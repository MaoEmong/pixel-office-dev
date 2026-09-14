// SQLite 영속 저장소. node:sqlite(DatabaseSync, D-08) 사용 — 네이티브 의존성 없음.
// 모든 API 는 동기. 파일 경로는 `${config.dataDir}/pixel-office.db`, 테스트는 ':memory:'.
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from '../config.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import type {
  AppendEventInput,
  CreateMemberInput,
  CreatePendingInput,
  CreateTaskInput,
  CreateTeamInput,
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

type Row = Record<string, unknown>;

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToTeam(r: Row): Team {
  return {
    id: r.id as string,
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
    teamId: r.team_id as string,
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
    teamId: r.team_id as string,
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
    teamId: r.team_id as string,
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

  private migrate(): void {
    this.db.exec(SCHEMA_SQL);
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as Row | undefined;
    if (!row) {
      this.db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(SCHEMA_VERSION);
      return;
    }
    const version = toNum(row.version as number);
    if (version > SCHEMA_VERSION) {
      throw new Error(`pixel-office.db schema_version ${version} is newer than supported ${SCHEMA_VERSION}`);
    }
    // version < SCHEMA_VERSION 인 경우의 마이그레이션 스텝은 버전이 올라갈 때 여기에 추가.
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

  // ---- teams ----------------------------------------------------------------

  createTeam(input: CreateTeamInput): Team {
    const id = input.id ?? newId('t');
    this.db
      .prepare(
        `INSERT INTO teams(id, name, cwd, leader_id, max_members, allowed_engines, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
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

  listTeams(): Team[] {
    return (this.db.prepare('SELECT * FROM teams ORDER BY rowid').all() as Row[]).map(rowToTeam);
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
        `INSERT INTO members(id, team_id, name, rank, engine, session_id, child_pid, cwd, status,
                             hired_by, member_token, instructions_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.teamId,
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

  updateMember(id: string, patch: UpdateMemberInput): Member | undefined {
    const { sets, params } = buildSet(patch as Record<string, unknown>, {
      name: { col: 'name' },
      rank: { col: 'rank' },
      engine: { col: 'engine' },
      sessionId: { col: 'session_id', encode: nullable },
      childPid: { col: 'child_pid', encode: nullable },
      cwd: { col: 'cwd' },
      status: { col: 'status' },
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

  /** 멤버 삭제. 그 멤버의 pending 은 cascade. tasks·events 는 남는다(이력). */
  deleteMember(id: string): boolean {
    const res = this.db.prepare('DELETE FROM members WHERE id = ?').run(id);
    return toNum(res.changes) > 0;
  }

  // ---- events ---------------------------------------------------------------

  appendEvent(input: AppendEventInput): OfficeEvent {
    const res = this.db
      .prepare('INSERT INTO events(ts, team_id, member_id, kind, detail, ref) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        input.ts ?? nowIso(),
        input.teamId,
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

  /** 팀당 최신 keepPerTeam 건만 남기고 삭제. 삭제 건수 반환. */
  pruneEvents(opts: { keepPerTeam: number } = { keepPerTeam: 50_000 }): number {
    const res = this.db
      .prepare(
        `DELETE FROM events WHERE seq IN (
           SELECT seq FROM (
             SELECT seq, ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY seq DESC) AS rn FROM events
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
        `INSERT INTO tasks(team_id, from_member, to_member, instruction, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.teamId, input.fromMember, input.toMember, input.instruction, input.status ?? 'queued', ts, ts);
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
    if (input.teamId !== undefined) {
      where.push('team_id = ?');
      params.push(input.teamId);
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
      teams: this.listTeams(),
      members: this.listMembers(),
      pending: this.listOpenPending(),
      tasks: this.listTasks({ status: OPEN_TASK_STATUSES }),
    };
  }
}
