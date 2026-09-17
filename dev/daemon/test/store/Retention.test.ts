// T30 ⑤ / D-39: 보존 정리. events 는 부서당 상한, pending 은 닫힌 뒤 30일, tasks 는 끝난 뒤 90일.
// 열린 행(open pending, queued/assigned task)은 아무리 오래돼도 지우지 않는다 — 그건 이력이 아니라 상태다.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store, DEFAULT_RETENTION } from '../../src/store/Store.js';
import type { Department, Member, Team } from '../../src/store/types.js';

const DAY = 24 * 60 * 60 * 1000;

describe('T30 보존 정리 (D-39)', () => {
  let store: Store;
  let dept: Department;
  let team: Team;
  let member: Member;

  beforeEach(() => {
    store = new Store(':memory:');
    dept = store.createDepartment({ name: 'alpha', cwd: 'D:/proj/alpha' });
    team = store.createTeam({ departmentId: dept.id, name: 'alpha', cwd: dept.cwd });
    member = store.createMember({
      departmentId: dept.id,
      teamId: team.id,
      name: '이음',
      rank: 'member',
      engine: 'claude',
      cwd: dept.cwd,
      hiredBy: 'user',
    });
  });
  afterEach(() => store.close());

  test('기본값: events 50,000 / pending 30일 / tasks 90일', () => {
    assert.deepEqual(DEFAULT_RETENTION, { keepPerTeam: 50_000, pendingDays: 30, taskDays: 90 });
  });

  test('pending: 닫힌 행만, 30일 지난 것만 지운다', () => {
    const answered = store.createPending({ memberId: member.id, type: 'approval', payload: { tool_name: 'Bash' } });
    store.answerPending(answered.id, { behavior: 'allow' });
    const expired = store.createPending({ memberId: member.id, type: 'question', payload: { question: '?' } });
    store.expirePending(expired.id);
    const open = store.createPending({ memberId: member.id, type: 'question', payload: { question: '열린 질문' } });

    // 아직 하루도 안 지났다.
    assert.equal(store.prunePending(30), 0);
    assert.equal(store.getPending(answered.id)?.status, 'answered');

    // 29일 뒤에도 남아 있다.
    assert.equal(store.prunePending(30, Date.now() + 29 * DAY), 0);

    // 31일 뒤에는 닫힌 둘만 사라지고 **열린 질문은 남는다**.
    assert.equal(store.prunePending(30, Date.now() + 31 * DAY), 2);
    assert.equal(store.getPending(answered.id), undefined);
    assert.equal(store.getPending(expired.id), undefined);
    assert.equal(store.getPending(open.id)?.status, 'open');
    assert.deepEqual(
      store.listOpenPending(member.id).map((p) => p.id),
      [open.id],
    );
  });

  test('tasks: 끝난 행(reported/aborted)만, 90일 지난 것만 지운다', () => {
    const reported = store.createTask({ departmentId: dept.id, fromMember: 'user', toMember: member.id, instruction: 'a', status: 'queued' });
    store.updateTask(reported.id, { status: 'reported', reportStatus: 'done', reportText: '끝' });
    const aborted = store.createTask({ departmentId: dept.id, fromMember: 'user', toMember: member.id, instruction: 'b', status: 'queued' });
    store.updateTask(aborted.id, { status: 'aborted', reportStatus: 'aborted' });
    const assigned = store.createTask({ departmentId: dept.id, fromMember: 'user', toMember: member.id, instruction: 'c', status: 'assigned' });
    const queued = store.createTask({ departmentId: dept.id, fromMember: 'user', toMember: member.id, instruction: 'd', status: 'queued' });

    assert.equal(store.pruneTasks(90), 0);
    assert.equal(store.pruneTasks(90, Date.now() + 89 * DAY), 0);
    assert.equal(store.pruneTasks(90, Date.now() + 91 * DAY), 2);
    assert.deepEqual(
      store.listTasks({ departmentId: dept.id }).map((t) => t.id),
      [assigned.id, queued.id],
      '진행 중인 일은 남는다',
    );
  });

  test('pruneRetention 은 셋을 한 번에 하고 건수를 돌려준다', () => {
    for (let i = 0; i < 5; i++) {
      store.appendEvent({ departmentId: dept.id, teamId: team.id, memberId: member.id, kind: 'idle', detail: {}, ref: {} });
    }
    const p = store.createPending({ memberId: member.id, type: 'approval', payload: {} });
    store.expirePending(p.id);
    const t = store.createTask({ departmentId: dept.id, fromMember: 'user', toMember: member.id, instruction: 'x', status: 'queued' });
    store.updateTask(t.id, { status: 'reported', reportStatus: 'done' });

    const res = store.pruneRetention({ keepPerTeam: 2, now: Date.now() + 200 * DAY });
    assert.deepEqual(res, { events: 3, pending: 1, tasks: 1 });
    assert.equal(store.eventsQuery({ departmentId: dept.id }).length, 2);
  });

  test('days <= 0 이면 아무것도 지우지 않는다(끄는 길)', () => {
    const p = store.createPending({ memberId: member.id, type: 'approval', payload: {} });
    store.expirePending(p.id);
    assert.equal(store.prunePending(0, Date.now() + 999 * DAY), 0);
    assert.equal(store.pruneTasks(-1, Date.now() + 999 * DAY), 0);
    assert.equal(store.getPending(p.id)?.status, 'expired');
  });
});
