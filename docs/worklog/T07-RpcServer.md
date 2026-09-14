# T07 — Office 조립 + WS JSON-RPC 서버

- 날짜: 2026-09-14
- 마일스톤: M0
- 관련 설계: 01 §구성 요소 1(와이어 프로토콜, 입력 직렬화, interrupt/fire/error 공통 후처리, 데몬 재시작 복구), §2 오피스 이벤트 스키마, §3 Flutter(재접속·터미널 탭), §실측 결과 반영 / `dev/daemon/PROTOCOL.md` / 04 D-03, D-04, D-05, D-07, D-11, D-14, D-15
- 커밋: (미커밋 — 상위에서)

## 목표

T01~T06 모듈을 한 프로세스로 묶어 실제로 도는 데몬을 만든다. `Office` 하나가 Store·PtyManager·HookReceiver·어댑터를 소유하고 멤버마다 ScreenModel·InputQueue 를 붙여 "팀 생성 → 출근 → 지시 → 허가 → 보고 → 퇴근 → 종료" 를 메서드로 제공하고, `RpcServer` 가 그것을 PROTOCOL.md 의 JSON-RPC 2.0 으로 노출한다. 이 태스크가 끝나면 콘솔 클라이언트(T08)·Flutter(M1)가 `ws://127.0.0.1:7420` 에 붙어 v1a 흐름을 돌릴 수 있고, 실제 `claude.exe` 로 지시 → 허가 → 파일 생성까지 왕복이 검증돼 있다.

## 한 것

- `dev/daemon/src/office/errors.ts` — `RPC_ERROR`(-32001 인증, -32002 없음, -32003 상태, -32004 직급, -32602/-32601/-32700/-32600/-32000 표준) + `OfficeError(code, message, data?)`. Office 는 이걸 던지고 RpcServer 는 코드를 그대로 옮긴다.
- `dev/daemon/src/office/types.ts` — `DaemonInfo`(daemon.json), RPC 파라미터 타입(`CreateTeamParams`, `ClockInParams`, `AttachResult`, `ApprovalRespondParams`), `DerivedStatus`, `OfficeEvents`(`event`/`status`/`term`/`notice`/`shutdown`), **`OfficeApi`**(RpcServer 가 보는 인터페이스 — 테스트에서 가짜로 대체), `PtyManagerLike`/`HookReceiverLike`(Office 가 받는 구조적 인터페이스 — 테스트에서 가짜 pty/receiver 주입).
- `dev/daemon/src/office/Office.ts` — 오케스트레이터. 공개 API:

  | 메서드 | 동작 |
  |---|---|
  | `new Office({ config?, store?, pty?, receiver?, hookScriptPath?, version? })` | config.ts 기본값 위에 덮어쓰기. store 생략 시 `${dataDir}/pixel-office.db`. 생성 시점에 어댑터·수신기·pty 이벤트 배선 |
  | `start(): Promise<DaemonInfo>` | dataDir 생성, `receiver.listen(hookPort)`, `${dataDir}/daemon.json` `{ wsPort, hookPort, token(32바이트 hex, 기동마다 새로), pid, startedAt, version }`, `store.pruneEvents()` 1회 |
  | `updateDaemonInfo({ wsPort })` | 실제 WS 포트가 설정과 다를 때(임시 포트 0) 재기록 |
  | `snapshot()`, `getMember(id)`, `eventsSince(seq)`(1000건 페이지를 끝까지 이어 붙임), `eventsQuery(input)` | Store 위임 |
  | `createTeam({ name, cwd, leaderEngine, maxMembers?, allowedEngines? })` | v1a: 팀만(팀장 자동 출근 없음). cwd 가 폴더가 아니면 -32602. leaderEngine 은 값 검사만(저장 안 함) |
  | `deleteTeam(teamId)` | 살아 있는 멤버 전부 `clockOut` 후 삭제(events 는 남음) |
  | `clockIn({ teamId, engine, name, instructions? })` | 정원·허용 엔진 검사 → `createMember(rank:'member', hiredBy:'user', status:'starting', cwd = team.cwd)` → 지시문 파일 → `spawnMember` |
  | `clockOut(memberId)` | `exitMode='clockOut'`, 큐 비우고 정지, `adapter.expireAllForMember`, `store.abortTasksFor`, `pty.kill(graceful)`(Claude `/exit`, 8초) → `idle{summary:'clocked out'}` + status exited. 행은 남는다. 이미 exited/error 면 -32003. 프로세스 없이 status 만 살아 있는 행(데몬 재시작 후)은 상태만 정리 |
  | `rehire(memberId)` | exited/error 멤버만. `session_id` 있으면 `--resume` |
  | `restart(memberId)` | 살아 있으면 `exitMode='restart'` 로 종료 → `--resume` 재스폰 → 큐에 `{kind:'system', text: RESUMED_TEXT}` |
  | `instruct(memberId, text): taskId` | `tasks(from:'user', to, status:'queued')` → 큐 `{kind:'instruct', text:'[TASK#n from user]\n<text>', id:String(taskId)}`. 큐 `flushed` 에서 `assigned`, 그 턴 `Stop`(idle 이벤트)에서 `reported`(report_text = 직전 `text` 이벤트) + `reporting{summary}` ref `{taskId}` 이벤트 |
  | `typeRaw(memberId, data)` | `queue.typeRaw` (즉시 write + 타이핑 grace 갱신) |
  | `interrupt(memberId)` | `queue.clear()` + `queue.interrupt()`(Ctrl+C) + pending expired + task aborted + 화면 감시(250ms×8s: `interrupted()`∨`promptReady()` 이고 status working 이면 `idle{summary:'interrupted'}` + idle). 1.5초 안 두 번째 호출 -32003 |
  | `attach(clientId, memberId, cols, rows)` | attach 집합에 추가, 마지막 attach 클라이언트로 지정, 그 크기로 screen+pty resize, `{ screen: serialize(), cols, rows }` |
  | `detach(clientId, memberId)`, `detachAll(clientId)` | 마지막 attach 클라이언트가 빠지면 남은 것 중 마지막이 승계 |
  | `resize(clientId, memberId, cols, rows)` | 마지막 attach 클라이언트만 적용, 그 외 무시. 범위 cols 20~500, rows 5~300 |
  | `getInstructions(memberId)` / `setInstructions(memberId, md)` | `${dataDir}/teams/<teamId>/members/<memberId>/INSTRUCTIONS.md`, `instructions_path` 갱신. 어댑터 `getInstructions` 도 같은 파일 |
  | `respondApproval(pendingId, { behavior, updatedInput?, message?, alwaysThisSession? })` | pending 검사(없음 -32002, 타입 불일치 -32602, 닫힘 -32003) → `adapter.resolveApproval`. `alwaysThisSession` 이면 멤버·도구를 기억해 다음 `pendingCreated` 에서 `setImmediate` 로 자동 allow + notice |
  | `respondQuestion(pendingId, answers)` | 동일 → `adapter.resolveQuestion` |
  | `shutdown()` | 전 런타임 `exitMode='shutdown'`, 전원 graceful kill(병렬) → `receiver.close()` → screen dispose → `store.close()` → daemon.json 삭제 → `'shutdown'` emit. **멤버 status 는 건드리지 않는다**(T09 복구용) |
  | `attachedClients(memberId)` | 진단용 |

  배선: `receiver 'hook'` → `store.getMemberByToken` → 없으면 `notice(warn)`(응답 안 하면 receiver 가 `{}`) / 있으면 `adapter.handleHook`. `'hold-timeout'`→`adapter.onHoldTimeout`+notice, `'hold-closed'`→`onHoldClosed`, `'bad-payload'`/`'handler-error'`→notice. `pty 'data'` → `screen.feed`(await 없음) + `'term'` emit. `pty 'exit'` → exitMode 별: shutdown 이면 무시 / clockOut·restart 면 expireAll + status exited(error 이벤트 없음) / 그 외(사용자 `/exit`·크래시)는 `adapter.onSessionExit` + `abortTasksFor`. `adapter 'event'` → `'event'` emit 후 v1a 보고 처리(text 기억, idle 에서 assigned task 닫기). `adapter 'status'` → `'status'(memberId, status, derived)`; derived 는 idle ∧ 배정 task 없음 → `free`, 그 외 status 그대로. `InputQueue.isIdle` = `member.status === 'idle' ∧ listOpenPending(member).length === 0`. 스폰 옵션: `memberToken`(→ `PIXEL_MEMBER`), `hookScriptPath` = `toForwardSlashes(src/hooks/hook.js 절대경로)`, `hookPort` = 실제 바인딩 포트, cols/rows = config(120×40).
- `dev/daemon/src/rpc/RpcServer.ts` — `ws` `WebSocketServer({ host:'127.0.0.1', port })`. `listen(): Promise<number>`(실제 포트), `close()`(클라이언트 1001 로 닫고 Office 구독 해제), `port`, `clientCount`. 연결마다 `{ id(uuid), authed, attached:Set<memberId> }`. 봉투 검사(파싱 실패 -32700 id null, `jsonrpc`/`method` 누락 -32600, id 없는 요청 무시) → 미인증이면 `hello` 외엔 -32001 + close 4001 → `hello` 토큰 검사(불일치 -32001 + 4001) → 결과 `{ daemon:{version,pid}, snapshot }` 전송 후 `since` 있으면 `office.eventsSince(since)` 를 `event` 알림으로 replay → 이후 메서드 표(PROTOCOL.md 의 19개 전부) 로 라우팅, 파라미터는 `reqStr/optStr/reqNum/optNum/reqEngine/optEngines` 로 검사(-32602). `OfficeError` 는 코드 그대로, 그 외 예외는 -32000. 알림: `event`(전원), `member.status{memberId,status,derived,member}`(전원), `term{memberId,data}`(attached 에 있는 클라이언트만), `daemon.notice{level,message}`(전원). 연결 종료 시 `office.detachAll(clientId)`. `daemon.shutdown` 은 `{}` 응답 → `setImmediate` 에서 `daemon.notice(info)` 방송 + `office.shutdown()`; 서버 자체는 Office `'shutdown'` 을 받은 index.ts 가 닫는다.
- `dev/daemon/src/index.ts` — `Office.start()` → `RpcServer.listen()` → 포트가 다르면 `updateDaemonInfo` → 경로·포트 로그 → `office.once('shutdown')` 에서 `rpc.close()` + `process.exit(0)`. SIGINT/SIGTERM → `office.shutdown()`(두 번째 시그널은 강제 종료). `npm start`/`npm run dev` 그대로. node:sqlite ExperimentalWarning 은 Store 모듈 필터가 처리(추가 작업 없음).
- `dev/daemon/PROTOCOL.md` — 아래 "PROTOCOL.md 변경" 참고. 메서드·파라미터 이름은 하나도 바꾸지 않았다.
- `dev/daemon/test/rpc/RpcServer.test.ts` (9건) — 가짜 Office(`OfficeApi` 구현, 호출 기록) + 실제 ws 클라이언트. hello 인증 성공/실패(-32001 + close 4001), 미인증 호출, `since` replay(응답 → seq>since 오름차순만, `eventsSince(2)` 호출 확인), 19개 메서드 라우팅과 결과 모양, 에러 코드 7종(-32602/-32002/-32003/-32601/-32700/-32600 + 인증 후 오류가 소켓을 안 끊음), 알림 방송(미인증 클라이언트 제외)·`term` 은 attach 한 클라이언트만·detach 후 중단, 연결 종료 → `detachAll(같은 clientId)`, `daemon.shutdown` 순서(응답 → notice → `office.shutdown()`).
- `dev/daemon/test/office/Office.test.ts` (11건) — 인메모리 Store + 가짜 PtyManager(spawn 옵션·write/paste/keys/resize 기록, `exit()`/`data()` 로 이벤트 주입) + 가짜 HookReceiver + T04 와 같은 가짜 HookRequest. 화면은 **실제 ScreenModel** 에 `test/screen/fixtures/claude-ready.txt`/`claude-interrupted.txt` 를 흘려 넣어 promptReady/interrupted 를 진짜로 판정한다. daemon.json 필드·토큰 / clockIn 행·스폰 옵션(토큰, 슬래시 경로 + 파일 존재, hook 포트, cols/rows, resume 없음)·INSTRUCTIONS.md·정원·엔진 허용·없는 팀·cwd 검사 / hook 토큰 라우팅(SessionStart → additionalContext 응답·idle·session_id, 모르는 토큰 → notice 만) + term 이벤트 / instruct(queued → idle∧ready 에서 paste → Enter 후 assigned → Stop 에서 reported + reporting 이벤트) / clockOut(abort·graceful kill·`/exit`·exited·error 이벤트 없음·두 번째 -32003) + rehire(`--resume`) / restart([RESUMED] paste, `text{resumed}`) / approval(pending·waiting_approval·allow JSON·오류 코드·alwaysThisSession 자동 allow, 다른 도구는 대기) / attach·detach·resize 소유권 / interrupt(ctrl-c·큐 비움·abort·가드·화면 기반 idle) / 예상 못 한 exit(error 이벤트·status error·abort) / deleteTeam·shutdown(status 유지, daemon.json 삭제, 두 번째 no-op).
- `dev/daemon/test/office/integration.test.ts` (opt-in, `PIXEL_IT=1`) — 실제 데몬을 `node --import tsx src/index.ts` 자식 프로세스로(임시 포트 2개 + 임시 dataDir 을 env 로) 띄우고 `daemon.json` 을 읽어 WS 로 접속. `team.create`(sandbox) → `member.clockIn(claude)` → status idle 대기 → `member.instruct("셸 명령 \"echo t07 > t07.txt\"를 실행해줘. 다른 건 하지 마.")` → `waiting_approval` 이벤트 대기 → `approval.respond(allow)` → `idle` 이벤트 대기 → `t07.txt` 존재 확인 → `member.attach` → `member.clockOut` → `daemon.shutdown` → 자식 종료·daemon.json 삭제 확인. finally 에서 데몬·claude 잔여 프로세스 정리(`taskkill /T /F`)와 t07.txt 삭제.

## 검증

```
$ cd dev/daemon && node --version
v24.14.1

$ npx tsc --noEmit
(출력 없음, EXIT=0)

$ npx tsx --test test/rpc/*.test.ts test/office/*.test.ts
▶ Office
  ✔ start(): daemon.json has wsPort/hookPort/token/pid/startedAt/version; token is 32 random bytes (11.7532ms)
  ✔ clockIn: member row + spawn options (PIXEL_MEMBER token, forward-slash hook.js, hook port) + INSTRUCTIONS.md (17.4541ms)
  ✔ hook 'hook' routes by member token to the adapter; unknown token → notice only (9.2643ms)
  ✔ instruct: task(from user, queued) + `[TASK#n from user]` pasted when idle ∧ prompt ready; Stop → reported + reporting event (1098.9879ms)
  ✔ clockOut: aborts open tasks, expires pending, kills gracefully, status exited; second clockOut → -32003; rehire resumes (8.674ms)
  ✔ restart: kills, respawns with --resume, enqueues [RESUMED] as a system item (686.9191ms)
  ✔ approval: PermissionRequest → pending + waiting_approval; respondApproval sends allow JSON; alwaysThisSession auto-allows next (61.9823ms)
  ✔ attach/detach/resize: last attached client owns resize; attach returns the serialized screen (51.3613ms)
  ✔ interrupt: ctrl-c, queue cleared, tasks aborted, second interrupt within guard → -32003; screen-based idle (415.131ms)
  ✔ unexpected pty exit: adapter error event + status error, tasks aborted; typeRaw writes immediately (5.0606ms)
  ✔ deleteTeam clocks out live members and removes rows; shutdown keeps member status for T09 (8.2355ms)
✔ Office (2376.5197ms)
﹣ real daemon: team.create → clockIn(claude) → instruct → waiting_approval → allow → idle → file exists → clockOut → shutdown (0.9951ms) # set PIXEL_IT=1 to run
▶ RpcServer
  ✔ hello: valid token → daemon + snapshot, no replay without since (54.1313ms)
  ✔ hello{since}: result first, then only events with seq > since, ascending (45.5671ms)
  ✔ hello: bad token → -32001 and the socket is closed (5.4128ms)
  ✔ unauthenticated non-hello request → -32001 and close (42.0393ms)
  ✔ method routing: results and Office calls (6.871ms)
  ✔ error codes: -32602 params, -32002 not found, -32003 bad state, -32601 unknown method, -32700 parse, -32600 envelope (4.5948ms)
  ✔ notifications: event/member.status/daemon.notice broadcast to authed clients only; term only to attached (67.8075ms)
  ✔ client close → Office.detachAll(clientId) with the same clientId used for attach (47.0891ms)
  ✔ daemon.shutdown → {} reply first, then daemon.notice and Office.shutdown() (46.9624ms)
✔ RpcServer (342.15ms)
ℹ tests 21  ℹ pass 20  ℹ fail 0  ℹ skipped 1

$ npx tsx --test test/**/*.test.ts        (전체, PIXEL_IT 없음)
ℹ tests 159  ℹ pass 157  ℹ fail 0  ℹ skipped 2
```

통합 테스트(실제 데몬 + 실제 claude.exe, bash, sandbox 는 이미 신뢰된 폴더):

```
$ time (PIXEL_IT=1 npx tsx --test test/office/integration.test.ts)
[daemon:out] [daemon] pixel-office daemon v1.0.0 pid=19892
[daemon:out] [daemon] data dir : C:\Users\User\AppData\Local\Temp\pixel-office-t07-it-9kBfrZ
[daemon:out] [daemon] daemon.json: C:\Users\User\AppData\Local\Temp\pixel-office-t07-it-9kBfrZ\daemon.json
[daemon:out] [daemon] ws        : ws://127.0.0.1:1852
[daemon:out] [daemon] hook port : 1853 (D:/myproject/pixel-office/dev/daemon/src/hooks/hook.js)
[daemon:out] [daemon] db        : C:\Users\User\AppData\Local\Temp\pixel-office-t07-it-9kBfrZ\pixel-office.db
[daemon:out] [daemon] listening
[IT] daemon.json wsPort=1852 hookPort=1853 pid=19892 version=1.0.0
[IT] hello ok: snapshot.seq=0 teams=0
[IT] status starting (starting)
[IT] clockIn member=m_4098a403afe7 pid=30624 status=starting
[IT] status idle (free)
[IT] idle (SessionStart) after 3026ms
[IT] instruct taskId=1
[IT] status working (working)
[IT] event #1 thinking {"text":"[TASK#1 from user]\n셸 명령 \"echo t07 > t07.txt\"를 실행해줘. 다른 건 하지 마."}
[IT] event #2 running {"tool":"Bash","cmd":"echo t07 > t07.txt","summary":"Write t07 into a text file"}
[IT] event #3 waiting_approval {"tool":"Bash","cmd":"echo t07 > t07.txt","summary":"Write t07 into a text file"}
[IT] waiting_approval after 7451ms: {"tool":"Bash","cmd":"echo t07 > t07.txt","summary":"Write t07 into a text file"} ref={"approvalId":"a_21073af6a94c"}
[IT] status waiting_approval (waiting_approval)
[IT] status working (working)
[IT] event #4 text {"text":"I ran `echo t07 > t07.txt`. It finished with no output or errors, which should mean `t07.txt` now holds `t07` i
[IT] event #5 idle {}
[IT] idle after 12683ms (seq 5)
[IT] event #6 reporting {"summary":"I ran `echo t07 > t07.txt`. It finished with no output or errors, which should mean `t07.txt` now holds `t07
[IT] status idle (free)
[IT] t07.txt = "t07\n"
[IT] reporting event: {"seq":6,"ts":"2026-09-14T11:50:26.399Z","teamId":"t_2adb3cd19bd5","memberId":"m_4098a403afe7","kind":"reporting","detail":{"summary":"I ran `echo t07 > t07.txt`. It finished with no output or errors, which should mean `t07.txt` now holds `t07` in the sandbox folder. I didn't open the file to check."},"ref":{"taskId":1}}
[IT] attach screen=1771 bytes 120x40
[IT] event #7 idle {"summary":"session ended: prompt_input_exit"}
[IT] status exited (exited)
[IT] event #8 idle {"summary":"clocked out"}
[IT] clockOut done after 16106ms; claude alive=false
[IT] notice info: daemon shutting down
[daemon:out] [daemon] bye
[IT] daemon exited=true code=0
✔ real daemon: team.create → clockIn(claude) → instruct → waiting_approval → allow → idle → file exists → clockOut → shutdown (16891.872ms)
ℹ tests 1  ℹ pass 1  ℹ fail 0

real    0m18.672s
```

관찰: SessionStart(idle) 3.0초, `[TASK#1]` paste → `PermissionRequest` 7.5초, allow → `Stop` 12.7초, 전체 왕복 17초. 이벤트 순서가 T04 표와 일치(thinking → running → waiting_approval → text → idle)하고 그 뒤에 Office 가 만든 `reporting`(ref.taskId=1, summary = last_assistant_message) 이 붙는다. `/exit` 로 퇴근할 때 Claude 가 `SessionEnd(prompt_input_exit)` 를 먼저 보내 어댑터가 `idle{session ended}` + exited 를 내고, 그 뒤 Office 의 `idle{clocked out}` 이 온다. 실행 전후 `tasklist` 의 claude.exe 수가 같아(14 → 14) 잔여 프로세스 없음. 데몬 stderr 출력 없음(sqlite 경고 필터 동작).

## PROTOCOL.md 변경 (전부 추가·정정, 이름 변경 없음)

1. 인증 문단: daemon.json 에 `version` 필드 추가, 포트는 실제 바인딩 값, token 은 기동마다 새로(32바이트 hex), 정상 종료 시 파일 삭제. 인증 실패·미인증 호출 시 close code **4001**. 인증 후 오류는 소켓을 끊지 않음. `params` 는 항상 객체, 클라이언트 알림은 무시, 결과 없는 메서드는 `{}`.
2. `hello`: "`since < seq`" 를 **`seq > since`** 로 정정(의미는 같았음), 응답이 먼저 오고 replay 는 오름차순임을 명시.
3. `events.query`: 기본 limit 200, `beforeSeq` 페이징 방법.
4. 각 메서드에 오류 조건 명시: `team.create` cwd(-32602), `member.clockIn` 정원(-32003)·엔진(-32602)·v1a rank/hiredBy, `member.clockOut` 행 유지·중복(-32003), `member.rehire` 살아 있으면 -32003, `member.restart` 는 종료된 멤버에도 허용 + `[RESUMED]`, `member.instruct` 의 task 수명(queued → assigned → reported)과 v1a 보고, `member.type` 빈 문자열 허용, `member.attach` 크기 범위·마지막 attach 승격·스폰 안 된 멤버(-32003), `member.detach` 연결 종료 시 자동, `member.resize` 비소유 클라이언트는 무시, `member.interrupt` 후처리(큐 비움·abort·expire)·1.5초 가드(-32003)·화면 기반 idle, `member.instructions.*` 파일 경로, `daemon.shutdown` 순서(응답 → notice → `/exit` → close 1001)와 status 유지.
5. `approval.respond` 에 **`message?`** 파라미터 추가(deny 사유, T04 어댑터가 이미 받음), `alwaysThisSession` 의 의미(멤버·도구 단위, 데몬 메모리) 명시. `question.respond` 의 `answers` 형식.
6. 에러 코드에 JSON-RPC 표준 `-32700/-32600/-32601/-32000` 추가, -32002 에 pending 포함, 에러 객체 `{code, message, data?}`.
7. 알림: `snapshot` 의 pending/tasks 필터, **`member.status` 에 `member?` 필드 추가**(다른 클라이언트가 새 멤버를 알 수 있게)와 `status`/`derived` 값 목록, `daemon.notice.level` 은 `info|warn|error`.
8. "오피스 이벤트" 절에 데몬이 만드는 이벤트 4종(`reporting`, `idle{interrupted}`, `idle{clocked out}`, `error{process exited}`) 추가.

## 발견한 함정

- **`HookReceiverLike` 의 제네릭 `on<K extends keyof Events>` 는 `EventEmitter<Events>['on']` 과 호환되지 않는다**(TS2322: 리스너 인자 튜플의 교집합이 `never`). `PtyManagerLike` 처럼 이벤트별 오버로드로 써야 실제 `HookReceiver` 와 가짜(`EventEmitter<HookReceiverEvents>` 상속) 둘 다 들어간다.
- **`alwaysThisSession` 자동 allow 는 `pendingCreated` 안에서 동기로 하면 안 된다.** 어댑터는 `pendingCreated` 를 낸 뒤에 `waiting_approval` 이벤트와 status 를 쓰므로, 그 자리에서 `resolveApproval` 하면 pending 은 answered 인데 status 는 waiting_approval 로 남는다 → `setImmediate` 로 미루고 그때도 open 인지 다시 확인.
- **퇴근 시 idle 이벤트가 두 번 온다.** `/exit` 를 치면 Claude 가 `SessionEnd(prompt_input_exit)` 를 보내 어댑터가 `idle{session ended}` + exited 를 먼저 내고, pty exit 뒤 Office 가 `idle{clocked out}` 을 낸다. 클라이언트는 둘 다 "퇴근" 으로 봐도 되고, 어댑터 것을 지우면 사용자가 직접 `/exit` 한 경우의 흔적이 사라지므로 그대로 뒀다.
- **`member.status` 알림만으로는 새 멤버를 모른다.** `member.clockIn` 결과는 호출한 클라이언트만 받으므로 두 번째 클라이언트는 스냅샷을 다시 받기 전엔 memberId 만 본다 → 알림에 `member` 행을 실었다(추가 필드).
- **Office 단위 테스트에서 실제 ScreenModel 을 쓰면 시간이 든다.** xterm write 는 비동기(60ms 대기)이고 InputQueue 폴링이 500ms, Enter 가 300ms 뒤라 instruct 테스트가 ~1.1초. 결정적으로 만들려면 InputQueue 의 `now()` 주입을 Office 까지 끌어올려야 하는데 이번엔 실제 타이머로 두고 여유 있는 sleep 을 썼다(3회 연속 실행 모두 통과).
- **`net.createServer().listen(0)` 이 준 임시 포트가 1852/1853 처럼 낮을 수 있다.** 문제는 없었지만 hook 명령 인자로 그대로 들어가므로 로그에서 낯설 수 있다.
- **restart 에서 status 가 exited → starting 으로 잠깐 흔들린다.** kill 을 기다리는 동안 `member.status(exited)` 가 나간다. 클라이언트가 exited 에서 캐릭터를 퇴장시키면 깜빡임 → 바로 뒤 `starting` 이 오므로 짧은 디바운스로 처리하면 된다(M1).
- 다른 모듈의 버그는 없었다. T04 가 적어둔 대로 `HOOK_EVENTS` 에 `PreCompact` 가 없지만 어댑터 default 분기로 `{}` 가 나가 동작엔 영향 없음(수정 안 함).

## 결정

04 에 D-## 로 올릴 후보(여기서는 번호 없이):

1. **task 수명은 queued → assigned(큐에서 실제로 pty 에 들어간 시점) → reported(그 턴의 Stop).** 스펙 초안은 생성 시 assigned 였지만, 작업 중에 넣은 지시가 큐에 머무는 동안 Stop 이 오면 엉뚱한 task 가 닫히므로 flush 시점을 assigned 로 잡았다. v1a 보고 = Stop 의 last_assistant_message 를 report_text 로, `reporting` 이벤트로 내 책상에 전달(01 §TeamTools "사용자 지시도 task").
2. **`member.interrupt` 는 01 §공통 후처리 그대로**(task aborted, pending expired) + 큐의 미전송 지시 폐기(T05 "Ctrl+C 는 큐를 비우지 않는다 → RPC 쪽에서 clear") + 1.5초 재호출 가드(T05 "Ctrl+C 두 번이면 종료"). idle 복귀는 화면 문구(01 §실측 "중단").
3. **데몬이 의도한 종료(clockOut/restart/shutdown)에는 `error` 이벤트를 내지 않는다.** `exitMode` 로 구분. 어댑터 `onSessionExit` 는 예상 못 한 종료에만.
4. **shutdown 은 멤버 status 를 보존한다**(T09 가 working/waiting 을 resume 대상으로 봄). daemon.json 은 정상 종료 시 삭제해 클라이언트가 stale 파일을 안 믿게.
5. `alwaysThisSession` 은 데몬 메모리(멤버 id × tool_name), 재시작 시 초기화.
6. `daemon.shutdown` 은 응답을 먼저 보내고 다음 매크로태스크에서 종료 절차(클라이언트가 결과를 받을 수 있게), 소켓은 1001 로.
7. RpcServer ↔ Office 경계는 `OfficeApi` 인터페이스 하나. 파라미터 검증은 RpcServer(-32602), 도메인 검증(존재·상태·정원)은 Office.

## 남은 것

- **T09 재시작 복구는 없다.** 데몬을 껐다 켜면 DB 에 working/idle 인 멤버 행이 남지만 런타임이 없어 `attach`/`instruct` 는 -32003, `clockOut` 만 상태 정리로 통한다. T09 에서 기동 시 `rehire` 경로로 재스폰 + `[RESUMED]`(진행 task 요약 포함) + approval pending expired.
- `--resume <id>` 가 실패하면(세션 파일 없음 등) Claude 가 바로 종료해 status error 가 된다. 새 세션으로 폴백하는 로직은 없음(T09 에서 판단).
- Codex 멤버도 `ClaudeHooksAdapter` 로 처리된다(이벤트 흐름은 같지만 도구 이름 매핑이 다름) — T20.
- `member.status.derived` 의 `waiting_reports` 는 M4. `-32004` 는 아직 아무 데서도 안 난다.
- `pruneEvents` 는 기동 시 1회만(주기 실행 없음). WS ping/keepalive 없음(로컬 전용이라 보류).
- `team.create` 의 `leaderEngine` 은 검사만 하고 저장하지 않는다(M4 팀장 자동 출근 때 Team 에 컬럼 추가).
- 통합 테스트는 첫 실행 다이얼로그(온보딩·폴더 신뢰)를 거치지 않았다(sandbox 가 이미 신뢰됨). InputQueue 의 자동 통과는 T05 단위 테스트로만 검증 — T10 시연에서 새 폴더로 확인.
- README.md 는 건드리지 않았다(상위에서 갱신).
