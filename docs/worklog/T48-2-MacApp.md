# T48-2 — 맥 지원(앱 쪽)

- 날짜: 2026-09-29
- 마일스톤: M6
- 관련 설계: `docs/design/맥-지원.md`(원칙 1~5 · "앱" 표 · 2단계 대본 M7~M16) / D-48 / D-47(수명주기)
- 커밋: `de734bf`(platform.dart) `c16808a`(맥 스폰) `32af3bd`(단축키) `b3050a1`(위험 패턴) `5fdc9cf`(macOS 러너) + 이 문서
- 짝: T48-1(데몬 쪽, `dev/daemon/**`) — 이 태스크는 `dev/app/**` 만 건드렸다. `docs/03`·`docs/04` 는 T48-3 몫.
- 이 PC 는 **윈도우**다. `flutter build macos` 는 여기서 돌지 않는다 → 맥 분기는 전부 **플랫폼을 주입한 테스트**로
  고정했고, 실기만 알 수 있는 것은 아래 "맥에서 확인" 으로 넘겼다(원칙 4).

## 목표

앱을 맥에서 쓸 수 있게 한다 — 다시 쓰는 것이 아니라 **운영체제에 닿는 곳만** 분기하고, 그 분기를 한 파일에
모아 윈도우에서 단위 테스트로 고정한다. 윈도우 동작은 1비트도 바뀌지 않는다.

## 한 것

### 1. `lib/platform/platform.dart` — 운영체제에 닿는 코드 한곳 (D-48 원칙 2)

`AppPlatform`(인터페이스: `isWindows`/`isMacOS`/`isLinux` · `env` · `home` · `pathSeparator` ·
`fileExists` · `listDirectory` · `runner`)을 주입받는 함수들. 진짜 구현은 `HostPlatform`(dart:io),
테스트는 `test/platform/fake_platform.dart` 의 `FakePlatform`(+ `FakeUnix`, `fakeTasklist`).

| API | 규칙 |
|---|---|
| `dataDir()` · `dataFilePath(name)` | `PIXEL_DATA_DIR` → 윈도우 `%LOCALAPPDATA%\pixel-office` · 맥 `$HOME/Library/Application Support/pixel-office` · 리눅스 `$XDG_DATA_HOME/pixel-office` 또는 `$HOME/.local/share/pixel-office`. 정할 수 없으면 `null` |
| `dataDirEnvName()` | 진단 문구에 쓰는 이름 — 윈도우 `LOCALAPPDATA`, 그 밖에는 `HOME` |
| `findNode()` | `PIXEL_NODE` → PATH → `/opt/homebrew/bin/node` → `/usr/local/bin/node` → `~/.nvm/versions/node/*/bin/node`(버전 내림차순) → `~/.volta/bin/node`. 없으면 `null`. **윈도우는 오늘 그대로 `'node'`** |
| `npmExecutable()` | 윈도우 `npm.cmd` · 유닉스 `npm` |
| `isProcessAlive(pid, imageContains:)` | 윈도우 `tasklist /FI "PID eq N" /NH /FO CSV` · 유닉스 `kill -0`(EPERM = 살아 있음). 이름을 주면 `processImageName` 으로 확인(pid 재사용 가드, D-17) |
| `processImageName(pid)` | 윈도우 CSV 첫 칸 · 유닉스 `ps -p <pid> -o comm=` 의 **basename** |
| `killTree(pid)` | 윈도우 `taskkill /PID <pid> /T /F` · 유닉스 `ps -axo pid=,ppid=` → 트리 구성 → **자식부터** `kill -9` |
| `isMetaShortcuts` · `shortcutModifierLabel` | 맥이면 Cmd, 그 밖에는 Ctrl(기준은 Flutter 의 `defaultTargetPlatform`) |

호출처를 전부 바꿨다: `rpc/daemon_info.dart`(데이터 폴더·진단 문구) · `lifecycle/app_lock.dart` ·
`panel/ui_prefs.dart`(`app-ui.json`) · `lifecycle/daemon_process.dart`(로그 경로 · `isPidAlive` ·
`killProcessTree` 는 이제 통로만 남았다) · `topbar/daemon_launcher.dart`(경로 구분자).

### 2. 맥에서 데몬 띄우기 (D-48 ③)

- `resolveDaemonCommand(cmd)`: `node` → `findNode()` 의 **절대 경로**, `npm`/`npm.cmd` → 플랫폼 이름.
  `spawnDaemon()` 이 띄우기 직전에 부른다. 명령 자체는 윈도우와 같다(`node --import tsx src/index.ts`, 파이프 모드).
- 못 찾으면 `DaemonNodeNotFoundException`(원인 `node-not-found`) → 감시자가 **재시작 일정을 돌지 않고** 바로
  `failed(nodeNotFound)`. 실패 화면(`overlay.nodeNotFound`):
  `node 를 찾지 못했습니다 — Homebrew 로 설치하거나 PIXEL_NODE 로 경로를 지정하세요`
- 왜 절대 경로냐: 맥 GUI 앱은 **터미널의 PATH 를 물려받지 않는다**(launchd 의 최소 PATH). Finder 에서
  더블클릭한 앱에게 Homebrew·nvm·volta 의 `node` 는 없는 명령이다.
- 옛 "데몬 시작" 폴백 버튼: 맥·리눅스에서는 `cmd /c start` 도 `open -a Terminal` 도 쓰지 않고 **감시자와 같은
  스포너**로 창 없이 띄운다(`launchDaemon(spawn:)` 으로 주입 가능). 폴백이 다른 길을 타면 맥에서 이 버튼만
  따로 고장난다.

### 3. 단축키 (D-48 ⑤)

| | 윈도우·리눅스 | 맥 |
|---|---|---|
| 지시 바 · 로그 · 터미널 · 지시문 · 보고서 | `Ctrl+K/L/T/I/R` | `Cmd+K/L/T/I/R` |
| 인박스 맨 위 카드 허가 / 거부 | `Alt+Y` / `Alt+N` | `Cmd+Shift+Y` / `Cmd+Shift+N` |

`AppShortcuts` 는 `SingleActivator(key, control: !meta, meta: meta)` 로 한 줄에서 갈리고, 인박스는
`HardwareKeyboard` 의 `isMetaPressed && isShiftPressed`(맥) / `isAltPressed`(그 밖)를 본다.
화면 문구도 플랫폼을 따른다: 카드 힌트(`platformApprovalShortcutHint`) · 힌트 줄(`platformShortcutHintLine`) ·
터미널 오버레이 안내(`terminalMovedToOverlay`) · 전송 툴팁.

### 4. 위험 명령 판별에 유닉스 패턴 (D-48 ④)

`panel/approval_summary.dart` 의 `isDangerousCommand` 에 **플랫폼 무관**으로 추가: `sudo` · `chmod -R`/`chown -R` ·
`git reset --hard` · `git clean -fd` · `git checkout -- <경로>` · `>`/`>>` 덮어쓰기(단 `2>&1` 은 아니다) ·
`dd`/`of=/dev/` · `mkfs` · `diskutil erase`. PowerShell 패턴은 그대로 두었다.

### 5. macOS 러너

`flutter create --platforms=macos --project-name pixel_office --org com.pixeloffice .` 로 만들고 손으로 고친 곳:

- `Runner/{DebugProfile,Release}.entitlements`
  - `com.apple.security.app-sandbox` = **false**
  - `com.apple.security.files.user-selected.read-write` = true
  - `com.apple.security.network.client` = true
  - (Debug 만) `cs.allow-jit`, `network.server` — Dart VM 서비스·핫 리로드
- `Runner/MainFlutterWindow.swift`: 초기 **1280×720**(윈도우 러너와 같다) · 최소 **1100×640**(레이아웃 v2 하한) ·
  `center()` · 제목 `픽셀 오피스`
- `Runner/Info.plist`: `CFBundleName`·`CFBundleDisplayName` = `픽셀 오피스`
  (`PRODUCT_NAME` 은 `pixel_office` 그대로 — 산출물이 `pixel_office.app` 이어야 문서·스크립트가 맞는다)
- `flutter create` 가 만든 기본 `test/widget_test.dart`(카운터 예제)와 `pixel_office.iml` 은 지웠다.
- `file_selector` 가 `file_selector_macos` 0.9.5+1 을 이미 끌어온다(`pubspec.lock` ·
  `macos/Flutter/GeneratedPluginRegistrant.swift` 에 `FileSelectorPlugin` 등록 확인) — 따로 추가하지 않았다.
- 윈도우 러너는 건드리지 않았다.

### 6. 문서

`dev/app/README.md` 에 **"플랫폼 · 맥"** 절(플랫폼 표 · node 탐색 실패 문구 · 단축키 표 · 엔타이틀먼트와
샌드박스를 끄는 이유 · 맥에서 빌드하는 방법과 Gatekeeper 주의) + 구조/위험 패턴/daemon.json 절 갱신.

## 검증

```
$ cd dev/app && flutter analyze
No issues found! (ran in 3.9s)

$ flutter test -j 2
00:44 +721 ~1: All tests passed!
```

기준선은 **659 통과 + 1 건너뜀**(맥 작업 전) → **721 통과 + 1 건너뜀**(+62). 기존 테스트는 한 줄도 고치지 않았다
(`flutter test` 의 기본 `defaultTargetPlatform` 이 android 라 윈도우와 같은 Ctrl/Alt 조합을 타기 때문에 그대로 통과한다).

새 테스트(전부 윈도우에서 도는 것):

| 파일 | 수 | 무엇을 고정하나 |
|---|---|---|
| `test/platform/platform_test.dart` | 32 | 데이터 폴더 3종 + `PIXEL_DATA_DIR` 우선 + 진단 환경변수 이름 / `findNode` 순서(PATH → Homebrew → /usr/local → nvm 최신 → volta), `PIXEL_NODE` 우선, 못 찾으면 null, 버전 정렬 / npm 이름 / `kill -0`·EPERM·`ps -p -o comm=` basename·tasklist CSV / 트리 종료 3대(자식 먼저, 뿌리 마지막, 남의 프로세스 제외) · `taskkill` 한 번 / `HostPlatform` |
| `test/lifecycle/mac_spawn_test.dart` | 14 | `resolveDaemonCommand`(절대 경로 · `node-not-found` · PIXEL_NODE · npm 이름 · 윈도우 무변화) / `spawnDaemon` 이 맥에서 스폰 전에 던지는지 · 오류 문구에 찾은 node 경로가 들어가는지 / 감시자 `failed(nodeNotFound)` 이고 재시작을 안 도는지 / 폴백 버튼이 같은 스포너를 쓰는지 |
| `test/command/mac_shortcuts_test.dart` | 7 | `TargetPlatform.macOS` 에서 `Cmd+K/L/T/I/R`·Esc 가 듣고 **Ctrl 은 안 듣는다** / 윈도우에서는 반대 / 문구가 플랫폼을 따른다 |
| `test/panel/mac_inbox_test.dart` | 2 | 맥에서 `Cmd+Shift+Y/N` 이 허가·거부를 보내고(가짜 데몬 RPC 확인) `Alt+Y`·`Cmd+Y` 는 아무 일도 안 한다 · 카드 힌트가 맥 문구 |
| `test/panel/approval_summary_test.dart`(추가 group) | 6 | 유닉스 위험 패턴 · 윈도우 패턴 유지 · 오탐 없음 |
| `test/lifecycle/overlay_lifecycle_test.dart`(추가) | 1 | 실패 화면의 node 문구 · 로그 꼬리·다시 시도 버튼은 그대로 |

`ps`·`kill`·`tasklist` 는 **한 번도 실제로 부르지 않는다** — 가짜 출력을 먹이고 어떤 인자로 불렸는지를 본다.

## 발견한 함정

1. **`testWidgets` 는 본문이 끝나는 자리에서 디버그 변수 원상복구를 검사한다**
   (`debugAssertAllFoundationVarsUnset`). `debugDefaultTargetPlatformOverride` 를 `setUp` 에서 켜고
   `tearDown` 에서 되돌리면 **테스트마다 실패한다**(tearDown 이 검사보다 뒤다). 본문 안에서 켜고
   `try/finally` 로 되돌려야 한다(두 파일에 `onMac(...)` 헬퍼).
2. **`flutter test` 의 기본 플랫폼은 android 다**(`FLUTTER_TEST` 가 있으면 그렇게 강제된다). 덕분에
   기존 Ctrl/Alt 테스트가 그대로 통과하지만, "윈도우니까 Ctrl" 이 아니라 "맥이 아니니까 Ctrl" 임을 알고 있어야 한다.
3. **맥 `ps` 에는 `--ppid` 가 없다.** `ps -o pid= --ppid <pid>`(리눅스식)는 맥에서 쓸 수 없어
   `ps -axo pid=,ppid=` 전체를 읽어 트리를 우리가 잇는다. 그리고 **부모를 먼저 죽이면 자식이 pid 1 에 입양돼**
   목록에서 사라지므로 자식부터 죽인다.
4. **임시 폴더를 `repo` 아래에 만들면 "폴더를 못 찾는" 테스트가 성립하지 않는다** — `findDaemonDir` 는 위로
   올라가며 찾으므로 `repo/nowhere/deeper` 에서 시작해도 `repo/dev/daemon` 을 찾아낸다. 별도 임시 폴더를 쓴다.
5. **`flutter create --platforms=macos .` 는 기본 `test/widget_test.dart` 와 `.iml` 도 만든다.** 카운터 예제라
   그대로 두면 테스트 스위트에 남는다(우리 앱엔 카운터가 없다) → 지웠다.
6. **`Info.plist` 의 `CFBundleName` 을 바꾸는 것과 `PRODUCT_NAME` 을 바꾸는 것은 다르다.** `PRODUCT_NAME` 을
   한글로 하면 **번들·실행 파일 이름까지** 한글이 되어 `pixel_office.app` 경로를 쓰는 문서·스크립트가 깨진다.

## 결정

- D-48(이미 기록됨)을 따랐다. 설계에 없던 빈칸으로 여기서 정한 것:
  1. `node` 를 못 찾은 것은 **재시도 대상이 아니다** → 새 실패 상태 `SupervisorFailure.nodeNotFound`
     (원인 코드 `node-not-found`)를 두고 첫 시도든 재시작 중이든 바로 그 화면으로 간다.
  2. 데이터 폴더 진단 문구의 두 번째 환경변수 이름을 플랫폼에 따라 바꾼다(`LOCALAPPDATA` ↔ `HOME`) —
     맥에서 "LOCALAPPDATA 없음" 은 아무 정보도 주지 못한다.
  3. 창 최소 크기는 **1100×640**(레이아웃 v2 의 하한). 윈도우 러너에는 최소 크기 제한이 없지만, 맥 창은
     아무렇게나 줄어들 수 있어 하한을 건다.
  4. 단축키 판정만 `defaultTargetPlatform` 을 쓴다(나머지는 주입된 `AppPlatform`) — 키보드는 Flutter 가 보는
     플랫폼이 기준이고, 그래야 위젯 테스트가 맥을 흉내 낼 수 있다.

## 맥에서 확인 (2단계 — `docs/design/맥-지원.md` M7~M16)

이 PC 에서 알 수 없는 것만. 순서대로 하고 결과는 `docs/worklog/T48-3-MacLive.md` 에, 다르게 동작한 것은 04 에 D-## 로.

| # | 대본 | 구체적으로 할 일 | 기대 | 어긋나면 |
|---|---|---|---|---|
| 1 | M7 | `flutter config --enable-macos-desktop` → `cd dev/app && flutter pub get && flutter analyze && flutter test` | 윈도우와 **같은 수**(720 통과 + 1 건너뜀). 맥 분기 테스트는 전부 가짜 플랫폼을 쓰고, 진짜 OS 를 보는 `HostPlatform` 그룹도 플랫폼별로 기대값을 갈라 두었다 | 실패한 테스트 이름과 출력을 그대로 옮긴다. `daemon_process_test.dart` 의 "killTree 가 자식 + 손자를 끝낸다" 는 윈도우 전용으로 건너뛰게 되어 있으니(`skip`) 맥에서는 **유닉스 판을 새로 쓸지** 판단한다 |
| 2 | M7 | `flutter build macos --release` | `build/macos/Build/Products/Release/pixel_office.app` | 서명 오류면 Xcode 에서 Runner 타깃에 개인 팀 자동 서명 |
| 3 | M8 | Finder 에서 `pixel_office.app` **더블클릭**(데몬 없이, 터미널 아님) | 콘솔 창 없이 데몬이 뜨고 사무실이 열린다(≈5초). `~/Library/Application Support/pixel-office/` 에 `daemon.json`·`daemon.log`·`app.lock` | `node 를 찾지 못했습니다` 화면이면 `findNode` 순서에 그 맥의 node 경로를 추가하거나 `launchctl setenv PIXEL_NODE <경로>` |
| 4 | M8 | 첫 실행에 Gatekeeper 경고가 뜨는지 | 우클릭 → 열기 → 열기로 통과 | 통과가 안 되면 서명·공증 필요 여부를 기록(범위 밖이지만 사실은 남긴다) |
| 5 | M8 | `daemon.log` 머리줄의 `앱이 데몬을 띄움: <명령>` | 명령의 node 가 **절대 경로**(`/opt/homebrew/bin/node` 등) | 상대 이름이면 `resolveDaemonCommand` 를 안 탄 경로가 있다 |
| 6 | M9 | 부서 만들기 → **폴더 선택 대화상자** → 폴더 선택 → 부장 출근 | 네이티브 대화상자가 뜨고 고른 경로가 들어간다(샌드박스 off + user-selected 권한) | 대화상자가 안 뜨거나 권한 오류면 엔타이틀먼트를 다시 본다 |
| 7 | M10 | **Cmd+Q** 로 종료 · Dock 아이콘 우클릭 → 종료 · 창 닫기(빨간 점) 각각 | 세 경로 모두 `onExitRequested` 를 타서 확인 다이얼로그(일하는 중일 때) → `정리하는 중…` → 프로세스 0. `ps aux \| grep -E "claude\|codex\|node"` 비어 있음 | Cmd+Q 가 가로채이지 않으면 `AppDelegate.applicationShouldTerminate` 를 손봐야 한다(그때 대안을 기록) |
| 8 | M10 | 위 종료가 **트리 kill** 까지 갔는지(일부러 8초를 넘겨 보기: 데몬에 `SIGSTOP`) | `ps -axo pid=,ppid=` 기반 트리 kill 이 손자(claude·codex)까지 데려간다 | 남는 프로세스가 있으면 그 pid 의 ppid 를 적어 둔다(트리 구성 규칙 보강) |
| 9 | M11 | 앱을 다시 켜기 | 조직 그대로 출근, `[RESUMED]` 없음, `app.lock` 이 새 pid 로 갱신 | 잠금이 낡아 두 번째 실행이 막히면 `ps -p <pid> -o comm=` 출력(앱 이미지 이름)을 적어 둔다 — `app.lock` 의 `image` 는 맥에서 `pixel_office` 다 |
| 10 | M11 | 앱을 두 번 띄워 보기(Finder 에서 다시 더블클릭) | 이미 실행 중 안내 후 스스로 끝냄 | 맥은 같은 앱을 두 번 안 띄우고 창만 앞으로 가져올 수도 있다 — 그러면 그대로 기록(잠금이 필요 없어진다) |
| 11 | M12 | 일하는 중 `kill -9 <데몬 pid>` | 윈도우와 같은 타임라인으로 재시작 + 세션 복구, 유령 정리(`ps` 이미지 이름) 동작 | 재시작이 안 되면 `daemon.log` 와 감시자 상태를 적어 둔다 |
| 12 | M13 | 앱을 `kill -9` | 데몬이 부모 사라짐을 감지해 몇 초 안에 스스로 정리(T48-1 쪽 `ps -o lstart` 파싱) | 남으면 데몬 쪽 이월 |
| 13 | M15 | `Cmd+K`/`Cmd+L`/`Cmd+T`/`Cmd+I`/`Cmd+R`, 인박스 `Cmd+Shift+Y`/`Cmd+Shift+N` | 전부 동작. 터미널 탭에 포커스가 있을 때 타이핑을 뺏지 않는지도 같이 | 시스템이 먼저 먹는 조합이 있으면(예: `Cmd+I`) 그 조합만 바꾸고 D-## 로 남긴다 |
| 14 | M15 | 카드 힌트 글자가 `Cmd+Shift+Y 허가 · Cmd+Shift+N 거부` 인지, 터미널 오버레이 안내가 `Cmd+T` 인지 | 글자와 실제 키가 같다 | 다르면 `isMetaShortcuts` 가 false 로 나온 것(런타임 플랫폼 확인) |
| 15 | M16 | 레티나(devicePixelRatio 2)에서 픽셀 서체·스프라이트 | 흐리지 않음, `spriteScale` 이 정수 | 흐리면 정수 배율 계산을 레티나에서 다시 본다 |
| 16 | M14 | 사용량 칩·팝오버·터미널 하단 상태 줄 | 윈도우와 동일 | `/usage`·`/status` 줄바꿈이 다르면 `tui-maps/*-darwin.json`(T48-1 로더 규칙) |
| 17 | M8 | 창 크기·제목·메뉴 막대 | 1280×720 으로 열리고 1100×640 아래로는 안 줄고, 제목과 메뉴 막대가 `픽셀 오피스` | 메뉴 막대가 `pixel_office` 면 `CFBundleName` 이 안 먹은 것(빌드 캐시 지우고 다시) |
| 18 | M17 | `tool/capture-window.sh` 작성(`osascript` 로 창 id → `screencapture -l`) 후 증거 캡처 | `docs/worklog/img/T48-*.png` | — |

## 남은 것

- **맥 실기 전부**(위 표) — T48-3 / `T48-3-MacLive.md`.
- `test/lifecycle/daemon_process_test.dart` 의 "killTree 가 자식 + 손자를 끝낸다" 는 **윈도우에서만** 돈다
  (`skip: node 없음 또는 윈도우 아님` — 원래 `taskkill /T` 를 보는 테스트다). 유닉스 트리 종료는 지금 가짜 `ps`/`kill`
  로만 고정돼 있으니, 맥에서 진짜 3대 트리를 죽여 보는 테스트는 2단계에서 추가할지 판단한다.
- `tool/capture-window.sh`(맥 창 캡처)는 2단계에서 만든다 — 윈도우에서는 검증할 방법이 없다.
- 데몬 쪽(`src/platform.ts`)과 규칙이 어긋나지 않는지는 T48-1 이 끝난 뒤 **양쪽 데이터 폴더 문자열을 한 번 더
  맞춰 본다**(같은 `PIXEL_DATA_DIR`·`HOME` 에서 같은 경로가 나와야 한다). 지금은 설계 표를 기준으로 각자 구현했다.
- 앱 아이콘은 `flutter create` 의 기본 Flutter 아이콘이다(윈도우도 기본 아이콘을 쓴다) — 픽셀 아이콘은 범위 밖.
