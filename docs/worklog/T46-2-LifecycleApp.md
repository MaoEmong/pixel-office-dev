# T46-2 — 수명 주기(앱 쪽)

- 날짜: 2026-09-21
- 마일스톤: M6
- 관련 설계: `docs/design/수명주기.md` §1 · §2 · §4 · §5 · "상태 · 와이어 변화" / D-47 / `docs/design/레이아웃-v2.md` 패스 2(로딩 3종)
- 커밋: `17de2b7` `3440c5c` `8e1ae04` `970c039` `80e26d5` (+ 이 문서)
- 짝: T46-1(데몬 쪽, `dev/daemon/**`) — 이 태스크는 `dev/app/**` 만 건드렸다.

## 목표

앱이 주인이 된다. 앱을 켜면 데몬이 **콘솔 창 없이** 같이 뜨고, 데몬이 죽으면 앱이 다시 띄우며,
앱을 닫으면 데몬과 AI 세션이 같이 꺼진다. 고아 프로세스(`node.exe` · `claude.exe` · `codex.exe`)를 남기지 않는다.
D-02("데몬은 앱과 분리된 상주 프로세스")의 **기본 동작을 뒤집되**, 옛 동작은 설정 하나로 되돌릴 수 있게 남긴다.

## 한 것

### 1. `lib/lifecycle/daemon_process.dart` — 데몬을 어떻게 띄우는가

- `daemonCommandFor(startScript)`: `dev/daemon/package.json` 의 `scripts.start`(= `tsx src/index.ts`)를
  **`node --import tsx src/index.ts`** 로 바꾼다. 같은 package.json 의 `test` 스크립트가 이미
  `node --import tsx` 를 쓰므로 검증된 모양이고, npm 을 끼지 않아 **프로세스가 하나**다(종료·트리 kill 이 단순).
  `node ...` 는 그대로, 모르는 모양은 `npm.cmd start`(윈도우) 로 떨어진다.
- `spawnDaemon()`: `Process.start` **기본 모드**(파이프)로 띄우고 stdout/stderr 를 `<데이터 폴더>/daemon.log` 에
  이어 쓴다. 기동 때 1MB 로 자르고(잘린 첫 줄은 버린다) 머리에 `[app] --- <시각> 앱이 데몬을 띄움: <명령> ---` 한 줄.
- `isPidAlive(pid, imageContains:)` = `tasklist /FI "PID eq N" /NH /FO CSV`,
  `killProcessTree(pid)` = `taskkill /PID N /T /F`,
  `daemonReachable()` = `daemon.json` 이 있고 **그 pid 가 살아 있다**(파일만 남은 하드 킬을 죽음으로 본다).

### 2. `lib/lifecycle/daemon_supervisor.dart` — 상태 기계

`attaching(2초) → starting → running → restarting → failed | stopped`.
스폰·생존 확인·시계·대기를 전부 주입받아 `dart:io` 없이 단위 테스트가 된다.

- 이미 도는 데몬이 있으면 붙기만 한다(콘솔에서 띄운 것·지난번 것).
- 2 + 8 = **10초** 안에 못 붙으면 `failed(startFailed)`. 떴는데 `daemon.json` 이 안 나오면 그 자식을 치우고 실패.
- 죽음 감지 두 길: 자식 `exitCode`, `socketClosed()` + `daemon.json` pid 죽음.
- 재시작 **즉시 → 2초 → 5초 → 10초, 최대 4회**. 기다리는 사이 누가 데몬을 띄웠으면 새로 안 띄우고 붙는다.
- **1분 안에 3번** 죽으면 `failed(crashLoop)` — 원인을 덮지 않는다.
- `stop({killChild})` 는 종료 경로가 부른다(이 뒤의 죽음은 재시작하지 않는다).

### 3. `lib/lifecycle/exit_flow.dart` + `lifecycle_gate.dart` — 끌 때

`AppLifecycleListener.onExitRequested` → `AppExitCoordinator`(위젯을 모른다):
계속 일하기면 즉시 통과 → 일하는 중이면 확인 한 번 → 감시자 정지 → `daemon.shutdown`
→ `정리하는 중…` 을 띄운 채 pid 가 사라질 때까지 **최대 8초** → 넘으면 `taskkill /T /F` → 종료.
`daemon.shutdown` 이 실패해도(이미 끊김) 프로세스는 치운다.
"일하는 중" 의 기준은 **범례 "작업" 칸 하나**(`workingMemberCount`) — 한가·대기·출근 중까지 세면
창을 닫을 때마다 묻게 된다.

### 4. `lib/lifecycle/app_lock.dart` — 앱은 한 번에 하나

`<데이터 폴더>/app.lock` 에 `{pid, startedAt, image}`. 두 번째 실행은 그 pid 가 **살아 있고 이미지 이름까지
같을 때만** 물러나고 `픽셀 오피스가 이미 실행 중입니다` 를 보인 뒤 끝낸다. 낡은 잠금(죽은 pid)은 빼앗는다.

### 5. 설정 · 와이어 · 화면

- **"앱을 닫아도 계속 일하기"**(상단 바 `⋮`, `app-ui.json` 의 `keepDaemonOnExit`, 기본 꺼짐) + `PIXEL_KEEP_DAEMON=1`.
  켜면 끄지도 묻지도 않고, `PIXEL_PARENT_PID` 와 `hello{parentPid}` 를 **둘 다 안 보낸다**(부모 감시 off).
  `⋮` 메뉴는 이제 부서가 없어도 열린다.
- `hello` 에 `parentPid`(§3) · `activeDepartmentId`(§5). 둘 다 null 이면 파라미터 자체가 없다.
- `daemon.notice` 에 `kind`(`parent-gone` | `recovering`) · `total` · `done`. 복구 진행은 `OfficeState.recovery`
  로 들고 있다가 `done >= total` 이거나 새 hello 가 오면 지운다. `message` 가 빈 알림은 토스트를 띄우지 않는다.
- 오버레이 6종(문구는 설계 그대로): `정리하는 중…` / `사무실을 여는 중…` /
  `데몬이 멈춰 다시 시작하는 중 · 세션을 복구합니다`(+ `복구 2 / 5`) / `데몬을 시작하지 못했습니다` /
  `데몬이 반복해서 종료됩니다` / (감시자 없음) `데몬에 연결되어 있지 않습니다`.
  실패 화면에만 `daemon.log` 마지막 8줄 + `다시 시도` + 옛 `데몬 시작`. 예외는 늘 "자세히" 접힘.
  오버레이는 **붙어 있어도** 다시 시작 중·복구 중·정리 중이면 덮는다(`overlayVisibleProvider`).
- `suspended`(잠시 닫힘): `MemberStatus`/`DerivedStatus` 추가, 회색 "퇴근" 칸 + 모니터 `(잠시 닫힘)`,
  `isGone` 이 **아니라서** 재고용 배너도 task 중단도 없다. 페인터의 "퇴근" 분기 3곳을 `isSeatEmpty` 로 모았다.

## 검증

### Process 실험 (윈도우 실측 — 이 태스크의 핵심 근거)

**① 콘솔 창은 언제 뜨는가.** 부모를 `ProcessStartMode.detached` 로 띄워 **콘솔이 없는 상태**(= Flutter GUI 앱)를
만들고, 거기서 콘솔 앱을 모드별로 띄워 자식이 `GetConsoleWindow()` / `IsWindowVisible()` 을 읽게 했다.

```
PARENT(detached):        pid=24892 consoleHwnd=0         visible=0
CHILD-normal-pipe:       pid=6716  consoleHwnd=0         visible=0   ← 기본 모드
CHILD-detached:          pid=25372 consoleHwnd=0         visible=0
CHILD-detachedWithStdio: pid=3572  consoleHwnd=0         visible=0
CHILD-inheritStdio:      pid=30668 consoleHwnd=333319058 visible=1   ← 보이는 창이 뜬다
  captured stdout/stderr: CHILD-normal-pipe stdout line | CHILD-normal-pipe stderr line
```

→ **기본 모드(파이프)면 콘솔 자체가 안 생긴다.** 로그도 받을 수 있으므로 자동 기동은 이 모드를 쓴다.
`inheritStdio` 만 피하면 된다. (옛 `데몬 시작` 버튼의 `cmd /c start "" npm start` 는 일부러 보이는 창을 띄우는
분리 실행이라 실패 화면 전용으로 남겼다.)

**② `node --import tsx` 가 되는가.** `dev/daemon` 을 cwd 로 두고 임시 `.ts` 파일 하나를 띄웠다(데몬은 안 띄웠다).

```
out: tsx-ok 42 15332 1234        ← TS 가 컴파일돼 돌고 PIXEL_PARENT_PID 가 전달됐다
err: (없음)
```

**③ 트리 kill.** 위 스크립트가 손자 `node` 를 하나 더 띄우게 한 뒤:

```
taskkill: SUCCESS: The process with PID 20424 (child process of PID 1096) has been terminated.
          SUCCESS: The process with PID 1096 (child process of PID 18296) has been terminated.
elapsed ms: 123
tasklist(자식/손자): INFO: No tasks are running which match the specified criteria.
```

→ `taskkill /PID N /T /F` 는 **손자까지** 데려가고 ~120ms. `tasklist /FI "PID eq N"` 은 ~95ms 이고 살아 있으면
`"image.exe","1234",…`, 없으면 `INFO: No tasks…` 라 파싱이 단순하다(종료 코드는 둘 다 0이라 못 쓴다).

### 테스트

```
$ flutter analyze
No issues found!

$ flutter test -j 2
00:42 +653 ~1: All tests passed!        (기준선 541 +1 → +112건)
```

| 파일 | 건수 | 보는 것 |
|---|---|---|
| `test/lifecycle/daemon_supervisor_test.dart` | 19 | 붙기 2초 · 스폰 · 스폰 실패 · daemon.json 안 나옴 · 즉시/2/5/10초 4회 · crash-loop · 1분 밖 · 중간에 붙기 · 다시 시도 · socketClosed 3종 · stop 3종 · PIXEL_PARENT_PID 유무 |
| `test/lifecycle/daemon_process_test.dart` | 16 | 명령 만들기 4 · 실제 package.json · daemon.log(1MB 자르기·꼬리 8줄) · pid 생존 · **node 로 진짜 띄워** 로그·환경변수·손자까지 트리 kill |
| `test/lifecycle/exit_flow_test.dart` | 15 | 안 묻는 경우 · 취소 · 닫기 · 8초 초과 → 트리 kill · shutdown 실패 · pid 없음 · 계속 일하기 · 일하는 중 세기 · 게이트 위젯 3 |
| `test/lifecycle/app_lock_test.dart` | 10 | 새로 잡기 · 살아 있는 앱 · 낡은 잠금 · pid 재사용 가드 · 깨진 파일 · release · 두 번째 창 |
| `test/lifecycle/overlay_lifecycle_test.dart` | 15 | 6가지 화면 문구 · 복구 2/5 진행 바 · 로그 8줄 · 자세히 접힘 · 덮는 조건 4 |
| `test/lifecycle/keep_daemon_test.dart` | 8 | 저장·읽기·환경변수 강제 · `⋮` 토글 3 |
| `test/lifecycle/recovery_notice_test.dart` | 9 | kind/total/done 파싱 · 모르는 값 · 상태 보관/해제 · 빈 메시지 토스트 금지 |
| `test/office/office_suspended_test.dart` | 14 | 파싱 · isGone 아님 · 범례 회색 · `(잠시 닫힘)` · 의자만 · 재고용 배너 없음 |

**실기(창을 띄워 보는 것)는 T46-3 몫이다.** 이 태스크에서는 앱도 데몬도 띄우지 않았다 —
위의 Process 실험만 임시 스크립트로 진짜 프로세스를 띄워 확인했다.

## 발견한 함정

1. **`inheritStdio` 만 콘솔 창을 만든다.** "콘솔 앱을 띄우면 창이 뜬다" 는 통념과 달리, 파이프 모드에서는
   콘솔이 아예 할당되지 않는다. 대신 **파이프를 누가 읽어야 한다** — 안 읽으면 64KB에서 데몬이 write 에 멈춘다.
   그래서 로그 쓰기는 선택이 아니라 필수다.
2. **`DerivedStatus.parse` 가 `suspended` 에서 던진다.** `Member.fromJson` 이 그 위에 있어서 `MemberStatus` 에만
   값을 추가하면 **스냅샷 파싱이 통째로 터진다.** 두 enum 을 같이 늘려야 한다.
3. **`AppLock` 안에서 `dart:io` 의 top-level `pid` 를 못 부른다** — 같은 이름의 인스턴스 필드에 가린다
   (정적 메서드인데도 "Undefined name"). 파일 맨 위에 `int get selfPid => pid;` 를 두고 쓴다.
4. **설정을 창 닫는 순간에 처음 읽으면 늦다.** `keepDaemonProvider` 는 파일을 비동기로 읽는데 종료 경로는
   즉시 값을 본다 → 늘 기본값(꺼짐)으로 보였다. `LifecycleGate.build` 가 미리 `watch` 한다.
5. **위젯 테스트에서 실제 대기를 쓰면 멈춘다.** 종료 흐름의 8초 폴링을 fake-async 존에서 돌리면
   `pumpAndSettle` 이 영영 안 끝난다(10분 타임아웃을 한 번 맞았다). 게이트 위젯 테스트는 "데몬이 이미 죽어 있다"
   로 두고, 시간이 걸리는 경로는 시계를 주입한 단위 테스트에서 본다.
6. **실패 화면은 세로로 길다.** 로그 8줄 + 버튼 둘이 800px 창에서 잘려 탭이 안 먹었다 →
   오버레이 본문을 `SingleChildScrollView` 로 감싸고 버튼을 `Wrap` 으로 바꿨다.

## 결정

- **D-47**(이미 기록됨)을 따랐다. 이 태스크에서 새로 정한 것은 설계에 없던 빈칸 셋이고, 전부 코드 주석에 남겼다:
  1. `scripts.start` 를 npm 이 아니라 `node --import tsx` 로 직접 실행한다(프로세스 1단 = 트리 kill 이 단순).
  2. 단일 실행 잠금의 "시작 시각" 대신 **이미지 이름**을 pid 재사용 가드로 쓴다(tasklist 한 번으로 얻는다).
  3. 옛 `데몬 시작` 버튼은 **감시자가 있을 때는 실패 화면에만**, 감시자가 없을 때(콘솔 실행·테스트)는
     예전 화면 그대로 남긴다 — 그 화면에서는 그것이 유일한 시작 방법이다.

## 남은 것

- **실기 검증 T46-3** — 설계 §검증 8항목(콘솔 창 없이 기동 / X 로 닫고 프로세스 0 / 다시 켜면 그대로 출근 /
  데몬 강제 종료 후 복구 / 앱 강제 종료 후 데몬 자정리 / 1분 3회 / 두 번 실행 / 계속 일하기).
- **부서 힌트 재전송**: 되살리는 도중 탭을 바꿔도 즉시 알릴 길이 없다(PROTOCOL 에 전용 메서드가 없다).
  지금은 값만 갱신하고 **다음 hello(재접속)** 에 실린다. 데몬 쪽(T46-1)이 힌트용 RPC를 두면 한 줄로 붙는다.
- `daemon.notice{kind:'parent-gone'}` 은 읽기만 하고 화면에 쓰지 않는다(그 알림이 올 때 앱은 이미 없다).
  데몬 로그·다음 기동의 `daemon.log` 로 확인한다.
- 데몬을 실행 파일 하나로 묶어 동봉하기(설계 "범위 밖") — 지금은 저장소의 `dev/daemon` 을 찾아 띄운다.
  저장소 밖에서 실행한 exe 는 `findDaemonDir()` 가 실패하고, 그때는 감시자 없이 옛 화면으로 떨어진다.
