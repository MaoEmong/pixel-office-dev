// SQLite 스키마. 버전은 schema_version 테이블 한 행. 마이그레이션이 필요해지면 여기서 버전별 스텝을 늘린다.
//
// v2(T34, D-32 직무 체계 rev 3): 2단(팀/팀장/팀원)에서 3단 트리(부서 → 부장 → 팀/팀장 → 팀원)로.
//   departments          부서 = 프로젝트(cwd). 부장(head_id)은 부서에 한 명.
//   teams.department_id  팀은 부서에 속한다. cwd 는 당분간 부서 cwd 와 같다(D-32 "한 부서 안의 팀들은 같은 cwd").
//   members.parent_id    트리 간선. 부장 null, 팀장 = 부장, 팀원 = 팀장.
//   members.team_id      **nullable** — 부장은 팀에 속하지 않는다(부서 직속).
//   members.rank         'head' | 'lead' | 'member'
//   tasks.department_id  task 는 부서 범위(팀이 없는 부장도 사용자 task 를 받는다). v1 의 team_id 를 대체한다.
//   events.department_id 이벤트도 부서 범위를 같이 싣는다. team_id 는 그대로 두되 팀 없는 멤버는 ''.
//
// v1 → v2 마이그레이션은 Store.migrate() 가 한다(기존 팀 하나 = 부서 하나). 표는 worklog/T34-TreeModel.md.

export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

-- 부서 = 프로젝트(cwd). head_id 는 그 부서의 부장(members.id). 부장이 나가도 값은 남는다
-- (살아 있는 부장 판정은 Store.liveHead 가 rank/status 로 한다 — teams.leader_id 와 같은 규칙).
CREATE TABLE IF NOT EXISTS departments (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  cwd        TEXT NOT NULL,
  head_id    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id              TEXT PRIMARY KEY,
  department_id   TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  cwd             TEXT NOT NULL,
  leader_id       TEXT,
  max_members     INTEGER NOT NULL DEFAULT 4,
  allowed_engines TEXT NOT NULL DEFAULT '["claude","codex"]',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_teams_department ON teams(department_id);

CREATE TABLE IF NOT EXISTS members (
  id                TEXT PRIMARY KEY,
  department_id     TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  team_id           TEXT REFERENCES teams(id) ON DELETE CASCADE,
  parent_id         TEXT REFERENCES members(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  rank              TEXT NOT NULL CHECK (rank IN ('head','lead','member')),
  engine            TEXT NOT NULL CHECK (engine IN ('claude','codex')),
  session_id        TEXT,
  child_pid         INTEGER,
  cwd               TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                      ('starting','idle','working','waiting_approval','waiting_answer','exited','error')),
  hired_by          TEXT NOT NULL CHECK (hired_by IN ('user','leader')),
  member_token      TEXT NOT NULL UNIQUE,
  instructions_path TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_members_team ON members(team_id);
CREATE INDEX IF NOT EXISTS idx_members_department ON members(department_id);
CREATE INDEX IF NOT EXISTS idx_members_parent ON members(parent_id);

-- events 는 이력이라 FK 없음(멤버·팀·부서 삭제 후에도 남는다). seq 는 AUTOINCREMENT 로 재사용 금지.
-- team_id 는 그 멤버의 팀(팀 없는 부장은 '').
CREATE TABLE IF NOT EXISTS events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  department_id TEXT NOT NULL DEFAULT '',
  team_id       TEXT NOT NULL,
  member_id     TEXT NOT NULL,
  kind          TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '{}',
  ref           TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_team_seq ON events(team_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_department_seq ON events(department_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_member_seq ON events(member_id, seq);

CREATE TABLE IF NOT EXISTS pending (
  id          TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('approval','question')),
  payload     TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL CHECK (status IN ('open','answered','expired')),
  created_at  TEXT NOT NULL,
  answered_at TEXT,
  answer      TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_member_status ON pending(member_id, status);

-- from_member / to_member 는 'user' 가 올 수 있어 FK 없음. 부서 삭제 시엔 cascade.
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  from_member   TEXT NOT NULL,
  to_member     TEXT NOT NULL,
  instruction   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('queued','assigned','reported','aborted')),
  report_text   TEXT,
  report_status TEXT CHECK (report_status IS NULL OR report_status IN ('done','blocked','aborted')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_department_status ON tasks(department_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_to_status ON tasks(to_member, status);
CREATE INDEX IF NOT EXISTS idx_tasks_from_status ON tasks(from_member, status);
`;

/**
 * v1 테이블을 `*_v1` 으로 옮기고 v1 인덱스를 지운다. SCHEMA_SQL 을 실행하기 **전에** 부른다
 * (이름이 비어야 v2 정의로 다시 만들어진다). 실제 복사는 `V1_TO_V2_COPY_ORDER` 순서로 Store 가 한다.
 */
export const V1_RENAME_SQL = `
DROP INDEX IF EXISTS idx_members_team;
DROP INDEX IF EXISTS idx_tasks_team_status;
DROP INDEX IF EXISTS idx_tasks_to_status;
DROP INDEX IF EXISTS idx_tasks_from_status;
ALTER TABLE teams RENAME TO teams_v1;
ALTER TABLE members RENAME TO members_v1;
ALTER TABLE tasks RENAME TO tasks_v1;
ALTER TABLE events ADD COLUMN department_id TEXT NOT NULL DEFAULT '';
`;

export const V1_DROP_SQL = `
DROP TABLE IF EXISTS tasks_v1;
DROP TABLE IF EXISTS members_v1;
DROP TABLE IF EXISTS teams_v1;
`;
