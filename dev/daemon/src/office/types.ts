// Office 공개 타입. RpcServer 는 OfficeApi 인터페이스만 보고(테스트에서 가짜로 대체), Office 는 PtyManager /
// HookReceiver 를 구조적 인터페이스(PtyManagerLike / HookReceiverLike)로 받아 테스트에서 가짜를 꽂을 수 있다.
import type { EventEmitter } from 'node:events';
import type { ExitInfo, PtySession, SpawnOptions } from '../pty/types.js';
import type { HookReceiverEvents } from '../hooks/HookReceiver.js';
import type { ApprovalDecisionInput } from '../adapters/types.js';
import type { Engine, EventsQueryInput, Member, MemberStatus, OfficeEvent, Snapshot, Team } from '../store/types.js';

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

export interface CreateTeamParams {
  name: string;
  cwd: string;
  leaderEngine: Engine;
  maxMembers?: number;
  allowedEngines?: Engine[];
}

export interface ClockInParams {
  teamId: string;
  engine: Engine;
  name: string;
  instructions?: string;
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

/** `member.status` 알림의 파생 상태(01 §2 "멤버 표시 상태(파생)"). v1a: idle 이고 배정 task 없으면 free. */
export type DerivedStatus = MemberStatus | 'free' | 'waiting_reports';

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

  snapshot(): Snapshot;
  getMember(memberId: string): Member | undefined;
  eventsSince(seq: number): OfficeEvent[];
  eventsQuery(input: EventsQueryInput): OfficeEvent[];

  createTeam(params: CreateTeamParams): Team;
  deleteTeam(teamId: string): Promise<void>;

  clockIn(params: ClockInParams): Member;
  clockOut(memberId: string): Promise<void>;
  rehire(memberId: string): Promise<Member>;
  restart(memberId: string): Promise<Member>;
  instruct(memberId: string, text: string): number;
  typeRaw(memberId: string, data: string): void;
  attach(clientId: string, memberId: string, cols: number, rows: number): AttachResult;
  detach(clientId: string, memberId: string): void;
  /** 클라이언트 연결이 끊겼을 때. attach 전부 해제. */
  detachAll(clientId: string): void;
  resize(clientId: string, memberId: string, cols: number, rows: number): void;
  interrupt(memberId: string): void;
  getInstructions(memberId: string): string;
  setInstructions(memberId: string, markdown: string): void;

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
