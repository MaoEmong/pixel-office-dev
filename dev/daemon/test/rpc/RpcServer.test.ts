// RpcServer 테스트: 가짜 Office(OfficeApi) + 실제 ws 클라이언트. 계약은 PROTOCOL.md.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { RpcServer, CLOSE_UNAUTHORIZED } from '../../src/rpc/RpcServer.js';
import { OfficeError, RPC_ERROR } from '../../src/office/errors.js';
import type {
  ApprovalRespondParams,
  AttachResult,
  ClockInParams,
  CreateDepartmentParams,
  CreateDepartmentResult,
  CreateTeamParams,
  CreateTeamResult,
  DepartmentTree,
  HireChildParams,
  InstructOptions,
  OfficeApi,
  OfficeEvents,
  OfficeSnapshot,
} from '../../src/office/types.js';
import type { Department, EventsQueryInput, Member, OfficeEvent, Team } from '../../src/store/types.js';

// ---- 가짜 Office ---------------------------------------------------------------------

const TOKEN = 'tok-secret-0123456789abcdef';

function ev(seq: number, kind: OfficeEvent['kind'] = 'idle'): OfficeEvent {
  return { seq, ts: `2026-09-14T00:00:0${seq}.000Z`, departmentId: 'd1', teamId: 't1', memberId: 'm1', kind, detail: {}, ref: {} };
}

function member(id: string, status: Member['status'] = 'idle'): Member {
  return {
    id,
    departmentId: 'd1',
    teamId: 't1',
    parentId: 'mH',
    name: id,
    rank: 'member',
    engine: 'claude',
    sessionId: null,
    childPid: null,
    cwd: 'D:\\x',
    status,
    hiredBy: 'user',
    memberToken: 'mt-' + id,
    instructionsPath: null,
    createdAt: 'c',
    updatedAt: 'u',
  };
}

const TEAM: Team = { id: 't1', departmentId: 'd1', name: 'team', cwd: 'D:\\x', leaderId: null, maxMembers: 4, allowedEngines: ['claude', 'codex'], createdAt: 'c' };
const DEPT: Department = { id: 'd1', name: 'dept', cwd: 'D:\\x', headId: null, createdAt: 'c' };

class FakeOffice extends EventEmitter<OfficeEvents> implements OfficeApi {
  readonly token = TOKEN;
  readonly version = '9.9.9';
  readonly pid = 4242;
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  events: OfficeEvent[] = [ev(1), ev(2), ev(3, 'thinking'), ev(4, 'running'), ev(5)];
  members = new Map<string, Member>([
    ['m1', member('m1')],
    ['dead', member('dead', 'exited')],
  ]);
  shutdownCalls = 0;

  private rec(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }
  private need(memberId: string): Member {
    const m = this.members.get(memberId);
    if (!m) throw new OfficeError(RPC_ERROR.NOT_FOUND, `member not found: ${memberId}`);
    if (m.status === 'exited') throw new OfficeError(RPC_ERROR.BAD_STATE, `member ${memberId} already exited`);
    return m;
  }

  snapshot(): OfficeSnapshot {
    // T28: 스냅샷 멤버 행에는 파생 상태가 실린다(여기서는 raw 를 그대로 — RpcServer 는 통과만 시킨다).
    const members = [...this.members.values()].map((m) => ({ ...m, derived: m.status }));
    return { seq: 5, departments: [DEPT], teams: [TEAM], members, pending: [], tasks: [] };
  }
  getMember(memberId: string): Member | undefined {
    return this.members.get(memberId);
  }
  eventsSince(seq: number): OfficeEvent[] {
    this.rec('eventsSince', seq);
    return this.events.filter((e) => e.seq > seq);
  }
  eventsQuery(input: EventsQueryInput): OfficeEvent[] {
    this.rec('eventsQuery', input);
    return this.events.slice(0, input.limit ?? 200);
  }
  createDepartment(params: CreateDepartmentParams): CreateDepartmentResult {
    this.rec('createDepartment', params);
    const head = {
      ...member('mH'),
      rank: 'head' as const,
      teamId: null,
      parentId: null,
      name: params.headName ?? '부장',
      engine: params.headEngine,
      status: 'starting' as const,
    };
    this.emit('tree', 'department.create'); // 실제 Office 와 같은 자리에서(T38)
    return { department: { ...DEPT, name: params.name, cwd: params.cwd, headId: head.id }, head };
  }
  async deleteDepartment(departmentId: string): Promise<void> {
    this.rec('deleteDepartment', departmentId);
    if (departmentId !== 'd1') throw new OfficeError(RPC_ERROR.NOT_FOUND, `department not found: ${departmentId}`);
    this.emit('tree', 'department.delete');
  }
  tree(): DepartmentTree[] {
    this.rec('tree');
    return [{ department: DEPT, teams: [{ team: TEAM, members: [] }], orphans: [] }];
  }
  createTeam(params: CreateTeamParams): CreateTeamResult {
    this.rec('createTeam', params);
    const lead = {
      ...member('mL'),
      rank: 'lead' as const,
      name: params.leadName ?? '팀장',
      engine: params.leadEngine ?? ('claude' as const),
      status: 'starting' as const,
    };
    this.emit('tree', 'team.create');
    return { team: { ...TEAM, name: params.name, departmentId: params.departmentId, leaderId: lead.id }, lead };
  }
  hireChild(params: HireChildParams): Member {
    this.rec('hireChild', params);
    return member('m3', 'starting');
  }
  async deleteTeam(teamId: string): Promise<void> {
    this.rec('deleteTeam', teamId);
    if (teamId !== 't1') throw new OfficeError(RPC_ERROR.NOT_FOUND, `team not found: ${teamId}`);
    this.emit('tree', 'team.delete');
  }
  clockIn(params: ClockInParams): Member {
    this.rec('clockIn', params);
    return member('m2', 'starting');
  }
  async clockOut(memberId: string): Promise<void> {
    this.rec('clockOut', memberId);
    this.need(memberId);
  }
  async rehire(memberId: string): Promise<Member> {
    this.rec('rehire', memberId);
    return member(memberId, 'starting');
  }
  async restart(memberId: string): Promise<Member> {
    this.rec('restart', memberId);
    return this.need(memberId);
  }
  instruct(memberId: string, text: string, opts: InstructOptions = {}): number {
    this.rec('instruct', memberId, text, opts);
    this.need(memberId);
    return 7;
  }
  typeRaw(memberId: string, data: string): void {
    this.rec('typeRaw', memberId, data);
    this.need(memberId);
  }
  attach(clientId: string, memberId: string, cols: number, rows: number): AttachResult {
    this.rec('attach', clientId, memberId, cols, rows);
    this.need(memberId);
    return { screen: '\x1b[2Jscreen-of-' + memberId, cols, rows };
  }
  detach(clientId: string, memberId: string): void {
    this.rec('detach', clientId, memberId);
  }
  detachAll(clientId: string): void {
    this.rec('detachAll', clientId);
  }
  resize(clientId: string, memberId: string, cols: number, rows: number): void {
    this.rec('resize', clientId, memberId, cols, rows);
    this.need(memberId);
  }
  interrupt(memberId: string): void {
    this.rec('interrupt', memberId);
    this.need(memberId);
  }
  getInstructions(memberId: string): string {
    this.rec('getInstructions', memberId);
    this.need(memberId);
    return '# role';
  }
  setInstructions(memberId: string, markdown: string): void {
    this.rec('setInstructions', memberId, markdown);
    this.need(memberId);
  }
  buildSessionContext(memberId: string): string {
    this.rec('buildSessionContext', memberId);
    this.need(memberId);
    return '[사무실] …\n\n# role';
  }
  respondApproval(pendingId: string, decision: ApprovalRespondParams): void {
    this.rec('respondApproval', pendingId, decision);
    if (pendingId === 'nope') throw new OfficeError(RPC_ERROR.NOT_FOUND, 'pending not found: nope');
  }
  respondQuestion(pendingId: string, answers: Record<string, string>): void {
    this.rec('respondQuestion', pendingId, answers);
  }
  async shutdown(): Promise<void> {
    this.shutdownCalls++;
    this.emit('shutdown');
  }
}

// ---- 테스트용 WS 클라이언트 --------------------------------------------------------------

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

class TestClient {
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: RpcError) => void }>();
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly waiters: Array<{ pred: (n: { method: string; params: unknown }) => boolean; resolve: (n: { method: string; params: unknown }) => void }> = [];

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (typeof msg.method === 'string') {
        const n = { method: msg.method, params: msg.params };
        this.notifications.push(n);
        for (const w of [...this.waiters]) {
          if (w.pred(n)) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            w.resolve(n);
          }
        }
        return;
      }
      const id = msg.id as number;
      const w = this.waiting.get(id);
      if (!w) return;
      this.waiting.delete(id);
      if (msg.error) w.reject(msg.error as RpcError);
      else w.resolve(msg.result);
    });
  }

  static connect(port: number): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.once('open', () => resolve(new TestClient(ws)));
      ws.once('error', reject);
    });
  }

  call<T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** 응답을 기다리지 않는 원본 전송(봉투 오류 테스트용). */
  sendRaw(text: string): void {
    this.ws.send(text);
  }

  /** 다음 응답/에러 하나(원본 전송 후). */
  nextRaw(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => this.ws.once('message', (raw) => resolve(JSON.parse(raw.toString()))));
  }

  waitNotification(pred: (n: { method: string; params: unknown }) => boolean, timeoutMs = 2000): Promise<{ method: string; params: unknown }> {
    const hit = this.notifications.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('notification timeout')), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (n) => {
          clearTimeout(t);
          resolve(n);
        },
      });
    });
  }

  hello(since?: number): Promise<{ daemon: { version: string; pid: number }; snapshot: OfficeSnapshot }> {
    return this.call('hello', { token: TOKEN, since, client: { name: 'test', version: '0' } });
  }

  close(): void {
    this.ws.close();
  }
}

const expectError = async (p: Promise<unknown>, code: number): Promise<RpcError> => {
  try {
    await p;
  } catch (e) {
    const err = e as RpcError;
    assert.equal(err.code, code, `expected code ${code}, got ${JSON.stringify(err)}`);
    return err;
  }
  assert.fail(`expected error ${code}`);
};

const tick = () => new Promise((r) => setTimeout(r, 30));

// ---- 테스트 ------------------------------------------------------------------------------

describe('RpcServer', () => {
  let office: FakeOffice;
  let server: RpcServer;
  let port: number;
  const open: TestClient[] = [];

  before(async () => {
    office = new FakeOffice();
    server = new RpcServer(office, { port: 0 });
    port = await server.listen();
    assert.ok(port > 0);
  });
  after(async () => {
    for (const c of open) c.close();
    await server.close();
  });
  beforeEach(() => {
    office.calls.length = 0;
  });
  const connect = async () => {
    const c = await TestClient.connect(port);
    open.push(c);
    return c;
  };

  test('hello: valid token → daemon + snapshot, no replay without since', async () => {
    const c = await connect();
    const res = await c.hello();
    assert.deepEqual(res.daemon, { version: '9.9.9', pid: 4242 });
    assert.equal(res.snapshot.seq, 5);
    assert.equal(res.snapshot.members.length, 2);
    await tick();
    assert.equal(c.notifications.length, 0);
    assert.equal(office.calls.filter((x) => x.method === 'eventsSince').length, 0);
  });

  test('hello{since}: result first, then only events with seq > since, ascending', async () => {
    const c = await connect();
    const order: string[] = [];
    c.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      order.push(m.method ?? `result:${m.id}`);
    });
    const res = await c.hello(2);
    assert.equal(res.snapshot.seq, 5);
    await tick();
    const replayed = c.notifications.filter((n) => n.method === 'event').map((n) => (n.params as OfficeEvent).seq);
    assert.deepEqual(replayed, [3, 4, 5]);
    assert.deepEqual(order, ['result:1', 'event', 'event', 'event']);
    assert.deepEqual(office.calls.find((x) => x.method === 'eventsSince')?.args, [2]);
  });

  test('hello: bad token → -32001 and the socket is closed', async () => {
    const c = await connect();
    const err = await expectError(c.call('hello', { token: 'wrong', client: { name: 'x', version: '0' } }), RPC_ERROR.UNAUTHORIZED);
    assert.match(err.message, /token/);
    const closed = await c.closed;
    assert.equal(closed.code, CLOSE_UNAUTHORIZED);
  });

  test('unauthenticated non-hello request → -32001 and close', async () => {
    const c = await connect();
    await expectError(c.call('member.instruct', { memberId: 'm1', text: 'x' }), RPC_ERROR.UNAUTHORIZED);
    const closed = await c.closed;
    assert.equal(closed.code, CLOSE_UNAUTHORIZED);
    await tick();
    // 연결 종료 시의 detachAll 외에는 Office 에 아무것도 닿지 않는다
    assert.deepEqual(office.calls.map((x) => x.method), ['detachAll']);
  });

  test('method routing: results and Office calls', async () => {
    const c = await connect();
    await c.hello();

    assert.deepEqual(await c.call('member.instruct', { memberId: 'm1', text: 'do it' }), { taskId: 7 });
    assert.deepEqual(office.calls.at(-1), { method: 'instruct', args: ['m1', 'do it', { force: false }] });
    // force 는 "부장에게만 지시" 게이트를 넘는 디버그 탈출구(T34, D-32) — 서버가 boolean 으로 정규화해 넘긴다.
    await c.call('member.instruct', { memberId: 'm1', text: 'do it', force: true });
    assert.deepEqual(office.calls.at(-1), { method: 'instruct', args: ['m1', 'do it', { force: true }] });

    // department.create 는 부장이 자동 출근해 `{ department, head }` 를 돌려준다(T34).
    const dept = await c.call<{ department: Department; head: Member }>('department.create', {
      name: 'D',
      cwd: 'D:\\y',
      headEngine: 'claude',
      headName: '국장',
    });
    assert.equal(dept.department.name, 'D');
    assert.equal(dept.head.rank, 'head');
    assert.equal(dept.head.name, '국장');
    assert.equal(dept.head.parentId, null);
    assert.equal(dept.department.headId, dept.head.id);
    assert.deepEqual(office.calls.at(-1)?.args[0], { name: 'D', cwd: 'D:\\y', headEngine: 'claude', headName: '국장' });

    const tree = await c.call<{ departments: DepartmentTree[] }>('department.tree', {});
    assert.deepEqual(tree.departments.map((d) => d.department.id), ['d1']);

    // team.create 는 T34 부터 디버그 전용 — force 없이는 -32004, 있으면 `{ team, lead }`.
    await expectError(c.call('team.create', { departmentId: 'd1', name: 'T' }), RPC_ERROR.RANK_RULE);
    const team = await c.call<{ team: Team; lead: Member }>('team.create', {
      departmentId: 'd1',
      name: 'T',
      leadEngine: 'claude',
      leadName: '반장',
      force: true,
    });
    assert.equal(team.team.name, 'T');
    assert.equal(team.lead.rank, 'lead');
    assert.equal(team.lead.name, '반장');
    assert.equal(team.team.leaderId, team.lead.id);
    assert.deepEqual(office.calls.at(-1)?.args[0], {
      departmentId: 'd1',
      name: 'T',
      leadEngine: 'claude',
      leadName: '반장',
      maxMembers: undefined,
      allowedEngines: undefined,
    });

    // member.clockIn 도 디버그 전용(force) — parentId/rank 를 받는다.
    await expectError(c.call('member.clockIn', { teamId: 't1', engine: 'claude', name: 'kim' }), RPC_ERROR.RANK_RULE);
    const ci = await c.call<{ member: Member }>('member.clockIn', {
      teamId: 't1',
      engine: 'claude',
      name: 'kim',
      instructions: '# hi',
      force: true,
    });
    assert.equal(ci.member.id, 'm2');
    assert.deepEqual(office.calls.at(-1)?.args[0], {
      parentId: undefined,
      departmentId: undefined,
      teamId: 't1',
      engine: 'claude',
      name: 'kim',
      instructions: '# hi',
      rank: undefined,
    });
    await c.call('member.clockIn', { parentId: 'mH', engine: 'claude', name: 'kim', rank: 'lead', force: true });
    assert.deepEqual(office.calls.at(-1)?.args[0], {
      parentId: 'mH',
      departmentId: undefined,
      teamId: undefined,
      engine: 'claude',
      name: 'kim',
      instructions: undefined,
      rank: 'lead',
    });

    assert.deepEqual(await c.call('member.clockOut', { memberId: 'm1' }), {});
    assert.equal((await c.call<{ member: Member }>('member.rehire', { memberId: 'dead' })).member.id, 'dead');
    assert.equal((await c.call<{ member: Member }>('member.restart', { memberId: 'm1' })).member.id, 'm1');
    assert.deepEqual(await c.call('member.type', { memberId: 'm1', data: '' }), {}); // 빈 data 허용
    assert.deepEqual(office.calls.at(-1), { method: 'typeRaw', args: ['m1', ''] });
    assert.deepEqual(await c.call('member.interrupt', { memberId: 'm1' }), {});
    assert.deepEqual(await c.call('member.instructions.get', { memberId: 'm1' }), { markdown: '# role' });
    assert.deepEqual(await c.call('member.instructions.effective', { memberId: 'm1' }), { markdown: '[사무실] …\n\n# role' });
    assert.deepEqual(office.calls.at(-1), { method: 'buildSessionContext', args: ['m1'] });
    assert.deepEqual(await c.call('member.instructions.set', { memberId: 'm1', markdown: '' }), {});
    assert.deepEqual(office.calls.at(-1), { method: 'setInstructions', args: ['m1', ''] });

    assert.deepEqual(await c.call('approval.respond', { pendingId: 'a_1', behavior: 'allow', updatedInput: { command: 'ls' }, alwaysThisSession: true }), {});
    assert.deepEqual(office.calls.at(-1), {
      method: 'respondApproval',
      args: ['a_1', { behavior: 'allow', updatedInput: { command: 'ls' }, message: undefined, alwaysThisSession: true }],
    });
    assert.deepEqual(await c.call('question.respond', { pendingId: 'q_1', answers: { '색?': '파랑' } }), {});
    assert.deepEqual(office.calls.at(-1), { method: 'respondQuestion', args: ['q_1', { '색?': '파랑' }] });

    const q = await c.call<{ events: OfficeEvent[] }>('events.query', { teamId: 't1', limit: 2 });
    assert.equal(q.events.length, 2);
    assert.deepEqual(office.calls.at(-1)?.args[0], { departmentId: undefined, teamId: 't1', memberId: undefined, beforeSeq: undefined, limit: 2 });

    assert.deepEqual(await c.call('team.delete', { teamId: 't1' }), {});
    assert.deepEqual(await c.call('department.delete', { departmentId: 'd1' }), {});
  });

  test('error codes: -32602 params, -32002 not found, -32003 bad state, -32601 unknown method, -32700 parse, -32600 envelope', async () => {
    const c = await connect();
    await c.hello();
    await expectError(c.call('member.instruct', { text: 'x' }), RPC_ERROR.INVALID_PARAMS);
    await expectError(c.call('member.instruct', { memberId: 'm1', text: '' }), RPC_ERROR.INVALID_PARAMS);
    await expectError(c.call('member.attach', { memberId: 'm1', cols: '80', rows: 24 }), RPC_ERROR.INVALID_PARAMS);
    await expectError(c.call('approval.respond', { pendingId: 'a', behavior: 'maybe' }), RPC_ERROR.INVALID_PARAMS);
    await expectError(c.call('question.respond', { pendingId: 'q', answers: { a: 1 } }), RPC_ERROR.INVALID_PARAMS);
    await expectError(c.call('department.create', { name: 'T', cwd: 'D:\\y', headEngine: 'gpt' }), RPC_ERROR.INVALID_PARAMS);
    await expectError(c.call('team.create', { departmentId: 'd1', name: 'T', leadEngine: 'gpt', force: true }), RPC_ERROR.INVALID_PARAMS);
    await expectError(
      c.call('member.clockIn', { teamId: 't1', engine: 'claude', name: 'kim', rank: 'boss', force: true }),
      RPC_ERROR.INVALID_PARAMS,
    );
    await expectError(c.call('member.instruct', { memberId: 'missing', text: 'x' }), RPC_ERROR.NOT_FOUND);
    await expectError(c.call('approval.respond', { pendingId: 'nope', behavior: 'deny' }), RPC_ERROR.NOT_FOUND);
    await expectError(c.call('member.instruct', { memberId: 'dead', text: 'x' }), RPC_ERROR.BAD_STATE);
    await expectError(c.call('team.delete', { teamId: 'zzz' }), RPC_ERROR.NOT_FOUND);
    await expectError(c.call('department.delete', { departmentId: 'zzz' }), RPC_ERROR.NOT_FOUND);
    await expectError(c.call('member.fire', { memberId: 'm1' }), RPC_ERROR.METHOD_NOT_FOUND);

    c.sendRaw('{not json');
    const parse = await c.nextRaw();
    assert.equal((parse.error as RpcError).code, RPC_ERROR.PARSE_ERROR);
    assert.equal(parse.id, null);

    c.sendRaw(JSON.stringify({ id: 9, method: 'x' })); // jsonrpc 누락
    const env = await c.nextRaw();
    assert.equal((env.error as RpcError).code, RPC_ERROR.INVALID_REQUEST);
    assert.equal(env.id, 9);

    // 소켓은 여전히 열려 있다(인증 후 오류는 연결을 끊지 않는다)
    assert.deepEqual(await c.call('member.interrupt', { memberId: 'm1' }), {});
  });

  test('notifications: event/member.status/daemon.notice broadcast to authed clients only; term only to attached', async () => {
    const a = await connect();
    const b = await connect();
    const unauthed = await connect();
    await a.hello();
    await b.hello();

    const res = await a.call<AttachResult>('member.attach', { memberId: 'm1', cols: 100, rows: 30 });
    assert.equal(res.screen, '\x1b[2Jscreen-of-m1');
    assert.deepEqual([res.cols, res.rows], [100, 30]);
    const attachCall = office.calls.find((x) => x.method === 'attach')!;
    assert.equal(typeof attachCall.args[0], 'string'); // clientId 는 서버가 만든다

    office.emit('term', 'm1', 'hello-m1');
    office.emit('term', 'm2', 'hello-m2');
    office.emit('event', ev(6, 'running'));
    office.emit('status', 'm1', 'working', 'working');
    office.emit('notice', 'warn', 'careful');
    await tick();

    const terms = (c: TestClient) => c.notifications.filter((n) => n.method === 'term').map((n) => n.params);
    assert.deepEqual(terms(a), [{ memberId: 'm1', data: 'hello-m1' }]);
    assert.deepEqual(terms(b), []);
    for (const c of [a, b]) {
      assert.deepEqual(c.notifications.find((n) => n.method === 'event')?.params, ev(6, 'running'));
      const st = c.notifications.find((n) => n.method === 'member.status')?.params as Record<string, unknown>;
      assert.equal(st.memberId, 'm1');
      assert.equal(st.status, 'working');
      assert.equal(st.derived, 'working');
      assert.equal((st.member as Member).name, 'm1');
      assert.deepEqual(c.notifications.find((n) => n.method === 'daemon.notice')?.params, { level: 'warn', message: 'careful' });
    }
    assert.equal(unauthed.notifications.length, 0);

    // detach 후에는 term 이 오지 않는다
    await a.call('member.detach', { memberId: 'm1' });
    office.emit('term', 'm1', 'after-detach');
    await tick();
    assert.equal(terms(a).length, 1);
    assert.deepEqual(office.calls.find((x) => x.method === 'detach')?.args, [attachCall.args[0], 'm1']);
  });

  // T38: 부서·팀 행의 생멸을 알리는 알림은 `snapshot` 하나뿐이다(T37 함정 ① — 콘솔에서 지운 부서가 앱에 남아 있었다).
  test('snapshot push: 트리가 바뀌면(부서·팀 생성/삭제) 전 클라이언트에 snapshot 알림 — 응답이 먼저다', async () => {
    const a = await connect();
    const b = await connect();
    const unauthed = await connect();
    await a.hello();
    await b.hello();
    const order: string[] = [];
    a.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>;
      order.push(typeof m.method === 'string' ? m.method : 'result');
    });

    await a.call('department.create', { name: 'D', cwd: 'D:\\y', headEngine: 'claude' });
    const pushed = await b.waitNotification((n) => n.method === 'snapshot');
    // hello 스냅샷과 **같은 내용**이라 클라이언트는 같은 코드로 적용하면 된다.
    assert.deepEqual(pushed.params, office.snapshot());
    await tick();
    // 요청한 클라이언트에게도 가되, 응답 뒤에 온다(setImmediate).
    assert.deepEqual(order, ['result', 'snapshot']);
    assert.equal(unauthed.notifications.length, 0);

    const count = (c: TestClient) => c.notifications.filter((n) => n.method === 'snapshot').length;
    await a.call('team.create', { departmentId: 'd1', name: 'T', force: true });
    await a.call('team.delete', { teamId: 't1' });
    await a.call('department.delete', { departmentId: 'd1' });
    await tick();
    assert.deepEqual([count(a), count(b)], [4, 4]);

    // 실패한 호출은 트리를 바꾸지 않으므로 아무것도 밀지 않는다.
    await expectError(a.call('department.delete', { departmentId: 'zzz' }), RPC_ERROR.NOT_FOUND);
    await expectError(a.call('team.create', { departmentId: 'd1', name: 'T' }), RPC_ERROR.RANK_RULE);
    await tick();
    assert.deepEqual([count(a), count(b)], [4, 4]);
  });

  test('client close → Office.detachAll(clientId) with the same clientId used for attach', async () => {
    const a = await connect();
    await a.hello();
    await a.call('member.attach', { memberId: 'm1', cols: 80, rows: 24 });
    const clientId = office.calls.find((x) => x.method === 'attach')!.args[0];
    const before = server.clientCount;
    a.close();
    await a.closed;
    await tick();
    assert.deepEqual(office.calls.at(-1), { method: 'detachAll', args: [clientId] });
    assert.equal(server.clientCount, before - 1);
  });

  test('daemon.shutdown → {} reply first, then daemon.notice and Office.shutdown()', async () => {
    const c = await connect();
    await c.hello();
    assert.equal(office.shutdownCalls, 0);
    assert.deepEqual(await c.call('daemon.shutdown', {}), {});
    const n = await c.waitNotification((x) => x.method === 'daemon.notice');
    assert.deepEqual(n.params, { level: 'info', message: 'daemon shutting down' });
    await tick();
    assert.equal(office.shutdownCalls, 1);
  });
});
