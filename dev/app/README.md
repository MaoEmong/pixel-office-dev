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
| `openPendingProvider` | `Map<String, Pending>` | 스냅샷 + `waiting_approval`/`asking` 이벤트로 추가, `error{pendingId}`·멤버가 waiting 을 벗어나면 제거 |
| `openTasksProvider` | `Map<int, Task>` | 스냅샷 + `instruct()` 로 추가, `reporting{taskId}`·멤버 exited/error 로 제거 |
| `globalEventsProvider` | `List<OfficeEvent>` | 링버퍼 2000 (오래된 → 최신) |
| `memberEventsProvider(id)` | `List<OfficeEvent>` | 멤버별 링버퍼 2000 |
| `latestEventProvider(id)` | `OfficeEvent?` | 말풍선 |
| `noticesProvider` | `List<DaemonNotice>` | `daemon.notice` 최근 50건 |

재접속 시 스냅샷은 teams/members/pending/tasks 를 **교체**하고, 이벤트 링버퍼·말풍선은 유지한다.
