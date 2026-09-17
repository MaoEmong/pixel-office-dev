// BaseHooksAdapter — hook 요청(Claude Code / Codex CLI)을 오피스 이벤트·멤버 status·pending 으로 정규화하는 공통 뼈대.
// T04 에서 ClaudeHooksAdapter 가 혼자 하던 일을 T20 에서 엔진 둘이 쓰도록 끌어올린 것이다. 두 CLI 의 hook 형식·결정 JSON·
// 보류(hold) 정책이 실측에서 같았으므로(02 §②④) 차이는 **도구 매핑 + 엔진 고유 이벤트** 뿐이고, 그 둘만 훅 포인트로 뺐다.
//
// 공통 매핑 표(엔진 공통 부분):
//   SessionStart        → sessionId 갱신(모든 source) + additionalContext 응답, status idle; source=resume 면 text{summary:'resumed'}
//   UserPromptSubmit    → status working, thinking{text: prompt[:200]}
//   PreToolUse          → mapTool() 결과(reading/editing/running), status working; toolGate 있으면 hold 후 '{}'
//   PermissionRequest   → 질문 도구(isQuestionTool): pending(question) + asking, status waiting_answer, hold
//                          mcp__team__*  : 즉시 allow(사용자에게 안 올림) — D-22
//                          그 외: pending(approval) + waiting_approval, status waiting_approval, hold
//   PostToolUse(Failure)→ toolDone 내부 이벤트, status working (오피스 이벤트 없음)
//   Stop                → text{text: last_assistant_message[:4000]} + idle, status idle
//   SessionEnd          → clear/resume: 없음(새 SessionStart 가 따라옴); 그 외: idle{summary:'session ended: <reason>'}, status exited
//   그 외(Notification, SubagentStop, PreCompact …) → onEngineEvent(기본 pass-through)
//   (pty exit)          → onSessionExit: error 이벤트, status exited(code 0) / error(그 외), pending 전부 expired
//
// 엔진 훅 포인트:
//   label          로그 접두사
//   mapTool        PreToolUse 도구 → 오피스 이벤트(null 이면 이벤트 없음)
//   isQuestionTool PermissionRequest 를 '질문'으로 볼 도구 이름(Claude: AskUserQuestion, Codex: 없음)
//   approvalDetail waiting_approval 이벤트 detail
//   onEngineEvent  그 엔진에만 있는 hook 이벤트(Codex: Interrupt)
import { EventEmitter } from 'node:events';
import type { DecisionHandle, HookRequest } from '../hooks/HookReceiver.js';
import { allow, askAnswers, deny, PASS_THROUGH, sessionStartContext } from '../hooks/decisions.js';
import type { HookPayload } from '../hooks/types.js';
import type { Store } from '../store/Store.js';
import type { EventDetail, EventRef, Member, MemberStatus, OfficeEventKind, Pending } from '../store/types.js';
import { isTurnEndingQuestion } from '../office/derived.js';
import { questionSummary, toolDetail, truncate, type ToolMapping } from './mapping.js';
import type { AdapterDeps, ApprovalDecisionInput, HoldLostReason, HooksAdapterEvents, ToolDoneInfo, ToolGateContext } from './types.js';

/** UserPromptSubmit 의 prompt 를 thinking 말풍선에 싣는 상한. */
export const MAX_THINKING_CHARS = 200;
/** Stop 의 last_assistant_message 를 text 이벤트에 싣는 상한. */
export const MAX_TEXT_CHARS = 4000;
/** deny 에 message 가 없을 때 모델에게 보내는 사유. */
export const DEFAULT_DENY_MESSAGE = 'Denied by user';
/**
 * TeamTools MCP 도구 이름 접두사. 이 도구들의 PermissionRequest 는 사용자에게 올리지 않고 데몬이 바로 allow 한다(D-22):
 * 우리 도구라 부작용이 데몬 안에서만 생기고, 허가 카드가 질문 카드보다 먼저 뜨는 어색한 흐름을 없앤다.
 */
export const TEAM_TOOL_PREFIX = 'mcp__team__';

/** SessionEnd 중 같은 프로세스 안에서 새 SessionStart 가 뒤따르는 reason(종료가 아님). */
const IN_PROCESS_SESSION_END: ReadonlySet<string> = new Set(['clear', 'resume']);

interface HeldPending {
  memberId: string;
  pending: Pending;
  handle: DecisionHandle;
}

/** toolGate 때문에 보류 중인 PreToolUse 하나(T27). 보류가 사라지면 abort 로 게이트에 알린다. */
interface GateHold {
  handle: DecisionHandle;
  abort: AbortController;
}

export abstract class BaseHooksAdapter extends EventEmitter<HooksAdapterEvents> {
  protected readonly store: Store;
  private readonly getInstructions: AdapterDeps['getInstructions'];
  private readonly toolGate: AdapterDeps['toolGate'];
  private readonly now: () => number;
  /** 사용자 답을 기다리는 hook 보류. pendingId → handle. */
  private readonly held = new Map<string, HeldPending>();
  /** toolGate 때문에 보류 중인 PreToolUse. memberId → 보류들. */
  private readonly gateHolds = new Map<string, Set<GateHold>>();

  constructor(deps: AdapterDeps) {
    super();
    this.store = deps.store;
    this.getInstructions = deps.getInstructions;
    this.toolGate = deps.toolGate;
    this.now = deps.now ?? Date.now;
  }

  // ---- 엔진 훅 포인트 ---------------------------------------------------------

  /** 로그 접두사(`[ClaudeHooksAdapter] …`). */
  protected abstract get label(): string;

  /** PreToolUse 의 도구 → 오피스 이벤트. null 이면 이벤트를 내지 않는다. */
  protected abstract mapTool(toolName: string, toolInput: unknown): ToolMapping | null;

  /** 그 도구의 PermissionRequest 를 '질문'(pending question)으로 볼지. Codex 는 항상 false. */
  protected isQuestionTool(_toolName: string): boolean {
    return false;
  }

  /**
   * 우리 TeamTools MCP 도구인지 — 맞으면 사용자에게 올리지 않고 데몬이 바로 allow 한다(D-22).
   * 기본은 Claude 가 붙이는 이름 규칙(`mcp__team__<tool>`). Codex 는 이름 규칙이 달라 어댑터가 넓게 잡는다(T22).
   */
  protected isTeamTool(toolName: string): boolean {
    return toolName.startsWith(TEAM_TOOL_PREFIX);
  }

  /** waiting_approval 이벤트의 detail. 기본은 PreToolUse 와 같은 도구 detail. */
  protected approvalDetail(toolName: string, toolInput: unknown): EventDetail {
    return toolDetail(toolName, toolInput);
  }

  /** 엔진 고유 hook 이벤트(기본: pass-through). Codex 가 Interrupt 를 여기서 처리한다. */
  protected onEngineEvent(req: HookRequest, _member: Member): void {
    req.respond(PASS_THROUGH);
  }

  // ---- 진입점 ---------------------------------------------------------------

  /**
   * HookReceiver 'hook' 리스너에서 호출. emit 중 동기적으로 respond()/hold() 를 결정한다.
   * 절대 throw 하지 않는다 — 예외는 'handler-error' 로 내고 **어떤 경우에도 응답을 내보낸다**(D-11 pass-through).
   *
   * **T30/D-38 딸린 관찰**: 예전에는 catch 가 `req.respond(PASS_THROUGH)` 만 불렀는데, 핸들러가 `req.hold()` **뒤에**
   * 던지면(D-38 의 `createPending` 예외) receiver 계약상 `respond` 가 먹지 않아 hook 프로세스가 영영 매달렸다 =
   * CLI 가 자기 TUI 프롬프트를 띄운 채 멈춘다. 그래서 이 진입점이 `hold()` 를 감싸 **마지막으로 만들어진 핸들**을
   * 들고 있다가 catch 에서 직접 닫는다.
   */
  handleHook(req: HookRequest, member: Member): void {
    let handle: DecisionHandle | undefined;
    // hold() 를 감싼 대리 요청 — 핸들러가 어디서 던지든 그때까지 연 보류를 catch 가 닫을 수 있다.
    const guarded: HookRequest = {
      memberToken: req.memberToken,
      event: req.event,
      payload: req.payload,
      respond: (json) => req.respond(json),
      hold: () => (handle = req.hold()),
    };
    try {
      switch (guarded.event) {
        case 'SessionStart':
          return this.onSessionStart(guarded, member);
        case 'UserPromptSubmit':
          return this.onUserPromptSubmit(guarded, member);
        case 'PreToolUse':
          return this.onPreToolUse(guarded, member);
        case 'PermissionRequest':
          return this.onPermissionRequest(guarded, member);
        case 'PostToolUse':
          return this.onPostToolUse(guarded, member, true);
        case 'PostToolUseFailure':
          return this.onPostToolUse(guarded, member, false);
        case 'Stop':
          return this.onStop(guarded, member);
        case 'SessionEnd':
          return this.onSessionEnd(guarded, member);
        default:
          // Notification, SubagentStop, PreCompact, Interrupt(Codex), 그 외 모르는 이벤트.
          return this.onEngineEvent(guarded, member);
      }
    } catch (err) {
      this.onHandlerError(guarded, member, err, handle);
    }
  }

  /**
   * 핸들러 예외 공통 처리(T30). ① 응답을 반드시 내보낸다(respond 가 먹지 않으면 열린 보류를 pass-through 로 닫는다),
   * ② 멤버에게 `error{summary:'hook handler failed: …'}` 를 남겨 사무실에서 보이게 하고, ③ `handler-error` 로
   * Office 의 `daemon.notice{error}` 를 띄운다.
   */
  private onHandlerError(req: HookRequest, member: Member, err: unknown, handle: DecisionHandle | undefined): void {
    if (!req.respond(PASS_THROUGH) && handle) this.releaseHandle(handle);
    const message = errMsg(err);
    console.error(`[${this.label}] ${req.event} handler failed for ${member.id}:`, err);
    try {
      this.appendEvent(member, 'error', { summary: `hook handler failed: ${message}`, hookEvent: req.event });
    } catch (logErr) {
      // store 자체가 망가진 경우(D-38 이 바로 그랬다) — 이벤트를 못 남겨도 notice 는 나가야 한다.
      console.error(`[${this.label}] handler-error 이벤트 기록 실패:`, logErr);
    }
    this.emit('handler-error', err, member.id, req.event);
  }

  /**
   * 예외로 버려진 보류 하나를 pass-through 로 닫는다. 그 보류에 딸린 pending 행(이미 `held` 에 등록됐다면)은 expired 로,
   * 셸 게이트 보류였다면 대기 줄에서 뺀다(T27 규칙 그대로).
   */
  private releaseHandle(handle: DecisionHandle): void {
    for (const [id, entry] of [...this.held]) {
      if (entry.handle !== handle) continue;
      this.held.delete(id);
      this.expireHeld(entry);
    }
    for (const [memberId, set] of [...this.gateHolds]) {
      for (const g of [...set]) {
        if (g.handle !== handle) continue;
        this.untrackGateHold(memberId, g);
        g.abort.abort();
      }
    }
    if (!handle.settled) handle.resolve(PASS_THROUGH);
  }

  // ---- 사용자 응답 ----------------------------------------------------------

  /** approval pending 에 답한다. 모르는 id·이미 닫힘·type 불일치면 false. */
  resolveApproval(pendingId: string, decision: ApprovalDecisionInput): boolean {
    const entry = this.takeHeld(pendingId, 'approval');
    if (!entry) return false;
    const json =
      decision.behavior === 'allow'
        ? allow(isRecord(decision.updatedInput) ? decision.updatedInput : undefined)
        : deny(decision.message ?? DEFAULT_DENY_MESSAGE);
    entry.handle.resolve(json);
    this.settlePending(entry, decision);
    return true;
  }

  /** question pending(AskUserQuestion) 에 답한다. answers = { "<question>": "<label>" }. */
  resolveQuestion(pendingId: string, answers: Record<string, string>): boolean {
    const entry = this.takeHeld(pendingId, 'question');
    if (!entry) return false;
    const toolInput = entry.pending.payload.tool_input;
    entry.handle.resolve(askAnswers(isRecord(toolInput) ? toolInput : undefined, answers));
    this.settlePending(entry, answers);
    return true;
  }

  // ---- 후처리 ---------------------------------------------------------------

  /**
   * interrupt / fire / error 공통 후처리(01 §구성 요소 1) = `cancelHolds` + `expirePendingFor(all)`.
   * 그 멤버의 보류 hook 을 전부 '{}' 로 닫고 open pending 을 expired 로.
   */
  expireAllForMember(memberId: string): void {
    this.cancelHolds(memberId);
    this.expirePendingFor(memberId);
  }

  /**
   * **보류만** 끊는다(T36/D-36). 응답을 아직 안 돌려준 hook 요청(허가·질문)과 셸 게이트 보류를 '{}' 로 닫는다.
   * pending 행은 건드리지 않는다 — `member.restart` 는 프로세스를 죽이면서도 턴 종료 질문(`ask_user`/`ask_parent`)을
   * 살려 둬야 하는데(D-19), 보류를 안 끊으면 죽는 CLI 가 응답을 기다리며 멈추기 때문에 이 둘이 갈라져야 한다.
   */
  cancelHolds(memberId: string): void {
    for (const [id, entry] of [...this.held]) {
      if (entry.memberId !== memberId) continue;
      this.held.delete(id);
      entry.handle.cancel();
    }
    const gates = this.gateHolds.get(memberId);
    if (gates) {
      this.gateHolds.delete(memberId);
      for (const g of gates) {
        g.handle.cancel();
        g.abort.abort(); // 게이트(셸 뮤텍스)에 "이 보류는 없어졌다" — 대기 줄에서 빼라(T27)
      }
    }
  }

  /**
   * 그 멤버의 열린 pending 을 만료시킨다. `opts.keepTurnEndingQuestions` 면 턴 종료 질문(`ask_user`/`ask_parent`,
   * `tool_input` 없는 질문)은 남긴다(D-19). waiting_* 였으면 status 는 working 으로 되돌린다(CLI 가 다시 주도권을 가짐) —
   * 단 살아남은 질문이 있으면 그대로 둔다.
   */
  expirePendingFor(memberId: string, opts: { keepTurnEndingQuestions?: boolean } = {}): Pending[] {
    const out: Pending[] = [];
    if (opts.keepTurnEndingQuestions) {
      for (const p of this.store.listOpenPending(memberId)) {
        if (isTurnEndingQuestion(p)) continue;
        const final = this.store.expirePending(p.id);
        if (final?.status !== 'expired') continue;
        out.push(final);
        this.emit('pendingSettled', final);
      }
    } else {
      for (const p of this.store.expireAllForMember(memberId)) {
        out.push(p);
        this.emit('pendingSettled', p);
      }
    }
    const current = this.store.getMember(memberId)?.status;
    const stillOpen = this.store.listOpenPending(memberId).length > 0;
    if (!stillOpen && (current === 'waiting_approval' || current === 'waiting_answer')) this.setStatus(memberId, 'working');
    return out;
  }

  /** HookReceiver 'hold-timeout' 연결점: 그 보류에 걸린 pending 을 expired 로(응답은 receiver 가 이미 '{}' 로 보냄). */
  onHoldTimeout(memberToken: string, event: string): void {
    this.onHoldLost(memberToken, event, 'timeout');
  }

  /** HookReceiver 'hold-closed' 연결점: hook 프로세스가 먼저 끊김(CLI 종료·hook timeout). */
  onHoldClosed(memberToken: string, event: string): void {
    this.onHoldLost(memberToken, event, 'closed');
  }

  /**
   * pty 프로세스 종료. status exited(code 0) / error(그 외) + error 이벤트. 열린 pending 은 hook 프로세스와 함께
   * 죽었으므로 전부 expired. SessionEnd 로 이미 exited 인 정상 종료는 이벤트를 중복해서 내지 않는다.
   */
  onSessionExit(memberId: string, exitCode: number): void {
    const member = this.store.getMember(memberId);
    if (!member) return;
    this.expireAllForMember(memberId);
    const clean = exitCode === 0;
    if (clean && member.status === 'exited') return;
    this.appendEvent(member, 'error', { summary: `process exited (code ${exitCode})`, exitCode });
    this.setStatus(memberId, clean ? 'exited' : 'error');
  }

  /** 지금 사용자 답을 기다리는 pending id 목록(디버깅·테스트용). */
  heldPendingIds(memberId?: string): string[] {
    return [...this.held.values()].filter((e) => memberId === undefined || e.memberId === memberId).map((e) => e.pending.id);
  }

  // ---- 이벤트별 핸들러 -------------------------------------------------------

  private onSessionStart(req: HookRequest, member: Member): void {
    const { payload } = req;
    let instructions: string | undefined;
    try {
      instructions = this.getInstructions(member.id);
    } catch (err) {
      console.error(`[${this.label}] getInstructions(${member.id}) failed:`, err);
    }
    req.respond(instructions ? sessionStartContext(instructions) : PASS_THROUGH);

    const source = typeof payload.source === 'string' ? payload.source : 'unknown';
    if (typeof payload.session_id === 'string' && payload.session_id) {
      this.store.updateMember(member.id, { sessionId: payload.session_id });
      this.emit('sessionId', member.id, payload.session_id, source);
    }
    if (source === 'resume') this.appendEvent(member, 'text', { summary: 'resumed' });
    this.setStatus(member.id, 'idle');
  }

  private onUserPromptSubmit(req: HookRequest, member: Member): void {
    req.respond(PASS_THROUGH);
    const prompt = typeof req.payload.prompt === 'string' ? req.payload.prompt : '';
    this.setStatus(member.id, 'working');
    this.appendEvent(member, 'thinking', { text: truncate(prompt, MAX_THINKING_CHARS) });
  }

  private onPreToolUse(req: HookRequest, member: Member): void {
    const toolName = toolNameOf(req.payload);
    const mapped = this.mapTool(toolName, req.payload.tool_input);
    // 도구 이벤트를 **게이트보다 먼저** 남긴다: 게이트(셸 뮤텍스)가 대기 이벤트를 낼 수 있고(T27), 그러면
    // 마지막 이벤트 = "대기 중" 이어야 말풍선이 맞다.
    this.setStatus(member.id, 'working');
    if (mapped) this.appendEvent(member, mapped.kind, mapped.detail);
    const gate = this.toolGate;
    if (!gate || this.isQuestionTool(toolName)) {
      req.respond(PASS_THROUGH);
    } else {
      const handle = req.hold();
      const hold: GateHold = { handle, abort: new AbortController() };
      this.trackGateHold(member.id, hold);
      const ctx: ToolGateContext = {
        toolUseId: typeof req.payload.tool_use_id === 'string' ? req.payload.tool_use_id : null,
        signal: hold.abort.signal,
      };
      // 게이트는 hook 도착 순서대로 **동기** 호출(뮤텍스 획득 순서 보장). reject/throw 돼도 deny 하지 않는다(D-11): 어떤 경우에도 '{}'.
      let gated: Promise<void>;
      try {
        gated = Promise.resolve(gate(member.id, toolName, req.payload.tool_input, ctx));
      } catch (err) {
        gated = Promise.reject(err);
      }
      gated
        .catch((err) => console.error(`[${this.label}] toolGate(${member.id}, ${toolName}) rejected:`, err))
        .finally(() => {
          this.untrackGateHold(member.id, hold);
          handle.resolve(PASS_THROUGH);
        });
    }
  }

  private onPermissionRequest(req: HookRequest, member: Member): void {
    const { payload } = req;
    const toolName = toolNameOf(payload);
    const toolInput = payload.tool_input;

    // D-22: TeamTools MCP 도구(mcp__team__*)는 보류하지 않고 즉시 허가한다. pending/waiting_approval 이벤트 없음
    // (PreToolUse 가 이미 running{tool} 을 남겼다).
    if (this.isTeamTool(toolName)) {
      req.respond(allow());
      return;
    }

    const handle = req.hold();

    if (this.isQuestionTool(toolName)) {
      const questions = isRecord(toolInput) && Array.isArray(toolInput.questions) ? toolInput.questions : [];
      const pending = this.store.createPending({
        memberId: member.id,
        type: 'question',
        payload: { questions, tool_input: toolInput ?? {} },
      });
      this.held.set(pending.id, { memberId: member.id, pending, handle });
      this.emit('pendingCreated', pending);
      const detail: EventDetail = { tool: toolName };
      const summary = questionSummary(toolInput);
      if (summary !== undefined) detail.summary = summary;
      this.appendEvent(member, 'asking', detail, { questionId: pending.id });
      this.setStatus(member.id, 'waiting_answer');
      return;
    }

    const pending = this.store.createPending({
      memberId: member.id,
      type: 'approval',
      payload: {
        tool_name: toolName,
        tool_input: toolInput ?? {},
        permission_suggestions: payload.permission_suggestions ?? null,
      },
    });
    this.held.set(pending.id, { memberId: member.id, pending, handle });
    this.emit('pendingCreated', pending);
    this.appendEvent(member, 'waiting_approval', this.approvalDetail(toolName, toolInput), { approvalId: pending.id });
    this.setStatus(member.id, 'waiting_approval');
  }

  private onPostToolUse(req: HookRequest, member: Member, ok: boolean): void {
    req.respond(PASS_THROUGH);
    const info: ToolDoneInfo = {
      tool: toolNameOf(req.payload),
      ok,
      toolUseId: typeof req.payload.tool_use_id === 'string' ? req.payload.tool_use_id : null,
    };
    if (!ok && typeof req.payload.error === 'string') info.error = req.payload.error;
    this.setStatus(member.id, 'working');
    this.emit('toolDone', member.id, info);
  }

  private onStop(req: HookRequest, member: Member): void {
    req.respond(PASS_THROUGH);
    const msg = req.payload.last_assistant_message;
    if (typeof msg === 'string' && msg.length > 0) {
      this.appendEvent(member, 'text', { text: truncate(msg, MAX_TEXT_CHARS) });
    }
    this.appendEvent(member, 'idle', {});
    this.setStatus(member.id, 'idle');
  }

  private onSessionEnd(req: HookRequest, member: Member): void {
    req.respond(PASS_THROUGH);
    const reason = typeof req.payload.reason === 'string' ? req.payload.reason : 'other';
    if (IN_PROCESS_SESSION_END.has(reason)) return;
    this.appendEvent(member, 'idle', { summary: `session ended: ${reason}` });
    this.setStatus(member.id, 'exited');
  }

  // ---- 내부 유틸 --------------------------------------------------------------

  /** 보류 목록에서 꺼낸다. 이미 receiver 쪽에서 닫혔으면(timeout 등) expired 처리하고 undefined. */
  private takeHeld(pendingId: string, type: Pending['type']): HeldPending | undefined {
    const entry = this.held.get(pendingId);
    if (!entry || entry.pending.type !== type) return undefined;
    this.held.delete(pendingId);
    if (entry.handle.settled) {
      this.expireHeld(entry);
      return undefined;
    }
    return entry;
  }

  private settlePending(entry: HeldPending, answer: unknown): void {
    const final = this.store.answerPending(entry.pending.id, answer) ?? { ...entry.pending, status: 'answered' as const, answer };
    this.setStatus(entry.memberId, 'working');
    this.emit('pendingSettled', final);
  }

  private expireHeld(entry: HeldPending): void {
    const final = this.store.expirePending(entry.pending.id) ?? { ...entry.pending, status: 'expired' as const };
    this.emit('pendingSettled', final);
  }

  private onHoldLost(memberToken: string, event: string, reason: HoldLostReason): void {
    // PreToolUse 게이트 보류(셸 뮤텍스 대기)는 pending 이 없다 — 줄에서만 빼면 된다.
    this.abortLostGateHolds(memberToken, event);
    for (const [id, entry] of [...this.held]) {
      const h = entry.handle;
      if (h.memberToken !== memberToken || h.event !== event || !h.settled) continue;
      this.held.delete(id);
      this.expireHeld(entry);
      const member = this.store.getMember(entry.memberId);
      if (!member) continue;
      // 응답은 '{}'(D-11) 로 나갔으니 CLI 가 자기 TUI 프롬프트를 띄운다 → 내 책상엔 "재지시 필요" 흔적을 남긴다.
      this.appendEvent(member, 'error', {
        summary: reason === 'timeout' ? 'hook hold timed out; answer in terminal' : 'hook connection closed before answer',
        pendingId: entry.pending.id,
        pendingType: entry.pending.type,
      });
      this.setStatus(entry.memberId, 'working');
    }
  }

  private trackGateHold(memberId: string, hold: GateHold): void {
    let set = this.gateHolds.get(memberId);
    if (!set) this.gateHolds.set(memberId, (set = new Set()));
    set.add(hold);
  }

  private untrackGateHold(memberId: string, hold: GateHold): void {
    const set = this.gateHolds.get(memberId);
    if (!set) return;
    set.delete(hold);
    if (set.size === 0) this.gateHolds.delete(memberId);
  }

  /**
   * 보류가 어댑터 결정 없이 닫힌(hold-timeout/hold-closed) PreToolUse 게이트를 정리한다 — 게이트(셸 뮤텍스)에
   * abort 로 알려 대기 줄에서 빼게 한다. 응답은 receiver 가 이미 '{}' 로 보냈으므로 그 명령은 그냥 실행된다(D-11).
   */
  private abortLostGateHolds(memberToken: string, event: string): void {
    for (const [memberId, set] of [...this.gateHolds]) {
      for (const hold of [...set]) {
        const h = hold.handle;
        if (h.memberToken !== memberToken || h.event !== event || !h.settled) continue;
        this.untrackGateHold(memberId, hold);
        hold.abort.abort();
      }
    }
  }

  protected appendEvent(member: Member, kind: OfficeEventKind, detail: EventDetail, ref: EventRef = {}): void {
    const ev = this.store.appendEvent({
      departmentId: member.departmentId,
      teamId: member.teamId,
      memberId: member.id,
      kind,
      detail,
      ref,
      ts: new Date(this.now()).toISOString(),
    });
    this.emit('event', ev);
  }

  /** store 의 현재 status 와 다를 때만 갱신·emit. */
  protected setStatus(memberId: string, status: MemberStatus): void {
    const current = this.store.getMember(memberId);
    if (!current || current.status === status) return;
    this.store.updateMember(memberId, { status });
    this.emit('status', memberId, status);
  }
}

export function toolNameOf(payload: HookPayload): string {
  return typeof payload.tool_name === 'string' && payload.tool_name ? payload.tool_name : 'unknown';
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
