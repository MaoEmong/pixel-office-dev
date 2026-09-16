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

## 직무 체계 rev 3 — 부서 · 부장 · 팀 (T37, D-32)

```
사용자 ──부서 만들기(부장 임명)──▶ 부장(head) ──create_team──▶ 팀장(lead) ──hire──▶ 팀원(member)
   ◀──── 보고·ask_user·허가 카드 ────┘        ◀── 보고·ask_parent ──┘      ◀── 보고·ask_parent ──┘
```

**사용자가 만드는 것은 부서뿐이다.** 팀·팀원은 부장·팀장이 만든다(앱에는 출근 버튼이 없다 — `member.clockIn`/`team.create` 는
`force:true` 뒤의 콘솔 전용 디버그 경로다, D-34).

- **상단 탭 = 부서**(`lib/topbar/selected_department.dart`: `selectedDepartmentIdProvider` / `activeDepartmentIdProvider`).
  "부서 만들기" 다이얼로그(이름 · 작업 폴더 cwd · 부장 엔진 · 부장 이름, 기본 `부장`) → `department.create` →
  응답의 `head` 를 바로 선택한다. 탭 오른쪽 `⋮` → "부서 삭제" → 확인 → `department.delete`(하위 트리를 잎부터 정리).
- **퇴근은 비상용으로만** 남겼다: 선택 멤버 옆 작은 버튼 → 확인 다이얼로그(경고 "비상용: 부장/팀장 퇴근 시 하위 전원이 정리됩니다")
  → `member.clockOut`.
- **지시 바**(`lib/command/command_bar.dart`): 대상이 **그 부서의 살아 있는 부장 하나로 고정**된다. 드롭다운에는 부장만 들어가고,
  살아 있는 부장이 없으면 비활성 + 안내(`commandBarNoHeadHint`). `-32004 부장에게만 지시할 수 있습니다 (head: <이름>)` 가
  오면 데몬 문구를 그대로 띄우고 `data.headId` 로 대상을 되돌린다 — `force` 는 앱에서 쓰지 않는다.
- **"살아 있는 부장/팀장" 판정**은 `departments.headId`/`teams.leaderId` 가 아니라 멤버 행의 `rank` + status 로 한다
  (데몬 `Store.liveHead`/`liveLead` 와 같은 규칙 — `liveHeadProvider(departmentId)` / `liveLeadProvider(teamId)`).
- **사무실 배치**(`lib/office/`): **부장 책상이 맨 윗줄 가운데**, 그 아래 팀마다 클러스터(제목 줄 "팀 t1 · 3명" + 팀장 책상 먼저,
  팀원 뒤). 팀 없는 멤버는 "미배정" 클러스터(정상 트리에는 없다). 배치 계획은 `OfficeScene.plan`(`OfficeDeskPlan`/`DeskCluster`)
  이고 `OfficeLayout` 이 그것으로 책상·클러스터 상자를 계산한다. 직급 배지는 "♛ 부장"(금색 `OfficeColors.headMark`) ·
  "★ 팀장"(은색 `leadMark`), 캐릭터에는 같은 색 링. 엔진 배지는 그대로.
- **내 책상**에는 **사용자 몫만** 선다: 허가는 직급과 무관하게 전부(셸 허가는 안전 문제 — D-32), 질문은 부장의 `ask_user`
  (와 턴을 붙잡는 TUI `AskUserQuestion`). 판정은 `Pending.goesToUser(rank:)` 한 곳이다.
- **`ask_parent`(T35)** 질문(payload `{source:'ask_parent', question, options, from, to}`)은 상사에게 간 질문이라
  사용자 카드·줄에 나오지 않는다. 대신 그 멤버는 **직속 상사 책상 옆으로 걸어가** "❓ 상사에게 질문" 말풍선을 띄우고,
  질문한 멤버의 패널에는 안내 카드 `AskParentCard`("↑ 팀장/부장에게 질문 중")가 뜬다. 상사가 멈춰 있을 때를 위해
  "대신 답하기" 버튼으로 사용자가 `question.respond` 를 대신 보낼 수 있다(월권 경로).
- **오른쪽 패널 헤더**: `직급 · 상사: 이름(직급) · 직속 부하 N명` 한 줄(`panelTreeLine`). 부장이 아니면
  "지시는 부장에게 — 이 멤버는 상사가 일을 줍니다 (터미널 직접 입력은 가능)" 안내가 붙는다. 탭(로그·터미널·지시문·보고서)은 그대로다.
- **선택 멤버**는 `lib/state/selection.dart`(`selectedMemberIdProvider`). 멤버 행이 사라지면 선택이 자동 해제된다
  (퇴근은 행이 남으므로 유지).

### T29 결함 수정(T37)

- **③ 셸 대기가 안 보이던 것**: `running` 이벤트에 `detail.waiting`(예 `shell-lock`) 이 있으면 모니터·말풍선이 `cmd` 대신
  `summary` 를 "⏳" 를 붙여 보여 준다 — "⏳ 셸 대기 중 (락: 작가)".
- **④ 보고 방문이 끊기던 것**: 보고 직후의 `running{tool:'mcp__team__*'}` 은 보고에 딸린 뒷정리이므로 6초 방문을
  취소하지 않는다(`OfficeMotion.cancelsVisit`). 보통 도구(Bash 등)는 예전대로 취소한다.

## 구조

```
lib/
  main.dart                 MaterialApp(dark) + 레이아웃 자리: TopBar / OfficeArea(T12) / RightPanel 탭(T13) / CommandBar(T14) / DisconnectedOverlay
  rpc/
    daemon_info.dart        %LOCALAPPDATA%\pixel-office\daemon.json 읽기 (wsPort, token, pid, version …)
    rpc_client.dart         JSON-RPC 2.0 over WebSocket: connect / hello / call / 알림 스트림 / lastSeq / 자동 재접속
  model/
    department.dart team.dart member.dart office_event.dart pending.dart task.dart snapshot.dart   (store/types.ts 와 1:1, fromJson)
    models.dart             배럴
  state/
    office_state.dart       Riverpod 프로바이더 (아래 표)
    selection.dart          selectedMemberIdProvider (사무실·패널·지시 바가 공유하는 선택 멤버, T24b)
  topbar/
    selected_department.dart  상단 부서 탭 상태(T37, T24 의 selected_team.dart 를 대체)
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
| `officeProvider` | `OfficeState` (`OfficeNotifier`) | build 시 클라이언트 `start()`. `instruct`/`createDepartment`/`deleteDepartment`/`queryEvents`/`respondApproval`/`respondQuestion`/`applyEvent` 등 편의 메서드. |
| `connectionStateProvider` | `RpcConnectionState` | 상단 바·오버레이 |
| `daemonVersionProvider` / `daemonPidProvider` | `String?` / `int?` | hello 결과 |
| `reconnectAttemptsProvider` / `lastSeqProvider` | `int` | |
| `departmentsProvider` / `departmentProvider(id)` | `Map<String, Department>` / `Department?` | 스냅샷 `departments[]` — 상단 탭(T37) |
| `teamsProvider` / `teamsOfDepartmentProvider(departmentId)` | `Map<String, Team>` / `List<Team>` | 스냅샷. 부서별은 createdAt 순 |
| `membersProvider` | `Map<String, Member>` | 스냅샷 + `member.status`(행 삽입 포함) |
| `memberProvider(id)` / `memberStatusProvider(id)` / `derivedStatusProvider(id)` | family | 캐릭터 포즈용 |
| `membersOfTeamProvider(teamId)` / `membersOfDepartmentProvider(id)` | `List<Member>` | 클러스터·부서 화면 |
| `liveHeadsProvider` / `liveHeadProvider(departmentId)` | `Map<String, Member>` / `Member?` | 살아 있는 부장(rank head ∧ status ∉ {exited,error}) — **지시 게이트**(T37) |
| `liveLeadsProvider` / `liveLeadProvider(teamId)` | `Map<String, Member>` / `Member?` | 살아 있는 팀장(rank lead) |
| `childrenProvider(memberId)` / `parentProvider(memberId)` | `List<Member>` / `Member?` | 트리(`parentId`) — 패널 헤더의 상사·직속 부하 |
| `openPendingProvider` | `Map<String, Pending>` | 스냅샷 + `waiting_approval`/`asking` 이벤트로 추가, `error{pendingId}`·멤버가 waiting 을 벗어나면 제거 |
| `openTasksProvider` | `Map<int, Task>` | 스냅샷 + `instruct()` 로 추가, `reporting{taskId}`·멤버 exited/error 로 제거 |
| `globalEventsProvider` | `List<OfficeEvent>` | 링버퍼 2000 (오래된 → 최신) |
| `memberEventsProvider(id)` | `List<OfficeEvent>` | 멤버별 링버퍼 2000 |
| `latestEventProvider(id)` | `OfficeEvent?` | 말풍선 |
| `noticesProvider` | `List<DaemonNotice>` | `daemon.notice` 최근 50건 |

재접속 시 스냅샷은 departments/teams/members/pending/tasks 를 **교체**하고, 이벤트 링버퍼·말풍선은 유지한다.

`queryEvents({departmentId, memberId, beforeSeq, limit})` 는 `events.query` 래퍼다. **멤버 로그 백필은 `departmentId` 를
보내지 않는다** — T34 마이그레이션 이전 이벤트 행은 `department_id` 가 `''` 이라 부서로 거르면 옛 기록이 통째로 사라진다.
