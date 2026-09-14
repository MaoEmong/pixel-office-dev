# T05 — InputQueue

- 날짜: 2026-09-14
- 마일스톤: M0
- 관련 설계: 01-설계문서.md §구성 요소 1 "입력 직렬화"·"ScreenModel"·"TeamTools"(`[TASK#n]`/`[REPORTS]`/`[ANSWER q#N]`/`[RESUMED]` 타이핑), §실측 결과 반영(첫 실행 다이얼로그·중단), 02-실측-체크리스트.md ①(bracketed paste, Ctrl+C)
- 커밋: (미커밋 — 상위 태스크에서)

## 목표

멤버당 입력 큐 하나로 pty 에 들어가는 모든 입력의 순서와 시점을 정한다. 사용자 직접 타이핑(`member.type`)은 즉시 쓰고, 자동 타이핑(`instruct` 와 데몬 메시지 `[TASK#n]`·`[REPORTS …]`·`[ANSWER q#N]`·`[RESUMED]`)은 **어댑터 idle ∧ ScreenModel prompt ready ∧ 사용자가 직접 치는 중이 아님(마지막 타이핑 후 3초)** 일 때만 bracketed paste + Enter 로 flush 한다. 첫 실행 다이얼로그(온보딩·폴더 신뢰)는 ScreenModel 감지 결과의 권장 키로 통과한다. 이 태스크가 끝나면 T07(RPC) 이 `member.instruct/type/interrupt` 를 이 큐에 위임할 수 있고, T04/T09/T17 이 시스템 메시지를 같은 경로로 넣을 수 있다.

## 한 것

- `dev/daemon/src/input/InputQueue.ts` (신규) — 공개 API:
  - 타입: `InputItem = {kind:'instruct'|'system', text, id?} | {kind:'keys', keys: KeyName[]}`, `QueueDeps{ session{paste,write,sendKeys}, screen{promptReady,detectDialog}, isIdle(), pollMs?=500, userTypingGraceMs?=3000, now?() }`, `BlockReason = 'not-idle'|'not-ready'|'user-typing'|'dialog'`, `TIMING` 상수(`keySpacingMs:150, enterDelayMs:300, busyAfterFlushMs:1500, dialogRepeatGuardMs:2000, blockedEmitIntervalMs:5000`).
  - `class InputQueue extends EventEmitter<{ flushed:[InputItem]; blocked:[BlockReason]; dialogPassed:[kind] }>`
    - `enqueue(item)` — instruct/system 은 FIFO 에 넣고 즉시 한 번 `tick()`; `keys` 는 큐를 거치지 않고 즉시 전송(첫 키 즉시, 나머지 150ms 간격).
    - `typeRaw(data)` — `session.write(data)` 즉시 + `lastUserTypingAt` 갱신.
    - `interrupt()` — `sendKeys('ctrl-c')`. 큐는 유지.
    - `size()`, `peek()`, `clear(): InputItem[]`(아직 paste 안 된 항목만 빼서 반환), `pendingActions()`(예약된 지연 동작 수 — 테스트·진단용).
    - `start()`/`stop()` — 폴링 루프(`setInterval(pollMs)`, unref) + 지연 동작 만기 시점의 `setTimeout`. `stop()` 은 예약을 버리지 않고 타이머만 끈다.
    - `tick()` — 한 번 평가. 테스트가 직접 부른다.
  - flush 규칙(`tick()` 순서):
    1. 만기된 지연 동작(키 간격·paste→Enter) 실행.
    2. `screen.detectDialog().kind !== 'none'` → 사용자가 grace 안에 타이핑 중이면 건너뜀(직접 다이얼로그를 다루는 중일 수 있음), 아니면 같은 kind 는 2초에 한 번만 `suggestedKeys` 를 150ms 간격으로 전송하고 `dialogPassed(kind)`. 이 tick 에서는 flush 안 함(가드에 걸려 못 보냈고 큐에 항목이 있으면 `blocked('dialog')`).
    3. 큐가 비었으면 끝. `now < busyUntil` 이면 조용히 대기(blocked 안 냄).
    4. `isIdle()` → `promptReady()` → 타이핑 grace 순으로 검사, 첫 실패 이유로 `blocked(reason)`(이유별 5초에 한 번, flush 성공 시 계량 리셋).
    5. flush = `session.paste(text)` → `busyUntil = now+300` → 300ms 뒤 `sendKeys('enter')` → `busyUntil = now+1500` → `flushed(item)`. 단일 행도 paste 로 통일.
  - 시간은 전부 주입된 `now()` 기준. 지연 동작은 내부 스케줄러(`{dueAt, run}` 목록)에 적어 두고 `tick()` 첫머리에서 만기분을 실행하므로 테스트에서 실제 타이머 없이 결정적으로 돌릴 수 있다.
- `dev/daemon/test/input/InputQueue.test.ts` (신규, 17건) — 가짜 session/screen/isIdle + `now()` 주입, `tick()` 직접 호출. 세 조건 AND / 타이핑 grace(경계 = 3000 초과) / grace 리셋 / blocked 5초 계량과 flush 후 리셋 / 큐 비었을 때 blocked 없음 / 다이얼로그 키 150ms 간격·dialogPassed·2초 재전송 가드·다른 kind 즉시 / 큐 없이도 다이얼로그 통과 / 타이핑 중 다이얼로그 자동 통과 안 함 / FIFO 순서 / busy 창(paste~Enter 사이, Enter 후 1500ms) / Enter 후 isIdle=false 로 이어지는 대기 / `keys` 즉시 실행 / `interrupt()` / `clear()` / 실제 타이머로 `start()`→`stop()` 1건.

## 검증

```
$ cd dev/daemon && npx tsc --noEmit
(출력 없음 — 오류 0)

$ npx tsx --test test/input/*.test.ts
▶ flush gate
  ✔ flushes only when isIdle && promptReady && no recent user typing (all three) (1.8541ms)
  ✔ single-line text also goes through paste (uniform), and system items behave like instruct (0.1605ms)
  ✔ user typing within grace blocks with blocked(user-typing); boundary is strictly greater than grace (0.2141ms)
  ✔ typing again resets the grace window (0.2866ms)
  ✔ blocked events are rate-limited to one per reason per 5s; the limit resets after a flush (0.2475ms)
  ✔ no blocked event when the queue is empty (0.1659ms)
✔ flush gate (3.9464ms)
▶ dialog pass-through
  ✔ sends suggested keys 150ms apart, emits dialogPassed, and does not flush the queue while the dialog is up (0.8887ms)
  ✔ guards repeats: same dialog kind at most once per 2s, then blocked(dialog) while a queued item waits (0.1894ms)
  ✔ dialog is passed even when the queue is empty (first-run dialogs happen before any instruction) (0.1621ms)
  ✔ does not auto-pass a dialog while the user is typing (they may be answering it themselves) (0.1863ms)
✔ dialog pass-through (1.6393ms)
▶ ordering and busy window
  ✔ FIFO order is preserved across multiple ticks (0.2612ms)
  ✔ busy window: no second flush within 1500ms after Enter, and none between paste and Enter (0.214ms)
  ✔ isIdle turning false after Enter (UserPromptSubmit) keeps the next item waiting past the busy window (0.3693ms)
✔ ordering and busy window (0.9817ms)
▶ keys, interrupt, clear
  ✔ keys items execute immediately (bypass gating), spaced 150ms (0.2975ms)
  ✔ interrupt() sends ctrl-c and does not clear the queue (0.1724ms)
  ✔ clear() returns and removes waiting items only; an already pasted item still gets its Enter (0.1683ms)
✔ keys, interrupt, clear (0.8178ms)
▶ poll loop (real timers)
  ✔ start() drives paste → Enter → next item without manual ticks; stop() halts (2249.919ms)
✔ poll loop (real timers) (2250.2145ms)
ℹ tests 17  ℹ suites 5  ℹ pass 17  ℹ fail 0  ℹ duration_ms 5233.8154
```

실제 타이머 테스트의 소요 2250ms ≈ Enter 지연 300 + busy 창 1500 + Enter 지연 300 + 폴링 20ms 여유 — busy 창이 실제 시계에서도 작동함을 보여 준다. 작업계획의 "작업 중 지시 2개 넣고 순서·시점 확인" 은 FIFO·busy 창 테스트(가짜 시계)와 위 실제 타이머 테스트로 대체했다. 실제 CLI 를 붙인 확인은 T08/T10 시연에서.

## 발견한 함정

- **paste 와 Enter 사이의 공백.** paste 직후 `busyUntil` 을 안 걸면 같은 tick 안에서는 안 겹치지만 다음 tick(≤500ms) 에 두 번째 paste 가 첫 Enter 보다 먼저 들어갈 수 있다 → paste 시점에 `busyUntil = now+300` 을 먼저 걸고, Enter 가 나간 뒤 `now+1500` 으로 늘린다. Enter 는 스케줄러에 있고 `tick()` 이 만기분을 **게이트 검사보다 먼저** 실행하므로 순서가 보장된다.
- **`blocked` 소음.** 큐가 비었는데 idle 이 아니라고 매 tick 이벤트를 내면 의미가 없다 → 큐에 항목이 있을 때만, 이유별 5초에 한 번. flush 성공 시 계량을 리셋해 다음 항목이 막히면 바로 알린다.
- **다이얼로그 위에 사용자 키가 겹치는 경우.** 터미널 탭에서 사용자가 신뢰 다이얼로그를 직접 고르는 중에 데몬이 ↓+Enter 를 얹으면 엉뚱한 항목이 선택된다 → 타이핑 grace 안에는 자동 통과도 멈춘다(설계의 "사용자가 직접 치는 중이 아님" 조건을 다이얼로그에도 적용).
- **Ctrl+C 는 큐를 비우지 않는다.** 실측 ①: Ctrl+C 후 Stop hook 이 없고 화면 준비 문구로 idle 판정 → 다음 tick 에 큐 머리가 그대로 들어간다. 사용자가 "중단하고 다른 지시" 를 원하면 RPC 쪽(T07)에서 `clear()` 후 `enqueue`. Claude 는 Ctrl+C 두 번이면 종료되므로 `interrupt()` 를 짧은 간격으로 두 번 부르지 않도록 T07 에서 주의.
- **`setTimeout` 만기 시각과 `Date.now` 해상도.** 타이머가 dueAt 직전에 깨면 만기분이 실행되지 않고 다음 폴링까지 미뤄진다 → 타이머에 +1ms. 못 깨워도 폴링(500ms)이 안전망.

## 결정

04-결정기록.md 는 이 태스크 범위 밖이라 안 건드렸다. 상위에서 번호 부여할 후보:

- 자동 타이핑은 단일 행도 bracketed paste 로 보낸다(동작 통일; 실측 ①에서 paste 로 세 줄이 한 프롬프트에 들어감을 확인). Enter 는 300ms 뒤 별도 전송.
- `keys` 항목과 `interrupt()` 는 게이트를 거치지 않는다 — 다이얼로그 통과·중단은 "지금 화면에 대한" 조작이라 대기가 무의미.
- Enter 후 1500ms busy 창: `UserPromptSubmit` 이 어댑터에 도착해 `isIdle()` 이 false 가 되기 전까지의 공백을 메운다. hook 왕복은 실측 ~150ms 수준이라 여유가 크다.
- 시간·지연은 전부 `now()` 주입 + 내부 스케줄러. 테스트가 실제 타이머 없이 결정적.

## 남은 것

- **실기동 확인(T08/T10):** 300ms Enter 지연이 Claude/Codex TUI 에서 충분한지(긴 paste 에서 입력 상자 반영이 늦으면 늘린다), 1500ms busy 창이 hook 도착보다 충분히 긴지, 다이얼로그 키 150ms 간격이 온보딩 3연속 다이얼로그에서 안정적인지.
- **큐 영속화 없음.** 데몬 재시작 시 큐 내용은 사라진다. 사용자 지시는 `tasks` 행(T06)으로 남으므로 T09 복구에서 `queued` task 를 다시 `enqueue` 하면 된다.
- **멤버 상태와의 연결.** `isIdle()` 은 T04 어댑터의 파생 상태(idle/free ∧ 열린 질문 없음)를 넘겨받는 콜백. 질문 대기 중(`waiting_answer`)에 `[ANSWER q#N]` 만 통과시키는 예외는 T17 에서 `isIdle` 콜백 쪽에서 처리(큐는 항목 종류를 구분하지 않는다).
- `codex resume` / `claude --resume` 직후의 `[RESUMED]` 메시지는 T09 에서 `kind:'system'` 으로 넣는다.
