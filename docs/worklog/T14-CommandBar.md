# T14 — 지시 바 · 상단 바 · 데몬 상태 (출근/퇴근 · 데몬 시작 · 알림 배너)

- 날짜: 2026-09-15
- 마일스톤: M1
- 관련 설계: 01-설계문서.md §구성 요소 3 "Flutter 데스크탑"(지시 바, 상단 팀 탭·데몬 상태·출근, 퇴근, "데몬 시작" detached 스폰), `dev/daemon/PROTOCOL.md`(`team.create`, `member.clockIn/clockOut/instruct/interrupt`, `daemon.notice`, hello 결과의 `daemon{version,pid}`)
- 커밋: (미커밋 — 이 태스크는 커밋하지 않음)

## 목표

T11 골격의 자리표시자(상단 바 텍스트, 비활성 지시 바)를 실제 조작 UI 로 바꾼다. 끝나면 사용자가 앱에서 (1) 대상 멤버를 골라 여러 줄 지시를 Enter 로 보내고 Ctrl+C(중단)를 걸 수 있고, (2) 상단 바에서 팀 탭을 고르고 데몬 버전·pid·멤버/대기 개수를 보며 **출근**(팀이 없으면 팀 만들기까지)·**퇴근**을 실행할 수 있고, (3) 데몬이 꺼져 있으면 "데몬 시작" 버튼으로 `npm start` 를 분리 프로세스로 띄우고, (4) `daemon.notice` 를 오른쪽 아래 토스트로 본다. T12(사무실)·T13(패널)과 병렬 작업이라 `lib/main.dart`·`lib/state/**` 는 건드리지 않고 `lib/command/**`, `lib/topbar/**` 안에서만 만들었다 — main.dart 연결은 통합 시점에.

## 한 것

- `dev/app/lib/command/command_bar.dart` — `CommandBar({required String? selectedMemberId})` (ConsumerStatefulWidget).
  - 대상 드롭다운(`Key('commandBar.target')`): `membersProvider` 를 이름순으로, `exited`/`error` 항목은 `enabled:false` + 회색 + 상태 표기. 기본값 = `selectedMemberId`, 사무실/패널에서 선택이 바뀌면(`didUpdateWidget`) 따라간다.
  - 입력(`Key('commandBar.input')`): `minLines 1 / maxLines 4` 멀티라인. `FocusNode.onKeyEvent` 에서 Enter/numpadEnter 를 가로채 **Enter = 전송, Shift+Enter = 커서 위치에 `\n` 삽입**(둘 다 `handled` 로 기본 개행 차단, `KeyRepeatEvent` 로는 전송 안 함). 힌트 `commandBarHint(name)` = `'<이름>에게 지시 (Enter 전송, Shift+Enter 줄바꿈)'`; 끊김 → `'데몬 연결 안 됨'`, 대상 없음 → `'대상을 고르세요'`, 퇴근 멤버 → `'<이름> 은(는) 퇴근했습니다'`.
  - 전송: 공백만이면 무시. `OfficeNotifier.instruct(memberId, text)`(→ `member.instruct`, 로컬 queued task 선반영) → 입력 비움 → `'#<taskId> 전송됨'` 배지(`Key('commandBar.badge')`) 를 `commandBarBadgeDuration`(3초) 표시 → 포커스 복귀. 여러 줄은 개행 그대로 보낸다(bracketed paste 는 데몬 InputQueue 몫).
  - **중단**(`Key('commandBar.interrupt')`) → `member.interrupt{memberId}`. 전송 아이콘 버튼(`Key('commandBar.send')`).
  - 비활성 조건: `connectionStateProvider != connected` ∨ 대상 없음 ∨ 대상 `status.isGone` ∨ RPC 진행 중. RPC 오류는 `RpcException.message` 를 빨간 글씨(`Key('commandBar.error')`)로.
- `dev/app/lib/topbar/selected_team.dart` — `selectedTeamIdProvider`(`NotifierProvider<SelectedTeamId, String?>`, `.notifier.select(id)`) = 사용자가 탭에서 고른 팀. `activeTeamIdProvider`(`Provider<String?>`) = 고른 팀이 `teamsProvider` 에 있으면 그것, 아니면 첫 팀, 팀 없으면 null — 사무실/패널이 "현재 팀" 으로 읽을 것. `top_bar.dart` 가 `export` 한다.
- `dev/app/lib/topbar/top_bar.dart` — `TopBar({String? selectedMemberId})` (ConsumerWidget, 높이 44).
  - 앱 이름 / 팀 탭(`Key('topbar.team.<id>')`, 가로 스크롤, 없으면 `'팀 없음'`) → `selectedTeamIdProvider.select` / 선택 멤버 `'<이름> [engine]'` + **퇴근** 아이콘(`Key('topbar.clockOut')`, 끊김·이미 exited 면 비활성) / 데몬 칩(`Key('topbar.daemon')`): `● 데몬 v<version> · pid <pid>`(초록) · `데몬 연결 중`(노랑) · `데몬 연결 안 됨`(빨강) / `'멤버 N · 대기 M'`(`Key('topbar.counts')`, M = `openPendingProvider.length`) / **출근** 버튼(`Key('topbar.clockIn')`, 끊기면 비활성).
  - `confirmClockOut(context, ref, member)`: AlertDialog(취소 / 퇴근 `Key('clockOut.confirm')`) → `member.clockOut{memberId}`; 오류는 SnackBar. 캐릭터 우클릭 메뉴(T12)에서도 이 함수를 그대로 부르면 된다.
  - `showClockInDialog(context, {initialTeamId})` / `ClockInDialog`: 이름(`clockIn.name`, 필수) · 엔진 SegmentedButton claude/codex(`clockIn.engine`) · 지시문(`clockIn.instructions`, 선택 → 있을 때만 `instructions` 파라미터) · 팀 드롭다운(`clockIn.team`, 기본 = `activeTeamIdProvider`) + "새 팀" 체크(`clockIn.createTeam`). **팀이 없으면 인라인 팀 만들기가 강제**: 팀 이름(`clockIn.teamName`) · 작업 폴더 cwd(`clockIn.cwd`) · 팀장 엔진(`clockIn.leaderEngine`) → `team.create{name, cwd, leaderEngine}` 의 `team.id` 로 → `member.clockIn{teamId, engine, name, instructions?}` → 그 팀을 `selectedTeamIdProvider` 에 선택 → 닫힘. 검증 실패는 필드 errorText, RPC 오류는 `'<message> (<code>)'` 로 다이얼로그 안에 남고 닫히지 않는다.
- `dev/app/lib/topbar/daemon_launcher.dart` — `findDaemonDir({startPaths})`: `Directory.current` 와 `Platform.resolvedExecutable` 의 폴더에서 각각 위로 올라가며 `dev/daemon/package.json` 을 찾는다(개발 중 `dev/app`, 릴리즈 exe `dev/app/build/windows/x64/runner/Release` 둘 다 저장소 루트에 닿음). `launchDaemon()`: Windows 는 `cmd /c start "" npm start`(새 콘솔, `ProcessStartMode.detached`, cwd = dev/daemon), 그 외 `npm start`. 못 찾으면 `DaemonLaunchException`. `DaemonStartButton({launcher})`(`Key('daemon.start')`): 띄운 뒤 `rpcClient.retryNow()` 를 즉시 + 2초 + 4초 뒤(데몬이 daemon.json 을 쓰기까지 1~2초) 호출, `'데몬 시작 중… (npm start)'` / 오류 문구(`Key('daemon.start.message')`). `DisconnectedOverlay` 의 "다시 연결" 옆에 넣을 것.
- `dev/app/lib/topbar/notices.dart` — `NoticeBanner({duration = 5s, margin})`(ConsumerStatefulWidget): `noticesProvider` 를 `ref.listen` 으로 지켜보다 마지막 `DaemonNotice` 를 `Align(bottomRight)` 로 표시(기본 여백 right 16 / bottom 72 = 지시 바 위), 새 알림이 오면 타이머 리셋, 닫기 버튼(`Key('notice.close')`). 숨겨진 동안은 `SizedBox.shrink` 라 아래 사무실 클릭을 막지 않는다. `NoticeCard(notice, onClose)`(`Key('notice.banner')`, level 별 색 info 남색/warn 갈색/error 적색). `NoticeToaster(child)` = `Stack([child, NoticeBanner()])` 편의 래퍼.
- `dev/app/test/command/fake_rpc_client.dart` — `FakeRpcClient extends RpcClient`: 소켓 없이 `emitHello(version, pid, teams, members, pending, tasks)` / `setState(...)` / `pushNotification(method, params)` 로 스트림에 직접 밀어 넣고, `call` 은 `calls`(`callList`) 에 기록 후 `responder` 결과를 돌려준다. `retryNowCount`. `overrides` = `[rpcClientProvider.overrideWithValue(this)]` — **실제 `OfficeNotifier` 가 그 위에서 그대로 돌아** 스냅샷 파싱·`instruct` 의 로컬 task 삽입까지 검증된다. (`test/fake_daemon.dart` 는 진짜 WebSocket 이라 위젯 테스트에선 `runAsync` 가 필요해 안 썼다.) `fakeTeam(id)`, `fakeMember(id, status, name, teamId, engine)`.
- `dev/app/test/command/command_bar_test.dart` 7건, `top_bar_test.dart` 7건, `notices_test.dart` 2건, `daemon_launcher_test.dart` 5건.

## 검증

```
$ cd dev/app && flutter analyze
Analyzing app...
No issues found! (ran in 3.9s)

$ flutter test test/command/           (2회 연속)
00:02 +21: All tests passed!
00:02 +21: All tests passed!
```

테스트가 확인하는 것:
- command_bar: 연결 + 멤버 2명(m1 idle `이음`, m2 exited `하루`) 스냅샷 후 힌트 `이음에게 지시 (Enter 전송, Shift+Enter 줄바꿈)` / `enterText` + Enter → `member.instruct{memberId:m1, text}` 한 번, 입력 비움, `#7 전송됨` 배지, `openTasksProvider` 에 7 번 queued 행, 3초 뒤 배지 사라짐 / Shift+Enter → RPC 없음, 텍스트 `'첫 줄\n'` 커서 4, 이어서 Enter 로 `'첫 줄\n둘째 줄'` 그대로 전송 / 공백만은 전송 안 함 / 끊김이면 입력·전송·중단 비활성 + `데몬 연결 안 됨`, 연결되면 활성, 다시 끊기면 Enter 쳐도 RPC 없음 / 대상 없음 → 비활성 + `대상을 고르세요`, 드롭다운 항목 `(m1,true),(m2,false)`, 이음 고르면 활성 / `selectedMemberId` 가 m2 로 바뀌면 따라가서 비활성 + `하루 은(는) 퇴근했습니다` / 중단 → `member.interrupt{memberId:m1}`, `-32003 double interrupt` 는 빨간 글씨.
- top_bar: 끊김 `데몬 연결 안 됨` · `멤버 0 · 대기 0` · 출근 비활성 → connecting `데몬 연결 중` → hello(v1.2.3, pid 777, 멤버 2, pending 1) `데몬 v1.2.3 · pid 777` · `멤버 2 · 대기 1` · 출근 활성 / 팀 탭: 기본 `selectedTeamId null`·`activeTeamId t1`, `haru` 클릭 → 둘 다 t2, t2 가 스냅샷에서 사라지면 active 는 t1 로 폴백(selected 는 t2 유지) / 출근: 이름 비면 `이름을 입력하세요` + RPC 없음, 이름 `이음` + codex + 지시문 → `member.clockIn{teamId:t2, engine:codex, name:이음, instructions:테스트만 담당}` 후 닫힘 / 팀 없음: `팀 없음` 라벨, 다이얼로그에 `팀이 없습니다 — 먼저 팀을 만듭니다` + 팀 드롭다운 없음, 팀 이름·cwd 비면 각각 errorText, 채우고 팀장 엔진 codex → `team.create{name:pixel, cwd, leaderEngine:codex}` → `member.clockIn{teamId:tNew, engine:claude, name:이음}` → `selectedTeamId == tNew` / RPC 오류 `-32003 team full` → 다이얼로그 유지 + `team full (-32003)` / 퇴근: `이음 [claude]` 표시, 버튼 → 확인 다이얼로그, 취소면 RPC 없음, 퇴근 확인 → `member.clockOut{memberId:m1}` / exited 멤버면 퇴근 버튼 비활성.
- notices: Stack 안 `NoticeBanner` — 숨김 상태에서 아래 위젯 탭 통과, `daemon.notice{warn}` → 배너가 오른쪽 아래(right-16, bottom-72) 에, 3초 뒤 새 알림 → 교체 + 타이머 리셋(그 뒤 3초엔 남아 있고 5.1초엔 사라짐), 닫기 버튼 즉시 숨김 / `NoticeToaster` 가 child 위에 겹침.
- daemon_launcher: 임시 폴더 `repo/dev/daemon/package.json` 을 `repo/dev/app/build/windows/x64/runner/Release` 에서 찾음 / 없으면 null + `launchDaemon` 은 `DaemonLaunchException` / 실제 저장소 `dev/app` 에서 `dev/daemon` 찾음 / `DaemonStartButton`: launcher 1회 + retryNow 즉시·2초·4초 = 3회, 안내 문구 / launcher 실패 → 오류 문구, retryNow 0회.

실제 데몬 상대 캡처는 없음 — 이 위젯들은 아직 `lib/main.dart` 에 안 붙어 있다(병렬 작업 규칙). 통합 후 T11 방식(`PrintWindow`)으로 `img/T14-*.png` 를 남길 것.

## 발견한 함정

- **`Enter` 를 `FocusNode.onKeyEvent` 에서 `handled` 로 돌려야 멀티라인 TextField 의 기본 개행이 안 들어간다.** Windows 임베더는 키 이벤트를 프레임워크가 처리하면 텍스트 입력 모델에 넘기지 않으므로 `handled` 만으로 충분했고, `KeyUpEvent` 도 `handled` 로 먹어야(안 그러면 up 이 Shortcuts 로 흘러 개행) 한다. `KeyRepeatEvent` 는 전송하지 않는다(길게 누르면 같은 지시가 여러 번 나감).
- **`DropdownButtonFormField` 의 `value` 는 Flutter 3.41 에서 `initialValue` 로 바뀌었다**(deprecated). 이름과 달리 `_DropdownButtonFormFieldState.didUpdateWidget` 이 `initialValue` 가 바뀌면 `setValue` 를 부르므로(SDK `dropdown.dart` 확인) 사무실에서 고른 멤버가 바뀌어 `_target` 이 바뀌면 드롭다운 표시도 따라온다 — `ValueKey` 재생성 불필요.
- **loose `Stack` 은 non-positioned 자식으로만 크기를 정한다.** `NoticeBanner` 가 숨겨져 `SizedBox.shrink` 일 때 Stack 에 다른 non-positioned 자식이 없으면 Stack 이 0×0 이 된다(테스트에서 사무실 자리를 `Positioned.fill` 로 넣었더니 탭이 안 잡혀서 발견). 앱에서는 `Column` 이 크기를 정하므로 문제 없지만, `NoticeBanner` 를 넣는 Stack 은 반드시 non-positioned 본문을 가져야 한다.
- **riverpod 3.3 은 `Override` 타입을 export 하지 않는다** — `FakeRpcClient.overrides` 는 타입을 안 적고 추론에 맡겼다.
- 위젯 테스트에서 스트림으로 밀어 넣은 뒤엔 `pump()` 두 번(첫 번째가 마이크로태스크 → `setState`, 두 번째가 프레임). `pumpAndSettle` 은 배지 타이머(3초) 때문에 CommandBar 쪽에선 못 쓴다.
- `HardwareKeyboard.instance.isShiftPressed` 는 테스트에서도 `sendKeyDownEvent(shiftLeft)` 로 그대로 켜진다.

## 결정

- 지시 바 대상은 v1a 규칙대로 **아무 멤버**(M4 부터 팀장만 — 그때 드롭다운을 `rank == leader` 로 거른다). 새 결정 번호 없음.
- 팀 탭 선택 상태를 `lib/state` 가 아니라 `lib/topbar/selected_team.dart` 에 둔 것은 병렬 작업 규칙(다른 폴더 수정 금지) 때문 — 통합 시 `lib/state` 로 옮겨도 되고 그대로 둬도 된다(`activeTeamIdProvider` 만 읽으면 됨).
- "데몬 시작" 은 `cmd /c start "" npm start` 새 콘솔 창(로그를 사용자가 볼 수 있게). 숨김 실행은 데몬이 자체 로그 파일을 갖게 된 뒤에.

## 남은 것

- **`lib/main.dart` 통합**(통합 담당): `OfficeShell` 에서 `TopBar(selectedMemberId: …)`, `CommandBar(selectedMemberId: …)`, `Stack` 에 `NoticeBanner()`(또는 `NoticeToaster` 로 감싸기), `DisconnectedOverlay` 에 `DaemonStartButton()`; T11 의 임시 `TopBar`/`CommandBar` 클래스 삭제. 사무실(T12)·패널(T13)은 `activeTeamIdProvider` 로 현재 팀을 읽는다.
- 통합 후 실제 데몬 상대로 출근(팀 만들기 포함)·지시·중단·퇴근·데몬 시작 왕복 캡처(`img/T14-*.png`).
- 캐릭터 우클릭 "퇴근"(T12) 은 `confirmClockOut` 재사용.
- M4: 지시 대상 팀장 고정, `member.rehire`(exited 멤버 재출근) 버튼.
