// Office — 데몬 하나에 하나. Store(T06)·PtyManager(T01)·HookReceiver(T03)·엔진별 hook 어댑터(T04 Claude / T20 Codex)를 소유하고,
// 멤버마다 ScreenModel(T02)·InputQueue(T05)를 붙여 "출근 → 지시 → 허가/질문 → 퇴근" 을 한 객체의 메서드로 만든다.
// RpcServer(T07)는 OfficeApi 인터페이스만 보고 JSON-RPC 로 옮긴다(PROTOCOL.md). 설계: 01 §구성 요소 1.
//
// 배선(설계 §구성 요소 1 + 각 worklog 의 "남은 것"):
//   HookReceiver 'hook'           → store.getMemberByToken → adapterFor(member.engine).handleHook (T20)
//   HookReceiver 'hold-timeout'   → adapter.onHoldTimeout   / 'hold-closed' → adapter.onHoldClosed
//   PtyManager  'data'            → ScreenModel.feed + 'term' 이벤트(attach 한 클라이언트)
//   PtyManager  'exit'            → adapter.onSessionExit(예상 못 한 종료) / status exited(퇴근·재시작·셧다운)
//   adapter     'event'/'status'  → 'event' / 'status' 이벤트(전 클라이언트)
//   InputQueue  isIdle            = member.status === 'idle' ∧ 열린 pending 없음
//   InputQueue  'dialogBlocked'   → daemon.notice{warn} (자동 통과 불가 다이얼로그 = CLI 허가 프롬프트, D-26 T23b)
//   화면 감시                      watchBootReady(Codex 부팅 D-24) / watchInterrupted(Ctrl+C) / watchScreenIdle(턴 종료 hook 없음 D-25)
//   TeamToolsServer(T17) ask_user  → askUser(): pending(question, source:'ask_user') + asking + waiting_answer
//   respondQuestion(ask_user)     → answerPending(게이트 해제) → 큐에 `[ANSWER q#<id>]\n<답>`(system) — 답이 열린 pending 을
//                                   먼저 닫으므로 isIdle 게이트를 그대로 통과한다(bypass 플래그 없음, 아래 answerAskUser)
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import pkg from '../../package.json' with { type: 'json' };
import { config as defaultConfig, type Config } from '../config.js';
import { Store, type RetentionResult } from '../store/Store.js';
import { PtyManager } from '../pty/PtyManager.js';
import { toForwardSlashes } from '../pty/hookSettings.js';
import type { ExitInfo, PtySession } from '../pty/types.js';
import { HookReceiver } from '../hooks/HookReceiver.js';
import type { BaseHooksAdapter } from '../adapters/BaseHooksAdapter.js';
import type { AdapterDeps, ToolGateContext } from '../adapters/types.js';
import { ClaudeHooksAdapter } from '../adapters/ClaudeHooksAdapter.js';
import { CodexHooksAdapter } from '../adapters/CodexHooksAdapter.js';
import { ScreenModel } from '../screen/ScreenModel.js';
import { InputQueue } from '../input/InputQueue.js';
import { UsageTracker } from '../usage/UsageTracker.js';
import { ALL_TEAM_TOOLS, TeamToolsServer, TEAM_MCP_NAME, canUseTool, rankToolMessage, type TeamToolName } from '../mcp/TeamToolsServer.js';
import { CHILD_RANK, USER_ACTOR } from '../store/types.js';
import type {
  Department,
  Engine,
  EventsQueryInput,
  HiredBy,
  Member,
  MemberRank,
  MemberStatus,
  OfficeEvent,
  Pending,
  Snapshot,
  Task,
  TaskStatus,
  Team,
} from '../store/types.js';
import { OfficeError, RPC_ERROR, badState, invalidParams, notFound } from './errors.js';
// T28: 공통 후처리(interrupt/퇴근/종료/재시작/팀 삭제/복구)와 파생 상태는 각각 한 파일에 모여 있다.
import { settleMember, type SettleCtx, type SettleReason, type SettleSummary } from './afterCare.js';
import { derivedStatus } from './derived.js';
import { CODEX_FALLBACK, detectQuestion, isFallbackQuestion, type FallbackQuestionPayload } from './codexFallback.js';
import { defaultOrphanOps, reapOrphan, type OrphanOps } from './orphans.js';
import { assertSingleDaemon, bindOrRefuse, defaultSingletonProbe, type SingletonProbe } from './singleton.js';
import { ShellMutex, shellLockCommand, type ShellLockInfo } from './ShellMutex.js';
import { RANK_LABEL, defaultInstructions, type TemplateScope } from './instructions/templates.js';
import { buildSessionContext, type RosterEntry } from './instructions/context.js';
import type {
  ApprovalRespondParams,
  AskParentPayload,
  AskUserParams,
  AskUserPayload,
  AttachResult,
  ClockInParams,
  CreateDepartmentParams,
  CreateDepartmentResult,
  CreateTeamParams,
  CreateTeamResult,
  DaemonInfo,
  DepartmentTree,
  DerivedStatus,
  HireByLeaderParams,
  HireChildParams,
  HookReceiverLike,
  InstructOptions,
  NoticeLevel,
  OfficeApi,
  OfficeEvents,
  OfficeSnapshot,
  PtyManagerLike,
  ReportLine,
  TeamCreateTeamInput,
  TeamHireInput,
  TeamReplyInput,
  TeamReplyResult,
  TeamReportInput,
  TeamToolsServerLike,
} from './types.js';

export type * from './types.js';
export { OfficeError, RPC_ERROR } from './errors.js';

/** `member.restart` 직후 큐에 넣는 시스템 메시지(01 §데몬 재시작 복구). 데몬 재시작 복구는 `buildResumedText` 로 task·이벤트 요약을 붙인다(T09). */
export const RESUMED_TEXT = '[RESUMED] 데몬이 세션을 재시작했다. 현재 상태를 점검하고 이어서 진행하라.';
/** 데몬 재시작 복구(T09)에서 되살린 멤버를 대상으로 하는 status. exited/error 는 손대지 않는다. */
export const RECOVERABLE: ReadonlySet<MemberStatus> = new Set(['starting', 'idle', 'working', 'waiting_approval', 'waiting_answer']);
/** `--resume` 직후 이 시간 안에 0 이 아닌 코드로 죽으면 "세션 없음" 증상으로 보고 새 세션으로 한 번 폴백한다(T07 남은 것). */
export const RESUME_FALLBACK_WINDOW_MS = 10_000;
/** [RESUMED] 에 싣는 마지막 이벤트 수·instruction 글자 수·이벤트 요약 글자 수. */
const RESUMED_EVENT_COUNT = 5;
const RESUMED_INSTRUCTION_CHARS = 80;
const RESUMED_SUMMARY_CHARS = 60;
/** 종료된 것으로 보는 멤버 status. */
const GONE: ReadonlySet<MemberStatus> = new Set(['exited', 'error']);
/**
 * 트리 깊이(잎이 0). 정리는 **작은 쪽부터**(팀원 → 팀장 → 부장, `settleOrder`), 복구는 **큰 쪽부터**
 * (부장 → 팀장 → 팀원, `recoverOrder`). 두 순서가 같은 상수를 본다.
 */
const RANK_DEPTH: Record<MemberRank, number> = { member: 0, lead: 1, head: 2 };
/** 미종료 task(= 아직 보고를 기다리는 것). 파생 상태·dismiss 검사·보고 버퍼 판정이 같은 집합을 본다. */
const OPEN_TASKS: TaskStatus[] = ['queued', 'assigned'];
/** `department.create` 가 `headName` 없이 올 때 부장에게 붙는 기본 이름(T34). */
export const DEFAULT_HEAD_NAME = '부장';
/** 팀 정원 기본값(store 의 teams.max_members DEFAULT 와 같은 값). 팀 없는 부장의 템플릿 문장에도 쓴다. */
export const DEFAULT_MAX_MEMBERS = 4;
/** `team.create` 가 `leadName` 없이 올 때 팀장에게 붙는 기본 이름(T24 → T34). */
export const DEFAULT_LEAD_NAME = '팀장';
/** T24 이름 그대로 쓰던 곳을 위한 별칭. */
export const DEFAULT_LEADER_NAME = DEFAULT_LEAD_NAME;
/** "부장에게만 지시" 게이트(-32004)의 문구. PROTOCOL.md 와 같은 문자열이어야 한다(T34, D-32). */
export const headOnlyMessage = (headName: string) => `부장에게만 지시할 수 있습니다 (head: ${headName})`;
/** Ctrl+C 를 두 번 연달아 보내면 Claude 가 종료되므로(T05 함정) 이 간격 안의 두 번째 interrupt 는 거절. */
const INTERRUPT_GUARD_MS = 1500;
/** interrupt 후 화면 준비 문구로 idle 을 판정하는 감시 시간·주기(실측: Ctrl+C 에는 Stop hook 이 없다). */
const INTERRUPT_WATCH_MS = 8000;
const INTERRUPT_WATCH_STEP_MS = 250;
/**
 * Codex 부팅 감시(T20 실측). Claude 는 기동하자마자 `SessionStart` hook 을 보내지만 **Codex 는 첫 프롬프트를 제출할 때**
 * 보낸다(dev/spike-0/run-codex6.log: spawn 09:47:00 → 프롬프트 입력 09:47:08.6 → SessionStart 09:47:09.4).
 * 그래서 hook 만 기다리면 status 가 starting 에 머물고 InputQueue 의 isIdle 게이트가 안 열려 **첫 지시가 영영 안 나간다.**
 * → 화면이 prompt ready 가 되면(다이얼로그 없음) idle 로 올린다. 그 사이 SessionStart 가 오면 감시를 멈춘다.
 */
const BOOT_WATCH_MS = 180_000;
const BOOT_WATCH_STEP_MS = 500;
/**
 * 화면 기반 idle 폴백(T23b, D-25). 턴 종료 hook 없이 프롬프트로 돌아오는 화면이 있다 — Codex 사용량 한도 안내(T23 함정 1)가
 * 대표적이고, Claude 도 턴이 이상하게 끊기면 `Stop` 이 안 온다. 그러면 멤버가 `working` 에 갇혀 사무실 표시가 틀리고
 * InputQueue 의 isIdle 게이트가 안 열려 다음 지시가 큐에 머문다.
 * → `watchBootReady` 와 같은 모양으로 화면을 본다: 열린 pending 이 없고 화면이 계속 prompt ready(다이얼로그 없음·busy 아님)인
 *   상태가 IDLE_SCREEN_STABLE_MS 동안 이어지고 그 사이 새 hook 이 없으면 `idle{summary:'screen-idle'}`.
 * 보류(허가·질문)가 열려 있거나 busy 표시가 있으면 절대 발화하지 않는다.
 */
const IDLE_SCREEN_STABLE_MS = 3000;
const IDLE_SCREEN_STEP_MS = 500;
/** 화면 기반 idle 폴백이 붙는 status(진행 중으로 표시되지만 턴 종료 hook 을 기다리는 상태). */
const IDLE_SCREEN_STATUSES: ReadonlySet<MemberStatus> = new Set(['working', 'waiting_approval', 'waiting_answer']);
/** 화면 기반 idle 폴백이 남기는 요약(PROTOCOL.md "데몬이 만드는 이벤트"). */
export const SCREEN_IDLE_SUMMARY = 'screen-idle';
/** 정중한 종료 대기(Claude `/exit`). */
const KILL_TIMEOUT_MS = 8000;
/** 보존 정리 주기(T30/D-39). 기동 때 한 번 + 하루에 한 번. */
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const COLS_RANGE = [20, 500] as const;
const ROWS_RANGE = [5, 300] as const;

export interface OfficeOptions {
  /** config.ts 기본값 위에 덮어쓴다(테스트 격리·임시 포트). */
  config?: Partial<Config>;
  /** 생략 시 `${dataDir}/pixel-office.db`. 테스트는 `new Store(':memory:')`. */
  store?: Store;
  pty?: PtyManagerLike;
  receiver?: HookReceiverLike;
  /** TeamTools MCP 서버(T17). 생략 시 실제 TeamToolsServer 를 config.mcpPort 에 연다. */
  mcp?: TeamToolsServerLike;
  /** hook.js 절대 경로. 기본 src/hooks/hook.js. */
  hookScriptPath?: string;
  /** statusline.js 절대 경로(T43). 기본 src/hooks/statusline.js. */
  statusLineScriptPath?: string;
  /** 사용량 추적기(T43). 생략 시 store 를 물린 UsageTracker 를 만든다. */
  usage?: UsageTracker;
  version?: string;
  /** "데몬은 하나만" 가드(T30)의 pid·포트 확인 연산. 테스트가 가짜로 바꿔 끼운다. */
  singletonProbe?: SingletonProbe;
  /** 보존 정리 주기(ms). 기본 RETENTION_INTERVAL_MS(24h). 0 이면 타이머를 걸지 않는다. */
  retentionIntervalMs?: number;
  /** 재시작 복구 옵션(테스트용). */
  recovery?: {
    /** `--resume` 실패 판정 창(ms). 기본 RESUME_FALLBACK_WINDOW_MS. */
    fallbackWindowMs?: number;
    /** 유령 자식(child_pid) 확인·종료 연산. 기본 defaultOrphanOps(tasklist/taskkill). */
    orphanOps?: OrphanOps;
  };
}

/** `start()` 의 재시작 복구 결과(로그·notice·테스트용). */
export interface RecoveryResult {
  /** `--resume` 으로 다시 띄운 멤버 id. */
  resumed: string[];
  /** session_id 가 없거나 스폰에 실패해 error 로 둔 멤버 id. */
  failed: string[];
  /** 만료시킨 pending id(approval 전부 + TUI AskUserQuestion). */
  expired: string[];
  /** 큐에 다시 넣은 queued task id. */
  requeued: number[];
  /** 이전 데몬이 하드 킬돼 살아남은 자식 중 종료한 pid. */
  orphansKilled: number[];
}

/** 살아 있거나 마지막 화면을 들고 있는 멤버별 런타임. */
interface MemberRuntime {
  memberId: string;
  session: PtySession;
  screen: ScreenModel;
  queue: InputQueue;
  /** attach 한 클라이언트 id. */
  attached: Set<string>;
  /** 마지막으로 attach 한 클라이언트 — resize 는 이 클라이언트만 유효. */
  lastAttached?: string;
  /** Stop 의 last_assistant_message. v1a 에서는 이것이 task 의 report_text(01 §TeamTools "사용자 지시도 task"). */
  lastText?: string;
  /** 데몬이 의도한 종료면 exit 시 error 이벤트를 내지 않는다. */
  exitMode?: 'clockOut' | 'restart' | 'shutdown';
  lastInterruptAt?: number;
  interruptWatch?: NodeJS.Timeout;
  /** Codex 부팅 감시(SessionStart 가 늦게 오는 엔진용). */
  bootWatch?: NodeJS.Timeout;
  /** 화면 기반 idle 폴백 감시(T23b, D-25). 세션 내내 돈다. */
  idleWatch?: NodeJS.Timeout;
  /** 화면이 "조용한 prompt ready" 가 된 시각. 조건이 깨지면 undefined. */
  screenIdleSince?: number;
  /** 이 멤버의 마지막 hook 도착 시각(화면 기반 idle 폴백의 "그 사이 새 hook 없음" 판정). */
  lastHookAt?: number;
  /**
   * 이 멤버 세션의 기록 파일 경로(Claude transcript / Codex rollout). 모든 hook 페이로드와 statusLine 이
   * 같이 주므로 조립하지 않고 받아 둔다 — 턴 종료 때 꼬리를 읽어 사용량을 갱신한다(T43).
   */
  transcriptPath?: string;
  /**
   * 재시작 복구로 `--resume` 한 세션. 이 창 안에 0 이 아닌 코드로 죽으면(세션 파일 없음 증상) 새 세션으로 한 번 폴백하고
   * 같은 [RESUMED]·queued task 를 다시 큐에 넣는다.
   */
  resumeFallback?: { until: number; resumedText: string };
}

export class Office extends EventEmitter<OfficeEvents> implements OfficeApi {
  readonly cfg: Config;
  readonly version: string;
  readonly pid = process.pid;
  readonly token: string = randomBytes(32).toString('hex');
  readonly hookScriptPath: string;
  /** Claude 세션 설정에 넣는 statusLine 스크립트(T43). 사용량이 이 경로로 들어온다. */
  readonly statusLineScriptPath: string;
  /** 엔진·멤버 사용량(T43, D-45). 스냅샷 `usage` 와 `usage.*` 알림의 출처. */
  readonly usage: UsageTracker;

  readonly store: Store;
  readonly pty: PtyManagerLike;
  readonly receiver: HookReceiverLike;
  readonly mcp: TeamToolsServerLike;
  /** Claude 멤버의 hook 어댑터(T04). 엔진별 라우팅은 adapterFor(). */
  readonly adapter: ClaudeHooksAdapter;
  /** Codex 멤버의 hook 어댑터(T20). */
  readonly codexAdapter: CodexHooksAdapter;
  /** engine → 어댑터. hook·pending·종료 처리는 전부 이 표를 거친다. */
  private readonly adapters: Record<Engine, BaseHooksAdapter>;

  /** 팀 단위 셸 뮤텍스(T27). PreToolUse 게이트로 잡고 toolDone·후처리로 푼다. */
  readonly shell = new ShellMutex();

  private readonly runtimes = new Map<string, MemberRuntime>();
  /** `alwaysThisSession` 로 자동 allow 할 도구(멤버별, 데몬 메모리에만). */
  private readonly autoAllow = new Map<string, Set<string>>();
  /**
   * 입력 큐에 **이미 들어가 있는**(아직 flush 되지 않은) task id(T25). task 는 pty 에 들어갈 때까지 `queued` 라서
   * 유휴 감시(`dispatchQueuedTasks`)가 같은 task 를 두 번 넣을 수 있다 — 이 집합이 그걸 막는다.
   */
  private readonly inFlight = new Set<number>();
  /**
   * 팀장별 보고 버퍼(T25, 01 §TeamTools "보고는 버퍼링"). 팀원의 `report(done|aborted)` 를 모아 두고,
   * **그 팀장이 발행한 미종료 task 가 0 이 되는 순간** 한 덩어리 + `[ALL_REPORTS_IN]` 로 흘린다.
   * `blocked` 는 버퍼를 건너뛰고 즉시 단독 전달.
   */
  private readonly reportBuffer = new Map<string, ReportLine[]>();
  /** 멤버별로 마지막에 내보낸 파생 상태(T28). raw 는 그대로인데 파생만 바뀐 것을 알아채는 데 쓴다. */
  private readonly lastDerived = new Map<string, DerivedStatus>();
  /** 하위 트리 정리(T36)로 끝낸 부하 세션의 종료 대기. `drainChildExits()` 가 비운다. */
  private readonly childExits: Array<Promise<void>> = [];
  private readonly fallbackWindowMs: number;
  private readonly orphanOps: OrphanOps;
  private readonly singletonProbe: SingletonProbe;
  private readonly retentionIntervalMs: number;
  /** 보존 정리 일일 타이머(T30/D-39). unref 라 데몬 종료를 붙잡지 않는다. */
  private retentionTimer?: NodeJS.Timeout;
  private info?: DaemonInfo;
  private started = false;
  private stopping = false;
  /** 이번 기동의 재시작 복구 결과. start() 뒤에 채워진다. */
  private recovery?: RecoveryResult;

  constructor(opts: OfficeOptions = {}) {
    super();
    this.cfg = { ...defaultConfig, ...opts.config };
    this.fallbackWindowMs = opts.recovery?.fallbackWindowMs ?? RESUME_FALLBACK_WINDOW_MS;
    this.orphanOps = opts.recovery?.orphanOps ?? defaultOrphanOps;
    this.singletonProbe = opts.singletonProbe ?? defaultSingletonProbe;
    this.retentionIntervalMs = opts.retentionIntervalMs ?? RETENTION_INTERVAL_MS;
    this.version = opts.version ?? (pkg as { version?: string }).version ?? '0.0.0';
    this.hookScriptPath = toForwardSlashes(opts.hookScriptPath ?? path.resolve(import.meta.dirname, '..', 'hooks', 'hook.js'));
    this.statusLineScriptPath = toForwardSlashes(
      opts.statusLineScriptPath ?? path.resolve(import.meta.dirname, '..', 'hooks', 'statusline.js'),
    );
    this.store = opts.store ?? new Store(path.join(this.cfg.dataDir, 'pixel-office.db'));
    this.usage =
      opts.usage ?? new UsageTracker({ store: this.store, pollIntervalMs: Math.max(0, this.cfg.usagePollSec) * 1000 });
    this.pty =
      opts.pty ??
      new PtyManager({
        claudeExe: this.cfg.claudeExe,
        codexExe: this.cfg.codexExe,
        dataDir: this.cfg.dataDir,
        cols: this.cfg.cols,
        rows: this.cfg.rows,
      });
    this.receiver = opts.receiver ?? new HookReceiver();
    this.mcp =
      opts.mcp ??
      new TeamToolsServer({
        version: this.version,
        host: {
          resolveMember: (token) => {
            const m = this.store.getMemberByToken(token);
            return m && !GONE.has(m.status) ? { id: m.id, name: m.name, rank: m.rank } : undefined;
          },
          // T35: 직급별 도구. 직급·대상 검사는 전부 아래 team* 메서드(=store)가 한다(MCP 는 목록만 가른다).
          askUser: (memberId, input) => ({ questionId: this.teamAskUser(memberId, input).id }),
          askParent: (memberId, input) => {
            const pending = this.askParent(memberId, input);
            const parentId = (pending.payload as { to?: string }).to ?? '';
            return { questionId: pending.id, parentName: this.store.getMember(parentId)?.name ?? '상사' };
          },
          createTeam: (memberId, input) => {
            const r = this.teamCreateTeam(memberId, { ...input, engine: input.engine });
            return { teamId: r.team.id, teamName: r.team.name, leadName: r.lead.name, leadMemberId: r.lead.id };
          },
          dismissTeam: async (memberId, input) => {
            const r = await this.teamDismissTeam(memberId, input.teamId);
            return { teamName: r.team.name, dismissed: r.dismissed.map((m) => m.name) };
          },
          reply: (memberId, input) => {
            const r = this.teamReply(memberId, { toMember: input.to_member, text: input.text });
            return { name: r.to.name, questionId: r.questionId };
          },
          hire: (memberId, input) => {
            const m = this.teamHire(memberId, input);
            return { memberId: m.id, name: m.name, engine: m.engine };
          },
          dismiss: async (memberId, input) => {
            const m = await this.teamDismiss(memberId, input.memberId);
            return { memberId: m.id, name: m.name };
          },
          delegate: (memberId, input) => {
            const r = this.teamDelegate(memberId, input.to_member, input.task);
            return { taskId: r.task.id, name: r.to.name, status: r.assigned ? 'assigned' : 'queued' };
          },
          report: (memberId, input) => {
            const r = this.teamReport(memberId, input);
            return { taskId: r.task.id, status: input.status, to: r.to };
          },
        },
      });
    const adapterDeps: AdapterDeps = {
      store: this.store,
      // T26b: hook 에 나가는 것은 파일 본문이 아니라 **런타임 프리앰블 + 유효 지시문**(아래 buildSessionContext).
      getInstructions: (memberId: string) => this.buildSessionContext(memberId) || undefined,
      // T27: 셸 도구(읽기 전용 제외)의 PreToolUse 는 팀 락을 잡을 때까지 응답을 보류한다.
      toolGate: (memberId, tool, input, ctx) => this.shellGate(memberId, tool, input, ctx),
    };
    this.adapter = new ClaudeHooksAdapter(adapterDeps);
    this.codexAdapter = new CodexHooksAdapter(adapterDeps);
    this.adapters = { claude: this.adapter, codex: this.codexAdapter };
    this.wire();
  }

  /** 엔진의 hook 어댑터. */
  adapterFor(engine: Engine): BaseHooksAdapter {
    return this.adapters[engine] ?? this.adapter;
  }

  /** 멤버의 hook 어댑터. 멤버 행이 없으면(삭제 후 늦게 온 이벤트) Claude 쪽으로 — 어느 쪽이든 no-op 이다. */
  private adapterOf(memberId: string): BaseHooksAdapter {
    const engine = this.store.getMember(memberId)?.engine;
    return engine ? this.adapterFor(engine) : this.adapter;
  }

  /** 모든 엔진 어댑터(배선용). */
  private allAdapters(): BaseHooksAdapter[] {
    return [...new Set(Object.values(this.adapters))];
  }

  /** memberToken 의 어댑터(hook 보류 만료 라우팅). 멤버를 못 찾으면 Claude — 그쪽에도 보류가 없으면 no-op. */
  private adapterForToken(memberToken: string): BaseHooksAdapter {
    const engine = this.store.getMemberByToken(memberToken)?.engine;
    return engine ? this.adapterFor(engine) : this.adapter;
  }

  // ---- 수명 ------------------------------------------------------------------------

  /** hook 수신 시작 + daemon.json 기록. 두 번 부르면 no-op(같은 info). */
  async start(): Promise<DaemonInfo> {
    if (this.info) return this.info;
    fs.mkdirSync(this.cfg.dataDir, { recursive: true });
    // 데몬은 하나만(T30 / T38 함정 ⑤) — 포트를 열기 전에 확인한다. 거부는 DaemonAlreadyRunningError(exit 3).
    await assertSingleDaemon({ daemonJsonPath: this.daemonJsonPath, probe: this.singletonProbe });
    // daemon.json 이 없어도(= 다른 환경에서 띄운 데몬) 포트는 잡혀 있을 수 있다 — EADDRINUSE 를 같은 문구·
    // 같은 exit 3 으로 바꾼다(T41). 스택 트레이스로 끝나면 사용자가 할 수 있는 게 없다.
    const hookPort = await bindOrRefuse('hook', this.cfg.hookPort, this.daemonJsonPath, () => this.receiver.listen(this.cfg.hookPort));
    const mcpPort = await bindOrRefuse('mcp', this.cfg.mcpPort, this.daemonJsonPath, () => this.mcp.listen(this.cfg.mcpPort));
    this.info = {
      wsPort: this.cfg.wsPort,
      hookPort,
      mcpPort,
      token: this.token,
      pid: this.pid,
      startedAt: new Date().toISOString(),
      version: this.version,
    };
    this.writeDaemonInfo();
    this.started = true;
    console.log(`[office] mcp       : http://127.0.0.1:${mcpPort}/mcp/<memberToken> (TeamTools: ${ALL_TEAM_TOOLS.join(', ')})`);
    this.runRetention();
    this.startRetentionTimer();
    // T43: DB 에 남아 있던 사용량 중 멤버 행이 사라진 것을 메모리에서 정리한다.
    // **연결 폴링(`claude auth status`/`codex login status`)은 여기서 시작하지 않는다** — Office 는 멤버 CLI 말고
    // 다른 프로세스를 스스로 띄우지 않는다(단위 테스트가 Office 를 그냥 만들어 쓴다). 실제 데몬은 index.ts 가
    // `office.usage.start()` 로 켠다. 끄는 것은 shutdown() 이 같이 한다.
    this.usage.pruneMissingMembers();
    // 재시작 복구(T09): RPC 클라이언트가 붙기 전에 이전 기동의 멤버를 되살린다. 절대 throw 하지 않는다.
    this.recovery = this.recover();
    return this.info;
  }

  /** 이번 기동의 재시작 복구 결과(start() 전에는 undefined). */
  get recoveryResult(): RecoveryResult | undefined {
    return this.recovery;
  }

  /**
   * 보존 정리 한 판(T30/D-39): events 부서당 상한 + 닫힌 pending 30일 + 끝난 task 90일.
   * 절대 throw 하지 않는다 — 정리가 실패해도 데몬은 떠야 한다.
   */
  runRetention(): RetentionResult {
    try {
      const pruned = this.store.pruneRetention();
      if (pruned.events || pruned.pending || pruned.tasks) {
        console.log(`[office] retention: events ${pruned.events} · pending ${pruned.pending} · tasks ${pruned.tasks} 삭제`);
      }
      return pruned;
    } catch (err) {
      console.warn('[office] pruneRetention failed:', err);
      this.notice('warn', `보존 정리 실패: ${errMsg(err)}`);
      return { events: 0, pending: 0, tasks: 0 };
    }
  }

  /**
   * 하루 한 번 보존 정리(T30). 예전에는 기동 때 한 번뿐이라 **켜 둔 채로 며칠 쓰면 정리가 영영 안 됐다**.
   * `unref()` 라 이 타이머가 데몬을 살려 두지 않는다.
   */
  private startRetentionTimer(): void {
    if (this.retentionTimer || !(this.retentionIntervalMs > 0)) return;
    this.retentionTimer = setInterval(() => this.runRetention(), this.retentionIntervalMs);
    this.retentionTimer.unref();
  }

  /** 실제 바인딩된 WS 포트가 설정과 다를 때(임시 포트 0) daemon.json 을 다시 쓴다. */
  updateDaemonInfo(patch: Partial<Pick<DaemonInfo, 'wsPort'>>): DaemonInfo {
    if (!this.info) throw badState('office not started');
    this.info = { ...this.info, ...patch };
    this.writeDaemonInfo();
    return this.info;
  }

  get daemonInfo(): DaemonInfo | undefined {
    return this.info;
  }

  get daemonJsonPath(): string {
    return path.join(this.cfg.dataDir, 'daemon.json');
  }

  private writeDaemonInfo(): void {
    fs.writeFileSync(this.daemonJsonPath, JSON.stringify(this.info, null, 2));
  }

  /**
   * 전원 정중히 종료(Claude `/exit`) → hook 수신 종료 → store 닫기. 멤버 status 는 건드리지 않는다
   * (T09 재시작 복구가 working/waiting 이던 멤버를 --resume 으로 되살린다).
   */
  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const rt of this.runtimes.values()) {
      rt.exitMode = 'shutdown';
      rt.queue.stop();
      clearWatches(rt);
    }
    await Promise.all(
      this.pty.list().map((s) =>
        this.pty.kill(s.memberId, { graceful: true, timeoutMs: KILL_TIMEOUT_MS }).catch((err) => {
          console.warn(`[office] kill ${s.memberId} failed:`, err);
        }),
      ),
    );
    await this.receiver.close();
    await this.mcp.close();
    for (const rt of this.runtimes.values()) rt.screen.dispose();
    this.runtimes.clear();
    this.shell.clear(); // T27: 남은 보류·타이머 정리
    this.usage.stop(); // T43: 연결 폴링 타이머
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = undefined;
    }
    this.store.close();
    if (this.info) {
      try {
        fs.rmSync(this.daemonJsonPath, { force: true });
      } catch {
        // 지우지 못해도 무해 — pid 가 죽어 있으면 클라이언트가 stale 로 본다
      }
    }
    this.emit('shutdown');
  }

  // ---- 조회 ------------------------------------------------------------------------

  /**
   * 스냅샷. 멤버 행에 **파생 상태**를 실어 보낸다(T28) — 클라이언트가 `member.status` 알림과 같은 규칙을 다시 구현하지 않게
   * (재접속 직후 팀장이 `waiting_reports` 인지 `free` 인지는 raw status 만으로는 알 수 없다). 규칙은 derived.ts 하나뿐이다.
   */
  snapshot(): OfficeSnapshot {
    const snap = this.store.snapshot();
    return {
      ...snap,
      members: snap.members.map((m) => ({ ...m, derived: derivedStatus(m, this.store) })),
      // T43: 재접속 직후에도 칩·패널이 맞도록 사용량을 같이 싣는다(클라이언트가 다시 계산하지 않는다).
      usage: this.usage.snapshotUsage(),
    };
  }

  getMember(memberId: string): Member | undefined {
    return this.store.getMember(memberId);
  }

  /** `hello{since}` replay 용. seq 초과 전부(페이지를 이어 붙여). */
  eventsSince(seq: number): OfficeEvent[] {
    const out: OfficeEvent[] = [];
    let cursor = seq;
    for (;;) {
      const page = this.store.eventsSince(cursor, 1000);
      out.push(...page);
      if (page.length < 1000) return out;
      cursor = page[page.length - 1]!.seq;
    }
  }

  eventsQuery(input: EventsQueryInput): OfficeEvent[] {
    return this.store.eventsQuery(input);
  }

  // ---- 부서 (T34, D-32) ---------------------------------------------------------------

  /**
   * 부서 생성 + **부장 자동 출근**. 사용자가 하는 유일한 생성이다(D-32 "사용자는 부서를 만들고 부장만 임명한다").
   * 부서 행 → 부장 멤버(rank 'head', parent_id null, hiredBy 'user', 이름 `headName ?? '부장'`) → CLI 스폰 →
   * `departments.head_id` 기록 순. 스폰이 실패하면 부서 행까지 되돌린다 — 부장 없는 부서를 남기지 않는다.
   */
  createDepartment(params: CreateDepartmentParams): CreateDepartmentResult {
    this.ensureStarted();
    if (!fs.existsSync(params.cwd) || !fs.statSync(params.cwd).isDirectory()) throw invalidParams(`cwd is not a directory: ${params.cwd}`);
    if (params.headEngine !== 'claude' && params.headEngine !== 'codex') throw invalidParams(`unknown engine: ${String(params.headEngine)}`);
    if (!params.name.trim()) throw invalidParams('name is empty');
    const headName = (params.headName ?? DEFAULT_HEAD_NAME).trim() || DEFAULT_HEAD_NAME;

    const department = this.store.createDepartment({ name: params.name.trim(), cwd: path.resolve(params.cwd) });
    let head: Member;
    try {
      head = this.hireChild({ departmentId: department.id, name: headName, rank: 'head', engine: params.headEngine, hiredBy: 'user' });
    } catch (e) {
      this.store.deleteDepartment(department.id);
      throw e;
    }
    // (T42/D-46) 예전에는 여기서 "부장 엔진이 codex 입니다 — v1 권장은 claude" 경고를 냈다. **사실이 아니어서 지웠다**:
    // T42 실기에서 Codex 부장이 create_team·delegate·report·ask_user·reply 를 전부 통과했다.
    const created = this.store.updateDepartment(department.id, { headId: head.id })!;
    this.emit('tree', 'department.create');
    return { department: created, head };
  }

  /**
   * 부서 삭제. **하위 트리 전체**(팀원 → 팀장 → 부장)를 잎부터 정리한 뒤 행을 지운다(events 는 남는다).
   * 잎부터인 이유는 T28 과 같다 — 위를 먼저 내보내면 그 후처리가 아래를 interrupt 하고, 아래 후처리가 다시
   * (아직 살아 있는) 위 큐에 `[REPORTS … aborted]` 를 밀어 넣어 어차피 지울 부서에 왕복만 는다.
   */
  async deleteDepartment(departmentId: string): Promise<void> {
    const department = this.store.getDepartment(departmentId);
    if (!department) throw notFound('department', departmentId);
    for (const m of this.settleOrder(this.store.listDepartmentMembers(departmentId))) {
      if (this.runtimes.get(m.id)?.session.alive) await this.clockOut(m.id, { byLeader: true, reason: 'departmentDelete' });
      else this.settle(m.id, 'departmentDelete');
      this.disposeRuntime(m.id);
      this.lastDerived.delete(m.id);
      this.usage.removeMember(m.id); // T43: 멤버 행과 함께 사용량도 사라진다(DB 쪽은 FK cascade)
    }
    await this.drainChildExits();
    this.store.deleteDepartment(departmentId);
    // 지운 행은 `member.status{exited}` 로만 알려졌었다 — 부서·팀 행 자체가 사라진 것은 스냅샷으로 민다(T38).
    this.emit('tree', 'department.delete');
  }

  /** 부서 트리(콘솔 `tree` · 앱 T37). 멤버 행에는 스냅샷과 같은 파생 상태가 붙는다. */
  tree(): DepartmentTree[] {
    const withDerived = (m: Member) => ({ ...m, derived: derivedStatus(m, this.store) });
    return this.store.listDepartments().map((department) => {
      const all = this.store.listDepartmentMembers(department.id);
      const head = all.find((m) => m.rank === 'head');
      const teams = this.store.listTeams(department.id).map((team) => ({
        team,
        lead: all.filter((m) => m.teamId === team.id && m.rank === 'lead').map(withDerived)[0],
        members: all.filter((m) => m.teamId === team.id && m.rank === 'member').map(withDerived),
      }));
      const known = new Set([head?.id, ...teams.flatMap((t) => [t.lead?.id, ...t.members.map((m) => m.id)])]);
      return {
        department,
        head: head ? withDerived(head) : undefined,
        teams,
        orphans: all.filter((m) => !known.has(m.id)).map(withDerived),
      };
    });
  }

  /** 잎부터 정리하는 순서(팀원 → 팀장 → 부장). `subtreeOf` 의 깊이 우선 배열을 직급으로 접은 것. */
  private settleOrder(members: Member[]): Member[] {
    return [...members].sort((a, b) => RANK_DEPTH[a.rank] - RANK_DEPTH[b.rank]);
  }

  /** 뿌리부터 되살리는 순서(부장 → 팀장 → 팀원, T36). 부모가 먼저 떠 있어야 자식 보고를 받을 수 있다. */
  private recoverOrder(members: Member[]): Member[] {
    return [...members].sort((a, b) => RANK_DEPTH[b.rank] - RANK_DEPTH[a.rank]);
  }

  // ---- 팀 --------------------------------------------------------------------------

  /**
   * 팀 생성 + **팀장 자동 출근**. 부서 안에서만 만들어지고 팀장은 **부장의 자식**(parent_id = 부장)이다.
   * cwd 는 부서 cwd 를 그대로 쓴다(D-32 "한 부서 안의 팀들은 같은 cwd"). 스폰이 실패하면 팀 행까지 되돌린다.
   * T34 에서는 RPC 로는 디버그 전용(`force:true`) — 정식 경로는 T35 의 부장 도구 `create_team` 이다.
   */
  createTeam(params: CreateTeamParams): CreateTeamResult {
    this.ensureStarted();
    const department = this.store.getDepartment(params.departmentId);
    if (!department) throw notFound('department', params.departmentId);
    const head = this.store.liveHead(department.id);
    if (!head) throw badState(`부서 ${department.name} 에 살아 있는 부장이 없습니다 — 팀은 부장이 만든다`);
    const engine = params.leadEngine ?? head.engine;
    if (engine !== 'claude' && engine !== 'codex') throw invalidParams(`unknown engine: ${String(engine)}`);
    if (params.allowedEngines && !params.allowedEngines.includes(engine)) {
      throw invalidParams(`leadEngine ${engine} is not in allowedEngines`);
    }
    if (params.maxMembers !== undefined && params.maxMembers < 1) throw invalidParams('maxMembers must be >= 1 (the lead takes one slot)');
    const leadName = (params.leadName ?? DEFAULT_LEAD_NAME).trim() || DEFAULT_LEAD_NAME;

    const team = this.store.createTeam({
      departmentId: department.id,
      name: params.name,
      cwd: department.cwd,
      maxMembers: params.maxMembers,
      allowedEngines: params.allowedEngines,
    });
    let lead: Member;
    try {
      lead = this.hireChild({
        parentId: head.id,
        teamId: team.id,
        name: leadName,
        rank: 'lead',
        engine,
        instructions: params.leadInstructions,
      });
    } catch (e) {
      this.store.deleteTeam(team.id);
      throw e;
    }
    const created = this.store.updateTeam(team.id, { leaderId: lead.id })!;
    this.emit('tree', 'team.create');
    return { team: created, lead };
  }

  /**
   * 팀 삭제 — **팀원 먼저, 팀장 마지막**(T28). 위를 먼저 내보내면 그 후처리가 팀원을 interrupt 하고, 그 팀원의
   * 후처리가 다시 (아직 살아 있는) 팀장 큐에 `[REPORTS … aborted]` 를 밀어 넣는다. 살아 있지 않은 행도 MCP 토큰은 끊는다.
   */
  async deleteTeam(teamId: string): Promise<void> {
    const team = this.store.getTeam(teamId);
    if (!team) throw notFound('team', teamId);
    for (const m of this.settleOrder(this.store.listMembers(teamId))) {
      if (this.runtimes.get(m.id)?.session.alive) await this.clockOut(m.id, { byLeader: true, reason: 'teamDelete' });
      else this.settle(m.id, 'teamDelete');
      this.disposeRuntime(m.id);
      this.lastDerived.delete(m.id);
      this.usage.removeMember(m.id); // T43: 멤버 행과 함께 사용량도 사라진다(DB 쪽은 FK cascade)
    }
    await this.drainChildExits();
    this.store.deleteTeam(teamId);
    this.emit('tree', 'team.delete');
  }

  // ---- 멤버 수명 ---------------------------------------------------------------------

  /**
   * **트리의 유일한 스폰 경로**(T34). `createDepartment`(부장) · `createTeam`(팀장) · `hire`(팀원)가 전부 여기로 들어와
   * 멤버 행 생성 → (지시문 저장) → CLI 스폰을 한다. 규칙도 여기 한 곳에서만 강제한다:
   *
   *   - **직급 사슬** head → lead → member. 부모 직급의 바로 아래 직급만 고용할 수 있다(D-32 "고용은 항상 바로 아래로만").
   *   - 부장은 부모가 없고(`parentId` 생략) 부서에 한 명(살아 있는 기준).
   *   - 팀장은 팀 하나에 한 명이고 `teamId` 가 필요하다. 팀원은 부모(팀장)의 팀에 들어간다.
   *   - **정원**은 팀 단위(`maxMembers`, 팀장도 한 자리). 부서의 팀 수는 지금은 제한하지 않는다.
   */
  hireChild(params: HireChildParams): Member {
    this.ensureStarted();
    const rank = params.rank;
    if (rank !== 'head' && rank !== 'lead' && rank !== 'member') throw invalidParams(`unknown rank: ${String(rank)}`);
    const parent = params.parentId ? this.member(params.parentId) : undefined;
    const hiredBy: HiredBy = params.hiredBy ?? (parent ? 'leader' : 'user');
    const instructions = params.role === undefined ? params.instructions : buildRoleInstructions(params.role, params.instructions);

    if (rank === 'head') {
      if (parent) throw new OfficeError(RPC_ERROR.RANK_RULE, '부장 위에는 상사가 없습니다 (parentId 를 비우세요)');
      const department = this.store.getDepartment(params.departmentId ?? '');
      if (!department) throw notFound('department', params.departmentId ?? '(없음)');
      const current = this.store.liveHead(department.id);
      if (current) throw badState(`부서 ${department.name} 에는 이미 부장이 있습니다 (${current.name})`);
      return this.spawnNewMember({ department, parentId: null, name: params.name, engine: params.engine, rank, hiredBy, instructions });
    }

    if (!parent) throw invalidParams(`parentId is required for rank ${rank}`);
    if (GONE.has(parent.status)) {
      throw new OfficeError(RPC_ERROR.RANK_RULE, `${parent.name} 은(는) ${parent.status} 입니다 — 고용할 수 없습니다`);
    }
    const expected = CHILD_RANK[parent.rank];
    if (expected !== rank) {
      throw new OfficeError(
        RPC_ERROR.RANK_RULE,
        `${RANK_LABEL[parent.rank]} ${parent.name} 은(는) ${RANK_LABEL[rank]} 을(를) 고용할 수 없습니다 ` +
          `(${RANK_LABEL[parent.rank]} → ${expected ? RANK_LABEL[expected] : '없음'})`,
      );
    }
    const department = this.store.getDepartment(parent.departmentId);
    if (!department) throw notFound('department', parent.departmentId);

    const teamId = rank === 'lead' ? params.teamId : (params.teamId ?? parent.teamId ?? undefined);
    if (!teamId) throw invalidParams(`teamId is required for rank ${rank}`);
    const team = this.store.getTeam(teamId);
    if (!team) throw notFound('team', teamId);
    if (team.departmentId !== department.id) throw invalidParams(`team ${team.name} is not in department ${department.name}`);
    if (rank === 'lead') {
      const current = this.store.liveLead(team.id);
      if (current) throw badState(`team ${team.name} already has a lead (${current.name})`);
    } else if (parent.teamId !== team.id) {
      throw new OfficeError(RPC_ERROR.RANK_RULE, `${parent.name} 의 팀이 아닙니다`);
    }
    return this.spawnNewMember({ department, team, parentId: parent.id, name: params.name, engine: params.engine, rank, hiredBy, instructions });
  }

  /**
   * 출근(사용자). T34 부터 **디버그 전용 RPC**(`member.clockIn{force:true}`) — 정식 경로는 부서 생성(부장)과
   * 상위 직급의 도구다(D-32 "사용자가 팀장·팀원을 직접 출근시키는 기능은 없앤다"). `hiredBy` 는 항상 `'user'` 라
   * 상위가 `dismiss` 할 수 없다. 두 갈래다: **`parentId` 를 주면** `hireChild` 로 들어가 직급 사슬 검사를 그대로 받고,
   * **주지 않으면** 부서·팀을 직접 지정하는 디버그 경로로 사슬을 건너뛴다(직급 규칙 시험·망가진 트리 손보기).
   */
  clockIn(params: ClockInParams): Member {
    this.ensureStarted();
    const parent = params.parentId ? this.member(params.parentId) : undefined;
    if (parent) {
      const member = this.hireChild({
        parentId: parent.id,
        teamId: params.teamId,
        name: params.name,
        engine: params.engine,
        rank: params.rank ?? CHILD_RANK[parent.rank] ?? 'member',
        instructions: params.instructions,
        hiredBy: 'user',
      });
      this.registerLeadership(member);
      // 사용자가 끼워 넣은 멤버는 그 상사가 알아야 한다(자기가 부른 hire 가 아니다).
      this.notifyParent(member, teamJoinText(member.name, member.engine, roleOf(params.instructions)));
      return member;
    }

    // 부모 없이 부서·팀을 직접 지정하는 **디버그 경로**: 사슬을 건너뛰고 그 팀에 바로 꽂는다.
    const team = params.teamId ? this.store.getTeam(params.teamId) : undefined;
    if (params.teamId && !team) throw notFound('team', params.teamId);
    const departmentId = params.departmentId ?? team?.departmentId;
    const department = departmentId ? this.store.getDepartment(departmentId) : undefined;
    if (!department) throw notFound('department', params.departmentId ?? '(없음)');
    const rank: MemberRank = params.rank ?? (team ? 'member' : 'head');
    if (rank !== 'head' && rank !== 'lead' && rank !== 'member') throw invalidParams(`unknown rank: ${String(rank)}`);
    if (rank === 'head') {
      const current = this.store.liveHead(department.id);
      if (current) throw badState(`부서 ${department.name} 에는 이미 부장이 있습니다 (${current.name})`);
    } else {
      if (!team) throw invalidParams(`teamId is required for rank ${rank}`);
      if (rank === 'lead' && this.store.liveLead(team.id)) throw badState(`team ${team.name} already has a lead (${this.store.liveLead(team.id)!.name})`);
    }
    // 살아 있는 상사가 있으면 그 아래로 붙이고, 없으면 부모 없는 행으로 남긴다(콘솔 `tree` 가 "부모 없는 멤버" 로 보여 준다).
    const implicitParent =
      rank === 'lead' ? this.store.liveHead(department.id) : rank === 'member' && team ? this.store.liveLead(team.id) : undefined;
    const member = this.spawnNewMember({
      department,
      team: rank === 'head' ? undefined : team,
      parentId: implicitParent?.id ?? null,
      name: params.name,
      engine: params.engine,
      rank,
      hiredBy: 'user',
      instructions: params.instructions,
    });
    this.registerLeadership(member);
    this.notifyParent(member, teamJoinText(member.name, member.engine, roleOf(params.instructions)));
    return member;
  }

  /** 부장·팀장으로 들어온 멤버를 부서/팀 행에도 적어 둔다(`departments.head_id` / `teams.leader_id`). */
  private registerLeadership(member: Member): void {
    if (member.rank === 'head') this.store.updateDepartment(member.departmentId, { headId: member.id });
    if (member.rank === 'lead' && member.teamId) this.store.updateTeam(member.teamId, { leaderId: member.id });
  }

  /**
   * 팀장의 TeamTools `hire`(T25)가 쓰는 얇은 래퍼 = `hireChild({parentId, rank:'member'})`.
   * 팀원은 `hiredBy:'leader'` 라 팀장이 `dismiss` 할 수 있다(사용자가 출근시킨 팀원과 구분, 01 §4).
   */
  hireByLeader(params: HireByLeaderParams): Member {
    return this.hireChild({
      parentId: params.leaderId,
      name: params.name,
      engine: params.engine,
      rank: 'member',
      instructions: params.instructions,
      hiredBy: 'leader',
    });
  }

  /** `hireChild` 만 부르는 "멤버 행 + 지시문 + 스폰". 이름·엔진·정원 검사도 여기서. */
  private spawnNewMember(input: {
    department: Department;
    team?: Team;
    parentId: string | null;
    name: string;
    engine: Engine;
    rank: MemberRank;
    hiredBy: HiredBy;
    instructions?: string;
  }): Member {
    const { department, team } = input;
    if (input.engine !== 'claude' && input.engine !== 'codex') throw invalidParams(`unknown engine: ${String(input.engine)}`);
    if (team && !team.allowedEngines.includes(input.engine)) throw invalidParams(`engine ${input.engine} not allowed in team ${team.name}`);
    if (!input.name.trim()) throw invalidParams('name is empty');
    if (team) {
      const live = this.store.listMembers(team.id).filter((m) => !GONE.has(m.status)).length;
      if (live >= team.maxMembers) throw badState(`team ${team.name} is full (${live}/${team.maxMembers})`);
    }

    const member = this.store.createMember({
      departmentId: department.id,
      teamId: team?.id ?? null,
      parentId: input.parentId,
      name: input.name.trim(),
      rank: input.rank,
      engine: input.engine,
      cwd: team?.cwd ?? department.cwd,
      hiredBy: input.hiredBy,
      status: 'starting',
    });
    if (input.instructions !== undefined) this.setInstructions(member.id, input.instructions);
    this.spawnMember(this.store.getMember(member.id)!, false);
    return this.store.getMember(member.id)!;
  }

  /**
   * 퇴근: 진행 task aborted(+ 발행자에게 `[REPORTS … status=aborted]`), pending expired, 정중히 종료.
   * 행은 남긴다(status exited → rehire 가능).
   *
   * **상위가 나가면(T25 → T36)** 그가 발행한 task 를 전부 aborted 하고, **하위 트리 전체가 잎부터 따라 정리된다**
   * (01 §"직무 체계 rev 3" 후처리: 부장 퇴근 = 부서 전원). 부하는 각자 `parentGone` 후처리를 받고 세션이 끝나며
   * 행은 `exited` 로 남는다 — 되살리려면 `rehire`.
   * `opts.byLeader` 는 TeamTools `dismiss` 경로 표시 — 그때는 `[TEAM]` 알림을 상사에게 되돌리지 않는다.
   * 후처리(task·pending·셸 락·하위 트리·MCP)는 전부 `settle()` 하나가 한다(T28). `opts.reason` 은 팀·부서 삭제 경로 표시.
   */
  async clockOut(memberId: string, opts: { byLeader?: boolean; reason?: SettleReason } = {}): Promise<void> {
    const member = this.member(memberId);
    const rt = this.runtimes.get(memberId);
    if (!rt?.session.alive && GONE.has(member.status)) throw badState(`member ${memberId} already ${member.status}`);
    if (rt?.session.alive) {
      rt.exitMode = 'clockOut';
      rt.queue.clear();
      rt.queue.stop();
    }
    this.settle(memberId, opts.reason ?? 'clockOut');
    if (!rt?.session.alive) {
      // 프로세스 없이 status 만 살아 있는 행(데몬 재시작 후 등) — 상태만 정리한다.
      this.finishMember(memberId, 'clocked out');
      await this.drainChildExits();
      this.noticeClockOut(member, opts.byLeader === true);
      return;
    }
    await this.pty.kill(memberId, { graceful: true, timeoutMs: KILL_TIMEOUT_MS });
    this.finishMember(memberId, 'clocked out');
    await this.drainChildExits(); // 하위 트리 정리로 끝낸 부하 세션까지 다 나간 뒤 반환한다
    this.noticeClockOut(member, opts.byLeader === true);
  }

/** 사용자가 누군가를 퇴근시키면 그 **상사**에게 `[TEAM] 팀원 변경: -<이름>`(상사 자신의 dismiss 는 제외). */
  private noticeClockOut(member: Member, byLeader: boolean): void {
    if (byLeader) return;
    this.notifyParent(member, teamLeaveText(member.name));
  }

  /** exited/error 멤버를 같은 설정으로 재스폰(session_id 있으면 --resume). */
  async rehire(memberId: string): Promise<Member> {
    this.ensureStarted();
    const member = this.member(memberId);
    if (!GONE.has(member.status) || this.runtimes.get(memberId)?.session.alive) {
      throw badState(`member ${memberId} is ${member.status}; use member.restart`);
    }
    this.spawnMember(member, true);
    return this.store.getMember(memberId)!;
  }

  /** 지시문 즉시 반영용: 종료 → --resume 재스폰 → [RESUMED] 를 큐에. */
  async restart(memberId: string): Promise<Member> {
    this.ensureStarted();
    this.member(memberId);
    const rt = this.runtimes.get(memberId);
    if (rt?.session.alive) {
      rt.exitMode = 'restart';
      rt.queue.clear();
      rt.queue.stop();
      this.settle(memberId, 'restart'); // T28: 보류 만료 + 셸 락 해제(진행 task 는 같은 세션을 이어서 하므로 그대로)
      await this.pty.kill(memberId, { graceful: true, timeoutMs: KILL_TIMEOUT_MS });
    }
    const fresh = this.spawnMember(this.store.getMember(memberId)!, true);
    fresh.queue.enqueue({ kind: 'system', text: RESUMED_TEXT });
    return this.store.getMember(memberId)!;
  }

  // ---- 입력 ------------------------------------------------------------------------

  /**
   * 사용자 지시 = task(from 'user'). 큐에 `[TASK#n from user]\n<text>` — flush 되면 assigned.
   *
   * **"부장에게만 지시"(T34, D-32 — T24 의 "팀장에게만" 을 대체):** 그 **부서**에 살아 있는 부장이 있으면
   * 부장 외(팀장·팀원) 직접 지시는 `-32004` + `data:{headId}`. 부장이 나가면(exited/error) 게이트가 열린다.
   * `opts.force` 는 디버그용 탈출구 — 앱은 보내지 않는다. 터미널 탭 직접 타이핑(`member.type`)은 "지시"가 아니라 항상 가능.
   */
  instruct(memberId: string, text: string, opts: InstructOptions = {}): number {
    const member = this.member(memberId);
    const rt = this.liveRuntime(member);
    if (!text.trim()) throw invalidParams('text is empty');
    if (!opts.force && member.rank !== 'head') {
      const head = this.store.liveHead(member.departmentId);
      if (head) throw new OfficeError(RPC_ERROR.RANK_RULE, headOnlyMessage(head.name), { headId: head.id });
    }
    const task = this.store.createTask({
      departmentId: member.departmentId,
      fromMember: USER_ACTOR,
      toMember: memberId,
      instruction: text,
      status: 'queued',
    });
    this.enqueueTask(rt, task);
    return task.id;
  }

  /** 터미널 탭 직접 타이핑(raw bytes, 게이트 없음). */
  typeRaw(memberId: string, data: string): void {
    const rt = this.liveRuntime(this.member(memberId));
    rt.queue.typeRaw(data);
  }

  /**
   * Ctrl+C. 큐의 미전송 항목은 버리고(중단 후 이어서 타이핑되면 안 되므로) task aborted·pending expired(01 §공통 후처리).
   * Ctrl+C 에는 Stop hook 이 없어 화면 준비 문구가 보이면 idle 로 되돌린다.
   */
  interrupt(memberId: string): void {
    const member = this.member(memberId);
    const rt = this.liveRuntime(member);
    const now = Date.now();
    if (rt.lastInterruptAt !== undefined && now - rt.lastInterruptAt < INTERRUPT_GUARD_MS) {
      throw badState('interrupt already sent; a second Ctrl+C would exit the CLI');
    }
    rt.lastInterruptAt = now;
    rt.queue.clear();
    rt.queue.interrupt();
    // T28 공통 후처리: 내 task aborted(+ 발행자에게 즉시 보고) · 보류 만료 · 셸 락 해제.
    // 팀장이어도 자기가 낸 task 는 건드리지 않는다 — Ctrl+C 는 그 팀장의 턴을 끊는 것이지 팀 지시를 거두는 게 아니다.
    this.settle(memberId, 'interrupt');
    this.watchInterrupted(rt);
  }

  // ---- 터미널 탭 -------------------------------------------------------------------------

  attach(clientId: string, memberId: string, cols: number, rows: number): AttachResult {
    this.member(memberId);
    const rt = this.runtimes.get(memberId);
    if (!rt) throw badState(`member ${memberId} has no terminal in this daemon session`);
    checkSize(cols, rows);
    rt.attached.add(clientId);
    rt.lastAttached = clientId;
    this.applySize(rt, cols, rows);
    return { screen: rt.screen.serialize(), cols: rt.screen.cols, rows: rt.screen.rows };
  }

  detach(clientId: string, memberId: string): void {
    const rt = this.runtimes.get(memberId);
    if (!rt) return;
    rt.attached.delete(clientId);
    if (rt.lastAttached === clientId) rt.lastAttached = [...rt.attached].at(-1);
  }

  detachAll(clientId: string): void {
    for (const rt of this.runtimes.values()) this.detach(clientId, rt.memberId);
  }

  /** 마지막으로 attach 한 클라이언트의 resize 만 적용. 그 외는 조용히 무시(PROTOCOL.md). */
  resize(clientId: string, memberId: string, cols: number, rows: number): void {
    this.member(memberId);
    const rt = this.runtimes.get(memberId);
    if (!rt) throw badState(`member ${memberId} has no terminal in this daemon session`);
    checkSize(cols, rows);
    if (rt.lastAttached !== clientId) return;
    this.applySize(rt, cols, rows);
  }

  /** 지금 attach 상태(테스트·진단). */
  attachedClients(memberId: string): { clients: string[]; last?: string } {
    const rt = this.runtimes.get(memberId);
    return { clients: rt ? [...rt.attached] : [], last: rt?.lastAttached };
  }

  // ---- 지시문 ----------------------------------------------------------------------

  /** **사용자 파일만.** 없으면 `""` — 앱의 지시문 편집기가 보는 값이다(기본 템플릿은 섞지 않는다). */
  getInstructions(memberId: string): string {
    this.member(memberId);
    return this.readInstructions(memberId);
  }

  /**
   * 지금 이 멤버에게 실제로 적용되는 지시문 본문(T26b). 사용자 파일에 **본문이 있으면** 그것, 없으면 직급 기본 템플릿.
   *
   * `hire` 가 쓴 `# 역할: <role>` 한 줄뿐인 파일은 "본문 없음" 으로 본다 — 그건 사용자가 쓴 지시문이 아니라 역할 메타데이터라
   * (roleOf 가 `[TEAM]` 알림에 쓴다) 기본 템플릿을 덮을 이유가 없다. 대신 그 역할이 템플릿 머리말에 실린다.
   */
  effectiveInstructions(memberId: string): string {
    const member = this.store.getMember(memberId);
    if (!member) return '';
    const file = this.readInstructions(memberId);
    if (bodyBelowRole(file).trim()) return file;
    const scope = this.templateScope(member);
    if (!scope) return file;
    return defaultInstructions(member, scope, { role: roleOf(file), parentName: this.store.parentOf(member.id)?.name });
  }

  /** 기본 템플릿이 쓰는 범위(팀이 있으면 팀, 부장은 부서). 부서 행이 없으면 undefined. */
  private templateScope(member: Member): TemplateScope | undefined {
    const team = member.teamId ? this.store.getTeam(member.teamId) : undefined;
    if (team) return { name: team.name, cwd: team.cwd, maxMembers: team.maxMembers, allowedEngines: team.allowedEngines };
    const department = this.store.getDepartment(member.departmentId);
    if (!department) return undefined;
    return { name: department.name, cwd: department.cwd, maxMembers: DEFAULT_MAX_MEMBERS, allowedEngines: ['claude', 'codex'] };
  }

  /**
   * SessionStart 의 `additionalContext` 로 나가는 전체 텍스트(T26b) = 런타임 프리앰블 + 유효 지시문.
   * 프리앰블(정체·로스터·도구 이름)은 사용자 지시문이 있어도 늘 붙고, startup/resume/clear/compact 마다 다시 나간다(D-05).
   */
  buildSessionContext(memberId: string): string {
    const member = this.store.getMember(memberId);
    if (!member) return '';
    const department = this.store.getDepartment(member.departmentId);
    if (!department) return this.effectiveInstructions(memberId);
    const parent = this.store.parentOf(member.id);
    // T34: 로스터는 **직속 부하만**(팀 전체가 아니라) — 트리에서 내가 말을 걸 수 있는 상대가 그들뿐이다.
    const children: RosterEntry[] = this.store
      .childrenOf(member.id)
      .map((m) => ({ name: m.name, rank: m.rank, engine: m.engine, role: roleOf(this.readInstructions(m.id)) }));
    return buildSessionContext({
      department,
      team: member.teamId ? this.store.getTeam(member.teamId) : undefined,
      member,
      parent: parent ? { name: parent.name, rank: parent.rank } : undefined,
      children,
      instructions: this.effectiveInstructions(memberId),
    });
  }

  /**
   * `${dataDir}/teams/<teamId>/members/<memberId>/INSTRUCTIONS.md`. 다음 SessionStart 부터 반영(D-05).
   * 파일은 **사용자(앱·콘솔)나 `hire`/`clockIn` 의 `instructions` 로만** 생긴다 — 기본 템플릿은 저장하지 않는다(T26b).
   */
  setInstructions(memberId: string, markdown: string): void {
    const member = this.member(memberId);
    const file = this.instructionsPath(member.teamId ?? member.departmentId, memberId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, markdown);
    if (member.instructionsPath !== file) this.store.updateMember(memberId, { instructionsPath: file });
  }

  /** `scopeId` 는 그 멤버의 팀 id, 팀이 없는 부장은 부서 id. 경로 접두사는 v1 그대로 `teams/` 다(기존 파일 유지). */
  instructionsPath(scopeId: string, memberId: string): string {
    return path.join(this.cfg.dataDir, 'teams', scopeId, 'members', memberId, 'INSTRUCTIONS.md');
  }

  private readInstructions(memberId: string): string {
    const member = this.store.getMember(memberId);
    const file = member?.instructionsPath;
    if (!file) return '';
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }

  // ---- 허가·질문 ----------------------------------------------------------------------

  respondApproval(pendingId: string, decision: ApprovalRespondParams): void {
    const pending = this.openPending(pendingId, 'approval');
    const ok = this.adapterOf(pending.memberId).resolveApproval(pendingId, {
      behavior: decision.behavior,
      updatedInput: decision.updatedInput,
      message: decision.message,
    });
    if (!ok) throw badState(`pending ${pendingId} is no longer held (hook already closed)`);
    if (decision.alwaysThisSession && decision.behavior === 'allow') {
      const tool = pending.payload.tool_name;
      if (typeof tool === 'string') this.autoAllowSet(pending.memberId).add(tool);
    }
  }

  /**
   * 질문에 답한다. TUI `AskUserQuestion`(payload.tool_input 있음)은 어댑터가 hook 결정으로 돌려주고,
   * TeamTools `ask_user`(payload.source==='ask_user')는 큐에 `[ANSWER q#<id>]` 시스템 메시지를 넣는다(T17).
   * Codex 질문 폴백(payload.fallback, T22)은 같은 경로지만 봉투 없이 답 본문만 넣는다.
   * **`ask_parent` 질문(T35)도 같은 경로로 답할 수 있다** — 정식 길은 상사의 `reply` 지만, 상사가 굳었을 때
   * 사용자가 앱·콘솔에서 대신 끊어 줄 수 있어야 한다(오버라이드, 앱 UI 에 광고하지는 않는다).
   */
  respondQuestion(pendingId: string, answers: Record<string, string>): void {
    const pending = this.openPending(pendingId, 'question');
    if (isAskUserPayload(pending.payload) || isAskParentPayload(pending.payload)) {
      this.answerAskUser(pending, answers);
      return;
    }
    if (!this.adapterOf(pending.memberId).resolveQuestion(pendingId, answers)) {
      throw badState(`pending ${pendingId} is no longer held (hook already closed)`);
    }
  }

  // ---- TeamTools ask_user (T17) ------------------------------------------------------------------

  /**
   * MCP `ask_user` 연결점: pending(question) 등록 + `asking` 이벤트 + status waiting_answer. 즉시 반환(비블로킹) —
   * 모델은 도구 결과의 안내대로 턴을 끝내고, 답은 `respondQuestion` 이 `[ANSWER q#<id>]` 로 넣는다.
   * payload 에 `tool_input` 을 넣지 않는다(D-19: 재시작 복구가 이 질문을 유효한 것으로 남긴다).
   */
  askUser(memberId: string, input: AskUserParams): Pending {
    return this.askUserUnchecked(memberId, input);
  }

  /**
   * `ask_user` **도구** 경로(T35). 사용자에게 직접 묻는 것은 부장뿐이다(D-32) — 팀장·팀원이 부르면
   * `ask_parent` 를 쓰라는 -32004. MCP 서버의 도구 목록(첫 겹)과 같은 문장을 쓴다.
   */
  teamAskUser(memberId: string, input: AskUserParams): Pending {
    this.requireToolRank(memberId, 'ask_user');
    return this.askUserUnchecked(memberId, input);
  }

  /** 직급 검사 없는 `ask_user` 본체. Codex 질문 폴백(T22)처럼 데몬이 스스로 만드는 질문도 여기를 쓴다. */
  private askUserUnchecked(memberId: string, input: AskUserParams): Pending {
    const member = this.member(memberId);
    this.liveRuntime(member);
    const question = input.question.trim();
    if (!question) throw invalidParams('question is empty');
    const options = (input.options ?? []).map((o) => o.trim()).filter((o) => o.length > 0);
    const payload: AskUserPayload = { source: 'ask_user', question, options };
    const pending = this.store.createPending({ memberId, type: 'question', payload: { ...payload } });
    const detail: OfficeEvent['detail'] = { tool: 'ask_user', summary: question };
    if (options.length > 0) detail.options = options;
    this.appendEvent(member, 'asking', detail, { questionId: pending.id });
    this.setStatus(memberId, 'waiting_answer');
    return pending;
  }

  /**
   * ask_user 답: pending 을 answered 로 닫고(= isIdle 게이트의 "열린 pending 없음" 조건이 풀린다) 큐에 `[ANSWER q#<id>]\n<답>`.
   * 큐는 항목 종류를 모르므로(T05 남은 것) 별도 bypass 플래그 대신 **답이 게이트를 먼저 연다** — 같은 멤버에 열린 ask_user 질문이
   * 둘이면 둘 다 답해야 흐른다(설계: 답 대기 중 새 지시를 섞지 않는다). 질문이 열린 동안 쌓인 항목([TASK#n]·[RESUMED])보다
   * 답이 먼저 들어간다(모델은 답을 기다리며 그 작업을 멈춘 상태) — 큐를 비웠다가 답 뒤에 그대로 다시 넣는다.
   * status 는 손대지 않는다: 보통 idle(턴이 끝난 상태)이라 큐가 바로 흘러 UserPromptSubmit 이 working 으로 올린다.
   * 아직 waiting_answer(PostToolUse 전, 턴 진행 중)면 working 으로.
   */
  private answerAskUser(pending: Pending, answers: Record<string, string>): void {
    const member = this.member(pending.memberId);
    const rt = this.liveRuntime(member);
    // Codex 질문 폴백(T22)에는 기다리는 MCP 호출이 없다 → `[ANSWER q#…]` 봉투 없이 사용자가 친 것처럼 그대로 넣는다.
    const text = isFallbackQuestion(pending.payload) ? answerBody(answers) : buildAnswerText(pending.id, answers);
    this.store.answerPending(pending.id, answers);
    if (this.store.getMember(member.id)?.status === 'waiting_answer') this.setStatus(member.id, 'working');
    else this.emitStatus(member.id, this.store.getMember(member.id)!.status); // derived(waiting_answer → idle/free) 갱신
    const waiting = rt.queue.clear();
    rt.queue.enqueue({ kind: 'system', text, id: pending.id });
    for (const item of waiting) rt.queue.enqueue(item);
  }

  // ---- TeamTools 오케스트레이션 (T25 → T35 직급별 도구) --------------------------------------
  //
  // 01 §TeamTools MCP / §"직무 체계 rev 3" / 전제 6. **직급·대상 검사는 전부 여기(=store)에서 한다** — MCP 서버는
  // 도구 목록만 직급으로 가르고, 실제 허용 여부는 이 메서드들이 판단해 OfficeError 를 던진다(도구 결과 isError).
  //   create_team  부장 → 팀 + 팀장 출근            dismiss_team 부장 → 팀 해산(팀장 유휴 ∧ 미종료 task 0)
  //   hire         팀장 → 팀원 출근(hiredBy 'leader'), 지시문 첫 줄에 `# 역할: <role>`
  //   dismiss      팀장 → 직속 팀원 퇴근(idle ∧ 미종료 task 0 ∧ hiredBy 'leader')
  //   delegate     부장·팀장 → **직속 부하**에게 task + `[TASK#n from <이름>(<직급>)]`, 바쁘면 queued
  //   reply        부장·팀장 → 직속 부하의 열린 ask_parent 에 `[ANSWER q#n]`, 없으면 `[MESSAGE from <이름>]`
  //   report       전원 → 자기에게 배정된 task 를 닫는다. 상사 보고는 버퍼링 후 `[REPORTS …][ALL_REPORTS_IN]`,
  //                부장이 사용자 task 를 보고하면 `reporting` 이벤트(= 내 책상 보고)
  //   ask_user     부장만 → 사용자      ask_parent  팀장·팀원 → 직속 상사 큐에 `[QUESTION from <이름> q#n]`
  //
  // **규칙은 아래 세 관문 하나씩에만 있다**: `requireToolRank`(그 직급의 도구인가) · `requireChild`(살아 있는 직속
  // 부하인가) · `requireParent`(직속 상사가 누구인가). 각 도구 메서드는 이 셋을 부르고 자기 일만 한다.

  /** 도구 호출자 관문(T35). 살아 있는 멤버이고 **그 직급의 도구**여야 한다. 아니면 -32004(도구 결과 isError). */
  private requireToolRank(memberId: string, tool: TeamToolName): Member {
    const m = this.member(memberId);
    if (GONE.has(m.status)) throw new OfficeError(RPC_ERROR.RANK_RULE, `${m.name} 은(는) ${m.status} 입니다`);
    if (!canUseTool(m.rank, tool)) throw new OfficeError(RPC_ERROR.RANK_RULE, rankToolMessage(tool, m.rank));
    return m;
  }

  /**
   * `delegate`/`reply`/`dismiss` 의 대상 = **살아 있는 직속 부하**(D-32 "지시·고용은 바로 아래로만").
   * 팀이 아니라 `parent_id` 를 본다 — 부장의 부하는 팀장, 팀장의 부하는 자기 팀원이다.
   */
  private requireChild(parent: Member, targetId: string, tool: string): Member {
    const id = targetId.trim();
    if (!id) throw invalidParams('to_member 가 비었습니다');
    const target = this.store.getMember(id);
    if (!target) throw notFound('member', id);
    if (target.id === parent.id) throw new OfficeError(RPC_ERROR.RANK_RULE, `자기 자신에게는 ${tool} 할 수 없습니다`);
    if (target.parentId !== parent.id) {
      const rank = RANK_LABEL[CHILD_RANK[parent.rank] ?? 'member'];
      throw new OfficeError(RPC_ERROR.RANK_RULE, `${target.name} 은(는) 당신의 직속 부하가 아닙니다 — ${tool} 은 직속 ${rank}에게만 할 수 있습니다`);
    }
    if (GONE.has(target.status)) throw badState(`${target.name} 은(는) ${target.status} 입니다`);
    return target;
  }

  /** `ask_parent`(그리고 보고 경로)의 상대 = **살아 있는 직속 상사**. 부장은 상사가 사용자라 여기 오지 않는다. */
  private requireParent(member: Member, tool: string): Member {
    const parent = member.parentId ? this.store.getMember(member.parentId) : undefined;
    if (!parent || GONE.has(parent.status)) {
      throw badState(`${tool} 할 직속 상사가 없습니다 (${member.name}) — 데몬이 트리를 복구할 때까지 report 로만 남기세요`);
    }
    return parent;
  }

  /**
   * 부장이 부른 `create_team`(T35). 자기 부서에 팀을 만들고 **자기 자식으로** 팀장을 출근시킨다.
   * 팀장 엔진은 지정하지 않으면 부장과 같은 엔진, `instructions` 는 그 팀장의 INSTRUCTIONS.md 초안이다.
   */
  teamCreateTeam(headId: string, input: TeamCreateTeamInput): CreateTeamResult {
    const head = this.requireToolRank(headId, 'create_team');
    const name = input.name.trim();
    if (!name) throw invalidParams('name 이 비었습니다 — 팀 이름을 적으세요');
    const leadName = (input.leadName ?? '').trim();
    if (!leadName) throw invalidParams('leadName 이 비었습니다 — 팀장의 이름을 적으세요');
    return this.createTeam({
      departmentId: head.departmentId,
      name,
      leadEngine: input.engine ?? head.engine,
      leadName,
      leadInstructions: input.instructions,
    });
  }

  /**
   * 부장이 부른 `dismiss_team`(T35). **자기 부서의 팀**만, 그 팀장이 유휴이고 팀에 미종료 task 가 없을 때만.
   * 정리는 `deleteTeam`(팀원 → 팀장 순 잎부터 퇴근 + 행 삭제)이 한다.
   */
  async teamDismissTeam(headId: string, teamId: string): Promise<{ team: Team; dismissed: Member[] }> {
    const head = this.requireToolRank(headId, 'dismiss_team');
    const id = (teamId ?? '').trim();
    if (!id) throw invalidParams('teamId 가 비었습니다');
    const team = this.store.getTeam(id);
    if (!team) throw notFound('team', id);
    if (team.departmentId !== head.departmentId) throw new OfficeError(RPC_ERROR.RANK_RULE, `팀 ${team.name} 은(는) 당신의 부서가 아닙니다`);
    const members = this.store.listMembers(team.id).filter((m) => !GONE.has(m.status));
    const lead = members.find((m) => m.rank === 'lead');
    if (lead && lead.parentId !== head.id) throw new OfficeError(RPC_ERROR.RANK_RULE, `팀 ${team.name} 의 팀장은 당신의 직속 부하가 아닙니다`);
    if (lead && lead.status !== 'idle') {
      throw badState(`팀장 ${lead.name} 이(가) 아직 ${lead.status} 입니다 — 보고를 기다리거나 먼저 중단시키세요`);
    }
    const open = members.flatMap((m) => this.store.listTasks({ toMember: m.id, status: OPEN_TASKS }));
    if (open.length > 0) {
      throw badState(`팀 ${team.name} 에 미종료 task 가 ${open.length}건 있습니다 (${open.map((t) => `task#${t.id}`).join(', ')}) — 보고를 기다리세요`);
    }
    await this.deleteTeam(team.id);
    return { team, dismissed: members };
  }

  /** 팀장이 부른 `hire`. 역할 줄을 붙인 지시문으로 팀원을 출근시킨다. 정원 초과·허용 안 된 엔진은 throw. */
  teamHire(leaderId: string, input: TeamHireInput): Member {
    const leader = this.requireToolRank(leaderId, 'hire');
    const team = leader.teamId ? this.store.getTeam(leader.teamId) : undefined;
    if (!team) throw notFound('team', leader.teamId ?? '(없음)');
    const role = input.role.trim();
    if (!role) throw invalidParams('role 이 비었습니다 — 그 팀원이 맡을 역할을 한 줄로 적으세요');
    const engine = this.pickHireEngine(team, leader, input.engine);
    return this.hireByLeader({
      leaderId,
      name: input.name,
      engine,
      instructions: buildRoleInstructions(role, input.instructions),
    });
  }

  /** hire 의 엔진 결정: 지정하면 그것(팀 허용 목록 안에서), 없으면 팀장과 같은 엔진 → claude → 허용 목록 첫 번째. */
  private pickHireEngine(team: Team, leader: Member, requested?: Engine): Engine {
    if (requested !== undefined) {
      if (requested !== 'claude' && requested !== 'codex') throw invalidParams(`모르는 엔진: ${String(requested)}`);
      if (!team.allowedEngines.includes(requested)) {
        throw invalidParams(`팀 ${team.name} 에서 허용되지 않은 엔진: ${requested} (허용: ${team.allowedEngines.join(', ')})`);
      }
      return requested;
    }
    if (team.allowedEngines.includes(leader.engine)) return leader.engine;
    if (team.allowedEngines.includes('claude')) return 'claude';
    return team.allowedEngines[0] ?? 'claude';
  }

  /**
   * 팀장이 부른 `dismiss`. 사용자가 출근시킨 팀원(`hiredBy:'user'`)은 팀장이 자를 수 없다(01 §4) — 사용자의 "퇴근" 만.
   * 대상이 idle 이고 미종료 task·열린 pending 이 없을 때만(아니면 먼저 기다리거나 중단시키라고 안내).
   */
  async teamDismiss(leaderId: string, targetId: string): Promise<Member> {
    const leader = this.requireToolRank(leaderId, 'dismiss');
    const target = this.requireChild(leader, targetId, 'dismiss');
    if (target.hiredBy !== 'leader') {
      throw new OfficeError(RPC_ERROR.RANK_RULE, `사용자가 출근시킨 팀원은 퇴근 버튼으로만 내보낼 수 있습니다 (${target.name})`);
    }
    if (GONE.has(target.status)) throw badState(`${target.name} 은(는) 이미 ${target.status} 입니다`);
    if (target.status !== 'idle') {
      throw badState(`${target.name} 이(가) 아직 ${target.status} 입니다 — 보고를 기다리거나 먼저 중단시키세요`);
    }
    const open = this.store.listTasks({ toMember: target.id, status: OPEN_TASKS });
    if (open.length > 0) {
      throw badState(`${target.name} 에게 미종료 task 가 ${open.length}건 있습니다 (${open.map((t) => `task#${t.id}`).join(', ')}) — 보고를 기다리세요`);
    }
    if (this.store.listOpenPending(target.id).length > 0) {
      throw badState(`${target.name} 에게 열린 허가·질문이 있습니다 — 먼저 처리하세요`);
    }
    await this.clockOut(target.id, { byLeader: true });
    return this.store.getMember(target.id)!;
  }

  /**
   * 부장·팀장이 부른 `delegate`. 대상은 **살아 있는 직속 부하**뿐이다(T35). 비블로킹 — task 행을 만들고, 대상이 지금
   * 받을 수 있으면(유휴 ∧ 열린 pending 없음) 바로 입력 큐에 넣어 `assigned`, 아니면 `queued` 로 남겨
   * 유휴 감시(`dispatchQueuedTasks`)가 전달한다.
   */
  teamDelegate(leaderId: string, toMemberId: string, task: string): { task: Task; to: Member; assigned: boolean } {
    const leader = this.requireToolRank(leaderId, 'delegate');
    const text = task.trim();
    if (!text) throw invalidParams('task 가 비었습니다');
    const target = this.requireChild(leader, toMemberId, '위임');

    const row = this.store.createTask({
      departmentId: leader.departmentId,
      fromMember: leader.id,
      toMember: target.id,
      instruction: text,
      status: 'queued',
    });
    const assigned = this.dispatchTask(row.id);
    this.appendEvent(
      leader,
      'delegating',
      { tool: 'delegate', summary: truncate(oneLine(text), 300), to: target.id, toName: target.name, status: assigned ? 'assigned' : 'queued' },
      { taskId: row.id },
    );
    this.emitStatus(leader.id, leader.status); // derived: 팀장이 idle 이면 waiting_reports 로 바뀐다
    return { task: this.store.getTask(row.id)!, to: target, assigned };
  }

  /**
   * `report`(전원). 그 task 가 **부른 사람에게 배정된 것**이어야 한다(아니면 isError — 남의 task 를 닫지 못한다).
   * 발행자가 사용자면 내 책상 보고(`reporting` 이벤트 + report_text — 부장의 보고가 여기로 온다), 상위 멤버면
   * **그 상위(부모) 단위로** 버퍼링해서 `[REPORTS …]` 로 올린다(T35: 팀장 전용이 아니라 트리 어느 간선이든 같다).
   * 이 도구로 닫힌 task 는 `reported` 가 되므로 턴 종료(`Stop`)의 v1a 보고 승격이 같은 task 를 두 번 보고하지 않는다.
   */
  teamReport(memberId: string, input: TeamReportInput): { task: Task; to: 'user' | 'parent' } {
    const member = this.requireToolRank(memberId, 'report');
    const summary = input.summary.trim();
    if (!summary) throw invalidParams('summary 가 비었습니다');
    if (input.status !== 'done' && input.status !== 'blocked' && input.status !== 'aborted') {
      throw invalidParams(`모르는 status: ${String(input.status)} (done|blocked|aborted)`);
    }
    const task = this.store.getTask(input.taskId);
    if (!task) throw notFound('task', `#${input.taskId}`);
    if (task.toMember !== memberId) {
      throw new OfficeError(RPC_ERROR.RANK_RULE, `task#${task.id} 은(는) 당신에게 배정된 작업이 아닙니다 — 받은 [TASK#n] 의 번호로 보고하세요`);
    }
    if (task.status === 'reported') throw badState(`task#${task.id} 은(는) 이미 보고됐습니다`);
    if (task.status === 'aborted') throw badState(`task#${task.id} 은(는) 중단된 작업입니다`);

    const body = reportBody(summary, input.files);
    this.store.updateTask(task.id, { status: 'reported', reportStatus: input.status, reportText: body });
    this.inFlight.delete(task.id);
    const detail: OfficeEvent['detail'] = { summary: truncate(body, 300), status: input.status };
    if (input.files?.length) detail.files = input.files;
    this.appendEvent(member, 'reporting', detail, { taskId: task.id });

    const to = task.fromMember === USER_ACTOR ? 'user' : 'parent';
    if (to === 'parent') this.bufferReport(task.fromMember, { taskId: task.id, name: member.name, status: input.status, body });
    // 보고가 끝나면 내(=보고자) 파생 상태도 바뀐다(배정 task 0 → free).
    this.emitStatus(member.id, this.store.getMember(member.id)?.status ?? member.status);
    return { task: this.store.getTask(task.id)!, to };
  }

  /**
   * `ask_parent`(팀장·팀원, T35). `ask_user` 와 같은 모양의 pending(question) 을 만들되 받는 쪽이 사용자가 아니라
   * **직속 상사**다: payload `{source:'ask_parent', question, options, from, to}` + `asking{tool:'ask_parent'}` +
   * status `waiting_answer`(파생), 그리고 상사 입력 큐에 `[QUESTION from <이름> q#<id>]` 시스템 메시지.
   * 비블로킹 — 답은 상사의 `reply` 가(또는 사용자가 앱에서 `question.respond` 로 대신) `[ANSWER q#<id>]` 로 넣는다.
   */
  askParent(memberId: string, input: AskUserParams): Pending {
    const member = this.requireToolRank(memberId, 'ask_parent');
    this.liveRuntime(member);
    const parent = this.requireParent(member, 'ask_parent');
    const question = input.question.trim();
    if (!question) throw invalidParams('question is empty');
    const options = (input.options ?? []).map((o) => o.trim()).filter((o) => o.length > 0);
    const payload: AskParentPayload = { source: 'ask_parent', question, options, from: member.id, to: parent.id };
    const pending = this.store.createPending({ memberId, type: 'question', payload: { ...payload } });
    const detail: OfficeEvent['detail'] = { tool: 'ask_parent', summary: question, to: parent.id, toName: parent.name };
    if (options.length > 0) detail.options = options;
    this.appendEvent(member, 'asking', detail, { questionId: pending.id });
    this.setStatus(memberId, 'waiting_answer');
    const rt = this.runtimes.get(parent.id);
    if (rt?.session.alive) rt.queue.enqueue({ kind: 'system', text: buildQuestionText(pending.id, member.name, question, options) });
    else this.notice('warn', `질문을 전달할 상사가 없습니다 — q#${pending.id} (${parent.name})`);
    this.emitStatus(parent.id, this.store.getMember(parent.id)?.status ?? parent.status);
    return pending;
  }

  /**
   * `reply`(부장·팀장, T35). 대상은 **살아 있는 직속 부하**. 그 부하가 나에게 물어 둔 `ask_parent` 질문이 열려 있으면
   * 그것을 답으로 닫고(`[ANSWER q#<id>]`, T17 과 같은 큐 규칙 — 답이 게이트를 먼저 연다), 없으면 그냥
   * `[MESSAGE from <나>]` 로 넣는다(새 일을 시키는 것은 `delegate`).
   */
  teamReply(parentId: string, input: TeamReplyInput): TeamReplyResult {
    const parent = this.requireToolRank(parentId, 'reply');
    const text = input.text.trim();
    if (!text) throw invalidParams('text 가 비었습니다');
    const target = this.requireChild(parent, input.toMember, '답장');
    this.liveRuntime(target);
    const open = this.store
      .listOpenPending(target.id)
      .find((p) => p.type === 'question' && isAskParentPayload(p.payload) && p.payload.to === parent.id);
    if (open && isAskParentPayload(open.payload)) {
      this.answerAskUser(open, { [open.payload.question]: text });
      return { to: target, questionId: open.id };
    }
    const rt = this.runtimes.get(target.id)!;
    rt.queue.enqueue({ kind: 'system', text: buildMessageText(parent.name, text) });
    return { to: target };
  }

  /**
   * 상위 멤버에게 올라가는 보고 버퍼(01 §TeamTools, T35 에서 팀장 전용 → **부모 단위**로 일반화).
   * `blocked` 는 즉시 단독 전달, 그 외는 모아 두었다가 **그 부모가 발행한 미종료 task 가 0 이 되는 순간**
   * 한 덩어리 + `[ALL_REPORTS_IN]`. 팀원 → 팀장 → 부장 어느 간선이든 같은 규칙이다.
   */
  private bufferReport(leaderId: string, line: ReportLine): void {
    if (line.status === 'blocked') {
      this.deliverReports(leaderId, [line], false);
      // T35: `blocked` 가 **마지막** 미종료 task 였으면 버퍼에 쌓여 있던 done 보고가 갈 곳을 잃는다 — 이어서 흘린다.
      this.flushReportBuffer(leaderId);
      return;
    }
    const buf = this.reportBuffer.get(leaderId) ?? [];
    buf.push(line);
    this.reportBuffer.set(leaderId, buf);
    this.flushReportBuffer(leaderId);
  }

  /** 그 부모가 발행한 미종료 task 가 0 이면 버퍼를 한 덩어리 + `[ALL_REPORTS_IN]` 로 흘린다. 아니면 그대로 둔다. */
  private flushReportBuffer(leaderId: string): void {
    const buf = this.reportBuffer.get(leaderId);
    if (!buf?.length) return;
    if (this.store.openTasksIssuedBy(leaderId).length > 0) return; // 아직 기다릴 보고가 남았다
    this.reportBuffer.delete(leaderId);
    this.deliverReports(leaderId, buf, true);
  }

  /** 보고 덩어리를 그 task 를 발행한 상사의 입력 큐에 넣는다. 상사가 없거나 이미 나갔으면 알림만(보고는 tasks 에 남아 있다). */
  private deliverReports(leaderId: string, lines: ReportLine[], allIn: boolean): void {
    if (lines.length === 0) return;
    const leader = this.store.getMember(leaderId);
    const rt = this.runtimes.get(leaderId);
    if (!leader || GONE.has(leader.status) || !rt?.session.alive) {
      this.notice('warn', `보고를 전달할 상사가 없습니다 — ${lines.map((l) => `task#${l.taskId}`).join(', ')} (${leaderId})`);
      return;
    }
    rt.queue.enqueue({ kind: 'system', text: buildReportsText(lines, allIn) });
    this.emitStatus(leaderId, leader.status); // derived: 남은 발행 task 가 0 이면 waiting_reports 가 풀린다
  }

  // ---- 내부: 공통 후처리(T28 → T36 트리) ---------------------------------------------------
  //
  // interrupt / 퇴근 / 비정상 종료 / 재시작 / 팀·부서 삭제 / 상위 정리 / 데몬 복구는 전부 이 문 하나로 들어간다.
  // 이유별로 무엇이 다른지는 afterCare.ts 의 SETTLE_MATRIX 표에만 적혀 있다
  // (01 §"interrupt / fire / error 공통 후처리" + §"직무 체계 rev 3" 후처리).

  /** 후처리 한 번. `opts.expireQuestions` 는 `recover` 에서 되살릴 세션이 아예 없는 멤버용(`ask_*` 질문까지 만료). */
  private settle(memberId: string, reason: SettleReason, opts: { expireQuestions?: boolean } = {}): SettleSummary {
    return settleMember(this.store, this.settleCtx(), memberId, reason, opts);
  }

  /** afterCare 가 부르는 부작용 묶음. Office 안에서만 만든다. */
  private settleCtx(): SettleCtx {
    return {
      expireAllPending: (id) => this.adapterOf(id).expireAllForMember(id),
      cancelHolds: (id) => this.adapterOf(id).cancelHolds(id),
      endSession: (id) => this.endChildSession(id),
      releaseShellLocks: (id) => this.releaseShellLocks(id),
      disposeMcp: (id) => this.disposeMcp(id),
      isAlive: (id) => this.runtimes.get(id)?.session.alive === true,
      interrupt: (id) => this.interrupt(id),
      appendEvent: (member, kind, detail, ref) => this.appendEvent(member, kind, detail, ref),
      deliverReports: (leaderId, lines, allIn) => this.deliverReports(leaderId, lines, allIn),
      dropReportBuffer: (leaderId) => this.reportBuffer.delete(leaderId),
      forgetInFlight: (taskId) => this.inFlight.delete(taskId),
      syncDerived: (id) => this.syncDerived(id),
      notice: (level, message) => this.notice(level, message),
    };
  }

  /**
   * 하위 트리 정리(T36)에서 부하 하나의 세션을 끝낸다. 후처리(`parentGone`)는 `settleMember` 가 이미 마쳤고
   * 여기서는 프로세스만 거둔다: 큐를 비우고 정중히 종료 → `exited`. 종료 대기는 `childExits` 에 모아 두고
   * 퇴근·삭제 경로가 반환 전에 기다린다(팀·부서 행을 지우기 전에 자식이 다 나가 있어야 한다).
   * `[TEAM] -<이름>` 알림은 내지 않는다 — 받을 상사가 바로 지금 사라지는 중이다.
   */
  private endChildSession(memberId: string): void {
    const rt = this.runtimes.get(memberId);
    if (rt?.session.alive) {
      rt.exitMode = 'clockOut';
      rt.queue.clear();
      rt.queue.stop();
      this.childExits.push(
        this.pty.kill(memberId, { graceful: true, timeoutMs: KILL_TIMEOUT_MS }).catch((err) => {
          this.notice('warn', `${this.memberLabel(memberId)} 종료 실패(상위 정리): ${errMsg(err)}`);
        }),
      );
    }
    this.finishMember(memberId, 'clocked out (상위 정리)');
  }

  /** `endChildSession` 이 띄운 종료를 전부 기다린다. 퇴근·팀/부서 삭제가 반환 전에 부른다. */
  private async drainChildExits(): Promise<void> {
    while (this.childExits.length > 0) await this.childExits.shift();
  }

  /** task 하나를 입력 큐에 넣는다(대상이 지금 받을 수 있을 때만). 넣었으면 true. */
  private dispatchTask(taskId: number): boolean {
    const task = this.store.getTask(taskId);
    if (!task || task.status !== 'queued' || this.inFlight.has(taskId)) return false;
    const rt = this.runtimes.get(task.toMember);
    if (!rt?.session.alive) return false;
    if (!this.isIdle(task.toMember)) return false; // 진행 중이거나 열린 허가·질문이 있다
    this.enqueueTask(rt, task);
    this.store.updateTask(task.id, { status: 'assigned' });
    return true;
  }

  /**
   * 유휴 감시(T25): 멤버가 idle 이 되는 순간 그 멤버 앞으로 밀려 있던 `queued` task 를 id 순으로 큐에 넣는다.
   * `emitStatus`(status → idle)에서 부른다 — 어댑터가 store 를 먼저 갱신하고 emit 하므로 여기서 본 상태가 최신이다.
   */
  private dispatchQueuedTasks(memberId: string): void {
    for (const task of this.store.listTasks({ toMember: memberId, status: 'queued' })) this.dispatchTask(task.id);
  }

  /** 입력 큐에 task 를 넣고 inFlight 에 등록. 사용자 지시는 `instruct`, 위임은 `system` 항목이다. */
  private enqueueTask(rt: MemberRuntime, task: Task): void {
    this.inFlight.add(task.id);
    const fromUser = task.fromMember === USER_ACTOR;
    const from = fromUser ? undefined : this.store.getMember(task.fromMember);
    const fromName = fromUser ? USER_ACTOR : (from?.name ?? task.fromMember);
    rt.queue.enqueue({ kind: fromUser ? 'instruct' : 'system', text: taskMessage(task, fromName, from?.rank), id: String(task.id) });
  }

  /**
   * 구성이 바뀌었다고 그 멤버의 **직속 상사**에게 알린다(01 §4, T34 에서 팀 단위 → 트리 간선 단위).
   * 상사 본인이 한 일(hire/dismiss)에는 부르지 않는다 — 자기가 한 일이다.
   */
  private notifyParent(member: Member, text: string): void {
    const parent = member.parentId ? this.store.getMember(member.parentId) : undefined;
    if (!parent || GONE.has(parent.status)) return;
    const rt = this.runtimes.get(parent.id);
    if (!rt?.session.alive) return;
    rt.queue.enqueue({ kind: 'system', text });
  }

  /** `${dataDir}/sessions/<memberId>/mcp.json` — Claude `--mcp-config` 용. 스폰 때마다 다시 쓴다(포트·토큰이 바뀔 수 있다). */
  mcpConfigPath(memberId: string): string {
    return path.join(this.cfg.dataDir, 'sessions', memberId, 'mcp.json');
  }

  /** 그 멤버의 TeamTools MCP 엔드포인트. Claude 는 mcp.json 안에, Codex 는 `-c mcp_servers.team.url=` 인자에 들어간다. */
  mcpUrl(member: Member): string {
    const port = this.info?.mcpPort ?? this.cfg.mcpPort;
    return `http://127.0.0.1:${port}/mcp/${member.memberToken}`;
  }

  private writeMcpConfig(member: Member): string {
    const file = this.mcpConfigPath(member.id);
    const body = { mcpServers: { [TEAM_MCP_NAME]: { type: 'http', url: this.mcpUrl(member) } } };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(body, null, 2));
    return file;
  }

  private openPending(pendingId: string, type: Pending['type']): Pending {
    const pending = this.store.getPending(pendingId);
    if (!pending) throw notFound('pending', pendingId);
    if (pending.type !== type) throw invalidParams(`pending ${pendingId} is a ${pending.type}, not ${type}`);
    if (pending.status !== 'open') throw badState(`pending ${pendingId} already ${pending.status}`);
    return pending;
  }

  private autoAllowSet(memberId: string): Set<string> {
    let s = this.autoAllow.get(memberId);
    if (!s) this.autoAllow.set(memberId, (s = new Set()));
    return s;
  }

  /** alwaysThisSession 로 기억한 도구의 허가 요청은 adapter 가 이벤트를 다 낸 뒤(다음 매크로태스크) 자동 allow. */
  private maybeAutoAllow(pending: Pending): void {
    if (pending.type !== 'approval') return;
    const tool = pending.payload.tool_name;
    if (typeof tool !== 'string' || !this.autoAllow.get(pending.memberId)?.has(tool)) return;
    setImmediate(() => {
      if (this.store.getPending(pending.id)?.status !== 'open') return;
      if (this.adapterOf(pending.memberId).resolveApproval(pending.id, { behavior: 'allow' })) {
        this.notice('info', `auto-allowed ${tool} for ${pending.memberId} (always this session)`);
      }
    });
  }

  // ---- 내부: 스폰·종료 -------------------------------------------------------------------

  /** CLI 스폰 + ScreenModel + InputQueue. 이전 런타임(죽은 세션의 화면)은 버린다. */
  private spawnMember(member: Member, resume: boolean): MemberRuntime {
    const old = this.runtimes.get(member.id);
    if (old?.session.alive) throw badState(`member ${member.id} already has a live session`);
    const attached = old?.attached ?? new Set<string>();
    const lastAttached = old?.lastAttached;
    this.disposeRuntime(member.id);

    const cols = this.cfg.cols;
    const rows = this.cfg.rows;
    const session = this.pty.spawn({
      memberId: member.id,
      memberToken: member.memberToken,
      engine: member.engine,
      cwd: member.cwd,
      resumeSessionId: resume && member.sessionId ? member.sessionId : undefined,
      cols,
      rows,
      hookScriptPath: this.hookScriptPath,
      hookPort: this.info?.hookPort ?? this.cfg.hookPort,
      // T43: Claude 세션에만 statusLine 을 넣는다(Codex 에는 그런 설정이 없다).
      statusLineScriptPath: member.engine === 'claude' ? this.statusLineScriptPath : undefined,
      // TeamTools MCP: Claude 는 mcp.json + `--mcp-config`(T17), Codex 는 `-c mcp_servers.team.url=…`(T22).
      mcpConfigPath: member.engine === 'claude' ? this.writeMcpConfig(member) : undefined,
      mcpUrl: member.engine === 'codex' ? this.mcpUrl(member) : undefined,
    });
    const screen = new ScreenModel({ engine: member.engine, cols, rows });
    const queue = new InputQueue({ session, screen, isIdle: () => this.isIdle(member.id) });
    const rt: MemberRuntime = { memberId: member.id, session, screen, queue, attached, lastAttached };
    this.runtimes.set(member.id, rt);

    queue.on('flushed', (item) => {
      // id 는 task 번호(instruct·위임 system) 또는 pending id(`[ANSWER q#…]`) — 숫자인 것만 task 다.
      if ((item.kind !== 'instruct' && item.kind !== 'system') || !item.id) return;
      const taskId = Number(item.id);
      if (!Number.isInteger(taskId)) return;
      this.inFlight.delete(taskId);
      const task = this.store.getTask(taskId);
      if (task?.status === 'queued') this.store.updateTask(task.id, { status: 'assigned' });
    });
    queue.on('dialogPassed', (kind) => this.notice('info', `${member.name}: passed first-run dialog (${kind})`));
    // 통과할 수 없는 다이얼로그(CLI 자체 허가 프롬프트 등, D-26). InputQueue 가 kind 당 한 번만 내므로 알림도 한 번이다.
    queue.on('dialogBlocked', (kind) => this.noticeDialogBlocked(member.id, kind));
    // Enter 가 안 먹어 다시 보냈다(T42 — Codex resume 직후). 정보성: 큐는 스스로 회복한다.
    queue.on('submitRetried', (_item, attempt) => this.notice('info', `${member.name}: 프롬프트가 안 들어가 Enter 를 다시 보냄 (${attempt})`));
    // 재시도를 다 썼는데도 안 들어갔다 — 텍스트가 입력 상자에 남아 있다. 사용자가 터미널 탭에서 Enter 를 치면 된다.
    queue.on('submitLost', () => this.notice('warn', `${member.name}: 지시가 입력 상자에 남아 제출되지 않았습니다 — 터미널 탭에서 Enter 를 쳐 주세요`));
    queue.start();

    this.store.updateMember(member.id, { childPid: session.pid, status: 'starting' });
    this.emitStatus(member.id, 'starting');
    // Codex 는 SessionStart 가 첫 프롬프트 때 오므로(T20 실측) 화면으로 부팅 완료를 판정한다.
    if (member.engine === 'codex') this.watchBootReady(rt);
    // 턴 종료 hook 없이 프롬프트로 돌아오는 화면(T23 함정 1)의 idle 폴백. 엔진 공통, 세션 내내.
    this.watchScreenIdle(rt);
    return rt;
  }

  /** 자동 통과할 수 없는 다이얼로그가 떠 있다는 알림(D-26). 허가 프롬프트는 사용자가 카드나 터미널 탭에서 답해야 한다. */
  private noticeDialogBlocked(memberId: string, kind: string): void {
    const name = this.store.getMember(memberId)?.name ?? memberId;
    if (kind === 'approval-prompt') {
      this.notice('warn', `${name}: CLI 허가 프롬프트가 떠 있음 — 카드로 답하거나 터미널에서 직접 답하세요`);
      return;
    }
    this.notice('warn', `${name}: 자동 통과할 수 없는 다이얼로그(${kind}) — 터미널에서 직접 답하세요`);
  }

  /**
   * starting → (화면이 prompt ready) → idle. Codex 전용(BOOT_WATCH_MS 주석 참고). SessionStart hook 이 먼저 와서
   * status 가 바뀌면 바로 멈춘다. 첫 실행 다이얼로그가 떠 있는 동안은 ready 로 보지 않는다(InputQueue 가 통과시킨다).
   */
  private watchBootReady(rt: MemberRuntime): void {
    if (rt.bootWatch) clearInterval(rt.bootWatch);
    const deadline = Date.now() + BOOT_WATCH_MS;
    const stop = () => {
      clearInterval(timer);
      rt.bootWatch = undefined;
    };
    const timer = setInterval(() => {
      const member = this.store.getMember(rt.memberId);
      if (!member || !rt.session.alive || member.status !== 'starting') return stop();
      if (Date.now() > deadline) {
        this.notice('warn', `${member.name}: CLI 가 준비 화면에 도달하지 못했습니다(터미널 탭을 확인하세요)`);
        return stop();
      }
      if (rt.screen.detectDialog().kind !== 'none' || !rt.screen.promptReady()) return;
      this.setStatus(member.id, 'idle');
      stop();
    }, BOOT_WATCH_STEP_MS);
    timer.unref();
    rt.bootWatch = timer;
  }

  /**
   * 화면 기반 idle 폴백(T23b, D-25 — IDLE_SCREEN_STABLE_MS 주석 참고). `watchBootReady` 와 같은 모양으로 IDLE_SCREEN_STEP_MS
   * 마다 화면을 본다. 발화 조건(전부 만족이 IDLE_SCREEN_STABLE_MS 이상 연속):
   *   - status 가 working / waiting_approval / waiting_answer 이고
   *   - 그 멤버에게 열린 pending(허가·질문)이 하나도 없고 — 보류 중에는 절대 발화하지 않는다
   *   - 화면에 다이얼로그가 없고 busy 표시도 없고 prompt ready 이고
   *   - 그 창 안에 그 멤버의 새 hook 이 도착하지 않았다(hook 이 오면 창을 다시 연다)
   * 조건이 하나라도 깨지면 창을 닫는다(다음에 처음부터 다시 잰다). 세션이 끝나면(프로세스 종료·퇴근) 타이머를 멈춘다.
   */
  private watchScreenIdle(rt: MemberRuntime): void {
    if (rt.idleWatch) clearInterval(rt.idleWatch);
    rt.screenIdleSince = undefined;
    const stop = () => {
      clearInterval(timer);
      rt.idleWatch = undefined;
      rt.screenIdleSince = undefined;
    };
    const timer = setInterval(() => {
      const member = this.store.getMember(rt.memberId);
      if (!member || !rt.session.alive) return stop();
      const now = Date.now();
      if (!this.screenLooksIdle(member, rt)) {
        rt.screenIdleSince = undefined;
        return;
      }
      // 창이 열려 있는 동안 hook 이 왔으면(턴이 살아 있다) 처음부터 다시.
      if (rt.screenIdleSince === undefined || (rt.lastHookAt !== undefined && rt.lastHookAt >= rt.screenIdleSince)) {
        rt.screenIdleSince = now;
        return;
      }
      if (now - rt.screenIdleSince < IDLE_SCREEN_STABLE_MS) return;
      rt.screenIdleSince = undefined;
      this.appendEvent(member, 'idle', { summary: SCREEN_IDLE_SUMMARY });
      this.setStatus(member.id, 'idle');
      // T43: Stop 없이 끝난 턴에서도 사용량은 갱신돼야 한다(Codex 한도가 이 경로로 들어오는 일이 있다).
      this.refreshMemberUsage(member.id, null);
    }, IDLE_SCREEN_STEP_MS);
    timer.unref();
    rt.idleWatch = timer;
  }

  /** 화면 기반 idle 폴백의 한 번 판정(status·보류·화면). 테스트가 조건을 하나씩 뒤집어 본다. */
  private screenLooksIdle(member: Member, rt: MemberRuntime): boolean {
    if (!IDLE_SCREEN_STATUSES.has(member.status)) return false;
    if (this.store.listOpenPending(member.id).length > 0) return false;
    if (rt.screen.detectDialog().kind !== 'none') return false;
    if (rt.screen.busyIndicator()) return false;
    return rt.screen.promptReady();
  }

  // ---- 내부: 재시작 복구(T09) ----------------------------------------------------------------

  /**
   * 기동 시 이전 기동의 멤버를 되살린다(01 §데몬 재시작 복구, §실측 "프로세스 수명": 데몬이 죽으면 ConPTY 자식도 죽는다).
   *   - status 가 starting/idle/working/waiting_* 인 멤버: session_id 있으면 `--resume` 재스폰 + [RESUMED](진행 task·최근 이벤트 요약)
   *     + queued task 를 id 순으로 다시 큐에. 없으면 error(재고용으로 새 세션).
   *   - 열린 approval 은 전부 expired(hook 프로세스가 죽었으므로), 열린 question 은 TUI AskUserQuestion(payload.tool_input)만 expired
   *     — M2 `ask_user`/`ask_parent`(턴 종료 상태) 질문은 그대로 유효.
   *   - assigned task 는 그대로(멤버가 이어서 진행), queued 는 재큐잉.
   *   - **트리 순서**(부장 → 팀장 → 팀원, T36)로 되살린다. 부하가 먼저 깨어나 보고를 올리면 받을 상사가 아직 없다.
   *     상사가 되살아나지 못한(`exited`/`error`) 부하는 `error{summary:'restart: parent gone'}` 로 두고 재스폰하지 않는다 —
   *     받을 사람 없는 세션을 깨워 봐야 보고가 갈 곳이 없다. 사용자가 부서를 다시 세우거나 `rehire` 로 되살린다.
   * 멤버 하나가 실패해도 나머지는 계속한다. 절대 throw 하지 않는다.
   */
  private recover(): RecoveryResult {
    const result: RecoveryResult = { resumed: [], failed: [], expired: [], requeued: [], orphansKilled: [] };
    let members: Member[];
    try {
      members = this.recoverOrder(this.store.listMembers().filter((m) => RECOVERABLE.has(m.status)));
    } catch (err) {
      console.error('[office] recover: listMembers failed:', err);
      return result;
    }
    for (const member of members) {
      try {
        this.recoverMember(member, result);
      } catch (err) {
        console.error(`[office] recover ${member.id} (${member.name}) failed:`, err);
        this.markRecoveryFailure(member, `restart: recovery failed: ${errMsg(err)}`, result);
      }
    }
    if (members.length > 0 || result.expired.length > 0) {
      let message = `복구: ${result.resumed.length}명 재개, ${result.expired.length}건 만료`;
      if (result.failed.length > 0) message += `, ${result.failed.length}명 재개 불가`;
      if (result.orphansKilled.length > 0) message += `, 유령 ${result.orphansKilled.length}개 정리`;
      this.notice('info', message);
    }
    return result;
  }

  private recoverMember(member: Member, result: RecoveryResult): void {
    this.reapOrphanOf(member, result);
    // 트리 순서 복구(T36): 내 상사가 이미 되살아나지 못했으면 나도 깨우지 않는다 — 보고가 갈 곳이 없다.
    const parent = member.parentId ? this.store.getMember(member.parentId) : undefined;
    const parentGone = member.parentId !== null && (!parent || GONE.has(parent.status));
    // 요약은 복구가 새 이벤트를 쓰기 전(=죽기 직전 모습)에 뜬다.
    const assigned = this.store.listTasks({ toMember: member.id, status: 'assigned' });
    const queued = this.store.listTasks({ toMember: member.id, status: 'queued' });
    const recent = this.store.eventsQuery({ memberId: member.id, limit: RESUMED_EVENT_COUNT });
    const expired = this.expirePendingForRestart(member, !member.sessionId || parentGone);
    result.expired.push(...expired.map((p) => p.id));

    if (parentGone) {
      this.markRecoveryFailure(member, 'restart: parent gone', result);
      return;
    }
    if (!member.sessionId) {
      this.markRecoveryFailure(member, 'restart: no session id to resume', result);
      return;
    }

    // 상위 직급의 [RESUMED] 에는 "내가 낸 일 + 직속 부하" 가 같이 실린다 — 깨어나자마자 누구를 기다리는지 알아야 한다.
    const resumedText = buildResumedText({
      assigned,
      events: recent,
      expiredCount: expired.length,
      issued: this.store.openTasksIssuedBy(member.id),
      children: this.store.childrenOf(member.id),
    });
    let rt: MemberRuntime;
    try {
      rt = this.spawnMember(member, true);
    } catch (err) {
      this.markRecoveryFailure(member, `restart: spawn failed: ${errMsg(err)}`, result);
      return;
    }
    rt.resumeFallback = { until: Date.now() + this.fallbackWindowMs, resumedText };
    this.enqueueResumed(rt, resumedText, queued);
    result.resumed.push(member.id);
    result.requeued.push(...queued.map((t) => t.id));
    console.log(
      `[office] recover ${member.name}(${member.id}): --resume ${member.sessionId}, assigned ${assigned.length}, requeued ${queued.length}, expired ${expired.length}`,
    );
  }

  /**
   * 이전 데몬이 하드 킬돼 살아남은 자식(child_pid)이 있으면 `--resume` 전에 종료한다(orphans.ts). 그대로 두면 같은 토큰으로
   * 새 데몬에 hook 을 보내고 세션 파일을 쥔다. 이름이 엔진과 다르면(pid 재사용) 건드리지 않고 경고만.
   */
  private reapOrphanOf(member: Member, result: RecoveryResult): void {
    const pid = member.childPid;
    if (!pid) return;
    try {
      const verdict = reapOrphan(this.orphanOps, pid, member.engine);
      if (verdict.action === 'killed') {
        result.orphansKilled.push(pid);
        this.notice('warn', `복구: ${member.name} 의 이전 프로세스(pid ${pid})가 살아 있어 종료함`);
      } else if (verdict.action === 'skipped') {
        this.notice('warn', `복구: ${member.name} 의 이전 pid ${pid} 를 건드리지 않음 — ${verdict.reason}`);
      }
    } catch (err) {
      console.warn(`[office] recover ${member.id}: orphan check for pid ${pid} failed:`, err);
    }
  }

  /**
   * [RESUMED] 를 먼저, 그 뒤에 queued task 를 id 순으로(원래 `instruct` 와 같은 모양이라 flush 시 assigned 가 된다).
   * 발행자가 팀장인 task(위임, T25)는 `[TASK#n from <팀장>(팀장)]` 봉투로 들어간다.
   */
  private enqueueResumed(rt: MemberRuntime, resumedText: string, queued: Task[]): void {
    rt.queue.enqueue({ kind: 'system', text: resumedText });
    for (const task of [...queued].sort((a, b) => a.id - b.id)) this.enqueueTask(rt, task);
  }

  /**
   * 재시작으로 무효가 된 pending 을 expired 로 + `error{summary:'재지시 필요…', pendingId}`(D-15 와 같은 모양).
   * approval 전부, question 은 payload.tool_input 이 있는 것(TUI AskUserQuestion)만. all=true 면(멤버가 error 로 가는 경우) 전부.
   */
  private expirePendingForRestart(member: Member, all: boolean): Pending[] {
    // T28: 후처리 표의 `recover` 행이 이 규칙을 그대로 들고 있다(만료 + D-15 모양의 error 이벤트, task 는 건드리지 않음).
    return this.settle(member.id, 'recover', { expireQuestions: all }).expiredPending;
  }

  /** 되살리지 못한 멤버: error 이벤트 + status error + 미종료 task aborted(01 §error 공통 후처리). 재고용은 사용자 몫. */
  private markRecoveryFailure(member: Member, summary: string, result: RecoveryResult): void {
    if (!result.failed.includes(member.id)) result.failed.push(member.id);
    try {
      this.disposeRuntime(member.id);
      this.store.abortTasksFor(member.id);
      this.appendEvent(member, 'error', { summary });
      this.store.updateMember(member.id, { childPid: null });
      this.setStatus(member.id, 'error');
      console.warn(`[office] recover ${member.name}(${member.id}): ${summary}`);
    } catch (err) {
      console.error(`[office] recover ${member.id}: marking error failed:`, err);
    }
  }

  /**
   * `--resume` 폴백: 창 안에 0 이 아닌 코드로 죽으면 세션 파일이 없는 것으로 보고 session_id 를 지운 뒤 새 세션으로 한 번 더.
   * 처리했으면 true(일반 exit 처리는 건너뛴다).
   */
  private tryResumeFallback(rt: MemberRuntime, info: ExitInfo): boolean {
    const fb = rt.resumeFallback;
    if (!fb || info.exitCode === 0 || Date.now() > fb.until) return false;
    const member = this.store.getMember(rt.memberId);
    if (!member) return false;
    this.adapterOf(member.id).expireAllForMember(member.id);
    this.store.updateMember(member.id, { childPid: null, sessionId: null });
    this.appendEvent(member, 'error', { summary: 'resume failed; started fresh session', exitCode: info.exitCode, sessionId: member.sessionId });
    const queued = this.store.listTasks({ toMember: member.id, status: 'queued' });
    let fresh: MemberRuntime;
    try {
      fresh = this.spawnMember(this.store.getMember(member.id)!, false);
    } catch (err) {
      this.notice('error', `복구: ${member.name} 새 세션 시작 실패: ${errMsg(err)}`);
      this.appendEvent(member, 'error', { summary: `restart: spawn failed: ${errMsg(err)}` });
      this.store.abortTasksFor(member.id);
      this.setStatus(member.id, 'error');
      return true;
    }
    this.enqueueResumed(fresh, fb.resumedText, queued);
    this.notice('warn', `복구: ${member.name} 세션 재개 실패(code ${info.exitCode}) → 새 세션으로 시작`);
    return true;
  }

  private onPtyExit(memberId: string, info: ExitInfo): void {
    this.releaseShellLocks(memberId); // T27 후처리(퇴근·재시작·크래시 공통)
    const rt = this.runtimes.get(memberId);
    if (rt) {
      rt.queue.stop();
      rt.queue.clear();
      clearWatches(rt);
    }
    this.disposeMcp(memberId);
    const mode = rt?.exitMode;
    if (mode === 'shutdown') return;
    if (rt && !mode && this.tryResumeFallback(rt, info)) return;
    this.store.updateMember(memberId, { childPid: null });
    if (mode === 'clockOut' || mode === 'restart') {
      // 데몬이 의도한 종료: error 이벤트 없이 status 만. 재시작은 곧 같은 세션이 돌아오므로 턴 종료 질문
      // (`ask_user`/`ask_parent`)을 살려 둔다(D-36) — 보류만 끊는다. 퇴근은 되살릴 세션이 없으니 전부 만료.
      const adapter = this.adapterOf(memberId);
      adapter.cancelHolds(memberId);
      adapter.expirePendingFor(memberId, { keepTurnEndingQuestions: mode === 'restart' });
      this.setStatus(memberId, 'exited');
      return;
    }
    // 예상 못 한 종료(사용자 /exit, 크래시): 어댑터가 error 이벤트 + exited/error, pending 만료.
    this.adapterOf(memberId).onSessionExit(memberId, info.exitCode);
    // T28: 나머지 후처리(내 task aborted + 발행자 보고 / 팀장이면 발행 task 정리 + 팀원 중단 / 셸 락 / MCP)는 표 하나로.
    this.settle(memberId, 'error');
  }

  /** 퇴근 마무리: 흔적 이벤트 + status exited. MCP 연결도 끊는다(프로세스 없이 status 만 살아 있던 행 포함). */
  private finishMember(memberId: string, summary: string): void {
    const member = this.store.getMember(memberId);
    if (!member) return;
    this.disposeMcp(memberId);
    this.appendEvent(member, 'idle', { summary });
    this.setStatus(memberId, 'exited');
    this.store.updateMember(memberId, { childPid: null });
  }

  private disposeRuntime(memberId: string): void {
    this.disposeMcp(memberId);
    const rt = this.runtimes.get(memberId);
    if (!rt) return;
    rt.queue.stop();
    clearWatches(rt);
    rt.screen.dispose();
    this.runtimes.delete(memberId);
  }

  /** 그 멤버의 MCP 연결을 끊는다(퇴근·종료·재스폰 전). 멤버 행이 없으면 무시. */
  private disposeMcp(memberId: string): void {
    const token = this.store.getMember(memberId)?.memberToken;
    if (token) this.mcp.dispose(token);
  }

  /** Ctrl+C 후: 화면에 중단 안내 또는 준비 문구가 보이면 idle(설계 §실측 "중단"). 최대 INTERRUPT_WATCH_MS. */
  private watchInterrupted(rt: MemberRuntime): void {
    if (rt.interruptWatch) clearInterval(rt.interruptWatch);
    const deadline = Date.now() + INTERRUPT_WATCH_MS;
    const stop = () => {
      clearInterval(timer);
      rt.interruptWatch = undefined;
    };
    const timer = setInterval(() => {
      const member = this.store.getMember(rt.memberId);
      if (!member || !rt.session.alive || Date.now() > deadline || member.status !== 'working') return stop();
      if (rt.screen.interrupted() || rt.screen.promptReady()) {
        this.appendEvent(member, 'idle', { summary: 'interrupted' });
        this.setStatus(member.id, 'idle');
        stop();
      }
    }, INTERRUPT_WATCH_STEP_MS);
    timer.unref();
    rt.interruptWatch = timer;
  }

  private applySize(rt: MemberRuntime, cols: number, rows: number): void {
    if (rt.screen.cols === cols && rt.screen.rows === rows) return;
    rt.screen.resize(cols, rows);
    if (rt.session.alive) rt.session.resize(cols, rows);
  }

  // ---- 내부: 팀 셸 뮤텍스(T27) ------------------------------------------------------------

  /**
   * `AdapterDeps.toolGate`: 셸 도구(읽기 전용 제외)의 PreToolUse 를 팀 락이 풀릴 때까지 보류한다.
   * **첫 await 전까지 동기**로 돌아야 한다 — hook 도착 순서가 곧 획득 순서다. 절대 reject 하지 않는다(D-11).
   */
  private shellGate(memberId: string, tool: string, input: unknown, ctx: ToolGateContext): Promise<void> {
    const member = this.store.getMember(memberId);
    if (!member) return Promise.resolve();
    const cmd = shellLockCommand(tool, input);
    if (cmd === null) return Promise.resolve(); // 셸이 아니거나 읽기 전용(D-27)
    // T34: 락 범위는 **부서**다 — 한 부서의 팀들은 같은 cwd 를 쓰므로(D-32) 팀 단위로는 서로를 못 막는다.
    return this.shell.acquire(member.departmentId, memberId, ctx.toolUseId, cmd, { signal: ctx.signal });
  }

  /** 도구 완료(PostToolUse / PostToolUseFailure)로 그 도구 호출이 쥔 락을 푼다. */
  private releaseShellLock(memberId: string, toolUseId: string | null): void {
    const departmentId = this.store.getMember(memberId)?.departmentId;
    if (departmentId) this.shell.release(departmentId, memberId, toolUseId);
  }

  /** 후처리 안전망(Stop·interrupt·fire·퇴근·프로세스 종료): 그 멤버의 락·대기 자리를 전부 정리. */
  private releaseShellLocks(memberId: string): void {
    this.shell.releaseAllFor(memberId);
  }

  /**
   * 셸 락을 기다리기 시작했다 → `running{waiting:'shell-lock'}` 한 번(PROTOCOL.md "오피스 이벤트").
   * status 는 `working` 그대로다 — CLI 는 도구를 부른 채 우리 응답을 기다리는 중이다.
   */
  private noticeShellWait(info: ShellLockInfo, holder: ShellLockInfo): void {
    const member = this.store.getMember(info.memberId);
    if (!member) return;
    const detail: OfficeEvent['detail'] = {
      summary: `셸 대기 중 (락: ${this.memberLabel(holder.memberId)})`,
      waiting: 'shell-lock',
      holder: holder.memberId,
    };
    if (info.cmd) detail.cmd = truncate(info.cmd, 300);
    this.appendEvent(member, 'running', detail);
  }

  private memberLabel(memberId: string): string {
    return this.store.getMember(memberId)?.name ?? memberId;
  }

  // ---- 내부: 사용량 (T43, D-45) -----------------------------------------------------------

  /**
   * 그 멤버의 기록 파일 꼬리를 다시 읽어 사용량을 갱신한다(턴 종료 · 화면 idle 폴백).
   * `transcriptPath` 가 없으면 마지막으로 본 경로를 쓴다. **비동기이고 절대 던지지 않는다** — 사용량은
   * 참고 정보라 실패하면 이전 값을 그대로 두는 게 맞다(설계 §알려진 한계).
   */
  private refreshMemberUsage(memberId: string, transcriptPath: string | null): void {
    const member = this.store.getMember(memberId);
    if (!member) return;
    const rt = this.runtimes.get(memberId);
    if (transcriptPath && rt) rt.transcriptPath = transcriptPath;
    const file = transcriptPath ?? rt?.transcriptPath ?? null;
    if (!file) return;
    void this.usage.applyTurnEnd({ id: member.id, engine: member.engine }, file).catch((err) => {
      console.warn(`[office] 사용량 갱신 실패(${memberId}):`, err);
    });
  }

  // ---- 내부: 배선 -------------------------------------------------------------------------

  private wire(): void {
    // 엔진 어댑터는 같은 이벤트를 낸다(HooksAdapterEvents) — 배선도 같다.
    for (const adapter of this.allAdapters()) {
      adapter.on('event', (ev) => {
        this.emit('event', ev);
        this.afterOfficeEvent(ev);
      });
      adapter.on('status', (memberId, status) => this.emitStatus(memberId, status));
      adapter.on('pendingCreated', (p) => this.maybeAutoAllow(p));
      // T27: 도구 완료(PostToolUse / PostToolUseFailure) = 셸 락 해제 조건 1번(01 §해제 표).
      adapter.on('toolDone', (memberId, info) => this.releaseShellLock(memberId, info.toolUseId));
      // T43: 턴 종료 → 기록 파일 꼬리 읽기(비동기, 실패해도 조용히 이전 값 유지).
      adapter.on('turnEnd', (memberId, transcriptPath) => this.refreshMemberUsage(memberId, transcriptPath));
      adapter.on('handler-error', (err, memberId, event) => this.notice('error', `hook ${event} handler failed for ${memberId}: ${errMsg(err)}`));
    }

    // T43: 사용량이 **바뀔 때만** 알림으로 흘린다(비영속·seq 없음). 계산은 UsageTracker 한 곳에서만 한다.
    this.usage.on('engine', (u) => this.emit('usage.engine', u));
    this.usage.on('member', (u) => this.emit('usage.member', u));

    // T27: 대기·강제 해제는 사용자에게 보여야 한다(대기는 이벤트, 강제 해제는 알림).
    this.shell.on('waiting', (info, holder) => this.noticeShellWait(info, holder));
    this.shell.on('warn', (info, message) => this.notice('warn', `${this.memberLabel(info.memberId)}: ${message}${info.cmd ? ` (${truncate(info.cmd, 80)})` : ''}`));

    this.receiver.on('hook', (req) => {
      const member = this.store.getMemberByToken(req.memberToken);
      if (!member) {
        // respond 하지 않으면 receiver 가 '{}' 로 닫는다.
        this.notice('warn', `hook ${req.event} from unknown member token ${req.memberToken.slice(0, 8)}…`);
        return;
      }
      // 화면 기반 idle 폴백(D-25)의 "그 사이 새 hook 없음" 판정용 — 어댑터가 status 를 어떻게 바꾸든 도착 자체를 기록한다.
      const rt = this.runtimes.get(member.id);
      if (rt) {
        rt.lastHookAt = Date.now();
        // T43: 사용량 꼬리 읽기는 이 경로를 쓴다. 모든 hook 이 transcript_path 를 들고 온다(실측 T43-0 Q1/Q6)
        // — 화면 idle 폴백처럼 hook 이 없는 턴 종료에서도 마지막 경로가 필요하다.
        if (typeof req.payload.transcript_path === 'string' && req.payload.transcript_path) {
          rt.transcriptPath = req.payload.transcript_path;
        }
      }
      // T20: 멤버의 engine 으로 어댑터를 고른다(Codex 는 명령 휴리스틱 매핑 + Interrupt hook).
      this.adapterFor(member.engine).handleHook(req, member);
    });
    // T43: statusLine 스크립트가 보낸 사용량 → UsageTracker, 응답은 터미널 하단에 찍을 한 줄.
    this.receiver.on('status-line', (req) => {
      const member = this.store.getMemberByToken(req.memberToken);
      if (!member) return; // receiver 가 404 로 닫는다(isKnownMember 가 먼저 거른다)
      const rt = this.runtimes.get(member.id);
      if (rt && typeof req.payload.transcript_path === 'string' && req.payload.transcript_path) {
        rt.transcriptPath = req.payload.transcript_path;
      }
      try {
        req.respond(this.usage.applyStatusLine({ id: member.id, engine: member.engine }, req.payload));
      } catch (err) {
        // 상태 줄 하나 때문에 TUI 가 멈추면 안 된다 — 빈 줄로 닫고 로그만 남긴다.
        console.warn(`[office] statusLine 처리 실패(${member.id}):`, err);
        req.respond('');
      }
    });
    this.receiver.on('hold-timeout', (h) => {
      this.adapterForToken(h.memberToken).onHoldTimeout(h.memberToken, h.event);
      this.notice('warn', `hook ${h.event} hold timed out for ${this.memberName(h.memberToken)}; answer in terminal`);
    });
    this.receiver.on('hold-closed', (h) => this.adapterForToken(h.memberToken).onHoldClosed(h.memberToken, h.event));
    this.receiver.on('bad-payload', (info) => this.notice('warn', `hook ${info.event}: bad payload (${info.error})`));
    this.receiver.on('handler-error', (err, req) => this.notice('error', `hook ${req.event} listener threw: ${errMsg(err)}`));

    this.pty.on('data', (memberId, chunk) => {
      const rt = this.runtimes.get(memberId);
      if (rt) rt.screen.feed(chunk).catch(() => {});
      this.emit('term', memberId, chunk);
    });
    this.pty.on('exit', (memberId, info) => this.onPtyExit(memberId, info));
    this.pty.on('warn', (memberId, message) => this.notice('warn', `[${memberId}] ${message}`));
  }

  /**
   * v1a 보고: Stop 의 text 를 기억했다가 idle 에서 assigned task 를 reported 로(01 §TeamTools "사용자 지시도 task").
   * 엔진 공통이다 — Codex 도 `report` 도구 없이 이 경로로 보고가 올라간다(T22 "보고 폴백").
   * 그 앞에 Codex 전용 질문 폴백이 있다(아래).
   */
  private afterOfficeEvent(ev: OfficeEvent): void {
    const rt = this.runtimes.get(ev.memberId);
    if (ev.kind === 'text' && typeof ev.detail.text === 'string' && rt) rt.lastText = ev.detail.text;
    // T27 안전망: 턴이 끝났는데(Stop·세션 종료) 락이 남아 있으면 푼다 — PostToolUse 가 유실돼도 팀이 굳지 않는다.
    if (ev.kind === 'idle') this.releaseShellLocks(ev.memberId);
    if (ev.kind !== 'idle' || ev.detail.summary !== undefined) return;
    const member = this.store.getMember(ev.memberId);
    if (!member) return;
    // Codex 폴백(T22): 질문으로 끝난 턴은 "끝난 작업"이 아니다 — 질문 pending 을 만들고 task 는 assigned 로 둔다.
    if (member.engine === 'codex' && this.codexQuestionFallback(member, rt?.lastText)) {
      // 같은 문장으로 다음 턴에 또 묻지 않도록 비운다(마지막 메시지가 없는 턴이 이어질 수 있다).
      if (rt) rt.lastText = undefined;
      return;
    }
    // T29 결함 ②(T35): **열린 질문으로 끝낸 턴도 "끝난 작업"이 아니다.** `ask_user`/`ask_parent` 를 부르고 답을 기다리려고
    // 턴을 끝냈는데 그대로 승격하면 사용자 task 가 "질문했습니다" 한마디로 닫혀 버리고, 답을 받은 뒤의 진짜 `report` 가
    // "이미 보고됐습니다" 로 거절된다(v1a 시연에서 실제로 났다). 답이 들어오면 pending 이 닫히므로 그다음 턴에서 승격된다.
    if (this.store.listOpenPending(ev.memberId).some((p) => p.type === 'question')) return;
    // T25(실기에서 잡은 함정, D-29): 상위가 delegate 해 놓고 **보고를 기다리려고** 턴을 끝낸 것도 "끝난 작업"이 아니다.
    // 발행한 미종료 task 가 하나라도 있으면 건너뛴다 — `[ALL_REPORTS_IN]` 뒤 턴에서 닫히거나 `report` 도구가 닫는다.
    if (this.store.openTasksIssuedBy(ev.memberId).length > 0) return;
    for (const task of this.store.listTasks({ toMember: ev.memberId, status: 'assigned' })) {
      const reportText = rt?.lastText ?? null;
      this.store.updateTask(task.id, { status: 'reported', reportStatus: 'done', reportText });
      this.appendEvent(member, 'reporting', { summary: reportText ? truncate(reportText, 300) : `task#${task.id} done` }, { taskId: task.id });
      // T25: 위임받은 task 를 `report` 도구 없이 턴만 끝낸 경우에도 팀장에게는 보고가 올라가야 한다 — 같은 버퍼를 탄다.
      // (팀장이 `[ALL_REPORTS_IN]` 을 영영 못 받고 굳는 것을 막는 안전망. `report` 로 이미 닫힌 task 는 여기 오지 않는다.)
      if (task.fromMember !== USER_ACTOR) {
        this.bufferReport(task.fromMember, { taskId: task.id, name: member.name, status: 'done', body: reportText ?? `task#${task.id} done` });
      }
    }
  }

  /**
   * Codex 질문 폴백(T22, 01 §"Codex 멤버 폴백(v1)"): 턴 종료 메시지가 질문처럼 보이면(`?`/`？` 로 끝나거나 정해진 표현)
   * TeamTools `ask_user` 와 **같은 모양의** pending(question) 을 만든다 — 앱의 질문 카드·내 책상 줄서기·재시작 복구
   * (D-19: ask_user 질문은 살아남는다)가 그대로 동작한다. 다른 점은 payload 의 `fallback` 표식뿐이다: 기다리는 MCP 호출이
   * 없으므로 답은 `[ANSWER q#…]` 가 아니라 **보통 프롬프트**로 들어간다(answerAskUser).
   * status 는 idle 그대로 두고(턴이 끝났다) 파생만 `waiting_answer` 로 갱신한다.
   * 만들었으면 true(그 턴은 보고로 치지 않는다).
   */
  private codexQuestionFallback(member: Member, lastText: string | undefined): boolean {
    if (!this.runtimes.get(member.id)?.session.alive) return false;
    const question = detectQuestion(lastText);
    if (!question) return false;
    // 이미 열린 질문이 있으면(ask_user 를 제대로 부른 턴 등) 두 번 묻지 않는다.
    if (this.store.listOpenPending(member.id).some((p) => p.type === 'question')) return false;
    const payload: FallbackQuestionPayload = { source: 'ask_user', question, options: [], fallback: CODEX_FALLBACK };
    const pending = this.store.createPending({ memberId: member.id, type: 'question', payload: { ...payload } });
    this.appendEvent(member, 'asking', { tool: 'ask_user', summary: question, fallback: CODEX_FALLBACK }, { questionId: pending.id });
    this.emitStatus(member.id, this.store.getMember(member.id)?.status ?? 'idle');
    return true;
  }

  // ---- 내부: 유틸 ------------------------------------------------------------------------

  private isIdle(memberId: string): boolean {
    const m = this.store.getMember(memberId);
    return m?.status === 'idle' && this.store.listOpenPending(memberId).length === 0;
  }

  /** 파생 상태(01 §2, T28). 규칙은 derived.ts 하나에만 있고 snapshot·`member.status` 알림이 같이 쓴다. */
  private derived(memberId: string, status: MemberStatus): DerivedStatus {
    const m = this.store.getMember(memberId);
    return m ? derivedStatus(m, this.store, status) : status;
  }

  private emitStatus(memberId: string, status: MemberStatus): void {
    const derived = this.derived(memberId, status);
    this.lastDerived.set(memberId, derived);
    this.emit('status', memberId, status, derived);
    // T25 유휴 감시: 유휴가 되는 순간 밀려 있던 위임(queued)을 전달한다. 게이트는 dispatchTask 가 다시 본다.
    if (status === 'idle') this.dispatchQueuedTasks(memberId);
  }

  /**
   * raw status 는 그대로인데 **파생만** 바뀐 경우에도 알린다(T28 — T17 의 `ask_user` 예외를 일반화).
   * 예: 팀장이 idle 인 채로 위임을 하면 free → waiting_reports, 보고가 다 들어오면 다시 free.
   * 값이 그대로면 아무것도 내지 않는다(중복 알림 방지).
   */
  private syncDerived(memberId: string): void {
    const m = this.store.getMember(memberId);
    if (!m) return;
    const derived = derivedStatus(m, this.store);
    if (this.lastDerived.get(memberId) === derived) return;
    this.lastDerived.set(memberId, derived);
    this.emit('status', memberId, m.status, derived);
  }

  private setStatus(memberId: string, status: MemberStatus): void {
    const m = this.store.getMember(memberId);
    if (!m) return;
    if (m.status === status) return void this.syncDerived(memberId);
    this.store.updateMember(memberId, { status });
    this.emitStatus(memberId, status);
  }

  private appendEvent(member: Member, kind: OfficeEvent['kind'], detail: OfficeEvent['detail'], ref: OfficeEvent['ref'] = {}): void {
    const ev = this.store.appendEvent({ departmentId: member.departmentId, teamId: member.teamId, memberId: member.id, kind, detail, ref });
    this.emit('event', ev);
  }

  private notice(level: NoticeLevel, message: string): void {
    const log = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    log(`[office] ${message}`);
    this.emit('notice', level, message);
  }

  private member(memberId: string): Member {
    const m = this.store.getMember(memberId);
    if (!m) throw notFound('member', memberId);
    return m;
  }

  private memberName(token: string): string {
    return this.store.getMemberByToken(token)?.name ?? 'unknown member';
  }

  private liveRuntime(member: Member): MemberRuntime {
    const rt = this.runtimes.get(member.id);
    if (!rt?.session.alive) throw badState(`member ${member.id} is ${GONE.has(member.status) ? member.status : 'not running'}`);
    return rt;
  }

  private ensureStarted(): void {
    if (!this.started) throw new OfficeError(RPC_ERROR.BAD_STATE, 'office not started');
  }
}

/**
 * 재시작 복구의 [RESUMED] 본문(01 §데몬 재시작 복구 + T36 트리). 한 문단 — bracketed paste 로 한 프롬프트에 들어간다.
 *   [RESUMED] 데몬이 재시작됐다. 진행 중이던 작업: task#12: <instruction 첫 80자> / 없음.
 *   [맡긴 일(보고 대기): task#13 → <이름>: …] [직속 부하: <이름>(팀장), …]
 *   마지막 확인된 행동: <kind summary>; … (최근 5건, 오래된 것부터) / 없음. [만료된 허가·질문: N건(필요하면 다시 요청하라).]
 *   현재 상태를 점검하고 이어서 진행하라.
 *
 * 가운데 두 칸은 **자식이 있는 직급**(부장·팀장)에만 붙는다 — 되살아난 상사가 "누구를 기다리는 중이었나" 를 모르면
 * 곧 도착할 `[REPORTS …]` 를 문맥 없이 받는다. 잎(팀원)은 배정 task 만 실린다(T09 그대로).
 */
export function buildResumedText(input: {
  assigned: Task[];
  events: OfficeEvent[];
  expiredCount?: number;
  /** 내가 발행해 아직 안 닫힌 task(= 부하 보고 대기). */
  issued?: Task[];
  /** 살아 있는 직속 부하. */
  children?: Member[];
}): string {
  const tasks = input.assigned.length
    ? input.assigned.map((t) => `task#${t.id}: ${oneLine(truncate(t.instruction, RESUMED_INSTRUCTION_CHARS))}`).join(', ')
    : '없음';
  const recent = input.events.slice(-RESUMED_EVENT_COUNT);
  const events = recent.length ? recent.map(describeEvent).join('; ') : '없음';
  const expired = input.expiredCount ? ` 만료된 허가·질문: ${input.expiredCount}건(필요하면 다시 요청하라).` : '';
  const issued = (input.issued ?? []).length
    ? ` 맡긴 일(보고 대기): ${input.issued!.map((t) => `task#${t.id} → ${oneLine(truncate(t.instruction, RESUMED_INSTRUCTION_CHARS))}`).join(', ')}.`
    : '';
  const children = (input.children ?? []).length
    ? ` 직속 부하: ${input.children!.map((m) => `${m.name}(${RESUMED_RANK_LABEL[m.rank]})`).join(', ')}.`
    : '';
  return `[RESUMED] 데몬이 재시작됐다. 진행 중이던 작업: ${tasks}.${issued}${children} 마지막 확인된 행동: ${events}.${expired} 현재 상태를 점검하고 이어서 진행하라.`;
}

/** `[RESUMED]` 의 "직속 부하" 줄에 쓰는 직급 라벨(cli/format.ts · templates.ts 와 같은 말). */
const RESUMED_RANK_LABEL: Record<MemberRank, string> = { head: '부장', lead: '팀장', member: '팀원' };

// ---- TeamTools 문구 빌더 (T25) ------------------------------------------------------------

/**
 * `[TASK#n from user]` / `[TASK#n from <이름>(<직급>)]` + 본문. 위임과 사용자 지시가 같은 봉투를 쓴다.
 * 직급 라벨은 발행자의 rank 에서 온다(T35: 부장 → 팀장 위임이면 `(부장)`).
 */
export function taskMessage(task: Task, fromName: string, fromRank?: MemberRank): string {
  const label = fromRank ? RANK_LABEL[fromRank] : '팀장';
  const from = task.fromMember === USER_ACTOR ? USER_ACTOR : `${fromName}(${label})`;
  return `[TASK#${task.id} from ${from}]\n${task.instruction}`;
}

/**
 * `[QUESTION from <이름> q#<id>]\n<질문>\n(옵션: a | b)` — `ask_parent` 가 **상사 큐**에 넣는 시스템 메시지(T35).
 * 상사는 `reply(to_member, text)` 로 답하고, 그 답은 물은 쪽 큐에 `[ANSWER q#<id>]` 로 들어간다.
 */
export function buildQuestionText(questionId: string, fromName: string, question: string, options: string[] = []): string {
  const head = `[QUESTION from ${fromName} q#${questionId}]\n${question}`;
  return options.length > 0 ? `${head}\n(옵션: ${options.join(' | ')})` : head;
}

/** `[MESSAGE from <상사 이름>]\n<본문>` — 열린 질문이 없을 때 `reply` 가 넣는 시스템 메시지(T35). */
export function buildMessageText(fromName: string, text: string): string {
  return `[MESSAGE from ${fromName}]\n${text}`;
}

/**
 * 팀원 보고 덩어리. `allIn` 이면 마지막에 `[ALL_REPORTS_IN]` 을 붙인다 — 팀장은 그 표시를 보고 "이제 전부 모였다"를 안다.
 *   [REPORTS task#12 이음 status=done]
 *   <요약>
 *
 *   [REPORTS task#13 하루 status=done]
 *   <요약>
 *
 *   [ALL_REPORTS_IN]
 */
export function buildReportsText(lines: ReportLine[], allIn: boolean): string {
  const blocks = lines.map((l) => `[REPORTS task#${l.taskId} ${l.name} status=${l.status}]\n${l.body}`);
  return allIn ? `${blocks.join('\n\n')}\n\n[ALL_REPORTS_IN]` : blocks.join('\n\n');
}

/** report 의 저장·전달 본문. `files` 가 있으면 한 줄 덧붙인다(tasks 에 파일 칸이 따로 없다). */
export function reportBody(summary: string, files?: string[]): string {
  const list = (files ?? []).map((f) => f.trim()).filter((f) => f.length > 0);
  return list.length > 0 ? `${summary}\n파일: ${list.join(', ')}` : summary;
}

/** hire 의 지시문: 첫 줄이 `# 역할: <role>`, 그 아래에 팀장이 준 초안(있으면). */
export function buildRoleInstructions(role: string, body?: string): string {
  const rest = (body ?? '').trim();
  return rest ? `# 역할: ${role}\n\n${rest}\n` : `# 역할: ${role}\n`;
}

/**
 * `# 역할: <role>` 첫 줄을 뺀 나머지(T26b). 비어 있으면 "사용자가 쓴 지시문이 없다" 는 뜻이라 기본 템플릿이 쓰인다.
 * 첫 줄이 역할 줄이 아니면 원문 그대로.
 */
export function bodyBelowRole(instructions?: string): string {
  const text = instructions ?? '';
  if (!roleOf(text)) return text;
  const nl = text.search(/\r?\n/);
  return nl < 0 ? '' : text.slice(nl + 1);
}

/** 지시문 첫 줄의 `# 역할: <role>` 을 되읽는다(`[TEAM]` 알림에 역할을 싣기 위해). */
export function roleOf(instructions?: string): string | undefined {
  const first = (instructions ?? '').split(/\r?\n/, 1)[0] ?? '';
  const m = /^#\s*역할:\s*(.+)$/.exec(first.trim());
  return m ? m[1]!.trim() : undefined;
}

/** `[TEAM] 팀원 변경: +<이름>(<엔진>[, 역할: …])` — 사용자가 팀원을 출근시켰다(01 §4). */
export function teamJoinText(name: string, engine: Engine, role?: string): string {
  return `[TEAM] 팀원 변경: +${name}(${engine}${role ? `, 역할: ${role}` : ''})`;
}

/** `[TEAM] 팀원 변경: -<이름>` — 사용자가 팀원을 퇴근시켰다. */
export function teamLeaveText(name: string): string {
  return `[TEAM] 팀원 변경: -${name}`;
}

/**
 * `[ANSWER q#<id>]\n<답>` — ask_user 답을 멤버에게 넣는 시스템 메시지(01 §TeamTools). 답이 하나면 라벨만, 여럿이면
 * `<question>: <label>` 을 줄마다. 빈 답은 -32602.
 */
export function buildAnswerText(questionId: string, answers: Record<string, string>): string {
  return `[ANSWER q#${questionId}]\n${answerBody(answers)}`;
}

/** 답 본문만(봉투 없음). Codex 질문 폴백(T22)은 이것만 보통 프롬프트로 넣는다. 빈 답은 -32602. */
export function answerBody(answers: Record<string, string>): string {
  const entries = Object.entries(answers).filter(([, v]) => typeof v === 'string' && v.trim().length > 0);
  if (entries.length === 0) throw invalidParams('answers is empty');
  return entries.length === 1 ? entries[0]![1].trim() : entries.map(([q, a]) => `${q}: ${a.trim()}`).join('\n');
}

/** `ask_user` pending 인가(D-19: tool_input 없음 + source 표식). */
export function isAskUserPayload(payload: Record<string, unknown>): payload is Record<string, unknown> & AskUserPayload {
  return payload.source === 'ask_user' && typeof payload.question === 'string' && payload.tool_input === undefined;
}

/** `ask_parent` pending 인가(T35). `ask_user` 와 같은 모양 + `from`/`to` 트리 간선. */
export function isAskParentPayload(payload: Record<string, unknown>): payload is Record<string, unknown> & AskParentPayload {
  return (
    payload.source === 'ask_parent' &&
    typeof payload.question === 'string' &&
    typeof payload.to === 'string' &&
    payload.tool_input === undefined
  );
}

/** 이벤트 한 건 → "kind 요약". 요약은 detail.summary → text → cmd → path → tool 순으로 있는 것. */
function describeEvent(ev: OfficeEvent): string {
  const d = ev.detail;
  const pick = [d.summary, d.text, d.cmd, d.path, d.tool].find((v) => typeof v === 'string' && v.trim().length > 0);
  const summary = typeof pick === 'string' ? oneLine(truncate(pick.trim(), RESUMED_SUMMARY_CHARS)) : '';
  return summary ? `${ev.kind} ${summary}` : ev.kind;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 런타임에 걸린 화면 감시 타이머(interrupt·Codex 부팅·화면 idle 폴백)를 모두 정리한다. */
function clearWatches(rt: MemberRuntime): void {
  if (rt.interruptWatch) clearInterval(rt.interruptWatch);
  rt.interruptWatch = undefined;
  if (rt.bootWatch) clearInterval(rt.bootWatch);
  rt.bootWatch = undefined;
  if (rt.idleWatch) clearInterval(rt.idleWatch);
  rt.idleWatch = undefined;
  rt.screenIdleSince = undefined;
}

function checkSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || cols < COLS_RANGE[0] || cols > COLS_RANGE[1]) throw invalidParams(`cols out of range: ${cols}`);
  if (!Number.isInteger(rows) || rows < ROWS_RANGE[0] || rows > ROWS_RANGE[1]) throw invalidParams(`rows out of range: ${rows}`);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
