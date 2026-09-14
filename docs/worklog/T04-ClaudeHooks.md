# T04 — ClaudeHooks 어댑터

- 날짜: 2026-09-14
- 마일스톤: M0
- 관련 설계: 01 §구성 요소 1(ClaudeHooks 어댑터, 대기 정책, interrupt/fire/error 후처리), §2 오피스 이벤트 스키마, §실측 결과 반영 / 02 §②③ / 04 D-04, D-05, D-11
- 커밋: (미커밋 — 상위 태스크에서 묶어 커밋)

## 목표

HookReceiver(T03)의 `'hook'` 요청을 받아 Claude Code hook 이벤트를 설계 §2 표의 오피스 이벤트로 바꿔 Store(T06)에 쌓고, 멤버 status 를 갱신하고, `PermissionRequest` / `AskUserQuestion` 을 `pending(approval|question)` 으로 만들어 사용자 답이 올 때까지 hook 응답을 붙들었다가 스파이크에서 먹힌 결정 JSON 그대로 돌려준다. `SessionStart` 에는 멤버 INSTRUCTIONS.md 를 `additionalContext` 로 주입하고 `session_id` 를 모든 source 에서 갱신한다. T07(WS 서버)은 `approval.respond` / `question.respond` 를 `resolveApproval` / `resolveQuestion` 으로 넘기기만 하면 된다.

## 한 것

- `dev/daemon/src/adapters/types.ts` — `AdapterDeps { store, getInstructions(memberId), toolGate?(memberId, tool, input): Promise<void>, now?() }`, `ApprovalDecisionInput { behavior, updatedInput?, message? }`, `ToolDoneInfo { tool, ok, toolUseId, error? }`, `HoldLostReason`, 이벤트 맵 `ClaudeHooksAdapterEvents`.
- `dev/daemon/src/adapters/mapping.ts` — 순수 매핑. `mapPreToolUse(tool_name, tool_input) → { kind, detail } | null`, `toolDetail()`(PreToolUse 와 waiting_approval 이벤트가 같은 detail 공유), `pathFromInput()`(file_path → notebook_path → pattern → path → url → query 순), `shellFromInput()`(command → cmd, description → summary), `questionSummary()`(questions[].question 을 " / " 로 이음), `truncate()`. 상한: cmd 1000자, summary 300자, path 500자.
- `dev/daemon/src/adapters/ClaudeHooksAdapter.ts` — `class ClaudeHooksAdapter extends EventEmitter<ClaudeHooksAdapterEvents>`.

### 공개 API

| 메서드 | 동작 |
|---|---|
| `handleHook(req: HookRequest, member: Member): void` | HookReceiver `'hook'` 리스너에서 호출. emit 중 동기적으로 `respond()`/`hold()` 를 결정. **절대 throw 하지 않음** — 예외는 `console.error` + `'handler-error'(err, memberId, event)` 로 내고 아직 응답 전이면 `{}` |
| `resolveApproval(pendingId, { behavior, updatedInput?, message? }): boolean` | approval pending 에 답. `allow(updatedInput)` / `deny(message ?? 'Denied by user')` 를 보내고 `store.answerPending`, status `working`, `'pendingSettled'`. 모르는 id·type 불일치·이미 닫힘이면 `false` |
| `resolveQuestion(pendingId, answers: Record<question,label>): boolean` | question pending 에 답. `askAnswers(tool_input, answers)`(= allow + `updatedInput.answers`) 를 보내고 같은 정리 |
| `expireAllForMember(memberId): void` | interrupt/fire/error 후처리. 그 멤버의 보류 hook(사용자 대기 + toolGate 대기) 전부 `cancel()`(`{}`), `store.expireAllForMember`, 각 행 `'pendingSettled'`. status 가 `waiting_*` 였으면 `working` 으로 |
| `onHoldTimeout(memberToken, event)` / `onHoldClosed(memberToken, event)` | HookReceiver `'hold-timeout'` / `'hold-closed'` 연결점. receiver 가 이미 `{}` 로 닫은(=settled) 보류의 pending 을 expired 로, `error` 이벤트(`summary: 'hook hold timed out; answer in terminal'` 등, `pendingId`, `pendingType`), status `working` |
| `onSessionExit(memberId, exitCode)` | pty 종료. `expireAllForMember` 후 `error` 이벤트 `{ summary: 'process exited (code N)', exitCode }`, status `exited`(0) / `error`(그 외). `SessionEnd` 로 이미 `exited` 인 정상 종료(code 0)는 중복 이벤트 없음 |
| `heldPendingIds(memberId?)` | 사용자 답을 기다리는 pending id 목록(디버깅·테스트) |

이벤트: `event(OfficeEvent)`(store.appendEvent 를 거친 행, seq 포함) / `status(memberId, status)`(값이 바뀔 때만) / `sessionId(memberId, sessionId, source)` / `pendingCreated(Pending)` / `pendingSettled(Pending)`(answered·expired 최종 행) / `toolDone(memberId, { tool, ok, toolUseId, error? })` / `'handler-error'(err, memberId, event)`.

### 최종 매핑 표 (Claude Code)

| hook 이벤트 | 응답 | status | 오피스 이벤트 | 비고 |
|---|---|---|---|---|
| `SessionStart` (startup/resume/clear/compact) | `sessionStartContext(INSTRUCTIONS)` — 비어 있으면 `{}` | `idle` | `source==='resume'` 일 때만 `text{summary:'resumed'}` | `session_id` 항상 갱신 + `sessionId` emit |
| `UserPromptSubmit` | `{}` | `working` | `thinking{text: prompt[:200]}` | |
| `PreToolUse` Read/Glob/Grep/WebFetch/WebSearch/LS | `{}` (toolGate 있으면 hold → settle 후 `{}`) | `working` | `reading{tool, path}` | path ← file_path\|pattern\|path\|url\|query |
| `PreToolUse` Edit/Write/NotebookEdit/MultiEdit | 〃 | `working` | `editing{tool, path}` | path ← file_path\|notebook_path |
| `PreToolUse` Bash/PowerShell | 〃 | `working` | `running{tool, cmd, summary}` | cmd ← command, summary ← description |
| `PreToolUse` `mcp__*` / 모르는 도구 | 〃 | `working` | `running{tool, summary?}` | summary ← description 있을 때만 |
| `PreToolUse` AskUserQuestion | `{}` (게이트 안 탐) | `working` | 없음 | PermissionRequest 에서 처리 |
| `PermissionRequest` AskUserQuestion | **hold** → `resolveQuestion` 시 `allow({...tool_input, answers})` | `waiting_answer` | `asking{tool, summary: 'Q1 / Q2'}` ref `{questionId}` | `pending(question){questions, tool_input}` |
| `PermissionRequest` 그 외 | **hold** → `resolveApproval` 시 `allow(updatedInput?)` / `deny(message)` | `waiting_approval` | `waiting_approval{tool, cmd/path/summary}` ref `{approvalId}` | `pending(approval){tool_name, tool_input, permission_suggestions}` |
| `PostToolUse` / `PostToolUseFailure` | `{}` | `working` | 없음 | 내부 `toolDone{tool, ok, toolUseId, error?}` (뮤텍스 해제용) |
| `Notification` | `{}` | 유지 | 없음 | permission_prompt 알림도 무시(이미 waiting_approval) |
| `Stop` | `{}` (절대 block 안 함) | `idle` | `text{text: last_assistant_message[:4000]}`(있을 때) → `idle{}` | |
| `SubagentStop` / `PreCompact` / `Interrupt`(Codex) / 미지 이벤트 | `{}` | 유지 | 없음 | |
| `SessionEnd` reason=clear / resume | `{}` | 유지 | 없음 | 같은 프로세스에서 새 `SessionStart` 가 따라옴 |
| `SessionEnd` 그 외 (prompt_input_exit, logout, other …) | `{}` | `exited` | `idle{summary:'session ended: <reason>'}` | |
| (pty exit) `onSessionExit` | — | `exited`(0) / `error`(≠0) | `error{summary:'process exited (code N)', exitCode}` | pending 전부 expired |
| (hold-timeout / hold-closed) | receiver 가 이미 `{}` | `working` | `error{summary, pendingId, pendingType}` | pending expired = "재지시 필요" 흔적 |

- `dev/daemon/test/adapters/mapping.test.ts` — 매핑 표 7건.
- `dev/daemon/test/adapters/ClaudeHooksAdapter.test.ts` — 인메모리 Store + 가짜 `HookRequest`(respond/hold/resolve/cancel 로 나간 JSON 기록) 18건. 페이로드는 `dev/spike-0/hooklog-2.json`(SessionStart startup/clear, UserPromptSubmit, PreToolUse·PermissionRequest·PostToolUse Bash/Write/AskUserQuestion, Notification, Stop, SessionEnd clear/prompt_input_exit), `hooklog.json`(SessionStart resume), `run11.log`(PostToolUseFailure 키: `error, is_interrupt, duration_ms`) 그대로.

## 검증

```
$ cd dev/daemon && node --version
v24.14.1

$ npx tsc --noEmit
(출력 없음, exit 0)

$ npx tsx --test test/adapters/*.test.ts
▶ ClaudeHooksAdapter
  ✔ SessionStart(startup): stores session_id, emits sessionId, responds additionalContext, status idle, no event
  ✔ SessionStart with empty instructions → {} ; clear/resume update session_id again; resume appends text{resumed}
  ✔ UserPromptSubmit → status working + thinking{text: prompt[:200]}
  ✔ PreToolUse mapping: Bash → running{cmd,summary}, Write → editing{path}, Read → reading, mcp → running, AskUserQuestion → none
  ✔ PermissionRequest(Bash) → pending(approval) + waiting_approval event + hold; resolveApproval(allow) sends exact allow JSON
  ✔ resolveApproval(allow, updatedInput) / (deny, message) build the exact decision JSON
  ✔ PermissionRequest(AskUserQuestion) → pending(question) + asking + waiting_answer; resolveQuestion sends updatedInput.answers
  ✔ PostToolUse / PostToolUseFailure → toolDone only (no office event), status working
  ✔ Stop → text{last_assistant_message[:4000]} + idle event, status idle, responds {} (never blocks)
  ✔ SubagentStop / PreCompact / Notification / Interrupt → {} and nothing else
  ✔ SessionEnd(clear) → nothing; SessionEnd(prompt_input_exit) → idle{session ended} + status exited
  ✔ onSessionExit: code 0 after SessionEnd → no duplicate; code 1 → status error + error event; open pending expired
  ✔ expireAllForMember settles held handles with {} and marks pending expired; waiting_* → working
  ✔ onHoldTimeout (receiver already sent {}) → pending expired, error event, status working
  ✔ resolveApproval on a handle the receiver already closed → false and pending expired
  ✔ handler exceptions are swallowed: {} is sent and handler-error emitted
▶ ClaudeHooksAdapter + toolGate
  ✔ PreToolUse is held until the gate promise settles, then {} (resolve and reject alike)
  ✔ expireAllForMember cancels gate holds with {} too
▶ mapping: PreToolUse tool_name → kind/detail
  ✔ reading tools take path from file_path|pattern|path|url|query
  ✔ editing tools: Edit/Write/NotebookEdit/MultiEdit → editing with path
  ✔ shell tools: Bash/PowerShell → running with cmd + summary
  ✔ AskUserQuestion → null (asking is produced from PermissionRequest)
  ✔ mcp__* and unknown tools → running with tool (and summary from description)
  ✔ helpers tolerate non-object input and truncate long strings
  ✔ questionSummary joins question texts
ℹ tests 25  ℹ pass 25  ℹ fail 0

$ npx tsx --test test/store/*.test.ts test/hooks/*.test.ts test/adapters/*.test.ts
ℹ tests 47  ℹ pass 47  ℹ fail 0
```

검증한 결정 JSON(스파이크 02 §②③ 과 동일):
- allow: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` (+ `updatedInput`)
- deny: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"not now"}}}`
- AskUserQuestion: `decision.updatedInput = { ...tool_input, answers: { "좋아하는 색은?": "파랑" } }`
- SessionStart: `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[테스트 팀원 startup]"}}`

## 발견한 함정

- **`PermissionRequest` 페이로드에는 `tool_use_id` 가 없다**(실측 hooklog-2 #3, #8, #14). PreToolUse 와 PermissionRequest 를 tool_use_id 로 짝지을 수 없어 pending 은 도구 이름·입력만 담는다. `toolDone` 의 `toolUseId` 는 PostToolUse 것.
- **`toolGate` 는 동기 호출해야 한다.** 처음엔 `Promise.resolve().then(() => gate(...))` 로 미뤘더니 hook 도착 순서와 락 획득 순서가 어긋날 수 있었다(테스트에서 바로 드러남). 지금은 `gate()` 를 `handleHook` 안에서 바로 부르고(동기 throw 도 reject 로 흡수) settle 만 비동기로 기다린다.
- `assert.deepEqual(arr, [])` 는 tsc 가 `arr` 를 `never[]` 로 좁혀 이후 `arr[0].detail` 이 타입 오류가 된다 → 테스트에서는 `assert.equal(arr.length, 0)` 을 쓴다.
- `HookEvent` 타입에 `PreCompact` 가 없다(T03 실측 목록). 어댑터는 `default` 분기에서 `{}` 로 흘리므로 동작엔 문제 없음. 실측되면 T03 `HOOK_EVENTS` 에 추가.

## 결정

스펙 문구가 모호했던 부분을 이렇게 정했다(04 에 D-## 로 올릴 후보는 첫 두 개):

1. **`SessionEnd` 의 in-process reason 은 `clear` 와 `resume`.** 스펙은 `clear` 만 예외였지만, 터미널 탭에서 `/resume` 을 치면 `SessionEnd(reason=resume)` → `SessionStart(source=resume)` 가 같은 프로세스에서 이어질 수 있다. 실제 종료는 어차피 `onSessionExit`(pty exit) 가 잡으므로, 모호한 reason 은 "종료 아님" 쪽이 안전하다. 그 외 reason(prompt_input_exit, logout, other …)은 전부 `exited`.
2. **hold 가 어댑터 결정 없이 닫히면(`hold-timeout`/`hold-closed`) `error` 이벤트를 남긴다.** 응답은 D-11 대로 `{}`(receiver 가 보냄)라 CLI 가 자기 TUI 프롬프트를 띄우는데, 앱에서는 pending 만 조용히 expired 되면 사용자가 알 길이 없다. 01 §대기 정책의 "내 책상에 재지시 필요" 를 `error{summary, pendingId, pendingType}` 로 표현하고 status 는 `working`(CLI 가 주도권을 가진 상태)으로 되돌린다.
3. **`onSessionExit` 는 exitCode 와 무관하게 `error` 이벤트**(01 §2 표: "프로세스 종료 → error"). status 만 `exited`(0)/`error`(≠0) 로 나눈다. `SessionEnd` 가 먼저 와서 이미 `exited` 인 정상 종료는 이벤트를 또 내지 않는다.
4. **`expireAllForMember` 는 `waiting_*` 를 `working` 으로 되돌린다.** open pending 이 없는데 `waiting_approval` 로 남으면 스냅샷이 모순된다. 실제 idle 판정은 상위(T05/ScreenModel 준비 문구)가 한다.
5. **`PostToolUse`/`PostToolUseFailure` 는 오피스 이벤트를 만들지 않는다.** 도구 실패는 정상 흐름이고, 완료는 다음 PreToolUse/Stop 으로 암시된다. 뮤텍스 해제(T27)용으로 내부 `toolDone` 만 낸다.
6. **`toolGate` 는 절대 deny 로 이어지지 않는다**(D-11 확장): reject/throw 도 `{}`. AskUserQuestion 은 게이트를 타지 않는다.
7. `PreToolUse` 에서도 status 를 `working` 으로 맞춘다(허가 후 첫 도구 호출 등에서 상태가 되돌아오게).
8. `resolveApproval` 의 `updatedInput` 은 객체일 때만 실어 보낸다(아니면 plain allow). `deny` 의 기본 message 는 `'Denied by user'`.
9. `status` emit 은 값이 실제로 바뀔 때만(store 의 현재 값과 비교). `event` 의 `ts` 는 `deps.now()` 로 만들어 테스트에서 고정 가능.

## 남은 것

- HookReceiver ↔ 어댑터 배선(`receiver.on('hook', req => adapter.handleHook(req, store.getMemberByToken(req.memberToken)))`, `'hold-timeout'` → `onHoldTimeout`, `'hold-closed'` → `onHoldClosed`, PtyManager `'exit'` → `onSessionExit`)은 T07/데몬 조립 쪽.
- `member.interrupt` 후 idle 판정(ScreenModel 준비 문구)은 T05. 어댑터는 `expireAllForMember` 만 제공.
- 팀 셸 뮤텍스(T27)는 `toolGate` + `toolDone` 으로 붙인다. 뮤텍스 보유 상한(30분) 경고 이벤트도 거기서.
- Codex 어댑터(T20)는 `mapping.ts` 의 도구 표를 재사용하지 못한다(도구 이름 체계가 다름) — 이벤트 흐름(`handleHook` 골격, pending·hold 관리)만 공유 가능하도록 분리 여부는 T20 에서 판단.
- `HOOK_EVENTS` 에 `PreCompact` 추가(T03 파일이라 여기서는 안 건드림) 및 `SessionEnd(reason=resume)` 실측.
- 04-결정기록.md 에 위 결정 1·2 D-## 기입(문서 범위 밖이라 여기서는 안 건드림).
