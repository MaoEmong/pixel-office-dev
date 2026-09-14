# T09 — 재시작 복구

- 날짜: 2026-09-15
- 마일스톤: M0
- 관련 설계: 01-설계문서.md §구성 요소 1 "데몬 재시작 복구" · "대기 정책" · §실측 결과 반영 "프로세스 수명"
- 커밋: (미커밋 — 상위에서)

## 목표

데몬이 죽었다 다시 뜨면 이전 기동의 멤버가 알아서 돌아온다. `Office.start()` 가 DB 에 남은 working/idle/waiting 멤버를 `claude --resume <session_id>` 로 다시 띄우고, 진행 중이던 task 와 마지막 행동을 요약한 `[RESUMED]` 를 타이핑하고, hook 프로세스와 함께 죽은 허가·TUI 질문을 `expired` 로 정리하고, 큐에만 있던 지시를 다시 넣는다. 콘솔/앱은 재접속만 하면 이어서 대화할 수 있다.

## 한 것

- `dev/daemon/src/office/Office.ts`
  - `start()`: `pruneEvents` 뒤, RPC 서버가 열리기 전에 `this.recovery = this.recover()`. `recoveryResult` getter(`RecoveryResult { resumed, failed, expired, requeued, orphansKilled }`). `OfficeOptions.recovery { fallbackWindowMs?, orphanOps? }`(테스트 주입용). `daemon.json` 처리는 그대로.
  - `recover()`: `RECOVERABLE`(starting/idle/working/waiting_approval/waiting_answer) 멤버를 rowid 순으로 `recoverMember` — 멤버마다 try/catch, 실패하면 그 멤버만 `error`. `listMembers` 자체가 실패해도 빈 결과. 절대 throw 하지 않는다. 끝나면 `notice('info', '복구: N명 재개, M건 만료[, K명 재개 불가][, 유령 J개 정리]')`(되살릴 것이 없으면 알림 없음) + 콘솔 `[office] 복구: …`.
  - `recoverMember()`: ① `reapOrphanOf`(아래) ② assigned/queued task·최근 이벤트 5건을 **복구가 이벤트를 쓰기 전에** 읽는다(죽기 직전 모습) ③ `expirePendingForRestart`: 열린 approval 전부 + `payload.tool_input` 이 있는 question(TUI `AskUserQuestion`)만 `expired` + `error{summary:'재지시 필요: 허가 요청이/질문이 재시작으로 만료됨', pendingId, pendingType}` ref `{approvalId|questionId}`. M2 `ask_user` 질문(tool_input 없음)은 `open` 유지 ④ `session_id` 없으면 `markRecoveryFailure`: task aborted + `error{summary:'restart: no session id to resume'}` + status `error`(재고용은 사용자 몫; 이때는 pending 전부 만료) ⑤ 있으면 `spawnMember(member, true)`(rehire 와 같은 경로 → `--resume`) → `rt.resumeFallback = {until: now+10s, resumedText}` → 큐에 `[RESUMED]`(kind `system`) 먼저, 그 뒤 queued task 를 id 순으로 `[TASK#n from user]\n<text>`(kind `instruct`, flush 되면 기존 핸들러가 `assigned`). assigned task 는 그대로.
  - `buildResumedText({assigned, events, expiredCount})`(export): `[RESUMED] 데몬이 재시작됐다. 진행 중이던 작업: task#<id>: <instruction 첫 80자>(, …)|없음. 마지막 확인된 행동: <kind 요약>; …(5건, 오래된 것부터)|없음. [만료된 허가·질문: N건(필요하면 다시 요청하라).] 현재 상태를 점검하고 이어서 진행하라.` 요약은 `detail.summary → text → cmd → path → tool` 중 첫 값 60자, 공백은 한 칸으로. 한 문단이라 bracketed paste 로 한 프롬프트에 들어간다. 기존 `RESUMED_TEXT`(`member.restart` 용)는 그대로.
  - `tryResumeFallback()`(`onPtyExit` 앞단): `--resume` 한 세션이 10초(`RESUME_FALLBACK_WINDOW_MS`) 안에 0 이 아닌 코드로 죽으면(T07 "세션 파일 없음이면 바로 종료" 증상) `session_id` 를 null 로 지우고 `error{summary:'resume failed; started fresh session', exitCode, sessionId}` + `notice(warn)` 후 `spawnMember(member, false)`(--resume 없음) → 같은 `[RESUMED]`·queued task 를 다시 큐에. task 는 abort 하지 않는다. 폴백은 한 번 — 새 세션도 죽으면 일반 비정상 종료 처리(`process exited`, status error, task aborted). 창 밖·코드 0 은 기존 경로.
  - `reapOrphanOf()`: 멤버의 `child_pid` 가 살아 있으면 `--resume` 전에 트리째 종료(아래 함정 1). 결과는 `orphansKilled` + `notice(warn)`. 이름이 엔진과 다르면(pid 재사용) 건드리지 않고 `notice(warn)` 만.
- `dev/daemon/src/office/orphans.ts`(신규): `OrphanOps { alive, name, kill }` + `reapOrphan(ops, pid, engine)`(자기 pid·이름 모름·이름 불일치는 skip) + `defaultOrphanOps`(win32: `tasklist /FI "PID eq N" /FO CSV` 로 이미지 이름, `taskkill /PID /T /F`; 그 외 `ps -o comm=`, `SIGKILL`). 전부 동기.
- `dev/daemon/PROTOCOL.md`(추가만): "오피스 이벤트" 에 복구 이벤트 6종, 새 섹션 "재시작 복구"(대상·유령 정리·pending·재스폰·[RESUMED]·tasks·폴백·알림·실패 격리).
- `dev/daemon/src/index.ts`: 변경 없음(복구가 `office.start()` 안에서 끝나므로).
- 테스트
  - `dev/daemon/test/office/fakes.ts`(신규): Office.test.ts 의 인라인 가짜(FakePty/FakeSession/FakeReceiver/fakeReq)를 파일로. `FakePty.failSpawnFor` 추가. Office.test.ts 는 손대지 않았다.
  - `dev/daemon/test/office/Recovery.test.ts`(신규, 7건): 인메모리 Store 에 이전 기동 모양을 심고(`seed`: A working+sess-A+assigned 1(80자 넘는 instruction)+queued 1+approval+TUI question+이벤트 7건, B idle+session 없음, C exited) `start()`. 유령 연산은 **항상 가짜**(이 머신의 진짜 claude.exe 를 건드리지 않게).
    1. A `--resume sess-A` 1회 스폰·starting·childPid, approval/TUI 질문 expired + error 이벤트(pendingId·ref), assigned 유지·queued 유지, B error + `restart: no session id to resume` + 스폰 없음, C 무변경(status·이벤트·스폰 전부), notice `복구: 1명 재개, 2건 만료, 1명 재개 불가`. SessionStart(resume)+준비 화면 후 paste[0] = [RESUMED](assigned 만, 79자+…, 뒤 문장 없음, 마지막 5건 정확히 `thinking [TASK#1 from user] 이 지시는 여든 글자; reading grep foo; editing src/a.ts; running npm test; waiting_approval echo hi`, 처음 2건 제외, 복구가 쓴 error 제외, 만료 2건 문구), 2.4초 뒤 paste[1] = `[TASK#2 from user]\n…` + task#2 assigned.
    2. ask_user 질문(tool_input 없음)은 open 유지, TUI 질문·approval 만 만료. `buildResumedText` 빈 입력 문구.
    3. 폴백: 스폰 직후 `exit(1)` → 두 번째 스폰에 `resumeSessionId` 없음, session_id null, `resume failed; started fresh session`(exitCode 1, 옛 sessionId), `process exited` 이벤트 없음, task 미abort, notice warn. 새 세션 SessionStart(startup, sess-A2) 후 같은 [RESUMED] + queued 재큐잉. 그 세션도 `exit(1)` → 스폰 2회 그대로, status error, `process exited (code 1)`, task aborted.
    4. 창(50ms) 밖 `exit(1)` → 스폰 1회·error·session_id 유지. 창 안 `exit(0)` → exited.
    5. `recover()` 가 throw 하지 않음: A 의 spawn 을 거부 → A error(`restart: spawn failed: …`, task aborted), B error, D 는 정상 재개.
    6. 유령: 4242(claude.exe) 살아 있음 → kill 1회·notice warn·`유령 1개 정리`; 4343(node.exe) → 건드리지 않고 warn; C 는 확인 안 함. `reapOrphan` 단독 3케이스.
    7. 빈 DB: notice 없음·스폰 없음.
  - `dev/daemon/test/office/restart.integration.test.ts`(신규, opt-in `PIXEL_IT=1`, 아래 검증): 실제 데몬 2개를 자식 프로세스로. `finally` 에서 데몬 트리 kill + **명령줄에 임시 dataDir 이 들어 있는 claude.exe 만** 골라 정리(`Get-CimInstance Win32_Process` 필터) → 이 머신의 다른 claude 세션은 건드리지 않는다.

## 검증

```
$ cd dev/daemon && npx tsc --noEmit
(출력 없음, EXIT=0)

$ npx tsx --test test/office/Recovery.test.ts test/office/Office.test.ts
▶ Office
  ✔ … (기존 11건 전부 통과)
✔ Office (2364.0953ms)
[office] recover A(m_874fdedd1bc8): --resume sess-A, assigned 1, requeued 1, expired 2
[office] recover B(m_c6aebaae9612): restart: no session id to resume
[office] 복구: 1명 재개, 2건 만료, 1명 재개 불가
[T09] RESUMED text:
[RESUMED] 데몬이 재시작됐다. 진행 중이던 작업: task#1: 이 지시는 여든 글자를 넘기도록 일부러 길게 쓴 문장이다. 앞 80자만 [RESUMED] 에 실려야 하고 나머지는 말줄임표로 잘려야 한다. 뒤…. 마지막 확인된 행동: thinking [TASK#1 from user] 이 지시는 여든 글자; reading grep foo; editing src/a.ts; running npm test; waiting_approval echo hi. 만료된 허가·질문: 2건(필요하면 다시 요청하라). 현재 상태를 점검하고 이어서 진행하라.
▶ Office restart recovery (T09)
  ✔ start(): A respawned with --resume, [RESUMED] then queued task; approval/TUI question expired; B → error; C untouched; notice (3113.1512ms)
  ✔ ask_user question (no tool_input) stays open; only TUI questions and approvals expire (5.283ms)
  ✔ fallback: resumed process exits non-zero within the window → fresh spawn without --resume, error event, same [RESUMED] + queued requeued (3086.4641ms)
  ✔ fallback does not apply after the window or on exit code 0 (145.0323ms)
  ✔ recover() never throws: a member whose spawn fails becomes error, the rest are still recovered (6.6816ms)
  ✔ orphans: a surviving child whose image name matches the engine is killed before --resume; a recycled pid with another name is left alone (7.0786ms)
  ✔ fresh daemon (no rows): no notice, no spawn (2.2108ms)
✔ Office restart recovery (T09) (6367.0919ms)
ℹ tests 18  ℹ pass 18  ℹ fail 0

$ npx tsx --test test/**/*.test.ts        # 전체
ℹ tests 167  ℹ suites 29  ℹ pass 164  ℹ fail 0  ℹ skipped 3 (PIXEL_IT 미설정 통합 3건)
```

통합(실제 데몬·실제 Claude, sandbox = `dev/spike-0/sandbox`; `[daemon] data dir/db/hook port` 줄만 생략):

```
$ PIXEL_IT=1 npx tsx --test test/office/restart.integration.test.ts
[d1:out] [daemon] pixel-office daemon v1.0.0 pid=14664
[d1:out] [daemon] ws        : ws://127.0.0.1:6074
[d1:out] [daemon] listening
[IT] d1 hello ok (329ms) snapshot.seq=0
[IT:c1] status starting (starting)
[IT] clockIn member=m_d8aa0b01c892 pid=21528 (463ms)
[IT:c1] status idle (free)
[IT] idle (SessionStart) 2314ms
[IT:c1] status working (working)
[IT:c1] event #1 thinking {"text":"[TASK#1 from user]\n한 줄로 인사해줘"}
[IT:c1] event #2 text {"text":"안녕하세요! 무엇을 도와드릴까요? 👋"}
[IT:c1] event #3 idle {}
[IT] greeting (task#1) 6287ms: "안녕하세요! 무엇을 도와드릴까요? 👋"
[IT:c1] event #4 reporting {"summary":"안녕하세요! 무엇을 도와드릴까요? 👋"}
[IT:c1] status idle (free)
[IT] before kill: status=idle session_id=871c0e11-f997-4e09-a3bc-bbf2e0668814 child_pid=21528
[IT] d1 killed: exited=true code=1 signal=null (6303ms)
[IT] claude#1 pid 21528 alive after daemon death: true
[d2:err] [office] 복구: tester 의 이전 프로세스(pid 21528)가 살아 있어 종료함
[d2:out] [office] recover tester(m_d8aa0b01c892): --resume 871c0e11-f997-4e09-a3bc-bbf2e0668814, assigned 0, requeued 0, expired 0
[d2:out] [office] 복구: 1명 재개, 0건 만료, 유령 1개 정리
[IT] recovery notice (8553ms): [office] 복구: 1명 재개, 0건 만료, 유령 1개 정리
[d2:out] [daemon] pixel-office daemon v1.0.0 pid=10580
[d2:out] [daemon] ws        : ws://127.0.0.1:6074
[d2:out] [daemon] listening
[IT] orphan claude#1 pid 21528 killed by recovery: true
[IT] after restart: status=starting session_id=871c0e11-f997-4e09-a3bc-bbf2e0668814 child_pid=6868 (9069ms)
[IT:c2] event #5 text {"summary":"resumed"}
[IT] resumed event #5 (10464ms)
[IT:c2] status idle (free)
[IT:c2] status working (working)
[IT:c2] event #6 thinking {"text":"[RESUMED] 데몬이 재시작됐다. 진행 중이던 작업: 없음. 마지막 확인된 행동: thinking [TASK#1 from user] 한 줄로 인사해줘; text 안녕하세요! 무엇을 도와드릴까요? 👋; idle; reporting 안녕하세요! 무엇을 도와드릴까요? …
[IT] [RESUMED] typed (11238ms): [RESUMED] 데몬이 재시작됐다. 진행 중이던 작업: 없음. 마지막 확인된 행동: thinking [TASK#1 from user] 한 줄로 인사해줘; text 안녕하세요! 무엇을 도와드릴까요? 👋; idle; reporting 안녕하세요! 무엇을 도와드릴까요? 👋. 현재 상태를 점검하고 이어서 진행하라.
[IT:c2] event #7 text {"text":"상태를 확인했습니다. 이전 작업(TASK#1, 한 줄 인사)은 재시작 전에 이미 끝났고, 이어서 할 작업은 없습니다. 지금은 대기 중입니다."}
[IT:c2] event #8 idle {}
[IT] reply to [RESUMED] (15774ms): "상태를 확인했습니다. 이전 작업(TASK#1, 한 줄 인사)은 재시작 전에 이미 끝났고, 이어서 할 작업은 없습니다. 지금은 대기 중입니다."
[IT:c2] status idle (free)
[IT] attach screen=2070 bytes; has instruction=true greeting tokens hit=["안녕하세요","무엇을","도와드릴까요"]
[IT] screen tail:
 ▐▛███▛█Claude Codev2.1.270
▝▜██████▀Opus 5 · Claude Max
  ▝▝ ▝▝  D:\myproject\pixel-office\dev\spike-0\sandbox · /rc
❯ [TASK#1 from user]   한 줄로 인사해줘
●안녕하세요!무엇을도와드릴까요?👋
❯ [RESUMED] 데몬이 재시작됐다. 진행 중이던 작업: 없음. 마지막 확인된 행동: thinking [TASK#1 from user] 한 줄로 인사해줘; text 안녕하세요! 무엇을 도와드릴까요? 👋; idle; reporting 안녕하세요! 무엇을 도와드릴까요? 👋. 현재 상태를 점검하고 이어서 진행하라.
●상태를확인했습니다.이전작업(TASK#1,한줄인사)은재시작전에이미끝났고,이어서할작업은없습니다.지금은대기
중입니다.
✢ Determining… (running stop hooks… 0/2 · 4s · ↓ 203 tokens · thought for 1s)
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────❯
⏸ manual mode on · esc to interrupt · ← for agents
[IT:c2] status working (working)
[IT:c2] event #9 thinking {"text":"[TASK#2 from user]\n아까 뭐라고 인사했는지 한 줄로"}
[IT:c2] event #10 text {"text":"아까는 \"안녕하세요! 무엇을 도와드릴까요? 👋\"라고 인사했어요."}
[IT:c2] event #11 idle {}
[IT] recall (20367ms): "아까는 \"안녕하세요! 무엇을 도와드릴까요? 👋\"라고 인사했어요."
[IT] greeting tokens=["안녕하세요","무엇을","도와드릴까요"] hits=["안녕하세요","무엇을","도와드릴까요"]
[IT:c2] event #12 reporting {"summary":"아까는 \"안녕하세요! 무엇을 도와드릴까요? 👋\"라고 인사했어요."}
[IT:c2] status idle (free)
[IT:c2] event #13 idle {"summary":"session ended: prompt_input_exit"}
[IT:c2] status exited (exited)
[IT:c2] event #14 idle {"summary":"clocked out"}
[IT] clockOut done (23365ms); claude#2 alive=false
[IT:c2] notice info: daemon shutting down
[d2:out] [daemon] bye
[IT] d2 exited=true code=0 (23385ms)
[IT] leftover check: 21528=dead 6868=dead
✔ real daemon restart: greet → kill daemon → new daemon resumes member → screen shows prior chat → recalls greeting → clockOut → shutdown (24989.4126ms)
ℹ tests 1  ℹ pass 1  ℹ fail 0

$ powershell: Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ? CommandLine -like '*pixel-office-t09*'
no leftover claude.exe from T09 tests   (임시 dataDir 도 남지 않음)
```

관찰: 하드 킬 뒤 daemon.json 이 남아 있었고(스냅샷 seq 4), 재기동 데몬은 같은 `session_id` 로 `--resume` 했고 `SessionStart(source=resume)` 가 같은 id 를 보고했다(`session_id` 불변). attach 화면(스크롤백 포함)에 재시작 전 `[TASK#1]`·인사·`[RESUMED]` 턴이 모두 있고, 회상 답변은 앞 인사를 그대로 인용했다. 복구 알림 → listening 까지 1초 미만, 재스폰 → idle 약 1.4초, 하드 킬 → 회상 답변까지 14초.

## 발견한 함정

1. **데몬을 하드 킬하면 ConPTY 자식(claude.exe)이 살아남는다.** 01 §실측 결과 반영 "프로세스 수명: 데몬(부모)이 죽으면 ConPTY 자식도 죽는다 → 유령 정리 불필요" 는 정상 종료(`/exit` 후 종료·SIGINT shutdown)에서만 맞다. `process.kill(pid)`(TerminateProcess)로 죽이면 자식은 그대로 살아 있다(위 `claude#1 pid 21528 alive after daemon death: true`, 첫 실행에서도 동일). 살아남은 자식은 같은 `PIXEL_MEMBER` 토큰으로 새 데몬의 hook 포트에 계속 POST 하고 세션 파일을 쥔다 → 그대로 두면 새 데몬이 두 프로세스의 hook 을 한 멤버로 섞어 받는다. 그래서 설계문서가 예비해 둔 "기동 시 PID 정리"(살아 있으면 종료 후 `--resume`; node-pty 는 재-attach 불가)를 `orphans.ts` 로 넣었다. **01/02 문서 수정 필요(상위에서):** 01 "설계 변경 이력" 에 한 줄, 02 실측 체크리스트의 해당 항목 정정. `child_pid` 는 이제 "기록만" 이 아니라 복구가 읽는다.
2. **복구 알림은 클라이언트가 못 받는다.** `daemon.notice{복구: …}` 는 `office.start()` 안(WS listen 전)에서 나가므로 콘솔 로그로만 남고, 클라이언트는 스냅샷·`error`/`text{resumed}` 이벤트로 결과를 본다. 통합 테스트도 데몬 stdout 의 `[office] 복구: N명 재개` 줄로 기다린다(PROTOCOL 에 명시).
3. **stdout 매칭 실수(테스트 버그, 수정됨):** 유령 정리 `notice(warn)` 도 `[office] 복구:` 로 시작해 첫 실행에서 요약 줄 대신 잡혔다. 정규식 `복구: \d+명 재개` 로 고침.
4. **Windows `process.kill(pid)` 은 exit code 1·signal null** 로 보인다(SIGTERM 이 아니라 TerminateProcess). 테스트는 exitCode 를 단정하지 않는다.
5. **[RESUMED] 는 열린 M2 `ask_user` 질문이 있으면 flush 되지 않는다** — `InputQueue.isIdle` 이 열린 pending 을 보기 때문(T05 남은 것). 그 질문은 설계대로 유효하게 남기지만, `[ANSWER q#N]` 만 통과시키는 예외는 T17 몫. 단위 테스트는 그래서 ask_user 케이스를 별도 건으로 뒀다.
6. **유령 판별의 pid 재사용 위험:** `tasklist` 로 이미지 이름을 확인해 엔진 이름(`claude`/`codex`)이 들어 있을 때만 죽인다. Codex 가 `node.exe` 로 뜨면 건드리지 않고 warn 만 낸다(T20 에서 실측 후 이름 규칙 보강).
7. 회상 검증은 "인사말의 2글자 이상 토큰 중 하나라도 회상문에 있음" 이라 느슨하다 — 실제로는 4/4 토큰이 그대로 인용됐다. 모델 출력이라 정확 일치는 요구하지 않았다.

## 결정

04-결정기록.md 에 append 필요(이 태스크는 04 를 수정하지 않음). 제안:

- **D-17 · 하드 킬에서 살아남은 ConPTY 자식은 기동 시 이름 확인 후 종료한다.** 맥락: 함정 1. 결정: `child_pid` 가 살아 있고 프로세스 이름에 엔진 이름이 있으면 `taskkill /T /F` 후 `--resume`; 이름이 다르면 건드리지 않고 warn. 대안: 재-attach(node-pty 미지원), 방치(hook 혼선). 결과: `orphans.ts`, notice `유령 J개 정리`.
- **D-18 · `--resume` 폴백은 10초·1회, `session_id` 를 지운다.** 맥락: T07 남은 것(세션 파일 없으면 바로 종료). 결정: 창 안 비정상 종료면 `session_id=null` + `error{resume failed; started fresh session}` + 새 세션 1회, task 는 유지·재큐잉. 두 번째도 죽으면 일반 error. 근거: 옛 id 를 남기면 다음 재시작마다 같은 실패를 반복한다.
- **D-19 · 재시작 시 TUI 질문/ask_user 질문의 구분은 `pending.payload.tool_input` 유무.** 맥락: 01 "대기 정책"(TUI 메뉴는 프로세스와 함께 사라짐, ask_user 는 유효). 결정: 어댑터(T04)가 `AskUserQuestion` pending 에 `tool_input` 을 넣으므로 이것을 판별 키로 쓴다. T17 의 `ask_user` pending 은 `tool_input` 을 넣지 않아야 한다.
- **D-20 · [RESUMED] 요약은 복구가 이벤트를 쓰기 전 스냅샷 + 만료 건수 한 문장.** 맥락: "마지막 확인된 행동" 은 죽기 직전 모습이어야 한다. 결정: 최근 5건은 만료 error 이벤트를 쓰기 전에 읽고, 만료가 있으면 `만료된 허가·질문: N건(필요하면 다시 요청하라).` 를 덧붙인다(설계 문구에 추가).

## 남은 것

- **문서(상위):** 01 "설계 변경 이력" + 02 실측 항목 정정(함정 1), 04 에 D-17~D-20, 03 T09 체크, `dev/daemon/README.md`(복구 동작·유령 정리·`PIXEL_IT=1 … restart.integration.test.ts`).
- 복구 알림을 클라이언트도 볼 수 있게 하려면 `hello` 응답에 마지막 복구 요약을 싣거나(예: `daemon.lastRecovery`) 알림을 첫 클라이언트 접속 때 재전송 — T18 "재시작 UI" 에서 결정.
- `member.restart` 의 `RESUMED_TEXT` 는 짧은 문구 그대로. `buildResumedText` 를 재사용해 진행 task 요약을 붙이는 건 T18/T26(지시문 즉시 반영) 때.
- 열린 `ask_user` 질문이 있는 멤버는 [RESUMED] 가 답이 올 때까지 큐에 머문다(함정 5) — T17.
- Codex 유령 이름 규칙·`codex resume` 폴백 증상(종료 코드) 미실측 — T20.
- 통합 테스트는 "진행 중(working) 상태에서 죽는" 시나리오(assigned task 가 [RESUMED] 에 실리고 모델이 이어서 진행)는 하지 않았다(단위 테스트로만). T10 시연에서 허가 대기 중 kill → `재지시 필요` 이벤트 → 이어서 진행까지 콘솔로 확인.
- `recover()` 는 동기(스폰까지)이고 폴백만 비동기다. 멤버가 많으면 기동이 스폰 수만큼 늦어진다(멤버당 수십 ms, ConPTY 생성 비용) — 상한 4명 기준 문제 없음.
