// Office 공개 타입. RpcServer 는 OfficeApi 인터페이스만 보고(테스트에서 가짜로 대체), Office 는 PtyManager /
// HookReceiver 를 구조적 인터페이스(PtyManagerLike / HookReceiverLike)로 받아 테스트에서 가짜를 꽂을 수 있다.
import type { EventEmitter } from 'node:events';
import type { ExitInfo, PtySession, SpawnOptions } from '../pty/types.js';
import type { HookReceiverEvents } from '../hooks/HookReceiver.js';
import type { ApprovalDecisionInput } from '../adapters/types.js';
import type {
  Department,
  Engine,
  EventsQueryInput,
  HiredBy,
  Member,
  MemberRank,
  MemberStatus,
  OfficeEvent,
  ReportStatus,
  Snapshot,
  Team,
} from '../store/types.js';

// ---- 데몬 기록 파일 ----------------------------------------------------------

/** `${dataDir}/daemon.json`. 클라이언트가 읽어 접속·인증한다(PROTOCOL.md 인증). */
export interface DaemonInfo {
  wsPort: number;
  hookPort: number;
  /** TeamTools MCP(Streamable HTTP) 포트(T17). CLI 세션의 mcp.json 이 이 포트를 가리킨다. */
  mcpPort: number;
  token: string;
  pid: number;
  startedAt: string;
  version: string;
}

// ---- RPC 파라미터 ------------------------------------------------------------

/** `department.create` — 사용자가 하는 유일한 생성(D-32). 부장이 자동 출근한다. */
export interface CreateDepartmentParams {
  name: string;
  /** 부서 = 프로젝트 폴더. 존재하는 디렉토리여야 한다. */
  cwd: string;
  headEngine: Engine;
  /** 자동 출근하는 부장의 이름. 기본 '부장'. */
  headName?: string;
}

export interface CreateDepartmentResult {
  department: Department;
  head: Member;
}

/** `team.create`(T34 부터 **디버그 전용** RPC — 실제 경로는 T35 의 부장 도구 `create_team`). */
export interface CreateTeamParams {
  departmentId: string;
  name: string;
  /** 자동 출근하는 팀장의 엔진. 생략하면 부장과 같은 엔진. */
  leadEngine?: Engine;
  /** 자동 출근하는 팀장의 이름. 기본 '팀장'. */
  leadName?: string;
  /** 자동 출근하는 팀장의 INSTRUCTIONS.md 초안(T35 `create_team` 의 `instructions`). 없으면 기본 팀장 템플릿. */
  leadInstructions?: string;
  maxMembers?: number;
  allowedEngines?: Engine[];
}

/** `team.create` 결과 — 팀과 **자동 출근한 팀장**(부장의 자식). */
export interface CreateTeamResult {
  team: Team;
  lead: Member;
}

/**
 * 트리의 **유일한 스폰 경로**(T34). `department.create`(부장) · 팀 생성(팀장) · `hire`(팀원)가 전부 여기로 들어온다.
 * 직급 사슬(head → lead → member)과 팀 정원은 이 한 곳에서 강제한다.
 */
export interface HireChildParams {
  /** 부모 memberId. 부장(rank 'head')만 null/생략. */
  parentId?: string | null;
  /** rank 'head' 일 때 필수(부모가 없으므로 부서를 직접 준다). */
  departmentId?: string;
  /** rank 'lead' 일 때 필수(그 팀장이 맡을 팀). 팀원은 부모의 팀을 쓴다. */
  teamId?: string;
  name: string;
  rank: MemberRank;
  engine: Engine;
  /** INSTRUCTIONS.md 본문. `role` 이 있으면 `# 역할: <role>` 아래에 붙는다. */
  instructions?: string;
  /** 지시문 첫 줄 `# 역할: <role>`(TeamTools `hire` 가 쓴다). */
  role?: string;
  /** 기본 'leader'(상위 멤버가 고용). 사용자가 직접 출근시키면 'user'. */
  hiredBy?: HiredBy;
}

/** `member.clockIn`(T34 부터 디버그 전용). 부모를 주면 직급이 사슬에서 정해진다. */
export interface ClockInParams {
  parentId?: string | null;
  departmentId?: string;
  teamId?: string;
  engine: Engine;
  name: string;
  instructions?: string;
  /** 생략하면 부모 직급의 아래 직급(head → lead → member). */
  rank?: MemberRank;
}

/** 팀장의 TeamTools `hire`(T25) 용 입력. `hireChild` 의 얇은 래퍼. */
export interface HireByLeaderParams {
  /** 고용하는 팀장의 memberId. 이 멤버가 살아 있는 팀장이어야 한다. */
  leaderId: string;
  engine: Engine;
  name: string;
  instructions?: string;
}

/** `member.instruct` 옵션. `force` 는 "부장에게만 지시" 게이트를 넘는 디버그 탈출구. */
export interface InstructOptions {
  force?: boolean;
}

// ---- TeamTools 오케스트레이션(T25) — RPC 가 아니라 MCP 도구가 부르는 Office 메서드의 입력 -----------

/** TeamTools `hire` 입력. `role` 은 그 팀원 지시문의 첫 줄(`# 역할: <role>`)이 된다. */
export interface TeamHireInput {
  name: string;
  role: string;
  /** 생략하면 팀 기본(팀장과 같은 엔진 → claude → 팀 허용 목록 첫 번째). */
  engine?: Engine;
  /** 역할 줄 아래에 붙는 지시문 초안. */
  instructions?: string;
}

/** TeamTools `create_team` 입력(부장, T35). 부서는 부르는 부장의 부서로 정해진다. */
export interface TeamCreateTeamInput {
  name: string;
  /** 자동 출근하는 팀장의 이름(필수 — 부장이 직접 짓는다). */
  leadName: string;
  /** 팀장 엔진. 생략하면 부장과 같은 엔진. */
  engine?: Engine;
  /** 팀장의 INSTRUCTIONS.md 초안. */
  instructions?: string;
}

/** TeamTools `reply` 입력(부장·팀장, T35). 대상은 살아 있는 직속 부하. */
export interface TeamReplyInput {
  toMember: string;
  text: string;
}

/** `reply` 결과 — 열린 `ask_parent` 를 닫았으면 그 questionId 가 있다. */
export interface TeamReplyResult {
  to: Member;
  /** 답으로 닫힌 ask_parent pending id. 없으면 그냥 `[MESSAGE from …]` 로 들어갔다. */
  questionId?: string;
}

/** `ask_parent` pending 의 payload(T35). `ask_user` 와 같은 모양 + 트리 간선(from/to). */
export interface AskParentPayload {
  source: 'ask_parent';
  question: string;
  options: string[];
  /** 물은 멤버(= pending 의 memberId 와 같다. 콘솔·앱이 payload 만 보고도 알 수 있게 싣는다). */
  from: string;
  /** 답할 직속 상사 memberId. */
  to: string;
}

/** TeamTools `report` 입력. `taskId` 는 그 멤버에게 배정된 task 여야 한다. */
export interface TeamReportInput {
  taskId: number;
  summary: string;
  files?: string[];
  status: ReportStatus;
}

/** 팀장에게 올라갈 보고 한 건(버퍼의 원소). `body` = summary(+ `파일:` 줄). */
export interface ReportLine {
  taskId: number;
  /** 보고한 팀원 이름. */
  name: string;
  status: ReportStatus;
  body: string;
}

export interface AttachResult {
  /** ScreenModel.serialize() — ANSI, 스크롤백 포함. 새 xterm 에 그대로 write 하면 같은 화면. */
  screen: string;
  cols: number;
  rows: number;
}

export interface ApprovalRespondParams extends ApprovalDecisionInput {
  /** 이번 세션 동안 같은 도구의 허가 요청을 자동 allow(멤버 단위, 데몬 메모리에만). */
  alwaysThisSession?: boolean;
}

/** TeamTools `ask_user` 입력(T17). */
export interface AskUserParams {
  question: string;
  options?: string[];
}

/** `ask_user` pending 의 payload 모양(D-19: `tool_input` 이 없어야 재시작 시 유효한 질문으로 남는다). */
export interface AskUserPayload {
  source: 'ask_user';
  question: string;
  options: string[];
}

/** `member.status` 알림의 파생 상태(01 §2 "멤버 표시 상태(파생)"). 규칙은 office/derived.ts 하나에 있다(T28). */
export type DerivedStatus = MemberStatus | 'free' | 'waiting_reports';

/** 스냅샷의 멤버 행 = Member + 그 시점의 파생 상태(T28). 클라이언트는 이걸 그대로 쓰면 된다. */
export interface SnapshotMember extends Member {
  derived: DerivedStatus;
}

/** `hello` 가 돌려주는 스냅샷. store 의 Snapshot 과 같고 멤버 행에 `derived` 가 더 있다. */
export interface OfficeSnapshot extends Omit<Snapshot, 'members'> {
  members: SnapshotMember[];
}

/** 콘솔 `tree` · 앱(T37)이 쓰는 부서 트리 한 그루. */
export interface DepartmentTree {
  department: Department;
  head?: SnapshotMember;
  teams: Array<{ team: Team; lead?: SnapshotMember; members: SnapshotMember[] }>;
  /** 어느 팀에도 속하지 않는 부장 이외의 멤버(있으면 안 되지만 디버그 경로로 생길 수 있다). */
  orphans: SnapshotMember[];
}

export type NoticeLevel = 'info' | 'warn' | 'error';

// ---- Office 이벤트 -------------------------------------------------------------

export type OfficeEvents = {
  /** store 에 적힌 오피스 이벤트(seq 포함) → `event` 알림(전 클라이언트). */
  event: [event: OfficeEvent];
  /** 멤버 status 변경 → `member.status` 알림. */
  status: [memberId: string, status: MemberStatus, derived: DerivedStatus];
  /** pty 출력 → `term` 알림(attach 한 클라이언트만). */
  term: [memberId: string, data: string];
  /** 사용자에게 보여줄 데몬 알림 → `daemon.notice`. */
  notice: [level: NoticeLevel, message: string];
  /**
   * 트리 **모양**이 바뀌었다(부서·팀 생성/삭제, T38) → RpcServer 가 `snapshot` 알림을 민다.
   * 멤버 행의 생멸은 `member.status` 가 알리지만 부서·팀 행의 생멸을 알리는 알림은 없어서,
   * 다른 클라이언트가 재접속할 때까지 지운 부서·팀이 화면에 남아 있었다(T37 함정 ①).
   * `reason` 은 로그·테스트용 꼬리표다.
   */
  tree: [reason: 'department.create' | 'department.delete' | 'team.create' | 'team.delete'];
  /** shutdown() 완료. */
  shutdown: [];
};

// ---- RpcServer 가 보는 Office ------------------------------------------------------

/** RpcServer 가 의존하는 Office 의 부분. 테스트에서는 이 인터페이스의 가짜를 넣는다. */
export interface OfficeApi extends EventEmitter<OfficeEvents> {
  /** 이번 기동의 인증 토큰(daemon.json 과 동일). */
  readonly token: string;
  readonly version: string;
  readonly pid: number;

  /** 멤버 행에 `derived`(파생 상태)가 실려 있다(T28, PROTOCOL.md `snapshot`). */
  snapshot(): OfficeSnapshot;
  getMember(memberId: string): Member | undefined;
  eventsSince(seq: number): OfficeEvent[];
  eventsQuery(input: EventsQueryInput): OfficeEvent[];

  /** 부서 생성 + 부장 자동 출근(T34, D-32). 사용자가 하는 유일한 생성. */
  createDepartment(params: CreateDepartmentParams): CreateDepartmentResult;
  /** 부서 하위 트리 전체(팀·팀장·팀원)를 정리하고 삭제한다. 부장이 마지막. */
  deleteDepartment(departmentId: string): Promise<void>;
  /** 부서 트리(콘솔 `tree`·앱). */
  tree(): DepartmentTree[];

  /** 팀 생성 + 팀장 자동 출근. T34 부터 RPC 로는 디버그 전용(`force:true`). */
  createTeam(params: CreateTeamParams): CreateTeamResult;
  deleteTeam(teamId: string): Promise<void>;

  /** 트리의 단일 스폰 경로. 직급 사슬·정원은 여기서 강제한다(T34). */
  hireChild(params: HireChildParams): Member;
  clockIn(params: ClockInParams): Member;
  clockOut(memberId: string): Promise<void>;
  rehire(memberId: string): Promise<Member>;
  restart(memberId: string): Promise<Member>;
  /** 부서에 살아 있는 부장이 있으면 부장 외 지시는 -32004 — `opts.force` 로만 넘는다(T34). */
  instruct(memberId: string, text: string, opts?: InstructOptions): number;
  typeRaw(memberId: string, data: string): void;
  attach(clientId: string, memberId: string, cols: number, rows: number): AttachResult;
  detach(clientId: string, memberId: string): void;
  /** 클라이언트 연결이 끊겼을 때. attach 전부 해제. */
  detachAll(clientId: string): void;
  resize(clientId: string, memberId: string, cols: number, rows: number): void;
  interrupt(memberId: string): void;
  /** 사용자 INSTRUCTIONS.md 본문만(없으면 `""`). */
  getInstructions(memberId: string): string;
  setInstructions(memberId: string, markdown: string): void;
  /** SessionStart 에 실제로 주입되는 텍스트 = 런타임 프리앰블 + 유효 지시문(사용자 파일 또는 기본 템플릿, T26b). */
  buildSessionContext(memberId: string): string;

  respondApproval(pendingId: string, decision: ApprovalRespondParams): void;
  /** TUI AskUserQuestion 은 hook 결정으로, TeamTools ask_user 는 `[ANSWER q#<id>]` 큐 주입으로(T17). */
  respondQuestion(pendingId: string, answers: Record<string, string>): void;

  shutdown(): Promise<void>;
}

// ---- Office 가 받는 의존성 ----------------------------------------------------------

/** PtyManager 의 부분집합(테스트 가짜용). */
export interface PtyManagerLike {
  spawn(opts: SpawnOptions): PtySession;
  get(memberId: string): PtySession | undefined;
  list(): PtySession[];
  kill(memberId: string, opts?: { graceful?: boolean; timeoutMs?: number }): Promise<void>;
  on(event: 'data', listener: (memberId: string, chunk: string) => void): this;
  on(event: 'exit', listener: (memberId: string, info: ExitInfo) => void): this;
  on(event: 'warn', listener: (memberId: string, message: string) => void): this;
}

/** TeamToolsServer 의 부분집합(테스트 가짜용). */
export interface TeamToolsServerLike {
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
  /** 멤버 퇴근·종료 시 그 토큰의 연결을 끊는다. */
  dispose(memberToken: string): void;
  readonly port: number;
}

/** HookReceiver 의 부분집합(테스트 가짜용). */
export interface HookReceiverLike {
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
  readonly port: number;
  on(event: 'hook', listener: (...args: HookReceiverEvents['hook']) => void): this;
  on(event: 'hold-timeout' | 'hold-closed', listener: (...args: HookReceiverEvents['hold-timeout']) => void): this;
  on(event: 'bad-payload', listener: (...args: HookReceiverEvents['bad-payload']) => void): this;
  on(event: 'handler-error', listener: (...args: HookReceiverEvents['handler-error']) => void): this;
}
