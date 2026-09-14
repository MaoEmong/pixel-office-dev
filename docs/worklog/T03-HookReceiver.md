# T03 — HookReceiver + hook.js

- 날짜: 2026-09-14
- 마일스톤: M0
- 관련 설계: 01 §HookReceiver, §대기 정책, §실측 결과 반영 / 02 §②③④ / 04 D-03, D-04, D-05
- 커밋: (미커밋 — 상위 태스크에서 묶어 커밋)

## 목표

CLI(claude / codex)에 주입한 hook 명령이 stdin 페이로드를 데몬으로 올리고, 데몬이 즉시 또는 사용자가 답할 때까지 보류했다가 결정 JSON을 돌려줄 수 있다. 어댑터(T04)는 `HookReceiver`의 `'hook'` 이벤트만 구독하면 되고, 결정 JSON은 `decisions.ts` 빌더로 만들어 스파이크에서 먹힌 모양이 그대로 나간다.

## 한 것

- `dev/daemon/src/hooks/hook.js` — 의존성 없는 단일 파일. `node <슬래시경로>/hook.js <port> <event>` 로 실행되어 stdin 전체를 `POST http://127.0.0.1:<port>/hook/<PIXEL_MEMBER>/<event>` 로 보내고 응답 본문을 stdout 에 그대로 출력. 어떤 실패(인자 오류, ECONNREFUSED, 연결 타임아웃 2s, 소켓 끊김)에도 `{}` 출력 + exit 0. 연결 **후**에는 idle 타임아웃을 두지 않아 데몬이 수 시간 보류해도 끊기지 않는다. `agent:false`(keep-alive 없이 1회용 소켓). 주석 한국어.
  - 데몬 패키지가 `"type":"module"` 이라 이 경로에서는 ESM 으로 실행된다 → `typeof require === 'function' ? require('http') : process.getBuiltinModule('http')` 로 CJS/ESM 양쪽에서 동작(Node 22.3+).
- `dev/daemon/src/hooks/HookReceiver.ts` — `class HookReceiver extends EventEmitter<HookReceiverEvents>`
  - `listen(port, host='127.0.0.1'): Promise<number>`(실제 바인딩 포트 반환, 0 이면 임시 포트), `close(): Promise<void>`(열린 보류 전부 `{}` 로 닫고 종료), `port` getter, `pendingHolds(): PendingHold[]`.
  - 라우트 `POST /hook/<memberToken>/<event>` 만. 그 외는 404 `{}` + `'bad-request'{reason:'not-found'}`. 본문 16MB 초과 413 `{}` + `'bad-request'{reason:'body-too-large'}`.
  - JSON 파싱 실패 → 200 `{}` + `'bad-payload'{memberToken,event,bodyHead,error}`(`'hook'` 은 emit 안 함).
  - 정상 → `'hook'` emit: `{ memberToken, event, payload, respond(json): boolean, hold(): DecisionHandle }`. emit 중 **동기적으로** `respond`/`hold` 를 부르지 않으면 즉시 `{}`. 늦은 `respond` 는 `false` 반환(무시). `hold()` 는 이미 응답/보류 상태면 throw.
  - `DecisionHandle = { memberToken, event, since, settled, resolve(json): boolean, cancel(): boolean }`. `resolve`/`cancel` 은 첫 호출만 유효(두 번째부터 `false`).
  - 보류 상한 `maxHoldMs`(기본 24h = `DEFAULT_MAX_HOLD_MS`) 초과 시 `{}` 전송 + `'hold-timeout'`. hook 프로세스가 먼저 끊기면(CLI 종료·hook timeout) `'hold-closed'`.
  - `'hook'` 리스너가 throw 하면 아직 응답 전일 때만 `{}` 로 닫고 `'handler-error'(err, {memberToken,event,payload})`.
  - 옵션 `isKnownMember?(token)`: 기본은 전부 허용(스펙대로 여기서는 토큰을 검사하지 않음). 넘기면 `false` 인 요청은 `{}` + `'unknown-member'` 로 빠지고 `'hook'` 은 안 간다.
  - 서버 `keepAliveTimeout/headersTimeout/requestTimeout/timeout` 모두 0 — 보류 중 Node http 서버가 응답을 끊지 않게.
- `dev/daemon/src/hooks/decisions.ts` — `allow(updatedInput?)`, `deny(message)`, `sessionStartContext(text)`, `askAnswers(toolInput, answers)`, `PASS_THROUGH`(`{}`). 타입 `PermissionRequestOutput`, `SessionStartOutput`, `PermissionDecision`.
- `dev/daemon/src/hooks/types.ts` — `HOOK_EVENTS`/`HookEvent`(SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Notification, Stop, SubagentStop, SessionEnd, Interrupt), 참고용 `DECISION_EVENTS`, `isHookEvent()`, `isDecisionEvent()`, 느슨한 `HookPayload`(session_id, transcript_path, cwd, hook_event_name, model, permission_mode, source, tool_name, tool_input, tool_response, tool_use_id, last_assistant_message, reason, turn_id, prompt, prompt_id + 인덱스 시그니처).
- `dev/daemon/test/hooks/HookReceiver.test.ts` — hook.js 를 실제 자식 프로세스로 띄우는 왕복 테스트 14건.

## 검증

```
$ node --version
v24.14.1

$ npm run typecheck
src/screen/tuiMap.ts(103,66): error TS2367: This comparison appears to be unintentional ...
```
→ 유일한 오류는 `src/screen/tuiMap.ts`(T02 범위, 이 태스크 파일 아님). `src/hooks/`, `test/hooks/` 는 오류 0.

```
$ npx tsx --test test/hooks/*.test.ts
▶ HookReceiver + hook.js
  ✔ roundtrip: handler respond() → child stdout equals the response JSON (100.8ms)
  ✔ no respond/hold during emit → child gets {} immediately (75.3ms)
  ✔ hold() + resolve after 300ms → child waits and gets the resolved JSON (387.5ms)
  ✔ hold-timeout (maxHoldMs=200) → child gets {} and hold-timeout is emitted (278.7ms)
  ✔ handle.cancel() → child gets {} (138.3ms)
  ✔ hold() after respond() throws → handler-error emitted, first response stands (73.2ms)
  ✔ handler throws before responding → child gets {} and handler-error emitted (78.2ms)
  ✔ unknown memberToken → {} and unknown-member emitted, no hook event (72.5ms)
  ✔ hold-closed: hook process disconnects before decision (121.5ms)
  ✔ daemon down: hook.js prints {} and exits 0 within ~3s (73.6ms)
  ✔ invalid JSON body → {} and bad-payload emitted, no hook event (72.5ms)
  ✔ non-POST / unroutable URL → 404 {} and bad-request emitted (15.7ms)
  ✔ close() settles open holds with {} (94.4ms)
▶ decisions builders
  ✔ shapes match the spike-verified JSON (0.3ms)
ℹ tests 14  ℹ pass 14  ℹ fail 0
```

hook.js 를 `"type":"module"` 패키지 밖(scratchpad)에 복사해 CommonJS 로도 실행 확인:
```
$ echo '{"a":1}' | PIXEL_MEMBER=tok1 node <scratchpad>/cjs/hook.js 1 PreToolUse
{} (exit 0)                      # 닫힌 포트 → ECONNREFUSED → {}
$ echo '{"a":1}' | node <scratchpad>/cjs/hook.js notaport X
{} (exit 0)                      # 인자 오류도 {}
$ echo '{}' | node src/hooks/hook.js
{} (exit 0)                      # ESM, 인자 없음
```

## 발견한 함정

- **`hook.js` 는 ESM 으로 실행된다.** 데몬 `package.json` 의 `"type":"module"` 이 `src/hooks/hook.js` 에도 적용되어 `require` 가 없다. `process.getBuiltinModule('http')` 폴백으로 해결(Node 22.3+; 데몬은 24). 파일을 다른 곳으로 옮겨 CJS 로 실행돼도 동작.
- **Node http 서버의 기본 타임아웃이 보류를 끊는다.** `requestTimeout`(기본 300s)·`headersTimeout` 이 켜져 있으면 장시간 보류 중 서버가 소켓을 닫는다. 넷 다 0 으로 꺼야 한다.
- **daemon-down 테스트는 ECONNREFUSED 경로만 검증.** 루프백에서 닫힌 포트는 즉시 거절되므로 2s 연결 타임아웃 분기(SYN 이 버려지는 경우)는 실측 안 됨. 코드 경로는 `socket.connecting` 일 때만 타이머를 걸고 `connect` 시 해제하는 단순 구조라 위험 낮음.
- 요청 본문이 JSON 이지만 객체가 아니면(배열·숫자) `payload = { raw: <값> }` 로 감싸 `'hook'` 을 보낸다(파싱 실패로 취급하지 않음).

## 결정

- 보류 상한 초과 시 응답은 **`{}`(pass-through)**, `deny` 가 아니다. 01 §대기 정책의 "상한 직전에 deny" 는 어댑터(T04)가 `'hold-timeout'` 보다 앞선 자체 타이머로 구현할 수 있게 receiver 는 중립을 지킨다(01 §뮤텍스의 "포기시키는 것보다 pass-through" 원칙과 일치). → 04 에 D-## 추가 후보.
- `hold()` 는 이벤트 종류를 제한하지 않는다. 어떤 이벤트를 붙들지는 어댑터가 결정하고, `DECISION_EVENTS` 는 참고용으로만 export.
- memberToken 검증은 receiver 밖(어댑터). `isKnownMember` 옵션은 있지만 기본은 전부 통과.

## 남은 것

- `src/screen/tuiMap.ts` 의 typecheck 오류는 T02 범위 → 그쪽에서 처리.
- 상한 24h 실측(Claude/Codex hook `timeout: 86400` 이 실제로 먹는지)은 어댑터 연동(T04) 때 확인.
- `docs/04-결정기록.md` 에 hold-timeout = pass-through 결정 D-## 기입(이 태스크에서는 문서 범위 밖이라 안 건드림).
