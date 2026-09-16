# T27 — 팀 단위 셸 뮤텍스

- 날짜: 2026-09-16
- 마일스톤: M4
- 관련 설계: 01-설계문서.md §구성 요소 1("팀 단위 셸 뮤텍스" 해제 표·보류 중 hook 타임아웃), §4(동시 편집·빌드 충돌), §Success Criteria v1b-9 · 02-실측-체크리스트.md §②(읽기 명령은 `PermissionRequest` 없이 실행 / 실패는 `PostToolUseFailure`) · 04 D-11(보류 타임아웃은 pass-through) D-16(hook timeout 86400) → **D-27**(이번) · worklog T04(`toolGate`·`toolDone` 연결점) T20(BaseHooksAdapter 훅 포인트)
- 커밋: (미커밋 — 상위에서)

## 목표

같은 팀의 멤버 둘이 동시에 빌드·테스트·쓰기 셸 명령을 돌리지 않게 **팀당 락 하나**를 둔다. 뒤에 온 셸 명령은 hook 응답을
보류해 CLI 를 도구 실행 **전에** 세워 두고(캐릭터 "대기 중"), 앞 명령이 끝나면 자동으로 풀어 준다. 끝나면 v1b 성공 기준 9
("같은 팀에서 셸 명령 두 개가 겹치면 두 번째가 대기하는 게 보인다")의 데몬 쪽이 선다.

## 한 것

### 1. `src/office/ShellMutex.ts` (신규) — 순수 자료구조

- `acquire(teamId, memberId, toolUseId, cmd, {signal?})` — 비어 있으면 **동기적으로** 잡고(호출 순서 = 획득 순서),
  잡혀 있으면 FIFO 줄 끝에 선다. **절대 reject 하지 않는다**(D-11: 게이트가 깨져도 hook 응답은 pass-through).
- `release(teamId, memberId, toolUseId?)` — 주인이 맞고 `tool_use_id` 가 맞을 때만 푼다(늦게 온 다른 도구의
  `PostToolUse` 가 남의 락을 풀지 않게). 풀면 다음 대기자에게 곧바로 넘긴다.
- `releaseAllFor(memberId)` — 그 멤버의 락 + 대기 자리 전부. **대기 자리를 먼저** 버린다(나가는 멤버가 방금 푼 락을
  자기 대기 자리로 되받으면 안 된다).
- `holder(teamId)` / `queueLength(teamId)` / `waiters(teamId)` / `size` / `clear()`.
- 보유 상한 `maxHoldMs`(기본 30분, `DEFAULT_MAX_HOLD_MS`) — 넘으면 `warn` 이벤트 + 강제 해제 + 다음 대기자에게 인계.
- 이벤트: `waiting(info, holder)` · `granted(info, waitedMs)` · `released(info, reason, heldMs)` · `warn(info, message)`.
  `reason` 은 `done | member-gone | max-hold`.
- 락 대상 판정(D-27): `isShellTool(tool)`(Claude `Bash`/`PowerShell` + Codex 셸 도구 이름) ∧
  `shellLockCommand(tool, input)` — **읽기 전용 명령이면 `null`**(락 안 잡음). 판정은 두 엔진 모두
  `codexMapping.isReadOnlyCommand` 하나로, 명령 문자열을 못 읽으면 잡는다.

### 2. 어댑터 훅 포인트 확장 (`src/adapters/`)

- `types.ts` — `AdapterDeps.toolGate(memberId, tool, input, **ctx**)` 로 넓혔다. 새 `ToolGateContext`:
  - `toolUseId` — 해제 짝 맞추기용(`PreToolUse.tool_use_id`, 없으면 `null`).
  - `signal` — **이 `PreToolUse` 의 보류가 사라지면 abort.** 게이트는 그때 대기 줄에서 자기 자리를 뺀다.
- `BaseHooksAdapter.ts`
  - 게이트 보류를 `{handle, abort}` 로 들고 있다가 ① `expireAllForMember`(interrupt/fire/퇴근 후처리)
    ② `onHoldTimeout`/`onHoldClosed`(receiver 가 이미 `{}` 를 보낸 보류) 에서 `abort()` 한다.
  - `onPreToolUse` 의 도구 이벤트(`running`/`reading`/`editing`)·status 를 **게이트 호출보다 먼저** 남기도록 순서만 바꿨다 —
    게이트가 내는 "대기 중" 이벤트가 뒤에 와야 말풍선이 맞다.

### 3. `src/office/Office.ts` 배선 (기존 코드 최소 수정)

- `readonly shell = new ShellMutex()` + `AdapterDeps.toolGate = shellGate(...)`.
  `shellGate` 는 첫 `await` 전까지 동기 — hook 도착 순서가 그대로 획득 순서다.
- 해제(01 §해제 표):
  - `adapter.on('toolDone')` → `release(teamId, memberId, toolUseId)` — `PostToolUse` **와 `PostToolUseFailure`** 둘 다.
  - `afterOfficeEvent` 의 `idle`(= `Stop`·세션 종료) → `releaseAllFor` 안전망.
  - `interrupt` / `clockOut` / `restart` / `onPtyExit`(퇴근·재시작·크래시 공통) → `releaseAllFor`. `shutdown` 은 `clear()`.
- 표시:
  - `shell.on('waiting')` → `running{cmd, summary:'셸 대기 중 (락: <이름>)', waiting:'shell-lock', holder:<memberId>}` 한 번.
    status 는 `working` 그대로(CLI 는 도구를 부른 채 우리 응답을 기다린다).
  - `shell.on('warn')`(상한 초과 강제 해제) → `daemon.notice{warn}`.

### 4. 문서·테스트

- `PROTOCOL.md` — 오피스 이벤트에 `running{waiting:'shell-lock'}` 항목 + 새 절 "팀 셸 뮤텍스 (T27)"(잡는 시점·읽기 예외·
  해제 4가지·hook 이 먼저 끊길 때·팀 경계).
- `test/office/ShellMutex.test.ts` — 순수 8건 + Office 배선 7건.
- `test/office/MixedTeam.test.ts` — 같은 팀의 Claude·Codex 가 쓰기 셸 명령을 이어서 내는 매핑 테스트에 대기 이벤트가
  끼게 됐다(락이 실제로 걸린다는 뜻). 그 테스트는 **도구 매핑**만 보므로 `detail.waiting === 'shell-lock'` 을 걸러 보게 했다.

## 검증

```
$ npx tsc --noEmit
(출력 없음)

$ npx tsx --test "test/**/*.test.ts"
ℹ tests 367
ℹ pass 362
ℹ fail 0
```

`test/office/ShellMutex.test.ts` 15건 중 배선 쪽 7건이 보는 것:

```
✔ 같은 팀의 두 번째 셸 명령은 앞 명령의 PostToolUse 까지 응답이 보류된다
✔ 읽기 전용 명령은 락을 안 기다린다 (D-27)
✔ PostToolUseFailure 도 락을 푼다 (실측 02 §②: 실패 시 PostToolUse 는 안 온다)
✔ 앞 멤버를 interrupt 하면 락이 풀려 다음 사람이 들어간다
✔ 턴 종료(Stop)·퇴근도 안전망으로 락을 푼다
✔ 다른 팀은 서로 막지 않는다
✔ 보류가 먼저 끊기면(hold-closed, D-11) 대기 줄에서 빠진다
```

핵심은 **"hook 응답이 실제로 안 나갔다"** 를 본다는 것이다(`fakeReq().sent` 가 빈 배열) — 이벤트만 보면 "대기 중이라고
말은 하는데 CLI 는 그냥 실행하는" 가짜 뮤텍스를 못 잡는다.

## 발견한 함정

1. **대기 이벤트가 도구 이벤트보다 먼저 나갔다.** 어댑터가 `PreToolUse` 에서 게이트를 먼저 부르고 도구 이벤트를 나중에
   남기던 순서라, 말풍선이 `running{cmd}` 로 끝나 "대기 중" 이 1틱 만에 덮였다. 어댑터에서 **도구 이벤트 → 게이트** 로
   순서만 바꿔 고쳤다(다른 동작 변화 없음).
2. **보류가 먼저 끊긴 대기자를 안 빼면 팀이 굳는다.** hook timeout·연결 끊김이면 응답이 `{}` 로 나가 그 명령은 그냥
   실행되는데(D-11), 대기 줄에는 그대로 남아 있다 → 앞 명령이 끝나면 "아무도 안 기다리는 자리" 가 락을 받아 쥐고,
   상한 30분이 지나야 풀린다. `toolGate` 에 `AbortSignal` 을 넘겨 빼도록 했다. 반대로 **락을 이미 쥔 쪽은 abort 로 풀지
   않는다** — hook 이 끊겨도 그 명령은 계속 돌고 있다.
3. **읽기 명령까지 잡으면 팀이 한 줄로 선다.** 설계 문장(“허가 여부와 무관하게 `PreToolUse` 에서”)을 곧이곧대로 구현하면
   `ls`·`cat` 도 직렬화된다. D-27 로 예외를 못 박았다.
4. **같은 팀에 넣어 둔 기존 테스트가 깨진다.** `MixedTeam.test.ts` 의 매핑 테스트는 Claude 가 쓰기 셸 명령을 `PostToolUse`
   없이 던져 둔 상태에서 Codex 가 셸 명령을 내는 모양이라, T27 이 붙자 대기 이벤트가 끼었다 — 뮤텍스가 **엔진을 안 가리고**
   같은 팀이면 건다는 증거이기도 하다.

## 결정

D-27(락은 `PreToolUse` 기준, 읽기 전용은 예외 + 딸린 결정 5가지) — 04-결정기록.md.

## 남은 것

- **실기 확인(M4 시연):** 팀원 둘에게 `flutter test` / `echo … > …` 를 동시에 시켜 두 번째 캐릭터가 실제로 대기하는지,
  30분 상한이 긴 빌드에서 잘못 발화하지 않는지. hook `timeout` 은 86400(D-16)이라 보류 자체는 버틴다.
- **앱 표시:** `running{waiting:'shell-lock'}` 을 "대기 중" 포즈·말풍선으로 그리는 것은 M4 UI 몫(지금은 이벤트만).
- **팀장 프롬프트:** "빌드·테스트는 한 번에 한 명" 규칙(01 §4)은 여전히 프롬프트 쪽 몫 — 뮤텍스는 마지막 방어선이다.
- **락 상한 설정화:** 지금은 `ShellMutex` 기본값(30분) 고정. `config.ts` 노출은 필요해지면(T27 범위 밖).
