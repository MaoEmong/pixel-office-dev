# T13 — 오른쪽 패널 (로그 탭 · 터미널 탭)

- 날짜: 2026-09-15
- 마일스톤: M1
- 관련 설계: 01-설계문서.md §구성 요소 3 "Flutter 데스크탑"(오른쪽 패널), `dev/daemon/PROTOCOL.md`(member.attach/detach/type/resize, `term` 알림, events.query, 재접속 규칙 3), 04-결정기록 D-21
- 커밋: (미커밋 — 이 태스크는 커밋하지 않음)

## 목표

선택한 멤버의 "실제 화면"과 "행동 기록"을 오른쪽 패널에서 본다. 이 태스크가 끝나면 `RightPanel(memberId: …)` 하나로
헤더(이름 · 엔진 · 상태 · 팀 cwd · 출근 후 경과) + 탭 4개(로그 · 터미널 · 변경 파일 · 보고서)가 뜨고,
로그 탭은 라이브 이벤트에 `events.query` 백필을 합쳐 최신이 아래에 쌓이며, 터미널 탭은 xterm 으로 그 멤버의 CLI TUI 를
그대로 보여 주고 키 입력을 데몬으로 보낸다. 재접속하면 둘 다 스스로 다시 채운다(백필 재조회 · attach 재호출).
T12(사무실 캔버스)가 선택 멤버 id 를 넘겨 주기만 하면 된다(`lib/main.dart` 배선은 통합 단계).

## 한 것

전부 `dev/app/lib/panel/` · `dev/app/test/panel/` 안. `lib/main.dart`·`lib/state`·`lib/model`·`lib/rpc` 는 건드리지 않았다.

- `lib/panel/right_panel.dart` — **`class RightPanel extends ConsumerWidget`**, `RightPanel({required String? memberId, RightPanelTab initialTab = RightPanelTab.log})`.
  - `memberId == null` → "캐릭터를 선택하세요". 모르는 id → 헤더에 `멤버 정보 없음 · <id>` (탭은 그대로).
  - `PanelHeader(member)`: 이름 · 엔진 배지 · 상태 점+한국어 라벨(derived 가 status 와 다르면 derived — `한가함`/`보고 대기`) · `팀이름 · 팀 cwd`(팀을 모르면 member.cwd) · `출근 N분`(`ElapsedSince`, 30초마다 갱신).
  - `DefaultTabController` + `TabBar`(로그 · 터미널 · 변경 파일 · 보고서) + `TabBarView`. `enum RightPanelTab { log, terminal, files, report }`.
  - 변경 파일: `_PlaceholderTab('변경 파일 (추후)')`. 보고서: `ReportTab` — `latestTextEventProvider(id)` 의 마지막 `text` 이벤트 본문(`마지막 응답 · HH:MM:SS · #seq` + `SelectableText`). T18 에서 교체.
  - 배럴 export: `LogTab`, `LogRow`, `TerminalTab`, `describeAttachError`, `memberLogProvider`, `memberBackfillProvider`, `latestTextEventProvider`, `MemberBackfill`, 라벨 함수.
- `lib/panel/log_tab.dart` — `LogTab({required String memberId})`. `memberLogProvider(id)` 를 그려 최신이 아래. 행 `LogRow`: `HH:MM`(로컬) · kind 한국어 라벨(색) · 상세 한 줄(고정폭 `Cascadia Mono`, 최대 3줄).
  - 자동 스크롤: 맨 아래(`maxScrollExtent - 8` 이내)를 보고 있을 때만 새 행에 따라 내려간다. 위로 올려 보는 중이면 그대로.
  - 백필 진행/실패 배너(`과거 이벤트 불러오는 중…` / `과거 이벤트 조회 실패: <원인>`). 실패해도 라이브 행은 그대로.
- `lib/panel/member_log.dart` — 로그 데이터 층(D-21).
  - `memberBackfillProvider(id)`: `NotifierProvider.family<MemberBackfillNotifier, MemberBackfill, String>`. build 시 connected 면 `events.query{memberId, limit: 200}` 를 부르고, `connectionStateProvider` 를 **listen**(watch 아님)해 `connected` 로 바뀔 때마다 다시 부른다(첫 접속·재접속 모두). 결과는 `seq → OfficeEvent` 맵으로 누적(중복 제거), 동시 호출은 마지막 것만 반영(티켓). `loading`/`error`/`loadedCount`.
  - `memberLogProvider(id)`: 백필 ∪ `memberEventsProvider(id)`(상태 층 라이브 링) → seq 오름차순, seq 중복 제거. 백필이 비어 있으면 라이브 리스트 그대로(복사 없음).
  - `latestTextEventProvider(id)`: 로그 중 마지막 `text{text≠''}` 이벤트.
- `lib/panel/terminal_tab.dart` — `TerminalTab({required String memberId, double fontSize = 13, bool autofocus = true})`. xterm `Terminal(maxLines: 5000)` + `TerminalView(textStyle: TerminalStyle(fontSize: 13, fontFamily: 'Cascadia Mono'))`(스파이크 ⑤와 같은 설정).
  - 첫 프레임 뒤(레이아웃되어 viewWidth/viewHeight 가 실제 크기) `member.attach{memberId, cols, rows}` → `\x1b[H\x1b[2J` 후 `result.screen` 을 `terminal.write`. cols/rows 는 PROTOCOL 범위(20~500 × 5~300)로 clamp.
  - `connectionStateProvider` 를 `ref.listenManual` — `connected` 로 바뀔 때마다 attach 재호출(재접속 규칙 3: term 은 replay 되지 않는다). 끊기면 `데몬 연결 끊김 — 재접속되면 화면을 다시 받습니다` 배너.
  - `RpcClient.notifications` 직접 구독 → `term{memberId == 내 멤버}` 의 `data` 를 `terminal.write`. 다른 멤버 것은 무시.
  - `terminal.onOutput` → `member.type{memberId, data}`; `terminal.onResize` → `member.resize{memberId, cols, rows}`(attach 된 뒤에만). 결과가 필요 없는 호출은 실패를 삼킨다(끊김 중 타이핑 등).
  - dispose(탭 숨김) · 멤버 교체(`didUpdateWidget`) → `member.detach{이전 memberId}`. 멤버 교체 시 Terminal 을 새로 만든다(이전 화면이 섞이지 않게). 늦게 도착한 attach 응답은 세대 번호로 버리고 그 자리에서 detach.
  - attach 실패 → 배너 + "다시 붙이기" 버튼. `describeAttachError(RpcException)`: `-32003` → "이 데몬 세션에서 스폰되지 않은 멤버라 터미널을 붙일 수 없습니다 (재출근/재고용 필요)", `-32002` 멤버 없음, `-32602` 크기 범위, `-1` 연결 안 됨, `-2` 타임아웃. 종료/오류 멤버는 안내 배너("퇴근한 멤버 — 마지막 화면").
  - 배너는 `Stack` 으로 터미널 **위에** 띄운다(아래 함정).
- `lib/panel/labels.dart` — `eventKindLabel`(읽는 중/편집/실행/생각 중/허가 대기/질문/위임/보고/완료/오류/응답), `eventKindColor`, `memberStatusLabel`(출근 중/대기/작업 중/허가 대기/답변 대기/퇴근/오류), `derivedStatusLabel`(한가함/보고 대기), `memberStatusColor`, `formatClock`(HH:MM 로컬), `formatClockSeconds`, `formatElapsed`(방금/N분/N시간 M분/N일 H시간), `eventDetailLine`(tool + path|cmd|summary|text 첫 줄, cmd/path 와 summary 가 둘 다 있으면 `— summary` 덧붙임, 200자 자름), `panelMonoFamily`/`panelMonoFallback`.
- `test/panel/panel_fake_daemon.dart` — T11 `FakeDaemon` 과 같은 봉투/hello/replay 에 `handlers[method]` 맵을 얹은 가짜 데몬(attach/detach/type/resize/events.query 를 테스트마다 바꿔 끼움, `FakeRpcError` 로 에러 응답, `requests`/`paramsOf`/`countOf`, `push`/`emitEvent`/`closeAll`). T11 의 것은 메서드 분기가 클로저 안에 고정돼 있어 재사용 대신 확장판을 뒀다(`sampleEvent` 는 T11 것을 그대로 import).
- `test/panel/panel_harness.dart` — `startDaemon()`(팀 1 · 멤버 m1 `하루` working / m2 `모시` codex idle · 기본 핸들러), `panelOverrides(daemon)`(실제 `RpcClient`/`OfficeNotifier` 를 가짜 데몬에 붙임, backoff 20~50ms), `pumpPanel(tester, daemon, child, {overrides})`(380×600 안에 띄움, 같은 테스트 안에서는 같은 GlobalKey → 재pump 가 didUpdateWidget 경로), `pumpUntil`/`pumpUntilConnected`.
- 테스트 15건: `log_tab_test.dart` 4, `terminal_tab_test.dart` 7, `right_panel_test.dart` 4.

## 검증

```
$ flutter --version
Flutter 3.41.7 • channel stable · Dart 3.11.5

$ cd dev/app && flutter analyze
Analyzing app...
No issues found! (ran in 2.9s)

$ flutter test test/panel/          (3회 연속)
00:01 +15: All tests passed!
00:01 +15: All tests passed!
00:02 +15: All tests passed!

$ flutter test                      (전체 — T11·T12·T14 포함)
00:08 +87 ~1: All tests passed!
```

테스트가 확인하는 것(전부 가짜 데몬에 실제 소켓으로 붙어서):
- log_tab: 라이브 이벤트 3건(m2 것 1건은 제외) → `LogRow` 3개, `읽는 중`/`실행`/`허가 대기`, 상세 `Read lib/main.dart` / `Bash flutter test — 테스트 실행` / `Bash rm -rf build`, seq 순서 [11,12,13] / **백필**: `events.query{memberId:'m1', limit:200}` 호출, 백필 [3,5,11] ∪ 라이브 [11,12] → 행 [3,5,11,12](11 중복 제거), 상태 층 링에는 라이브만 / **재접속**: `closeAll` → 재접속 후 events.query 2회째, 끊긴 동안의 `reporting{끝났습니다}` 가 행으로, `loadedCount == 2` / events.query 실패(-32000 db locked) → 배너 원인, 라이브 행은 그대로.
- terminal_tab: attach 파라미터 `{memberId:'m1', cols:int, rows:int}` 가 범위 안이고 **TerminalView 가 레이아웃한 실제 viewWidth/viewHeight 와 같다**, `screen` 이 버퍼에 / `term` 알림 중 m1 것만 버퍼에(한글·이모지 그대로), m2 것은 없음 / `textInput('ls -la')`+Enter → `member.type` 2회 `{memberId:'m1', data:'ls -la'}`, `'\r'` / 자식 교체(dispose) → `member.detach{m1}` / attach -32003 → "스폰되지 않은 멤버" 배너 + "다시 붙이기" → 데몬 회복 후 버튼으로 재attach(`BACK` 화면) / 재접속 → "연결 끊김" 배너 → attach 2회째 → 새 화면 `SCREEN-AGAIN`, 배너 사라짐 / 멤버 m1→m2 교체 → detach(m1)+attach(m2), 새 버퍼에 `SCREEN:m1` 없음.
- right_panel: null → "캐릭터를 선택하세요"·TabBar 없음 / 헤더 `하루` · `claude` · `작업 중` · `pixel · D:/proj/pixel` · `출근 1시간 30분`, 탭 4개, 기본 로그 탭(TerminalView 없음), `member.status{idle, free}` → `한가함`, 모르는 id → `멤버 정보 없음` / 터미널 탭 탭하면 attach 1회 → 로그 탭으로 돌아오면 detach 1회·TerminalView 사라짐 / 보고서 자리: 백필 `text` 본문 → 라이브 `text` 로 교체, `#12`.

실제 데몬에 붙인 화면 캡처는 `main.dart` 배선(통합 단계) 뒤에 — 이 태스크는 `lib/main.dart` 를 건드리지 않는다.

## 발견한 함정

- **`ref` 는 dispose 에서 못 쓴다**: `_TerminalTabState` 가 `ref.read(rpcClientProvider)` 를 getter 로 두고 dispose 의 detach 에서 불렀더니 Riverpod 이 `Using "ref" when a widget is about to or has been unmounted is unsafe` 로 throw. 그 예외가 트리 unmount 를 반쯤 실패시키고, 테스트 하네스의 GlobalKey 가 다음 테스트로 이어져 이후 테스트 전부가 `_activateRecursively` 단언으로 죽었다. → `initState` 에서 client 를 필드에 잡아 둔다. 하네스도 GlobalKey 를 테스트마다 새로(`addTearDown` 으로 폐기).
- **배너가 터미널 rows 를 바꾼다**: 배너를 `Column` 으로 터미널 위에 쌓았더니, 연결 전 "연결 안 됨" 배너(TextButton 최소 높이 48 포함 ≈ 4행) → 연결되면 attach(rows 33) → 배너 제거 → 터미널이 37행으로 커져 `member.resize` 가 뒤따른다. 동작은 하지만 attach 크기와 실제 크기가 어긋나는 프레임이 생기고 테스트(attach rows == viewHeight)가 잡아냈다. → `Stack` 으로 배너를 터미널 위에 띄워 터미널 크기를 배너와 무관하게.
- **가짜 데몬의 `StreamSink is closed`**: `stop()` 의 `HttpServer.close(force:true)` 뒤에도 `WebSocket.readyState` 는 `open` 인 채 sink 만 닫혀 있어, 핸들러를 `await` 한 뒤 늦게 나가는 응답이 throw → 테스트 실패로 잡힘. `send` 에서 `StateError` 를 삼킨다.
- **`runAsync` 안에서는 `pump()` 만으로 시간이 흐르지 않는다**: 탭 전환 애니메이션이 끝나지 않아 `TabBarView` 가 터미널 페이지를 만들지 않았다 → `pumpAndSettle()` 을 끼워 넣는다.
- **`Override` 타입**은 `flutter_riverpod/flutter_riverpod.dart` 가 아니라 `flutter_riverpod/misc.dart` 에서 export 된다.
- Riverpod 3 `Notifier.build()` 안에서 `ref.watch(connectionStateProvider)` 를 쓰면 연결 상태가 바뀔 때마다 Notifier 가 새로 만들어져 진행 중인 `events.query` 결과가 버려진다 → `ref.listen` 으로.
- `TabBarView` 는 보이지 않는 페이지를 내린다(PageView) → 터미널 탭이 숨겨지면 dispose → detach, 다시 보이면 initState → attach. 별도의 "보임" 추적 없이 이 생명주기만으로 attach/detach 가 맞아떨어진다. 대신 탭을 오갈 때마다 attach 왕복이 생긴다(스크롤백도 리셋) — 아래 남은 것.

## 결정

- 재접속 replay 이벤트는 로그에 살리지 않는다(T11 남은 것) — D-21 대로 `events.query` 백필로 채우면 replay 여부와 무관하게 같은 결과이고, 상태 층 규칙(replay 무시)을 그대로 둘 수 있다. 새 결정 번호 없음.
- 백필은 멤버당 `limit: 200` 한 번(페이지 없음). 로그 탭이 최근 200건 + 라이브면 M1 에는 충분. `beforeSeq` 페이징은 스크롤 상단 도달 시 붙이면 되게 `MemberBackfill.events` 를 seq 맵으로 두었다.
- 백필/로그 프로바이더는 `lib/state` 가 아니라 `lib/panel/member_log.dart` 에 둔다(표시 전용, 상태 파생에 쓰지 않음 — T11 함정 항목대로).

## 남은 것

- `lib/main.dart` 배선: 지금 main.dart 의 자리표시 `RightPanel()` 을 `panel/right_panel.dart` 의 `RightPanel(memberId: 선택 멤버)` 로 교체(선택 멤버 프로바이더는 T12 가 정의). 통합 단계에서.
- 실제 데몬에 붙인 캡처(`img/T13-*.png`) — 배선 뒤.
- 탭을 오갈 때 터미널 스크롤백이 리셋된다(attach 가 현재 화면만 준다). 유지하고 싶으면 `TabBarView` 대신 `IndexedStack` + 보임 추적으로 attach/detach 하되 Terminal 인스턴스를 살려 두는 방식으로.
- 로그 스크롤 상단 도달 시 `beforeSeq` 페이징.
- 변경 파일 탭(자리만) · 보고서 탭의 task/report 연동(T18).
