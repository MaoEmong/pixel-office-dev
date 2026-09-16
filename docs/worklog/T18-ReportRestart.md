# T18 — 보고서 탭 · 재시작 UI (재지시 필요 카드 · 퇴근/오류 배너 · 재고용 · 터미널 스크롤백 유지)

- 날짜: 2026-09-15 ~ 2026-09-16(간헐 실패 추적·수정)
- 마일스톤: M2
- 관련 설계: 01-설계문서.md §구성 요소 3 "Flutter 데스크탑"(보고서 탭 — v1a 보고 = Stop 마지막 메시지, "재지시 필요", 데몬 죽음/재시작 흐름, 성공 기준 6·10), `dev/daemon/PROTOCOL.md`(`reporting{summary}` ref taskId, `error{summary, pendingId}`, `error{process exited (code N)}`, `member.rehire`/`member.restart`, "재시작 복구"), 04-결정기록 D-11 · D-15 · D-16 · D-19 · D-21, worklog T13(터미널 탭 남은 것) · T15(카드 영역)
- 커밋: (미커밋 — 이 태스크는 커밋하지 않음)

## 목표

멤버가 턴을 끝내면 그 보고(v1a = Stop 의 마지막 assistant 메시지)를 **보고서 탭**에서 task 별로 본다. 허가·질문이 사용자 답 없이 닫히면(hook 보류 시간 초과 · 연결 끊김 · 데몬 재시작 만료) 오른쪽 패널에 **"⚠ 재지시 필요" 카드**가 떠서 터미널 탭으로 바로 가거나 원래 지시문을 복사해 다시 지시할 수 있다. 멤버가 퇴근했거나(`exited`) 오류로 죽으면(`error`) 헤더 아래 배너에 **재고용** 버튼이 뜨고 `member.rehire` 로 되살린다. 데몬이 재시작되며 만료시킨 요청이 있으면 "데몬이 재시작됐어요 — 만료된 요청 N건" 힌트를 보여 준다. 터미널 탭은 이제 탭을 오가도 스크롤백이 남는다(T13 남은 것).

## 한 것

전부 `dev/app/lib/panel/` · `dev/app/test/panel/` 안. `lib/main.dart`·`lib/office`·`lib/state`·`lib/model`·`lib/rpc`·`lib/command`·`lib/topbar` 는 건드리지 않았다(`notices.dart`·`daemon_launcher.dart` 도 손댈 필요가 없었다).

- `lib/panel/report_tab.dart` (자리표시 `ReportTab` 교체) — 스냅샷 `tasks` 에는 queued|assigned 만 오므로 보고된 task 는 **이벤트에서 되살린다**(`memberLogProvider` = 백필 ∪ 라이브, D-21 — 재접속해도 남는다).
  - `parseTaskPrompt(text)`: `[TASK#N from <who>]\n<지시>` → `(taskId, from, instruction)`. `[RESUMED]`·`[ANSWER q#]` 는 null.
  - `taskInstructionsProvider(id)`: task id → 지시문. `thinking{text:'[TASK#N from user]…'}`(UserPromptSubmit, 절단본) 위에 `openTasksProvider` 의 열린 task(전문)를 덮는다 — 열린 동안은 전문, 보고된 뒤에는 절단본이 남는다.
  - `memberReportsProvider(id)` → `List<MemberReport>` 최신 먼저. 데몬은 Stop 때 `text` → `idle` → `reporting{summary}` ref `{taskId}` 순서로 쓰므로 **`reporting` 직전의 본문 있는 `text`** 가 그 보고의 전문(`body`), 없으면 `reporting.summary`. 어떤 `reporting` 에도 붙지 않은 `text` 는 **"보고(작업 없음)"**(터미널에서 직접 대화한 턴). `text{summary:'resumed'}` 처럼 본문 없는 text 는 제외.
  - `ReportTab(memberId)`: 백필 진행/실패 배너 + `ReportCard` 목록(`ValueKey('report-<seq>')`). 카드 = `task#N · HH:MM · #seq`(작업 없음이면 회색 제목) / `지시: …`(3줄 절단) / 본문 `SelectableText`(고정폭, `reportBodyMaxHeight`=260 안에서 스크롤). 비어 있으면 "아직 보고 없음".
- `lib/panel/redo_card.dart` (신규) — "재지시 필요" 카드.
  - `isRedoEvent(ev)` = `error` ∧ `detail.pendingId != null`. `isTurnBoundary(ev)` = `idle` ∨ 본문 있는 `text`.
  - `redoNeededProvider(id)`: 로그를 훑어 **마지막 턴 경계 뒤**의 error{pendingId} 를 pendingId 별로 하나씩(같은 pending 에 여러 error 가 오면 최신 것). 멤버가 새 턴을 끝내면(idle/text) 비워져 카드가 내려간다. `text{summary:'resumed'}` 는 본문이 없어 경계로 세지 않는다 — 재시작 복구가 `error{재지시 필요}` → `text{resumed}` 순서로 쓰기 때문(세면 카드가 뜨자마자 사라진다).
  - `redoInstructionProvider(id)`: "다시 지시" 가 복사할 원래 지시문 = 열린 task 중 최신(전문) → 없으면 로그의 마지막 `[TASK#N from user]` thinking(절단본).
  - `describeRedoSummary(summary, pendingType)`: `timed out` → "허가 요청 보류가 시간 초과로 닫혔어요 — CLI 가 자기 프롬프트를 띄웠으니 터미널에서 직접 답하세요"(D-11·D-16), `connection closed` → "…답하기 전에 끊겼어요", `재지시 필요…` → 원문 + "데몬이 재시작되며 열려 있던 …이 사라졌어요", 그 외 원문.
  - `RedoCards(memberId)` / `RedoCard(event)`: `⚠ 재지시 필요` · 시각 · 사유 · 버튼 **터미널에서 답하기**(`ValueKey('redo-terminal-<pendingId>')` → `panelTabRequestProvider.notifier.request(RightPanelTab.terminal)`) · **다시 지시**(`ValueKey('redo-instruct-<pendingId>')` → `Clipboard.setData` + SnackBar "지시문을 복사했어요 — 지시 바에 붙여넣기"; 지시문을 못 찾으면 "원래 지시문을 찾지 못했어요 — 지시 바에 직접 입력하세요").
- `lib/panel/panel_tabs.dart` (신규) — `enum RightPanelTab { log, terminal, files, report }` 를 right_panel 에서 여기로 옮기고 **`panelTabRequestProvider`**(`NotifierProvider<PanelTabRequestNotifier, PanelTabRequest?>`, `request(tab)` 이 nonce 를 올려 같은 탭을 연달아 요청해도 리스너가 불린다) 정의. RightPanel 이 `_TabRequestListener` 로 듣고 `DefaultTabController.animateTo`. main.dart 배선 불필요.
- `lib/panel/member_gone_banner.dart` (신규)
  - `memberFailureEventsProvider(id)`: 마지막 턴 경계 뒤의 pendingId 없는 `error` 이벤트(오래된 순). `recoveryExpiredCountProvider(id)`: 마지막 턴 경계 뒤의 `재지시 필요` 로 시작하는 error{pendingId} 의 pendingId 개수.
  - **`MemberGoneBanner(member)`**(`Key('panel.goneBanner')`): `status.isGone` 일 때만. `exited` → "퇴근함", `error` → "⚠ 오류로 종료됨 (code N)"(N 은 마지막 턴 경계 뒤의 `error{process exited (code N), exitCode}`; 없으면 코드 생략). 그 밖의 error 요약(`resume failed; started fresh session`, `restart: no session id to resume`, `restart: spawn failed…`)은 한 줄씩 아래에. **재고용**(`Key('panel.rehire')`) → `rpcClient.call('member.rehire', {memberId})`. 성공하면 `member.status{starting}` 이 와서 status 가 바뀌며 배너가 저절로 내려간다. `RpcException` 이면 `재고용 실패: <message>`(-32003 이 아니면 코드도)(`Key('panel.rehire.error')`) 를 배너 안에 두고 버튼을 다시 연다. 끊김이면 버튼 비활성 + 안내.
  - **`RecoveryHint(memberId)`**(`Key('panel.recoveryHint')`): `recoveryExpiredCountProvider` 가 0 이 아니면 "데몬이 재시작됐어요 — 만료된 요청 N건". 복구 알림 `daemon.notice{복구: …}` 는 WS 가 열리기 전에 나가 클라이언트가 못 받으므로(PROTOCOL 재시작 복구 8) 이벤트로 대신한다. 멤버가 새 턴을 끝내면 사라진다.
- `lib/panel/terminal_cache.dart` (신규) — **`terminalCacheProvider`** = `TerminalCache(rpcClient)`; `of(memberId)` 가 멤버별 `CachedTerminal{terminal: Terminal(maxLines: 5000), attached}` 를 만들어 두고 같은 멤버엔 항상 같은 인스턴스를 준다. `terminal.onOutput` → `member.type`, `onResize` → `member.resize`(attached 일 때만) 배선도 여기서 한 번만. `remove(memberId)`.
- `lib/panel/terminal_tab.dart` — Terminal 을 State 가 아니라 캐시에서 받는다. 탭이 보이면 attach(현재 화면을 `\x1b[H\x1b[2J` 뒤에 써서 뷰포트만 비우고 스크롤백은 유지), 숨겨지면/멤버가 바뀌면 detach — 데몬 쪽 구독만 오간다. 세대 번호·재접속 재attach·오류 배너는 T13 그대로.
- `lib/panel/right_panel.dart` — 헤더 아래에 `MemberGoneBanner` → `RecoveryHint` → (카드 영역 `pendingCardsMaxHeight`=320 안에) `RedoCards` + `PendingCards` → `TabBar` 순. `_TabRequestListener`. 배럴 export 에 T18 심볼 추가(`RightPanelTab`/`PanelTabRequest`/`panelTabRequestProvider`, `RedoCards`/`RedoCard`/`redoNeededProvider`/`redoInstructionProvider`/`describeRedoSummary`, `ReportTab`/`ReportCard`/`MemberReport`/`memberReportsProvider`/`taskInstructionsProvider`/`parseTaskPrompt`, `MemberGoneBanner`/`RecoveryHint`/`memberFailureEventsProvider`/`recoveryExpiredCountProvider`, `terminalCacheProvider`/`TerminalCache`/`CachedTerminal`).
- 테스트(신규 `report_tab_test.dart` 3 · `redo_card_test.dart` 3 · `member_gone_banner_test.dart` 3, `terminal_tab_test.dart` +1, `right_panel_test.dart` 의 보고서 자리 테스트를 T18 동작으로 갱신) — `test/panel/` 합계 40건.

## 검증

```
$ cd dev/app && flutter analyze
Analyzing app...
No issues found! (ran in 4.1s)

$ flutter test test/panel/          (3회 연속)
__PANEL_RUNS__

$ flutter test                      (전체, 6회 연속 — 아래 "발견한 함정" 의 간헐 실패 추적)
__FULL_RUNS__
```

`~1` 은 `test/office/office_preview_test.dart` 의 `OFFICE_PREVIEW_OUT` 미설정 skip(T12).

테스트가 확인하는 것(전부 가짜 데몬에 실제 소켓으로 붙어서):
- report_tab: `parseTaskPrompt` 형식(`user`/`m1(팀장)`, `\r\n`, `[RESUMED]`·`[ANSWER]` 는 null) / 백필 `text(4)` + `thinking[TASK#7]` + `text(22)` + `idle` + `reporting(24, taskId 7)` → 카드 2장 `[24, 4]`: `task#7` · `지시: 테스트를 고쳐줘` · 본문 전문, 그리고 `보고(작업 없음)` 로 seq 4 — reporting 에 쓰인 text 는 작업 없음으로 중복되지 않는다; 라이브로 `text{resumed}`(카드 안 됨) + `[TASK#8]` + text + reporting → 맨 위에 `task#8` / 스냅샷 `tasks` 의 assigned task(전문) 가 thinking 절단본보다 우선, `reporting` 만 오고 text 가 없으면 `summary` 가 본문, reporting 뒤 상태 층이 task 를 지워도 지시문은 절단본으로 남는다.
- redo_card: `describeRedoSummary` 4 경우 / 백필 `error{재지시 필요, pendingId a1}` + `text{resumed}` → 카드 1장(제목·사유·버튼 2개), 같은 pendingId 의 두 번째 error 는 사유만 갱신(카드 1장 유지), m2 것은 안 보임, 두 번째 pendingId → 2장, `idle` → 전부 사라짐 / RightPanel 안에서: 카드가 헤더 아래·TabBar 위, **터미널에서 답하기** → `panelTabRequestProvider.tab == terminal` → TerminalView + `member.attach` 1회, **다시 지시** → 클립보드 `'빌드 고쳐줘'`(SystemChannels.platform mock) + 스낵바 문구, 열린 task 를 넣으면 `redoInstructionProvider` 가 그 전문을 준다.
- member_gone_banner: exited 스냅샷 → `퇴근함` + `재고용`, 배너가 헤더 바로 아래, 탭 → `member.rehire{memberId:'m1'}` → `member.status{starting}` 으로 배너 사라지고 헤더 `출근 중` / error 스냅샷 + 백필(이전 턴의 `code 9` 는 경계 앞이라 무시, `resume failed; started fresh session`, `process exited (code 1)`) → `⚠ 오류로 종료됨 (code 1)` + resume failed 줄, `code 9` 없음, 재고용 -32003 → `재고용 실패: member still running` + 버튼 다시 열림 / 살아 있는 멤버는 배너 없음; `재지시 필요` 2건 + 재시작 아닌 error 1건 → 힌트 `만료된 요청 2건`(RedoCard 는 3장), 라이브 `text` 본문 → 힌트·카드 모두 사라짐.
- terminal_tab(+1): RightPanel 터미널 탭 → attach #1, `TerminalView.terminal` 이 `terminalCacheProvider.of('m1').terminal` 과 identical, term 200줄로 스크롤백을 만들고 로그 탭 → detach(attached false, TerminalView 없음) → 터미널 탭 → attach #2, **같은 Terminal 객체**, 버퍼에 `스크롤백 줄 1` 이 그대로 + 새 화면 `SCREEN:m1`, m2 는 다른 인스턴스. 기존 7건(attach 크기·term·type·dispose detach·-32003·재접속·멤버 교체) 그대로 통과.
- right_panel: 보고서 탭 초기 진입(`initialTab: report`) → 백필 text 가 `보고(작업 없음)`, 라이브 text 가 위에 `[12, 4]`, `#12`.

실제 데몬에 붙인 캡처는 없음 — T19(v1a 시연)에서 재시작·재고용 흐름을 사용자가 직접 확인.

## 발견한 함정

- **전체 `flutter test` 의 간헐 실패(`+133 ~1 -1`) 를 잡았다 — `test/panel/report_tab_test.dart` 의 "reporting(ref.taskId) + 직전 text → task#N 카드…" 였다.** 처음 3회 중 2회차에서 재현, `--reporter expanded` 로 다시 돌려 실패 문구를 얻었다:

  ```
  Expected: [33, 24, 4]
    Actual: [32, 24, 4]
     Which: at location [0] is <32> instead of <33>
  report_tab_test.dart:61
  ```

  타이머·timeout 문제가 아니라 **대기 조건이 헐거워서 생긴 경합**이다. 테스트가 라이브 이벤트 4개(`text{resumed}`(30) · `thinking[TASK#8]`(31) · `text{문서 갱신 완료}`(32) · `reporting ref taskId 8`(33))를 연달아 밀어 넣고 `ReportCard` **개수가 3** 이 되기를 기다렸는데, `text`(32) 만 도착해도 그게 "보고(작업 없음)" 카드가 되어 이미 3장이다. 그 틈에 조건이 참이 되면 맨 위 카드 seq 가 33 이 아니라 32 다(33 이 오면 32 를 흡수해 개수는 그대로 3). 소켓 4건이 한 프레임 안에 다 들어오면 통과하고, 32 와 33 사이에 pump 가 끼면 실패 — 부하에 따라 갈렸다.
  고친 방법: 개수 대신 **33 이 와야만 생기는 것**(`task#8` 제목)이 나타날 때까지 기다린다. `pumpUntil(… find.text('task#8') …)`. 실제 타이밍에 의존하지 않고 최종 상태를 기다리므로 결정적이다.
  같은 패턴(개수로 기다리기)이 다른 곳에도 있는지 훑었다 — `right_panel_test.dart` 보고서 탭과 `report_tab_test.dart` 두 번째 테스트, `redo_card_test.dart` 는 모두 **마지막 이벤트로만 생기는 내용**(`최신 응답입니다`, `task#9 done`, RedoCard 유무)을 기다려서 같은 경합이 없다. `test/command/notices_test.dart` 는 `tester.pump(Duration)` 만 써서 실시간과 무관(수정 없음).
- **`text{summary:'resumed'}` 를 턴 경계로 세면 재시작 카드가 뜨자마자 사라진다** — 재시작 복구는 `error{재지시 필요}` 들을 먼저 쓰고 되살린 세션의 `SessionStart(resume)` 이 `text{resumed}` 를 남긴다. 그래서 경계는 `idle` 또는 **본문 있는** `text` 만. 보고서 탭도 같은 이유로 본문 없는 text 를 무시한다.
- **`reporting` 이 오면 상태 층이 `openTasks` 에서 그 task 를 지운다**(T11 규칙) → 보고 카드의 지시문은 열린 task 만 보면 사라진다. `thinking{[TASK#N from user]}` 이벤트(UserPromptSubmit, 200자 절단)를 함께 보되 열린 동안은 전문이 덮어쓰게 했다.
- **Terminal 을 캐시로 옮기면 `onResize` 가 detach 된 뒤에도 불린다**(뷰가 다시 붙을 때 크기가 잡히며). attach 되기 전의 resize 는 데몬이 "마지막 attach 클라이언트" 검사에서 무시하지만 헛 RPC 라 `CachedTerminal.attached` 로 걸렀다. TerminalTab 이 attach 성공에 true, detach/끊김/dispose 에 false.
- 재attach 때 `\x1b[H\x1b[2J` 는 **뷰포트만** 지우므로 스크롤백은 남는다(xterm 의 ED 2 는 스크롤백을 건드리지 않는다 — 스크롤백까지 지우려면 ED 3). 테스트가 200줄을 밀어 넣어 `스크롤백 줄 1` 이 재attach 뒤에도 남는 것을 확인한다.
- 같은 pendingId 에 error 가 두 번 올 수 있다(hook 보류 timeout 뒤 데몬 재시작 등) — 카드 키를 `pendingId` 로 잡아 한 장으로 합친다.

## 결정

- 재지시 카드·퇴근/오류 배너의 exit code·RecoveryHint 는 모두 **"마지막 턴 경계(idle / 본문 있는 text) 뒤의 이벤트"** 로 판정한다("마지막 접속 이후" 가 아니라). 로그는 백필로 재접속과 무관하게 같은 결과를 주고(D-21), 멤버가 새 턴을 끝내면 사용자가 이미 대응했다고 볼 수 있어 셋이 함께 내려간다. 새 결정 번호 없음.
- 보고서는 데몬 `tasks.report_text` 를 조회하는 RPC 없이(PROTOCOL 에 없음) 이벤트에서 되살린다. `reporting` 직전 `text` = `report_text` 와 같은 값(둘 다 Stop 의 last_assistant_message). 새 결정 번호 없음.
- `panelTabRequestProvider` 는 `lib/state` 가 아니라 `lib/panel/panel_tabs.dart` 에(패널 내부 사정, 병렬 작업 규칙). 통합 시 옮겨도 됨.
- "다시 지시" 는 지시 바에 직접 넣지 않고 클립보드 + 스낵바(지시 바는 `lib/command`, 범위 밖). 통합 단계에서 `CommandBar` 에 초기 텍스트 프로바이더가 생기면 교체.

## 남은 것

- `lib/main.dart` 배선 불필요 — `RightPanel(memberId)` 가 그대로 배너·카드·보고서 탭을 포함하고, `panelTabRequestProvider`/`terminalCacheProvider` 는 패널 안에서만 읽는다. (선택) "다시 지시" 를 클립보드 대신 `CommandBar` 입력란에 직접 넣기.
- `member.restart`(지시문 즉시 반영 재시작) 버튼 — 지시문 탭(설계 §3 "지시문" 탭)과 함께.
- 보고서 탭 `beforeSeq` 페이징(백필 200건 안의 보고만 보인다), `reportStatus`(done/blocked) 표시(M4 팀 보고 때).
- 실기 캡처(`img/T18-*.png`): 재시작 → 재지시 카드 → 재고용 흐름은 T19 시연에서.
