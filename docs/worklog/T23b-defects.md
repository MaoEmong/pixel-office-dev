# T23b — 혼합 팀 확인에서 나온 결함 2건 (화면 기반 idle 폴백 · 허가 프롬프트 알림)

- 날짜: 2026-09-16
- 마일스톤: M3 (T23 후속 결함 수정)
- 관련 설계: 01-설계문서.md §구성 요소 1(입력 직렬화·화면) / §2 오피스 이벤트 · 04 D-23 D-24 → **D-25 D-26**(이번) · worklog T20(`watchBootReady`) T21(함정·결정 `approval-prompt`) T23(함정 1·2)
- 커밋: (미커밋 — 상위에서)

## 목표

T23(혼합 팀 확인)이 "안 고침" 으로 남긴 결함 두 건을 고친다.

1. **턴 종료 hook 없이 끝난 멤버가 `working` 에 갇힌다.** Codex 사용량 한도 안내는 화면에만 뜨고 `Stop` 을 내지 않는다
   → 사무실 표시가 틀리고(파란 캐릭터) `InputQueue.isIdle` 게이트가 안 열려 **다음 지시가 큐에 머문다.**
2. **`approval-prompt` 에 `daemon.notice` 스팸.** CLI 자체 허가 프롬프트가 떠 있는 내내 2초마다
   `passed first-run dialog (approval-prompt)` 가 찍힌다. 키는 안 나가지만(D-23) "통과했다" 는 거짓말이다.

끝나면 ① 턴 종료 hook 이 없어도 멤버가 스스로 `idle` 로 내려오고 큐가 다시 흐르며, ② 허가 프롬프트는 **막힘**으로
한 번만 알린다.

## 한 것

### 1. 화면 기반 idle 폴백 (결함 1, D-25)

- `src/office/Office.ts`
  - `watchScreenIdle(rt)` 신설 — `watchBootReady`/`watchInterrupted` 와 같은 모양(멤버당 `setInterval` 하나, `unref`,
    500ms). `spawnMember()` 에서 **엔진 공통**으로 건다. 세션이 끝나면(pty exit·퇴근·재스폰·셧다운) `clearWatches()` 가 멈춘다.
  - 발화 조건(`screenLooksIdle()`) — 전부 만족이 **3초 연속**:
    status ∈ {`working`, `waiting_approval`, `waiting_answer`} · 그 멤버에게 **열린 pending 0** ·
    `detectDialog().kind === 'none'` · `!busyIndicator()` · `promptReady()` · **그 창 안에 새 hook 없음.**
    하나라도 깨지면 창(`rt.screenIdleSince`)을 닫고 다음에 처음부터 다시 잰다.
  - 발화 = `idle{summary:'screen-idle'}` 이벤트 + status `idle`. 상수 `IDLE_SCREEN_STABLE_MS`(3000)/`IDLE_SCREEN_STEP_MS`(500)/
    `IDLE_SCREEN_STATUSES`, 내보낸 상수 `SCREEN_IDLE_SUMMARY`.
  - "새 hook 없음" 판정용으로 `wire()` 의 `receiver.on('hook')` 에서 `rt.lastHookAt` 을 기록한다(어댑터가 status 를
    어떻게 바꾸든 **도착 자체**를 본다). `MemberRuntime` 에 `idleWatch`/`screenIdleSince`/`lastHookAt` 추가.

### 2. `approval-prompt` 은 통과가 아니라 막힘 (결함 2, D-26)

- `src/input/InputQueue.ts`
  - 새 이벤트 `dialogBlocked(kind)`. `tick()` 에서 다이얼로그의 `suggestedKeys` 가 **비어 있으면** 키를 보내지 않고
    `dialogPassed` 도 내지 않는다 → `blocked('dialog')`(기존 이유들과 같은 5초 계량, 큐에 기다리는 항목이 있을 때만) +
    `dialogBlocked(kind)`(그 다이얼로그가 **사라질 때까지 kind 당 한 번**, `blockedDialogKind` 로 기억).
    다이얼로그가 `none` 이 되거나 통과 가능한 다른 다이얼로그로 바뀌면 기억을 지운다.
  - 빈 키 검사는 `user-typing` 검사보다 **앞**이다 — 사용자가 치고 있든 아니든 우리는 이 화면을 통과시킬 수 없다.
- `src/office/Office.ts` — `spawnMember()` 에서 `queue.on('dialogBlocked', …)` → `noticeDialogBlocked()`:
  `approval-prompt` 이면 `daemon.notice{warn, '<이름>: CLI 허가 프롬프트가 떠 있음 — 카드로 답하거나 터미널에서 직접 답하세요'}`,
  그 외 빈 키 다이얼로그는 일반 경고. InputQueue 가 kind 당 한 번만 내므로 **알림도 한 번**이다.

### 3. 테스트

- `test/office/ScreenWatch.test.ts`(신규 6건) — 가짜 pty/HookReceiver + **진짜 `Office`/`Store`/`InputQueue`/`ScreenModel`**.
  화면은 T21 실측 픽스처를 `\x1b[2J\x1b[H` + 본문으로 pty 출력에 흘려 넣는다(120x40, 데몬 기본 크기). 두 감시 모두
  실제 타이머로 도는 코드라 시계를 주입하지 않고 실제로 기다린다(창 3초 + 폴링 500ms → 발화 대기 4.5초).
- `test/input/InputQueue.test.ts`(+3건) — 하네스에 `dialogBlocked` 수집 추가.

## 검증

```
$ cd dev/daemon && npx tsc --noEmit
(출력 없음, EXIT=0)

$ npx tsx --test test/input/InputQueue.test.ts
  ✔ empty suggestedKeys (CLI approval prompt): no keys, no dialogPassed — blocked(dialog) + one dialogBlocked(kind) (D-26)
  ✔ dialogBlocked repeats only after the dialog clears (or a different kind shows up)
  ✔ a blocked dialog keeps the queue intact — it flushes as soon as the prompt returns
ℹ tests 20  ℹ pass 20  ℹ fail 0        (기존 17 + 3)

$ npx tsx --test test/office/ScreenWatch.test.ts
  ✔ Codex 사용량 한도 화면: Stop hook 없이 프롬프트로 돌아오면 3초 뒤 idle{screen-idle} 로 내려오고 막혀 있던 지시가 흐른다
  ✔ hook 이 계속 오는 동안에는 창이 다시 열리고, 조용해진 뒤에야 idle 로 내려온다 (Claude 준비 화면)
  ✔ busy 표시 · 다이얼로그 · 열린 보류 중에는 발화하지 않는다; 보류가 닫히면 다음 창에서 내려온다
  ✔ 퇴근하면 감시가 멈춘다 (죽은 세션의 마지막 화면으로 idle 을 만들지 않는다)
  ✔ CLI 허가 프롬프트: 키를 보내지 않고 "통과했다" 알림도 없다 — 경고 알림 한 번(다이얼로그가 사라졌다 다시 뜨면 또 한 번)
  ✔ 통과할 수 있는 첫 실행 다이얼로그는 그대로 통과한다 (폴더 신뢰 — 회귀 방지)
ℹ tests 6  ℹ pass 6  ℹ fail 0          (2회 연속 동일 — 타이밍 흔들림 없음)

$ npx tsx --test "test/**/*.test.ts"
ℹ tests 337  ℹ suites 51  ℹ pass 332  ℹ fail 0  ℹ skipped 5   (= opt-in 통합 테스트, PIXEL_IT 미설정)
```

T23 기준 328 → 337(+9). 전체 소요는 13초 → 34초 — 새 파일이 실제 시계를 기다린다(창 3초 × 발화 5회).

### 픽스처로 재현한 결함 1 (실기 T23 과 같은 화면)

`test/screen/fixtures/codex/usage-limit.txt` 를 120x40 에 그리면 `promptReady()=true` · `busyIndicator()=false` ·
`detectDialog().kind='none'` 이다(T21 `screens.test.ts` 가 이미 고정해 둔 판정). 그래서 `UserPromptSubmit` 으로
`working` 이 된 Codex 멤버에게 이 화면을 주면 예전 코드에서는 영원히 `working` 이었고, 지금은 3초 뒤
`idle{summary:'screen-idle'}` 이 나오고 **큐에 머물던 `[TASK#1 …]` 가 그제서야 paste 된다**(테스트가 이 두 가지를 같이 본다).

### 픽스처로 재현한 결함 2

`test/screen/fixtures/claude/approval-prompt.txt`(실측 "Do you want to proceed?") → `approval-prompt`,
`suggestedKeys: []`. 2.6초(예전 재전송 가드 2초를 넘김) 동안 폴링시켜도 알림은 한 번, 세션에 나간 키는 **0개**,
`passed first-run dialog` 는 **0회**. 화면을 준비 화면으로 바꿨다가 다시 허가 프롬프트로 바꾸면 알림이 한 번 더(총 2회).

## 발견한 함정

1. **`promptReady()` 는 이미 다이얼로그·busy 를 포함한다**(다이얼로그가 있거나 busy 면 false). 그래도
   `screenLooksIdle()` 에 `detectDialog()`/`busyIndicator()` 검사를 따로 남겼다 — "보류·다이얼로그·busy 중엔 절대 발화 안 함"
   이 D-25 의 핵심이라 `promptReady()` 의 내부 구현이 바뀌어도 깨지지 않게 하려는 것. 중복 비용은 폴링 1회분뿐이다.
2. **화면 픽스처를 이어 붙이면 화면이 누적된다.** pty 출력에 두 번째 픽스처를 그냥 흘리면 아래에 덧그려져 앞 화면이
   남는다. 테스트에서 화면을 갈아 끼울 때는 `\x1b[2J\x1b[H`(지우고 홈)를 앞에 붙일 것.
3. **`waiting_approval` 이어도 보류가 닫혀 있으면 발화 대상이다.** D-15/D-16 경로(hook 보류가 결정 없이 끝남)에서
   status 는 `waiting_approval`/`working` 인데 pending 은 `expired` 인 조합이 실제로 생긴다. "status 가 아니라 열린 pending
   유무" 로 막는 이유다 — 테스트가 이 전이(보류 만료 → 다음 창에서 idle)를 고정한다.
4. **`dialogBlocked` 를 `blocked` 로 대신할 수 없다.** `blocked` 는 "큐에 기다리는 항목이 있을 때만" 내는 이벤트라
   (기존 규칙) 지시가 없는 동안 허가 프롬프트가 떠 있으면 아무도 모른다. kind 를 싣는 별도 이벤트가 필요했다.
5. 실기 재확인은 아직이다 — 결함 1 은 Codex 한도 화면이 필요하고(9/21 이후), 결함 2 는 Claude 허가 대기 중
   콘솔 로그를 다시 보면 된다. 아래 "남은 것".

## 결정

- **D-25** — 턴 종료 hook 이 없으면 화면으로 idle 판정(`idle{summary:'screen-idle'}`).
- **D-26** — `approval-prompt` 은 "통과" 가 아니라 "막힘"(`dialogPassed` 대신 `blocked`+`dialogBlocked`).

## 남은 것

- **실기 재확인** — ① 결함 2: Claude 에게 허가 필요한 Bash 를 시키고 허가를 몇 분 방치 → `daemon.notice` 에 경고가
  **한 번**만 찍히는지(예전엔 2초마다). ② 결함 1: 9/21 한도 리셋 전에는 Codex 한도 화면이 그대로 재현되니
  T23 "9/21 이후 확인 목록" 을 돌리기 전에 먼저 볼 수 있다(지시 → `working` → 3초 → `idle{screen-idle}` → 다음 지시가 나감).
- T23 "9/21 이후 확인 목록" I 항목은 이 태스크로 닫힌다(코드·단위 테스트 기준). 목록의 나머지 A~H·J 는 그대로.
- 앱 쪽: `idle{summary:'screen-idle'}` 을 로그에 어떻게 보일지(지금은 다른 idle 과 같은 줄) — 필요하면 M5 에서.
- `dialogBlocked` 를 스냅샷/파생 상태로 올릴지(앱의 "재지시 필요" 카드가 `approvalPrompt().allowKeys` 로 허가/거부
  버튼을 붙이는 D-23 후속) — M4/M5 판단.
