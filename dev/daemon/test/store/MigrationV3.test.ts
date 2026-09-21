// T43-1 — 스키마 v2 → v3(사용량 표시, D-45). **추가만** 하는 마이그레이션이다.
//
// v2 DB(T34~T42 의 모양)를 파일로 직접 만들어 놓고 `new Store(path)` 로 열었을 때
//   ① 기존 행(부서·팀·멤버·task·event·pending)이 하나도 변하지 않고
//   ② `engine_usage` · `member_usage` 두 테이블이 생기며 schema_version 이 3 이 되고
//   ③ 멤버 사용량은 멤버가 지워질 때 함께 사라지고(FK cascade — 부서 삭제·팀 삭제 경로) 엔진 사용량은 남는다
//   ④ 다시 열어도 그대로다(멱등)
// 를 확인한다.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/store/Store.js';
import { SCHEMA_VERSION } from '../../src/store/schema.js';

/** T43 이전(v2)의 스키마 그대로. 여기 문장을 고치면 안 된다 — 과거의 모양이다. */
const V2_SQL = `
CREATE TABLE schema_version (version INTEGER NOT NULL);
CREATE TABLE departments (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, head_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE teams (
  id TEXT PRIMARY KEY, department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name TEXT NOT NULL, cwd TEXT NOT NULL, leader_id TEXT, max_members INTEGER NOT NULL DEFAULT 4,
  allowed_engines TEXT NOT NULL DEFAULT '["claude","codex"]', created_at TEXT NOT NULL);
CREATE INDEX idx_teams_department ON teams(department_id);
CREATE TABLE members (
  id TEXT PRIMARY KEY, department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE, parent_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  name TEXT NOT NULL, rank TEXT NOT NULL CHECK (rank IN ('head','lead','member')),
  engine TEXT NOT NULL CHECK (engine IN ('claude','codex')), session_id TEXT, child_pid INTEGER, cwd TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting','idle','working','waiting_approval','waiting_answer','exited','error')),
  hired_by TEXT NOT NULL CHECK (hired_by IN ('user','leader')), member_token TEXT NOT NULL UNIQUE,
  instructions_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_members_team ON members(team_id);
CREATE INDEX idx_members_department ON members(department_id);
CREATE INDEX idx_members_parent ON members(parent_id);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, department_id TEXT NOT NULL DEFAULT '',
  team_id TEXT NOT NULL, member_id TEXT NOT NULL, kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}', ref TEXT NOT NULL DEFAULT '{}');
CREATE INDEX idx_events_team_seq ON events(team_id, seq);
CREATE INDEX idx_events_department_seq ON events(department_id, seq);
CREATE INDEX idx_events_member_seq ON events(member_id, seq);
CREATE TABLE pending (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('approval','question')), payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('open','answered','expired')), created_at TEXT NOT NULL,
  answered_at TEXT, answer TEXT);
CREATE INDEX idx_pending_member_status ON pending(member_id, status);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  from_member TEXT NOT NULL, to_member TEXT NOT NULL, instruction TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','assigned','reported','aborted')),
  report_text TEXT, report_status TEXT CHECK (report_status IS NULL OR report_status IN ('done','blocked','aborted')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_tasks_department_status ON tasks(department_id, status);
CREATE INDEX idx_tasks_to_status ON tasks(to_member, status);
CREATE INDEX idx_tasks_from_status ON tasks(from_member, status);
`;

const TS = '2026-09-20T00:00:00.000Z';

/** v2 DB: 부서 alpha(부장 반장) + 팀 t1(팀장 이음) + task·event·pending 각 한 건. */
function writeV2Db(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(V2_SQL);
  db.prepare('INSERT INTO schema_version(version) VALUES (2)').run();
  db.prepare('INSERT INTO departments(id, name, cwd, head_id, created_at) VALUES (?,?,?,?,?)').run('d_a', 'alpha', 'D:/proj/alpha', 'm_head', TS);
  db.prepare('INSERT INTO teams(id, department_id, name, cwd, leader_id, max_members, allowed_engines, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('t_1', 'd_a', 't1', 'D:/proj/alpha', 'm_lead', 4, '["claude","codex"]', TS);
  const member = (id: string, teamId: string | null, parentId: string | null, name: string, rank: string, engine = 'claude') =>
    db.prepare(
      `INSERT INTO members(id, department_id, team_id, parent_id, name, rank, engine, session_id, child_pid, cwd, status,
                           hired_by, member_token, instructions_path, created_at, updated_at)
       VALUES (?,'d_a',?,?,?,?,?,?,?,?,'idle','user',?,NULL,?,?)`,
    ).run(id, teamId, parentId, name, rank, engine, `sess-${id}`, 1234, 'D:/proj/alpha', `tok-${id}`, TS, TS);
  member('m_head', null, null, '반장', 'head');
  member('m_lead', 't_1', 'm_head', '이음', 'lead', 'codex');
  db.prepare('INSERT INTO tasks(id, department_id, from_member, to_member, instruction, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(1, 'd_a', 'user', 'm_head', '기능 만들어', 'assigned', TS, TS);
  db.prepare('INSERT INTO events(ts, department_id, team_id, member_id, kind, detail, ref) VALUES (?,?,?,?,?,?,?)')
    .run(TS, 'd_a', '', 'm_head', 'thinking', '{}', '{}');
  db.prepare("INSERT INTO pending(id, member_id, type, payload, status, created_at) VALUES ('a_1','m_head','approval','{}','open',?)").run(TS);
  db.close();
}

const engineUsage = (engine: string, usedPercent: number) => ({
  engine,
  connected: true,
  plan: 'max',
  weekly: { usedPercent, resetsAt: '2026-09-24T03:00:00.000Z' },
  session: null,
  updatedAt: TS,
  reason: null,
});

describe('스키마 v2 → v3 마이그레이션 (T43, D-45 사용량)', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-mig3-'));
    dbPath = path.join(dir, 'pixel-office.db');
    writeV2Db(dbPath);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('v2 행은 그대로, 사용량 테이블만 생기고 버전이 3 이 된다', () => {
    const store = new Store(dbPath);
    assert.deepEqual(store.listDepartments().map((d) => d.id), ['d_a']);
    assert.deepEqual(store.listTeams().map((t) => t.id), ['t_1']);
    assert.deepEqual(store.listMembers().map((m) => m.id), ['m_head', 'm_lead']);
    assert.deepEqual(store.listTasks().map((t) => t.id), [1]);
    assert.equal(store.lastSeq(), 1);
    assert.deepEqual(store.listOpenPending().map((p) => p.id), ['a_1']);
    // 새 테이블은 비어 있다.
    assert.deepEqual(store.listEngineUsage(), []);
    assert.deepEqual(store.listMemberUsage(), []);
    store.close();

    const raw = new DatabaseSync(dbPath);
    assert.equal((raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 3);
    assert.equal(SCHEMA_VERSION, 3);
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    assert.ok(tables.includes('engine_usage'), tables.join(','));
    assert.ok(tables.includes('member_usage'), tables.join(','));
    raw.close();
  });

  test('사용량 행을 쓰고 다시 열면 그대로 읽힌다(upsert)', () => {
    const s1 = new Store(dbPath);
    s1.putEngineUsage('claude', engineUsage('claude', 54), TS);
    s1.putEngineUsage('claude', engineUsage('claude', 55), '2026-09-21T00:00:00.000Z');
    s1.putEngineUsage('codex', engineUsage('codex', 12), TS);
    s1.putMemberUsage('m_head', { memberId: 'm_head', engine: 'claude', costUsd: 1.84 }, TS);
    s1.close();

    const s2 = new Store(dbPath);
    const engines = s2.listEngineUsage();
    assert.deepEqual(engines.map((e) => e.engine), ['claude', 'codex']);
    assert.equal((engines[0]!.value as { weekly: { usedPercent: number } }).weekly.usedPercent, 55, 'upsert 로 덮어쓴다');
    assert.equal(engines[0]!.updatedAt, '2026-09-21T00:00:00.000Z');
    const members = s2.listMemberUsage();
    assert.deepEqual(members.map((m) => m.memberId), ['m_head']);
    assert.equal((members[0]!.value as { costUsd: number }).costUsd, 1.84);
    s2.close();
  });

  test('멤버 사용량은 멤버와 함께 사라지고(부서 삭제 cascade) 엔진 사용량은 남는다', () => {
    const store = new Store(dbPath);
    store.putEngineUsage('claude', engineUsage('claude', 54), TS);
    store.putMemberUsage('m_head', { memberId: 'm_head' }, TS);
    store.putMemberUsage('m_lead', { memberId: 'm_lead' }, TS);
    assert.equal(store.listMemberUsage().length, 2);

    assert.equal(store.deleteDepartment('d_a'), true);
    assert.deepEqual(store.listMemberUsage(), [], '부서 삭제 → 멤버 삭제 → 사용량 행도 사라진다');
    assert.equal(store.listEngineUsage().length, 1, '엔진 행은 남는다(마지막 값 표시용)');
    store.close();
  });

  test('팀 삭제 경로에서도 팀 멤버의 사용량이 사라진다', () => {
    const store = new Store(dbPath);
    store.putMemberUsage('m_head', { memberId: 'm_head' }, TS);
    store.putMemberUsage('m_lead', { memberId: 'm_lead' }, TS);
    assert.equal(store.deleteTeam('t_1'), true);
    assert.deepEqual(store.listMemberUsage().map((m) => m.memberId), ['m_head'], '팀 멤버만 사라진다');
    store.close();
  });

  test('deleteMemberUsage 는 멤버 행을 남긴 채 사용량만 지운다(퇴근이 아니라 명시 삭제용)', () => {
    const store = new Store(dbPath);
    store.putMemberUsage('m_lead', { memberId: 'm_lead' }, TS);
    assert.equal(store.deleteMemberUsage('m_lead'), true);
    assert.equal(store.deleteMemberUsage('m_lead'), false, '없는 행은 false');
    assert.ok(store.getMember('m_lead'), '멤버 행은 그대로');
    store.close();
  });

  test('json 이 깨진 행은 조용히 건너뛴다', () => {
    const store = new Store(dbPath);
    store.putEngineUsage('claude', engineUsage('claude', 54), TS);
    store.close();
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE engine_usage SET json = '{oops' WHERE engine = 'claude'").run();
    raw.close();
    const s2 = new Store(dbPath);
    assert.deepEqual(s2.listEngineUsage(), []);
    s2.close();
  });

  test('다시 열어도 그대로(멱등)', () => {
    const s1 = new Store(dbPath);
    s1.putEngineUsage('claude', engineUsage('claude', 54), TS);
    s1.close();
    const s2 = new Store(dbPath);
    assert.equal(s2.listEngineUsage().length, 1);
    assert.equal(s2.listMembers().length, 2);
    s2.close();
    const raw = new DatabaseSync(dbPath);
    assert.equal((raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 3);
    raw.close();
  });

  test('v1 DB 도 한 번에 v3 까지 간다(v1 → v2 → 사용량 테이블)', () => {
    // v1 경로는 Migration.test.ts 가 자세히 본다. 여기서는 v3 산출물만 확인한다.
    const v1Path = path.join(dir, 'v1.db');
    const db = new DatabaseSync(v1Path);
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, leader_id TEXT,
        max_members INTEGER NOT NULL DEFAULT 4, allowed_engines TEXT NOT NULL DEFAULT '["claude"]', created_at TEXT NOT NULL);
      CREATE TABLE members (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        name TEXT NOT NULL, rank TEXT NOT NULL CHECK (rank IN ('leader','member')),
        engine TEXT NOT NULL CHECK (engine IN ('claude','codex')), session_id TEXT, child_pid INTEGER, cwd TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('starting','idle','working','waiting_approval','waiting_answer','exited','error')),
        hired_by TEXT NOT NULL CHECK (hired_by IN ('user','leader')), member_token TEXT NOT NULL UNIQUE,
        instructions_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, team_id TEXT NOT NULL,
        member_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', ref TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE pending (id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('approval','question')), payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK (status IN ('open','answered','expired')), created_at TEXT NOT NULL, answered_at TEXT, answer TEXT);
      CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        from_member TEXT NOT NULL, to_member TEXT NOT NULL, instruction TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','assigned','reported','aborted')),
        report_text TEXT, report_status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    db.prepare('INSERT INTO schema_version(version) VALUES (1)').run();
    db.prepare('INSERT INTO teams(id, name, cwd, leader_id, created_at) VALUES (?,?,?,?,?)').run('t_a', 'alpha', 'D:/a', 'm_l', TS);
    db.prepare(
      `INSERT INTO members(id, team_id, name, rank, engine, session_id, child_pid, cwd, status, hired_by, member_token, instructions_path, created_at, updated_at)
       VALUES ('m_l','t_a','반장','leader','claude',NULL,NULL,'D:/a','idle','user','tok-l',NULL,?,?)`,
    ).run(TS, TS);
    db.close();

    const store = new Store(v1Path);
    store.putMemberUsage('m_l', { memberId: 'm_l' }, TS);
    store.putEngineUsage('claude', engineUsage('claude', 1), TS);
    assert.equal(store.listMemberUsage().length, 1);
    assert.equal(store.listEngineUsage().length, 1);
    // 멤버를 지우면 사용량도 따라간다 = FK 가 members(살아 있는 테이블)를 가리킨다.
    assert.equal(store.deleteMember('m_l'), true);
    assert.deepEqual(store.listMemberUsage(), []);
    store.close();
  });
});
