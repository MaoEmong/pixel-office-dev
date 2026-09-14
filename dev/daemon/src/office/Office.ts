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
import type { EventsQueryInput, Member, MemberStatus, OfficeEvent, Pending, Snapshot, Team } from '../store/types.js';
import { OfficeError, RPC_ERROR, badState, invalidParams, notFound } from './errors.js';
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

/** `member.restart` 직후 큐에 넣는 시스템 메시지(01 §데몬 재시작 복구; T09 에서 진행 중 task 요약을 덧붙인다). */
export const RESUMED_TEXT = '[RESUMED] 데몬이 세션을 재시작했다. 현재 상태를 점검하고 이어서 진행하라.';
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
  private info?: DaemonInfo;
  private started = false;
  private stopping = false;

  constructor(opts: OfficeOptions = {}) {
    super();
    this.cfg = { ...defaultConfig, ...opts.config };
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
    return this.info;
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

  private onPtyExit(memberId: string, info: ExitInfo): void {
    const rt = this.runtimes.get(memberId);
    if (rt) {
      rt.queue.stop();
      rt.queue.clear();
      if (rt.interruptWatch) clearInterval(rt.interruptWatch);
    }
    const mode = rt?.exitMode;
    if (mode === 'shutdown') return;
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
