// SQLite 영속 저장소. node:sqlite(DatabaseSync, D-08) 사용 — 네이티브 의존성 없음.
// 모든 API 는 동기. 파일 경로는 `${config.dataDir}/pixel-office.db`, 테스트는 ':memory:'.
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from '../config.js';
import { PENDING_FK_REPAIR_SQL, SCHEMA_SQL, SCHEMA_VERSION, V1_DROP_SQL, V1_RENAME_SQL } from './schema.js';
import type {
  AppendEventInput,
  CreateDepartmentInput,
  CreateMemberInput,
  CreatePendingInput,
  CreateTaskInput,
  CreateTeamInput,
  Department,
  Engine,
  EventDetail,
  EventRef,
  EventsQueryInput,
  ListTasksInput,
  Member,
  OfficeEvent,
  OfficeEventKind,
  Pending,
  Snapshot,
  Task,
  TaskStatus,
  Team,
  UpdateDepartmentInput,
  UpdateMemberInput,
  UpdateTaskInput,
  UpdateTeamInput,
} from './types.js';

// ---- node:sqlite ExperimentalWarning 억제 ----------------------------------
// node:sqlite 는 로드 시 "SQLite is an experimental feature..." ExperimentalWarning 을 낸다.
// emitWarning 은 nextTick 으로 'warning' 이벤트를 내므로 이 모듈 본문에서 필터를 걸면 늦지 않다.
// process.removeAllListeners('warning') 은 다른 경고까지 지우므로, 기존 리스너를 보존한 채
// 이 경고 하나만 걸러서 나머지는 원래 리스너(Node 기본 stderr 출력 포함)로 넘긴다.
const WARNING_FILTER_KEY = Symbol.for('pixel-office.sqliteWarningFilter');
type ProcessWithFlag = NodeJS.Process & { [WARNING_FILTER_KEY]?: true };
const proc = process as ProcessWithFlag;
if (!proc[WARNING_FILTER_KEY]) {
  proc[WARNING_FILTER_KEY] = true;
  const isSqliteExperimental = (w: Error) =>
    w.name === 'ExperimentalWarning' && typeof w.message === 'string' && w.message.includes('SQLite');
  const original = process.listeners('warning');
  for (const l of original) process.removeListener('warning', l);
  process.on('warning', (w: Error) => {
    if (isSqliteExperimental(w)) return;
    for (const l of original) l.call(process, w);
  });
}

// ---- 내부 유틸 ---------------------------------------------------------------

export const DEFAULT_DB_PATH = path.join(config.dataDir, 'pixel-office.db');

const nowIso = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const newToken = () => randomBytes(24).toString('hex');
const toNum = (v: number | bigint) => Number(v);
const cutoffIso = (days: number, now: number = Date.now()) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

/**
 * 보존 정책 기본값(T30/D-39). 사무실 로그는 "무엇이 일어났나" 를 보여 주는 이력이지 감사 기록이 아니다 —
 * 무한히 쌓이면 개발 머신의 DB 가 커지고 스냅샷·조회가 느려진다.
 */
export const DEFAULT_RETENTION = {
  /** 부서당 남길 이벤트 수. */
  keepPerTeam: 50_000,
  /** 닫힌 pending(answered/expired) 보존 일수. */
  pendingDays: 30,
  /** 끝난 task(reported/aborted) 보존 일수. */
  taskDays: 90,
} as const;

export interface RetentionOptions {
  keepPerTeam?: number;
  pendingDays?: number;
  taskDays?: number;
  /** 기준 시각(테스트용). 기본 지금. */
  now?: number;
}

/** `pruneRetention()` 이 지운 행 수. */
export interface RetentionResult {
  events: number;
  pending: number;
  tasks: number;
}

type Row = Record<string, unknown>;

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToDepartment(r: Row): Department {
  return {
    id: r.id as string,
    name: r.name as string,
    cwd: r.cwd as string,
    headId: (r.head_id as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function rowToTeam(r: Row): Team {
  return {
    id: r.id as string,
    departmentId: r.department_id as string,
    name: r.name as string,
    cwd: r.cwd as string,
    leaderId: (r.leader_id as string | null) ?? null,
    maxMembers: toNum(r.max_members as number),
    allowedEngines: parseJson<Engine[]>(r.allowed_engines, ['claude', 'codex']),
    createdAt: r.created_at as string,
  };
}

function rowToMember(r: Row): Member {
  return {
    id: r.id as string,
    departmentId: r.department_id as string,
    teamId: (r.team_id as string | null) ?? null,
    parentId: (r.parent_id as string | null) ?? null,
    name: r.name as string,
    rank: r.rank as Member['rank'],
    engine: r.engine as Engine,
    sessionId: (r.session_id as string | null) ?? null,
    childPid: r.child_pid == null ? null : toNum(r.child_pid as number),
    cwd: r.cwd as string,
    status: r.status as Member['status'],
    hiredBy: r.hired_by as Member['hiredBy'],
    memberToken: r.member_token as string,
    instructionsPath: (r.instructions_path as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function rowToEvent(r: Row): OfficeEvent {
  return {
    seq: toNum(r.seq as number),
    ts: r.ts as string,
    departmentId: (r.department_id as string | null) ?? '',
    teamId: (r.team_id as string | null) ?? '',
    memberId: r.member_id as string,
    kind: r.kind as OfficeEventKind,
    detail: parseJson<EventDetail>(r.detail, {}),
    ref: parseJson<EventRef>(r.ref, {}),
  };
}

function rowToPending(r: Row): Pending {
  return {
    id: r.id as string,
    memberId: r.member_id as string,
    type: r.type as Pending['type'],
    payload: parseJson<Record<string, unknown>>(r.payload, {}),
    status: r.status as Pending['status'],
    createdAt: r.created_at as string,
    answeredAt: (r.answered_at as string | null) ?? null,
    answer: r.answer == null ? null : parseJson<unknown>(r.answer, null),
  };
}

function rowToTask(r: Row): Task {
  return {
    id: toNum(r.id as number),
    departmentId: r.department_id as string,
    fromMember: r.from_member as string,
    toMember: r.to_member as string,
    instruction: r.instruction as string,
    status: r.status as TaskStatus,
    reportText: (r.report_text as string | null) ?? null,
    reportStatus: (r.report_status as Task['reportStatus']) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/** partial 객체 → `col = ?` 목록. 컬럼 매핑에 없는 키·undefined 값은 무시. */
function buildSet(
  patch: Record<string, unknown>,
  columns: Record<string, { col: string; encode?: (v: unknown) => SQLInputValue }>,
): { sets: string[]; params: SQLInputValue[] } {
  const sets: string[] = [];
  const params: SQLInputValue[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const spec = columns[key];
    if (!spec) continue;
    sets.push(`${spec.col} = ?`);
    params.push(spec.encode ? spec.encode(value) : (value as SQLInputValue));
  }
  return { sets, params };
}

const json = (v: unknown): SQLInputValue => JSON.stringify(v ?? null);
const nullable = (v: unknown): SQLInputValue => (v == null ? null : (v as SQLInputValue));

const OPEN_TASK_STATUSES: TaskStatus[] = ['queued', 'assigned'];

// ---- Store -------------------------------------------------------------------

export class Store {
  readonly path: string;
  private db: DatabaseSync;

  /**
   * @param dbPath 파일 경로. 생략 시 `${config.dataDir}/pixel-office.db`. 테스트는 ':memory:'.
   */
  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.path = dbPath;
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    if (dbPath !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  /**
   * 열 때마다 한 번. 없는 테이블을 만들고(`CREATE TABLE IF NOT EXISTS`), 옛 버전이면 스텝을 태운다.
   *
   * v1(2단: 팀·팀장·팀원) → v2(3단 트리: 부서·부장·팀장·팀원)는 팀 정의가 바뀌어(CHECK(rank), NOT NULL,
   * FK 대상) ALTER 만으로는 안 되므로 **teams/members/tasks 를 통째로 다시 만든다**:
   *   ① v1 테이블을 `*_v1` 으로 rename(+ v1 인덱스 제거, events 에 department_id 추가)
   *   ② SCHEMA_SQL 로 v2 테이블 생성
   *   ③ 팀 하나 = 부서 하나로 복사 — 팀장(rank 'leader')은 **부장(head)** 이 되고 그 부서의 head_id 이자
   *      옛 팀의 leader_id 로 남는다(부장이 레거시 팀의 팀장을 겸한다). 옛 팀원은 rank 'member' + parent_id = 부장.
   *      tasks·events 는 그 부서 id 를 받는다.
   *   ④ `*_v1` drop.
   * 개발 DB 하나를 위한 코드다(배포 전) — 실패하면 던져서 잘못된 상태로 열리지 않게 한다.
   */
  private migrate(): void {
    const version = this.readVersion();
    if (version !== undefined && version > SCHEMA_VERSION) {
      throw new Error(`pixel-office.db schema_version ${version} is newer than supported ${SCHEMA_VERSION}`);
    }
    if (version === 1) {
      // 테이블을 다시 만드는 동안에는 FK 를 꺼 둔다(ALTER RENAME 이 참조를 따라다니지 않게).
      this.db.exec('PRAGMA foreign_keys = OFF');
      this.db.exec(V1_RENAME_SQL);
      this.db.exec(SCHEMA_SQL);
      this.transaction(() => this.copyV1ToV2());
      this.db.exec(V1_DROP_SQL);
      this.db.exec('PRAGMA foreign_keys = ON');
    } else {
      this.db.exec(SCHEMA_SQL);
    }
    this.repairPendingFk();
    this.writeVersion(SCHEMA_VERSION);
  }

  /**
   * **T39** — v1 → v2 마이그레이션이 `pending.member_id` 의 REFERENCES 를 `members_v1`(이미 drop 된 임시 테이블)로
   * 바꿔 놓은 DB 를 고친다. 그대로 두면 `createPending` 이 전부 `no such table: main.members_v1` 로 던져
   * 허가 카드·`ask_user`·`ask_parent` 가 통째로 죽는다(어댑터는 hook 을 보류한 뒤 던지므로 CLI 가 영영 멈춘다).
   *
   * 이유는 schema.ts `PENDING_FK_REPAIR_SQL` 주석에. 열 때마다 검사하지만 실제 작업은 깨진 DB 에서 한 번뿐이다.
   */
  private repairPendingFk(): void {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pending'")
      .get() as Row | undefined;
    const sql = typeof row?.sql === 'string' ? row.sql : '';
    if (!sql.includes('members_v1')) return;
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.transaction(() => this.db.exec(PENDING_FK_REPAIR_SQL));
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
    console.warn('[store] pending.member_id FK 복구: members_v1 → members (T39)');
  }

  /** schema_version 한 행. 테이블 자체가 없으면(새 DB) undefined. */
  private readVersion(): number | undefined {
    const t = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get() as Row | undefined;
    if (!t) return undefined;
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as Row | undefined;
    return row ? toNum(row.version as number) : undefined;
  }

  private writeVersion(version: number): void {
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as Row | undefined;
    if (row) this.db.prepare('UPDATE schema_version SET version = ?').run(version);
    else this.db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(version);
  }

  /** v1 `*_v1` 테이블 → v2 테이블. 팀 하나가 부서 하나가 된다(위 migrate 주석의 표). */
  private copyV1ToV2(): void {
    const teams = this.db.prepare('SELECT * FROM teams_v1 ORDER BY rowid').all() as Row[];
    for (const t of teams) {
      const teamId = t.id as string;
      const deptId = newId('d');
      const members = this.db.prepare('SELECT * FROM members_v1 WHERE team_id = ? ORDER BY rowid').all(teamId) as Row[];
      // v1 팀장(rank 'leader')이 부장이 된다. 없으면(팀장이 지워진 DB) head 는 null 로 둔다.
      const head = members.find((m) => m.rank === 'leader');
      const headId = (head?.id as string | undefined) ?? null;
      this.db
        .prepare('INSERT INTO departments(id, name, cwd, head_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(deptId, t.name as string, t.cwd as string, headId, t.created_at as string);
      this.db
        .prepare(
          `INSERT INTO teams(id, department_id, name, cwd, leader_id, max_members, allowed_engines, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(teamId, deptId, t.name as string, t.cwd as string, headId, t.max_members as number, t.allowed_engines as string, t.created_at as string);
      for (const m of members) {
        const isHead = m.rank === 'leader';
        this.db
          .prepare(
            `INSERT INTO members(id, department_id, team_id, parent_id, name, rank, engine, session_id, child_pid, cwd,
                                 status, hired_by, member_token, instructions_path, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            m.id as string,
            deptId,
            teamId,
            isHead ? null : headId,
            m.name as string,
            isHead ? 'head' : 'member',
            m.engine as string,
            nullable(m.session_id),
            nullable(m.child_pid),
            m.cwd as string,
            m.status as string,
            m.hired_by as string,
            m.member_token as string,
            nullable(m.instructions_path),
            m.created_at as string,
            m.updated_at as string,
          );
      }
      this.db
        .prepare(
          `INSERT INTO tasks(id, department_id, from_member, to_member, instruction, status, report_text, report_status, created_at, updated_at)
           SELECT id, ?, from_member, to_member, instruction, status, report_text, report_status, created_at, updated_at
           FROM tasks_v1 WHERE team_id = ?`,
        )
        .run(deptId, teamId);
      this.db.prepare('UPDATE events SET department_id = ? WHERE team_id = ?').run(deptId, teamId);
    }
  }

  /** 여러 쓰기를 한 트랜잭션으로. 예외 시 롤백 후 재throw. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- departments (T34) -----------------------------------------------------

  createDepartment(input: CreateDepartmentInput): Department {
    const id = input.id ?? newId('d');
    this.db
      .prepare('INSERT INTO departments(id, name, cwd, head_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.name, input.cwd, input.headId ?? null, nowIso());
    return this.getDepartment(id)!;
  }

  getDepartment(id: string): Department | undefined {
    const r = this.db.prepare('SELECT * FROM departments WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToDepartment(r) : undefined;
  }

  listDepartments(): Department[] {
    return (this.db.prepare('SELECT * FROM departments ORDER BY rowid').all() as Row[]).map(rowToDepartment);
  }

  updateDepartment(id: string, patch: UpdateDepartmentInput): Department | undefined {
    const { sets, params } = buildSet(patch as Record<string, unknown>, {
      name: { col: 'name' },
      cwd: { col: 'cwd' },
      headId: { col: 'head_id', encode: nullable },
    });
    if (sets.length > 0) {
      this.db.prepare(`UPDATE departments SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return this.getDepartment(id);
  }

  /** 부서 삭제. teams·members·tasks 는 FK cascade(members 의 pending 도), events 는 이력이라 남는다. */
  deleteDepartment(id: string): boolean {
    const res = this.db.prepare('DELETE FROM departments WHERE id = ?').run(id);
    return toNum(res.changes) > 0;
  }

  /**
   * 그 부서의 **살아 있는 부장**(rank='head' ∧ status ∉ {exited, error}). 사용자 지시 게이트(-32004)와
   * `department.create` 중복 방지가 이 함수 하나를 본다 — `departments.head_id` 는 나간 부장도 남기므로.
   */
  liveHead(departmentId: string): Member | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM members WHERE department_id = ? AND rank = 'head' AND status NOT IN ('exited', 'error')
         ORDER BY rowid LIMIT 1`,
      )
      .get(departmentId) as Row | undefined;
    return r ? rowToMember(r) : undefined;
  }

  // ---- teams ----------------------------------------------------------------

  createTeam(input: CreateTeamInput): Team {
    const id = input.id ?? newId('t');
    this.db
      .prepare(
        `INSERT INTO teams(id, department_id, name, cwd, leader_id, max_members, allowed_engines, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.departmentId,
        input.name,
        input.cwd,
        input.leaderId ?? null,
        input.maxMembers ?? 4,
        JSON.stringify(input.allowedEngines ?? ['claude', 'codex']),
        nowIso(),
      );
    return this.getTeam(id)!;
  }

  getTeam(id: string): Team | undefined {
    const r = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToTeam(r) : undefined;
  }

  listTeams(departmentId?: string): Team[] {
    const rows =
      departmentId === undefined
        ? (this.db.prepare('SELECT * FROM teams ORDER BY rowid').all() as Row[])
        : (this.db.prepare('SELECT * FROM teams WHERE department_id = ? ORDER BY rowid').all(departmentId) as Row[]);
    return rows.map(rowToTeam);
  }

  updateTeam(id: string, patch: UpdateTeamInput): Team | undefined {
    const { sets, params } = buildSet(patch as Record<string, unknown>, {
      name: { col: 'name' },
      cwd: { col: 'cwd' },
      leaderId: { col: 'leader_id', encode: nullable },
      maxMembers: { col: 'max_members' },
      allowedEngines: { col: 'allowed_engines', encode: json },
    });
    if (sets.length > 0) {
      this.db.prepare(`UPDATE teams SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return this.getTeam(id);
  }

  /** 팀 삭제. members·tasks 는 FK cascade, members 의 pending 도 cascade. events 는 남는다. */
  deleteTeam(id: string): boolean {
    const res = this.db.prepare('DELETE FROM teams WHERE id = ?').run(id);
    return toNum(res.changes) > 0;
  }

  // ---- members --------------------------------------------------------------

  createMember(input: CreateMemberInput): Member {
    const id = input.id ?? newId('m');
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO members(id, department_id, team_id, parent_id, name, rank, engine, session_id, child_pid, cwd, status,
                             hired_by, member_token, instructions_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.departmentId,
        input.teamId ?? null,
        input.parentId ?? null,
        input.name,
        input.rank,
        input.engine,
        input.sessionId ?? null,
        input.childPid ?? null,
        input.cwd,
        input.status ?? 'starting',
        input.hiredBy,
        input.memberToken ?? newToken(),
        input.instructionsPath ?? null,
        ts,
        ts,
      );
    return this.getMember(id)!;
  }

  getMember(id: string): Member | undefined {
    const r = this.db.prepare('SELECT * FROM members WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToMember(r) : undefined;
  }

  getMemberByToken(token: string): Member | undefined {
    const r = this.db.prepare('SELECT * FROM members WHERE member_token = ?').get(token) as Row | undefined;
    return r ? rowToMember(r) : undefined;
  }

  listMembers(teamId?: string): Member[] {
    const rows = teamId
      ? (this.db.prepare('SELECT * FROM members WHERE team_id = ? ORDER BY rowid').all(teamId) as Row[])
      : (this.db.prepare('SELECT * FROM members ORDER BY rowid').all() as Row[]);
    return rows.map(rowToMember);
  }

  /** 그 부서의 멤버 전부(부장 포함). 팀이 없는 부장도 들어간다. */
  listDepartmentMembers(departmentId: string): Member[] {
    return (
      this.db.prepare('SELECT * FROM members WHERE department_id = ? ORDER BY rowid').all(departmentId) as Row[]
    ).map(rowToMember);
  }

  updateMember(id: string, patch: UpdateMemberInput): Member | undefined {
    const { sets, params } = buildSet(patch as Record<string, unknown>, {
      name: { col: 'name' },
      rank: { col: 'rank' },
      engine: { col: 'engine' },
      sessionId: { col: 'session_id', encode: nullable },
      childPid: { col: 'child_pid', encode: nullable },
      cwd: { col: 'cwd' },
      status: { col: 'status' },
      teamId: { col: 'team_id', encode: nullable },
      parentId: { col: 'parent_id', encode: nullable },
      hiredBy: { col: 'hired_by' },
      memberToken: { col: 'member_token' },
      instructionsPath: { col: 'instructions_path', encode: nullable },
    });
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(nowIso());
      this.db.prepare(`UPDATE members SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return this.getMember(id);
  }

  /**
   * 그 팀의 **살아 있는 팀장**(rank='lead' ∧ status ∉ {exited, error}). 팀장 중복 방지·`[TEAM]` 알림 대상이
   * 이 함수 하나를 본다(`teams.leader_id` 는 나간 팀장도 남기므로).
   */
  liveLead(teamId: string): Member | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM members WHERE team_id = ? AND rank = 'lead' AND status NOT IN ('exited', 'error')
         ORDER BY rowid LIMIT 1`,
      )
      .get(teamId) as Row | undefined;
    return r ? rowToMember(r) : undefined;
  }

  /** T24 이름 그대로 쓰던 곳을 위한 별칭(= liveLead). */
  liveLeader(teamId: string): Member | undefined {
    return this.liveLead(teamId);
  }

  /** 그 멤버의 직속 부하 중 **살아 있는** 멤버(트리 간선 parent_id 기준). */
  childrenOf(memberId: string): Member[] {
    return (
      this.db
        .prepare(`SELECT * FROM members WHERE parent_id = ? AND status NOT IN ('exited', 'error') ORDER BY rowid`)
        .all(memberId) as Row[]
    ).map(rowToMember);
  }

  /** 그 멤버의 직속 상사(없으면 undefined — 부장이거나 상사가 지워졌다). */
  parentOf(memberId: string): Member | undefined {
    const parentId = this.getMember(memberId)?.parentId;
    return parentId ? this.getMember(parentId) : undefined;
  }

  /**
   * 그 멤버를 뿌리로 한 하위 트리를 **깊이 우선**으로(자기 자신 먼저, 그다음 자식의 하위 트리).
   * 후처리(부모 퇴근 = 하위 정리)는 이 배열을 **뒤에서부터** 훑으면 잎부터 정리된다.
   * exited/error 인 자식도 포함한다(행 정리·MCP 끊기 대상이라서). 순환이 생겨도 무한 루프를 돌지 않는다.
   */
  subtreeOf(memberId: string): Member[] {
    const out: Member[] = [];
    const seen = new Set<string>();
    const walk = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const m = this.getMember(id);
      if (!m) return;
      out.push(m);
      const kids = this.db.prepare('SELECT id FROM members WHERE parent_id = ? ORDER BY rowid').all(id) as Row[];
      for (const k of kids) walk(k.id as string);
    };
    walk(memberId);
    return out;
  }

  /** 멤버 삭제. 그 멤버의 pending 은 cascade. tasks·events 는 남는다(이력). */
  deleteMember(id: string): boolean {
    const res = this.db.prepare('DELETE FROM members WHERE id = ?').run(id);
    return toNum(res.changes) > 0;
  }

  // ---- events ---------------------------------------------------------------

  appendEvent(input: AppendEventInput): OfficeEvent {
    const res = this.db
      .prepare('INSERT INTO events(ts, department_id, team_id, member_id, kind, detail, ref) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        input.ts ?? nowIso(),
        input.departmentId,
        input.teamId ?? '',
        input.memberId,
        input.kind,
        JSON.stringify(input.detail ?? {}),
        JSON.stringify(input.ref ?? {}),
      );
    const r = this.db.prepare('SELECT * FROM events WHERE seq = ?').get(toNum(res.lastInsertRowid)) as Row;
    return rowToEvent(r);
  }

  /** seq 초과 이벤트를 오름차순으로 최대 limit 건. 재접속 `hello{since}` 용. */
  eventsSince(seq: number, limit = 1000): OfficeEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(seq, limit) as Row[]).map(
      rowToEvent,
    );
  }

  /**
   * 과거 방향 페이징(`events.query`). beforeSeq 미만 중 최신 limit 건을 골라 **오름차순**으로 돌려준다.
   * 다음 페이지는 반환된 첫 건의 seq 를 beforeSeq 로.
   */
  eventsQuery(input: EventsQueryInput): OfficeEvent[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (input.departmentId !== undefined) {
      where.push('department_id = ?');
      params.push(input.departmentId);
    }
    if (input.teamId !== undefined) {
      where.push('team_id = ?');
      params.push(input.teamId);
    }
    if (input.memberId !== undefined) {
      where.push('member_id = ?');
      params.push(input.memberId);
    }
    if (input.beforeSeq !== undefined) {
      where.push('seq < ?');
      params.push(input.beforeSeq);
    }
    const limit = input.limit ?? 200;
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as Row[];
    return rows.reverse().map(rowToEvent);
  }

  /** 지금까지 발급된 최대 seq. 삭제된 이벤트가 있어도 되돌아가지 않는다(sqlite_sequence). */
  lastSeq(): number {
    const r = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as Row | undefined;
    return r ? toNum(r.seq as number) : 0;
  }

  /**
   * 보존 정리 한 판(T30/D-39). 기동 때 한 번 + 하루에 한 번 Office 가 부른다.
   *   events  부서당 최신 `keepPerTeam` 건만
   *   pending 닫힌 행(answered/expired) 중 `pendingDays` 일보다 오래된 것
   *   tasks   끝난 행(reported/aborted) 중 `taskDays` 일보다 오래된 것
   * 열린 행(`open` pending, `queued`/`assigned` task)은 아무리 오래돼도 지우지 않는다 — 그건 이력이 아니라 상태다.
   */
  pruneRetention(opts: RetentionOptions = {}): RetentionResult {
    const now = opts.now ?? Date.now();
    return {
      events: this.pruneEvents({ keepPerTeam: opts.keepPerTeam ?? DEFAULT_RETENTION.keepPerTeam }),
      pending: this.prunePending(opts.pendingDays ?? DEFAULT_RETENTION.pendingDays, now),
      tasks: this.pruneTasks(opts.taskDays ?? DEFAULT_RETENTION.taskDays, now),
    };
  }

  /** 닫힌 pending(answered/expired) 중 `days` 일보다 오래된 행을 지운다. 삭제 건수 반환. */
  prunePending(days: number = DEFAULT_RETENTION.pendingDays, now: number = Date.now()): number {
    if (!(days > 0)) return 0;
    const res = this.db
      .prepare(
        `DELETE FROM pending
           WHERE status IN ('answered','expired')
             AND COALESCE(answered_at, created_at) < ?`,
      )
      .run(cutoffIso(days, now));
    return toNum(res.changes);
  }

  /** 끝난 task(reported/aborted) 중 `days` 일보다 오래된 행을 지운다. 삭제 건수 반환. */
  pruneTasks(days: number = DEFAULT_RETENTION.taskDays, now: number = Date.now()): number {
    if (!(days > 0)) return 0;
    const res = this.db
      .prepare("DELETE FROM tasks WHERE status IN ('reported','aborted') AND updated_at < ?")
      .run(cutoffIso(days, now));
    return toNum(res.changes);
  }

  /** 부서당 최신 keepPerTeam 건만 남기고 삭제(T34 부터 파티션이 부서다). 삭제 건수 반환. */
  pruneEvents(opts: { keepPerTeam: number } = { keepPerTeam: DEFAULT_RETENTION.keepPerTeam }): number {
    const res = this.db
      .prepare(
        `DELETE FROM events WHERE seq IN (
           SELECT seq FROM (
             SELECT seq, ROW_NUMBER() OVER (PARTITION BY department_id ORDER BY seq DESC) AS rn FROM events
           ) WHERE rn > ?
         )`,
      )
      .run(opts.keepPerTeam);
    return toNum(res.changes);
  }

  // ---- pending --------------------------------------------------------------

  createPending(input: CreatePendingInput): Pending {
    const id = input.id ?? newId(input.type === 'approval' ? 'a' : 'q');
    this.db
      .prepare('INSERT INTO pending(id, member_id, type, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.memberId, input.type, JSON.stringify(input.payload ?? {}), 'open', nowIso());
    return this.getPending(id)!;
  }

  getPending(id: string): Pending | undefined {
    const r = this.db.prepare('SELECT * FROM pending WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToPending(r) : undefined;
  }

  listOpenPending(memberId?: string): Pending[] {
    const rows = memberId
      ? (this.db
          .prepare("SELECT * FROM pending WHERE status = 'open' AND member_id = ? ORDER BY rowid")
          .all(memberId) as Row[])
      : (this.db.prepare("SELECT * FROM pending WHERE status = 'open' ORDER BY rowid").all() as Row[]);
    return rows.map(rowToPending);
  }

  /** open → answered. 이미 닫힌 건 변경하지 않고 현재 행을 돌려준다. */
  answerPending(id: string, answer: unknown): Pending | undefined {
    this.db
      .prepare("UPDATE pending SET status = 'answered', answer = ?, answered_at = ? WHERE id = ? AND status = 'open'")
      .run(JSON.stringify(answer ?? null), nowIso(), id);
    return this.getPending(id);
  }

  /** open → expired. */
  expirePending(id: string): Pending | undefined {
    this.db
      .prepare("UPDATE pending SET status = 'expired', answered_at = ? WHERE id = ? AND status = 'open'")
      .run(nowIso(), id);
    return this.getPending(id);
  }

  /** 그 멤버의 open pending 전부 expired (interrupt/fire/error 후처리). 만료된 행 반환. */
  expireAllForMember(memberId: string): Pending[] {
    return this.transaction(() => {
      const open = this.listOpenPending(memberId);
      if (open.length === 0) return [];
      this.db
        .prepare("UPDATE pending SET status = 'expired', answered_at = ? WHERE member_id = ? AND status = 'open'")
        .run(nowIso(), memberId);
      return open.map((p) => this.getPending(p.id)!);
    });
  }

  // ---- tasks ----------------------------------------------------------------

  createTask(input: CreateTaskInput): Task {
    const ts = nowIso();
    const res = this.db
      .prepare(
        `INSERT INTO tasks(department_id, from_member, to_member, instruction, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.departmentId, input.fromMember, input.toMember, input.instruction, input.status ?? 'queued', ts, ts);
    return this.getTask(toNum(res.lastInsertRowid))!;
  }

  getTask(id: number): Task | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToTask(r) : undefined;
  }

  updateTask(id: number, patch: UpdateTaskInput): Task | undefined {
    const { sets, params } = buildSet(patch as Record<string, unknown>, {
      fromMember: { col: 'from_member' },
      toMember: { col: 'to_member' },
      instruction: { col: 'instruction' },
      status: { col: 'status' },
      reportText: { col: 'report_text', encode: nullable },
      reportStatus: { col: 'report_status', encode: nullable },
    });
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(nowIso());
      this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return this.getTask(id);
  }

  listTasks(input: ListTasksInput = {}): Task[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (input.departmentId !== undefined) {
      where.push('department_id = ?');
      params.push(input.departmentId);
    }
    if (input.toMember !== undefined) {
      where.push('to_member = ?');
      params.push(input.toMember);
    }
    if (input.fromMember !== undefined) {
      where.push('from_member = ?');
      params.push(input.fromMember);
    }
    if (input.status !== undefined) {
      const statuses = Array.isArray(input.status) ? input.status : [input.status];
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ASC`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToTask);
  }

  /** memberId 가 발행한(delegate) 미종료 task. 보고 버퍼링의 "0이 되는 순간" 판정용. */
  openTasksIssuedBy(memberId: string): Task[] {
    return this.listTasks({ fromMember: memberId, status: OPEN_TASK_STATUSES });
  }

  /** memberId 에게 배정된 미종료 task 전부 aborted (interrupt/fire/error 후처리). 변경된 행 반환. */
  abortTasksFor(memberId: string): Task[] {
    return this.transaction(() => {
      const open = this.listTasks({ toMember: memberId, status: OPEN_TASK_STATUSES });
      if (open.length === 0) return [];
      const ts = nowIso();
      this.db
        .prepare(
          `UPDATE tasks SET status = 'aborted', report_status = 'aborted', updated_at = ?
           WHERE to_member = ? AND status IN ('queued', 'assigned')`,
        )
        .run(ts, memberId);
      return open.map((t) => this.getTask(t.id)!);
    });
  }

  // ---- snapshot -------------------------------------------------------------

  /** `hello` 응답용 스냅샷. seq 는 lastSeq — 클라이언트는 그보다 큰 event 만 적용한다. */
  snapshot(): Snapshot {
    return {
      seq: this.lastSeq(),
      departments: this.listDepartments(),
      teams: this.listTeams(),
      members: this.listMembers(),
      pending: this.listOpenPending(),
      tasks: this.listTasks({ status: OPEN_TASK_STATUSES }),
    };
  }
}
