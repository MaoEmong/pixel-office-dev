// PtyManager — 멤버당 CLI(claude | codex) 하나를 node-pty(ConPTY)에 띄우고 입출력을 중계한다. (T01, 설계 §구성 요소 1)
//
// 여기서는 바이트만 다룬다. 화면 재구성은 ScreenModel(T02), 입력 시점 판단은 InputQueue(T05),
// hook 수신은 HookReceiver(T03)가 맡는다. 이 클래스는 "누가 떠 있고, 뭘 쓰고, 언제 죽었나"만 안다.
import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import { config as defaultConfig } from '../config.js';
import { buildClaudeArgs, buildCodexArgs } from './args.js';
import { CHILD_TERM, sanitizeEnv, stripDaemonEnv } from './env.js';
import { ensureCodexHooksFile, writeClaudeSessionSettings } from './hookSettings.js';
import type { Engine, ExitInfo, KeyName, PtySession, SpawnOptions } from './types.js';

export type { Engine, ExitInfo, KeyName, PtySession, SpawnOptions } from './types.js';
export * from './args.js';
export * from './env.js';
export * from './hookSettings.js';

/** 생성자에서 덮어쓸 수 있는 설정. 기본값은 config.ts. 테스트에서 dataDir 등을 격리할 때 쓴다. */
export interface PtyManagerConfig {
  claudeExe: string;
  codexExe: string;
  dataDir: string;
  cols: number;
  rows: number;
}

export interface KillOptions {
  /**
   * true 면 먼저 정중한 종료를 시도한다 — Claude `/exit`, Codex Ctrl+C(안 죽으면 2초 뒤 한 번 더). 실측 "종료".
   * timeoutMs 안에 안 죽으면 강제 종료.
   */
  graceful?: boolean;
  /** 정중한 종료 대기 시간. 기본 5000ms. */
  timeoutMs?: number;
}

/** sendKeys 이름 → 바이트. */
export const KEY_BYTES: Record<KeyName, string> = {
  enter: '\r',
  down: '\x1b[B',
  up: '\x1b[A',
  'ctrl-c': '\x03',
  esc: '\x1b',
};

/** bracketed paste 구분자 (실측 ①: 세 줄이 한 프롬프트로 들어감). */
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/**
 * Codex 정중한 종료에서 **두 번째** Ctrl+C 를 보내기 전에 기다리는 시간.
 * 실측(T20/T21): 프롬프트가 idle 이면 Ctrl+C **한 번**으로 exit 0 이 되고 `codex resume <id>` 안내가 찍힌다.
 * 턴이 도는 중이면 첫 Ctrl+C 는 그 턴만 끊으므로 안 죽었을 때만 한 번 더 보낸다.
 */
export const CODEX_SECOND_CTRL_C_WAIT_MS = 2000;

/** [PtyManager.spawnBare] 인자 — 멤버가 아닌 세션(확인용 세션, T43-4). */
export interface BareSpawnOptions {
  /** 세션 키(`usage-probe:claude` 등). **멤버 id 가 아니다.** */
  id: string;
  engine: Engine;
  cwd: string;
  /** 실행 파일 뒤에 그대로 붙일 인자 전부(`args.ts` 의 `build*ProbeArgs`). */
  args: string[];
  cols?: number;
  rows?: number;
  /** 기본은 `stripDaemonEnv(process.env)` + TERM — **`PIXEL_MEMBER` 는 넣지 않는다**(hook 이 붙을 자리가 없다). */
  env?: Record<string, string>;
}

/** gracefulQuit 가 건드리는 세션의 최소 모양(테스트에서 가짜로 대체). */
export type QuitTarget = Pick<PtySession, 'engine' | 'alive' | 'write' | 'sendKeys'>;

/** 종료를 ms 만큼 기다려 죽었으면 true. PtyManager 는 exit 이벤트로, 테스트는 가짜로 준다. */
export type ExitWaiter = (ms: number) => Promise<boolean>;

/** 엔진별 첫 종료 입력. Claude `/exit`+Enter, Codex Ctrl+C. 이미 죽은 세션의 예외는 삼킨다. */
function sendQuitInput(session: QuitTarget): void {
  try {
    if (session.engine === 'claude') session.write('/exit' + KEY_BYTES.enter);
    else session.sendKeys('ctrl-c');
  } catch {
    // write 실패(이미 죽음)는 무시 — 호출자가 강제 종료로 이어간다.
  }
}

/**
 * "정중한 종료" 한 판. 죽었으면 true, timeoutMs 안에 안 죽으면 false(호출자가 강제 종료).
 *   claude: `/exit` + Enter 한 번 → 끝까지 대기
 *   codex : Ctrl+C 한 번 → 최대 CODEX_SECOND_CTRL_C_WAIT_MS 대기 → 아직 살아 있으면 Ctrl+C 한 번 더 → 남은 시간 대기
 * (실측 ④ 는 "Ctrl+C ×2" 였지만 그건 턴이 돌던 중이었다 — idle 프롬프트에서는 한 번이면 끝난다. 그래서 무조건 두 번 보내지 않는다:
 *  이미 죽은 뒤의 두 번째 Ctrl+C 는 다음 세션이나 사용자 터미널로 새어 나갈 수 있다.)
 */
export async function gracefulQuit(session: QuitTarget, waitExit: ExitWaiter, opts: { firstWaitMs?: number; timeoutMs?: number } = {}): Promise<boolean> {
  const total = opts.timeoutMs ?? 5000;
  sendQuitInput(session);
  if (session.engine !== 'codex') return waitExit(total);

  const first = Math.min(opts.firstWaitMs ?? CODEX_SECOND_CTRL_C_WAIT_MS, total);
  if (await waitExit(first)) return true;
  if (session.alive) {
    try {
      session.sendKeys('ctrl-c');
    } catch {
      // 그 사이 죽었으면 무시.
    }
  }
  return waitExit(Math.max(total - first, 0));
}

export type PtyManagerEvents = {
  /** pty 출력 바이트(string). ScreenModel 과 attach 된 클라이언트에 그대로 흘린다. */
  data: [memberId: string, chunk: string];
  /** 자식 종료. 이후 get(memberId) 는 undefined. */
  exit: [memberId: string, info: ExitInfo];
  /** 치명적이지 않은 경고 (예: 남의 .codex/hooks.json 을 건드리지 않음). 리스너가 없으면 console.warn. */
  warn: [memberId: string, message: string];
};

class PtySessionImpl implements PtySession {
  #alive = true;

  constructor(
    readonly memberId: string,
    readonly engine: Engine,
    private readonly proc: pty.IPty,
  ) {}

  get pid(): number {
    return this.proc.pid;
  }

  get alive(): boolean {
    return this.#alive;
  }

  /** onExit 에서 PtyManager 가 호출. */
  markExited(): void {
    this.#alive = false;
  }

  write(text: string): void {
    if (!this.#alive) throw new Error(`pty session ${this.memberId} is not alive`);
    this.proc.write(text);
  }

  paste(text: string): void {
    this.write(PASTE_START + text + PASTE_END);
  }

  sendKeys(keys: KeyName): void {
    const bytes = KEY_BYTES[keys];
    if (bytes === undefined) throw new Error(`unknown key: ${String(keys)}`);
    this.write(bytes);
  }

  resize(cols: number, rows: number): void {
    if (!this.#alive) return;
    this.proc.resize(cols, rows);
  }

  kill(): void {
    if (!this.#alive) return;
    try {
      this.proc.kill();
    } catch {
      // 이미 죽은 프로세스면 무시. 최종 상태는 onExit 이 정한다.
    }
  }
}

export class PtyManager extends EventEmitter<PtyManagerEvents> {
  private readonly cfg: PtyManagerConfig;
  private readonly sessions = new Map<string, PtySessionImpl>();

  constructor(cfg: Partial<PtyManagerConfig> = {}) {
    super();
    this.cfg = {
      claudeExe: cfg.claudeExe ?? defaultConfig.claudeExe,
      codexExe: cfg.codexExe ?? defaultConfig.codexExe,
      dataDir: cfg.dataDir ?? defaultConfig.dataDir,
      cols: cfg.cols ?? defaultConfig.cols,
      rows: cfg.rows ?? defaultConfig.rows,
    };
  }

  /**
   * CLI 를 띄운다. 같은 memberId 로 살아 있는 세션이 있으면 에러 — 재고용/재시작은 먼저 kill.
   * 동기: 반환 시점에 pid 가 있다. 첫 화면(온보딩·신뢰 다이얼로그)은 data 이벤트로 흘러온다.
   */
  spawn(opts: SpawnOptions): PtySession {
    const existing = this.sessions.get(opts.memberId);
    if (existing?.alive) throw new Error(`member ${opts.memberId} already has a live pty session (pid ${existing.pid})`);

    const { file, args } = this.prepareCommand(opts);
    const env = sanitizeEnv(process.env, opts.memberToken);
    return this.spawnRaw(opts.memberId, opts.engine, file, args, opts.cwd, env, opts.cols, opts.rows);
  }

  /**
   * **멤버가 아닌** 프로세스를 띄운다(T43-4 확인용 세션). 설정 파일을 쓰지 않고 `PIXEL_MEMBER` 도 넣지 않는다 —
   * 인자를 통째로 받아 그대로 실행할 뿐이다. `id` 는 세션 키일 뿐 멤버 id 가 아니며, 이 세션은 DB 의 `members`
   * 에도 스냅샷에도 사무실에도 나타나지 않는다(D-45 ⑦).
   *
   * 확인용 세션은 **자기 PtyManager 인스턴스**를 쓴다 — Office 의 세션 목록에 섞이면 언젠가 멤버로 취급된다.
   */
  spawnBare(opts: BareSpawnOptions): PtySession {
    const existing = this.sessions.get(opts.id);
    if (existing?.alive) throw new Error(`bare session ${opts.id} already alive (pid ${existing.pid})`);
    const file = opts.engine === 'claude' ? this.cfg.claudeExe : this.cfg.codexExe;
    const env = opts.env ?? { ...stripDaemonEnv(process.env), TERM: CHILD_TERM };
    return this.spawnRaw(opts.id, opts.engine, file, opts.args, opts.cwd, env, opts.cols, opts.rows);
  }

  private spawnRaw(
    id: string,
    engine: Engine,
    file: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    cols?: number,
    rows?: number,
  ): PtySession {
    const proc = pty.spawn(file, args, { name: CHILD_TERM, cols: cols ?? this.cfg.cols, rows: rows ?? this.cfg.rows, cwd, env });
    const session = new PtySessionImpl(id, engine, proc);
    this.sessions.set(id, session);

    proc.onData((chunk) => this.emit('data', id, chunk));
    proc.onExit((e) => {
      session.markExited();
      releaseConptyResources(proc);
      // 그 사이 같은 id 로 새 세션이 떴을 수 있으니 내 것일 때만 지운다.
      if (this.sessions.get(id) === session) this.sessions.delete(id);
      this.emit('exit', id, { exitCode: e.exitCode, signal: e.signal });
    });
    return session;
  }

  get(memberId: string): PtySession | undefined {
    return this.sessions.get(memberId);
  }

  list(): PtySession[] {
    return [...this.sessions.values()];
  }

  /**
   * 세션 종료. 없으면 아무것도 안 한다. exit 이벤트가 오면(또는 강제 종료 후 3초 안에 안 오면) resolve.
   */
  async kill(memberId: string, opts: KillOptions = {}): Promise<void> {
    const session = this.sessions.get(memberId);
    if (!session || !session.alive) return;

    const exited = this.waitExit(memberId);
    if (opts.graceful) {
      const done = await gracefulQuit(session, (ms) => withTimeout(exited, ms), { timeoutMs: opts.timeoutMs ?? 5000 });
      if (done) return;
    }
    session.kill();
    await withTimeout(exited, 3000);
  }

  /** memberId 의 exit 이벤트를 기다리는 promise. */
  private waitExit(memberId: string): Promise<void> {
    return new Promise((resolve) => {
      const handler = (id: string) => {
        if (id !== memberId) return;
        this.off('exit', handler);
        resolve();
      };
      this.on('exit', handler);
    });
  }

  /** 엔진별 실행 파일·인자와 hook 설정 파일 준비. 경고(남의 hooks.json)는 warn 이벤트로. */
  private prepareCommand(opts: SpawnOptions): { file: string; args: string[] } {
    const { file, args, warn } = prepareSpawnCommand(this.cfg, opts);
    if (warn) this.warn(opts.memberId, warn);
    return { file, args };
  }

  private warn(memberId: string, message: string): void {
    if (this.listenerCount('warn') > 0) this.emit('warn', memberId, message);
    else console.warn(`[pty:${memberId}] ${message}`);
  }
}

export interface SpawnCommand {
  file: string;
  args: string[];
  /** 치명적이지 않은 경고(남이 쓴 `.codex/hooks.json` 을 건드리지 않았다 등). */
  warn?: string;
}

/**
 * 엔진별 실행 파일·인자 + hook 설정 파일 준비(부작용: 설정 파일 쓰기). spawn 없이 검증할 수 있게 밖으로 뺐다.
 *   claude: `<dataDir>/sessions/<memberId>/claude-settings.json` 을 쓰고 `--settings …`(+ --resume, --mcp-config).
 *           `statusLineScriptPath` 가 있으면 그 파일에 `statusLine` 도 같이 들어간다(T43 사용량).
 *   codex : `<cwd>/.codex/hooks.json`(pixel-office 마커, 남의 파일이면 건드리지 않고 warn) +
 *           `[resume <id>] --dangerously-bypass-hook-trust -c approval_policy="on-request" -c sandbox_mode="workspace-write"` (실측 ④)
 *           + `-c mcp_servers.team.url="<mcpUrl>"` (T22, mcpUrl 이 있을 때)
 */
export function prepareSpawnCommand(cfg: Pick<PtyManagerConfig, 'claudeExe' | 'codexExe' | 'dataDir'>, opts: SpawnOptions): SpawnCommand {
  if (opts.engine === 'claude') {
    const settingsPath = writeClaudeSessionSettings(cfg.dataDir, opts.memberId, opts.hookScriptPath, opts.hookPort, opts.statusLineScriptPath);
    return {
      file: cfg.claudeExe,
      args: buildClaudeArgs(settingsPath, opts.resumeSessionId, opts.extraArgs, { mcpConfigPath: opts.mcpConfigPath }),
    };
  }
  const result = ensureCodexHooksFile(opts.cwd, opts.hookScriptPath, opts.hookPort);
  const cmd: SpawnCommand = { file: cfg.codexExe, args: buildCodexArgs(opts.resumeSessionId, opts.extraArgs, { mcpUrl: opts.mcpUrl }) };
  if (!result.written) cmd.warn = result.reason ?? `did not write ${result.path}`;
  return cmd;
}

/** promise 가 ms 안에 끝나면 true, 아니면 false. 타이머는 정리한다. */
function withTimeout(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([p.then(() => true), timeout]).finally(() => clearTimeout(timer));
}

/**
 * 자식이 스스로 끝난 뒤 node-pty(win32, ConPTY, useConptyDll=false)가 놓치는 자원을 돌려준다.
 *
 * node-pty 1.1.0 은 자연 종료 시 conout 소켓만 닫고 exit 를 올린다. pseudoconsole 핸들·conout worker 스레드·
 * conin 소켓은 agent.kill() 에서만 해제되므로 `/exit` 로 끝난 세션이 데몬(또는 테스트 러너)의 이벤트 루프를
 * 영원히 붙든다(T01 통합 테스트에서 러너가 안 끝나는 것으로 발견). 그런데 proc.kill() 을 그대로 부르면
 * conpty_console_list_agent 를 fork 해 죽은 콘솔에 AttachConsole 을 시도하다 stderr 에 스택을 찍고 5초를 기다린다.
 * 그래서 내부 필드를 직접 정리하고, 필드 모양이 다르면(node-pty 버전 변경) proc.kill() 로 폴백한다.
 */
function releaseConptyResources(proc: pty.IPty): void {
  const agent = (proc as unknown as { _agent?: ConptyAgentInternals })._agent;
  try {
    if (agent && agent._conoutSocketWorker && agent._ptyNative && typeof agent._pty === 'number') {
      agent._inSocket?.destroy();
      agent._ptyNative.kill(agent._pty, agent._useConptyDll ?? false);
      agent._conoutSocketWorker.dispose();
      return;
    }
    proc.kill();
  } catch {
    // 자원 해제 목적일 뿐 — 실패해도 exit 처리에는 영향 없음
  }
}

/** node-pty 1.1.0 WindowsPtyAgent 의 내부 필드 중 우리가 건드리는 것. */
interface ConptyAgentInternals {
  _pty?: number;
  _useConptyDll?: boolean;
  _inSocket?: { destroy(): void };
  _conoutSocketWorker?: { dispose(): void };
  _ptyNative?: { kill(pty: number, useConptyDll: boolean): void };
}
