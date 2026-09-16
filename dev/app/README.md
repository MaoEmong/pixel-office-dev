# pixel-office 데스크탑 앱 (Flutter, Windows)

데몬(`dev/daemon`)에 WebSocket 으로 붙어 사무실을 그리는 클라이언트. T11 시점에는 골격만 있다 — RPC 클라이언트·상태 모델·레이아웃 자리.
와이어 계약은 `dev/daemon/PROTOCOL.md` 가 유일한 기준이다.

## 실행

```
cd dev/app
flutter pub get
flutter run -d windows          # 개발 실행
flutter build windows --release # build\windows\x64\runner\Release\pixel_office.exe
flutter analyze && flutter test # 검증
```

데몬이 먼저 떠 있어야 한다(`cd dev/daemon && npm start`). 없으면 앱은 회색 오버레이 + "데몬 연결 안 됨" 을 보이며 1→2→4→5초 간격으로 계속 재접속을 시도한다("데몬 시작" 버튼은 T14).

## 엔진(Claude / Codex)

앱에는 **엔진별 분기가 없다.** `member.engine` 은 책상 배지(`Claude` / `Codex`)와 패널 헤더 칩에만 쓰이고, 이벤트·pending·터미널·지시 경로는
두 엔진이 같다(엔진 차이는 전부 데몬이 흡수한다 — `dev/daemon/PROTOCOL.md` §"엔진별 동작 차이"). T23 실기에서 같은 팀의 Claude 팀원과
Codex 팀원이 각자 책상·배지·터미널 탭(실제 Codex TUI)으로 보이는 것을 확인했다(`docs/worklog/T23-MixedTeam.md`).

## 팀·팀장 (T24 / T24b)

팀을 만들면 **팀장이 자동으로 출근한다**(`team.create` → `{team, leader}`). 사용자 지시는 **팀장에게만** 간다 — 팀원에게
직접 지시하면 데몬이 `-32004 팀장에게만 지시할 수 있습니다 (leader: <이름>)` 로 막는다(01-설계문서 §4).

- **"살아 있는 팀장" 판정**: `rank == 'leader'` 이고 status 가 `exited`/`error` 가 아닌 첫 멤버. `Team.leaderId` 는 팀장이
  나가도 남으므로 그것으로 판정하면 안 된다(데몬 `Store.liveLeader` 와 같은 규칙 — `liveLeadersProvider` / `liveLeaderProvider(teamId)`).
- **지시 바**(`lib/command/command_bar.dart`): 팀장이 있으면 대상이 팀장으로 고정된다(사무실에서 팀원을 클릭해도). 같은 팀의
  팀원 항목은 비활성 + 툴팁 "팀장에게만 지시할 수 있어요", 팀장 없는 팀의 멤버는 그대로 고를 수 있다. 팀장이 퇴근하면 게이트가
  열려 팀원에게 직접 지시된다. `-32004` 가 오면 데몬 문구를 배지 자리에 그대로 띄우고 `data.leaderId` 로 대상을 되돌린다 —
  `force`(콘솔 `say!`)는 앱에서 쓰지 않는다.
- **상단 바**(`lib/topbar/top_bar.dart`): 출근 다이얼로그의 "팀장 이름"(기본 `팀장`)·"팀장 엔진", 새 팀이면 팀원 이름은 선택
  (비우면 팀장만 출근한 빈 사무실). 팀을 만들면 응답의 `leader.id` 를 바로 선택한다. 선택 멤버가 팀장이면 이름 앞에 왕관 배지.
- **사무실 캔버스**(`lib/office/`): 팀장 책상에는 엔진 배지 왼쪽에 "팀장" 배지, 캐릭터에는 금색 링(`OfficeColors.leaderMark`).
  파생 상태 `waiting_reports`(팀장이 위임하고 보고를 기다리는 중)는 모니터·말풍선에 "📨 보고 대기".
- **선택 멤버**는 `lib/state/selection.dart`(`selectedMemberIdProvider`). 멤버 행이 사라지면 선택이 자동 해제된다
  (퇴근은 행이 남으므로 유지).

## 구조

```
lib/
  main.dart                 MaterialApp(dark) + 레이아웃 자리: TopBar / OfficeArea(T12) / RightPanel 탭(T13) / CommandBar(T14) / DisconnectedOverlay
  rpc/
    daemon_info.dart        %LOCALAPPDATA%\pixel-office\daemon.json 읽기 (wsPort, token, pid, version …)
    rpc_client.dart         JSON-RPC 2.0 over WebSocket: connect / hello / call / 알림 스트림 / lastSeq / 자동 재접속
  model/
    team.dart member.dart office_event.dart pending.dart task.dart snapshot.dart   (store/types.ts 와 1:1, fromJson)
    models.dart             배럴
  state/
    office_state.dart       Riverpod 프로바이더 (아래 표)
    selection.dart          selectedMemberIdProvider (사무실·패널·지시 바가 공유하는 선택 멤버, T24b)
test/
  fake_daemon.dart          dart:io HttpServer + WebSocketTransformer 로 만든 가짜 데몬(hello/replay/echo/fail/hang/push)
  rpc_client_test.dart      상관·에러 매핑·replay 중복 제거·재접속(since)·backoff
  model_test.dart           PROTOCOL/설계문서 예시 JSON 파싱
  office_state_test.dart    스냅샷 → 맵, member.status, event → 링버퍼/pending 파생, 재접속
windows/runner/main.cpp     창 제목 "픽셀 오피스"
```

의존성: `flutter_riverpod`(상태), `web_socket_channel`(WS), `xterm`(T13 터미널 탭용, 지금은 미사용).

## daemon.json 은 어디서 읽나

`DaemonInfo.defaultPath()`:
1. 환경변수 `PIXEL_DATA_DIR` 이 있으면 `${PIXEL_DATA_DIR}\daemon.json`
2. 아니면 `%LOCALAPPDATA%\pixel-office\daemon.json` (`Platform.environment['LOCALAPPDATA']`)

데몬은 기동마다 token 을 새로 만들고 정상 종료 시 파일을 지우므로, `DaemonConnector.fromDaemonJson()` 은 **재접속 시도마다** 파일을 다시 읽는다. 파일이 없으면 그 시도는 "daemon.json 없음(데몬 미기동)" 으로 실패 처리되고 backoff 후 다시 본다.

## RPC 클라이언트 동작 (`lib/rpc/rpc_client.dart`)

- **봉투**: 요청 `{jsonrpc, id, method, params}` — id 는 1부터 증가하는 정수. 응답은 id 로 상관해 `Completer` 를 푼다. `error` 가 오면 `RpcException(code, message, data)` 로 throw. 응답이 `callTimeout`(기본 15초) 안에 안 오면 code `-2`, 도중에 소켓이 닫히면 code `-1`(대기 중이던 호출 전부).
- **연결 상태**: `disconnected → connecting → connected`. 소켓이 열려도 `hello` 가 성공해야 `connected`. `stateStream` 은 값이 바뀔 때만 흘린다.
- **hello**: `hello{token, since?, client:{name:'pixel-office', version}}`. 결과의 `snapshot.seq` 는 **응답 핸들러 안에서 동기적으로** `lastSeq` 에 반영한다 — 바로 뒤에 오는 replay `event` 보다 먼저.
- **lastSeq / 중복 제거**: `lastSeq = max(snapshot.seq, 통과한 event.seq)`. `event` 알림 중 `seq <= lastSeq` 인 것은 `events` 스트림으로 내보내지 않는다(재접속 규칙 2). 원본 알림 전부는 `notifications` 로 볼 수 있다(`term`, `member.status`, `daemon.notice`, `snapshot` 포함).
- **자동 재접속**: `start(urlProvider, tokenProvider)` 루프. 끊기면 backoff(1s → 2s → 4s → 5s 상한) 후 `connect` + `hello`. 한 번이라도 동기화된 뒤라면 `since = lastSeq` 를 넣는다. 성공한 hello 마다 `hellos` 스트림으로 `HelloResult` 가 나가므로 상태 층이 스냅샷을 다시 적용한다. `retryNow()` 로 대기를 건너뛸 수 있다("다시 연결" 버튼). 실패 횟수는 `reconnectAttempts` / `attemptStream`(실패마다 증가, 성공 시 0 — daemon.json 이 없어 소켓을 열지 못한 시도도 포함), 원인은 `lastError`.
- **term 은 replay 되지 않는다**(규칙 3). 터미널 탭(T13)은 재접속 후 `member.attach` 를 다시 불러 화면을 받아야 한다.

## 상태 층 (`lib/state/office_state.dart`)

`officeProvider` 하나가 `OfficeState` 전체를 들고, 나머지는 `select` 로 잘라 낸 파생 프로바이더다.

| 프로바이더 | 타입 | 내용 |
|---|---|---|
| `rpcClientProvider` | `RpcClient` | 앱 전체 하나. 테스트에서 override. |
| `daemonConnectorProvider` | `DaemonConnector` | url/token 공급자. 기본 daemon.json. |
| `officeProvider` | `OfficeState` (`OfficeNotifier`) | build 시 클라이언트 `start()`. `instruct`/`respondApproval`/`respondQuestion`/`applyEvent` 등 편의 메서드. |
| `connectionStateProvider` | `RpcConnectionState` | 상단 바·오버레이 |
| `daemonVersionProvider` / `daemonPidProvider` | `String?` / `int?` | hello 결과 |
| `reconnectAttemptsProvider` / `lastSeqProvider` | `int` | |
| `teamsProvider` | `Map<String, Team>` | 스냅샷 |
| `membersProvider` | `Map<String, Member>` | 스냅샷 + `member.status`(행 삽입 포함) |
| `memberProvider(id)` / `memberStatusProvider(id)` / `derivedStatusProvider(id)` | family | 캐릭터 포즈용 |
| `membersOfTeamProvider(teamId)` | `List<Member>` | 팀 탭 |
| `liveLeadersProvider` / `liveLeaderProvider(teamId)` | `Map<String, Member>` / `Member?` | 살아 있는 팀장(rank leader ∧ status ∉ {exited,error}) — 지시 게이트(T24b) |
| `openPendingProvider` | `Map<String, Pending>` | 스냅샷 + `waiting_approval`/`asking` 이벤트로 추가, `error{pendingId}`·멤버가 waiting 을 벗어나면 제거 |
| `openTasksProvider` | `Map<int, Task>` | 스냅샷 + `instruct()` 로 추가, `reporting{taskId}`·멤버 exited/error 로 제거 |
| `globalEventsProvider` | `List<OfficeEvent>` | 링버퍼 2000 (오래된 → 최신) |
| `memberEventsProvider(id)` | `List<OfficeEvent>` | 멤버별 링버퍼 2000 |
| `latestEventProvider(id)` | `OfficeEvent?` | 말풍선 |
| `noticesProvider` | `List<DaemonNotice>` | `daemon.notice` 최근 50건 |

재접속 시 스냅샷은 teams/members/pending/tasks 를 **교체**하고, 이벤트 링버퍼·말풍선은 유지한다.
