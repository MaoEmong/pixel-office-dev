// Store 의 공개 타입. 01-설계문서 §구성 요소 1(SQLite), §2 오피스 이벤트 스키마, §4 팀·직급 모델 기준.

export type Engine = 'claude' | 'codex';
export type MemberRank = 'leader' | 'member';
export type HiredBy = 'user' | 'leader';
export type MemberStatus =
  | 'starting'
  | 'idle'
  | 'working'
  | 'waiting_approval'
  | 'waiting_answer'
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

export interface Team {
  id: string;
  name: string;
  cwd: string;
  leaderId: string | null;
  maxMembers: number;
  allowedEngines: Engine[];
  createdAt: string;
}

export interface Member {
  id: string;
  teamId: string;
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
  teamId: string;
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

export interface CreateTeamInput {
  id?: string;
  name: string;
  cwd: string;
  leaderId?: string | null;
  maxMembers?: number;
  allowedEngines?: Engine[];
}

export type UpdateTeamInput = Partial<Omit<Team, 'id' | 'createdAt'>>;

export interface CreateMemberInput {
  id?: string;
  teamId: string;
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

export type UpdateMemberInput = Partial<Omit<Member, 'id' | 'teamId' | 'createdAt' | 'updatedAt'>>;

export interface AppendEventInput {
  teamId: string;
  memberId: string;
  kind: OfficeEventKind;
  detail?: EventDetail;
  ref?: EventRef;
  /** 생략 시 현재 시각(ISO). */
  ts?: string;
}

export interface EventsQueryInput {
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
  teamId: string;
  fromMember: string;
  toMember: string;
  instruction: string;
  status?: TaskStatus;
}

export type UpdateTaskInput = Partial<Omit<Task, 'id' | 'teamId' | 'createdAt' | 'updatedAt'>>;

export interface ListTasksInput {
  teamId?: string;
  toMember?: string;
  fromMember?: string;
  status?: TaskStatus | TaskStatus[];
}

export interface Snapshot {
  /** 스냅샷 시점의 lastSeq. 클라이언트는 seq > 이 값만 적용한다. */
  seq: number;
  teams: Team[];
  members: Member[];
  /** status='open' 만. */
  pending: Pending[];
  /** status in ('queued','assigned') 만. */
  tasks: Task[];
}
