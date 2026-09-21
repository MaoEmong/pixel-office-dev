// T43-4 — 스키마 v3 → v4(확인용 세션 pid). **추가만** 하는 마이그레이션이다.
//
// v3 DB(T43-1 의 모양)를 파일로 만들어 놓고 `new Store(path)` 로 열었을 때
//   ① 기존 행(부서·멤버·사용량)이 변하지 않고 ② `usage_probe` 테이블이 생기며 버전이 올라가고
//   ③ pid 를 적고 지울 수 있고(멤버가 아니라 FK 가 없다) ④ 다시 열어도 그대로다.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/store/Store.js';
import { SCHEMA_VERSION } from '../../src/store/schema.js';

/** T43-4 이전(v3)의 스키마 — 여기 문장을 고치면 안 된다(과거의 모양이다). 필요한 표만 만든다. */
const V3_SQL = `
CREATE TABLE schema_version (version INTEGER NOT NULL);
CREATE TABLE departments (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, head_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE teams (
  id TEXT PRIMARY KEY, department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name TEXT NOT NULL, cwd TEXT NOT NULL, leader_id TEXT, max_members INTEGER NOT NULL DEFAULT 4,
  allowed_engines TEXT NOT NULL DEFAULT '["claude","codex"]', created_at TEXT NOT NULL);
CREATE TABLE members (
  id TEXT PRIMARY KEY, department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE, parent_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  name TEXT NOT NULL, rank TEXT NOT NULL CHECK (rank IN ('head','lead','member')),
  engine TEXT NOT NULL CHECK (engine IN ('claude','codex')), session_id TEXT, child_pid INTEGER, cwd TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting','idle','working','waiting_approval','waiting_answer','exited','error')),
  hired_by TEXT NOT NULL CHECK (hired_by IN ('user','leader')), member_token TEXT NOT NULL UNIQUE,
  instructions_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, department_id TEXT NOT NULL DEFAULT '',
  team_id TEXT NOT NULL, member_id TEXT NOT NULL, kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}', ref TEXT NOT NULL DEFAULT '{}');
CREATE TABLE pending (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('approval','question')), payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('open','answered','expired')), created_at TEXT NOT NULL,
  answered_at TEXT, answer TEXT);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  from_member TEXT NOT NULL, to_member TEXT NOT NULL, instruction TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','assigned','reported','aborted')),
  report_text TEXT, report_status TEXT CHECK (report_status IS NULL OR report_status IN ('done','blocked','aborted')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE engine_usage (engine TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE member_usage (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE, json TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

const TS = '2026-09-21T10:00:00.000Z';

function writeV3Db(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(V3_SQL);
  db.prepare('INSERT INTO schema_version(version) VALUES (3)').run();
  db.prepare('INSERT INTO departments(id, name, cwd, head_id, created_at) VALUES (?,?,?,?,?)').run('d_a', 'alpha', 'D:\\a', 'm_head', TS);
  db.prepare(
    `INSERT INTO members(id, department_id, team_id, parent_id, name, rank, engine, session_id, child_pid, cwd,
                         status, hired_by, member_token, instructions_path, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('m_head', 'd_a', null, null, '국장', 'head', 'claude', null, null, 'D:\\a', 'idle', 'user', 'tok_head', null, TS, TS);
  // T43-1 이 쓴 엔진 사용량 행(= `models`·`source` 가 없는 옛 모양).
  db.prepare('INSERT INTO engine_usage(engine, json, updated_at) VALUES (?,?,?)').run(
    'claude',
    JSON.stringify({ engine: 'claude', connected: true, plan: 'max', weekly: { usedPercent: 54, resetsAt: null }, session: null, updatedAt: TS, reason: null }),
    TS,
  );
  db.close();
}

describe('스키마 v3 → v4 마이그레이션 (T43-4 확인용 세션 pid)', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-mig4-'));
    dbPath = path.join(dir, 'pixel-office.db');
    writeV3Db(dbPath);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('v3 행은 그대로, usage_probe 테이블만 생기고 버전이 올라간다', () => {
    const store = new Store(dbPath);
    assert.deepEqual(store.listDepartments().map((d) => d.id), ['d_a']);
    assert.deepEqual(store.listMembers().map((m) => m.id), ['m_head']);
    assert.equal(store.listEngineUsage().length, 1, '옛 사용량 행은 그대로 읽힌다');
    assert.deepEqual(store.listUsageProbePids(), [], '새 표는 비어 있다');
    store.close();

    const raw = new DatabaseSync(dbPath);
    assert.equal((raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version, SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 5, 'T46-1 에서 members.status 에 suspended 가 붙으며 v5 가 됐다');
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    assert.ok(tables.includes('usage_probe'), tables.join(','));
    // v5(T46-1): 같은 열기에서 members 표가 다시 만들어지고 CHECK 에 suspended 가 들어간다.
    const membersSql = (raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='members'").get() as { sql: string }).sql;
    assert.ok(membersSql.includes('suspended'), membersSql);
    assert.ok(!tables.includes('members_v5'), '임시 표는 남지 않는다');
    // 인덱스도 다시 만들어진다(표와 함께 사라지므로).
    const idx = (raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='members'").all() as Array<{ name: string }>).map((r) => r.name);
    for (const want of ['idx_members_team', 'idx_members_department', 'idx_members_parent']) assert.ok(idx.includes(want), idx.join(','));
    raw.close();
  });

  test('pid 를 적고 덮어쓰고 지운다 — 멤버가 아니라 FK 가 없다', () => {
    const store = new Store(dbPath);
    store.putUsageProbePid('claude', 1234, TS);
    store.putUsageProbePid('codex', 5678, TS);
    assert.deepEqual(store.listUsageProbePids(), [
      { engine: 'claude', childPid: 1234 },
      { engine: 'codex', childPid: 5678 },
    ]);
    store.putUsageProbePid('claude', 4321, TS);
    assert.equal(store.listUsageProbePids()[0]!.childPid, 4321, 'upsert');
    store.putUsageProbePid('claude', null);
    assert.deepEqual(store.listUsageProbePids().map((r) => r.engine), ['codex'], 'null 이면 행을 지운다');
    store.clearUsageProbePids();
    assert.deepEqual(store.listUsageProbePids(), []);
    store.close();
  });

  test('pid 는 멤버 삭제와 무관하다(확인용 세션은 멤버가 아니다)', () => {
    const store = new Store(dbPath);
    store.putUsageProbePid('claude', 1234, TS);
    assert.equal(store.deleteDepartment('d_a'), true);
    assert.deepEqual(store.listUsageProbePids(), [{ engine: 'claude', childPid: 1234 }]);
    store.close();
  });

  test('다시 열어도 그대로(멱등)', () => {
    const s1 = new Store(dbPath);
    s1.putUsageProbePid('claude', 1234, TS);
    s1.close();
    const s2 = new Store(dbPath);
    assert.deepEqual(s2.listUsageProbePids(), [{ engine: 'claude', childPid: 1234 }]);
    s2.close();
  });
});
