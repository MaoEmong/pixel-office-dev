// 부모 앱 감시(T46-1, D-47 · 수명주기.md §3).
//
// 앱이 X 로 닫히면 `daemon.shutdown` 이 온다(§2). 그런데 **강제 종료·크래시**에서는 그 코드가 돌지 못한다 —
// 그러면 데몬과 AI 세션이 주인 없이 남는다(원칙 2: "어느 쪽이 먼저 죽어도 남는 것이 없어야 한다").
// 그래서 데몬이 거꾸로 부모를 본다: `PIXEL_PARENT_PID` 가 있으면 2초마다 그 pid 가 살아 있는지 확인하고,
// 사라지면 §2 와 **같은** 정리를 스스로 한다.
//
// 두 가지 함정을 피한다.
//   ① **pid 재사용.** 부모가 죽고 같은 번호가 다른 프로그램에 다시 붙으면 `kill(pid,0)` 은 계속 "살아 있다" 고 한다.
//      → 기동 때 **프로세스 시작 시각**을 한 번 읽어 두고 같이 비교한다. 시작 시각이 달라지면 "다른 프로세스" 다.
//      읽기에 실패하면(권한·플랫폼) pid 만 본다 — 감시를 아예 끄는 것보다 낫다.
//   ② **느린 조회.** 윈도우에서 `wmic`/`Get-Process` 를 2초마다 돌리면 데몬이 계속 프로세스를 띄운다.
//      → 폴링은 `process.kill(pid, 0)`(시스템 콜 하나) 로만 하고, 비싼 `Get-CimInstance Win32_Process` 는
//      **기동 때 한 번**(그리고 `hello{parentPid}` 로 대상이 바뀔 때 한 번) 만 부른다.
import { spawnSync } from 'node:child_process';

/** 2초마다(수명주기.md §3). */
export const PARENT_WATCH_INTERVAL_MS = 2000;

/** 감시가 쓰는 최소 OS 연산. 테스트는 가짜로 바꿔 끼운다. */
export interface ProcessProbe {
  /** pid 가 살아 있는가(싼 검사 — 폴링마다 부른다). */
  alive(pid: number): boolean;
  /**
   * 프로세스 시작 시각(ms epoch). 비싼 검사 — **대상이 정해질 때 한 번만** 부른다.
   * 모르면 undefined(그러면 pid 만 보고 판단한다).
   */
  startedAt(pid: number): number | undefined;
}

/** `setInterval`/`clearInterval` 주입구(테스트가 시간을 손으로 돌린다). */
export interface WatchTimer {
  setInterval(fn: () => void, ms: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
}

export interface ParentWatchOptions {
  /** 지켜볼 부모 pid. 없으면 감시하지 않는다. */
  parentPid?: number;
  /** 폴링 주기(ms). 기본 2000. */
  intervalMs?: number;
  probe?: ProcessProbe;
  timer?: WatchTimer;
  /** 부모가 사라졌을 때 한 번만 불린다. */
  onGone: (info: { pid: number; reason: 'exited' | 'pid-reused' }) => void;
}

/**
 * 부모 pid 하나를 지켜본다. `start()` → `tick()` 반복 → 사라지면 `onGone` **한 번** → 스스로 멈춘다.
 * `retarget(pid)` 는 `hello{parentPid}`(앱만 재시작된 경우) 용이다 — 새 pid 의 시작 시각을 다시 한 번 읽는다.
 */
export class ParentWatch {
  private readonly intervalMs: number;
  private readonly probe: ProcessProbe;
  private readonly timer: WatchTimer;
  private readonly onGone: ParentWatchOptions['onGone'];
  private pid?: number;
  /** 대상이 정해질 때 한 번 읽은 시작 시각. undefined 면 pid 만 본다. */
  private startedAt?: number;
  private handle?: NodeJS.Timeout;
  private fired = false;

  constructor(opts: ParentWatchOptions) {
    this.intervalMs = opts.intervalMs ?? PARENT_WATCH_INTERVAL_MS;
    this.probe = opts.probe ?? defaultProcessProbe;
    this.timer = opts.timer ?? globalTimer;
    this.onGone = opts.onGone;
    if (opts.parentPid !== undefined) this.target(opts.parentPid);
  }

  /** 지금 지켜보는 pid(없으면 undefined). */
  get parentPid(): number | undefined {
    return this.pid;
  }

  /** 기동 때 읽어 둔 부모 시작 시각(읽지 못했으면 undefined) — 진단·테스트용. */
  get parentStartedAt(): number | undefined {
    return this.startedAt;
  }

  get watching(): boolean {
    return this.handle !== undefined;
  }

  /** 대상이 있으면 폴링을 건다. 대상이 없으면 아무 일도 하지 않는다(= 감시 꺼짐). */
  start(): void {
    if (this.handle || this.pid === undefined) return;
    const h = this.timer.setInterval(() => this.tick(), this.intervalMs);
    // 이 타이머 때문에 데몬이 살아 있으면 안 된다(다른 주기 타이머와 같은 규칙).
    h.unref?.();
    this.handle = h;
  }

  stop(): void {
    if (!this.handle) return;
    this.timer.clearInterval(this.handle);
    this.handle = undefined;
  }

  /**
   * 감시 대상을 바꾼다(`hello{parentPid}` — 앱만 다시 뜬 경우). 이미 `onGone` 을 쏜 뒤에는 무시한다
   * (정리가 이미 돌고 있다 — 그 위에 새 부모를 붙여 봐야 데몬은 내려가는 중이다).
   */
  retarget(parentPid: number): void {
    if (this.fired || parentPid === this.pid) return;
    const wasWatching = this.watching;
    this.stop();
    this.target(parentPid);
    if (wasWatching) this.start();
  }

  /** 한 번 확인. 타이머가 부르지만 테스트는 직접 부른다. */
  tick(): void {
    if (this.fired || this.pid === undefined) return;
    const pid = this.pid;
    let alive: boolean;
    try {
      alive = this.probe.alive(pid);
    } catch {
      return; // 확인 자체가 실패했다면 판단하지 않는다 — 살아 있는 부모를 죽었다고 보면 안 된다
    }
    if (!alive) return this.fire(pid, 'exited');
    // pid 가 살아 있어도 그게 **우리 부모**인지는 시작 시각이 말해 준다(pid 재사용).
    if (this.startedAt === undefined) return;
    let now: number | undefined;
    try {
      now = this.probe.startedAt(pid);
    } catch {
      return;
    }
    if (now !== undefined && now !== this.startedAt) this.fire(pid, 'pid-reused');
  }

  private fire(pid: number, reason: 'exited' | 'pid-reused'): void {
    this.fired = true;
    this.stop();
    this.onGone({ pid, reason });
  }

  private target(parentPid: number): void {
    this.pid = parentPid;
    try {
      this.startedAt = this.probe.startedAt(parentPid);
    } catch {
      this.startedAt = undefined;
    }
  }
}

const globalTimer: WatchTimer = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
};

/**
 * 실제 OS 연산. `alive` 는 시스템 콜 하나(`kill(pid,0)`) — `EPERM` 은 "살아 있음" 이다(D-40 의 단일 데몬 가드와 같은 규칙).
 * `startedAt` 은 win32 에서 PowerShell `Get-CimInstance Win32_Process` 한 번(수백 ms) — **폴링에 쓰지 않는다.**
 */
export const defaultProcessProbe: ProcessProbe = {
  alive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  startedAt(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    try {
      if (process.platform === 'win32') {
        const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString("o")`;
        const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000,
        });
        const ms = Date.parse((out.stdout ?? '').trim());
        return Number.isFinite(ms) ? ms : undefined;
      }
      // POSIX: `ps -o lstart=` 는 사람이 읽는 표기지만 초 단위로 안정적이다.
      const out = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
      const ms = Date.parse((out.stdout ?? '').trim());
      return Number.isFinite(ms) ? ms : undefined;
    } catch {
      return undefined;
    }
  },
};
