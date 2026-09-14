// SQLite 스키마. 버전은 schema_version 테이블 한 행. 마이그레이션이 필요해지면 여기서 버전별 스텝을 늘린다.

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  cwd             TEXT NOT NULL,
  leader_id       TEXT,
  max_members     INTEGER NOT NULL DEFAULT 4,
  allowed_engines TEXT NOT NULL DEFAULT '["claude","codex"]',
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id                TEXT PRIMARY KEY,
  team_id           TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  rank              TEXT NOT NULL CHECK (rank IN ('leader','member')),
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

-- events 는 이력이라 FK 없음(멤버·팀 삭제 후에도 남는다). seq 는 AUTOINCREMENT 로 재사용 금지.
CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  team_id   TEXT NOT NULL,
  member_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT '{}',
  ref       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_team_seq ON events(team_id, seq);
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

-- from_member / to_member 는 'user' 가 올 수 있어 FK 없음. 팀 삭제 시엔 cascade.
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  from_member   TEXT NOT NULL,
  to_member     TEXT NOT NULL,
  instruction   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('queued','assigned','reported','aborted')),
  report_text   TEXT,
  report_status TEXT CHECK (report_status IS NULL OR report_status IN ('done','blocked','aborted')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_team_status ON tasks(team_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_to_status ON tasks(to_member, status);
CREATE INDEX IF NOT EXISTS idx_tasks_from_status ON tasks(from_member, status);
`;
