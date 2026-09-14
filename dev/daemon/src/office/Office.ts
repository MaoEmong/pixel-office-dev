// Office — 데몬 하나에 하나. Store(T06)·PtyManager(T01)·HookReceiver(T03)·ClaudeHooksAdapter(T04)를 소유하고,
// 멤버마다 ScreenModel(T02)·InputQueue(T05)를 붙여 "출근 → 지시 → 허가/질문 → 퇴근" 을 한 객체의 메서드로 만든다.
// RpcServer(T07)는 OfficeApi 인터페이스만 보고 JSON-RPC 로 옮긴다(PROTOCOL.md). 설계: 01 §구성 요소 1.
//
// 배선(설계 §구성 요소 1 + 각 worklog 의 "남은 것"):
//   HookReceiver 'hook'           → store.getMemberByToken → adapter.handleHook
//   HookReceiver 'hold-timeout'   → adapter.onHoldTimeout   / 'hold-closed' → adapter.onHoldClosed
//   PtyManager  'data'            → ScreenModel.feed + 'term' 이벤트(attach 한 클라이언트)
//   PtyManager  'exit'            → adapter.onSessionExit(예상 못 한 종료) / status exited(퇴근·재시작·셧다운)
//   adapter     'event'/'status'  → 'event' / 'status' 이벤트(전 클라이언트)
//   InputQueue  isIdle            = member.status === 'idle' ∧ 열린 pending 없음
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import pkg from '../../package.json' with { type: 'json' };
import { config as defaultConfig, type Config } from '../config.js';
import { Store } from '../store/Store.js';
import { PtyManager } from '../pty/PtyManager.js';
import { toForwardSlashes } from '../pty/hookSettings.js';
import type { ExitInfo, PtySession } from '../pty/types.js';
import { HookReceiver } from '../hooks/HookReceiver.js';
import { ClaudeHooksAdapter } from '../adapters/ClaudeHooksAdapter.js';
import { ScreenModel } from '../screen/ScreenModel.js';
import { InputQueue } from '../input/InputQueue.js';
import { USER_ACTOR } from '../store/types.js';
import type { EventsQueryInput, Member, MemberStatus, OfficeEvent, Pending, Snapshot, Task, Team } from '../store/types.js';
import { OfficeError, RPC_ERROR, badState, invalidParams, notFound } from './errors.js';
import { defaultOrphanOps, reapOrphan, type OrphanOps } from './orphans.js';
import type {
  ApprovalRespondParams,
  AttachResult,
  ClockInParams,
  CreateTeamParams,
  DaemonInfo,
  DerivedStatus,
  HookReceiverLike,
  NoticeLevel,
  OfficeApi,
  OfficeEvents,
  PtyManagerLike,
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
/** Ctrl+C 를 두 번 연달아 보내면 Claude 가 종료되므로(T05 함정) 이 간격 안의 두 번째 interrupt 는 거절. */
const INTERRUPT_GUARD_MS = 1500;
/** interrupt 후 화면 준비 문구로 idle 을 판정하는 감시 시간·주기(실측: Ctrl+C 에는 Stop hook 이 없다). */
const INTERRUPT_WATCH_MS = 8000;
const INTERRUPT_WATCH_STEP_MS = 250;
/** 정중한 종료 대기(Claude `/exit`). */
const KILL_TIMEOUT_MS = 8000;
const COLS_RANGE = [20, 500] as const;
const ROWS_RANGE = [5, 300] as const;

export interface OfficeOptions {
  /** config.ts 기본값 위에 덮어쓴다(테스트 격리·임시 포트). */
  config?: Partial<Config>;
  /** 생략 시 `${dataDir}/pixel-office.db`. 테스트는 `new Store(':memory:')`. */
  store?: Store;
  pty?: PtyManagerLike;
  receiver?: HookReceiverLike;
  /** hook.js 절대 경로. 기본 src/hooks/hook.js. */
  hookScriptPath?: string;
  version?: string;
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

  readonly store: Store;
  readonly pty: PtyManagerLike;
  readonly receiver: HookReceiverLike;
  readonly adapter: ClaudeHooksAdapter;

  private readonly runtimes = new Map<string, MemberRuntime>();
  /** `alwaysThisSession` 로 자동 allow 할 도구(멤버별, 데몬 메모리에만). */
  private readonly autoAllow = new Map<string, Set<string>>();
  private readonly fallbackWindowMs: number;
  private readonly orphanOps: OrphanOps;
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
    this.version = opts.version ?? (pkg as { version?: string }).version ?? '0.0.0';
    this.hookScriptPath = toForwardSlashes(opts.hookScriptPath ?? path.resolve(import.meta.dirname, '..', 'hooks', 'hook.js'));
    this.store = opts.store ?? new Store(path.join(this.cfg.dataDir, 'pixel-office.db'));
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
    this.adapter = new ClaudeHooksAdapter({
      store: this.store,
      getInstructions: (memberId) => this.readInstructions(memberId) || undefined,
    });
    this.wire();
  }

  // ---- 수명 ------------------------------------------------------------------------

  /** hook 수신 시작 + daemon.json 기록. 두 번 부르면 no-op(같은 info). */
  async start(): Promise<DaemonInfo> {
    if (this.info) return this.info;
    fs.mkdirSync(this.cfg.dataDir, { recursive: true });
    const hookPort = await this.receiver.listen(this.cfg.hookPort);
    this.info = {
      wsPort: this.cfg.wsPort,
      hookPort,
      token: this.token,
      pid: this.pid,
      startedAt: new Date().toISOString(),
      version: this.version,
    };
    this.writeDaemonInfo();
    this.started = true;
    try {
      const pruned = this.store.pruneEvents();
      if (pruned > 0) console.log(`[office] pruned ${pruned} old events`);
    } catch (err) {
      console.warn('[office] pruneEvents failed:', err);
    }
    // 재시작 복구(T09): RPC 클라이언트가 붙기 전에 이전 기동의 멤버를 되살린다. 절대 throw 하지 않는다.
    this.recovery = this.recover();
    return this.info;
  }

  /** 이번 기동의 재시작 복구 결과(start() 전에는 undefined). */
  get recoveryResult(): RecoveryResult | undefined {
    return this.recovery;
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
      if (rt.interruptWatch) clearInterval(rt.interruptWatch);
    }
    await Promise.all(
      this.pty.list().map((s) =>
        this.pty.kill(s.memberId, { graceful: true, timeoutMs: KILL_TIMEOUT_MS }).catch((err) => {
          console.warn(`[office] kill ${s.memberId} failed:`, err);
        }),
      ),
    );
    await this.receiver.close();
    for (const rt of this.runtimes.values()) rt.screen.dispose();
    this.runtimes.clear();
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

  snapshot(): Snapshot {
    return this.store.snapshot();
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

  // ---- 팀 --------------------------------------------------------------------------

  /** v1a: 팀만 만든다(팀장 자동 출근은 M4). leaderEngine 은 값만 검사. */
  createTeam(params: CreateTeamParams): Team {
    if (!fs.existsSync(params.cwd) || !fs.statSync(params.cwd).isDirectory()) throw invalidParams(`cwd is not a directory: ${params.cwd}`);
    if (params.leaderEngine !== 'claude' && params.leaderEngine !== 'codex') throw invalidParams(`unknown engine: ${String(params.leaderEngine)}`);
    return this.store.createTeam({
      name: params.name,
      cwd: path.resolve(params.cwd),
      maxMembers: params.maxMembers,
      allowedEngines: params.allowedEngines,
    });
  }

  /** 멤버 전부 퇴근시킨 뒤 삭제(events 는 남는다). */
  async deleteTeam(teamId: string): Promise<void> {
    const team = this.store.getTeam(teamId);
    if (!team) throw notFound('team', teamId);
    for (const m of this.store.listMembers(teamId)) {
      if (this.runtimes.get(m.id)?.session.alive) await this.clockOut(m.id);
      this.disposeRuntime(m.id);
    }
    this.store.deleteTeam(teamId);
  }

  // ---- 멤버 수명 ---------------------------------------------------------------------

  /** 출근: 멤버 행 생성 → (지시문 저장) → CLI 스폰. v1a 는 rank 'member', hiredBy 'user'. */
  clockIn(params: ClockInParams): Member {
    this.ensureStarted();
    const team = this.store.getTeam(params.teamId);
    if (!team) throw notFound('team', params.teamId);
    if (params.engine !== 'claude' && params.engine !== 'codex') throw invalidParams(`unknown engine: ${String(params.engine)}`);
    if (!team.allowedEngines.includes(params.engine)) throw invalidParams(`engine ${params.engine} not allowed in team ${team.name}`);
    if (!params.name.trim()) throw invalidParams('name is empty');
    const live = this.store.listMembers(team.id).filter((m) => !GONE.has(m.status)).length;
    if (live >= team.maxMembers) throw badState(`team ${team.name} is full (${live}/${team.maxMembers})`);

    const member = this.store.createMember({
      teamId: team.id,
      name: params.name.trim(),
      rank: 'member',
      engine: params.engine,
      cwd: team.cwd,
      hiredBy: 'user',
      status: 'starting',
    });
    if (params.instructions !== undefined) this.setInstructions(member.id, params.instructions);
    this.spawnMember(this.store.getMember(member.id)!, false);
    return this.store.getMember(member.id)!;
  }

  /** 퇴근: 진행 task aborted, pending expired, 정중히 종료. 행은 남긴다(status exited → rehire 가능). */
  async clockOut(memberId: string): Promise<void> {
    const member = this.member(memberId);
    const rt = this.runtimes.get(memberId);
    if (!rt?.session.alive) {
      if (GONE.has(member.status)) throw badState(`member ${memberId} already ${member.status}`);
      // 프로세스 없이 status 만 살아 있는 행(데몬 재시작 후 등) — 상태만 정리한다.
      this.finishMember(memberId, 'clocked out');
      return;
    }
    rt.exitMode = 'clockOut';
    rt.queue.clear();
    rt.queue.stop();
    this.adapter.expireAllForMember(memberId);
    this.store.abortTasksFor(memberId);
    await this.pty.kill(memberId, { graceful: true, timeoutMs: KILL_TIMEOUT_MS });
    this.finishMember(memberId, 'clocked out');
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
      this.adapter.expireAllForMember(memberId);
      await this.pty.kill(memberId, { graceful: true, timeoutMs: KILL_TIMEOUT_MS });
    }
    const fresh = this.spawnMember(this.store.getMember(memberId)!, true);
    fresh.queue.enqueue({ kind: 'system', text: RESUMED_TEXT });
    return this.store.getMember(memberId)!;
  }

  // ---- 입력 ------------------------------------------------------------------------

  /** 사용자 지시 = task(from 'user'). 큐에 `[TASK#n from user]\n<text>` — flush 되면 assigned. */
  instruct(memberId: string, text: string): number {
    const member = this.member(memberId);
    const rt = this.liveRuntime(member);
    if (!text.trim()) throw invalidParams('text is empty');
    const task = this.store.createTask({
      teamId: member.teamId,
      fromMember: USER_ACTOR,
      toMember: memberId,
      instruction: text,
      status: 'queued',
    });
    rt.queue.enqueue({ kind: 'instruct', text: `[TASK#${task.id} from user]\n${text}`, id: String(task.id) });
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
    this.adapter.expireAllForMember(memberId);
    this.store.abortTasksFor(memberId);
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

  getInstructions(memberId: string): string {
    this.member(memberId);
    return this.readInstructions(memberId);
  }

  /** `${dataDir}/teams/<teamId>/members/<memberId>/INSTRUCTIONS.md`. 다음 SessionStart 부터 반영(D-05). */
  setInstructions(memberId: string, markdown: string): void {
    const member = this.member(memberId);
    const file = this.instructionsPath(member.teamId, memberId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, markdown);
    if (member.instructionsPath !== file) this.store.updateMember(memberId, { instructionsPath: file });
  }

  instructionsPath(teamId: string, memberId: string): string {
    return path.join(this.cfg.dataDir, 'teams', teamId, 'members', memberId, 'INSTRUCTIONS.md');
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
    const ok = this.adapter.resolveApproval(pendingId, {
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

  respondQuestion(pendingId: string, answers: Record<string, string>): void {
    this.openPending(pendingId, 'question');
    if (!this.adapter.resolveQuestion(pendingId, answers)) throw badState(`pending ${pendingId} is no longer held (hook already closed)`);
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
      if (this.adapter.resolveApproval(pending.id, { behavior: 'allow' })) {
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
    });
    const screen = new ScreenModel({ engine: member.engine, cols, rows });
    const queue = new InputQueue({ session, screen, isIdle: () => this.isIdle(member.id) });
    const rt: MemberRuntime = { memberId: member.id, session, screen, queue, attached, lastAttached };
    this.runtimes.set(member.id, rt);

    queue.on('flushed', (item) => {
      if (item.kind !== 'instruct' || !item.id) return;
      const task = this.store.getTask(Number(item.id));
      if (task?.status === 'queued') this.store.updateTask(task.id, { status: 'assigned' });
    });
    queue.on('dialogPassed', (kind) => this.notice('info', `${member.name}: passed first-run dialog (${kind})`));
    queue.start();

    this.store.updateMember(member.id, { childPid: session.pid, status: 'starting' });
    this.emitStatus(member.id, 'starting');
    return rt;
  }

  // ---- 내부: 재시작 복구(T09) ----------------------------------------------------------------

  /**
   * 기동 시 이전 기동의 멤버를 되살린다(01 §데몬 재시작 복구, §실측 "프로세스 수명": 데몬이 죽으면 ConPTY 자식도 죽는다).
   *   - status 가 starting/idle/working/waiting_* 인 멤버: session_id 있으면 `--resume` 재스폰 + [RESUMED](진행 task·최근 이벤트 요약)
   *     + queued task 를 id 순으로 다시 큐에. 없으면 error(재고용으로 새 세션).
   *   - 열린 approval 은 전부 expired(hook 프로세스가 죽었으므로), 열린 question 은 TUI AskUserQuestion(payload.tool_input)만 expired
   *     — M2 `ask_user`(턴 종료 상태) 질문은 그대로 유효.
   *   - assigned task 는 그대로(멤버가 이어서 진행), queued 는 재큐잉.
   * 멤버 하나가 실패해도 나머지는 계속한다. 절대 throw 하지 않는다.
   */
  private recover(): RecoveryResult {
    const result: RecoveryResult = { resumed: [], failed: [], expired: [], requeued: [], orphansKilled: [] };
    let members: Member[];
    try {
      members = this.store.listMembers().filter((m) => RECOVERABLE.has(m.status));
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
    // 요약은 복구가 새 이벤트를 쓰기 전(=죽기 직전 모습)에 뜬다.
    const assigned = this.store.listTasks({ toMember: member.id, status: 'assigned' });
    const queued = this.store.listTasks({ toMember: member.id, status: 'queued' });
    const recent = this.store.eventsQuery({ memberId: member.id, limit: RESUMED_EVENT_COUNT });
    const expired = this.expirePendingForRestart(member, !member.sessionId);
    result.expired.push(...expired.map((p) => p.id));

    if (!member.sessionId) {
      this.markRecoveryFailure(member, 'restart: no session id to resume', result);
      return;
    }

    const resumedText = buildResumedText({ assigned, events: recent, expiredCount: expired.length });
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

  /** [RESUMED] 를 먼저, 그 뒤에 queued task 를 id 순으로(원래 `instruct` 와 같은 모양이라 flush 시 assigned 가 된다). */
  private enqueueResumed(rt: MemberRuntime, resumedText: string, queued: Task[]): void {
    rt.queue.enqueue({ kind: 'system', text: resumedText });
    for (const task of [...queued].sort((a, b) => a.id - b.id)) {
      rt.queue.enqueue({ kind: 'instruct', text: `[TASK#${task.id} from user]\n${task.instruction}`, id: String(task.id) });
    }
  }

  /**
   * 재시작으로 무효가 된 pending 을 expired 로 + `error{summary:'재지시 필요…', pendingId}`(D-15 와 같은 모양).
   * approval 전부, question 은 payload.tool_input 이 있는 것(TUI AskUserQuestion)만. all=true 면(멤버가 error 로 가는 경우) 전부.
   */
  private expirePendingForRestart(member: Member, all: boolean): Pending[] {
    const out: Pending[] = [];
    for (const p of this.store.listOpenPending(member.id)) {
      const isTuiQuestion = p.type === 'question' && p.payload.tool_input !== undefined;
      if (!all && p.type === 'question' && !isTuiQuestion) continue;
      const final = this.store.expirePending(p.id);
      if (final?.status !== 'expired') continue;
      out.push(final);
      const summary = p.type === 'approval' ? '재지시 필요: 허가 요청이 재시작으로 만료됨' : '재지시 필요: 질문이 재시작으로 만료됨';
      const ref = p.type === 'approval' ? { approvalId: p.id } : { questionId: p.id };
      this.appendEvent(member, 'error', { summary, pendingId: p.id, pendingType: p.type }, ref);
    }
    return out;
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
    this.adapter.expireAllForMember(member.id);
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
    const rt = this.runtimes.get(memberId);
    if (rt) {
      rt.queue.stop();
      rt.queue.clear();
      if (rt.interruptWatch) clearInterval(rt.interruptWatch);
    }
    const mode = rt?.exitMode;
    if (mode === 'shutdown') return;
    if (rt && !mode && this.tryResumeFallback(rt, info)) return;
    this.store.updateMember(memberId, { childPid: null });
    if (mode === 'clockOut' || mode === 'restart') {
      // 데몬이 의도한 종료: error 이벤트 없이 status 만.
      this.adapter.expireAllForMember(memberId);
      this.setStatus(memberId, 'exited');
      return;
    }
    // 예상 못 한 종료(사용자 /exit, 크래시): 어댑터가 error 이벤트 + exited/error, pending 만료. task 는 여기서 aborted.
    this.adapter.onSessionExit(memberId, info.exitCode);
    this.store.abortTasksFor(memberId);
  }

  /** 퇴근 마무리: 흔적 이벤트 + status exited. */
  private finishMember(memberId: string, summary: string): void {
    const member = this.store.getMember(memberId);
    if (!member) return;
    this.store.abortTasksFor(memberId);
    this.appendEvent(member, 'idle', { summary });
    this.setStatus(memberId, 'exited');
    this.store.updateMember(memberId, { childPid: null });
  }

  private disposeRuntime(memberId: string): void {
    const rt = this.runtimes.get(memberId);
    if (!rt) return;
    rt.queue.stop();
    if (rt.interruptWatch) clearInterval(rt.interruptWatch);
    rt.screen.dispose();
    this.runtimes.delete(memberId);
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

  // ---- 내부: 배선 -------------------------------------------------------------------------

  private wire(): void {
    this.adapter.on('event', (ev) => {
      this.emit('event', ev);
      this.afterOfficeEvent(ev);
    });
    this.adapter.on('status', (memberId, status) => this.emitStatus(memberId, status));
    this.adapter.on('pendingCreated', (p) => this.maybeAutoAllow(p));
    this.adapter.on('handler-error', (err, memberId, event) => this.notice('error', `hook ${event} handler failed for ${memberId}: ${errMsg(err)}`));

    this.receiver.on('hook', (req) => {
      const member = this.store.getMemberByToken(req.memberToken);
      if (!member) {
        // respond 하지 않으면 receiver 가 '{}' 로 닫는다.
        this.notice('warn', `hook ${req.event} from unknown member token ${req.memberToken.slice(0, 8)}…`);
        return;
      }
      this.adapter.handleHook(req, member);
    });
    this.receiver.on('hold-timeout', (h) => {
      this.adapter.onHoldTimeout(h.memberToken, h.event);
      this.notice('warn', `hook ${h.event} hold timed out for ${this.memberName(h.memberToken)}; answer in terminal`);
    });
    this.receiver.on('hold-closed', (h) => this.adapter.onHoldClosed(h.memberToken, h.event));
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

  /** v1a 보고: Stop 의 text 를 기억했다가 idle 에서 assigned task 를 reported 로(01 §TeamTools "사용자 지시도 task"). */
  private afterOfficeEvent(ev: OfficeEvent): void {
    const rt = this.runtimes.get(ev.memberId);
    if (ev.kind === 'text' && typeof ev.detail.text === 'string' && rt) rt.lastText = ev.detail.text;
    if (ev.kind !== 'idle' || ev.detail.summary !== undefined) return;
    const member = this.store.getMember(ev.memberId);
    if (!member) return;
    for (const task of this.store.listTasks({ toMember: ev.memberId, status: 'assigned' })) {
      const reportText = rt?.lastText ?? null;
      this.store.updateTask(task.id, { status: 'reported', reportStatus: 'done', reportText });
      this.appendEvent(member, 'reporting', { summary: reportText ? truncate(reportText, 300) : `task#${task.id} done` }, { taskId: task.id });
    }
  }

  // ---- 내부: 유틸 ------------------------------------------------------------------------

  private isIdle(memberId: string): boolean {
    const m = this.store.getMember(memberId);
    return m?.status === 'idle' && this.store.listOpenPending(memberId).length === 0;
  }

  private derived(memberId: string, status: MemberStatus): DerivedStatus {
    if (status !== 'idle') return status;
    const open = this.store.listTasks({ toMember: memberId, status: ['queued', 'assigned'] });
    return open.length === 0 ? 'free' : 'idle';
  }

  private emitStatus(memberId: string, status: MemberStatus): void {
    this.emit('status', memberId, status, this.derived(memberId, status));
  }

  private setStatus(memberId: string, status: MemberStatus): void {
    const m = this.store.getMember(memberId);
    if (!m || m.status === status) return;
    this.store.updateMember(memberId, { status });
    this.emitStatus(memberId, status);
  }

  private appendEvent(member: Member, kind: OfficeEvent['kind'], detail: OfficeEvent['detail'], ref: OfficeEvent['ref'] = {}): void {
    const ev = this.store.appendEvent({ teamId: member.teamId, memberId: member.id, kind, detail, ref });
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
 * 재시작 복구의 [RESUMED] 본문(01 §데몬 재시작 복구). 한 문단 — bracketed paste 로 한 프롬프트에 들어간다.
 *   [RESUMED] 데몬이 재시작됐다. 진행 중이던 작업: task#12: <instruction 첫 80자> / 없음.
 *   마지막 확인된 행동: <kind summary>; … (최근 5건, 오래된 것부터) / 없음. [만료된 허가·질문: N건(필요하면 다시 요청하라).]
 *   현재 상태를 점검하고 이어서 진행하라.
 */
export function buildResumedText(input: { assigned: Task[]; events: OfficeEvent[]; expiredCount?: number }): string {
  const tasks = input.assigned.length
    ? input.assigned.map((t) => `task#${t.id}: ${oneLine(truncate(t.instruction, RESUMED_INSTRUCTION_CHARS))}`).join(', ')
    : '없음';
  const recent = input.events.slice(-RESUMED_EVENT_COUNT);
  const events = recent.length ? recent.map(describeEvent).join('; ') : '없음';
  const expired = input.expiredCount ? ` 만료된 허가·질문: ${input.expiredCount}건(필요하면 다시 요청하라).` : '';
  return `[RESUMED] 데몬이 재시작됐다. 진행 중이던 작업: ${tasks}. 마지막 확인된 행동: ${events}.${expired} 현재 상태를 점검하고 이어서 진행하라.`;
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
