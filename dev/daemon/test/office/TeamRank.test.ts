// T24 팀·직급 모델 → **T34 에서 3단 트리로 갱신**(D-32: 나 → 부장 → 팀장 → 팀원).
//   ① `department.create` 가 부장을 자동 출근시키고 `departments.head_id` 를 채운다(`{ department, head }`).
//   ② `team.create` 는 부장 아래에 팀장을 붙인다(`parent_id` = 부장, `teams.leader_id`). 두 번째 팀장은 -32003.
//   ③ "부장에게만 지시": 살아 있는 부장이 있으면 그 외 지시는 -32004, `force:true` 로만 넘는다.
//      부장이 나가면(exited/error) 게이트가 열린다.
//   ④ `team.delete` 는 팀장·팀원을, `department.delete` 는 하위 트리 전체를 퇴근시킨다.
//   ⑤ 스냅샷 JSON 에 `departments[]` · `Member.rank/parentId/departmentId` · `Team.departmentId` 가 들어 있다.
// 가짜 pty + 가짜 HookReceiver 위의 진짜 Office/Store.
//
// T24 에서 바뀐 것(의도적):
//   - 사용자가 팀장·팀원을 직접 출근시키는 정식 경로는 없어졌다(D-32) — 여기서는 `office.clockIn` 을 그대로 부르지만
//     RPC 에서는 `force:true` 가 필요하다(그 검사는 RpcServer.test.ts).
//   - "팀장에게만 지시" 는 "부장에게만 지시" 가 됐다. 게이트 범위도 팀이 아니라 **부서**다.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_HEAD_NAME, DEFAULT_LEAD_NAME, Office, headOnlyMessage } from '../../src/office/Office.js';
import { RPC_ERROR } from '../../src/office/errors.js';
import { Store } from '../../src/store/Store.js';
import type { Member } from '../../src/store/types.js';
import { FakePty, FakeReceiver, makeTree } from './fakes.js';

const code = (e: unknown) => (e as { code?: number }).code;

describe('부서·직급 트리 (T24 → T34)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let office: Office;
  let notices: string[];
  let statuses: Array<[string, string, string]>;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t34-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty, receiver, version: 't34' });
    notices = [];
    statuses = [];
    office.on('notice', (l, m) => notices.push(`${l}: ${m}`));
    office.on('status', (id, s, d) => statuses.push([id, s, d]));
    await office.start();
  });
  afterEach(async () => {
    await office.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const createDept = (over: Partial<Parameters<Office['createDepartment']>[0]> = {}) =>
    office.createDepartment({ name: 'alpha', cwd: dataDir, headEngine: 'claude', ...over });
  const tree = (over: Partial<Parameters<typeof makeTree>[1]> = {}) => makeTree(office, { name: 'alpha', cwd: dataDir, ...over });

  // ---- ① 부서 생성 = 부장 자동 출근 ------------------------------------------------------

  test('department.create: 부장이 rank head / parent 없음 / hiredBy user 로 자동 출근하고 head_id 가 채워진다', () => {
    const { department, head } = createDept({ headName: '국장' });

    assert.equal(head.rank, 'head');
    assert.equal(head.parentId, null);
    assert.equal(head.teamId, null, '부장은 팀에 속하지 않는다(부서 직속)');
    assert.equal(head.hiredBy, 'user');
    assert.equal(head.name, '국장');
    assert.equal(head.engine, 'claude');
    assert.equal(head.departmentId, department.id);
    assert.equal(head.status, 'starting');
    assert.equal(head.cwd, path.resolve(dataDir));

    assert.equal(department.headId, head.id);
    assert.equal(store.getDepartment(department.id)!.headId, head.id);
    assert.equal(store.liveHead(department.id)!.id, head.id);

    // 실제로 CLI 가 스폰됐다 — 부장도 보통 멤버와 같은 경로.
    assert.equal(pty.spawns.length, 1);
    assert.equal(pty.spawns[0]!.memberId, head.id);
    assert.equal(pty.spawns[0]!.engine, 'claude');
    assert.equal(pty.spawns[0]!.resumeSessionId, undefined);
    assert.ok(pty.session(head.id).alive);

    assert.deepEqual(statuses, [[head.id, 'starting', 'starting']]);
  });

  test('department.create: headName 이 없으면 기본 이름 "부장"; 공백만 줘도 기본 이름', () => {
    assert.equal(createDept().head.name, DEFAULT_HEAD_NAME);
    assert.equal(createDept({ name: 'b', headName: '   ' }).head.name, DEFAULT_HEAD_NAME);
  });

  test('department.create: 부장 엔진이 codex 여도 허용하되 daemon.notice{warn} 을 낸다 (v1 권장은 claude)', () => {
    const { head } = createDept({ headEngine: 'codex' });
    assert.equal(head.engine, 'codex');
    assert.ok(
      notices.some((n) => n.startsWith('warn:') && n.includes('codex')),
      `codex 부장 경고: ${JSON.stringify(notices)}`,
    );
  });

  test('department.create: 잘못된 파라미터 — cwd 아님 / 모르는 엔진 / 빈 이름', () => {
    const bad = (over: Record<string, unknown>) =>
      assert.throws(() => createDept(over as never), (e: unknown) => code(e) === RPC_ERROR.INVALID_PARAMS);
    bad({ cwd: path.join(dataDir, 'missing') });
    bad({ headEngine: 'gpt' });
    bad({ name: '   ' });
    assert.equal(store.listDepartments().length, 0, '검사에 걸린 부서 행은 남지 않는다');
  });

  test('department.create: 부장 스폰이 실패하면 부서 행도 되돌린다(부장 없는 부서를 남기지 않는다)', () => {
    const original = pty.spawn.bind(pty);
    pty.spawn = () => {
      throw new Error('spawn refused');
    };
    assert.throws(() => createDept(), /spawn refused/);
    assert.equal(store.listDepartments().length, 0);
    assert.equal(store.listMembers().length, 0);
    pty.spawn = original;
  });

  // ---- ② 팀 생성 = 팀장(부장의 자식) ------------------------------------------------------

  test('team.create: 팀장이 rank lead / parent = 부장 으로 출근하고 teams.leader_id·department_id 가 채워진다', () => {
    const { department, head, team, lead } = tree({ headName: '국장', leadName: '반장' });

    assert.equal(team.departmentId, department.id);
    assert.equal(team.cwd, path.resolve(dataDir), '팀 cwd = 부서 cwd');
    assert.equal(team.leaderId, lead.id);
    assert.equal(lead.rank, 'lead');
    assert.equal(lead.parentId, head.id);
    assert.equal(lead.teamId, team.id);
    assert.equal(lead.hiredBy, 'leader', '팀장은 부장이 고용한 것');
    assert.equal(store.liveLead(team.id)!.id, lead.id);
    assert.deepEqual(store.childrenOf(head.id).map((m) => m.id), [lead.id]);
    assert.equal(pty.spawns.length, 2, '부장 + 팀장');
  });

  test('team.create: 부장이 없는 부서에는 만들 수 없다 / 두 번째 팀장은 -32003 / 이름 기본값', async () => {
    const { department, head, team } = tree();
    assert.equal(store.getTeam(team.id)!.leaderId, store.liveLead(team.id)!.id);
    assert.equal(office.createTeam({ departmentId: department.id, name: 'b' }).lead.name, DEFAULT_LEAD_NAME);

    // 같은 팀에 두 번째 팀장(디버그 clockIn)은 거절.
    assert.throws(
      () => office.clockIn({ teamId: team.id, engine: 'claude', name: '대행', rank: 'lead' }),
      (e: unknown) => code(e) === RPC_ERROR.BAD_STATE,
    );

    // 부장이 나가면 팀을 더 만들 수 없다(팀은 부장이 만든다).
    await office.clockOut(head.id);
    assert.equal(store.liveHead(department.id), undefined);
    assert.throws(
      () => office.createTeam({ departmentId: department.id, name: 'c' }),
      (e: unknown) => code(e) === RPC_ERROR.BAD_STATE,
    );
    assert.throws(() => office.createTeam({ departmentId: 'nope', name: 'c' }), (e: unknown) => code(e) === RPC_ERROR.NOT_FOUND);
  });

  // ---- hireChild 사슬 ---------------------------------------------------------------------

  test('hireChild: 사슬은 head → lead → member 만 — 건너뛰면 -32004', () => {
    const { department, head, team, lead } = tree();

    // 부장이 팀원을 직접 고용할 수 없다(01 §rev3 "부장이 팀 없이 팀원을 두는 것은 금지").
    assert.throws(
      () => office.hireChild({ parentId: head.id, teamId: team.id, name: 'x', rank: 'member', engine: 'claude' }),
      (e: unknown) => code(e) === RPC_ERROR.RANK_RULE,
    );
    // 팀장이 팀장을 만들 수 없다.
    assert.throws(
      () => office.hireChild({ parentId: lead.id, teamId: team.id, name: 'y', rank: 'lead', engine: 'claude' }),
      (e: unknown) => code(e) === RPC_ERROR.RANK_RULE,
    );
    // 부서에 부장이 이미 있으면 두 번째 부장은 -32003.
    assert.throws(
      () => office.hireChild({ departmentId: department.id, name: 'z', rank: 'head', engine: 'claude' }),
      (e: unknown) => code(e) === RPC_ERROR.BAD_STATE,
    );
    // 부장에게 부모를 주면 -32004.
    assert.throws(
      () => office.hireChild({ parentId: lead.id, name: 'w', rank: 'head', engine: 'claude' }),
      (e: unknown) => code(e) === RPC_ERROR.RANK_RULE,
    );

    // 정상: 팀장 → 팀원(팀은 부모에게서 물려받는다).
    const worker = office.hireChild({ parentId: lead.id, name: '이음', rank: 'member', engine: 'claude', role: '파일 작성' });
    assert.equal(worker.rank, 'member');
    assert.equal(worker.parentId, lead.id);
    assert.equal(worker.teamId, team.id);
    assert.equal(worker.hiredBy, 'leader');
    assert.equal(fs.readFileSync(office.instructionsPath(team.id, worker.id), 'utf8'), '# 역할: 파일 작성\n');

    // 나간 상사는 고용할 수 없다.
    pty.exit(lead.id, 1);
    assert.throws(
      () => office.hireChild({ parentId: lead.id, name: 'q', rank: 'member', engine: 'claude' }),
      (e: unknown) => code(e) === RPC_ERROR.RANK_RULE,
    );
  });

  test('hireByLeader(T25 용): hireChild 의 얇은 래퍼 — hiredBy leader / rank member', () => {
    const { team, lead } = tree();
    const hired = office.hireByLeader({ leaderId: lead.id, engine: 'claude', name: '이음', instructions: '# 역할\n테스터' });
    assert.equal(hired.rank, 'member');
    assert.equal(hired.hiredBy, 'leader');
    assert.equal(hired.parentId, lead.id);
    assert.equal(hired.teamId, team.id);
    assert.equal(fs.readFileSync(office.instructionsPath(team.id, hired.id), 'utf8'), '# 역할\n테스터');

    assert.throws(
      () => office.hireByLeader({ leaderId: hired.id, engine: 'claude', name: 'x' }),
      (e: unknown) => code(e) === RPC_ERROR.RANK_RULE,
      '팀원은 고용할 수 없다',
    );
  });

  test('정원(maxMembers)은 팀 단위 — 팀장도 한 자리', () => {
    const { lead } = tree({ maxMembers: 2 });
    office.hireByLeader({ leaderId: lead.id, engine: 'claude', name: '이음' });
    assert.throws(
      () => office.hireByLeader({ leaderId: lead.id, engine: 'claude', name: '하루' }),
      (e: unknown) => code(e) === RPC_ERROR.BAD_STATE,
    );
  });

  // ---- ③ "부장에게만 지시" -----------------------------------------------------------------

  test('member.instruct: 살아 있는 부장이 있으면 팀장·팀원 지시는 -32004 (부장 본인은 통과)', () => {
    const { head, lead } = tree({ headName: '국장' });
    const worker = office.hireByLeader({ leaderId: lead.id, engine: 'claude', name: '이음' });

    for (const target of [lead, worker]) {
      let thrown: unknown;
      try {
        office.instruct(target.id, '빌드 돌려줘');
      } catch (e) {
        thrown = e;
      }
      assert.equal(code(thrown), RPC_ERROR.RANK_RULE, target.name);
      assert.equal((thrown as Error).message, '부장에게만 지시할 수 있습니다 (head: 국장)');
      assert.equal((thrown as Error).message, headOnlyMessage(head.name));
      assert.deepEqual((thrown as { data?: unknown }).data, { headId: head.id });
      assert.equal(store.listTasks({ toMember: target.id }).length, 0, '거절된 지시는 task 를 만들지 않는다');
    }

    // 부장에게는 그대로 간다.
    const taskId = office.instruct(head.id, '기능 나눠서 진행해');
    assert.equal(store.getTask(taskId)!.toMember, head.id);
    assert.equal(store.getTask(taskId)!.departmentId, head.departmentId);
  });

  test('member.instruct{force:true}: 게이트를 넘는 디버그 탈출구 — 팀장에게 task 가 생긴다', () => {
    const { lead } = tree();
    const taskId = office.instruct(lead.id, '직접 지시', { force: true });
    assert.equal(store.getTask(taskId)!.toMember, lead.id);
    assert.equal(store.getTask(taskId)!.fromMember, 'user');
  });

  // 게이트("부장에게만 지시")만 보는 테스트라 부장 행 status 를 직접 내린다. 실제 `clockOut(부장)` 은 T36 부터
  // 하위 트리까지 함께 정리하므로(01 §rev 3 후처리) 남아 있는 팀장이 없다 — 그 동작은 TreeAfterCare.test.ts.
  test('member.instruct: 부장이 나가면(exited) 팀장 직접 지시가 열린다', () => {
    const { head, lead } = tree();
    assert.throws(() => office.instruct(lead.id, 'x'), (e: unknown) => code(e) === RPC_ERROR.RANK_RULE);

    store.updateMember(head.id, { status: 'exited' });
    assert.equal(store.liveHead(lead.departmentId), undefined);
    const taskId = office.instruct(lead.id, '이제 직접 지시');
    assert.equal(store.getTask(taskId)!.toMember, lead.id);
  });

  test('member.instruct: 게이트는 같은 부서에만 — 부장 없는 부서의 멤버는 그대로 지시된다', () => {
    tree();
    const other = store.createDepartment({ name: 'no-head', cwd: dataDir });
    const otherTeam = store.createTeam({ departmentId: other.id, name: 'no-head', cwd: dataDir });
    const m = office.clockIn({ teamId: otherTeam.id, engine: 'claude', name: '외톨이' });
    assert.ok(office.instruct(m.id, '혼자 해줘') > 0);
  });

  test('member.type(터미널 직접 타이핑)은 게이트와 무관하다 — 그건 "지시"가 아니다', () => {
    const { lead } = tree();
    office.typeRaw(lead.id, 'ls\r');
    assert.ok(pty.session(lead.id).writes.includes('ls\r'));
  });

  // ---- ④ 삭제 -----------------------------------------------------------------------------

  test('team.delete: 팀장·팀원을 퇴근시키고 팀 행을 지운다 — 부장은 남는다', async () => {
    const { department, head, team, lead } = tree({ maxMembers: 4 });
    const a = office.hireByLeader({ leaderId: lead.id, engine: 'claude', name: '이음' });
    assert.equal(store.listMembers(team.id).length, 2);

    await office.deleteTeam(team.id);

    assert.equal(store.getTeam(team.id), undefined);
    for (const id of [lead.id, a.id]) assert.equal(store.getMember(id), undefined, `${id} 행이 지워졌다`);
    assert.equal(store.getMember(head.id)!.status, 'starting', '부장은 그대로');
    assert.deepEqual(pty.kills.map((k) => k.memberId).sort(), [lead.id, a.id].sort());
    assert.ok(pty.kills.every((k) => k.graceful), '정중한 종료');
    assert.equal(store.listDepartments().length, 1);
    assert.equal(department.id, store.listDepartments()[0]!.id);
  });

  test('department.delete: 하위 트리 전체를 잎부터 퇴근시키고 행을 지운다 (부장이 마지막)', async () => {
    const { department, head, team, lead } = tree({ maxMembers: 4 });
    const a = office.hireByLeader({ leaderId: lead.id, engine: 'claude', name: '이음' });
    const b = office.hireByLeader({ leaderId: lead.id, engine: 'claude', name: '하루' });
    assert.equal(store.listDepartmentMembers(department.id).length, 4);

    await office.deleteDepartment(department.id);

    assert.equal(store.getDepartment(department.id), undefined);
    assert.equal(store.getTeam(team.id), undefined);
    for (const id of [head.id, lead.id, a.id, b.id]) assert.equal(store.getMember(id), undefined, `${id} 행이 지워졌다`);
    // 팀원 → 팀장 → 부장 순(부장이 마지막).
    assert.deepEqual(pty.kills.map((k) => k.memberId), [a.id, b.id, lead.id, head.id]);
    assert.ok(pty.kills.every((k) => k.graceful));
    assert.equal(pty.list().length, 0);
    assert.equal(store.listTasks().length, 0, 'task 도 부서와 함께 정리된다');
  });

  test('department.delete: 없는 부서는 -32002', async () => {
    await assert.rejects(office.deleteDepartment('d_nope'), (e: unknown) => code(e) === RPC_ERROR.NOT_FOUND);
  });

  // ---- ⑤ 스냅샷·트리 ------------------------------------------------------------------------

  test('snapshot JSON: departments[] · Member.rank/parentId/departmentId · Team.departmentId', () => {
    const { department, head, team, lead } = tree({ headName: '국장', leadName: '반장' });
    const worker = office.hireByLeader({ leaderId: lead.id, engine: 'claude', name: '이음' });

    const snap = JSON.parse(JSON.stringify(office.snapshot()));
    const d = snap.departments.find((x: { id: string }) => x.id === department.id);
    assert.equal(d.headId, head.id);
    assert.equal(d.cwd, path.resolve(dataDir));
    const t = snap.teams.find((x: { id: string }) => x.id === team.id);
    assert.equal(t.departmentId, department.id);
    assert.equal(t.leaderId, lead.id);
    assert.equal(t.maxMembers, 4);

    const rows: Array<{ id: string; rank: string; parentId: string | null; departmentId: string; teamId: string | null }> = snap.members;
    const row = (id: string) => rows.find((m) => m.id === id)!;
    assert.deepEqual([row(head.id).rank, row(lead.id).rank, row(worker.id).rank], ['head', 'lead', 'member']);
    assert.deepEqual([row(head.id).parentId, row(lead.id).parentId, row(worker.id).parentId], [null, head.id, lead.id]);
    assert.equal(row(head.id).teamId, null);
    assert.equal(row(worker.id).teamId, team.id);
    for (const m of rows) assert.equal(m.departmentId, department.id);

    // getMember(= `member.status` 알림의 member 필드)도 같은 값을 준다.
    assert.equal((office.getMember(head.id) as Member).rank, 'head');
  });

  test('tree(): 부서 → 부장 → 팀/팀장 → 팀원', () => {
    const { department, head, team, lead } = tree({ headName: '국장', leadName: '반장' });
    const worker = office.hireByLeader({ leaderId: lead.id, engine: 'claude', name: '이음' });

    const forest = office.tree();
    assert.equal(forest.length, 1);
    const node = forest[0]!;
    assert.equal(node.department.id, department.id);
    assert.equal(node.head!.id, head.id);
    assert.equal(node.head!.derived, 'starting');
    assert.equal(node.teams.length, 1);
    assert.equal(node.teams[0]!.team.id, team.id);
    assert.equal(node.teams[0]!.lead!.id, lead.id);
    assert.deepEqual(node.teams[0]!.members.map((m) => m.id), [worker.id]);
    assert.deepEqual(node.orphans, []);
  });
});
