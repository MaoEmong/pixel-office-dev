// 통합 테스트(opt-in, PIXEL_IT=1) 공통 도우미: 실제 데몬 프로세스 띄우기, WS JSON-RPC 클라이언트, 임시 포트, 이 테스트가 띄운
// claude.exe 만 골라 죽이기. **모든 IT 가 이 파일을 쓴다**(T44 에서 restart IT 의 인라인 사본도 여기로 합쳤다).
//
// 격리 규칙(D-40 · README "실행"): IT 는 자기 `PIXEL_DATA_DIR`(임시 폴더)과 **빈 포트 3개**(`freePort()`)로 데몬을 띄운다 —
// 기본 포트 7420-7422 에 진짜 데몬이 떠 있어도 부딪히지 않는다. `PIXEL_FORCE_START` 는 쓰지 않는다.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { OfficeEvent, Snapshot } from '../../src/store/types.js';

export const IT = process.env.PIXEL_IT === '1';
export const DAEMON_DIR = path.resolve(import.meta.dirname, '..', '..');
/**
 * 멤버의 cwd. 기본은 저장소의 `dev/spike-0/sandbox`(두 CLI 에서 신뢰된 폴더).
 * `PIXEL_IT_SANDBOX` 로 갈아끼울 수 있다 — worktree 처럼 sandbox 가 없는 체크아웃(gitignore 대상)에서 쓴다.
 */
export const SANDBOX = process.env.PIXEL_IT_SANDBOX ? path.resolve(process.env.PIXEL_IT_SANDBOX) : path.resolve(DAEMON_DIR, '..', 'spike-0', 'sandbox');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * IT 용 데몬 환경변수 한 벌: 임시 dataDir + 빈 포트 3개(+ 추가분).
 * **포트를 하드코딩하지 않는다** — 기본 7420-7422 에 실사용 데몬이 떠 있어도 이 데몬은 그 옆에 뜬다.
 */
export async function itEnv(prefix: string, extra: Record<string, string> = {}): Promise<{ dataDir: string; env: Record<string, string> }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `pixel-office-${prefix}-it-`));
  const [wsPort, hookPort, mcpPort] = await Promise.all([freePort(), freePort(), freePort()]);
  return {
    dataDir,
    env: {
      PIXEL_WS_PORT: String(wsPort),
      PIXEL_HOOK_PORT: String(hookPort),
      PIXEL_MCP_PORT: String(mcpPort),
      PIXEL_DATA_DIR: dataDir,
      ...extra,
    },
  };
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export interface Notification {
  method: string;
  params: Record<string, unknown>;
}

export class Client {
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  readonly notifications: Notification[] = [];
  private readonly waiters: Array<{ pred: (n: Notification) => boolean; resolve: (n: Notification) => void }> = [];
  lastSeq = 0;

  private constructor(
    readonly ws: WebSocket,
    readonly tag: string,
  ) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (typeof msg.method === 'string') {
        const n = { method: msg.method, params: (msg.params ?? {}) as Record<string, unknown> };
        this.notifications.push(n);
        if (n.method === 'event') {
          const e = n.params as unknown as OfficeEvent;
          this.lastSeq = Math.max(this.lastSeq, e.seq);
          console.log(`[IT:${tag}] event #${e.seq} ${e.kind} ${JSON.stringify(e.detail).slice(0, 160)}${e.ref.questionId ? ` q=${e.ref.questionId}` : ''}`);
        } else if (n.method === 'member.status') {
          console.log(`[IT:${tag}] status ${String(n.params.status)} (${String(n.params.derived)})`);
        } else if (n.method === 'daemon.notice') {
          console.log(`[IT:${tag}] notice ${String(n.params.level)}: ${String(n.params.message)}`);
        }
        for (const w of [...this.waiters]) {
          if (w.pred(n)) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            w.resolve(n);
          }
        }
        return;
      }
      const w = this.waiting.get(msg.id as number);
      if (!w) return;
      this.waiting.delete(msg.id as number);
      if (msg.error) w.reject(new Error(`rpc error ${JSON.stringify(msg.error)}`));
      else w.resolve(msg.result);
    });
  }

  static connect(port: number, tag: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.once('open', () => resolve(new Client(ws, tag)));
      ws.once('error', reject);
    });
  }

  call<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** 알림 구독(이미 받은 것도 포함해 첫 매치). */
  waitFor(what: string, pred: (n: Notification) => boolean, timeoutMs: number): Promise<Notification> {
    const hit = this.notifications.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs);
      // unref: 끝까지 안 맞은 대기(autoApprove 의 1시간 루프 등)가 프로세스를 붙잡아 러너가 안 끝나는 것을 막는다.
      // 대기하는 동안은 WS 소켓이 이벤트 루프를 살려 두므로 진짜 타임아웃은 그대로 뜬다.
      t.unref();
      this.waiters.push({
        pred,
        resolve: (n) => {
          clearTimeout(t);
          resolve(n);
        },
      });
    });
  }

  waitEvent(memberId: string, kind: OfficeEvent['kind'], afterSeq: number, timeoutMs: number, extra?: (e: OfficeEvent) => boolean): Promise<OfficeEvent> {
    return this.waitFor(
      `event ${kind} after #${afterSeq}`,
      (n) => {
        if (n.method !== 'event') return false;
        const e = n.params as unknown as OfficeEvent;
        return e.memberId === memberId && e.kind === kind && e.seq > afterSeq && (extra ? extra(e) : true);
      },
      timeoutMs,
    ).then((n) => n.params as unknown as OfficeEvent);
  }

  waitStatus(memberId: string, status: string, timeoutMs: number): Promise<void> {
    return this.waitFor(`status ${status}`, (n) => n.method === 'member.status' && n.params.memberId === memberId && n.params.status === status, timeoutMs).then(
      () => undefined,
    );
  }

  /** 지금까지 받은 이벤트(오름차순). */
  events(): OfficeEvent[] {
    return this.notifications.filter((n) => n.method === 'event').map((n) => n.params as unknown as OfficeEvent);
  }

  /**
   * 멤버를 가리지 않고 모든 허가 요청을 자동 allow(T25 통합 테스트 — 팀장이 도중에 hire 한 팀원의 Bash 허가까지 받는다).
   * 리스너 해제 함수를 돌려준다.
   */
  autoApproveAll(): () => void {
    let stopped = false;
    const loop = async () => {
      let seen = 0;
      while (!stopped) {
        const ev = await this.waitFor(
          'approval(any member)',
          (n) => {
            if (n.method !== 'event') return false;
            const e = n.params as unknown as OfficeEvent;
            return e.kind === 'waiting_approval' && e.seq > seen;
          },
          3_600_000,
        ).catch(() => undefined);
        if (!ev || stopped) return;
        const e = ev.params as unknown as OfficeEvent;
        seen = e.seq;
        const pendingId = e.ref.approvalId;
        if (!pendingId) continue;
        console.log(`[IT:${this.tag}] auto-approve ${pendingId} (${String(e.detail.tool)} ${String(e.detail.cmd ?? e.detail.path ?? '')})`);
        await this.call('approval.respond', { pendingId, behavior: 'allow' }).catch((err) => console.log(`[IT:${this.tag}] approval.respond failed: ${String(err)}`));
      }
    };
    void loop();
    return () => {
      stopped = true;
    };
  }

  /** 모든 허가 요청을 자동 allow(통합 테스트용 — MCP 도구 첫 호출 등). 리스너 해제 함수를 돌려준다. */
  autoApprove(memberId: string): () => void {
    let stopped = false;
    const loop = async () => {
      let seen = 0;
      while (!stopped) {
        const ev = await this.waitFor('approval', (n) => {
          if (n.method !== 'event') return false;
          const e = n.params as unknown as OfficeEvent;
          return e.memberId === memberId && e.kind === 'waiting_approval' && e.seq > seen;
        }, 3_600_000).catch(() => undefined);
        if (!ev || stopped) return;
        const e = ev.params as unknown as OfficeEvent;
        seen = e.seq;
        const pendingId = e.ref.approvalId;
        if (!pendingId) continue;
        console.log(`[IT:${this.tag}] auto-approve ${pendingId} (${String(e.detail.tool)})`);
        await this.call('approval.respond', { pendingId, behavior: 'allow' }).catch((err) => console.log(`[IT:${this.tag}] approval.respond failed: ${String(err)}`));
      }
    };
    void loop();
    return () => {
      stopped = true;
    };
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * 지금 스냅샷을 한 번 떠 온다. **스냅샷 전용 RPC 는 없다** — `hello` 응답에만 실려 오므로 별도 연결로 한 번 붙었다 끊는다
 * (구 IT 들이 쓰던 `snapshot` 메서드는 존재한 적이 없다: -32601).
 */
export async function snapshotOnce(port: number, token: string, tag: string): Promise<Snapshot> {
  const peek = await Client.connect(port, tag);
  const s = (await peek.call<{ snapshot: Snapshot }>('hello', { token, client: { name: tag, version: '0' } })).snapshot;
  peek.close();
  return s;
}

export interface Daemon {
  child: ChildProcess;
  lines: string[];
  waitLine(what: string, pred: (line: string) => boolean, timeoutMs: number): Promise<string>;
}

export function startDaemon(tag: string, env: Record<string, string>): Daemon {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: DAEMON_DIR,
    env: { ...process.env, ...env, PIXEL_IT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines: string[] = [];
  const waiters: Array<{ pred: (l: string) => boolean; resolve: (l: string) => void }> = [];
  const onLine = (prefix: string) => (buf: Buffer) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line) continue;
      console.log(`${prefix} ${line}`);
      lines.push(line);
      for (const w of [...waiters]) {
        if (w.pred(line)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(line);
        }
      }
    }
  };
  child.stdout!.on('data', onLine(`[${tag}:out]`));
  child.stderr!.on('data', onLine(`[${tag}:err]`));
  return {
    child,
    lines,
    waitLine(what, pred, timeoutMs) {
      const hit = lines.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${what} (${tag})`)), timeoutMs);
        t.unref();
        const onExit = () => reject(new Error(`${tag} exited (code ${child.exitCode}) before ${what}`));
        child.once('exit', onExit);
        waiters.push({
          pred,
          resolve: (l) => {
            clearTimeout(t);
            child.off('exit', onExit);
            resolve(l);
          },
        });
      });
    },
  };
}

export function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch {
    // 이미 죽음
  }
}

/**
 * 이 테스트가 띄운 claude 만 골라 죽인다: 데몬이 `--settings <dataDir>/…` 로 스폰하므로 명령줄에 dataDir 이 들어 있다.
 * (이 머신의 다른 claude.exe 는 건드리지 않는다.) win32 전용, 그 외는 pid 목록만.
 */
export function sweepClaudeByDataDir(dataDir: string, known: number[]): number[] {
  const killed: number[] = [];
  if (process.platform === 'win32') {
    const pattern = dataDir.replace(/'/g, "''");
    const ps = `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -like '*${pattern}*' } | Select-Object -ExpandProperty ProcessId`;
    const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    for (const line of (out.stdout ?? '').split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) {
        killTree(pid);
        killed.push(pid);
      }
    }
  }
  for (const pid of known) {
    if (pidAlive(pid)) {
      killTree(pid);
      killed.push(pid);
    }
  }
  return killed;
}
