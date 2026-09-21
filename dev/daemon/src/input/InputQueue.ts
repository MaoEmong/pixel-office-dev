// InputQueue — 멤버별 입력 직렬화 큐 (T05, 설계 §구성 요소 1 "입력 직렬화").
//
// 사용자 직접 타이핑(member.type)과 자동 타이핑(instruct, [TASK#n], [REPORTS ...], [ANSWER q#N], [RESUMED])이
// 같은 pty 를 쓰므로 한 곳에서 순서를 정한다. 자동 타이핑은 (a) 어댑터가 idle 이고(진행 중 턴·열린 질문 없음),
// (b) ScreenModel 이 prompt ready 이고, (c) 사용자가 직접 치는 중이 아닐 때(마지막 typeRaw 후 grace 경과)만 flush 한다.
// 첫 실행 다이얼로그(온보딩·폴더 신뢰)는 ScreenModel 감지 + 권장 키로 통과한다(실측 ①④ — 설정 선주입은 안 먹힘).
// 권장 키가 없는 다이얼로그(CLI 자체 허가 프롬프트 `approval-prompt`, D-23)는 통과 대상이 아니다 — 키를 보내지 않고
// blocked('dialog') + dialogBlocked(kind) 로만 알린다(D-26, T23b).
//
// **붙여넣기 ↔ Enter 는 한 덩어리다(T44).** paste 를 보낸 순간부터 제출이 확정될 때까지가 임계 구간이고, 그 사이에
// 들어온 사용자 키(typeRaw)는 pty 로 바로 보내지 않고 모아 뒀다가 구간이 끝나면 순서대로 재생한다 — 그 틈에 들어간
// 키 하나가 지시를 깨뜨리기 때문이다(T42 함정 2: Esc 가 입력 상자를 비워 Enter 가 빈 상자에 떨어져 지시가 증발했다).
// Ctrl+C(interrupt)만은 예외로 절대 모으지 않는다 — 즉시 나가고 예약된 Enter·제출 확인을 취소한다.
//
// 시간은 전부 주입된 now() 기준이고, 지연 동작(키 간격·paste→Enter·busy 창)은 내부 스케줄러에 "언제 실행"으로 적어 두고
// tick() 에서 만기된 것을 실행한다. 그래서 테스트는 setInterval/setTimeout 없이 now() 를 밀고 tick() 만 불러 검증할 수 있다.
// start() 하면 폴링 interval 과, 지연 동작 만기 시점의 setTimeout 이 tick() 을 실제로 깨운다.
import { EventEmitter } from 'node:events';
import type { KeyName } from '../pty/types.js';

/** sendKeys 로 보낼 수 있는 키(PtySession 과 동일). */
export type QueueKey = KeyName;
/** 다이얼로그 통과용 키(tui-map 의 Key 와 동일 — ctrl-c 는 없음). */
export type DialogKey = Exclude<KeyName, 'ctrl-c'>;

export type InputItem =
  /** 사용자 지시. paste(text) 후 Enter. */
  | { kind: 'instruct'; text: string; id?: string }
  /** 데몬 메시지([TASK#n], [REPORTS ...], [ANSWER q#N], [RESUMED]). instruct 와 동일하게 처리. */
  | { kind: 'system'; text: string; id?: string }
  /** 키 시퀀스. 큐를 거치지 않고 즉시 실행(게이트 무시) — 다이얼로그 통과·중단 등. */
  | { kind: 'keys'; keys: QueueKey[] };

/** 큐에 쌓이는(=게이트를 기다리는) 항목. */
export type TextItem = Extract<InputItem, { kind: 'instruct' | 'system' }>;

export type BlockReason = 'not-idle' | 'not-ready' | 'user-typing' | 'dialog';

export interface QueueDeps {
  /** PtySession 의 부분집합. */
  session: { paste(text: string): void; write(text: string): void; sendKeys(k: QueueKey): void };
  /** ScreenModel 의 부분집합. */
  screen: { promptReady(): boolean; detectDialog(): { kind: string; suggestedKeys: readonly DialogKey[]; highlightDriven?: boolean } };
  /** 어댑터 상태가 idle/free 인가(진행 중 턴 없음, 열린 질문 없음). */
  isIdle(): boolean;
  /** 폴링 주기. 기본 500ms. */
  pollMs?: number;
  /** 마지막 사용자 타이핑 후 이 시간이 지나야 자동 타이핑을 flush. 기본 3000ms. */
  userTypingGraceMs?: number;
  /** 시계. 기본 Date.now. 테스트에서 주입. */
  now?(): number;
}

export type InputQueueEvents = {
  /** 항목이 pty 에 완전히 들어감(paste + Enter 까지). */
  flushed: [item: InputItem];
  /**
   * Enter 를 보냈는데 CLI 가 프롬프트를 받지 않아(= submitCheckMs 동안 계속 idle) 한 번 더 보냈다(T42 실기).
   * Codex `resume` 직후가 대표적이다 — 화면은 prompt ready 인데 세션 복원이 끝나기 전이라 Enter 가 먹지 않는다.
   */
  submitRetried: [item: TextItem, attempt: number];
  /** 재시도를 다 쓰고도 프롬프트가 안 들어갔다. 텍스트는 입력 상자에 남아 있다(사용자가 터미널 탭에서 Enter 를 치면 된다). */
  submitLost: [item: TextItem];
  /** 큐 머리를 flush 하지 못한 이유(첫 번째로 걸린 조건). 같은 이유는 blockedEmitIntervalMs 에 한 번만. */
  blocked: [reason: BlockReason];
  /** 다이얼로그를 감지해 권장 키를 보냈다. */
  dialogPassed: [kind: string];
  /**
   * 통과할 수 없는 다이얼로그가 떠 있다(권장 키가 비어 있음 — CLI 자체 허가 프롬프트 `approval-prompt` 등, D-23/D-26).
   * 키는 보내지 않는다. 같은 kind 에 대해 그 다이얼로그가 사라질 때까지 한 번만 낸다.
   */
  dialogBlocked: [kind: string];
};

/** 내부 타이밍 상수. 테스트에서 참조. */
export const TIMING = {
  /** 키 시퀀스에서 키 사이 간격. TUI 가 한 키씩 처리하도록. */
  keySpacingMs: 150,
  /** paste 후 Enter 까지. TUI 가 붙여넣기를 입력 상자에 반영할 시간. */
  enterDelayMs: 300,
  /** Enter 후 다음 항목까지 최소 대기. UserPromptSubmit 이 와서 isIdle 이 false 가 되기 전 공백을 메운다. */
  busyAfterFlushMs: 1500,
  /**
   * Enter 를 보낸 뒤 이 시간이 지나도 계속 idle 이면 "Enter 가 안 먹었다" 로 보고 한 번 더 보낸다(T42).
   * busyAfterFlushMs 보다 넉넉히 커야 한다 — 정상 흐름에서는 그 전에 UserPromptSubmit 이 와서 idle 이 풀린다.
   */
  submitCheckMs: 2500,
  /** 같은 kind 의 다이얼로그에 키를 다시 보내기까지 최소 간격(화면이 아직 안 바뀌었을 때 중복 전송 방지). */
  dialogRepeatGuardMs: 2000,
  /** 같은 이유의 blocked 이벤트 최소 간격. */
  blockedEmitIntervalMs: 5000,
  /**
   * 통과할 수 없는 다이얼로그(`approval-prompt` 등)가 **이만큼 계속 떠 있어야** `dialogBlocked` 를 낸다(T45, D-26).
   *
   * 왜 필요한가(실측, `docs/worklog/T45-UsageAndNotice.md`): MCP 도구(`mcp__team__*`)를 부를 때 CLI 는 자기
   * 허가 프롬프트를 **먼저 그리고**, 곧이어 도착한 `PermissionRequest` hook 의 allow 로 그 화면을 지운다
   * (화면 이력에 `⎿ Allowed by PermissionRequest hook` 가 남는다). 우리 판정은 **틀리지 않았다** — 진짜
   * 허가 프롬프트가 한 프레임 떠 있었다. 다만 **아무도 답할 필요가 없는** 프롬프트라 경고가 거짓이었다.
   *
   * 실측 지속 시간은 **502ms**(폴링 한 판)였고, 두 번 모두 같았다. 진짜 허가 프롬프트(hook 이 없거나 만료된
   * D-16 폴백)는 사람이 답할 때까지 **무한히** 떠 있으므로, "계속 떠 있는가" 하나로 둘이 갈린다.
   * 3초는 그 502ms 에 6배 여유를 둔 값이다(화면 기반 idle 판정의 안정 창과 같은 크기).
   *
   * **큐를 막는 것은 지연되지 않는다** — 다이얼로그를 보는 즉시 `blocked('dialog')` 이고 키도 안 나간다.
   * 늦춰지는 것은 사람에게 보내는 **알림 한 줄**뿐이다.
   */
  dialogBlockedNoticeMs: 3000,
} as const;

/**
 * Enter 재전송 횟수 상한(T42). 총 대기 = SUBMIT_RETRY_MAX × submitCheckMs.
 * 재전송이 헛방이어도 **빈 입력 상자의 Enter 는 두 CLI 모두 무동작**이라 안전하다.
 */
export const SUBMIT_RETRY_MAX = 4;

interface Scheduled {
  dueAt: number;
  run: (now: number) => void;
  /** 취소할 수 있게 하는 이름. 'submit-enter' = paste 뒤에 나갈 Enter(중단이 들어오면 지운다, T44). */
  tag?: 'submit-enter';
}

export class InputQueue extends EventEmitter<InputQueueEvents> {
  private readonly deps: QueueDeps;
  private readonly pollMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;

  private readonly queue: TextItem[] = [];
  private readonly scheduled: Scheduled[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private interval: NodeJS.Timeout | undefined;
  private running = false;

  private lastUserTypingAt = Number.NEGATIVE_INFINITY;
  private busyUntil = Number.NEGATIVE_INFINITY;
  /** 다이얼로그 kind → 마지막으로 보낸 키와 시각. 같은 키를 가드 안에 또 보내지 않기 위한 것(T36). */
  private readonly lastDialogAt = new Map<string, { at: number; keys: DialogKey[] }>();
  private readonly lastBlockedAt = new Map<BlockReason, number>();
  /** 지금 막고 있는(통과 키가 없는) 다이얼로그 kind. 그 다이얼로그가 사라지거나 다른 kind 로 바뀌면 지운다. */
  private blockedDialogKind: string | undefined;
  /** 그 다이얼로그를 **연속으로** 보기 시작한 시각. `dialogBlockedNoticeMs` 를 재는 기준(T45). */
  private blockedDialogSince = Number.POSITIVE_INFINITY;
  /** 그 구간에 `dialogBlocked` 를 이미 냈는가. 다이얼로그가 사라지면 false 로 돌아간다. */
  private blockedDialogNoticed = false;
  /** Enter 를 보내고 "프롬프트가 실제로 들어갔는지" 를 확인하는 중인 항목(T42). 들어가면(= idle 이 풀리면) 지운다. */
  private awaitingSubmit: { item: TextItem; enterAt: number; attempt: number } | undefined;
  /**
   * 붙여넣기 ↔ Enter 임계 구간(T44). paste 부터 제출 확정(또는 포기·다이얼로그·중단)까지 열려 있고,
   * 그 사이 사용자가 친 키를 순서대로 모아 둔다. 구간이 끝나면 모은 것을 그대로 pty 에 흘린다.
   */
  private critical: { buffer: string[] } | undefined;

  constructor(deps: QueueDeps) {
    super();
    this.deps = deps;
    this.pollMs = deps.pollMs ?? 500;
    this.graceMs = deps.userTypingGraceMs ?? 3000;
    this.now = deps.now ?? Date.now;
  }

  /** instruct/system 은 FIFO 에 넣고 바로 한 번 평가한다. keys 는 큐를 거치지 않고 즉시 보낸다. */
  enqueue(item: InputItem): void {
    if (item.kind === 'keys') {
      this.sendKeySequence(item.keys);
      return;
    }
    this.queue.push(item);
    this.tick();
  }

  /**
   * 터미널 탭에서의 직접 타이핑. 평소에는 게이트 없이 즉시 쓰고 grace 창의 기준 시각을 갱신한다.
   *
   * **임계 구간(paste ~ 제출 확정) 중에는 보내지 않고 모아 둔다(T44).** 그 틈에 키가 하나 들어가면
   * 붙여넣은 지시가 깨지거나(문자 섞임) 통째로 사라진다(Esc → 입력 상자 비움 → Enter 가 빈 상자에, T42 함정 2).
   * 모아 둔 키는 구간이 끝나는 즉시 순서 그대로 나가고, 그때 grace 기준 시각이 갱신된다 — 그래서
   * "사용자가 치는 중에는 자동 타이핑을 시작하지 않는다" 규칙도 재생 시점부터 다시 걸린다.
   * 모아 두는 동안 grace 기준을 갱신하지 **않는** 것이 중요하다 — 아직 pty 에 닿지도 않은 키 때문에
   * 제출 확인(checkSubmit)을 접으면 T42 가 고친 "Enter 가 씹혀 큐가 막히는" 상태로 돌아간다.
   */
  typeRaw(data: string): void {
    if (this.critical) {
      this.critical.buffer.push(data);
      return;
    }
    this.lastUserTypingAt = this.now();
    this.deps.session.write(data);
  }

  /**
   * Ctrl+C. 큐는 지우지 않는다(중단 후 다음 지시가 그대로 이어지도록). 비우려면 clear().
   *
   * **중단은 임계 구간에서도 모으지 않는다(T44)** — 모아 두면 "멈춰" 가 몇 초 늦게 도착한다. 대신
   * ① 모아 둔 사용자 키를 먼저 흘리고(사용자가 친 순서: …키… → Ctrl+C), ② 아직 안 나간 Enter 와 제출 확인을
   * 취소하고, ③ ctrl-c 를 보낸다. 취소된 항목은 flushed 를 내지 않는다 — CLI 가 입력 상자를 비우므로 실제로
   * 제출되지 않았고, 그 task 는 Office 의 중단 후처리가 aborted 로 닫는다(afterCare `interrupt` 행).
   */
  interrupt(): void {
    this.cancelSubmit();
    this.endCritical(this.now());
    this.deps.session.sendKeys('ctrl-c');
  }

  size(): number {
    return this.queue.length;
  }

  peek(): InputItem | undefined {
    return this.queue[0];
  }

  /** 아직 flush 되지 않은 항목을 모두 빼서 돌려준다. 이미 paste 된(Enter 대기 중) 항목은 되돌리지 않는다. */
  clear(): InputItem[] {
    return this.queue.splice(0, this.queue.length);
  }

  /** 폴링 시작. 즉시 한 번 tick 하고, 이후 pollMs 마다 + 지연 동작 만기 시점마다 tick. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const now = this.now();
    for (const s of this.scheduled) this.armTimer(Math.max(0, s.dueAt - now));
    this.tick();
    this.interval = setInterval(() => this.tick(), this.pollMs);
    this.interval.unref();
  }

  /** 폴링 중지. 예약된 지연 동작은 버리지 않고 다음 tick()/start() 에서 이어진다. */
  stop(): void {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    // 임계 구간에 모아 둔 사용자 키는 버린다 — stop() 은 퇴근·정리 경로라 곧 pty 가 죽고(write 가 던진다)
    // 되돌려 줄 입력 상자도 없다. 살아 있는 세션에서 구간을 끝내는 길은 checkSubmit 과 interrupt 둘뿐이다.
    this.critical = undefined;
  }

  /** 예약된 지연 동작 중 아직 실행되지 않은 수(테스트·진단용). */
  pendingActions(): number {
    return this.scheduled.length;
  }

  /** 임계 구간에 붙잡아 둔 사용자 키 조각 수(테스트·진단용, T44). 구간이 아니면 0. */
  heldUserInput(): number {
    return this.critical?.buffer.length ?? 0;
  }

  /**
   * 한 번 평가. 순서: 만기된 지연 동작 실행 → 다이얼로그 통과 → 큐 머리 flush 게이트.
   * 테스트는 이 메서드를 직접 부른다.
   */
  tick(): void {
    this.drainDue();
    const now = this.now();

    const dialog = this.deps.screen.detectDialog();
    this.checkSubmit(now, dialog.kind !== 'none');
    if (dialog.kind === 'none') this.forgetBlockedDialog();
    if (dialog.kind !== 'none') {
      // 권장 키가 없는 다이얼로그(= CLI 자체 허가 프롬프트, D-23)는 통과 대상이 아니다. 키도 안 보내고 "통과했다"고도 하지 않는다.
      // 큐가 막힌 이유(blocked)는 다른 이유와 같은 계량으로, 어떤 다이얼로그인지(dialogBlocked)는 사라질 때까지 한 번만 알린다(D-26).
      if (dialog.suggestedKeys.length === 0) {
        if (this.blockedDialogKind !== dialog.kind) {
          this.blockedDialogKind = dialog.kind;
          this.blockedDialogSince = now;
          this.blockedDialogNoticed = false;
        }
        // **계속 떠 있을 때만** 알린다(T45). MCP 도구 구간에 한 프레임 스쳐 가는 프롬프트(hook 이 곧 allow 로
        // 지운다)를 사람에게 알리지 않기 위한 것이고, 큐를 막는 것은 아래에서 **지금 당장** 한다.
        if (!this.blockedDialogNoticed && now - this.blockedDialogSince >= TIMING.dialogBlockedNoticeMs) {
          this.blockedDialogNoticed = true;
          this.emit('dialogBlocked', dialog.kind);
        }
        return this.block('dialog', now);
      }
      this.forgetBlockedDialog();
      // 사용자가 터미널 탭에서 직접 다이얼로그를 다루는 중일 수 있다 — 그 위에 키를 얹지 않는다.
      if (this.userTyping(now)) return this.block('user-typing', now);
      // 강조로 키가 갈리는 다이얼로그(신뢰 폴더)는 **이동 키와 확인 키를 나눠** 보낸다. T36 실측: Claude 2.1 신뢰
      // 다이얼로그는 뜬 직후 한 번 더 렌더되며 선택을 'No, exit' 로 되돌린다 — ↓와 Enter 를 150ms 간격으로 붙여
      // 보내면 Enter 가 되돌아온 'No, exit' 에 떨어져 CLI 가 exit 1 로 죽는다(T34 "빈 폴더 함정").
      // 이동 키만 먼저 보내고, 다음 폴링에서 **강조가 원하는 항목에 와 있는 것을 다시 본 뒤에야** Enter 를 보낸다.
      const keys = dialog.highlightDriven === true && dialog.suggestedKeys.length > 1 ? dialog.suggestedKeys.slice(0, -1) : dialog.suggestedKeys;
      // 반복 가드는 **같은 키를 또 보내는 것**만 막는다. 키가 달라졌으면(이동이 먹혀 확인만 남았다) 화면이 실제로
      // 바뀐 것이므로 바로 보낸다 — 안 그러면 확인이 가드만큼 늦어진다.
      const last = this.lastDialogAt.get(dialog.kind);
      if (last && now - last.at < TIMING.dialogRepeatGuardMs && sameKeys(last.keys, keys)) return this.block('dialog', now);
      this.lastDialogAt.set(dialog.kind, { at: now, keys: [...keys] });
      this.sendKeySequence(keys);
      this.emit('dialogPassed', dialog.kind);
      return;
    }

    if (this.queue.length === 0) return;
    if (now < this.busyUntil) return; // 방금 넣은 입력을 CLI 가 소화하는 중 — 조용히 대기
    if (!this.deps.isIdle()) return this.block('not-idle', now);
    if (!this.deps.screen.promptReady()) return this.block('not-ready', now);
    if (this.userTyping(now)) return this.block('user-typing', now);

    this.flushHead(now);
  }

  private userTyping(now: number): boolean {
    return now - this.lastUserTypingAt <= this.graceMs;
  }

  /** 막고 있던 다이얼로그가 사라졌다(또는 통과 가능한 것으로 바뀌었다) — 다시 뜨면 새 사건으로 센다. */
  private forgetBlockedDialog(): void {
    this.blockedDialogKind = undefined;
    this.blockedDialogSince = Number.POSITIVE_INFINITY;
    this.blockedDialogNoticed = false;
  }

  /** 큐에 기다리는 항목이 있을 때만 의미가 있으므로 큐가 비었으면 조용히 넘어간다. */
  private block(reason: BlockReason, now: number): void {
    if (this.queue.length === 0) return;
    const last = this.lastBlockedAt.get(reason);
    if (last !== undefined && now - last < TIMING.blockedEmitIntervalMs) return;
    this.lastBlockedAt.set(reason, now);
    this.emit('blocked', reason);
  }

  /**
   * paste(text) → enterDelayMs 후 Enter → busyAfterFlushMs 동안 다음 항목 보류. 단일 행도 paste 로 통일.
   * paste 와 함께 임계 구간이 열린다(T44) — 여기부터 제출이 확정될 때까지 사용자 키는 pty 에 닿지 않는다.
   */
  private flushHead(now: number): void {
    const item = this.queue.shift();
    if (!item) return;
    this.critical = { buffer: [] };
    this.deps.session.paste(item.text);
    this.busyUntil = now + TIMING.enterDelayMs; // Enter 가 나가기 전엔 다음 항목을 절대 붙이지 않는다
    this.schedule(
      TIMING.enterDelayMs,
      (at) => {
        this.deps.session.sendKeys('enter');
        this.busyUntil = at + TIMING.busyAfterFlushMs;
        this.lastBlockedAt.clear(); // 다음 항목이 막히면 새로 알린다
        this.awaitingSubmit = { item, enterAt: at, attempt: 0 };
        this.emit('flushed', item);
      },
      'submit-enter',
    );
  }

  /** 임계 구간을 닫고 모아 둔 사용자 키를 순서 그대로 흘린다(T44). 열려 있지 않으면 아무 일도 안 한다. */
  private endCritical(now: number): void {
    const c = this.critical;
    this.critical = undefined;
    if (!c || c.buffer.length === 0) return;
    for (const data of c.buffer) this.deps.session.write(data);
    // 재생한 것도 사용자 타이핑이다 — 다음 자동 타이핑은 grace 가 지난 뒤에.
    this.lastUserTypingAt = now;
  }

  /** 아직 안 나간 Enter 예약과 제출 확인을 취소한다(중단 전용, T44). 이미 나간 Enter 는 되돌릴 수 없다. */
  private cancelSubmit(): void {
    for (let i = this.scheduled.length - 1; i >= 0; i--) {
      if (this.scheduled[i].tag === 'submit-enter') this.scheduled.splice(i, 1);
    }
    this.awaitingSubmit = undefined;
  }

  /**
   * "Enter 가 실제로 먹었는가" 확인(T42 실기에서 나온 문제).
   *
   * Codex `resume` 직후에는 화면이 prompt ready 인데도(헤더의 `model: loading` 은 복원된 대화에 밀려 안 보인다)
   * 세션 복원이 끝나기 전이라 **Enter 가 그냥 버려진다.** 그러면 붙여넣은 `[RESUMED]` 지시가 입력 상자에 남고,
   * 여러 줄짜리 텍스트가 상자를 채워 `promptReady()` 까지 false 가 되어 **그 멤버의 큐가 영구히 막힌다**
   * (실기: 복구된 Codex 부장·팀장 둘 다 이 상태였고, 손으로 Enter 를 한 번 더 치니 그대로 제출됐다).
   *
   * 판정은 화면 문자열이 아니라 **프롬프트가 들어갔을 때만 생기는 사실**로 한다 — UserPromptSubmit 이 오면
   * 어댑터가 status 를 working 으로 올리므로 `isIdle()` 이 false 가 된다. submitCheckMs 동안 계속 idle 이면 Enter 를 한 번 더.
   * 다이얼로그가 떴거나 사용자가 터미널 탭을 쓰는 중이면 확인을 접는다(그 위에 키를 얹지 않는다).
   */
  private checkSubmit(now: number, dialogUp: boolean): void {
    const a = this.awaitingSubmit;
    if (!a) return;
    if (!this.deps.isIdle()) {
      // 프롬프트가 들어갔다 — **여기서 재시도가 끝난다**(이미 들어간 Enter 를 또 보내 두 번 제출하지 않는다).
      this.awaitingSubmit = undefined;
      this.endCritical(now);
      return;
    }
    if (dialogUp || this.userTyping(now)) {
      this.awaitingSubmit = undefined;
      this.endCritical(now); // 화면을 다이얼로그·사용자가 쥐었다 — 모아 둔 키를 돌려준다
      return;
    }
    if (now - a.enterAt < TIMING.submitCheckMs) return;
    if (a.attempt >= SUBMIT_RETRY_MAX) {
      this.awaitingSubmit = undefined;
      this.endCritical(now);
      this.emit('submitLost', a.item);
      return;
    }
    a.attempt += 1;
    a.enterAt = now;
    this.deps.session.sendKeys('enter');
    this.busyUntil = now + TIMING.busyAfterFlushMs;
    this.emit('submitRetried', a.item, a.attempt);
  }

  /** 첫 키는 즉시, 나머지는 keySpacingMs 간격으로 예약. 빈 배열이면 아무것도 안 한다. */
  private sendKeySequence(keys: readonly QueueKey[]): void {
    keys.forEach((k, i) => {
      if (i === 0) this.deps.session.sendKeys(k);
      else this.schedule(i * TIMING.keySpacingMs, () => this.deps.session.sendKeys(k));
    });
  }

  private schedule(delayMs: number, run: (now: number) => void, tag?: Scheduled['tag']): void {
    this.scheduled.push({ dueAt: this.now() + delayMs, run, tag });
    if (this.running) this.armTimer(delayMs);
  }

  /** 실제 타이머로 tick 을 깨운다. +1ms 는 Date.now 해상도로 dueAt 직전에 깨는 것을 막는 여유. */
  private armTimer(delayMs: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.tick();
    }, delayMs + 1);
    t.unref();
    this.timers.add(t);
  }

  /** 만기된 지연 동작을 dueAt 순으로 실행. run 안에서 새로 예약된 것은 미래 시각이라 이 루프에서 돌지 않는다. */
  private drainDue(): void {
    const now = this.now();
    this.scheduled.sort((a, b) => a.dueAt - b.dueAt);
    while (this.scheduled.length > 0 && this.scheduled[0].dueAt <= now) {
      const s = this.scheduled.shift()!;
      s.run(now);
    }
  }
}

/** 키 순서가 같은가(반복 가드 비교용). */
function sameKeys(a: readonly DialogKey[], b: readonly DialogKey[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}
