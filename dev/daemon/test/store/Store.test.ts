import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/store/Store.js';
import type { OfficeEventKind } from '../../src/store/types.js';

/**
 * T34 기준 최소 트리: 부서 → 부장 → 팀/팀장 → 팀원.
 * 옛 `seedTeam` 이 주던 `{team, leader, member}` 는 그대로 쓸 수 있게 이름을 남겼다(leader = 팀장 rank 'lead').
 */
function seedTeam(store: Store) {
  const department = store.createDepartment({ name: 'alpha', cwd: 'D:/proj/alpha' });
  const team = store.createTeam({ departmentId: department.id, name: 'alpha', cwd: department.cwd });
  const head = store.createMember({
    departmentId: department.id,
    name: '부장',
    rank: 'head',
    engine: 'claude',
    cwd: department.cwd,
    hiredBy: 'user',
  });
  const leader = store.createMember({
    departmentId: department.id,
    teamId: team.id,
    parentId: head.id,
    name: '팀장',
    rank: 'lead',
    engine: 'claude',
    cwd: team.cwd,
    hiredBy: 'leader',
  });
  const member = store.createMember({
    departmentId: department.id,
    teamId: team.id,
    parentId: leader.id,
    name: '이음',
    rank: 'member',
    engine: 'codex',
    cwd: team.cwd,
    hiredBy: 'leader',
    status: 'idle',
  });
  store.updateDepartment(department.id, { headId: head.id });
  store.updateTeam(team.id, { leaderId: leader.id });
  return { department: store.getDepartment(department.id)!, team: store.getTeam(team.id)!, head, leader, member };
}

describe('Store (in-memory)', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  test('team + members: create / get / list / update / token lookup / delete cascade', () => {
    const { team, leader, member } = seedTeam(store);

    assert.equal(team.name, 'alpha');
    assert.equal(team.maxMembers, 4);
    assert.deepEqual(team.allowedEngines, ['claude', 'codex']);
    assert.equal(team.leaderId, leader.id);
    assert.equal(store.listTeams().length, 1);

    assert.equal(leader.status, 'starting');
    assert.equal(member.status, 'idle');
    assert.equal(leader.memberToken.length, 48);
    assert.notEqual(leader.memberToken, member.memberToken);
    assert.equal(store.getMemberByToken(member.memberToken)?.id, member.id);
    assert.equal(store.getMemberByToken('nope'), undefined);

    assert.deepEqual(
      store.listMembers(team.id).map((m) => m.id),
      [leader.id, member.id],
      '팀에 속한 것은 팀장·팀원뿐 — 부장은 부서 직속(team_id null)',
    );
    assert.equal(store.listMembers().length, 3);
    assert.equal(store.getMember(leader.id)!.teamId, team.id);
    assert.equal(store.listMembers().find((m) => m.rank === 'head')!.teamId, null);

    const updated = store.updateMember(member.id, { status: 'working', sessionId: 'sess-1', childPid: 4242 });
    assert.equal(updated?.status, 'working');
    assert.equal(updated?.sessionId, 'sess-1');
    assert.equal(updated?.childPid, 4242);
    assert.ok(updated!.updatedAt >= member.updatedAt);

    const t2 = store.updateTeam(team.id, { allowedEngines: ['claude'], maxMembers: 2 });
    assert.deepEqual(t2?.allowedEngines, ['claude']);
    assert.equal(t2?.maxMembers, 2);

    // 팀 삭제: 그 팀의 멤버(팀장·팀원)와 그들의 pending 은 cascade.
    // **task 는 남는다** — T34 부터 task 는 부서 소유라(팀이 아니라) 팀을 지워도 보고 이력이 사라지지 않는다.
    store.createPending({ memberId: member.id, type: 'approval', payload: { tool: 'Bash' } });
    store.createTask({ departmentId: team.departmentId, fromMember: 'user', toMember: leader.id, instruction: 'x' });
    assert.equal(store.deleteTeam(team.id), true);
    assert.equal(store.deleteTeam(team.id), false);
    assert.equal(store.getTeam(team.id), undefined);
    assert.deepEqual(store.listMembers().map((m) => m.rank), ['head'], '부서 직속인 부장은 남는다');
    assert.equal(store.listOpenPending().length, 0);
    assert.equal(store.listTasks().length, 1);

    // 부서 삭제는 teams·members·tasks 를 전부 거둔다.
    assert.equal(store.deleteDepartment(team.departmentId), true);
    assert.equal(store.deleteDepartment(team.departmentId), false);
    assert.equal(store.listDepartments().length, 0);
    assert.equal(store.listMembers().length, 0);
    assert.equal(store.listTasks().length, 0);
  });

  // ---- T34 트리 질의 -------------------------------------------------------------------

  test('departments: create / get / list / update / liveHead / listTeams(departmentId)', () => {
    const { department, team, head, leader } = seedTeam(store);
    assert.equal(department.cwd, 'D:/proj/alpha');
    assert.equal(department.headId, head.id);
    assert.equal(store.getDepartment(department.id)!.name, 'alpha');
    assert.equal(store.listDepartments().length, 1);
    assert.equal(store.updateDepartment(department.id, { name: 'alpha2' })!.name, 'alpha2');

    assert.equal(store.liveHead(department.id)!.id, head.id);
    // 나간 부장은 "살아 있는 부장" 이 아니다 — head_id 는 그대로 남는다.
    store.updateMember(head.id, { status: 'exited' });
    assert.equal(store.liveHead(department.id), undefined);
    assert.equal(store.getDepartment(department.id)!.headId, head.id);

    // 팀 목록은 부서로 거른다.
    const other = store.createDepartment({ name: 'beta', cwd: 'D:/proj/beta' });
    store.createTeam({ departmentId: other.id, name: 'beta', cwd: other.cwd });
    assert.deepEqual(store.listTeams(department.id).map((t) => t.id), [team.id]);
    assert.equal(store.listTeams().length, 2);
    assert.equal(store.liveLead(team.id)!.id, leader.id);
    assert.equal(store.liveLeader(team.id)!.id, leader.id, 'liveLeader 는 liveLead 의 별칭');
  });

  test('tree: childrenOf(살아 있는 자식만) / parentOf / subtreeOf(깊이 우선)', () => {
    const { department, head, leader, member } = seedTeam(store);
    const second = store.createMember({
      departmentId: department.id,
      teamId: leader.teamId,
      parentId: leader.id,
      name: '나루',
      rank: 'member',
      engine: 'claude',
      cwd: 'D:/proj/alpha',
      hiredBy: 'leader',
    });

    assert.deepEqual(store.childrenOf(head.id).map((m) => m.id), [leader.id]);
    assert.deepEqual(store.childrenOf(leader.id).map((m) => m.id), [member.id, second.id]);
    assert.deepEqual(store.childrenOf(member.id), []);
    assert.equal(store.parentOf(member.id)!.id, leader.id);
    assert.equal(store.parentOf(head.id), undefined);

    // subtreeOf 는 자기 자신부터 깊이 우선. 뒤에서부터 훑으면 잎부터 정리된다(후처리 순서).
    assert.deepEqual(store.subtreeOf(head.id).map((m) => m.name), ['부장', '팀장', '이음', '나루']);
    assert.deepEqual(store.subtreeOf(leader.id).map((m) => m.id), [leader.id, member.id, second.id]);
    assert.deepEqual(store.subtreeOf('m_nope'), []);

    // childrenOf 는 살아 있는 자식만(후처리·로스터가 이 기준을 쓴다), subtreeOf 는 나간 행도 포함.
    store.updateMember(member.id, { status: 'exited' });
    assert.deepEqual(store.childrenOf(leader.id).map((m) => m.id), [second.id]);
    assert.equal(store.subtreeOf(leader.id).length, 3);
  });

  test('deleteMember cascades pending but keeps tasks/events', () => {
    const { team, member } = seedTeam(store);
    store.createPending({ memberId: member.id, type: 'question', payload: { q: '?' } });
    store.createTask({ departmentId: team.departmentId, fromMember: 'user', toMember: member.id, instruction: 'x' });
    store.appendEvent({ departmentId: team.departmentId, teamId: team.id, memberId: member.id, kind: 'idle' });
    assert.equal(store.deleteMember(member.id), true);
    assert.equal(store.listOpenPending().length, 0);
    assert.equal(store.listTasks().length, 1);
    assert.equal(store.eventsSince(0).length, 1);
  });

  test('events: append returns seq, eventsSince / eventsQuery paging', () => {
    const { team, leader, member } = seedTeam(store);
    const kinds: OfficeEventKind[] = ['thinking', 'reading', 'editing', 'running', 'idle'];
    const seqs: number[] = [];
    for (let i = 0; i < 10; i++) {
      const ev = store.appendEvent({
        departmentId: team.departmentId,
        teamId: team.id,
        memberId: i % 2 === 0 ? leader.id : member.id,
        kind: kinds[i % kinds.length]!,
        detail: { tool: 'Read', path: `f${i}.ts` },
        ref: { taskId: i },
      });
      seqs.push(ev.seq);
      assert.equal(ev.detail.path, `f${i}.ts`);
      assert.equal(ev.ref.taskId, i);
      assert.ok(ev.ts);
    }
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(store.lastSeq(), 10);

    // eventsSince: seq > since, 오름차순, limit
    assert.deepEqual(store.eventsSince(7).map((e) => e.seq), [8, 9, 10]);
    assert.deepEqual(store.eventsSince(0, 3).map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(store.eventsSince(10), []);

    // eventsQuery: 과거 방향 페이징, 페이지 안은 오름차순
    const page1 = store.eventsQuery({ teamId: team.id, limit: 4 });
    assert.deepEqual(page1.map((e) => e.seq), [7, 8, 9, 10]);
    const page2 = store.eventsQuery({ teamId: team.id, beforeSeq: page1[0]!.seq, limit: 4 });
    assert.deepEqual(page2.map((e) => e.seq), [3, 4, 5, 6]);
    const page3 = store.eventsQuery({ teamId: team.id, beforeSeq: page2[0]!.seq, limit: 4 });
    assert.deepEqual(page3.map((e) => e.seq), [1, 2]);
    assert.deepEqual(store.eventsQuery({ teamId: team.id, beforeSeq: 1 }), []);

    // memberId 필터
    assert.deepEqual(
      store.eventsQuery({ memberId: member.id, limit: 100 }).map((e) => e.seq),
      [2, 4, 6, 8, 10],
    );
    assert.deepEqual(store.eventsQuery({ teamId: 'other' }), []);
  });

  test('pending lifecycle: open → answered / expired, expireAllForMember', () => {
    const { leader, member } = seedTeam(store);
    const a = store.createPending({ memberId: member.id, type: 'approval', payload: { tool: 'Bash', cmd: 'rm' } });
    const q = store.createPending({ memberId: member.id, type: 'question', payload: { question: 'A or B?' } });
    const other = store.createPending({ memberId: leader.id, type: 'question', payload: {} });

    assert.equal(a.status, 'open');
    assert.ok(a.id.startsWith('a_'));
    assert.ok(q.id.startsWith('q_'));
    assert.deepEqual(a.payload, { tool: 'Bash', cmd: 'rm' });
    assert.equal(store.listOpenPending().length, 3);
    assert.deepEqual(store.listOpenPending(member.id).map((p) => p.id), [a.id, q.id]);

    const answered = store.answerPending(a.id, { decision: 'allow' });
    assert.equal(answered?.status, 'answered');
    assert.deepEqual(answered?.answer, { decision: 'allow' });
    assert.ok(answered?.answeredAt);
    // 이미 닫힌 건 다시 바꾸지 않는다
    assert.equal(store.expirePending(a.id)?.status, 'answered');
    store.answerPending(a.id, 'deny');
    assert.deepEqual(store.getPending(a.id)?.answer, { decision: 'allow' });

    const expired = store.expirePending(q.id);
    assert.equal(expired?.status, 'expired');
    assert.equal(expired?.answer, null);
    assert.equal(store.listOpenPending(member.id).length, 0);

    // expireAllForMember: 그 멤버 것만
    const q2 = store.createPending({ memberId: member.id, type: 'question', payload: {} });
    const q3 = store.createPending({ memberId: member.id, type: 'approval', payload: {} });
    const bulk = store.expireAllForMember(member.id);
    assert.deepEqual(bulk.map((p) => [p.id, p.status]), [[q2.id, 'expired'], [q3.id, 'expired']]);
    assert.deepEqual(store.expireAllForMember(member.id), []);
    assert.equal(store.getPending(other.id)?.status, 'open');
    assert.equal(store.getPending('missing'), undefined);
  });

  test('tasks lifecycle, listTasks filters, openTasksIssuedBy, abortTasksFor', () => {
    const { team, leader, member } = seedTeam(store);
    const m2 = store.createMember({
      departmentId: team.departmentId,
      teamId: team.id,
      parentId: leader.id,
      name: '둘',
      rank: 'member',
      engine: 'claude',
      cwd: team.cwd,
      hiredBy: 'leader',
    });

    const userTask = store.createTask({ departmentId: team.departmentId, fromMember: 'user', toMember: leader.id, instruction: '기능 만들어' });
    assert.equal(userTask.id, 1);
    assert.equal(userTask.status, 'queued');
    assert.equal(userTask.reportText, null);

    const d1 = store.createTask({ departmentId: team.departmentId, fromMember: leader.id, toMember: member.id, instruction: 'A', status: 'assigned' });
    const d2 = store.createTask({ departmentId: team.departmentId, fromMember: leader.id, toMember: m2.id, instruction: 'B' });
    const d3 = store.createTask({ departmentId: team.departmentId, fromMember: leader.id, toMember: member.id, instruction: 'C' });

    assert.deepEqual(store.openTasksIssuedBy(leader.id).map((t) => t.id), [d1.id, d2.id, d3.id]);
    assert.deepEqual(store.openTasksIssuedBy(member.id), []);
    assert.deepEqual(store.listTasks({ toMember: member.id }).map((t) => t.id), [d1.id, d3.id]);
    assert.deepEqual(store.listTasks({ fromMember: 'user' }).map((t) => t.id), [userTask.id]);
    assert.deepEqual(store.listTasks({ status: 'assigned' }).map((t) => t.id), [d1.id]);
    assert.deepEqual(store.listTasks({ departmentId: team.departmentId, status: ['queued', 'assigned'] }).length, 4);

    // report
    const reported = store.updateTask(d2.id, { status: 'reported', reportText: '끝', reportStatus: 'done' });
    assert.equal(reported?.status, 'reported');
    assert.equal(reported?.reportText, '끝');
    assert.equal(reported?.reportStatus, 'done');
    assert.deepEqual(store.openTasksIssuedBy(leader.id).map((t) => t.id), [d1.id, d3.id]);

    // abort: member 에게 배정된 미종료만
    const aborted = store.abortTasksFor(member.id);
    assert.deepEqual(aborted.map((t) => [t.id, t.status, t.reportStatus]), [
      [d1.id, 'aborted', 'aborted'],
      [d3.id, 'aborted', 'aborted'],
    ]);
    assert.deepEqual(store.abortTasksFor(member.id), []);
    assert.equal(store.getTask(d2.id)?.status, 'reported');
    assert.equal(store.getTask(userTask.id)?.status, 'queued');
    assert.deepEqual(store.openTasksIssuedBy(leader.id), []);
    assert.equal(store.getTask(999), undefined);
  });

  test('snapshot shape: seq + teams + members + open pending + open tasks', () => {
    const { team, leader, member } = seedTeam(store);
    store.appendEvent({ departmentId: team.departmentId, teamId: team.id, memberId: leader.id, kind: 'thinking' });
    store.appendEvent({ departmentId: team.departmentId, teamId: team.id, memberId: leader.id, kind: 'idle' });
    const p = store.createPending({ memberId: member.id, type: 'approval', payload: {} });
    const pClosed = store.createPending({ memberId: member.id, type: 'question', payload: {} });
    store.answerPending(pClosed.id, 'x');
    const t1 = store.createTask({ departmentId: team.departmentId, fromMember: 'user', toMember: leader.id, instruction: 'a' });
    const t2 = store.createTask({ departmentId: team.departmentId, fromMember: leader.id, toMember: member.id, instruction: 'b', status: 'assigned' });
    const t3 = store.createTask({ departmentId: team.departmentId, fromMember: leader.id, toMember: member.id, instruction: 'c' });
    store.updateTask(t3.id, { status: 'reported', reportText: 'ok', reportStatus: 'done' });

    const snap = store.snapshot();
    assert.deepEqual(Object.keys(snap).sort(), ['departments', 'members', 'pending', 'seq', 'tasks', 'teams']);
    assert.deepEqual(snap.departments.map((d) => d.id), [team.departmentId]);
    assert.equal(snap.seq, 2);
    assert.deepEqual(snap.teams.map((t) => t.id), [team.id]);
    assert.deepEqual(snap.members.map((m) => m.name), ['부장', '팀장', '이음']);
    assert.deepEqual(snap.pending.map((x) => x.id), [p.id]);
    assert.deepEqual(snap.tasks.map((x) => x.id), [t1.id, t2.id]);
  });

  // T34: 파티션이 팀이 아니라 **부서**다 — 부서 둘을 만들어 각각 남는지 본다.
  test('pruneEvents keeps newest keepPerTeam per department; seq does not reset', () => {
    const { team, leader } = seedTeam(store);
    const dept2 = store.createDepartment({ name: 'beta', cwd: 'D:/proj/beta' });
    const team2 = store.createTeam({ departmentId: dept2.id, name: 'beta', cwd: dept2.cwd });
    const m2 = store.createMember({ departmentId: dept2.id, teamId: team2.id, name: 'b', rank: 'lead', engine: 'claude', cwd: team2.cwd, hiredBy: 'user' });
    for (let i = 0; i < 10; i++) store.appendEvent({ departmentId: team.departmentId, teamId: team.id, memberId: leader.id, kind: 'idle' });
    for (let i = 0; i < 3; i++) store.appendEvent({ departmentId: team2.departmentId, teamId: team2.id, memberId: m2.id, kind: 'idle' });

    const deleted = store.pruneEvents({ keepPerTeam: 4 });
    assert.equal(deleted, 6);
    assert.deepEqual(store.eventsQuery({ teamId: team.id, limit: 100 }).map((e) => e.seq), [7, 8, 9, 10]);
    assert.deepEqual(store.eventsQuery({ teamId: team2.id, limit: 100 }).map((e) => e.seq), [11, 12, 13]);
    assert.equal(store.lastSeq(), 13);

    // 전부 지워도 seq 는 이어진다
    assert.equal(store.pruneEvents({ keepPerTeam: 0 }), 7);
    assert.equal(store.lastSeq(), 13);
    assert.equal(store.appendEvent({ departmentId: team.departmentId, teamId: team.id, memberId: leader.id, kind: 'idle' }).seq, 14);
  });
});

describe('Store (file, WAL, reopen)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-store-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('seq is monotonic across close/reopen and after deletes', () => {
    const dbPath = path.join(dir, 'nested', 'pixel-office.db');
    const s1 = new Store(dbPath);
    const { team, leader } = seedTeam(s1);
    const first = [1, 2, 3].map(() => s1.appendEvent({ departmentId: team.departmentId, teamId: team.id, memberId: leader.id, kind: 'reading' }).seq);
    assert.deepEqual(first, [1, 2, 3]);
    s1.pruneEvents({ keepPerTeam: 0 }); // 전부 삭제 — 재시작 후 seq 가 1 로 돌아가면 안 된다
    s1.close();

    assert.ok(fs.existsSync(dbPath));

    const s2 = new Store(dbPath);
    assert.equal(s2.lastSeq(), 3);
    assert.equal(s2.getTeam(team.id)?.name, 'alpha');
    assert.equal(s2.listMembers(team.id).length, 2);
    assert.equal(s2.listDepartmentMembers(team.departmentId).length, 3, '부장까지 셋');
    const next = s2.appendEvent({ departmentId: team.departmentId, teamId: team.id, memberId: leader.id, kind: 'idle' });
    assert.equal(next.seq, 4);
    assert.deepEqual(s2.eventsSince(0).map((e) => e.seq), [4]);
    s2.close();
  });
});
