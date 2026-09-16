// Office 테스트: 인메모리 Store + 가짜 PtyManager/HookReceiver. 화면은 실제 ScreenModel 에 스파이크 픽스처를 흘려 넣는다.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office, RESUMED_TEXT } from '../../src/office/Office.js';
import { RPC_ERROR } from '../../src/office/errors.js';
import type { HookReceiverLike, OfficeEvents, PtyManagerLike } from '../../src/office/types.js';
import { Store } from '../../src/store/Store.js';
import type { Member, OfficeEvent, Team } from '../../src/store/types.js';
import type { ExitInfo, KeyName, PtySession, SpawnOptions } from '../../src/pty/types.js';
import type { DecisionHandle, HookReceiverEvents, HookRequest } from '../../src/hooks/HookReceiver.js';
import type { HookEvent, HookPayload } from '../../src/hooks/types.js';
import { allow, sessionStartContext } from '../../src/hooks/decisions.js';
import { loadFixture } from '../screen/helpers.js';
import { seedDeptTeam } from './fakes.js';

// ---- 가짜 pty ----------------------------------------------------------------------------

class FakeSession implements PtySession {
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

class FakePty extends EventEmitter<PtyEvents> implements PtyManagerLike {
  readonly spawns: SpawnOptions[] = [];
  readonly kills: Array<{ memberId: string; graceful?: boolean }> = [];
  readonly sessions = new Map<string, FakeSession>();
  private nextPid = 1000;
  spawn(opts: SpawnOptions): PtySession {
    const existing = this.sessions.get(opts.memberId);
    if (existing?.alive) throw new Error('already live');
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
  async kill(memberId: string, opts: { graceful?: boolean } = {}): Promise<void> {
    this.kills.push({ memberId, graceful: opts.graceful });
    const s = this.sessions.get(memberId);
    if (!s?.alive) return;
    if (opts.graceful) s.writes.push('/exit\r');
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
  last(): FakeSession {
    return [...this.sessions.values()].at(-1)!;
  }
}

class FakeReceiver extends EventEmitter<HookReceiverEvents> implements HookReceiverLike {
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

// ---- 가짜 HookRequest (adapter 테스트와 같은 모양) --------------------------------------------

interface FakeReq {
  req: HookRequest;
  sent: unknown[];
  handle: () => DecisionHandle | undefined;
}

function fakeReq(memberToken: string, event: HookEvent, payload: HookPayload): FakeReq {
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

const SID = 'sess-0001';
const base = (event: string) => ({ session_id: SID, hook_event_name: event, cwd: 'D:\\x' });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readyScreen = () => loadFixture('claude-ready.txt').join('\r\n');

// ---- 테스트 -------------------------------------------------------------------------------

describe('Office', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let office: Office;
  let team: Team;
  let events: OfficeEvent[];
  let statuses: Array<[string, string, string]>;
  let notices: string[];

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t07-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty, receiver, version: '1.2.3' });
    events = [];
    statuses = [];
    notices = [];
    office.on('event', (e) => events.push(e));
    office.on('status', (id, s, d) => statuses.push([id, s, d]));
    office.on('notice', (l, m) => notices.push(`${l}: ${m}`));
    await office.start();
    // 팀장 없는 팀(store 직접) — 이 파일은 멤버 수명·입력·복구를 본다. team.create 의 팀장 자동 출근(T24)은 TeamRank.test.ts.
    team = seedDeptTeam(store, { name: 'alpha', cwd: dataDir, maxMembers: 2 }).team;
  });
  afterEach(async () => {
    await office.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** SessionStart hook 을 보내 status 를 idle 로. */
  const sessionStart = (m: Member, source = 'startup') => {
    const r = fakeReq(m.memberToken, 'SessionStart', { ...base('SessionStart'), source });
    receiver.emit('hook', r.req);
    return r;
  };
  /** 준비 화면을 흘려 넣고 xterm 파싱을 기다린다. */
  const feedReady = async (m: Member) => {
    pty.data(m.id, readyScreen());
    await sleep(60);
  };
  const clockIn = (name = 'kim', instructions?: string) => office.clockIn({ teamId: team.id, engine: 'claude', name, instructions });

  test('start(): daemon.json has wsPort/hookPort/mcpPort/token/pid/startedAt/version; token is 32 random bytes', async () => {
    const info = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.json'), 'utf8'));
    assert.deepEqual(Object.keys(info).sort(), ['hookPort', 'mcpPort', 'pid', 'startedAt', 'token', 'version', 'wsPort']);
    assert.equal(info.hookPort, 45678);
    // T17: TeamTools MCP 는 실제 서버(임시 포트) — 0 이 아닌 실제 바인딩 포트가 기록된다
    assert.ok(Number.isInteger(info.mcpPort) && info.mcpPort > 0, `mcpPort bound: ${info.mcpPort}`);
    assert.equal(info.mcpPort, office.mcp.port);
    assert.equal(info.pid, process.pid);
    assert.equal(info.version, '1.2.3');
    assert.match(info.token, /^[0-9a-f]{64}$/);
    assert.equal(info.token, office.token);
    const other = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store: new Store(':memory:'), pty: new FakePty(), receiver: new FakeReceiver() });
    assert.notEqual(other.token, office.token);
    office.updateDaemonInfo({ wsPort: 4321 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.json'), 'utf8')).wsPort, 4321);
  });

  test('clockIn: member row + spawn options (PIXEL_MEMBER token, forward-slash hook.js, hook port) + INSTRUCTIONS.md', () => {
    const m = clockIn('kim', '# 역할\n테스터');
    assert.equal(m.teamId, team.id);
    assert.equal(m.rank, 'member');
    assert.equal(m.hiredBy, 'user');
    assert.equal(m.engine, 'claude');
    assert.equal(m.status, 'starting');
    assert.equal(m.cwd, team.cwd);
    assert.equal(m.childPid, 1000);
    assert.match(m.memberToken, /^[0-9a-f]{48}$/);

    assert.equal(pty.spawns.length, 1);
    const opts = pty.spawns[0]!;
    assert.equal(opts.memberId, m.id);
    assert.equal(opts.memberToken, m.memberToken);
    assert.equal(opts.engine, 'claude');
    assert.equal(opts.cwd, team.cwd);
    assert.equal(opts.resumeSessionId, undefined);
    assert.equal(opts.hookPort, 45678);
    assert.deepEqual([opts.cols, opts.rows], [120, 40]);
    assert.ok(!opts.hookScriptPath.includes('\\'), `hook path must use forward slashes: ${opts.hookScriptPath}`);
    assert.ok(opts.hookScriptPath.endsWith('/src/hooks/hook.js'), opts.hookScriptPath);
    assert.ok(fs.existsSync(opts.hookScriptPath.replace(/\//g, path.sep)), 'hook.js exists');

    const expectedPath = path.join(dataDir, 'teams', team.id, 'members', m.id, 'INSTRUCTIONS.md');
    assert.equal(m.instructionsPath, expectedPath);
    assert.equal(fs.readFileSync(expectedPath, 'utf8'), '# 역할\n테스터');
    assert.equal(office.getInstructions(m.id), '# 역할\n테스터');
    assert.deepEqual(statuses, [[m.id, 'starting', 'starting']]);

    // 팀 정원·엔진 허용 검사
    clockIn('lee');
    assert.throws(() => clockIn('park'), (e: { code: number }) => e.code === RPC_ERROR.BAD_STATE);
    const t2 = seedDeptTeam(store, { name: 'codex-only', cwd: dataDir, allowedEngines: ['codex'] }).team;
    assert.throws(() => office.clockIn({ teamId: t2.id, engine: 'claude', name: 'x' }), (e: { code: number }) => e.code === RPC_ERROR.INVALID_PARAMS);
    assert.throws(() => office.clockIn({ teamId: 'nope', engine: 'claude', name: 'x' }), (e: { code: number }) => e.code === RPC_ERROR.NOT_FOUND);
    // T34: cwd 검사는 부서로 옮겨졌다(팀은 부서 cwd 를 물려받는다).
    assert.throws(
      () => office.createDepartment({ name: 'bad', cwd: path.join(dataDir, 'missing'), headEngine: 'claude' }),
      (e: { code: number }) => e.code === RPC_ERROR.INVALID_PARAMS,
    );
  });

  test("hook 'hook' routes by member token to the adapter; unknown token → notice only", () => {
    const m = clockIn('kim', 'be nice');
    const r = sessionStart(m);
    // T26b: 주입 텍스트 = 런타임 프리앰블 + 사용자 지시문(자세한 내용은 Instructions.test.ts).
    assert.deepEqual(r.sent, [sessionStartContext(office.buildSessionContext(m.id))]);
    assert.ok(office.buildSessionContext(m.id).endsWith('\n\nbe nice'));
    const after = store.getMember(m.id)!;
    assert.equal(after.status, 'idle');
    assert.equal(after.sessionId, SID);
    assert.deepEqual(statuses.at(-1), [m.id, 'idle', 'free']);

    const stranger = fakeReq('no-such-token', 'Stop', base('Stop'));
    receiver.emit('hook', stranger.req);
    assert.equal(stranger.sent.length, 0); // 응답 안 함 → receiver 가 {} 로 닫는다
    assert.ok(notices.some((n) => n.startsWith('warn: hook Stop from unknown member token')));
    assert.equal(events.length, 0);

    // pty 출력은 term 으로 흘리고 ScreenModel 에 들어간다
    const terms: string[] = [];
    office.on('term', (id, d) => terms.push(`${id}:${d}`));
    pty.data(m.id, 'abc');
    assert.deepEqual(terms, [`${m.id}:abc`]);
  });

  test('instruct: task(from user, queued) + `[TASK#n from user]` pasted when idle ∧ prompt ready; Stop → reported + reporting event', async () => {
    const m = clockIn();
    const session = pty.last();
    // 아직 starting → 큐에 머문다
    const t1 = office.instruct(m.id, 'hello\nworld');
    assert.equal(t1, 1);
    const task = store.getTask(1)!;
    assert.equal(task.fromMember, 'user');
    assert.equal(task.toMember, m.id);
    assert.equal(task.status, 'queued');
    assert.equal(task.instruction, 'hello\nworld');
    assert.equal(session.pastes.length, 0);

    sessionStart(m); // idle
    assert.equal(session.pastes.length, 0); // 화면이 아직 준비 안 됨
    await feedReady(m);
    await sleep(600); // 폴링 500ms 안에 flush
    assert.deepEqual(session.pastes, ['[TASK#1 from user]\nhello\nworld']);
    await sleep(400); // Enter 는 300ms 뒤
    assert.ok(session.keys.includes('enter'));
    assert.equal(store.getTask(1)!.status, 'assigned');

    // 턴 종료: text + idle → task reported(report_text = last_assistant_message) + reporting 이벤트
    receiver.emit('hook', fakeReq(m.memberToken, 'UserPromptSubmit', { ...base('UserPromptSubmit'), prompt: '[TASK#1 from user]' }).req);
    receiver.emit('hook', fakeReq(m.memberToken, 'Stop', { ...base('Stop'), last_assistant_message: '다 했다.' }).req);
    const done = store.getTask(1)!;
    assert.equal(done.status, 'reported');
    assert.equal(done.reportStatus, 'done');
    assert.equal(done.reportText, '다 했다.');
    assert.deepEqual(
      events.map((e) => e.kind),
      ['thinking', 'text', 'idle', 'reporting'],
    );
    assert.deepEqual(events.at(-1)!.ref, { taskId: 1 });
    assert.equal(events.at(-1)!.detail.summary, '다 했다.');
    assert.deepEqual(statuses.at(-1), [m.id, 'idle', 'free']);

    // 종료된 멤버에게 지시 → -32003, 없는 멤버 → -32002
    assert.throws(() => office.instruct('nope', 'x'), (e: { code: number }) => e.code === RPC_ERROR.NOT_FOUND);
  });

  test('clockOut: aborts open tasks, expires pending, kills gracefully, status exited; second clockOut → -32003; rehire resumes', async () => {
    const m = clockIn();
    sessionStart(m);
    office.instruct(m.id, 'never typed');
    const session = pty.last();
    await office.clockOut(m.id);
    assert.deepEqual(pty.kills, [{ memberId: m.id, graceful: true }]);
    assert.ok(session.writes.includes('/exit\r'));
    const after = store.getMember(m.id)!;
    assert.equal(after.status, 'exited');
    assert.equal(after.childPid, null);
    assert.equal(store.getTask(1)!.status, 'aborted');
    assert.equal(store.getTask(1)!.reportStatus, 'aborted');
    assert.equal(events.filter((e) => e.kind === 'error').length, 0); // 의도한 종료엔 error 이벤트 없음
    assert.equal(events.at(-1)!.kind, 'idle');
    assert.equal(events.at(-1)!.detail.summary, 'clocked out');
    assert.ok(statuses.some(([id, s]) => id === m.id && s === 'exited'));
    await assert.rejects(office.clockOut(m.id), (e: { code: number }) => e.code === RPC_ERROR.BAD_STATE);
    assert.throws(() => office.instruct(m.id, 'x'), (e: { code: number }) => e.code === RPC_ERROR.BAD_STATE);

    const re = await office.rehire(m.id);
    assert.equal(re.status, 'starting');
    assert.equal(pty.spawns.at(-1)!.resumeSessionId, SID);
    assert.equal(pty.spawns.at(-1)!.memberToken, m.memberToken);
    await assert.rejects(office.rehire(m.id), (e: { code: number }) => e.code === RPC_ERROR.BAD_STATE);
  });

  test('restart: kills, respawns with --resume, enqueues [RESUMED] as a system item', async () => {
    const m = clockIn();
    sessionStart(m);
    const first = pty.last();
    const re = await office.restart(m.id);
    assert.equal(first.alive, false);
    assert.equal(re.status, 'starting');
    assert.equal(pty.spawns.length, 2);
    assert.equal(pty.spawns[1]!.resumeSessionId, SID);
    const second = pty.last();
    assert.notEqual(second, first);
    // 새 세션이 idle + 준비 화면이 되면 [RESUMED] 가 붙여넣어진다
    sessionStart(m, 'resume');
    await feedReady(m);
    await sleep(600);
    assert.deepEqual(second.pastes, [RESUMED_TEXT]);
    assert.ok(events.some((e) => e.kind === 'text' && e.detail.summary === 'resumed'));
  });

  test('approval: PermissionRequest → pending + waiting_approval; respondApproval sends allow JSON; alwaysThisSession auto-allows next', async () => {
    const m = clockIn();
    sessionStart(m);
    const pr = fakeReq(m.memberToken, 'PermissionRequest', { ...base('PermissionRequest'), tool_name: 'Bash', tool_input: { command: 'echo 1' } });
    receiver.emit('hook', pr.req);
    const pending = store.listOpenPending(m.id);
    assert.equal(pending.length, 1);
    assert.equal(store.getMember(m.id)!.status, 'waiting_approval');
    assert.equal(events.at(-1)!.kind, 'waiting_approval');
    assert.equal(events.at(-1)!.ref.approvalId, pending[0]!.id);

    assert.throws(() => office.respondApproval('a_nope', { behavior: 'allow' }), (e: { code: number }) => e.code === RPC_ERROR.NOT_FOUND);
    assert.throws(() => office.respondQuestion(pending[0]!.id, {}), (e: { code: number }) => e.code === RPC_ERROR.INVALID_PARAMS);
    office.respondApproval(pending[0]!.id, { behavior: 'allow', alwaysThisSession: true });
    assert.deepEqual(pr.sent, [allow()]);
    assert.equal(store.getPending(pending[0]!.id)!.status, 'answered');
    assert.equal(store.getMember(m.id)!.status, 'working');
    assert.throws(() => office.respondApproval(pending[0]!.id, { behavior: 'deny' }), (e: { code: number }) => e.code === RPC_ERROR.BAD_STATE);

    // 같은 도구의 다음 요청은 자동 allow(다음 매크로태스크)
    const pr2 = fakeReq(m.memberToken, 'PermissionRequest', { ...base('PermissionRequest'), tool_name: 'Bash', tool_input: { command: 'echo 2' } });
    receiver.emit('hook', pr2.req);
    assert.equal(pr2.sent.length, 0);
    await sleep(20);
    assert.deepEqual(pr2.sent, [allow()]);
    assert.equal(store.listOpenPending(m.id).length, 0);
    assert.ok(notices.some((n) => n.includes('auto-allowed Bash')));
    // 다른 도구는 그대로 대기
    const pr3 = fakeReq(m.memberToken, 'PermissionRequest', { ...base('PermissionRequest'), tool_name: 'Write', tool_input: { file_path: 'a' } });
    receiver.emit('hook', pr3.req);
    await sleep(20);
    assert.equal(pr3.sent.length, 0);
    assert.equal(store.listOpenPending(m.id).length, 1);
  });

  test('attach/detach/resize: last attached client owns resize; attach returns the serialized screen', async () => {
    const m = clockIn();
    const session = pty.last();
    pty.data(m.id, 'hello screen');
    await sleep(30);
    const a = office.attach('A', m.id, 100, 30);
    assert.match(a.screen, /hello screen/);
    assert.deepEqual([a.cols, a.rows], [100, 30]);
    assert.deepEqual(session.resizes, [[100, 30]]);

    office.attach('B', m.id, 90, 25);
    assert.deepEqual(session.resizes.at(-1), [90, 25]);
    office.resize('A', m.id, 80, 24); // A 는 마지막 attach 가 아니므로 무시
    assert.deepEqual(session.resizes.at(-1), [90, 25]);
    office.resize('B', m.id, 80, 24);
    assert.deepEqual(session.resizes.at(-1), [80, 24]);
    assert.deepEqual(office.attachedClients(m.id), { clients: ['A', 'B'], last: 'B' });

    office.detach('B', m.id);
    assert.deepEqual(office.attachedClients(m.id), { clients: ['A'], last: 'A' });
    office.detachAll('A');
    assert.deepEqual(office.attachedClients(m.id), { clients: [], last: undefined });
    assert.throws(() => office.attach('A', m.id, 5, 5), (e: { code: number }) => e.code === RPC_ERROR.INVALID_PARAMS);
    assert.throws(() => office.attach('A', 'nope', 80, 24), (e: { code: number }) => e.code === RPC_ERROR.NOT_FOUND);
  });

  test('interrupt: ctrl-c, queue cleared, tasks aborted, second interrupt within guard → -32003; screen-based idle', async () => {
    const m = clockIn();
    sessionStart(m);
    receiver.emit('hook', fakeReq(m.memberToken, 'UserPromptSubmit', { ...base('UserPromptSubmit'), prompt: 'go' }).req);
    assert.equal(store.getMember(m.id)!.status, 'working');
    office.instruct(m.id, 'queued while working');
    const session = pty.last();
    office.interrupt(m.id);
    assert.deepEqual(session.keys, ['ctrl-c']);
    assert.equal(store.getTask(1)!.status, 'aborted');
    assert.throws(() => office.interrupt(m.id), (e: { code: number }) => e.code === RPC_ERROR.BAD_STATE);
    assert.equal(session.keys.length, 1);
    // 중단 후 준비 화면이 보이면 idle 로(Stop hook 없음)
    pty.data(m.id, loadFixture('claude-interrupted.txt').join('\r\n'));
    await sleep(400);
    assert.equal(store.getMember(m.id)!.status, 'idle');
    assert.ok(events.some((e) => e.kind === 'idle' && e.detail.summary === 'interrupted'));
    assert.equal(session.pastes.length, 0); // 큐가 비워졌으니 아무것도 안 들어간다
  });

  test('unexpected pty exit: adapter error event + status error, tasks aborted; typeRaw writes immediately', () => {
    const m = clockIn();
    sessionStart(m);
    office.instruct(m.id, 'x');
    office.typeRaw(m.id, 'ls\r');
    assert.ok(pty.last().writes.includes('ls\r'));
    pty.exit(m.id, 1);
    const after = store.getMember(m.id)!;
    assert.equal(after.status, 'error');
    assert.equal(after.childPid, null);
    const err = [...events].reverse().find((e) => e.kind === 'error')!;
    assert.equal(err.detail.exitCode, 1);
    assert.equal(store.getTask(1)!.status, 'aborted');
    // T25 후처리: 중단된 task 의 발행자(여기선 사용자)에게 aborted 보고가 바로 간다 — 내 책상 카드용.
    const aborted = events.at(-1)!;
    assert.equal(aborted.kind, 'reporting');
    assert.equal(aborted.detail.status, 'aborted');
    assert.equal(aborted.ref.taskId, 1);
    assert.throws(() => office.typeRaw(m.id, 'x'), (e: { code: number }) => e.code === RPC_ERROR.BAD_STATE);
  });

  test('deleteTeam clocks out live members and removes rows; shutdown keeps member status for T09', async () => {
    const m = clockIn();
    sessionStart(m);
    await office.deleteTeam(team.id);
    assert.equal(store.getTeam(team.id), undefined);
    assert.equal(store.getMember(m.id), undefined);
    assert.deepEqual(pty.kills, [{ memberId: m.id, graceful: true }]);

    const t2 = seedDeptTeam(store, { name: 'b', cwd: dataDir }).team;
    const m2 = office.clockIn({ teamId: t2.id, engine: 'claude', name: 'z' });
    sessionStart(m2);
    receiver.emit('hook', fakeReq(m2.memberToken, 'UserPromptSubmit', { ...base('UserPromptSubmit'), prompt: 'go' }).req);
    let shut = 0;
    office.on('shutdown', () => shut++);
    await office.shutdown();
    assert.equal(shut, 1);
    assert.equal(receiver.closed, true);
    assert.equal(pty.last(), undefined);
    assert.equal(fs.existsSync(path.join(dataDir, 'daemon.json')), false);
    // store 는 닫혔으므로 새로 열어 확인할 수 없지만(메모리 DB), 종료 직전 status 는 working 그대로였다
    assert.equal(statuses.at(-1)![1], 'working');
    await office.shutdown(); // 두 번째는 no-op
    // afterEach 의 shutdown 도 no-op — 새 store 를 만들어 두 번째 close 를 막을 필요 없음
  });
});
