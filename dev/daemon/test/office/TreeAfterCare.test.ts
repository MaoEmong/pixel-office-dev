// T36 — 하위 트리 후처리(01 §"직무 체계 rev 3" 후처리: 상위가 퇴근하면 하위 트리 전체 정리).
//
// 트리 하나(부장 → 팀장 → 팀원 둘)를 세워 두고 이유별로 무엇이 다른지 고정한다:
//   ① clockOut / error / departmentDelete → 하위 트리 전체를 **잎부터** 정리(각자 `parentGone`)
//   ② `parentGone` 의 aborted 보고는 **사라지는 상위 큐에 넣지 않는다**(대신 그 멤버 이력에 흔적만)
//   ③ interrupt 는 자기 턴만 끊는다 — 부하는 그대로
//   ④ restart 는 부하를 살려 둔다(되살아난 세션이 그 보고를 받는다)
//   ⑤ 결함 ⑤(T29): `team.delete` 는 task 행(보고 이력)을 지우지 않는다 — task 는 부서 소유(D-33·D-35)
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office } from '../../src/office/Office.js';
import { leavesFirst } from '../../src/office/afterCare.js';
import { Store } from '../../src/store/Store.js';
import type { Department, Member, OfficeEvent, Team } from '../../src/store/types.js';
import { loadFixture } from '../screen/helpers.js';
import { FakeMcp, FakePty, FakeReceiver, fakeReq, makeTree } from './fakes.js';

const SID = 'sess-t36';
const base = (event: string) => ({ session_id: SID, hook_event_name: event, cwd: 'D:\\x' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readyScreen = () => loadFixture('claude-ready.txt').join('\r\n');
const FLUSH_MS = 700;

describe('하위 트리 후처리 (T36)', () => {
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
  let w1: Member;
  let w2: Member;
  let events: OfficeEvent[];
  let notices: string[];

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t36-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    mcp = new FakeMcp();
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty, receiver, mcp, version: 't36' });
    events = [];
    notices = [];
    office.on('event', (e) => events.push(e));
    office.on('notice', (l, m) => notices.push(`${l}: ${m}`));
    await office.start();
    const t = makeTree(office, { name: 'alpha', cwd: dataDir, headName: '국장', leadName: '반장', maxMembers: 4 });
    department = t.department;
    team = t.team;
    head = await ready(t.head);
    lead = await ready(t.lead);
    // 팀원 둘은 팀장이 직접 고용한다(트리 간선 parent_id = 팀장).
    w1 = await ready(office.teamHire(lead.id, { name: '이음', role: '빌드' }));
    w2 = await ready(office.teamHire(lead.id, { name: '하루', role: '문서' }));
    pty.kills.length = 0; // 세팅 중 kill 은 없지만 순서 단언을 깔끔하게
  });
  afterEach(async () => {
    await office.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const hook = (m: Member, event: 'SessionStart' | 'UserPromptSubmit' | 'Stop', extra: Record<string, unknown> = {}) =>
    receiver.emit('hook', fakeReq(m.memberToken, event, { ...base(event), ...extra }).req);
  async function ready(m: Member): Promise<Member> {
    hook(m, 'SessionStart', { source: 'startup' });
    pty.data(m.id, readyScreen());
    await sleep(60);
    return store.getMember(m.id)!;
  }
  const busy = (m: Member) => hook(m, 'UserPromptSubmit', { prompt: 'x' });
  const statusOf = (m: Member) => store.getMember(m.id)!.status;
  const killOrder = () => pty.kills.map((k) => k.memberId);
  /** 부장 → 팀장 → 팀원 둘로 일이 한 줄 내려간 상태(전부 assigned). */
  function delegateDown(): { toLead: number; toW1: number; toW2: number } {
    const toLead = office.teamDelegate(head.id, lead.id, '설계').task.id;
    const toW1 = office.teamDelegate(lead.id, w1.id, '빌드').task.id;
    const toW2 = office.teamDelegate(lead.id, w2.id, '문서').task.id;
    return { toLead, toW1, toW2 };
  }

  // ---- ① 잎부터 정리 -----------------------------------------------------------------------

  test('clockOut(팀장): 하위 팀원 둘이 먼저 나가고 팀장이 마지막 — 전부 exited + 토큰 정리', async () => {
    const { toW1, toW2 } = delegateDown();
    busy(w1);

    await office.clockOut(lead.id);

    assert.deepEqual(killOrder(), [w1.id, w2.id, lead.id], '잎부터');
    for (const m of [w1, w2, lead]) {
      assert.equal(statusOf(m), 'exited', `${m.name} 은(는) 나가야 한다`);
      assert.ok(mcp.disposed.includes(m.memberToken), `${m.name} MCP 토큰 정리`);
      assert.ok(store.getMember(m.id), `${m.name} 행은 남는다(rehire 가능)`);
    }
    assert.equal(store.getTask(toW1)!.status, 'aborted');
    assert.equal(store.getTask(toW2)!.status, 'aborted');
    assert.equal(statusOf(head), 'idle', '위(부장)는 건드리지 않는다');
    assert.ok(notices.some((n) => n.includes('반장 후처리(퇴근)') && n.includes('하위 2명 정리')), notices.join('\n'));
  });

  test('clockOut(부장): 부서 전원(팀원 → 팀장 → 부장)이 잎부터 나간다', async () => {
    const { toLead } = delegateDown();

    await office.clockOut(head.id);

    assert.deepEqual(killOrder(), [w1.id, w2.id, lead.id, head.id]);
    for (const m of [w1, w2, lead, head]) assert.equal(statusOf(m), 'exited', m.name);
    assert.equal(store.getTask(toLead)!.status, 'aborted');
    assert.equal(store.liveHead(department.id), undefined);
  });

  test('프로세스 비정상 종료(error, 팀장): 같은 표로 하위 트리가 정리된다', async () => {
    delegateDown();

    pty.exit(lead.id, 1); // 크래시
    await sleep(40);

    assert.equal(statusOf(lead), 'error');
    assert.equal(statusOf(w1), 'exited');
    assert.equal(statusOf(w2), 'exited');
    assert.equal(statusOf(head), 'idle');
  });

  test('department.delete: 트리 전체를 잎부터 내보내고 부서·팀·멤버 행을 지운다', async () => {
    delegateDown();

    await office.deleteDepartment(department.id);

    assert.deepEqual(killOrder(), [w1.id, w2.id, lead.id, head.id]);
    for (const m of [w1, w2, lead, head]) assert.equal(store.getMember(m.id), undefined, `${m.name} 행이 사라진다`);
    assert.equal(store.getDepartment(department.id), undefined);
    assert.equal(store.getTeam(team.id), undefined);
  });

  // ---- ② parentGone 의 보고는 버린다 --------------------------------------------------------

  test('parentGone: aborted 보고는 사라지는 상위 큐에 안 들어가고 그 멤버 이력에만 남는다', async () => {
    const { toW1 } = delegateDown();
    const leadSession = pty.session(lead.id); // 퇴근하면 FakePty 맵에서 빠진다
    const before = leadSession.pastes.length;

    await office.clockOut(lead.id);
    await sleep(FLUSH_MS);

    assert.equal(
      leadSession.pastes.slice(before).filter((p) => p.includes('[REPORTS')).length,
      0,
      '나가는 팀장에게 보고를 되돌리지 않는다',
    );
    assert.ok(
      events.some((e) => e.memberId === w1.id && e.kind === 'idle' && String(e.detail.summary).includes(`task#${toW1} aborted`)),
      '대신 팀원 이력에 왜 끊겼는지 남는다',
    );
  });

  // ---- ③ interrupt / ④ restart ------------------------------------------------------------

  test('interrupt(팀장): 자기 턴만 끊는다 — 하위 팀원과 그들의 task 는 그대로', async () => {
    const { toW1, toW2 } = delegateDown();
    busy(lead);

    office.interrupt(lead.id);

    assert.deepEqual(killOrder(), [], '아무도 내보내지 않는다');
    assert.equal(statusOf(w1), 'idle');
    assert.equal(statusOf(w2), 'idle');
    assert.equal(store.getTask(toW1)!.status, 'assigned');
    assert.equal(store.getTask(toW2)!.status, 'assigned');
    assert.deepEqual(pty.session(w1.id).keys, [], '팀원에게 Ctrl+C 가 가지 않는다');
  });

  test('restart(팀장): 하위는 계속 돈다 — 되살아난 세션이 그 보고를 받는다', async () => {
    const { toW1, toW2 } = delegateDown();

    await office.restart(lead.id);

    assert.deepEqual(killOrder(), [lead.id], '팀장만 재시작된다');
    assert.equal(statusOf(w1), 'idle');
    assert.equal(statusOf(w2), 'idle');
    assert.equal(store.getTask(toW1)!.status, 'assigned', '맡긴 일은 그대로');
    assert.equal(store.getTask(toW2)!.status, 'assigned');
    assert.ok(pty.sessions.get(lead.id)?.alive, '팀장은 새 세션으로 살아 있다');
  });

  // ---- ⑤ 결함 ⑤(T29) 회귀: team.delete 가 보고 이력을 지우지 않는다 -------------------------

  test('결함 ⑤ 회귀: team.delete 는 tasks 행을 지우지 않는다(task 는 부서 소유, D-33·D-35)', async () => {
    const { toLead, toW1, toW2 } = delegateDown();
    office.teamReport(w1.id, { taskId: toW1, summary: '빌드 끝', status: 'done' });

    await office.deleteTeam(team.id);

    assert.equal(store.getTeam(team.id), undefined, '팀 행은 사라진다');
    for (const id of [toLead, toW1, toW2]) assert.ok(store.getTask(id), `task#${id} 는 남는다`);
    assert.equal(store.getTask(toW1)!.reportText, '빌드 끝', '보고 본문도 남는다');
    assert.ok(
      store.listTasks({ departmentId: department.id }).length >= 3,
      '부서 기준으로는 그대로 조회된다',
    );
  });

  test('department.delete 는 반대로 task 를 함께 지운다(프로젝트 자체가 사라진다, D-35)', async () => {
    const { toLead } = delegateDown();

    await office.deleteDepartment(department.id);

    assert.equal(store.getTask(toLead), undefined);
  });

  // ---- 정리 순서 헬퍼 ----------------------------------------------------------------------

  test('leavesFirst: 깊은 쪽부터, 같은 깊이 안에서는 원래 순서', () => {
    const subtree = store.subtreeOf(head.id);
    assert.deepEqual(
      subtree.map((m) => m.id),
      [head.id, lead.id, w1.id, w2.id],
      'subtreeOf 는 깊이 우선(자기 자신 먼저)',
    );
    assert.deepEqual(
      leavesFirst(subtree, head.id).map((m) => m.id),
      [w1.id, w2.id, lead.id],
      '형제 순서(이음 → 하루)는 뒤집히지 않는다',
    );
  });
});
