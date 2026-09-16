// T34 — 스키마 v1 → v2 마이그레이션(D-32 직무 체계 rev 3).
//
// v1 DB(팀·팀장·팀원 2단)를 파일로 직접 만들어 놓고 `new Store(path)` 로 열었을 때
//   ① 팀 하나가 부서 하나가 되고(이름·cwd 그대로), 그 팀장이 **부장**이 되어 `departments.head_id` 에 들어간다
//   ② 옛 팀 행은 그 부서의 팀으로 남고 `leader_id` 도 부장을 가리킨다(부장이 레거시 팀의 팀장을 겸한다)
//   ③ 옛 팀원은 rank 'member' + `parent_id` = 부장
//   ④ tasks·events 는 그 부서 id 를 받고 **행이 사라지지 않는다**(이력 보존)
//   ⑤ schema_version 이 2 가 되고, 다시 열어도 그대로다(멱등)
// 를 확인한다. 개발 DB 한 개를 위한 코드라 여기서만 검증한다(worklog T34).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/store/Store.js';

/** T34 이전(v1)의 스키마 그대로. 여기 문장을 고치면 안 된다 — 과거의 모양이다. */
const V1_SQL = `
CREATE TABLE schema_version (version INTEGER NOT NULL);
CREATE TABLE teams (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, leader_id TEXT,
  max_members INTEGER NOT NULL DEFAULT 4, allowed_engines TEXT NOT NULL DEFAULT '["claude","codex"]', created_at TEXT NOT NULL);
CREATE TABLE members (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, name TEXT NOT NULL,
  rank TEXT NOT NULL CHECK (rank IN ('leader','member')), engine TEXT NOT NULL CHECK (engine IN ('claude','codex')),
  session_id TEXT, child_pid INTEGER, cwd TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting','idle','working','waiting_approval','waiting_answer','exited','error')),
  hired_by TEXT NOT NULL CHECK (hired_by IN ('user','leader')), member_token TEXT NOT NULL UNIQUE,
  instructions_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_members_team ON members(team_id);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, team_id TEXT NOT NULL, member_id TEXT NOT NULL,
  kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', ref TEXT NOT NULL DEFAULT '{}');
CREATE INDEX idx_events_team_seq ON events(team_id, seq);
CREATE INDEX idx_events_member_seq ON events(member_id, seq);
CREATE TABLE pending (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('approval','question')), payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('open','answered','expired')), created_at TEXT NOT NULL,
  answered_at TEXT, answer TEXT);
CREATE INDEX idx_pending_member_status ON pending(member_id, status);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  from_member TEXT NOT NULL, to_member TEXT NOT NULL, instruction TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','assigned','reported','aborted')),
  report_text TEXT, report_status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_tasks_team_status ON tasks(team_id, status);
CREATE INDEX idx_tasks_to_status ON tasks(to_member, status);
CREATE INDEX idx_tasks_from_status ON tasks(from_member, status);
`;

const TS = '2026-09-15T00:00:00.000Z';

/** v1 DB 한 개 = 팀 alpha(팀장 반장 + 팀원 이음·하루) + 팀 beta(팀장 없음, 팀원 외톨이) + task·event·pending. */
function writeV1Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(V1_SQL);
  db.prepare('INSERT INTO schema_version(version) VALUES (1)').run();
  const team = (id: string, name: string, cwd: string, leader: string | null) =>
    db.prepare('INSERT INTO teams(id, name, cwd, leader_id, max_members, allowed_engines, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, name, cwd, leader, 5, '["claude"]', TS);
  const member = (id: string, teamId: string, name: string, rank: string, status = 'idle', hiredBy = 'user') =>
    db.prepare(
      `INSERT INTO members(id, team_id, name, rank, engine, session_id, child_pid, cwd, status, hired_by, member_token,
                           instructions_path, created_at, updated_at)
       VALUES (?,?,?,?,'claude',?,?,?,?,?,?,?,?,?)`,
    ).run(id, teamId, name, rank, `sess-${id}`, 4242, 'D:/proj/alpha', status, hiredBy, `tok-${id}`, null, TS, TS);

  team('t_alpha', 'alpha', 'D:/proj/alpha', 'm_lead');
  member('m_lead', 't_alpha', '반장', 'leader');
  member('m_eum', 't_alpha', '이음', 'member', 'working', 'leader');
  member('m_haru', 't_alpha', '하루', 'member', 'exited', 'user');
  team('t_beta', 'beta', 'D:/proj/beta', null);
  member('m_alone', 't_beta', '외톨이', 'member');

  db.prepare('INSERT INTO tasks(id, team_id, from_member, to_member, instruction, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(1, 't_alpha', 'user', 'm_lead', '기능 만들어', 'assigned', TS, TS);
  db.prepare('INSERT INTO tasks(id, team_id, from_member, to_member, instruction, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(2, 't_alpha', 'm_lead', 'm_eum', 'A 해라', 'queued', TS, TS);
  db.prepare('INSERT INTO tasks(id, team_id, from_member, to_member, instruction, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(3, 't_beta', 'user', 'm_alone', '혼자 해라', 'reported', TS, TS);
  db.prepare('INSERT INTO events(ts, team_id, member_id, kind, detail, ref) VALUES (?,?,?,?,?,?)').run(TS, 't_alpha', 'm_lead', 'thinking', '{}', '{}');
  db.prepare('INSERT INTO events(ts, team_id, member_id, kind, detail, ref) VALUES (?,?,?,?,?,?)').run(TS, 't_beta', 'm_alone', 'idle', '{}', '{}');
  db.prepare("INSERT INTO pending(id, member_id, type, payload, status, created_at) VALUES ('a_1','m_eum','approval','{}','open',?)").run(TS);
  db.close();
}

describe('스키마 v1 → v2 마이그레이션 (T34, D-32)', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-mig-'));
    dbPath = path.join(dir, 'pixel-office.db');
    writeV1Db(dbPath);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('팀 하나 = 부서 하나, 팀장 → 부장(head_id + 팀의 leader_id), 팀원 → parent_id = 부장', () => {
    const store = new Store(dbPath);

    const depts = store.listDepartments();
    assert.deepEqual(depts.map((d) => d.name), ['alpha', 'beta']);
    const alpha = depts[0]!;
    const beta = depts[1]!;
    assert.equal(alpha.cwd, 'D:/proj/alpha');
    assert.equal(alpha.createdAt, TS, '부서 created_at 은 옛 팀 것을 그대로');
    assert.equal(alpha.headId, 'm_lead');
    assert.equal(beta.headId, null, '팀장이 없던 팀은 부장 없는 부서');

    // 옛 팀 행이 그 부서의 팀으로 남는다(부장이 레거시 팀의 팀장을 겸한다).
    const teams = store.listTeams(alpha.id);
    assert.deepEqual(teams.map((t) => t.id), ['t_alpha']);
    assert.equal(teams[0]!.leaderId, 'm_lead');
    assert.equal(teams[0]!.maxMembers, 5);
    assert.deepEqual(teams[0]!.allowedEngines, ['claude']);

    // 직급·트리 간선
    const lead = store.getMember('m_lead')!;
    assert.equal(lead.rank, 'head');
    assert.equal(lead.parentId, null);
    assert.equal(lead.departmentId, alpha.id);
    assert.equal(lead.teamId, 't_alpha');
    assert.equal(lead.sessionId, 'sess-m_lead', '세션·pid 같은 복구 정보는 그대로');
    assert.equal(lead.childPid, 4242);
    assert.equal(lead.memberToken, 'tok-m_lead');

    for (const id of ['m_eum', 'm_haru']) {
      const m = store.getMember(id)!;
      assert.equal(m.rank, 'member');
      assert.equal(m.parentId, 'm_lead', `${id} 는 부장 밑으로`);
      assert.equal(m.departmentId, alpha.id);
    }
    assert.equal(store.getMember('m_haru')!.status, 'exited', 'status 보존');
    assert.equal(store.getMember('m_alone')!.parentId, null, '부장이 없던 팀의 팀원은 부모 없음');
    assert.equal(store.getMember('m_alone')!.departmentId, beta.id);

    // 트리 질의가 바로 먹는다.
    assert.deepEqual(store.childrenOf('m_lead').map((m) => m.id), ['m_eum'], '살아 있는 자식만(하루는 exited)');
    assert.deepEqual(store.subtreeOf('m_lead').map((m) => m.id), ['m_lead', 'm_eum', 'm_haru']);
    assert.equal(store.liveHead(alpha.id)!.id, 'm_lead');

    store.close();
  });

  test('tasks·events·pending 은 행이 살아남고 부서 id 를 받는다', () => {
    const store = new Store(dbPath);
    const [alpha, beta] = store.listDepartments();

    const tasks = store.listTasks();
    assert.deepEqual(tasks.map((t) => t.id), [1, 2, 3]);
    assert.deepEqual(tasks.map((t) => t.departmentId), [alpha!.id, alpha!.id, beta!.id]);
    assert.equal(tasks[0]!.instruction, '기능 만들어');
    assert.deepEqual(store.listTasks({ departmentId: alpha!.id }).map((t) => t.id), [1, 2]);
    assert.deepEqual(store.openTasksIssuedBy('m_lead').map((t) => t.id), [2]);

    const events = store.eventsSince(0);
    assert.deepEqual(events.map((e) => e.seq), [1, 2]);
    assert.deepEqual(events.map((e) => e.departmentId), [alpha!.id, beta!.id]);
    assert.deepEqual(events.map((e) => e.teamId), ['t_alpha', 't_beta']);
    assert.equal(store.lastSeq(), 2, 'seq 는 이어진다');
    assert.deepEqual(store.eventsQuery({ departmentId: alpha!.id }).map((e) => e.seq), [1]);

    assert.deepEqual(store.listOpenPending().map((p) => p.id), ['a_1']);

    // 새 행도 그대로 이어서 쓸 수 있다(AUTOINCREMENT 가 되감기지 않는다).
    const t = store.createTask({ departmentId: alpha!.id, fromMember: 'user', toMember: 'm_lead', instruction: 'x' });
    assert.equal(t.id, 4);
    assert.equal(store.appendEvent({ departmentId: alpha!.id, teamId: 't_alpha', memberId: 'm_lead', kind: 'idle' }).seq, 3);
    store.close();
  });

  test('다시 열어도 그대로 — schema_version 2, *_v1 임시 테이블 없음(멱등)', () => {
    const s1 = new Store(dbPath);
    const deptId = s1.listDepartments()[0]!.id;
    s1.close();

    const s2 = new Store(dbPath);
    assert.equal(s2.listDepartments().length, 2);
    assert.equal(s2.listDepartments()[0]!.id, deptId, '두 번째 열기에서 부서를 또 만들지 않는다');
    assert.equal(s2.listMembers().length, 4);
    assert.equal(s2.listTasks().length, 3);
    s2.close();

    const raw = new DatabaseSync(dbPath);
    const version = (raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
    assert.equal(version, 2);
    const leftovers = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_v1'").all() as Array<{ name: string }>);
    assert.deepEqual(leftovers, [], '임시 테이블은 남지 않는다');
    // v2 제약이 실제로 걸려 있다(부서 cascade).
    raw.close();

    const s3 = new Store(dbPath);
    assert.equal(s3.deleteDepartment(deptId), true);
    assert.equal(s3.listTeams(deptId).length, 0);
    assert.equal(s3.listDepartmentMembers(deptId).length, 0);
    assert.deepEqual(s3.listTasks().map((t) => t.id), [3], '지운 부서의 task 만 사라진다');
    s3.close();
  });

  test('새 DB 는 바로 v2 (마이그레이션 경로를 타지 않는다)', () => {
    const fresh = path.join(dir, 'fresh.db');
    const store = new Store(fresh);
    assert.equal(store.listDepartments().length, 0);
    store.close();
    const raw = new DatabaseSync(fresh);
    assert.equal((raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 2);
    raw.close();
  });

  // ---- T39 결함: pending FK 가 members_v1 을 가리킨 채 남는다 -------------------------------
  //
  // `ALTER TABLE members RENAME TO members_v1`(V1_RENAME_SQL)이 **다른 테이블의 REFERENCES 절까지** 고쳐 쓴다.
  // teams/members/tasks 는 SCHEMA_SQL 로 다시 만들어지지만 `pending` 은 `IF NOT EXISTS` 라 v1 행이 그대로 남고
  // 참조만 `members_v1` 로 바뀐다 → 그 테이블이 drop 된 뒤로 **pending INSERT 가 전부 실패**한다
  // (`no such table: main.members_v1`). 허가 카드·ask_user·ask_parent 가 통째로 죽는다 — T39 시연에서 발견.
  test('T39: 마이그레이션 뒤에도 pending 을 새로 만들 수 있다 (FK 가 members 를 가리킨다)', () => {
    const store = new Store(dbPath);
    const lead = store.listMembers().find((m) => m.name === '반장')!;
    const p = store.createPending({ memberId: lead.id, type: 'approval', payload: { tool_name: 'Bash' } });
    assert.equal(p.type, 'approval');
    assert.equal(store.listOpenPending(lead.id).length, 1);
    const q = store.createPending({ memberId: lead.id, type: 'question', payload: { source: 'ask_parent' } });
    assert.equal(q.status, 'open');
    store.close();

    const raw = new DatabaseSync(dbPath);
    const sql = (raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pending'").get() as { sql: string }).sql;
    assert.ok(!sql.includes('members_v1'), `pending FK 가 members_v1 을 가리킨다: ${sql}`);
    // 옛 pending 행(a_1)은 살아남는다 — 복구는 테이블만 갈아 끼운다.
    const rows = raw.prepare('SELECT id FROM pending ORDER BY id').all() as Array<{ id: string }>;
    assert.ok(rows.some((r) => r.id === 'a_1'), '마이그레이션 전 pending 행이 남아야 한다');
    // 인덱스도 다시 만들어진다.
    const idx = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pending_member_status'").all();
    assert.equal(idx.length, 1);
    raw.close();
  });

  test('T39: 복구된 DB 를 다시 열어도 그대로 동작한다(멱등)', () => {
    const s1 = new Store(dbPath);
    const leadId = s1.listMembers().find((m) => m.name === '반장')!.id;
    s1.close();
    const s2 = new Store(dbPath);
    const before = s2.listOpenPending().length;
    s2.createPending({ memberId: leadId, type: 'approval', payload: {} });
    assert.equal(s2.listOpenPending().length, before + 1);
    s2.close();
  });
});
