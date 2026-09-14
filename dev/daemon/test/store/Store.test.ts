import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/store/Store.js';
import type { OfficeEventKind } from '../../src/store/types.js';

function seedTeam(store: Store) {
  const team = store.createTeam({ name: 'alpha', cwd: 'D:/proj/alpha' });
  const leader = store.createMember({
    teamId: team.id,
    name: '팀장',
    rank: 'leader',
    engine: 'claude',
    cwd: team.cwd,
    hiredBy: 'user',
  });
  const member = store.createMember({
    teamId: team.id,
    name: '이음',
    rank: 'member',
    engine: 'codex',
    cwd: team.cwd,
    hiredBy: 'leader',
    status: 'idle',
  });
  store.updateTeam(team.id, { leaderId: leader.id });
  return { team: store.getTeam(team.id)!, leader, member };
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
    );
    assert.equal(store.listMembers().length, 2);

    const updated = store.updateMember(member.id, { status: 'working', sessionId: 'sess-1', childPid: 4242 });
    assert.equal(updated?.status, 'working');
    assert.equal(updated?.sessionId, 'sess-1');
    assert.equal(updated?.childPid, 4242);
    assert.ok(updated!.updatedAt >= member.updatedAt);

    const t2 = store.updateTeam(team.id, { allowedEngines: ['claude'], maxMembers: 2 });
    assert.deepEqual(t2?.allowedEngines, ['claude']);
    assert.equal(t2?.maxMembers, 2);

    // 삭제: members / pending / tasks cascade
    store.createPending({ memberId: member.id, type: 'approval', payload: { tool: 'Bash' } });
    store.createTask({ teamId: team.id, fromMember: 'user', toMember: leader.id, instruction: 'x' });
    assert.equal(store.deleteTeam(team.id), true);
    assert.equal(store.deleteTeam(team.id), false);
    assert.equal(store.getTeam(team.id), undefined);
    assert.equal(store.listMembers().length, 0);
    assert.equal(store.listOpenPending().length, 0);
    assert.equal(store.listTasks().length, 0);
  });

  test('deleteMember cascades pending but keeps tasks/events', () => {
    const { team, member } = seedTeam(store);
    store.createPending({ memberId: member.id, type: 'question', payload: { q: '?' } });
    store.createTask({ teamId: team.id, fromMember: 'user', toMember: member.id, instruction: 'x' });
    store.appendEvent({ teamId: team.id, memberId: member.id, kind: 'idle' });
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
      teamId: team.id,
      name: '둘',
      rank: 'member',
      engine: 'claude',
      cwd: team.cwd,
      hiredBy: 'leader',
    });

    const userTask = store.createTask({ teamId: team.id, fromMember: 'user', toMember: leader.id, instruction: '기능 만들어' });
    assert.equal(userTask.id, 1);
    assert.equal(userTask.status, 'queued');
    assert.equal(userTask.reportText, null);

    const d1 = store.createTask({ teamId: team.id, fromMember: leader.id, toMember: member.id, instruction: 'A', status: 'assigned' });
    const d2 = store.createTask({ teamId: team.id, fromMember: leader.id, toMember: m2.id, instruction: 'B' });
    const d3 = store.createTask({ teamId: team.id, fromMember: leader.id, toMember: member.id, instruction: 'C' });

    assert.deepEqual(store.openTasksIssuedBy(leader.id).map((t) => t.id), [d1.id, d2.id, d3.id]);
    assert.deepEqual(store.openTasksIssuedBy(member.id), []);
    assert.deepEqual(store.listTasks({ toMember: member.id }).map((t) => t.id), [d1.id, d3.id]);
    assert.deepEqual(store.listTasks({ fromMember: 'user' }).map((t) => t.id), [userTask.id]);
    assert.deepEqual(store.listTasks({ status: 'assigned' }).map((t) => t.id), [d1.id]);
    assert.deepEqual(store.listTasks({ teamId: team.id, status: ['queued', 'assigned'] }).length, 4);

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
    store.appendEvent({ teamId: team.id, memberId: leader.id, kind: 'thinking' });
    store.appendEvent({ teamId: team.id, memberId: leader.id, kind: 'idle' });
    const p = store.createPending({ memberId: member.id, type: 'approval', payload: {} });
    const pClosed = store.createPending({ memberId: member.id, type: 'question', payload: {} });
    store.answerPending(pClosed.id, 'x');
    const t1 = store.createTask({ teamId: team.id, fromMember: 'user', toMember: leader.id, instruction: 'a' });
    const t2 = store.createTask({ teamId: team.id, fromMember: leader.id, toMember: member.id, instruction: 'b', status: 'assigned' });
    const t3 = store.createTask({ teamId: team.id, fromMember: leader.id, toMember: member.id, instruction: 'c' });
    store.updateTask(t3.id, { status: 'reported', reportText: 'ok', reportStatus: 'done' });

    const snap = store.snapshot();
    assert.deepEqual(Object.keys(snap).sort(), ['members', 'pending', 'seq', 'tasks', 'teams']);
    assert.equal(snap.seq, 2);
    assert.deepEqual(snap.teams.map((t) => t.id), [team.id]);
    assert.deepEqual(snap.members.map((m) => m.id), [leader.id, member.id]);
    assert.deepEqual(snap.pending.map((x) => x.id), [p.id]);
    assert.deepEqual(snap.tasks.map((x) => x.id), [t1.id, t2.id]);
  });

  test('pruneEvents keeps newest keepPerTeam per team; seq does not reset', () => {
    const { team, leader } = seedTeam(store);
    const team2 = store.createTeam({ name: 'beta', cwd: 'D:/proj/beta' });
    const m2 = store.createMember({ teamId: team2.id, name: 'b', rank: 'leader', engine: 'claude', cwd: team2.cwd, hiredBy: 'user' });
    for (let i = 0; i < 10; i++) store.appendEvent({ teamId: team.id, memberId: leader.id, kind: 'idle' });
    for (let i = 0; i < 3; i++) store.appendEvent({ teamId: team2.id, memberId: m2.id, kind: 'idle' });

    const deleted = store.pruneEvents({ keepPerTeam: 4 });
    assert.equal(deleted, 6);
    assert.deepEqual(store.eventsQuery({ teamId: team.id, limit: 100 }).map((e) => e.seq), [7, 8, 9, 10]);
    assert.deepEqual(store.eventsQuery({ teamId: team2.id, limit: 100 }).map((e) => e.seq), [11, 12, 13]);
    assert.equal(store.lastSeq(), 13);

    // 전부 지워도 seq 는 이어진다
    assert.equal(store.pruneEvents({ keepPerTeam: 0 }), 7);
    assert.equal(store.lastSeq(), 13);
    assert.equal(store.appendEvent({ teamId: team.id, memberId: leader.id, kind: 'idle' }).seq, 14);
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
    const first = [1, 2, 3].map(() => s1.appendEvent({ teamId: team.id, memberId: leader.id, kind: 'reading' }).seq);
    assert.deepEqual(first, [1, 2, 3]);
    s1.pruneEvents({ keepPerTeam: 0 }); // 전부 삭제 — 재시작 후 seq 가 1 로 돌아가면 안 된다
    s1.close();

    assert.ok(fs.existsSync(dbPath));

    const s2 = new Store(dbPath);
    assert.equal(s2.lastSeq(), 3);
    assert.equal(s2.getTeam(team.id)?.name, 'alpha');
    assert.equal(s2.listMembers(team.id).length, 2);
    const next = s2.appendEvent({ teamId: team.id, memberId: leader.id, kind: 'idle' });
    assert.equal(next.seq, 4);
    assert.deepEqual(s2.eventsSince(0).map((e) => e.seq), [4]);
    s2.close();
  });
});
