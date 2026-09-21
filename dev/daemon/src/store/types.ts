// Store 의 공개 타입. 01-설계문서 §구성 요소 1(SQLite), §2 오피스 이벤트 스키마, §4 팀·직급 모델 기준.

export type Engine = 'claude' | 'codex';
/**
 * 직급 3단 트리(D-32 rev 3). `head` 부장 = 부서에 한 명, 사용자와 직접 말하는 유일한 직급.
 * `lead` 팀장 = 팀에 한 명, 부장의 자식. `member` 팀원 = 팀장의 자식.
 */
export type MemberRank = 'head' | 'lead' | 'member';
/** 부모 아래 직급(고용 체인 head → lead → member). undefined 면 더 못 내려간다. */
export const CHILD_RANK: Readonly<Record<MemberRank, MemberRank | undefined>> = {
  head: 'lead',
  lead: 'member',
  member: undefined,
};
/** 누가 출근시켰나. `'leader'` 는 "상위 멤버가 고용" 이라는 뜻(v1 값을 그대로 쓴다 — 마이그레이션 최소화). */
export type HiredBy = 'user' | 'leader';
/**
 * 멤버(캐릭터)의 raw 상태 = "CLI 프로세스가 지금 어떤가".
 *
 * `suspended`(잠시 닫힘, T46-1 · D-47)는 **데몬이 정상 종료하면서 접어 둔 세션**이다. 사용자 퇴근·상사 dismiss 의
 * `exited` 나 사고의 `error` 와 달리 **다음 기동에 말없이 되살린다**(수명주기.md §5) — 그래서 값이 따로 있다.
 * 되살아나는 동안만 잠깐 보이는 상태라 앱은 회색 + `(잠시 닫힘)` 로 그린다.
 */
export type MemberStatus =
  | 'starting'
  | 'idle'
  | 'working'
  | 'waiting_approval'
  | 'waiting_answer'
  | 'suspended'
  | 'exited'
  | 'error';

/** 오피스 이벤트 kind (엔진 중립). 설계문서 §2 표와 동일. */
export type OfficeEventKind =
  | 'thinking'
  | 'text'
  | 'reading'
  | 'editing'
  | 'running'
  | 'waiting_approval'
  | 'asking'
  | 'delegating'
  | 'reporting'
  | 'idle'
  | 'error';

export type PendingType = 'approval' | 'question';
export type PendingStatus = 'open' | 'answered' | 'expired';
export type TaskStatus = 'queued' | 'assigned' | 'reported' | 'aborted';
export type ReportStatus = 'done' | 'blocked' | 'aborted';

/** tasks.from_member / to_member 에 들어가는 값. 사용자 지시는 'user'. */
export const USER_ACTOR = 'user';

export interface Department {
  id: string;
  name: string;
  /** 부서 = 프로젝트. 이 부서의 팀·멤버는 모두 이 폴더에서 일한다(D-32). */
  cwd: string;
  /** 부장 memberId. 부장이 나가도 남는다 — "살아 있는 부장" 은 `Store.liveHead`. */
  headId: string | null;
  createdAt: string;
}

export interface Team {
  id: string;
  departmentId: string;
  name: string;
  /** 당분간 부서 cwd 와 같다(팀별 worktree 분리는 v2). */
  cwd: string;
  /** 팀장 memberId. 살아 있는 팀장은 `Store.liveLead`. */
  leaderId: string | null;
  maxMembers: number;
  allowedEngines: Engine[];
  createdAt: string;
}

export interface Member {
  id: string;
  departmentId: string;
  /** 부장은 팀에 속하지 않는다(null). 팀장·팀원은 자기 팀. */
  teamId: string | null;
  /** 트리 간선. 부장 null, 팀장 = 부장, 팀원 = 팀장. */
  parentId: string | null;
  name: string;
  rank: MemberRank;
  engine: Engine;
  sessionId: string | null;
  childPid: number | null;
  cwd: string;
  status: MemberStatus;
  hiredBy: HiredBy;
  memberToken: string;
  instructionsPath: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 이벤트 상세. 설계문서 §2 예시 키 + 자유 확장. */
export interface EventDetail {
  tool?: string;
  path?: string;
  cmd?: string;
  summary?: string;
  [key: string]: unknown;
}

/** 이벤트가 가리키는 pending/task 참조. */
export interface EventRef {
  approvalId?: string | null;
  questionId?: string | null;
  taskId?: number | null;
}

export interface OfficeEvent {
  /** 전역 단조 증가. 삭제·재시작 후에도 되돌아가지 않는다(AUTOINCREMENT). */
  seq: number;
  ts: string;
  departmentId: string;
  /** 그 멤버의 팀. 팀이 없는 부장의 이벤트는 `''`. */
  teamId: string;
  memberId: string;
  kind: OfficeEventKind;
  detail: EventDetail;
  ref: EventRef;
}

export interface Pending {
  id: string;
  memberId: string;
  type: PendingType;
  payload: Record<string, unknown>;
  status: PendingStatus;
  createdAt: string;
  answeredAt: string | null;
  answer: unknown | null;
}

export interface Task {
  id: number;
  departmentId: string;
  /** 'user' 또는 멤버 id. */
  fromMember: string;
  toMember: string;
  instruction: string;
  status: TaskStatus;
  reportText: string | null;
  reportStatus: ReportStatus | null;
  createdAt: string;
  updatedAt: string;
}

// ---- 입력 타입 -------------------------------------------------------------

export interface CreateDepartmentInput {
  id?: string;
  name: string;
  cwd: string;
  headId?: string | null;
}

export type UpdateDepartmentInput = Partial<Omit<Department, 'id' | 'createdAt'>>;

export interface CreateTeamInput {
  id?: string;
  departmentId: string;
  name: string;
  cwd: string;
  leaderId?: string | null;
  maxMembers?: number;
  allowedEngines?: Engine[];
}

export type UpdateTeamInput = Partial<Omit<Team, 'id' | 'departmentId' | 'createdAt'>>;

export interface CreateMemberInput {
  id?: string;
  departmentId: string;
  /** 부장은 생략(null). */
  teamId?: string | null;
  parentId?: string | null;
  name: string;
  rank: MemberRank;
  engine: Engine;
  cwd: string;
  hiredBy: HiredBy;
  status?: MemberStatus;
  sessionId?: string | null;
  childPid?: number | null;
  memberToken?: string;
  instructionsPath?: string | null;
}

export type UpdateMemberInput = Partial<Omit<Member, 'id' | 'departmentId' | 'createdAt' | 'updatedAt'>>;

export interface AppendEventInput {
  departmentId: string;
  /** 생략 시 `''`(팀 없는 부장). */
  teamId?: string | null;
  memberId: string;
  kind: OfficeEventKind;
  detail?: EventDetail;
  ref?: EventRef;
  /** 생략 시 현재 시각(ISO). */
  ts?: string;
}

export interface EventsQueryInput {
  departmentId?: string;
  teamId?: string;
  memberId?: string;
  /** 이 seq 미만(더 오래된) 이벤트만. 생략 시 최신부터. */
  beforeSeq?: number;
  limit?: number;
}

export interface CreatePendingInput {
  id?: string;
  memberId: string;
  type: PendingType;
  payload: Record<string, unknown>;
}

export interface CreateTaskInput {
  departmentId: string;
  fromMember: string;
  toMember: string;
  instruction: string;
  status?: TaskStatus;
}

export type UpdateTaskInput = Partial<Omit<Task, 'id' | 'departmentId' | 'createdAt' | 'updatedAt'>>;

export interface ListTasksInput {
  departmentId?: string;
  toMember?: string;
  fromMember?: string;
  status?: TaskStatus | TaskStatus[];
}

export interface Snapshot {
  /** 스냅샷 시점의 lastSeq. 클라이언트는 seq > 이 값만 적용한다. */
  seq: number;
  departments: Department[];
  teams: Team[];
  members: Member[];
  /** status='open' 만. */
  pending: Pending[];
  /** status in ('queued','assigned') 만. */
  tasks: Task[];
}
