// InputQueue — 멤버별 입력 직렬화 큐 (T05, 설계 §구성 요소 1 "입력 직렬화").
//
// 사용자 직접 타이핑(member.type)과 자동 타이핑(instruct, [TASK#n], [REPORTS ...], [ANSWER q#N], [RESUMED])이
// 같은 pty 를 쓰므로 한 곳에서 순서를 정한다. 자동 타이핑은 (a) 어댑터가 idle 이고(진행 중 턴·열린 질문 없음),
// (b) ScreenModel 이 prompt ready 이고, (c) 사용자가 직접 치는 중이 아닐 때(마지막 typeRaw 후 grace 경과)만 flush 한다.
// 첫 실행 다이얼로그(온보딩·폴더 신뢰)는 ScreenModel 감지 + 권장 키로 통과한다(실측 ①④ — 설정 선주입은 안 먹힘).
// 권장 키가 없는 다이얼로그(CLI 자체 허가 프롬프트 `approval-prompt`, D-23)는 통과 대상이 아니다 — 키를 보내지 않고
// blocked('dialog') + dialogBlocked(kind) 로만 알린다(D-26, T23b).
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
  /** 같은 kind 의 다이얼로그에 키를 다시 보내기까지 최소 간격(화면이 아직 안 바뀌었을 때 중복 전송 방지). */
  dialogRepeatGuardMs: 2000,
  /** 같은 이유의 blocked 이벤트 최소 간격. */
  blockedEmitIntervalMs: 5000,
} as const;

interface Scheduled {
  dueAt: number;
  run: (now: number) => void;
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
  /** dialogBlocked 를 이미 낸 다이얼로그 kind. 그 다이얼로그가 사라지거나 다른 kind 로 바뀌면 지운다. */
  private blockedDialogKind: string | undefined;

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

  /** 터미널 탭에서의 직접 타이핑. 게이트 없이 즉시 쓰고, grace 창의 기준 시각을 갱신한다. */
  typeRaw(data: string): void {
    this.lastUserTypingAt = this.now();
    this.deps.session.write(data);
  }

  /** Ctrl+C. 큐는 지우지 않는다(중단 후 다음 지시가 그대로 이어지도록). 비우려면 clear(). */
  interrupt(): void {
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
  }

  /** 예약된 지연 동작 중 아직 실행되지 않은 수(테스트·진단용). */
  pendingActions(): number {
    return this.scheduled.length;
  }

  /**
   * 한 번 평가. 순서: 만기된 지연 동작 실행 → 다이얼로그 통과 → 큐 머리 flush 게이트.
   * 테스트는 이 메서드를 직접 부른다.
   */
  tick(): void {
    this.drainDue();
    const now = this.now();

    const dialog = this.deps.screen.detectDialog();
    if (dialog.kind === 'none') this.blockedDialogKind = undefined;
    if (dialog.kind !== 'none') {
      // 권장 키가 없는 다이얼로그(= CLI 자체 허가 프롬프트, D-23)는 통과 대상이 아니다. 키도 안 보내고 "통과했다"고도 하지 않는다.
      // 큐가 막힌 이유(blocked)는 다른 이유와 같은 계량으로, 어떤 다이얼로그인지(dialogBlocked)는 사라질 때까지 한 번만 알린다(D-26).
      if (dialog.suggestedKeys.length === 0) {
        if (this.blockedDialogKind !== dialog.kind) {
          this.blockedDialogKind = dialog.kind;
          this.emit('dialogBlocked', dialog.kind);
        }
        return this.block('dialog', now);
      }
      this.blockedDialogKind = undefined;
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

  /** 큐에 기다리는 항목이 있을 때만 의미가 있으므로 큐가 비었으면 조용히 넘어간다. */
  private block(reason: BlockReason, now: number): void {
    if (this.queue.length === 0) return;
    const last = this.lastBlockedAt.get(reason);
    if (last !== undefined && now - last < TIMING.blockedEmitIntervalMs) return;
    this.lastBlockedAt.set(reason, now);
    this.emit('blocked', reason);
  }

  /** paste(text) → enterDelayMs 후 Enter → busyAfterFlushMs 동안 다음 항목 보류. 단일 행도 paste 로 통일. */
  private flushHead(now: number): void {
    const item = this.queue.shift();
    if (!item) return;
    this.deps.session.paste(item.text);
    this.busyUntil = now + TIMING.enterDelayMs; // Enter 가 나가기 전엔 다음 항목을 절대 붙이지 않는다
    this.schedule(TIMING.enterDelayMs, (at) => {
      this.deps.session.sendKeys('enter');
      this.busyUntil = at + TIMING.busyAfterFlushMs;
      this.lastBlockedAt.clear(); // 다음 항목이 막히면 새로 알린다
      this.emit('flushed', item);
    });
  }

  /** 첫 키는 즉시, 나머지는 keySpacingMs 간격으로 예약. 빈 배열이면 아무것도 안 한다. */
  private sendKeySequence(keys: readonly QueueKey[]): void {
    keys.forEach((k, i) => {
      if (i === 0) this.deps.session.sendKeys(k);
      else this.schedule(i * TIMING.keySpacingMs, () => this.deps.session.sendKeys(k));
    });
  }

  private schedule(delayMs: number, run: (now: number) => void): void {
    this.scheduled.push({ dueAt: this.now() + delayMs, run });
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
