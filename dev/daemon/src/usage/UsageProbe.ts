// UsageProbe — **확인용 세션**(T43-4, 설계 `docs/design/사용량-표시.md` §확인용 세션).
//
// 문제: Claude 는 그 엔진의 멤버가 **한 턴이라도 돌아야** 한도를 준다(첫 API 호출 전에는 statusLine 에
// `rate_limits` 키 자체가 없다, T43-0 Q2). 아무도 일을 안 시킨 아침이나 툴 **밖에서** 사용량을 쓴 경우
// 앱의 숫자가 어긋난다. 실측은 "새 세션에서 `/usage` 만 치면 **모델 턴 0 · 토큰 0** 으로 주간 한도가
// 그대로 나온다" 였다 → 엔진마다 **숨은 세션 하나**를 띄워 두고 5분마다 화면만 읽는다.
//
// **이 세션은 멤버가 아니다.** DB `members` 에 행이 없고, 스냅샷·사무실·이벤트 어디에도 안 나오고,
// hooks·MCP·statusLine 을 주입하지 않고, 지시를 받지 않는다. cwd 는 `<dataDir>/usage-probe/<engine>` 의
// 빈 폴더다(프로젝트 폴더를 건드리지 않는다). 섞이지 않도록 **자기 PtyManager 인스턴스**를 쓴다.
//
// 한 판:
//   spawn → (첫 실행 다이얼로그는 InputQueue 가 통과) → promptReady → 슬래시 명령 타이핑 + Enter
//   → 패널이 **새로** 그려질 때까지 대기(화면 패턴 개수가 늘어나는 것으로 판정) → 파싱 → Esc → promptReady 확인
//   → 다음 판까지 대기
//
// 실패는 전부 조용하다: 패턴이 안 맞으면 그 판을 버리고 **엔진당 데몬 수명에 한 번** `daemon.notice{warn}`,
// 프로세스가 죽으면 1분 → 최대 10분 백오프로 다시 띄운다. 턴 종료 출처(statusLine·rollout)가 계속
// 값을 대 주므로 확인용 세션이 죽어도 기능이 죽지는 않는다.
//
// 시간은 전부 주입된 `now()` 기준이고 판단은 `tick()` 한 곳에서만 한다 — 테스트는 타이머 없이
// `now` 를 밀고 `tick()` 을 부르면 된다(InputQueue 와 같은 규칙).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { InputQueue } from '../input/InputQueue.js';
import { buildClaudeProbeArgs, buildCodexProbeArgs } from '../pty/args.js';
import { PtyManager } from '../pty/PtyManager.js';
import type { KeyName } from '../pty/types.js';
import { ScreenModel } from '../screen/ScreenModel.js';
import type { Engine } from '../store/types.js';
import { countPanels, panelReady, parseUsageScreen } from './parse/usageScreen.js';
import type { UsageTracker } from './UsageTracker.js';

/** 기본 주기(초). `PIXEL_USAGE_PROBE_SEC`. */
export const DEFAULT_PROBE_SEC = 300;
/** 판정 주기(ms) — 화면이 바뀌었는지 보는 간격. */
export const TICK_MS = 500;

export const PROBE_TIMING = {
  /** 기동 → 프롬프트 준비. Claude 는 실측 **약 64초** 걸렸다(T43-0) — 넉넉히 준다. */
  bootMs: 240_000,
  /**
   * 슬래시 명령을 친 뒤 Enter 까지. 두 CLI 모두 `/` 를 치면 명령 팔레트가 뜨고, 글자가 다 들어가기 전에
   * Enter 를 보내면 엉뚱한 명령이 골라진다(스파이크가 600~700ms 를 두고 쳤다).
   */
  enterDelayMs: 700,
  /** 슬래시 명령 → 패널 렌더. 실측 2.2~4.8초. */
  panelMs: 30_000,
  /** Esc → 프롬프트 복귀. */
  closeMs: 15_000,
  /** 죽은 세션을 다시 띄우기까지(1회차). */
  backoffMinMs: 60_000,
  /** 백오프 상한. */
  backoffMaxMs: 600_000,
} as const;

/** 백오프: 1분 → 2 → 4 → 8 → 10분(상한). `failures` 는 1부터. */
export function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  const ms = PROBE_TIMING.backoffMinMs * 2 ** (failures - 1);
  return Math.min(ms, PROBE_TIMING.backoffMaxMs);
}

/** `<dataDir>/usage-probe/<engine>` — 확인용 세션의 빈 작업 폴더. */
export function probeCwd(dataDir: string, engine: Engine): string {
  return path.join(dataDir, 'usage-probe', engine);
}

/** pty 세션 키. **멤버 id 와 절대 겹치지 않는 모양**이다(멤버 id 는 `m_…`). */
export function probeSessionId(engine: Engine): string {
  return `usage-probe:${engine}`;
}

/** 실제 pty 이벤트를 지금 세션의 콜백으로 흘리는 자리. */
interface RealSink {
  data?: (chunk: string) => void;
  exit?: () => void;
}

/** 확인용 세션이 쓰는 pty 의 최소 모양(테스트에서 가짜로 대체). */
export interface ProbeSession {
  readonly pid: number;
  readonly alive: boolean;
  write(text: string): void;
  sendKeys(key: KeyName): void;
  kill(): void;
  /** pty 출력. 한 번만 등록한다. */
  onData(cb: (chunk: string) => void): void;
  /** 자식 종료. 한 번만 등록한다. */
  onExit(cb: () => void): void;
}

export type ProbeSpawn = (engine: Engine, cwd: string) => ProbeSession;

export interface UsageProbeOptions {
  tracker: UsageTracker;
  /** 데몬 데이터 폴더 — 아래에 `usage-probe/<engine>` 을 만든다. */
  dataDir: string;
  /** 주기(ms). 기본 300초. 0 이하면 **한 번만** 읽는다. */
  intervalMs?: number;
  /** false 면 확인용 세션을 아예 띄우지 않는다(`PIXEL_USAGE_PROBE=0`). */
  enabled?: boolean;
  claudeExe?: string;
  codexExe?: string;
  cols?: number;
  rows?: number;
  now?: () => number;
  /** 기본은 실제 pty. 테스트가 가짜 세션을 준다. */
  spawn?: ProbeSpawn;
  /** 살아 있는 확인용 세션의 pid 기록(유령 정리용). pid 가 null 이면 지운다. */
  recordPid?: (engine: Engine, pid: number | null) => void;
}

export type UsageProbeEvents = {
  /** 엔진당 데몬 수명에 **한 번**. Office 가 `daemon.notice{warn}` 으로 올린다. */
  warn: [engine: Engine, message: string];
  /** 한 판을 읽어 반영했다(테스트·로그용). */
  reading: [engine: Engine, at: number];
};

type Phase =
  /** 세션 없음(꺼짐·연결 안 됨). */
  | 'off'
  /** 띄웠고 프롬프트를 기다린다. */
  | 'booting'
  /** 프롬프트가 준비됐고 다음 판을 기다린다. */
  | 'idle'
  /** 슬래시 명령을 쳤고 Enter 를 보낼 때를 기다린다. */
  | 'typing'
  /** Enter 를 보냈고 패널을 기다린다. */
  | 'sent'
  /** Esc 를 보냈고 프롬프트 복귀를 기다린다. */
  | 'closing'
  /** 죽었다 — 백오프 뒤 다시 띄운다. */
  | 'backoff';

class EngineProbe {
  phase: Phase = 'off';
  session?: ProbeSession;
  screen?: ScreenModel;
  queue?: InputQueue;
  /** 지금 단계에 들어온 시각. */
  phaseAt = 0;
  /** 다음 판을 시작할 시각(idle 에서 본다). */
  nextProbeAt = 0;
  /** 다시 띄울 시각(backoff 에서 본다). */
  retryAt = 0;
  failures = 0;
  /** 명령을 치기 직전의 패널 등장 횟수 — 스크롤백에 남은 옛 패널과 구별한다. */
  panelsBefore = 0;
  /** 경고를 이미 한 번 냈는가(엔진당 데몬 수명에 한 번). */
  warned = false;

  constructor(readonly engine: Engine) {}
}

export class UsageProbe extends EventEmitter<UsageProbeEvents> {
  private readonly tracker: UsageTracker;
  private readonly dataDir: string;
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private readonly cols: number;
  private readonly rows: number;
  private readonly now: () => number;
  private readonly spawnFn: ProbeSpawn;
  private readonly recordPid?: (engine: Engine, pid: number | null) => void;
  private readonly pty: PtyManager;
  private readonly sinks = new Map<string, RealSink>();
  private readonly probes = new Map<Engine, EngineProbe>();
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(opts: UsageProbeOptions) {
    super();
    this.tracker = opts.tracker;
    this.dataDir = opts.dataDir;
    this.intervalMs = opts.intervalMs ?? DEFAULT_PROBE_SEC * 1000;
    this.enabled = opts.enabled !== false;
    this.cols = opts.cols ?? 120;
    this.rows = opts.rows ?? 40;
    this.now = opts.now ?? Date.now;
    this.recordPid = opts.recordPid;
    this.pty = new PtyManager({ claudeExe: opts.claudeExe, codexExe: opts.codexExe, dataDir: opts.dataDir, cols: this.cols, rows: this.rows });
    this.spawnFn = opts.spawn ?? ((engine, cwd) => this.spawnReal(engine, cwd));
    this.pty.on('data', (id, chunk) => this.sinks.get(id)?.data?.(chunk));
    this.pty.on('exit', (id) => this.sinks.get(id)?.exit?.());
    this.pty.on('warn', (id, message) => console.warn(`[usage-probe:${id}] ${message}`));
  }

  /** 확인용 세션을 쓰는가(꺼져 있으면 `start()` 가 아무 일도 하지 않는다). */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 진단용 — 지금 살아 있는 확인용 세션의 pid. */
  pids(): Array<{ engine: Engine; pid: number }> {
    const out: Array<{ engine: Engine; pid: number }> = [];
    for (const p of this.probes.values()) if (p.session?.alive) out.push({ engine: p.engine, pid: p.session.pid });
    return out;
  }

  /** 지금 단계(테스트·진단용). */
  phaseOf(engine: Engine): string {
    return this.probes.get(engine)?.phase ?? 'off';
  }

  start(): void {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  /** 타이머를 끄고 **확인용 세션을 죽인다**. 데몬 종료 경로가 반드시 부른다. */
  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const p of this.probes.values()) this.killSession(p);
    this.probes.clear();
  }

  /** 한 번 평가. 엔진마다 독립이다 — 하나가 죽어도 다른 하나는 돈다. `stop()` 뒤에는 아무 일도 하지 않는다. */
  tick(): void {
    if (!this.enabled || !this.running) return;
    const now = this.now();
    for (const engine of ['claude', 'codex'] as const) this.tickEngine(this.probeOf(engine), now);
  }

  private probeOf(engine: Engine): EngineProbe {
    let p = this.probes.get(engine);
    if (!p) {
      p = new EngineProbe(engine);
      this.probes.set(engine, p);
    }
    return p;
  }

  private tickEngine(p: EngineProbe, now: number): void {
    // 안 붙어 있는 엔진에는 세션을 띄우지 않는다. 붙어 있다가 끊기면 내린다(나중에 다시 붙으면 다시 띄운다).
    if (!this.tracker.engineUsage(p.engine).connected) {
      if (p.phase !== 'off') this.killSession(p);
      p.phase = 'off';
      p.failures = 0;
      return;
    }
    // 화면 패턴이 없는 엔진(맵에 `usage` 절이 없다)은 확인용 세션을 띄울 이유가 없다.
    if (!this.usageMap(p)) return;

    switch (p.phase) {
      case 'off':
        return this.spawnFor(p, now);
      case 'backoff':
        if (now >= p.retryAt) this.spawnFor(p, now);
        return;
      case 'booting':
        p.queue?.tick(); // 첫 실행 다이얼로그(신뢰 폴더·온보딩) 통과는 InputQueue 가 맡는다
        if (this.screenText(p) !== undefined && p.screen!.promptReady()) {
          p.phase = 'idle';
          p.phaseAt = now;
          p.nextProbeAt = now; // 준비되는 즉시 첫 판
          return;
        }
        if (now - p.phaseAt > PROBE_TIMING.bootMs) {
          this.warnOnce(p, `확인용 세션이 준비 화면에 도달하지 못했습니다(${PROBE_TIMING.bootMs / 1000}초)`);
          this.fail(p, now);
        }
        return;
      case 'idle':
        p.queue?.tick();
        if (now >= p.nextProbeAt) this.sendCommand(p, now);
        return;
      case 'typing':
        if (now - p.phaseAt >= PROBE_TIMING.enterDelayMs) this.sendEnter(p, now);
        return;
      case 'sent':
        return this.awaitPanel(p, now);
      case 'closing':
        p.queue?.tick();
        if (p.screen?.promptReady() || now - p.phaseAt > PROBE_TIMING.closeMs) {
          p.phase = 'idle';
          p.phaseAt = now;
          p.nextProbeAt = this.intervalMs > 0 ? now + this.intervalMs : Number.POSITIVE_INFINITY;
        }
        return;
    }
  }

  // ---- 한 판 --------------------------------------------------------------------

  private sendCommand(p: EngineProbe, now: number): void {
    const map = this.usageMap(p);
    const session = p.session;
    if (!map || !session?.alive) return this.fail(p, now);
    p.panelsBefore = countPanels(this.screenText(p) ?? '', map);
    try {
      // 붙여넣기(bracketed paste)가 아니라 그대로 타이핑한다 — 슬래시 명령은 한 줄이고,
      // 붙여넣은 `/usage` 는 명령이 아니라 글자로 들어갈 수 있다. Enter 는 팔레트가 가라앉은 뒤에.
      session.write(map.command);
    } catch {
      return this.fail(p, now);
    }
    p.phase = 'typing';
    p.phaseAt = now;
  }

  private sendEnter(p: EngineProbe, now: number): void {
    if (!p.session?.alive) return this.fail(p, now);
    try {
      p.session.sendKeys('enter');
    } catch {
      return this.fail(p, now);
    }
    p.phase = 'sent';
    p.phaseAt = now;
  }

  private awaitPanel(p: EngineProbe, now: number): void {
    const map = this.usageMap(p);
    const text = this.screenText(p);
    if (!map || text === undefined) return this.fail(p, now);

    if (countPanels(text, map) > p.panelsBefore && panelReady(text, map)) {
      const result = parseUsageScreen(text, map, now);
      if (result.ok) {
        this.tracker.applyProbe(p.engine, { weekly: result.weekly, session: result.session, models: result.models, plan: result.plan }, now);
        this.emit('reading', p.engine, now);
      } else {
        // 패널은 떴는데 한도 블록이 하나도 안 맞았다 = 문구가 바뀌었다. 값은 건드리지 않는다.
        this.warnOnce(p, `${map.command} 화면에서 한도를 읽지 못했습니다 — CLI 문구가 바뀌었을 수 있습니다(tui-maps/${p.engine}-*.json 의 usage 절)`);
      }
      return this.closePanel(p, now);
    }
    if (now - p.phaseAt > PROBE_TIMING.panelMs) {
      this.warnOnce(p, `${map.command} 화면이 뜨지 않았습니다 — CLI 문구가 바뀌었을 수 있습니다(tui-maps/${p.engine}-*.json 의 usage 절)`);
      this.closePanel(p, now);
    }
  }

  private closePanel(p: EngineProbe, now: number): void {
    const map = this.usageMap(p);
    try {
      for (const k of map?.closeKeys ?? ['esc']) p.session?.sendKeys(k);
    } catch {
      // 이미 죽었으면 다음 tick 의 onExit 이 처리한다.
    }
    p.phase = 'closing';
    p.phaseAt = now;
  }

  // ---- 세션 수명 ------------------------------------------------------------------

  private spawnFor(p: EngineProbe, now: number): void {
    const cwd = probeCwd(this.dataDir, p.engine);
    try {
      fs.mkdirSync(cwd, { recursive: true });
    } catch (err) {
      this.warnOnce(p, `확인용 세션 폴더를 만들지 못했습니다(${cwd}): ${String(err)}`);
      return this.fail(p, now);
    }
    let session: ProbeSession;
    try {
      session = this.spawnFn(p.engine, cwd);
    } catch (err) {
      console.warn(`[usage-probe] ${p.engine} 스폰 실패:`, err);
      return this.fail(p, now);
    }
    const screen = new ScreenModel({ engine: p.engine, cols: this.cols, rows: this.rows });
    // 첫 실행 다이얼로그(온보딩·폴더 신뢰) 통과만 맡긴다 — 큐에 넣는 지시는 영원히 없다.
    const queue = new InputQueue({
      session: { paste: (t) => session.write(t), write: (t) => session.write(t), sendKeys: (k) => session.sendKeys(k) },
      screen,
      isIdle: () => true,
      now: this.now,
    });
    p.session = session;
    p.screen = screen;
    p.queue = queue;
    p.phase = 'booting';
    p.phaseAt = now;
    session.onData((chunk) => void screen.feed(chunk));
    session.onExit(() => this.onExit(p));
    this.recordPid?.(p.engine, session.pid);
  }

  private onExit(p: EngineProbe): void {
    if (!this.running) return; // stop() 이 죽인 것 — 다시 띄우지 않는다
    if (!p.session) return; // 우리가 먼저 정리한 것(killSession) — 실패로 세지 않는다
    this.recordPid?.(p.engine, null);
    this.fail(p, this.now());
  }

  /** 한 판(또는 세션)을 실패로 접고 백오프를 건다. */
  private fail(p: EngineProbe, now: number): void {
    this.killSession(p);
    p.failures += 1;
    p.phase = 'backoff';
    p.phaseAt = now;
    p.retryAt = now + backoffMs(p.failures);
  }

  /**
   * 세션 정리. **`kill()` 은 맨 마지막에** 부른다 — ConPTY 는 종료 콜백을 같은 틱에 부를 수 있고,
   * 그러면 `onExit` → `fail` → `killSession` 으로 재진입해 실패 횟수가 두 번 올라간다.
   */
  private killSession(p: EngineProbe): void {
    const session = p.session;
    p.queue?.stop();
    p.screen?.dispose();
    p.session = undefined;
    p.screen = undefined;
    p.queue = undefined;
    try {
      session?.kill();
    } catch {
      // 이미 죽었으면 무시
    }
    this.recordPid?.(p.engine, null);
  }

  private warnOnce(p: EngineProbe, message: string): void {
    if (p.warned) return;
    p.warned = true;
    this.emit('warn', p.engine, `사용량 확인용 세션(${p.engine}): ${message}`);
  }

  private usageMap(p: EngineProbe) {
    // 화면이 없으면 맵만 필요하므로 임시 ScreenModel 없이 tuiMap 을 본다.
    return (p.screen ?? this.mapProbe(p.engine)).tuiMap.usage;
  }

  /** 세션이 없을 때 맵만 보기 위한 1회용 ScreenModel(엔진당 캐시). */
  private readonly mapCache = new Map<Engine, ScreenModel>();
  private mapProbe(engine: Engine): ScreenModel {
    let m = this.mapCache.get(engine);
    if (!m) {
      m = new ScreenModel({ engine, cols: 2, rows: 1 });
      this.mapCache.set(engine, m);
    }
    return m;
  }

  /** 맵이 스크롤백을 요구하면 버퍼 전체, 아니면 뷰포트. 세션이 없으면 undefined. */
  private screenText(p: EngineProbe): string | undefined {
    if (!p.screen) return undefined;
    return this.usageMap(p)?.scrollback ? p.screen.fullText() : p.screen.text();
  }

  /**
   * 실제 pty. `spawnBare` 라서 세션 설정 파일도 `PIXEL_MEMBER` 도 없다.
   *
   * pty 이벤트 구독은 **생성자에서 한 번만** 한다 — 세션을 다시 띄울 때마다 `on()` 을 부르면 리스너가
   * 쌓여 옛 세션의 콜백이 새 화면에 섞인다.
   */
  private spawnReal(engine: Engine, cwd: string): ProbeSession {
    const args = engine === 'claude' ? buildClaudeProbeArgs() : buildCodexProbeArgs();
    const id = probeSessionId(engine);
    const session = this.pty.spawnBare({ id, engine, cwd, args, cols: this.cols, rows: this.rows });
    const sink: RealSink = {};
    this.sinks.set(id, sink);
    return {
      get pid() {
        return session.pid;
      },
      get alive() {
        return session.alive;
      },
      write: (t) => session.write(t),
      sendKeys: (k) => session.sendKeys(k),
      kill: () => session.kill(),
      onData: (cb) => {
        sink.data = cb;
      },
      onExit: (cb) => {
        sink.exit = cb;
      },
    };
  }
}
