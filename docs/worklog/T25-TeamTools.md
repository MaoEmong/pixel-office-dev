# T25 — TeamTools MCP: hire / dismiss / delegate / report (팀장 오케스트레이션)

- 날짜: 2026-09-16
- 마일스톤: M4
- 관련 설계: 01-설계문서.md §구성 요소 1 "TeamTools MCP (HTTP streamable)" · §4 팀·직급 모델 · 전제 6 · §"interrupt / fire / error 공통 후처리", 04-결정기록.md D-06 · D-19 · D-22 · D-27 · D-28, worklog T17(TeamToolsServer) · T24(직급·hireByLeader) · T27(셸 뮤텍스) · T09(재시작 복구)
- 커밋: (미커밋 — 상위에서)

## 목표

팀장이 **사무실 안에서 팀을 굴린다.** 사용자가 팀장에게 한 줄 지시하면 팀장이 `hire` 로 팀원을 만들고 `delegate` 로 일을 쪼개 주고,
팀원이 `report` 로 보고하면 데몬이 모아서 `[REPORTS …][ALL_REPORTS_IN]` 한 덩어리로 팀장에게 올리고, 팀장이 다시 `report` 로
사용자 책상에 보고한다. 직급 규칙(팀장 전용 도구·자기 task 만 보고)은 **데몬이 store 를 보고 강제**한다 — 모델이 무슨 말을 하든.
중단·퇴근·팀장 종료의 후처리(aborted 보고)와 파생 상태 `waiting_reports` 까지 포함한다.

## 한 것

### MCP 서버 — `src/mcp/TeamToolsServer.ts`

- 도구가 1개(`ask_user`) → **5개**. 호스트 인터페이스 `TeamToolsHost` 에 `hire/dismiss/delegate/report` 추가,
  `resolveMember` 가 **`rank` 까지** 돌려준다(요청마다 store 에서 다시 읽는다).
- **직급 강제 2겹**
  1. `buildServer(token, member)` 가 **지금 직급**으로 도구를 등록한다 — 팀원의 `tools/list` 에는 `report`·`ask_user` 만.
     (무상태 전송이라 요청마다 McpServer 를 새로 만드는 T17 구조가 그대로 직급 반영 창구가 됐다.)
  2. 팀장 전용 콜백마다 `rankGate(tool)` 로 한 번 더 확인 → 아니면 `isError` + 한국어 사유.
- 결과 문구를 함수로 export(테스트·PROTOCOL 과 같은 문자열): `hireResultText` / `dismissResultText` / `delegateResultText` /
  `reportResultText` / `leaderOnlyToolMessage`, 상수 `LEADER_ONLY_TOOLS`·`EVERYONE_TOOLS`·`ALL_TEAM_TOOLS`.
- 실패는 전부 `isError:true` + `"<도구> 실패: <사유>"` (턴을 죽이지 않는다). `report.taskId` 는 `z.coerce.number()` —
  모델이 `"7"` 로 보내도 받는다(실기에서 흔하다).

### Office — `src/office/Office.ts` (새 섹션 "TeamTools 오케스트레이션 (T25)")

- `teamHire(leaderId, {name, role, engine?, instructions?})` — `requireLiveLeader` → 엔진 결정(`pickHireEngine`:
  지정값 → 팀장과 같은 엔진 → `claude` → 허용 목록 첫 번째) → `buildRoleInstructions(role, instructions)`
  (`# 역할: <role>` + 빈 줄 + 본문) → 기존 `hireByLeader`(T24). 정원·허용 엔진 검사는 `spawnNewMember` 가 그대로 한다.
- `teamDismiss(leaderId, targetId)` — 같은 팀 ∧ 팀장 아님 ∧ `hiredBy:'leader'` ∧ `idle` ∧ 미종료 task 0 ∧ 열린 pending 0
  일 때만 `clockOut(target, {byLeader:true})`. 각 조건마다 한국어 사유.
- `teamDelegate(leaderId, to, task)` — task 행(`from=<팀장>`, `queued`) → `dispatchTask`(대상이 지금 받을 수 있으면 큐에 넣고
  `assigned`) → `delegating{tool, summary, to, toName, status}` ref `{taskId}` 이벤트 → 팀장 `member.status` 재발행
  (파생이 `waiting_reports` 로 바뀐다).
- `teamReport(memberId, {taskId, summary, files?, status})` — **자기에게 배정된 task 만**. task `reported` +
  `report_status` + `report_text`(= `reportBody`: summary + `\n파일: …`) + 보고자에게 `reporting{summary,status,files?}`.
  발행자가 `user` 면 거기서 끝(내 책상 보고), 팀장이면 `bufferReport`.
- **보고 버퍼** `reportBuffer: Map<leaderId, ReportLine[]>` — `blocked` 는 즉시 단독 전달, 그 외는 모았다가
  `store.openTasksIssuedBy(leader).length === 0` 이 되는 순간 `buildReportsText(lines, true)` 로 한 덩어리 + `[ALL_REPORTS_IN]`.
  팀장이 이미 나갔으면 `daemon.notice{warn}` 만(보고는 `tasks.report_text` 에 남는다).
- **유휴 감시** — `emitStatus(memberId, 'idle')` 에서 `dispatchQueuedTasks` 를 부른다(어댑터가 store 를 먼저 갱신하고 emit 하므로
  여기서 본 상태가 최신이다). 같은 task 를 두 번 넣지 않도록 `inFlight: Set<taskId>`(큐에 들어갔지만 아직 flush 안 된 것)를 둔다.
- **후처리** — `abortTasksAndReport(memberId, why)`(interrupt·퇴근·비정상 종료): 미종료 task aborted + 발행자에게
  `[REPORTS … status=aborted]` **즉시**(버퍼 안 탐), 발행자가 사용자면 `reporting{status:'aborted'}` 이벤트.
  `abortTasksIssuedBy(leader, why)`(팀장 퇴근·종료): 발행 task 전부 aborted + 맡고 있던 팀원 interrupt + 버퍼 비움.
- **`[TEAM]` 알림** — `clockIn`(팀원)·`clockOut`(팀원) 에서 `notifyTeamChange` 로 살아 있는 팀장 큐에
  `[TEAM] 팀원 변경: +이름(엔진, 역할: …)` / `-이름`. 팀장 자신의 `hire`/`dismiss` 에는 안 낸다(`clockOut(id, {byLeader})`).
- **파생 상태** `derived()` 에 `waiting_reports`(팀장 ∧ idle ∧ 발행한 미종료 task > 0). 순서: 열린 질문 → 보고 대기 → free.
- **v1a 보고 승격 손질 2건**
  - 위임받은 task 를 `report` 없이 턴만 끝내도 **같은 버퍼를 탄다**(팀장이 `[ALL_REPORTS_IN]` 을 영영 못 받고 굳는 것 방지).
  - **발행한 미종료 task 가 있는 멤버의 턴 종료는 승격하지 않는다** — 실기에서 잡은 함정(아래).
- 잡다: `taskMessage(task, fromName)` 로 `[TASK#n from user]` / `[TASK#n from <팀장>(팀장)]` 을 한 곳에서 만든다(재시작 복구의
  requeue 도 이걸 쓴다 — 예전에는 위임 task 도 `from user` 로 다시 들어갔다). 큐 `flushed` 핸들러가 `system` 항목도 보고
  `inFlight` 를 지운다(`[ANSWER q#…]` 처럼 id 가 숫자가 아닌 항목은 무시).
- export: `taskMessage` / `buildReportsText` / `reportBody` / `buildRoleInstructions` / `roleOf` / `teamJoinText` / `teamLeaveText`.
- `src/office/types.ts`: `TeamHireInput` / `TeamReportInput` / `ReportLine`, `OfficeApi.clockOut(memberId, opts?)`.

### 콘솔 클라이언트

- `src/cli/format.ts` `formatTask` 가 보고를 같이 찍는다: `task#12 reported 반장→이음: <지시>  ↩ done <보고 80자>`.
- `src/cli/index.ts` `applyTaskEvent` — 스냅샷의 `tasks` 는 열린 것만 오므로, `delegating`(새 task)·`reporting`(보고)
  이벤트로 로컬 표를 갱신한다. `tasks` 명령이 from/to/status/보고를 다 보여준다.

### PROTOCOL.md

- "TeamTools MCP" 섹션 제목이 T17+T25 로 바뀌고 **도구 표(직급 표시)·직급 강제 2겹·isError 문구 목록·`hire`/`delegate`/`report`
  동작·버퍼링 규칙·후처리·`[TEAM]` 알림** 소절 추가.
- `member.status.derived` 에 `waiting_reports`(M4 → 확정), 오피스 이벤트에 `delegating{…}`·`reporting{status,files?}` 항목,
  `member.clockIn`/`member.clockOut` 행에 `[TEAM]`·팀장 퇴근 후처리.

## 검증

### 타입체크 + 전체 스위트

```
$ cd dev/daemon && npx tsc --noEmit
(출력 없음)

$ npx tsx --test "test/**/*.test.ts"
ℹ tests 390
ℹ suites 56
ℹ pass 384
ℹ fail 0
ℹ skipped 6      (PIXEL_IT 미설정 통합 5건 + office preview 1건)
ℹ duration_ms 34367.6838
```

T25 시작 367건 → **390건**(신규 17 + MCP 5 + 기존 1건 보강).

### T25 파일만

```
$ npx tsx --test test/office/TeamTools.test.ts test/mcp/TeamToolsServer.test.ts
ℹ tests 28  pass 28  fail 0

▶ TeamTools 오케스트레이션 (T25)
  ✔ hire: hiredBy leader / rank member, INSTRUCTIONS.md 첫 줄이 "# 역할: …", 엔진 기본은 팀장과 같다
  ✔ hire: 팀원이 부르면 -32004, 정원이 차면 -32003, 허용 안 된 엔진은 -32602
  ✔ delegate: 유휴 팀원에게는 즉시 assigned + [TASK#n from <팀장>(팀장)] 이 타이핑된다
  ✔ delegate: 바쁜 팀원에게는 queued 로 남고, 그 팀원이 idle 이 되는 순간 전달된다(유휴 감시)
  ✔ delegate: 같은 팀이 아니거나 팀장·자기 자신이면 -32004, 팀원이 부르면 -32004
  ✔ report: 팀원 둘의 보고가 버퍼링됐다가 마지막 보고에서 한 덩어리 + [ALL_REPORTS_IN] 으로 팀장에게 간다
  ✔ report(blocked): 버퍼를 건너뛰고 즉시 단독으로 전달된다([ALL_REPORTS_IN] 없음)
  ✔ report: 남의 task 는 -32004, 이미 보고된 task 는 -32003, 팀장의 report 는 사용자 task 를 닫는다
  ✔ 보고를 기다리는 팀장의 턴 종료는 사용자 task 를 닫지 않는다(실기 함정)
  ✔ report 없이 턴만 끝내도(v1a 승격) 팀장 버퍼를 탄다 — [ALL_REPORTS_IN] 이 영영 안 오는 것을 막는다
  ✔ dismiss: 팀장이 hire 한 유휴 팀원만 — 사용자 출근 팀원·바쁜 팀원·미종료 task 는 거절
  ✔ 사용자 출근/퇴근 → 팀장 큐에 [TEAM] 팀원 변경: +이름(엔진, 역할 …) / -이름
  ✔ 팀원 interrupt → 그 task 가 aborted 되고 팀장에게 [REPORTS … status=aborted] 가 즉시 간다
  ✔ 팀장 퇴근 → 발행한 task 전부 aborted + 그 팀원 interrupt, 팀원 행은 남는다
  ✔ derived waiting_reports: 팀장이 idle 이어도 발행한 미종료 task 가 있으면 보고 대기로 보인다
  ✔ MCP 왕복: 팀장 토큰으로 hire → delegate → 팀원 토큰으로 report 까지 실제 HTTP 로 돈다
  ✔ 문구 빌더: taskMessage / buildReportsText / reportBody / buildRoleInstructions / teamJoinText

▶ TeamToolsServer (T17)
  ✔ T25 tools/list: 팀원은 report·ask_user 만, 팀장은 hire·dismiss·delegate 까지 5개
  ✔ T25 팀장 도구: hire / dismiss / delegate 가 호스트를 부르고 결과 문구를 돌려준다
  ✔ T25 report: 전원이 쓸 수 있고 taskId 는 문자열로 와도 숫자로 강제된다
  ✔ T25 직급 강제: 팀원이 hire 를 부르면 없는 도구, 세션 중 강등되면 isError(한국어 사유)
  ✔ T25 호스트가 throw 하면 isError + 한국어 사유(턴을 죽이지 않는다)
  (+ T17 6건)
```

### 실기 통합 (진짜 데몬 + 진짜 Claude 팀장, 24초)

`test/office/teamtools.integration.test.ts` (opt-in). cwd = `dev/spike-0/sandbox`, 임시 dataDir·포트 3개, 허가는 자동 allow.

```
$ PIXEL_IT=1 npx tsx --test test/office/teamtools.integration.test.ts

[d:out] [office] mcp       : http://127.0.0.1:9840/mcp/<memberToken> (TeamTools: hire, dismiss, delegate, report, ask_user)
[IT] team=t_e0d575cd4ed4 leader=m_f8bf8fdfcb60 pid=24552 (650ms)
[IT] leader idle (2064ms)
[IT] instruct task#1 (2066ms)
[IT:c] event #1 thinking {"text":"[TASK#1 from user]\nteam MCP 도구로 팀원 '보조'를 hire하고(역할: 파일 작성), …
[IT:c] event #2 running {"tool":"ToolSearch"}
[IT:c] event #3 running {"tool":"mcp__team__hire"}
[IT] hired 보조 (m_ba76c5968ab8) engine=claude hiredBy=leader (6438ms)
[IT] worker INSTRUCTIONS.md: "# 역할: 파일 작성\n"
[IT:c] event #4 running {"tool":"mcp__team__delegate"}
[IT:c] event #5 delegating {"tool":"delegate","summary":"작업 디렉토리에 hello25.txt 파일을 만들고 내용으로 'hi' 라고 써라. …","to":"m_ba76c5968ab8",…
[IT] delegating #5 task#2 → 보조 (assigned) (9034ms)
[IT:c] event #6 thinking {"text":"[TASK#2 from 반장(팀장)]\n작업 디렉토리에 hello25.txt 파일을 만들고 …"}
[IT:c] event #8 idle {}
[IT:c] status idle (waiting_reports)          ← 팀장 파생 상태
[IT:c] event #9 editing {"tool":"Write","path":"…\\sandbox\\hello25.txt"}
[IT:c] auto-approve a_88c44a9854c8 (Write …\hello25.txt)
[IT:c] event #12 running {"tool":"mcp__team__report"}
[IT:c] event #13 reporting {"summary":"… hello25.txt 생성 완료. 내용: hi (줄바꿈 없음).\n파일: hello25.txt","status":"done","files":["hello25.txt"]}
[IT] leader got reports (14902ms):
[REPORTS task#2 보조 status=done]
작업 디렉토리(D:\myproject\pixel-office\dev\spike-0\sandbox)에 hello25.txt 생성 완료. 내용: hi (줄바꿈 없음).
파일: hello25.txt

[ALL_REPORTS_IN]
[IT:c] event #18 running {"tool":"mcp__team__report"}
[IT:c] event #19 reporting {"summary":"팀원 '보조'가 hello25.txt 를 만들고 \"hi\" 를 썼고, 파일을 열어 내용을 확인함.…","status":"done"}
[IT] leader reported task#1: … (19411ms)
[IT] hello25.txt: "hi" (19414ms)
[IT] daemon exited=true code=0 (22483ms)
[IT] leftover check: 24552=dead 4648=dead
✔ real daemon + real Claude leader: hire → delegate → member works → [ALL_REPORTS_IN] → leader report (24017.5363ms)
ℹ tests 1  pass 1  fail 0
```

한 바퀴가 실제로 돈다: `hire`(6.4s) → `delegate`(9.0s) → 팀원이 파일 작성 → `report` → 팀장에게 `[ALL_REPORTS_IN]`(14.9s)
→ 팀장 `report` → `reporting` 이벤트(19.4s) → `sandbox/hello25.txt` = `"hi"`. 테스트가 띄운 `claude.exe` 두 개만 정리됐다.

**ToolSearch 확인:** 실기 로그의 `event #2 running {"tool":"ToolSearch"}` 가 D-22 참고 사항 그대로다 — Claude 2.1.270 은
MCP 도구를 지연 로딩하므로 지시문/프롬프트에 **도구 이름을 적어 두면** 모델이 `ToolSearch` 로 바로 찾아 쓴다. 통합 테스트도 지시 끝에
`도구 이름: mcp__team__hire, … (도구 목록에 없으면 ToolSearch로 찾아라).` 한 줄을 붙였고(앱의 `leaderInstructionTemplate`, T26a 와 같은 줄),
그 줄이 있으면 첫 턴에서 바로 `mcp__team__hire` 를 부른다.

## 발견한 함정

1. **보고를 기다리는 팀장의 턴 종료가 사용자 task 를 닫아 버린다(실기 1회차에서 잡음).** 팀장이 `hire`+`delegate` 를 하고
   "맡겼고 기다리는 중입니다" 라고 말하며 턴을 끝내면, v1a 보고 승격(`Stop` → `assigned` task 를 `reported`)이 그 인사말로
   task#1 을 닫아 버렸다. 그래서 나중에 진짜 `report(task#1)` 이 `"task#1 은(는) 이미 보고됐습니다"` 로 거절되고 모델이
   "사무실 쪽에서 먼저 닫힌 것 같다" 고 사용자에게 사과했다(1회차 로그).
   → **발행한 미종료 task 가 하나라도 있는 멤버의 턴 종료는 승격하지 않는다.** 2회차에서 정상 동작 확인, 단위 테스트로 고정.
2. **`member.restart` 는 갓 시작한 세션에 쓰면 안 된다.** 통합 테스트 1회차에서 팀장 지시문을 넣으려고 `instructions.set` +
   `restart` 를 했더니 `--resume <방금 만든 session_id>` 가 exit 1 로 죽었다(대화 내용이 없는 세션). D-18 의 resume 폴백은
   **재시작 복구 경로에만** 붙어 있어서(`recoverMember` 가 `resumeFallback` 을 세팅한다) `restart` 에는 폴백이 없다 → 멤버가
   `error` 로 끝났다. 통합 테스트는 지시문 주입 대신 지시 텍스트에 도구 이름을 넣는 쪽으로 바꿨다. `restart` 에도 같은 폴백을
   붙이는 것은 T09 후속(아래 "남은 것").
3. **`Client.waitFor` 는 이미 받은 알림도 매치한다.** 그래서 `restart` 뒤에 `waitStatus(idle)` 을 부르면 **재시작 전의** idle
   알림에 즉시 걸려 통과해 버린다(1회차에서 4초 만에 "leader ready" 가 찍힌 이유). 통합 테스트에서 "무엇이 바뀐 뒤"를 기다릴
   때는 `waitEvent(…, afterSeq)` 처럼 기준점이 있는 대기를 쓰거나 알림 인덱스를 기억해야 한다.
4. **MCP SDK 는 등록되지 않은 도구를 `-32602 Tool hire not found` 로 reject 한다**(`disable()` 해도 `Tool … disabled`).
   그래서 "팀원이 `hire` 를 부르면 한국어 isError" 를 **등록을 지우는 방식으로는** 만들 수 없다. 직급별 도구 목록(1겹)과
   한국어 isError(2겹)는 서로 다른 상황을 맡는다 — 목록에서 빠진 도구는 프로토콜 오류, 목록에는 있었는데 호출 시점에 자격이
   사라진 경우(멤버 퇴근 등)와 Office 가 거절하는 모든 경우가 `isError` 다. 테스트도 그렇게 나눠 고정했다.
5. **task 는 pty 에 들어갈 때까지 `queued` 라서 유휴 감시가 같은 task 를 두 번 넣을 수 있다.** 큐에 넣은 순간부터 flush 될
   때까지를 `inFlight` 로 들고 있어야 한다(delegate 직후 대상이 idle 알림을 한 번 더 내면 바로 재현된다). 큐 `flushed`·중단
   후처리·보고에서 지운다.
6. **`abortTasksFor` 후처리가 이벤트 순서를 바꾼다.** 비정상 종료 때 `error{process exited}` 뒤에 `reporting{status:'aborted'}`
   가 하나 더 붙으므로 `events.at(-1)` 로 error 를 집던 기존 테스트 3건이 깨졌다(Office/Recovery). "마지막 error 이벤트"를
   찾도록 고쳤다 — `findLast` 는 tsconfig lib 이 es2022 라 못 쓴다(`[...arr].reverse().find`).

## 결정

- **D-29** (04-결정기록.md) — 보고를 기다리는 멤버의 턴 종료는 v1a 보고 승격 대상이 아니다 + 위임 task 의 승격은 팀장 버퍼를 탄다.

그 외 이 태스크에서 정한 것(번호 없이 여기에):

- **`dismiss` 는 팀장이 hire 한 팀원만.** 설계 §4 그대로. 사용자가 출근시킨 팀원은 `-32004` + "퇴근 버튼으로만".
- **팀장이 퇴근해도 팀원은 남는다.** 설계 §후처리는 "팀장 fire 시 하위 task 전부 aborted + 팀원 interrupt" 까지만 요구한다.
  팀장이 hire 한 팀원까지 자동으로 자르면 사용자가 손쓸 새 없이 사무실이 비고, 되돌릴 수 없다(퇴근은 사용자 권한). 그래서
  **task aborted + interrupt 까지만** 한다. 남은 팀원은 사용자가 퇴근시키거나, 새 팀장이 오면 그대로 쓰면 된다.
- **`files` 는 컬럼을 늘리지 않고 `report_text` 에 `\n파일: a, b` 로 붙인다.** `tasks` 스키마 변경(마이그레이션)까지 할 만큼
  쓰임새가 분명하지 않다. 이벤트 `detail.files` 에는 배열 그대로 실린다(앱이 나중에 쓸 수 있다).
- **`hire` 의 엔진 기본값은 "팀장과 같은 엔진".** 설계는 "팀 설정의 허용 목록에서만" 만 정한다. 팀장이 Claude 인 팀에서
  팀원만 Codex 가 되면 놀랍고, 혼합 팀은 사용자가 출근시키거나 팀장이 `engine` 을 명시하면 된다.
- **`delegating` 이벤트는 팀장에게 붙인다**(팀원이 아니라). 사무실에서 "팀장이 위임 중" 을 그리는 게 자연스럽고, 팀원 쪽은
  `[TASK#n]` 타이핑이 `thinking` 으로 이미 보인다. `detail.status` 로 assigned/queued 를 구분한다(콘솔이 쓴다).
- **유휴 감시는 `emitStatus` 에 건다**(설계 노트의 "afterOfficeEvent idle" 대신). `afterOfficeEvent` 는 어댑터 이벤트만 타므로
  화면 기반 idle(D-25)·interrupt 회복(T19)처럼 데몬이 직접 내는 idle 을 못 본다. status 는 두 경로가 모두 지나간다.

## 남은 것

- **앱(Flutter)**: 이번 범위 밖(`dev/app/**` 미수정). 팀장 파생 상태 `waiting_reports` 배지, 위임 화살표·보고 카드,
  `tasks` 패널이 아직 없다. 팀장 지시문 기본 템플릿(T26a `leaderInstructionTemplate`)은 이미 도구 이름을 들고 있어 그대로 맞는다.
- **데몬 기본 지시문 템플릿**(비어 있는 멤버에게 `SessionStart` 로 주입할 기본값)은 T26b 몫. 지금은 `hire` 가 넣는
  `# 역할: <role>` 한 줄이 전부라, 팀원이 `report` 를 쓸 줄 알아야 한다는 안내는 팀장이 `instructions` 에 적어 줘야 한다
  (실기에서는 팀장이 delegate 문구에 "끝나면 report 로 보고하라" 를 넣어 해결했다).
- **`member.restart` 의 resume 폴백**(함정 2). D-18 을 `restart` 경로에도 붙이면 "지시문 즉시 반영" 이 갓 만든 세션에서도 안전해진다.
- **Codex 팀장**: `hire/dismiss/delegate` 도구는 엔진 중립이지만 실기 확인은 Claude 팀장만 했다(Codex 한도 D-23). Codex 팀원은
  `report` 를 안 부르면 v1a 승격이 버퍼를 타므로 동작은 한다.
- **`dismiss` 실기 미확인**: 통합 테스트는 `team.delete` 로 정리했다(팀장이 스스로 `dismiss` 하는 장면은 단위 테스트만).
- **보고 버퍼는 메모리에만 있다.** 데몬이 죽으면 아직 안 흘린 보고(= 미종료 task 가 남아 대기 중이던 것)는 사라진다. 다만 task
  자체는 `reported` + `report_text` 로 DB 에 있으므로 복구 시 `[RESUMED]` 로 상황을 알릴 수는 있다 — 재시작 복구가 버퍼를
  다시 세우는 것은 안 했다.
