// PtyManager — 멤버당 CLI(claude | codex) 하나를 node-pty(ConPTY)에 띄우고 입출력을 중계한다. (T01, 설계 §구성 요소 1)
//
// 여기서는 바이트만 다룬다. 화면 재구성은 ScreenModel(T02), 입력 시점 판단은 InputQueue(T05),
// hook 수신은 HookReceiver(T03)가 맡는다. 이 클래스는 "누가 떠 있고, 뭘 쓰고, 언제 죽었나"만 안다.
import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import { config as defaultConfig } from '../config.js';
import { buildClaudeArgs, buildCodexArgs } from './args.js';
import { CHILD_TERM, sanitizeEnv } from './env.js';
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
   * true 면 먼저 정중한 종료를 시도한다 — Claude `/exit`, Codex Ctrl+C×2 (실측 "종료").
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
    const cols = opts.cols ?? this.cfg.cols;
    const rows = opts.rows ?? this.cfg.rows;

    const proc = pty.spawn(file, args, { name: CHILD_TERM, cols, rows, cwd: opts.cwd, env });
    const session = new PtySessionImpl(opts.memberId, opts.engine, proc);
    this.sessions.set(opts.memberId, session);

    proc.onData((chunk) => this.emit('data', opts.memberId, chunk));
    proc.onExit((e) => {
      session.markExited();
      releaseConptyResources(proc);
      // 그 사이 같은 id 로 새 세션이 떴을 수 있으니 내 것일 때만 지운다.
      if (this.sessions.get(opts.memberId) === session) this.sessions.delete(opts.memberId);
      this.emit('exit', opts.memberId, { exitCode: e.exitCode, signal: e.signal });
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
      this.sendQuitSequence(session);
      const done = await withTimeout(exited, opts.timeoutMs ?? 5000);
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

  /** 실측 "종료": Claude 는 `/exit`, Codex 는 `/quit` 만으로는 안 끝나고 Ctrl+C×2. */
  private sendQuitSequence(session: PtySessionImpl): void {
    try {
      if (session.engine === 'claude') {
        session.write('/exit' + KEY_BYTES.enter);
      } else {
        session.sendKeys('ctrl-c');
        setTimeout(() => {
          if (session.alive) session.sendKeys('ctrl-c');
        }, 300);
      }
    } catch {
      // write 실패(이미 죽음)는 무시 — 이어서 강제 종료·exit 대기로 간다.
    }
  }

  /** 엔진별 실행 파일·인자와 hook 설정 파일 준비. */
  private prepareCommand(opts: SpawnOptions): { file: string; args: string[] } {
    if (opts.engine === 'claude') {
      const settingsPath = writeClaudeSessionSettings(this.cfg.dataDir, opts.memberId, opts.hookScriptPath, opts.hookPort);
      return {
        file: this.cfg.claudeExe,
        args: buildClaudeArgs(settingsPath, opts.resumeSessionId, opts.extraArgs, { mcpConfigPath: opts.mcpConfigPath }),
      };
    }
    const result = ensureCodexHooksFile(opts.cwd, opts.hookScriptPath, opts.hookPort);
    if (!result.written) this.warn(opts.memberId, result.reason ?? `did not write ${result.path}`);
    return { file: this.cfg.codexExe, args: buildCodexArgs(opts.resumeSessionId, opts.extraArgs) };
  }

  private warn(memberId: string, message: string): void {
    if (this.listenerCount('warn') > 0) this.emit('warn', memberId, message);
    else console.warn(`[pty:${memberId}] ${message}`);
  }
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
