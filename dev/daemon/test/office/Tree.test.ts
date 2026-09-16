// T34 — 트리 동작(구조는 TeamRank.test.ts, 여기서는 **움직임**). D-32 직무 체계 rev 3.
//   ① 부서 생성 → 부장 출근 → 사용자 지시는 부장에게만(-32004) → 부장이 낸 일은 팀장에게로
//   ② 파생 상태 `waiting_reports` 는 직급을 가리지 않는다 — 부장도 팀장도 부하 보고를 기다리면 같은 상태
//   ③ `[TEAM]` 알림은 팀이 아니라 **직속 상사**에게 간다(사용자가 끼워 넣은 멤버 / 사용자가 퇴근시킨 멤버)
//   ④ `department.delete` 는 하위 트리를 잎부터 정리한다 — task aborted, pty 종료 순서, MCP 토큰 정리
//   ⑤ 셸 락 범위는 부서(같은 부서의 다른 팀끼리도 직렬화된다)
//   ⑥ 스냅샷에 `departments[]` 와 트리 필드가 실린다
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office } from '../../src/office/Office.js';
import { RPC_ERROR } from '../../src/office/errors.js';
import { derivedStatus } from '../../src/office/derived.js';
import { Store } from '../../src/store/Store.js';
import type { Department, Member, Team } from '../../src/store/types.js';
import { loadFixture } from '../screen/helpers.js';
import { FakeMcp, FakePty, FakeReceiver, fakeReq, makeTree } from './fakes.js';

const SID = 'sess-t34';
const base = (event: string) => ({ session_id: SID, hook_event_name: event, cwd: 'D:\\x' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readyScreen = () => loadFixture('claude-ready.txt').join('\r\n');
const FLUSH_MS = 700;
/** 연속 두 항목: enterDelay(300) + busyAfterFlush(1500) 를 넘겨야 다음 paste 가 나간다. */
const SECOND_FLUSH_MS = 2400;
const code = (e: unknown) => (e as { code?: number }).code;

describe('직무 체계 rev 3 — 트리 동작 (T34)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let mcp: FakeMcp;
  let office: Office;
  let department: Department;
  let head: Member;
  let team: Team;
  let lead: Member;
  let statuses: Array<[string, string, string]>;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-tree-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    mcp = new FakeMcp();
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty, receiver, mcp, version: 't34' });
    statuses = [];
    office.on('status', (id, s, d) => statuses.push([id, s, d]));
    await office.start();
    const t = makeTree(office, { name: 'alpha', cwd: dataDir, headName: '국장', leadName: '반장', maxMembers: 4 });
    department = t.department;
    head = t.head;
    team = t.team;
    lead = t.lead;
  });
  afterEach(async () => {
    await office.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const hook = (m: Member, event: 'SessionStart' | 'UserPromptSubmit' | 'Stop', extra: Record<string, unknown> = {}) => {
    const r = fakeReq(m.memberToken, event, { ...base(event), ...extra });
    receiver.emit('hook', r.req);
    return r;
  };
  /** SessionStart + 준비 화면 — 이 뒤로 큐가 흐른다. */
  const ready = async (m: Member): Promise<Member> => {
    hook(m, 'SessionStart', { source: 'startup' });
    pty.data(m.id, readyScreen());
    await sleep(60);
    return store.getMember(m.id)!;
  };
  const derivedOf = (id: string) => [...statuses].reverse().find((s) => s[0] === id)?.[2];
  const pastesOf = (m: Member) => pty.session(m.id).pastes;

  // ---- ① 사용자 → 부장 → 팀장 -------------------------------------------------------------

  test('사용자 지시는 부장에게만 가고, 부장이 낸 일은 팀장에게 [TASK#n] 으로 들어간다', async () => {
    await ready(head);
    await ready(lead);

    // 사용자 → 부장.
    const userTask = office.instruct(head.id, '로그인 기능 만들어');
    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(head), [`[TASK#${userTask} from user]\n로그인 기능 만들어`]);
    assert.equal(store.getTask(userTask)!.status, 'assigned');

    // 사용자 → 팀장은 막힌다.
    assert.throws(() => office.instruct(lead.id, '직접 해'), (e: unknown) => code(e) === RPC_ERROR.RANK_RULE);

    // 부장 → 팀장(위임). 지금은 delegate 도구가 팀장 전용이라 Office 메서드로 직접 검증한다(도구 노출은 T35).
    const row = store.createTask({ departmentId: department.id, fromMember: head.id, toMember: lead.id, instruction: '설계부터' });
    assert.equal(row.departmentId, department.id);
    assert.deepEqual(store.openTasksIssuedBy(head.id).map((t) => t.id), [row.id]);
  });

  // ---- ② 파생 상태 ------------------------------------------------------------------------

  test('waiting_reports 는 직급을 가리지 않는다 — 부장도 부하 보고를 기다리면 같은 상태(T34)', async () => {
    await ready(head);
    await ready(lead);
    assert.equal(derivedOf(head.id), 'free');

    // 부장이 팀장에게 일을 낸다 → 부장은 raw idle 이지만 waiting_reports.
    const t = store.createTask({ departmentId: department.id, fromMember: head.id, toMember: lead.id, instruction: '설계', status: 'assigned' });
    assert.equal(derivedStatus(store.getMember(head.id)!, store), 'waiting_reports');
    assert.equal(derivedStatus(store.getMember(lead.id)!, store), 'idle', '배정받은 쪽은 idle(할 일이 있다)');

    // 보고가 닫히면 다시 free.
    store.updateTask(t.id, { status: 'reported', reportStatus: 'done', reportText: '끝' });
    assert.equal(derivedStatus(store.getMember(head.id)!, store), 'free');
    assert.equal(derivedStatus(store.getMember(lead.id)!, store), 'free');
  });

  // ---- ③ [TEAM] 알림은 직속 상사에게 -------------------------------------------------------

  test('사용자가 끼워 넣거나 내보낸 멤버는 그 **직속 상사**에게 [TEAM] 으로 알린다', async () => {
    await ready(head);
    await ready(lead);

    const worker = office.clockIn({ parentId: lead.id, engine: 'claude', name: '이음' });
    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(lead), ['[TEAM] 팀원 변경: +이음(claude)'], '팀장(직속 상사)에게만');
    assert.deepEqual(pastesOf(head), [], '부장은 남의 팀 구성 변경을 받지 않는다');

    await ready(worker);
    await office.clockOut(worker.id);
    await sleep(SECOND_FLUSH_MS);
    assert.deepEqual(pastesOf(lead).at(-1), '[TEAM] 팀원 변경: -이음');

    // 팀장 본인이 부른 hire 에는 알림이 가지 않는다(자기가 한 일).
    const before = pastesOf(lead).length;
    office.teamHire(lead.id, { name: '나루', role: '문서' });
    await sleep(SECOND_FLUSH_MS);
    assert.equal(pastesOf(lead).length, before);
  });

  // ---- ④ 부서 삭제 = 하위 트리 정리 ---------------------------------------------------------

  test('department.delete: 잎부터 정리 — 진행 task aborted, 종료 순서는 팀원 → 팀장 → 부장, MCP 토큰도 끊는다', async () => {
    await ready(head);
    await ready(lead);
    const worker = await ready(office.hireByLeader({ leaderId: lead.id, engine: 'claude', name: '이음' }));

    const userTask = office.instruct(head.id, '기능 만들어');
    const delegated = office.teamDelegate(lead.id, worker.id, '파일 써').task;
    await sleep(FLUSH_MS);
    assert.equal(store.getTask(delegated.id)!.status, 'assigned');

    await office.deleteDepartment(department.id);

    assert.equal(store.getDepartment(department.id), undefined);
    assert.equal(store.listTeams().length, 0);
    assert.equal(store.listMembers().length, 0);
    assert.equal(store.listTasks().length, 0, 'task 는 부서 cascade 로 사라진다');
    // 종료 순서: 팀원 → 팀장 → 부장.
    assert.deepEqual(pty.kills.map((k) => k.memberId), [worker.id, lead.id, head.id]);
    // 정리 대상이던 task 들은 삭제 전에 aborted 로 닫혔다(발행자에게 보고가 갔다는 뜻).
    const aborted = office.eventsQuery({ limit: 200 }).filter((e) => e.kind === 'reporting' && e.detail.status === 'aborted');
    assert.ok(aborted.some((e) => e.ref.taskId === userTask), `사용자 task 중단 보고: ${JSON.stringify(aborted.map((e) => e.ref))}`);
    // 살아 있지 않았던 행까지 MCP 토큰을 끊는다.
    assert.deepEqual(
      [...new Set(mcp.disposed)].sort(),
      [head.memberToken, lead.memberToken, worker.memberToken].sort(),
    );
  });

  // T36: "부장 퇴근 = 부서 전원"(01 §rev 3 후처리). 세션은 잎부터 거두고 **행은 남긴다**(rehire 로 되살릴 수 있다).
  test('부장 퇴근은 하위 트리 전체를 잎부터 정리한다 — 발행 task 는 거두고 행은 남는다', async () => {
    await ready(head);
    await ready(lead);
    const t = store.createTask({ departmentId: department.id, fromMember: head.id, toMember: lead.id, instruction: '설계', status: 'assigned' });

    await office.clockOut(head.id);

    assert.equal(store.getMember(head.id)!.status, 'exited');
    assert.equal(store.getMember(lead.id)!.status, 'exited', '팀장도 함께 나간다');
    assert.ok(store.getMember(lead.id), '팀장 행은 남는다');
    assert.deepEqual(
      pty.kills.map((k) => k.memberId),
      [lead.id, head.id],
      '잎부터: 팀장이 먼저, 부장이 마지막',
    );
    assert.equal(store.getTask(t.id)!.status, 'aborted', '받을 사람이 없어진 일은 거둔다');
    assert.equal(store.liveHead(department.id), undefined, '게이트가 열린다');
  });

  // ---- ⑤ 셸 락 범위 = 부서 ------------------------------------------------------------------

  test('셸 락은 부서 단위 — 같은 부서의 다른 팀끼리도 줄을 선다(같은 cwd 이므로)', async () => {
    const other = office.createTeam({ departmentId: department.id, name: 'beta', leadName: '다른팀장' });
    await ready(head);
    await ready(lead);
    await ready(other.lead);

    const pre = (command: string, toolUseId: string) =>
      ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: toolUseId }) as never;
    const a = fakeReq(lead.memberToken, 'PreToolUse', pre('npm run build', 'u1'));
    receiver.emit('hook', a.req);
    await sleep(30);
    assert.deepEqual(a.sent, [{}]);
    assert.equal(office.shell.holder(department.id)?.memberId, lead.id);

    const b = fakeReq(other.lead.memberToken, 'PreToolUse', pre('npm test', 'u2'));
    receiver.emit('hook', b.req);
    await sleep(30);
    assert.deepEqual(b.sent, [], '같은 부서(같은 cwd)라 기다린다');
    assert.equal(office.shell.queueLength(department.id), 1);
  });

  // ---- ⑥ 스냅샷 ------------------------------------------------------------------------------

  test('snapshot: departments[] + 멤버 행의 departmentId/parentId/rank/teamId + derived', () => {
    const worker = office.hireByLeader({ leaderId: lead.id, engine: 'claude', name: '이음' });
    const snap = office.snapshot();

    assert.deepEqual(snap.departments.map((d) => d.id), [department.id]);
    assert.equal(snap.departments[0]!.headId, head.id);
    assert.deepEqual(snap.teams.map((t) => t.departmentId), [department.id]);
    assert.deepEqual(
      snap.members.map((m) => [m.name, m.rank, m.parentId, m.teamId]),
      [
        ['국장', 'head', null, null],
        ['반장', 'lead', head.id, team.id],
        ['이음', 'member', lead.id, team.id],
      ],
    );
    for (const m of snap.members) {
      assert.equal(m.departmentId, department.id);
      assert.equal(m.derived, 'starting');
    }
    assert.equal(worker.departmentId, department.id);
  });

  // T38: 부서·팀 행의 생멸에는 `member.status` 같은 알림이 없다 — Office 가 'tree' 를 내고 RpcServer 가 `snapshot` 을 민다.
  test("'tree' 이벤트: 부서·팀 생성/삭제에서만 나온다(고용·퇴근은 아니다)", async () => {
    const seen: string[] = [];
    office.on('tree', (reason) => seen.push(reason));

    // 고용·지시는 트리 **모양**이 아니라 멤버 행이라 'tree' 가 아니다(member.status 가 알린다).
    const worker = office.hireByLeader({ leaderId: lead.id, engine: 'claude', name: '이음' });
    await office.clockOut(worker.id);
    assert.deepEqual(seen, []);

    const t2 = office.createTeam({ departmentId: department.id, name: 't2', leadName: '조장' });
    await office.deleteTeam(t2.team.id);
    const d2 = office.createDepartment({ name: 'beta', cwd: dataDir, headEngine: 'claude', headName: '부장2' });
    await office.deleteDepartment(d2.department.id);
    assert.deepEqual(seen, ['team.create', 'team.delete', 'department.create', 'department.delete']);
  });
});
