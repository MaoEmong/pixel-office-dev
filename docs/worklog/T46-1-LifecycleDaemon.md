# T46-1 — 수명 주기 (데몬 쪽)

- 날짜: 2026-09-21
- 마일스톤: M6
- 관련 설계: `docs/design/수명주기.md`(전문) · 04-결정기록 **D-47**(D-02 의 기본 동작을 뒤집음), D-17·D-18~D-20(복구), D-36(보류 ↔ pending 분리), D-40(단일 데몬 가드)
- 커밋: `8f97fba` `93fc378` `64fa320` `28be89a` `7da059f` (브랜치 `worktree-agent-a7178fe8e25b4cf64`)

## 목표

앱·데몬·AI 세션을 **한 몸**으로 만드는 네 가지 중 데몬이 맡는 쪽. 끝나면:

- 앱이 강제 종료돼도 데몬이 스스로 알아채고 같은 정리를 한다 → 주인 없는 `claude.exe`·`codex.exe` 가 남지 않는다.
- 앱을 닫았다 다시 켜면 **어제의 사무실이 그대로** 출근해 있다. 그러면서 **토큰을 쓰지 않는다**.
- 데몬이 하드 킬돼도 남은 CLI 를 치우고 같은 대화를 이어서 다시 띄운다(이건 T09 부터 있었고, 여기서 순서·상한·침묵을 더했다).

## 한 것

### 1. 부모 앱 감시 — `dev/daemon/src/office/parentWatch.ts` (신규, §3)

`PIXEL_PARENT_PID` 가 있으면 **2초마다** 그 pid 가 살아 있는지 본다. 두 가지를 갈라 놨다:

- **폴링은 싼 것만** — `process.kill(pid, 0)` 시스템 콜 하나(`EPERM` 도 "살아 있음", D-40 과 같은 규칙).
- **비싼 것은 한 번만** — 프로세스 **시작 시각**(win32: PowerShell `Get-CimInstance Win32_Process` 한 번)은
  대상이 정해질 때만 읽는다. 폴링에서 그 값이 달라지면 pid 재사용으로 본다. 못 읽으면 pid 만 본다(감시를 끄지 않는다).

사라지면 `부모 앱이 사라졌다` 로그 + `daemon.notice{level:'warn', kind:'parent-gone'}` + `daemon.shutdown` 과 **같은** 정리.
한 번만 쏜다. `hello{parentPid}` 가 대상을 바꾸고(`Office.watchParent`), `PIXEL_KEEP_DAEMON=1` 이면 그것도 무시한다.
시계(`WatchTimer`)와 프로세스 표(`ProcessProbe`)가 주입구라 테스트는 진짜 프로세스도 진짜 시간도 쓰지 않는다.

### 2. `suspended` — `src/store/{schema,Store,types}.ts` · `src/office/derived.ts` · `src/office/afterCare.ts` (§5)

`members.status` 에 값 하나(스키마 **v5**, 추가만). SQLite 는 CHECK 를 ALTER 로 못 고쳐 `members` 표만 통째로 다시 만든다
(`MEMBERS_V5_SQL`) — 행은 그대로 옮기고, `DROP TABLE members` 뒤 `ALTER ... RENAME TO members` 순서라 다른 표의
`REFERENCES members(id)` 는 건드려지지 않는다(T39 가 물린 함정의 **반대쪽**). 판단은 버전이 아니라 `sqlite_master` 의
실제 표 정의를 본다 — 멱등이고 손으로 만든 DB 에서도 맞는다.

- `derived.ts`: `RAW_ONLY_STATUSES = {exited, error, suspended}` — 파생이 덮지 않는다. 잠시 닫힌 캐릭터는 열린 `ask_*`
  질문을 **일부러 남긴 채** 접히므로 "질문 대기" 로 보이면 안 된다(자고 있다).
- `afterCare.ts`: `SETTLE_MATRIX` 에 **`suspend` 행**. `recover` 와 거의 같고 한 칸이 다르다 — 살아 있는 CLI 를 닫는 길이라
  **보류를 끊는다**(안 끊으면 `/exit` 전에 CLI 가 응답을 기다리며 선다). 만료 문구의 까닭은 `policy.expiredWhy` 로 갈라
  `앱 종료로 만료됨` / `재시작으로 만료됨` 이 된다.
- `Store.liveHead`/`liveLead` 는 손대지 않았다 — `status NOT IN ('exited','error')` 이므로 `suspended` 부장은 여전히 "살아 있는 부장" 이다(곧 돌아온다).

### 3. 종료 완결성 — `src/office/Office.ts` `shutdown()` · `src/rpc/RpcServer.ts` (§2)

`daemon.shutdown` · SIGINT/SIGTERM · 부모 사라짐이 **같은 길**로 들어온다. 순서를 바꿨다:

1. 부모 감시 정지 + 아직 안 깨운 복구 줄 버리기(`cancelRecovery`) — 내려가는 데몬이 새 CLI 를 띄우면 안 된다.
2. `suspendLiveMembers()` — 잎부터 `settle(id,'suspend')` + `status = 'suspended'`.
3. 전원 정중히 종료(기존) → hook·MCP·확인용 세션 종료 → DB 닫기(기존).
4. **`awaitChildrenGone()`** (신규) — `members.child_pid` + `usage_probe.child_pid` + 지금 살아 있는 확인용 세션 pid 를
   **store 를 닫기 전에** 모아 두고, 다 사라질 때까지 100ms 간격으로 4초까지 기다린 뒤 남은 것은 `reapOrphan`(이름 확인 포함)으로 트리째.
5. **그제야** `daemon.json` 삭제.

`daemon.shutdown` 응답은 `{closing: N}`(`Office.closingSessions()` = 멤버 세션 + 확인용 세션). 종료가 시작되면 그때 센 수를
기억해 두고 **두 번째 요청은 같은 수만 돌려주고 아무것도 다시 하지 않는다**(`Office.isClosing`).

### 4. 기동 복구 — `src/office/recovery.ts` (신규) + `Office.recover()` 재작성 (§4·§5)

`recovery.ts` 는 **순수 규칙**만 갖는다(afterCare 와 같은 이유 — 표 하나로 읽히고 Office 없이 검증된다):

- `recoveryOrder(members, {hintDepartmentId, recentDepartmentId})` — 부서 우선순위 × 트리 깊이 × 원래 순서.
- `needsResumedText({assigned, queued, issued, openQuestions})` — 말없이 앉히기 규칙.
- `RECOVER_MAX_IN_FLIGHT = 3`, `RECOVER_BOOT_SLOT_MS = 60_000`.

Office 쪽은 **스케줄러**가 됐다(`RecoverPlan`). 줄에서 하나씩 꺼내 띄우고, 띄운 멤버는 `starting` 을 벗어날 때까지 자리를 잡는다
(`emitStatus` / `onPtyExit` / 상한 타이머 셋이 자리를 돌려준다). 그래서 `recover()` 는 **바로 돌아오고** 뒤에서 줄이 흘러간다 —
그동안 앱이 붙어 스냅샷을 받고 `hello{activeDepartmentId}` 로 "지금 보는 부서부터" 를 알려 줄 수 있다(`prioritizeRecovery`).
진행은 `daemon.notice{kind:'recovering', total, done}`.

대상에 `suspended` 를 더하고(`RECOVERABLE`), `[RESUMED]` 는 하던 일이 있는 멤버에게만 만든다(없으면 빈 문자열 → `enqueueResumed` 가
아무것도 넣지 않는다). `RecoveryResult` 에 `silent`·`total` 이 늘었다.

### 5. 유령 정리의 이름 확인 — `src/office/orphans.ts`

`reapOrphan(ops, pid, engine, { exeName })` 로 넓혔다. 기본은 **D-17 그대로**(이름에 `claude`/`codex` 가 들어갈 때만)이고,
여기에 "데몬이 실제로 띄운 실행 파일 이름" 만 더 인정한다(`Office.engineExeName` → `config.claudeExe`/`codexExe` 의 basename).

### 6. 문서

`dev/daemon/PROTOCOL.md` 에 **"수명 주기"** 절(부모 감시 · `suspended` 표 · 정상 종료 여섯 단계 · 기동 복구가 더한 넷 · 와이어 변화 요약)
+ `hello`·`daemon.shutdown`·`member.status`·`daemon.notice` 행과 파생 상태 표, "재시작 복구" 절 머리말 갱신.
`dev/daemon/README.md` 에 환경변수 둘과 "누가 데몬을 끄는가" 표. `src/cli/help.ts` 에 상태 목록 + `shutdown` 설명.

## 검증

```
$ npx tsc --noEmit
(출력 없음)

$ npm test
ℹ tests 778      (기준선 742 → +36)
ℹ pass 771
ℹ fail 0
ℹ skipped 7
ℹ duration_ms 36890
```

새 테스트: `test/office/ParentWatch.test.ts`(9건) · `test/office/Lifecycle.test.ts`(22건) + `RecoveryTree.test.ts` 2건 ·
`RpcServer.test.ts` 3건. 고친 테스트: `Office.test.ts`(종료 → `suspended`), `Recovery.test.ts`(`RecoveryResult` 모양),
`RecoveryTree.test.ts`(동시 3개), `MigrationV4.test.ts`(v5), `RpcServer.test.ts`(`{closing}`).

**실기 — `restart` 통합 테스트**(진짜 데몬 둘 + 진짜 `claude.exe` 2.1.275, 임시 `PIXEL_DATA_DIR` + 빈 포트 3개):

```
$ PIXEL_IT=1 PIXEL_IT_SANDBOX=D:/myproject/pixel-office/dev/spike-0/sandbox \
  npx tsx --test test/office/restart.integration.test.ts

[IT] orphan claude#1 pid 37692 killed by recovery: true
[IT] after restart: status=starting session_id=f76a47af-… child_pid=1280 (18048ms)
[IT] resumed event #5 (19671ms)
[IT] silent seat check (27685ms): thinking events after resume = []
[IT] attach screen=1282 bytes; has instruction=true greeting tokens hit=["안녕하세요","it09","부서","부장",…]
[IT] recall (32331ms): "\"안녕하세요! it09 부서 부장 기억이입니다 — 무엇을 도와드릴까요?\" 라고 인사했습니다."
[IT] daemon.shutdown → {"closing":2}
[d2:out] [office] 종료: 세션 2개 닫음, 0명 잠시 닫힘(suspended)
[IT] leftover check: 37692=dead 1280=dead
✔ real daemon restart: … (37089.952ms)
ℹ tests 1  ℹ pass 1  ℹ fail 0
```

복구 알림은 `[office] 복구: 1명 재개, 0건 만료, 말없이 1명, 유령 1개 정리`(테스트가 문자열로 검사한다).
**가장 중요한 줄은 `thinking events after resume = []`** — T46 이전에는 여기서 `[RESUMED]` 한 턴이 돌았다.
대화 기억은 그대로다(회상 성공). 남은 프로세스 0.

> `[d2:err] Error: AttachConsole failed` 는 node-pty 의 `conpty_console_list_agent` 가 데몬이 끝난 뒤 뱉는 예전부터 있던
> 잡음이다(exit code 는 0). 이번 변경과 무관.

## 발견한 함정

1. **`[RESUMED]` 침묵 규칙을 "내가 맡은 일" 로만 잡으면 부장이 벙어리가 된다.** 부장·팀장은 자기에게 배정된 task 가
   보통 없다 — 하던 일은 **자기가 낸 일**(`openTasksIssuedBy`)이다. 그대로 두면 되살아난 상사가 곧 도착할 `[REPORTS …]` 를
   문맥 없이 받는다(T36/D-20 이 고쳐 놓은 것이 도로 깨진다). `needsResumedText` 가 `issued` 를 같이 본다.
2. **`node.exe` 를 유령 판정에 무조건 넣으면 안 된다.** 태스크 지시에는 "`node.exe` for the wrapper" 가 있었지만, 데몬·앱·npm 이
   전부 node 라 재사용된 pid 하나로 엉뚱한 프로그램을 트리째 죽일 수 있다 — 기존 테스트(T20/T09)가 바로 그 경우를 막아 놨다.
   그래서 "아무 node" 가 아니라 **"데몬이 자기가 띄운 그 실행 파일"** 로 좁혔다(아래 결정).
3. **복구를 "전부 기동할 때까지" 기다리면 알림이 늦는다.** 동시 상한 3 을 넣자 `start()` 안에서 끝나던 복구 요약이
   CLI 준비를 기다리게 됐다. 그런데 "무엇을 되살리고 무엇을 포기했는가" 는 줄이 비는 순간 이미 다 정해져 있다 —
   그래서 **줄이 비면** 복구가 끝난 것으로 본다(남은 자리 타이머는 그때 정리한다). 기존 T09 테스트의 알림 검사가 그대로 산다.
4. **`ALTER TABLE ... RENAME TO` 의 방향.** T39 가 물린 사고는 "옛 표를 rename 하면 다른 표의 REFERENCES 가 따라간다" 였다.
   v5 는 반대로 **새 표를 만들고 → 복사하고 → 옛 표를 DROP 하고 → 새 표를 rename** 한다. rename 이 따라가는 것은
   `members_v5` 를 가리키는 참조뿐인데 그런 표가 없으므로 `pending.member_id` 는 멀쩡하다.
5. **테스트에서 파일 DB 를 쓰면 윈도우가 폴더를 못 지운다.** "껐다 켠다" 를 흉내 내려면 같은 DB 를 두 번 열어야 하는데,
   `shutdown()` 이 store 를 닫으므로 Office 없이 끝나는 테스트는 `afterEach` 에서 따로 닫아 줘야 `rmSync` 가 `EPERM` 을 안 낸다.
6. **두 데몬이 `FakeReceiver` 를 공유하면 안 된다.** 첫 Office 가 리스너를 단 채로 store 를 닫으므로 hook 이 `database is not open` 으로 터진다.

## 결정

- **D-47 구현.** 새 결정 번호는 만들지 않았다(`docs/04-결정기록.md` 는 이 태스크 범위 밖).
- 다만 두 가지는 설계문서 문구를 좁혀 구현했으니 기록해 둔다(T46 통합 때 D-47 딸린 결정으로 올릴 후보):
  1. **유령 판정의 `node.exe`** — "아무 node" 가 아니라 `config.claudeExe`/`codexExe` 의 이미지 이름과 같을 때만.
     설계문서(§4-1)는 "그 pid 가 정말 그 CLI 인지(실행 파일 이름) 확인한다" 이고, 이쪽이 그 문장에 더 맞는다.
  2. **복구의 "끝"** — 모든 CLI 가 준비 화면에 도달한 때가 아니라 **되살릴 대상을 다 처리한 때**. 그 뒤는 CLI 기동 시간일 뿐이고
     SessionStart·화면 감시가 알아서 받는다.

## 남은 것

- **T46-2(앱)** — §1 데몬 직접 띄우기·§2 확인 대화와 8초 대기·§4 자동 재시작·`suspended` 표시(회색 + `(잠시 닫힘)`)·
  `hello{parentPid, activeDepartmentId}` 보내기·`{closing}` 으로 "정리하는 중…" 그리기. 와이어는 위 "한 것 6" 의 요약표가 전부다.
- **T46-3 실기** — 설계문서 §검증 1~8(특히 5 "앱을 `taskkill /F` → 데몬이 몇 초 안에 스스로 정리" 와 2 "남은 프로세스 0").
  데몬 쪽 단위 검증은 끝났지만 **진짜 앱과 함께** 돌려 본 적은 없다.
- **부모 시작 시각의 실기 확인** — `Get-CimInstance Win32_Process` 가 이 머신에서 얼마나 걸리는지(기동 때 한 번뿐이라
  문제가 되진 않겠지만 숫자를 안 재 봤다). 실패하면 pid 만 보는 폴백이 돈다.
- **`suspended` 인 상사 아래 고용** — `hireChild` 의 게이트는 `GONE`(exited/error)만 본다. 복구는 RPC 가 열리기 전에 시작하므로
  실제로 마주칠 창이 아주 좁지만, 이론적으로는 "잠시 닫힌 팀장 밑에 팀원을 붙이는" 요청이 통과한다. 다음 태스크 후보.
- 윈도우 작업 개체(Job Object)로 묶기는 설계문서대로 **범위 밖** — 부모 감시로 충분한지 T46-3 에서 보고 판단한다.
