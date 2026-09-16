// 실측 캡처 공통 하네스(T21). 실제 CLI 를 node-pty(ConPTY)로 띄우고 ScreenModel 에 넣어
// "데몬이 보는 그대로"(뷰포트 = buffer.active.baseY 기준)의 평문 화면을 픽스처로 저장한다.
// 스파이크의 screen() 헬퍼는 버퍼 0행부터 읽어 Codex(일반 버퍼+스크롤백)에서는 작업 중 화면이 안 남았다 → 이 하네스는 ScreenModel.lines() 를 쓴다.
//
// 사용: capture-codex.ts / capture-claude.ts 가 시나리오를 쓴다. 테스트 실행(`test/**/*.test.ts`)에는 포함되지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import pty from 'node-pty';
import { ScreenModel } from '../../../src/screen/ScreenModel.js';
import type { Engine } from '../../../src/screen/ScreenModel.js';

export const CR = '\r';
export const ESC = '\x1b';
export const CTRL_C = '\x03';
export const DOWN = '\x1b[B';
export const UP = '\x1b[A';

export const FIXTURES_DIR = path.resolve(import.meta.dirname, '..', 'fixtures');

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...extra };
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^CLAUDE_?CODE|^CLAUDECODE|^CLAUDE_CONFIG_DIR$/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

export interface CaptureOpts {
  engine: Engine;
  file: string;
  args: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  /** 모든 프레임(화면이 바뀔 때마다)을 남길 로그 파일. */
  frameLog: string;
}

export class Capture {
  readonly sm: ScreenModel;
  readonly proc: pty.IPty;
  readonly t0 = Date.now();
  exited: { exitCode: number; signal?: number } | undefined;
  private raw = 0;
  private lastFrame = '';
  private readonly logFd: number;
  private readonly frameTimer: NodeJS.Timeout;

  constructor(readonly opts: CaptureOpts) {
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 40;
    this.sm = new ScreenModel({ engine: opts.engine, cols, rows });
    fs.mkdirSync(path.dirname(opts.frameLog), { recursive: true });
    this.logFd = fs.openSync(opts.frameLog, 'w');
    this.log(`spawn ${opts.file} ${opts.args.join(' ')} (cwd=${opts.cwd}, ${cols}x${rows})`);
    this.proc = pty.spawn(opts.file, opts.args, { name: 'xterm-256color', cols, rows, cwd: opts.cwd, env: cleanEnv() });
    this.log(`pid ${this.proc.pid}`);
    this.proc.onData((d) => {
      this.raw += d.length;
      void this.sm.feed(d);
    });
    this.proc.onExit((e) => {
      this.exited = e;
      this.log(`EXIT ${JSON.stringify(e)}`);
    });
    // 화면이 바뀔 때마다 프레임을 로그에 남긴다(어떤 문구가 언제 떴는지 나중에 고를 수 있게).
    this.frameTimer = setInterval(() => this.logFrameIfChanged(), 250);
  }

  get elapsed(): string {
    return ((Date.now() - this.t0) / 1000).toFixed(1).padStart(6) + 's';
  }

  log(msg: string): void {
    const line = `[${this.elapsed}] ${msg}`;
    console.log(line);
    fs.writeSync(this.logFd, line + '\n');
  }

  /** 현재 뷰포트(뒤쪽 빈 줄 제거, 각 줄 오른쪽 공백 제거 — translateToString(true) 가 이미 뗀다). */
  frame(): string {
    return this.sm.trimmedLines().join('\n');
  }

  private logFrameIfChanged(): void {
    const f = this.frame();
    if (f === this.lastFrame) return;
    this.lastFrame = f;
    const flags = `ready=${this.sm.promptReady()} busy=${this.sm.busyIndicator()} intr=${this.sm.interrupted()} dialog=${this.sm.detectDialog().kind}`;
    fs.writeSync(this.logFd, `[${this.elapsed}] --- FRAME (raw=${this.raw}) ${flags} ---\n${f}\n--- END ---\n`);
  }

  type(s: string, label?: string): void {
    this.log(`TYPE ${label ?? JSON.stringify(s)}`);
    this.proc.write(s);
  }

  /** 픽스처 저장: 뷰포트 rows 줄 전부(뒤쪽 빈 줄은 뗀다). */
  save(name: string): string {
    const file = path.join(FIXTURES_DIR, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const f = this.frame();
    fs.writeFileSync(file, f + '\n', 'utf8');
    this.log(`SAVED ${name} (${f.split('\n').length} lines) ready=${this.sm.promptReady()} busy=${this.sm.busyIndicator()} intr=${this.sm.interrupted()} dialog=${this.sm.detectDialog().kind}`);
    return f;
  }

  /** 조건이 참이 될 때까지 폴링. 타임아웃이면 false. */
  async waitFor(pred: (sm: ScreenModel, text: string) => boolean, timeoutMs: number, label: string, everyMs = 200): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (this.exited) return false;
      if (pred(this.sm, this.frame())) {
        this.log(`OK ${label}`);
        return true;
      }
      await sleep(everyMs);
    }
    this.log(`TIMEOUT ${label} (${timeoutMs}ms)`);
    return false;
  }

  /** 화면이 quietMs 동안 안 바뀔 때까지 대기(최대 timeoutMs). */
  async settle(quietMs: number, timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs;
    let last = this.raw;
    let lastChange = Date.now();
    while (Date.now() < until) {
      await sleep(100);
      if (this.raw !== last) {
        last = this.raw;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= quietMs) return;
    }
  }

  async waitExit(timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until && !this.exited) await sleep(100);
    return !!this.exited;
  }

  /** 종료 보장: 아직 살아 있으면 kill. 남은 프로세스가 없게 하는 마지막 안전장치. */
  async close(): Promise<void> {
    clearInterval(this.frameTimer);
    this.logFrameIfChanged();
    if (!this.exited) {
      this.log('still alive → kill');
      try {
        this.proc.kill();
      } catch {}
      await this.waitExit(3000);
      if (!this.exited) {
        try {
          process.kill(this.proc.pid, 'SIGKILL');
        } catch {}
      }
    }
    this.sm.dispose();
    fs.closeSync(this.logFd);
  }
}
