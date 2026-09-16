// Office 테스트 공통 가짜(T09 Recovery.test.ts 용). Office.test.ts 의 인라인 가짜와 같은 모양 — spawn 옵션·write/paste/keys 를 기록하고
// exit()/data() 로 pty 이벤트를 주입한다.
import { EventEmitter } from 'node:events';
import type { HookReceiverLike, PtyManagerLike, TeamToolsServerLike } from '../../src/office/types.js';
import type { ExitInfo, KeyName, PtySession, SpawnOptions } from '../../src/pty/types.js';
import { gracefulQuit } from '../../src/pty/PtyManager.js';
import type { DecisionHandle, HookReceiverEvents, HookRequest } from '../../src/hooks/HookReceiver.js';
import type { HookEvent, HookPayload } from '../../src/hooks/types.js';

export class FakeSession implements PtySession {
  alive = true;
  readonly writes: string[] = [];
  readonly pastes: string[] = [];
  readonly keys: KeyName[] = [];
  readonly resizes: Array<[number, number]> = [];
  constructor(
    readonly memberId: string,
    readonly engine: 'claude' | 'codex',
    readonly pid: number,
  ) {}
  write(text: string): void {
    if (!this.alive) throw new Error('not alive');
    this.writes.push(text);
  }
  paste(text: string): void {
    this.pastes.push(text);
    this.write('\x1b[200~' + text + '\x1b[201~');
  }
  sendKeys(k: KeyName): void {
    if (!this.alive) throw new Error('not alive');
    this.keys.push(k);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    this.alive = false;
  }
}

type PtyEvents = { data: [string, string]; exit: [string, ExitInfo]; warn: [string, string] };

export class FakePty extends EventEmitter<PtyEvents> implements PtyManagerLike {
  readonly spawns: SpawnOptions[] = [];
  readonly kills: Array<{ memberId: string; graceful?: boolean }> = [];
  readonly sessions = new Map<string, FakeSession>();
  /** memberId 별로 spawn 을 실패시킨다(복구가 throw 를 삼키는지 검증). */
  readonly failSpawnFor = new Set<string>();
  /** 첫 종료 입력으로 안 죽는 멤버(정중한 종료의 두 번째 Ctrl+C 를 보게 한다). */
  readonly stubborn = new Set<string>();
  private nextPid = 1000;
  spawn(opts: SpawnOptions): PtySession {
    const existing = this.sessions.get(opts.memberId);
    if (existing?.alive) throw new Error('already live');
    if (this.failSpawnFor.has(opts.memberId)) throw new Error(`spawn refused for ${opts.memberId}`);
    this.spawns.push(opts);
    const s = new FakeSession(opts.memberId, opts.engine, this.nextPid++);
    this.sessions.set(opts.memberId, s);
    return s;
  }
  get(memberId: string): PtySession | undefined {
    return this.sessions.get(memberId);
  }
  list(): PtySession[] {
    return [...this.sessions.values()];
  }
  /**
   * graceful 이면 진짜 종료 시퀀스(PtyManager.gracefulQuit)를 세션에 보낸다 — Claude `/exit`, Codex Ctrl+C.
   * 기본 세션은 첫 종료 입력에 죽는다(실측: idle Codex 는 Ctrl+C 한 번이면 끝). stubborn 에 넣은 멤버는 안 죽어
   * 두 번째 Ctrl+C 까지 받는다(턴 진행 중 시나리오).
   */
  async kill(memberId: string, opts: { graceful?: boolean } = {}): Promise<void> {
    this.kills.push({ memberId, graceful: opts.graceful });
    const s = this.sessions.get(memberId);
    if (!s?.alive) return;
    if (opts.graceful) await gracefulQuit(s, () => Promise.resolve(!this.stubborn.has(memberId)), { firstWaitMs: 0, timeoutMs: 0 });
    this.exit(memberId, 0);
  }
  /** 자식 종료 시뮬레이션(PtyManager 처럼 map 에서 지우고 exit 을 낸다). */
  exit(memberId: string, exitCode: number): void {
    const s = this.sessions.get(memberId);
    if (!s) return;
    s.alive = false;
    this.sessions.delete(memberId);
    this.emit('exit', memberId, { exitCode });
  }
  data(memberId: string, chunk: string): void {
    this.emit('data', memberId, chunk);
  }
  session(memberId: string): FakeSession {
    const s = this.sessions.get(memberId);
    if (!s) throw new Error(`no fake session for ${memberId}`);
    return s;
  }
}

/** TeamTools MCP 서버 가짜(T28): 어떤 멤버 토큰의 연결이 언제 끊겼는지만 기록한다. */
export class FakeMcp implements TeamToolsServerLike {
  port = 0;
  closed = false;
  /** dispose 된 memberToken(호출 순서대로). */
  readonly disposed: string[] = [];
  async listen(port: number): Promise<number> {
    this.port = port || 45679;
    return this.port;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  dispose(memberToken: string): void {
    this.disposed.push(memberToken);
  }
}

export class FakeReceiver extends EventEmitter<HookReceiverEvents> implements HookReceiverLike {
  port = 0;
  closed = false;
  async listen(port: number): Promise<number> {
    this.port = port || 45678;
    return this.port;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface FakeReq {
  req: HookRequest;
  sent: unknown[];
  handle: () => DecisionHandle | undefined;
}

export function fakeReq(memberToken: string, event: HookEvent, payload: HookPayload): FakeReq {
  const sent: unknown[] = [];
  let state: 'open' | 'responded' | 'held' = 'open';
  let handle: DecisionHandle | undefined;
  const req: HookRequest = {
    memberToken,
    event,
    payload,
    respond(json) {
      if (state !== 'open') return false;
      state = 'responded';
      sent.push(json);
      return true;
    },
    hold() {
      if (state !== 'open') throw new Error(`already ${state}`);
      state = 'held';
      let settled = false;
      handle = {
        memberToken,
        event,
        since: Date.now(),
        get settled() {
          return settled;
        },
        resolve(json) {
          if (settled) return false;
          settled = true;
          sent.push(json);
          return true;
        },
        cancel() {
          if (settled) return false;
          settled = true;
          sent.push({});
          return true;
        },
      };
      return handle;
    },
  };
  return { req, sent, handle: () => handle };
}
