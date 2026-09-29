# T48-3 — 맥 실기 (2단계 대본 M1~M17)

- 날짜: 2026-09-29
- 마일스톤: M6
- 관련 설계: `docs/design/맥-지원.md` "2단계 대본" M1~M17 / D-48 / 짝 T48-1(데몬)·T48-2(앱)
- 커밋: `9dfe30d`(데몬 소스) `75e8ec6`(데몬 테스트) `c5a4010`(앱 테스트) `9ddcfd6`·`f603fcd`(macOS 빌드)
  `7a7ace4`(창 캡처 도구) `be1fc21`(통합 테스트 필터) + 이 문서 + 04 의 D-49
- 브랜치: `T48-3` (아직 푸시하지 않았다)
- 실기 환경: **macOS 26.6.2 (25G83) · arm64** / Node v24.18.0 · npm 11.16.0 / Flutter 3.44.7 · Dart 3.12.2 /
  CocoaPods 1.17.0 / **Xcode 27.0** / claude 2.1.284 / codex 0.154.0 (0.159.0 → 내림, 아래 M4 함정)
- 저장소 위치: `~/Desktop/포트폴리오/pixel-office-dev` (경로에 **한글**이 들어 있다 — M7 함정 ②)

## 목표

T48-1·T48-2 가 윈도우에서 "플랫폼을 주입해" 고정해 둔 맥 분기를, **진짜 맥에서** 대본 M1~M17 대로 돌려
맞는지 본다. 어긋난 것은 고치고, 맥에서만 드러나는 것은 기록한다.

## 결과 요약

| # | 확인 | 결과 |
|---|---|---|
| M1 | 데몬 `npm install` → `tsc --noEmit` → `npm test` | **통과** — 874건 + 스킵된 MixedTeam 10건 = 윈도우의 884 (함정 ①~⑤ 를 고친 뒤) |
| M2 | `npm start` 로그의 실행 파일 탐색 | **통과** — `claude : /Users/hjkim/.nvm/versions/node/v24.18.0/bin/claude`(실제 파일), 데이터 폴더 `~/Library/Application Support/pixel-office` |
| M3 | `dept create` → 첫 실행 신뢰 다이얼로그 → idle | **통과(claude·codex)** — claude 는 `passed first-run dialog (trust-folder-claude / onboarding-enter)` → `idle`, codex 는 `부장 [codex] starting` → `idle`. darwin 전용 tui-map 불필요 |
| M4 | `say 부장` 한 턴 → 이벤트 표 · `report` | **통과(claude·codex)** — 둘 다 thinking → create_team → delegate → 팀장 thinking → text → idle. codex 는 `reading`·`editing` 같은 전용 이벤트 종류까지 맞다. 단 **codex 0.159 로는 지시가 제출되지 않는다** — 맵 문제는 아니다(아래 함정 ⑤) |
| M5 | 쓰기 명령 허가 → 콘솔 `allow` | **통과(claude·codex)** — claude 는 유닉스 리다이렉션(`printf … > mac-live.txt`), codex 는 **작업 폴더 밖** `apply_patch`. 둘 다 승인 후 실행·파일 생성(한글 그대로) |
| M6 | `PIXEL_IT=1` 통합 테스트 | **통과 5종** — pty · office · askuser · teamtools · **codex**. 단 **파일 하나씩** 돌려야 하고(함정), teamtools 는 CLI 버전 변화 때문에 필터를 고쳐야 했다(함정) |
| M7 | 앱 `pub get`·`analyze`·`test`·`build macos --release` | **통과** — 720 통과·2 스킵, `✓ Built pixel_office.app (36.0MB)`. 툴체인 함정 둘을 고쳐야 했다(③④) |
| M8 | Finder 더블클릭(데몬 없이) | **통과** — 앱이 **nvm 의 node 를 절대 경로로** 찾아 데몬을 띄웠다. `daemon.log`·`app.lock` 이 데이터 폴더에, ws ESTABLISHED, 창 1280×752 |
| M9 | 부서 만들기 → 폴더 선택 대화상자 | **못 함** — 앱 제어 권한이 없다(GUI 클릭 필요). 엔타이틀먼트는 바이너리에서 확인 |
| M10 | Cmd+Q → 프로세스 0 | **부분** — Cmd+Q 와 같은 경로(Apple Event quit)가 `onExitRequested` 에 **도달했다**. 확인 대화상자를 사람이 눌러야 하는 갈래만 남았다 |
| M11 | 앱 다시 켜기 → 조직 그대로 출근(말없이) | **통과** — `recover 부장: --resume <id>, assigned 1` / `실기팀장: …, 말없이` → `복구: 2명 재개, 0건 만료, 말없이 1명` |
| M12 | 일하는 중 `kill -9 <데몬 pid>` → 자동 재시작·복구 | **통과** — 2초 안에 새 데몬, **유령 정리가 맥에서 동작**(옛 CLI 3개 종료), 앱은 살아 있고 ws 재연결 |
| M13 | 앱 `kill -9` → 데몬이 부모 사라짐 감지 → 정리 | **통과** — 5초 안에 `부모 앱이 사라졌다 (pid …)` → `세션 3개 닫음, 2명 잠시 닫힘` → `bye`, CLI 전부 종료 |
| M14 | 사용량 칩·팝오버·터미널 하단 상태 줄 | **부분** — 데몬 쪽은 **두 엔진 다** 들어온다: `claude 연결됨(max) 주간 94% / 5시간 55% / 모델 Fable 93%`, `codex 연결됨(pro) 주간 59%`, 멤버별 컨텍스트·토큰. `/usage`·`/status` 줄바꿈 차이 없음 → darwin 패턴 불필요. 앱 칩·팝오버는 GUI |
| M15 | 단축키 `Cmd+K/L/T/I/R`, `Cmd+Shift+Y/N` | **못 함** — GUI 입력 필요 |
| M16 | 픽셀 서체·스프라이트가 레티나에서 흐리지 않음 | **못 함** — 눈으로 봐야 한다. 창 크기만 확인(`setContentSize(1280×720)` → 관측 1280×752 = 콘텐츠 720 + 타이틀바 32) |
| M17 | 창 캡처 스크립트로 증거 저장 | **부분** — `tool/capture-window.sh` 를 만들고 창 id 조회까지 확인(id=2753). `screencapture` 호출은 화면 기록 권한 프롬프트가 떠 실행하지 않았다 |

M9·M15·M16 과 M10 의 나머지는 **앱 창을 직접 클릭·타이핑해야** 한다. 이 세션에서는 앱 제어 권한이
승인되지 않아 못 했다(코드 문제가 아니다) — "남은 것" 에 사람이 할 순서를 적어 뒀다.

## 한 것

### 1. M1 함정 ① — npm 11.16+ 가 node-pty 설치 스크립트를 막아 **모든 pty spawn 이 실패**한다

`npm install` 은 exit 0 인데 경고가 붙는다:

```
npm warn allow-scripts 3 packages have install scripts not yet covered by allowScripts:
npm warn allow-scripts   node-pty@1.1.0 (install: node scripts/prebuild.js || node-gyp rebuild; postinstall: …)
```

그대로 두면 pty 를 띄우는 순간 이렇게 죽는다:

```
$ node -e "require('node-pty').spawn('/bin/echo',['hi'],{cols:80,rows:24})"
SPAWN FAIL: posix_spawnp failed.
```

원인은 **네이티브 빌드 실패가 아니다**(대본 M1 의 "어긋나면" 칸이 짚은 Xcode CLT·Python 문제가 아니다).
node-pty 1.1.0 은 `prebuilds/darwin-arm64/` 에 `pty.node` 와 **`spawn-helper`** 를 담아 배포하고,
유닉스 구현은 자식을 그 `spawn-helper` 로 띄운다(`lib/unixTerminal.js`: `helperPath = native.dir + '/spawn-helper'`).
설치 스크립트가 그 파일에 실행 권한을 주는데, npm 11.16 부터는 설치 스크립트가 **기본으로 차단**되어
`spawn-helper` 가 `-rw-r--r--` 로 남는다 → `posix_spawnp` 가 EACCES.

```
$ ls -l node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
-rw-r--r--@ 1 hjkim  staff  50480 spawn-helper      ← 실행 권한 없음
$ chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
$ node -e "…pty.spawn('/bin/echo',['hi'])…"
DATA:"hi\r\n"
EXIT 0
```

**코드는 안 고쳤다** — `node_modules` 문제라서 저장소가 할 일은 "알려 주는 것" 이다. 루트 README 의 맥 절에
이 한 줄을 넣었다(`npm approve-scripts` 또는 `chmod +x`). 윈도우는 `conpty.node` 를 쓰고 `spawn-helper` 가
없어 이 문제가 없다.

### 2. M1 함정 ② — `npm test` 의 glob 이 맥에서 **파일 하나를 조용히 빠뜨린다**

`package.json` 의 `"test": "node --import tsx --test test/**/*.test.ts"` 는 따옴표가 없었다.
윈도우에서 npm 은 `cmd.exe` 로 스크립트를 돌리고 cmd 는 glob 을 펼치지 않으므로 **node 가** 자기 glob 으로
`**` 를 재귀 처리해 67개 파일을 모두 본다. 맥에서 npm 은 `/bin/sh` 를 쓰고, sh 의 `**` 는 `*` 와 같아
`test/*/*.test.ts` 로 펼쳐진다 — **최상위 `test/log.test.ts` 가 빠진다**(5건).

```
$ /bin/sh  -c 'set -- test/**/*.test.ts; echo $#'   → 66
$ /bin/zsh -c 'set -- test/**/*.test.ts; echo $#'   → 67
$ grep -c "데몬 로그 목적지" <첫 npm test 로그>       → 0      ← log.test.ts 가 안 돌았다
```

고쳤다 — 패턴을 따옴표로 감싸 **셸이 손대지 못하게** 하고 node 가 glob 하게 한다. 윈도우도 그대로 동작한다
(cmd 는 따옴표를 벗겨 node 에 같은 문자열을 넘긴다). 고친 뒤 sh 에서도 `log.test.ts` 가 돈다.

`dev/daemon/package.json`

### 3. M1 함정 ③ — `Singleton.test.ts` 가 **윈도우 안내 문구를 못 박고 있었다**

T48-1 은 안내 문구의 명령을 `platform.ts` 로 옮겼는데(`taskkill` ↔ `kill`, `netstat|findstr` ↔ `lsof`),
테스트는 옛 윈도우 문자열을 정규식으로 그대로 들고 있었다. 구현이 맞고 **테스트가 틀린** 경우다:

```
AssertionError: The input did not match the regular expression /taskkill \/F \/PID 4242/. Input:
  '이미 데몬이 돌고 있습니다 — pid 4242 (ws 127.0.0.1:7420).
     콘솔에서 `shutdown`  또는  kill 4242 …'      ← 맥 문구가 정확히 나왔다
```

플랫폼별 문구 **리터럴**은 이미 `test/platform/platform.test.ts` 가 세 플랫폼 모두 고정하고 있으므로,
Singleton 쪽은 "그 힌트가 문구에 들어 있다" 만 보게 했다 — `host.hintForKillingPid(4242)` ·
`host.hintForFindingPortOwner(7421)` 를 그대로 쓴다.

`dev/daemon/test/office/Singleton.test.ts`

### 4. M1 함정 ④ — `TeamToolsServer.test.ts` 의 직급 강등 검사가 **전송의 SSE GET 과 경합**한다

"서버를 만들 때는 부장인데 콜백이 도는 사이 팀장으로 내려앉으면 한국어 사유" 검사가 맥에서 깨졌다:

```
+ actual   'MCP error -32602: Tool ask_user not found'
- expected 'ask_user 실패: 부장만 사용자에게 질문할 수 있습니다. ask_parent를 쓰세요.'
```

`handle()` 은 **HTTP 요청마다** `resolveMember` 를 한 번 부른다. 검사는 오버라이드를 걸고 "다음
`resolveMember` 는 내가 부를 `callTool` 의 것" 이라고 가정하는데, SDK 의 Streamable HTTP 클라이언트는
initialize 뒤에 **SSE `GET` 을 따로** 연다. 서버 요청 로그를 찍어 확인했다:

```
[HTTP] POST /mcp/tok_head   ← initialize
[HTTP] POST /mcp/tok_head   ← tools/list
[HTTP] GET  /mcp/tok_head   ← 이 GET 이 'head' 를 먹는다
[HTTP] POST /mcp/tok_head   ← callTool 은 'lead' 로 서버가 만들어져 ask_user 가 등록조차 안 된다
```

그래서 기대한 **콜백의 한국어 게이트** 대신 SDK 의 `-32602` 가 온다. 윈도우에서는 이 GET 이 더 일찍
도착해 가려져 있었다(맥에서도 로깅을 한 줄 넣으면 타이밍이 바뀌어 통과한다 — 진짜 경합이다).

구현이 아니라 **검사 방법**을 고쳤다. GET 은 SSE 라 응답이 끝나지 않고 주차되므로
`server.liveConnections(token)` 이 1 이 되는 것으로 도착을 알 수 있다 — 오버라이드를 걸기 **전에**
`waitForSseStream(server, HEAD)` 로 그 GET 을 기다린다. 10회 연속 통과로 확인했다.

`dev/daemon/test/mcp/TeamToolsServer.test.ts`

### 5. M1 함정 ⑤ — `MixedTeam.test.ts` 가 **`.gitignore` 된 픽스처**를 읽어 스위트가 통째로 죽는다

```
Error: ENOENT: no such file or directory, open '…/dev/spike-0/hooklog-2.json'
    at loadLog (test/office/MixedTeam.test.ts:37:29)      ← import 시점에 던진다
```

`.gitignore:10` 의 `dev/spike-0/*.json` 이 스파이크 실측 로그를 빼기 때문에 **새로 클론한 곳에는 그 파일이
없다**. 맥에서 처음 드러났지만 플랫폼과 무관하다 — 윈도우에 새로 클론해도 같다.

로그가 있으면 그대로 검증하고, 없으면 **이유를 달아 스위트만 건너뛰게** 했다(조용히 사라지지 않는다):

```
﹣ 혼합 팀: Claude 1 + Codex 1 (T23) # 실측 hook 로그가 없다(dev/spike-0/hooklog-2.json, hooklog-codex.json)
  — .gitignore 된 스파이크 산출물이라 새 클론에는 없다
```

`dev/daemon/test/office/MixedTeam.test.ts`

### 6. M7 함정 ① — 앱 테스트 다섯 건이 **호스트를 윈도우라고 가정**하고 있었다

T48-2 는 앱의 플랫폼 의존을 `platform.dart` 로 모으고 `FakePlatform` 주입을 갖췄는데, 이 다섯 건은
주입을 안 하고 **호스트**에 물었다. 윈도우에서는 그게 우연히 맞았다.

| 테스트 | 맥에서 난 일 | 고침 |
|---|---|---|
| `daemon_info_test.dart` (2건) | `LOCALAPPDATA` 가 무의미해 `dataDir` 이 `null` → 뒤 검사 전부 무너짐 | `FakePlatform(os: 'windows')` 를 주입하고 구분자도 그 플랫폼에서 받는다. `daemonNoDataDir`(호스트) → `daemonNoDataDirMessage(platform: win)` |
| `daemon_process_test.dart` (1건) | `npm.cmd` 를 기대했는데 `npm` | `windows: true` / `windows: false` 두 갈래를 다 못 박는다 |
| `create_department_test.dart` (2건) | `parentDirOf(r'D:\myproject\pixel-office')` 가 `'.'` — dart:io 는 **호스트** 경로 규칙이라 `\` 를 구분자로 안 본다 | 부모를 계산하는 검사에만 호스트 모양 픽스처(`hostProjects`/`hostPicked`/`hostRoot`)를 쓴다. 그냥 통과하는 문자열로 쓰이는 기존 상수는 그대로 |

`dev/app/test/{daemon_info_test.dart, lifecycle/daemon_process_test.dart, command/create_department_test.dart}`

### 7. M2 — 맥·리눅스에 `claude.exe` 를 알려 주던 문구

`claude` 를 못 찾았을 때 데몬이 이렇게 안내했다:

```
[daemon] 경로를 직접 주려면 PIXEL_CLAUDE_EXE=<claude.exe 경로>      ← 맥에 없는 파일 이름
```

플랫폼에 맞췄다 → 맥·리눅스는 `PIXEL_CLAUDE_EXE=<claude 경로>`. `dev/daemon/src/index.ts`

### 8. M7 함정 ③ — Xcode 27 의 `lipo` 가 유니버설 빌드를 막는다

`flutter build macos --release` 가 이렇게 죽었다:

```
Target release_unpack_macos failed: Exception: Binary …/FlutterMacOS does not contain architectures "arm64 x86_64".

lipo -info:
Architectures in the fat file: …/FlutterMacOS are: x86_64 arm64      ← 두 arch 가 다 들어 있다
```

메시지가 자기 모순이다. Flutter 의 `thinFramework`(`flutter_tools/lib/src/build_system/targets/darwin.dart`)는
Xcode 의 `ARCHS` 를 그대로 넘겨 `lipo <파일> -verify_arch arm64 x86_64` 를 부르는데, **Xcode 27 의 lipo 는
두 번째 arch 를 입력 파일로 세고 거부한다**:

```
$ lipo <FlutterMacOS> -verify_arch arm64 x86_64
lipo: -verify_arch requires exactly one input file        ← exit 1
$ lipo <FlutterMacOS> -verify_arch arm64
                                                          ← exit 0
$ lipo <FlutterMacOS> -verify_arch x86_64
                                                          ← exit 0
```

**한글 경로 탓이 아니다** — 프레임워크를 ASCII 경로로 복사해 같은 명령을 돌려도 똑같이 거부한다(확인함).
인자 순서를 바꿔도 같다. `lipo` 의 usage 는 `-verify_arch <arch> ...` 로 여러 개를 받는다고 적혀 있는데
실제로는 안 받는다.

`macos/Runner/Configs/Release.xcconfig` 에 `ARCHS = arm64` 을 박아 arch 를 하나로 줄였다. 유니버설 바이너리는
포기한다(개인 도구 · 앱스토어 배포는 D-48 범위 밖). Flutter 가 저 arg 순서를 고치면 그 줄을 지우면 된다.

`$(NATIVE_ARCH_ACTUAL)`·`$(NATIVE_ARCH_64_BIT)` 로 "빌드하는 맥의 arch" 를 쓰려 했지만 **둘 다 빌드 시점에
`arm64e` 로 풀려** 프레임워크에 없는 arch 를 요구했다(`does not contain architectures "arm64e"`). 그래서
리터럴로 적었다 — 인텔 맥에서 빌드하려면 그 줄을 `x86_64` 로 바꾼다. xcconfig 주석에 적어 뒀다.

### 9. M7 함정 ④ — Xcode 27 은 배포 대상 10.15 를 받지 않는다

③ 을 고치자 다음 오류가 나왔다:

```
error: The macOS deployment target 'MACOSX_DEPLOYMENT_TARGET' is set to 10.15,
       but the range of supported deployment target versions is 12.0 to 27.0.x.
```

**Flutter 3.44.7 의 macOS 템플릿 자체가 아직 10.15 다**(`templates/app/macos.tmpl/…/project.pbxproj.tmpl`
세 곳 확인) — T48-2 가 `flutter create --platforms=macos` 로 만든 러너도 그래서 10.15 였다. 즉 Xcode 27 에서는
이 프로젝트만의 문제가 아니라 **모든 Flutter macOS 프로젝트**가 그대로는 안 빌드된다.
`project.pbxproj` 의 세 곳을 12.0 으로 올렸다.

이 둘을 고친 뒤: `✓ Built build/macos/Build/Products/Release/pixel_office.app (36.0MB)`.

빌드 중에 Flutter 가 Runner 스킴에 `PreActions`(`macos_assemble.sh prepare`)를 하나 넣었다 — 도구가 한
마이그레이션이라 빌드가 성공한 상태 그대로 커밋했다.

### 10. M17 — 맥용 창 캡처 스크립트 `dev/app/tool/capture-window.sh`

`capture-window.ps1`(윈도우, PrintWindow)의 맥판. 전체 화면은 찍지 않는다. 설계는
"`screencapture -l <windowid>` + `osascript` 로 창 id" 였는데 **`osascript` 로는 CGWindowID 를 못 얻는다**
(`id of window 1` 은 Cocoa 앱에서 CGWindowID 가 아니고, 맥 기본 python3 에는 Quartz/pyobjc 가 없다).
그래서 두 갈래로 만들었다.

| 순위 | 방법 | 비고 |
|---|---|---|
| 1 | `swift` 로 `CGWindowListCopyWindowInfo` → 창 id → `screencapture -x -o -l <id>` | 진짜 창 단위(그림자 제외). Xcode 필요 |
| 2 | System Events 로 창 위치·크기 → `screencapture -x -R <rect>` | 겹친 창이 같이 찍힐 수 있다. 손쉬운 사용 권한 필요 |

이름이 두 곳에서 다른 것도 걸렸다 — CGWindowList 의 소유자 이름은 **번들 표시 이름**(`픽셀 오피스`,
Info.plist `CFBundleDisplayName`)이고 System Events 의 프로세스 이름은 **실행 파일 이름**(`pixel_office`)이다.
둘 다 기본 후보로 넣어 `-p` 없이 쓰게 했다.

### 11. M6 — claude 2.1.284 가 긴 주입 텍스트를 `<pasted_content>` 로 감싼다

통합 테스트 4종 중 `teamtools` 가 **480초 타임아웃**으로 실패했다:

```
✖ real daemon + real Claude leader: hire → delegate → member works → [ALL_REPORTS_IN] → leader report (489760ms)
  Error: timeout waiting for event thinking after #5
```

멈춘 곳은 "팀장이 `[REPORTS …]` 를 받았는지" 기다리는 줄이다. 그런데 로그를 보면 팀장은 **분명히 받았다**:

```
[IT:c] event #18 thinking {"text":"\n\n<pasted_content id=\"6a84\">\n[REPORTS task#2 보조 status=done]\n…"}
                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^  이 봉투 때문에
```

**claude 2.1.284 는 프롬프트로 밀어 넣은 텍스트가 길면 화면에 `\n\n<pasted_content id="…">\n` 으로 감싸
찍는다.** 데몬은 화면에 찍힌 그대로를 `thinking.text` 에 담으므로 주입 머리말이 문자열 맨 앞에 오지 않고,
`startsWith('[REPORTS ')` 필터가 영원히 안 맞는다. 길이에 따라 감싸기도 하고 안 하기도 한다 — 같은 실행에서
짧은 `[TASK#2 from 반장(팀장)]` 은 **감싸이지 않아** 그 앞 단계는 8.9초에 통과했다.

**플랫폼과 무관한 CLI 버전 변화다.** 이 프로젝트가 맞춰 둔 버전은 2.1.270(D-24 기록)이고 지금은 2.1.284다 —
같은 CLI 를 쓰는 윈도우에서도 똑같이 깨진다.

`it-helpers.ts` 에 `unwrapPasted()` 를 넣어 봉투를 벗기고, 주입 텍스트를 읽는 세 통합 테스트
(`teamtools` 2곳 + assert 2곳, `ranktools` 3곳, `askuser` 1곳)가 그것을 거치게 했다. 두 모양 다 통과한다:

```
감싼 것   → "[REPORTS task#2 보조 status=done]\n내용"
안 감싼 것 → "[TASK#2 from 반장(팀장)]\n작업 폴더…"
```

고친 뒤 teamtools 가 **24초에 통과**했다(`leader got reports (14879ms)`, `hello25.txt: "hi"`, 유령 0).

**고치지 않고 남긴 것**: 같은 봉투가 **사용자에게 보이는 로그·말풍선에도 그대로 찍힌다**(M4 에서
`#17 thinking 부장 ⏎ ⏎ <pasted_content id="8321"> ⏎ [REPORTS task#2 …` 로 관측). `thinking.text` 는 200자로
잘리므로 그 200자 중 앞자리를 봉투가 먹는다. 데몬이 저장할 때 벗길 것인가 앱이 그릴 때 벗길 것인가는
설계 결정이 필요하고 T48-3(맥 지원) 범위가 아니라 "남은 것" 으로 넘겼다.

### 12. M4 함정 ⑤ — codex 0.159 에서는 지시가 제출되지 않는다 (원인 미확정, 맵 문제는 **아니다**)

`codex` 를 설치하고(`npm i -g @openai/codex` → **0.159.0**) codex 부서를 만들었다. 부서 생성·출근·`idle`
까지는 됐는데 첫 지시가 들어가지 않았다:

```
task#1 → 부장
[daemon:info] 부장: 프롬프트가 안 들어가 Enter 를 다시 보냄 (1)…(4)
[daemon:warn] 부장: 지시가 입력 상자에 남아 제출되지 않았습니다 — 터미널 탭에서 Enter 를 쳐 주세요
```

사용량 쪽에서도 같은 말이 나왔다: `사용량 확인용 세션(codex): /status 화면이 뜨지 않았습니다 — CLI 문구가
바뀌었을 수 있습니다`.

**원인 확정을 위해 0.154.0 으로 내려 대조했더니 전부 됐다**(아래 검증) — 그래서 "버전 드리프트" 는 맞다.
그런데 **어디가 드리프트인지는 처음 짚은 것이 틀렸다.** 되돌린 뒤 0.159 로 따로 재현해 보니:

| 시험한 것 | 결과 |
|---|---|
| 0.154 맵으로 0.159 화면의 `promptReady` / `busy` 판정 | **맞는다** — `› Ask Codex to do anything` 은 그대로이고 `promptReady()=true`, 작업 중에는 `• Working (2s • esc to interrupt)` 로 `busy=true` |
| 평범한 타이핑 + Enter | **제출된다** |
| 데몬과 같은 **괄호 붙여넣기**(`ESC[200~ … ESC[201~`) + Enter | **제출된다** (`◦ Working (3s …)`) |

즉 **화면 패턴도, 붙여넣기 방식도 문제가 아니다.** 처음에 `attach` 출력에서 본
`›Ask Codex to do anything`(공백 없음)·`?forshortcuts` 는 **콘솔 클라이언트의 렌더링 아티팩트**였고 실제
화면은 `› Ask Codex to do anything`·`← for agents · ? for shortcuts` 다. 그걸 근거로 "시작 화면이 통째로
달라 패턴이 안 맞는다" 고 적었던 것은 취소한다.

남은 차이는 **데몬이 세션을 세우는 방식**뿐이다 — spawn 인자(`--dangerously-bypass-hook-trust`,
`-c approval_policy="on-request"`, `-c sandbox_mode="workspace-write"`, `-c mcp_servers.team.url=…`)와
cwd 에 놓이는 `.codex/hooks.json`(8종 hook). 특히 `UserPromptSubmit` hook 이 제출 경로에 끼어 있으므로
0.159 가 hook 을 다르게 다루면 지금 증상(글자는 들어갔고 제출만 안 된다)이 그대로 나온다. **거기까지는
좁혔고 확정은 못 했다** — 한 단계씩 인자를 붙여 가며 재현하는 일이 남았다.

이건 T48-3(맥 지원) 범위가 아니다(플랫폼 무관, 윈도우에서도 같을 것이다) → "남은 것".

## 검증

### M1 — 데몬

```
$ cd dev/daemon && npm install
added 108 packages … (allow-scripts 경고 → 함정 ① 참고)
$ npx tsc --noEmit
(출력 없음, exit 0)
```

고치기 **전**:

```
ℹ tests 870   ℹ pass 858   ℹ fail 4   ℹ skipped 8
✖ TeamToolsServer (T17) › T35 직급 강제 …
✖ test/office/MixedTeam.test.ts
✖ T30 데몬 단일 기동 가드 › pid 가 살아 있고 ws 포트가 열려 있으면 거부 …
✖ T30 데몬 단일 기동 가드 › 포트가 EADDRINUSE 면 같은 문구·같은 exit 3 …
```

고친 **뒤**:

```
$ npm test
ℹ tests 874   ℹ suites 143   ℹ pass 865   ℹ fail 0   ℹ skipped 9   ℹ duration_ms 46823
```

**윈도우 884 와 맞는다**: 874(등록된 것) + MixedTeam 스위트의 10건(픽스처가 없어 스킵, 등록조차 안 됨) = 884.
스킵 9건은 win32 전용 + 원래 스킵 8건이다(따옴표 수정으로 `log.test.ts` 의 win32 전용 1건이 새로 합류).

### M2 — 실행 파일 탐색·기동

`claude` 2.1.284 를 npm 전역으로 깔고 보니 **설계의 가정이 틀렸다** — 맥에서도 셰뱅 스크립트가 아니다:

```
$ ls -l $(which claude)
… bin/claude -> ../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
$ file …/bin/claude.exe
Mach-O 64-bit executable arm64          ← 네이티브 실행 파일. 이름만 `.exe` 다(맥에서도)
```

탐색은 그대로 잘 됐다(심볼릭 링크를 따라가 실제 파일을 확인하는 규칙이 이 모양도 통과시킨다):

```
$ npm start
[daemon] data dir : /Users/hjkim/Library/Application Support/pixel-office      ← 설계 표대로
[daemon] db        : …/pixel-office.db
[daemon] claude    : /Users/hjkim/.nvm/versions/node/v24.18.0/bin/claude        ← 실제 파일 절대 경로
[daemon] listening
```

`npmGlobalRoots` 도 이 맥의 nvm 뿌리까지 잡았다 — Homebrew, `/usr/local`, `~/.npm-global`,
`~/.nvm/versions/node/v24.18.0/lib/node_modules`.

### M2 보충 — claude 없을 때의 진단 (설치 전에 확인한 것)

```
dataDir       : /Users/hjkim/Library/Application Support/pixel-office     ← 설계 표대로
npmGlobalRoots: [ '/opt/homebrew/lib/node_modules',
                  '/usr/local/lib/node_modules',
                  '/Users/hjkim/.npm-global/lib/node_modules',
                  '/Users/hjkim/.nvm/versions/node/v24.18.0/lib/node_modules' ]   ← nvm 뿌리까지 잡는다
claude        : { exe: 'claude', found: false,
                  tried: [ 'PIXEL_CLAUDE_EXE 없음',
                           'PATH 에 claude 없음(셰뱅 스크립트도 실행 파일로 본다)',
                           'npm 전역에 @anthropic-ai/claude-code/bin/claude 없음' ] }
```

데몬은 맥에서 **끝까지 뜬다**:

```
$ PIXEL_DATA_DIR=… PIXEL_WS_PORT=17420 … node --import tsx src/index.ts
[daemon] data dir : …/pixel-office
[daemon] ws        : ws://127.0.0.1:17420
[daemon] db        : …/pixel-office.db
[daemon] claude 실행 파일을 못 찾았습니다 — 찾아본 곳: …
[daemon] listening
```

### 미지수 둘 — 대본이 "가장 큰 미지수" 로 꼽은 것을 준비 없이 확인

**① npm 이 설치한 `claude` 는 맥에서 셰뱅 스크립트다. 가짜 터미널로 그대로 띄워지나?**
npm 전역 bin 과 **같은 모양**(`#!/usr/bin/env node` + 심볼릭 링크)을 만들어 node-pty 로 띄웠다:

```
$ 직접 실행 파일 :  exit 0 | faux-cli up, tty=true, cols=100
$ 심볼릭 링크 경유:  exit 0 | faux-cli up, tty=true, cols=100
```

**된다** — 셰뱅 스크립트를 직접, 심볼릭 링크를 거쳐서도 진짜 TTY 로 띄운다(설계 표의 가정이 맞았다).
남은 것은 진짜 `claude` 바이너리로 같은 걸 보는 일뿐이다(M2·M3).

**② 터미널을 닫았을 때(SIGHUP) 정리가 끝까지 도나?**

```
$ node --import tsx -e "…createPlatform({platform:p}).shutdownSignals()…"
win32  [ 'SIGINT', 'SIGTERM' ]
darwin [ 'SIGINT', 'SIGTERM', 'SIGHUP' ]
linux  [ 'SIGINT', 'SIGTERM', 'SIGHUP' ]

$ kill -HUP <데몬 pid>
[daemon] SIGHUP — shutting down
[daemon] bye
$ (프로세스 사라짐, daemon.json 삭제됨 — 데이터 폴더에 pixel-office.db 만 남는다)
```

**된다** — SIGHUP 이 정상 종료 경로를 그대로 타고 `daemon.json` 까지 치운다.

### M7 — 앱

```
$ cd dev/app && flutter pub get
Changed 4 dependencies!        ← 이 맥의 Flutter 3.44.7 이 물고 온 transitive 버전 차이. 커밋에 넣지 않았다
$ flutter analyze
No issues found!               ← 단, ASCII 경로에서. 함정 ② 참고
```

고치기 **전** `flutter test`: `+715 ~2 -5` → `Some tests failed.` (실패 5건 = M7 함정 ①)
고친 **뒤**:

```
$ flutter test
00:11 +720 ~2: All tests passed!
```

720 통과 · 2 스킵(win32 전용 `killTree` 실기 1건, `OFFICE_PREVIEW_OUT` 미설정 1건) = 722.
윈도우의 721 과의 차이는 그 win32 전용 1건이다(맥에서는 스킵, 윈도우에서는 통과).

`flutter build macos --release` 는 **못 돌렸다** — 아래.

### M3~M5 — 실기 한 바퀴 (부서 만들기 → 지시 → 허가 → 보고)

M3: 첫 실행 신뢰 다이얼로그를 **darwin 전용 tui-map 없이** 그대로 통과했다.

```
$ npm run cli -- --exec "dept create 맥테스트 <sandbox> claude 부장" --wait-idle 부장
부서 생성: d_b7cded758e25  맥테스트  …/dev/spike-0/sandbox  head=m_935a0ab8ebe3
[daemon:info] 부장: passed first-run dialog (trust-folder-claude)
[daemon:info] 부장: passed first-run dialog (trust-folder-claude)
status 부장 → idle (free)
[daemon:info] 부장: passed first-run dialog (onboarding-enter)
```

M4: 지시 한 턴의 이벤트 표가 윈도우와 같은 순서로 흘렀다. 부장이 직접 쓰지 않고 팀을 만들어 위임했다
(D-32 대로).

```
$ npm run cli -- --exec "say 부장 sandbox 폴더에 mac-live.txt 를 만들고 …" --wait-idle 부장
task#1 → 부장
status 부장 → working (working)
#1 thinking 부장 [TASK#1 from user] ⏎ sandbox 폴더에 mac-live.txt 를 …
#2 running 부장 ToolSearch
#3 running 부장 mcp__team__create_team
status 실기팀장 → idle (free)
#4 running 부장 mcp__team__delegate
#5 delegating 부장 delegate — …  task#2
#6 thinking 실기팀장 [TASK#2 from 부장(부장)] ⏎ …
#8 idle 부장
```

M5: 허가 카드가 **유닉스 리다이렉션 쓰기**로 떴다(설계가 유닉스 패턴에 추가한 `> file` 그대로).

```
$ npm run cli -- --exec "pending"
a_acf48a4ffeec  approval  실기팀장  Bash printf '맥 실기 T48-3\n' > mac-live.txt && cat … && xxd …

$ npm run cli -- --exec "allow a_acf48a4ffeec" --wait-idle 실기팀장
#15 running 실기팀장 mcp__team__report
#16 reporting 실기팀장 파일 생성 완료. 경로: …/sandbox/mac-live.txt / 내용: '맥…  task#2
#17 thinking 부장 ⏎ [REPORTS task#2 실기팀장 status=done] …

$ cat dev/spike-0/sandbox/mac-live.txt
맥 실기 T48-3                                    ← 한글 내용 그대로
```

파생 상태도 맞았다 — `tree` 가 부장 `waiting_reports`, 팀장 `waiting_approval` 로 찍혔다.

### M14(데몬 쪽) — 사용량

`/usage`·`/status` 화면 파싱이 맥에서 그대로 됐다. **줄바꿈 차이가 없어 darwin 전용 tui-map 이 필요 없다.**

```
$ npm run cli -- --exec "usage"
claude  연결됨(max)  주간 94% 남음 (리셋 2026-09-30T03:00:00.000Z)  5시간 55% 남음 …  측정 …(turn)
    모델 Fable 93% 남음 (리셋 2026-09-30T03:00:00.000Z)
codex   연결 안 됨(설치 안 됨)
  부장 [claude]  컨텍스트 4% (44k/1.0M)  토큰 170k  $0.2592  …
  실기팀장 [claude]  컨텍스트 4% (41k/1.0M)  토큰 80k  $0.1535  …
```

### M7 — 빌드 산출물

```
$ flutter build macos --release
✓ Built build/macos/Build/Products/Release/pixel_office.app (36.0MB)

$ lipo -info …/pixel_office.app/Contents/MacOS/pixel_office
Non-fat file: … is architecture: arm64

$ codesign -d --entitlements - …/pixel_office.app
  com.apple.security.app-sandbox                 false      ← D-48 ⑥ 대로 꺼져 있다
  com.apple.security.files.user-selected.read-write  true
  com.apple.security.network.client               true
```

### M8 · M11 — Finder 더블클릭(데몬 없이) → 데몬 자동 기동 → 조직 복귀

데몬을 끄고 `open <app>`(Finder 더블클릭과 같은 경로)만 했다. 앱이 데몬을 스스로 띄웠다:

```
$ cat "~/Library/Application Support/pixel-office/daemon.log"
[app] --- 2026-09-29T16:05:13 앱이 데몬을 띄움:
      /Users/hjkim/.nvm/versions/node/v24.18.0/bin/node --import tsx src/index.ts
      (cwd …/dev/daemon) ---                     ← nvm 의 node 를 절대 경로로 찾았다(D-48 ③ 핵심)
[office] recover 부장(m_935a0ab8ebe3): --resume 86c409d2-…, assigned 1, requeued 0, expired 0
[office] recover 실기팀장(m_3142e993ca52): --resume 35f9cfa0-…, assigned 0, …, 말없이
[office] 복구: 2명 재개, 0건 만료, 말없이 1명                    ← M11: 조직이 그대로, 말없이
[office] 부모 감시  : pid 73703 (시작 시각까지 확인, …)          ← ps -o lstart 경로
[daemon] listening
```

앱 GUI 를 클릭할 권한은 없었지만 창은 확실히 열렸다 — 데이터 폴더·잠금 파일·ws·창 크기가 다 맞는다:

```
$ cat …/app.lock
{"pid":73703,"startedAt":"2026-09-29T16:04:45","image":"pixel_office"}   ← pid 재사용 가드(D-17)

$ lsof -nP -iTCP:7420 | grep ESTABLISHED
pixel_off 73703 … TCP 127.0.0.1:55986->127.0.0.1:7420 (ESTABLISHED)
node      73770 … TCP 127.0.0.1:7420->127.0.0.1:55986 (ESTABLISHED)

# CGWindowList 로 본 창
owner=픽셀 오피스 id=2753 1280x752      ← MainFlutterWindow.swift 의 setContentSize(1280×720) + 타이틀바 32
```

### M12 — 일하는 중 데몬 `kill -9` → 자동 재시작 + 유령 정리

```
$ kill -9 75770                                   (앱은 그대로 둔다)
→ 2초 안에 새 데몬 pid=75579

[app] --- 16:11:13 앱이 데몬을 띄움: …/bin/node --import tsx src/index.ts ---
[office] 복구: 이전 기동의 사용량 확인용 세션(claude, pid 73798)을 종료함
[office] 복구: 부장 의 이전 프로세스(pid 73779)가 살아 있어 종료함
[office] 복구: 실기팀장 의 이전 프로세스(pid 73780)가 살아 있어 종료함
[office] 복구: 2명 재개, 1건 만료, 말없이 1명, 유령 2개 정리
[office] 부모 감시  : pid 73703 …
[daemon] listening
```

**설계 표의 맥 행이 실제로 동작한 지점이다** — 프로세스 생존(`kill -0`), 이미지 이름(`ps -p <pid> -o comm=`),
트리 강제 종료(`ps -axo pid=,ppid=` → 자식부터 `kill -9`). 옛 pid 셋(73779·73780·73798)이 전부 죽은 것과
ws 가 새 데몬으로 다시 붙은 것을 확인했다.

### M13 — 앱 `kill -9` → 데몬이 부모 사라짐을 보고 스스로 정리

```
$ kill -9 73703                                   (16:11:37)
→ 5초 안에 데몬 종료 (16:11:41)

[office] 부모 앱이 사라졌다 (pid 73703) — 사무실을 정리하고 데몬을 종료합니다
[office] 종료: 세션 3개 닫음, 2명 잠시 닫힘(suspended)
[daemon] bye
```

claude CLI 3개 전부 종료, `daemon.json` 삭제. `app.lock` 은 남는다 — 앱이 강제로 죽어 못 치운 것이고,
다음 기동 때 pid + 이미지 이름으로 걸러내는 게 원래 설계다(D-17).

### M10 — Cmd+Q 와 같은 종료 경로가 `onExitRequested` 에 도달하는가

설계가 "맥은 Cmd+Q·Dock 종료도 같은 경로로 오는지 확인 목록에" 로 남겨 둔 미지수다. GUI 를 못 눌러
**Apple Event `quit`** 으로 확인했다 — NSApplication 의 종료 경로라 Cmd+Q·Dock 종료와 같은 길이다.

```
$ osascript -e 'tell application "픽셀 오피스" to quit'
execution error: pixel_office에 오류 발생: 사용자가 취소함. (-128)
```

**`-128`(userCancelled)이 답이다.** 그 값이 나오려면 앱이 이벤트에 "취소" 로 답해야 하고, 앱이 그렇게
답하는 곳은 `ExitFlow.onExitRequested` 의 `working > 0 → confirm(working)` → `AppExitResponse.cancel`
한 곳뿐이다(`lib/lifecycle/exit_flow.dart:150`). 즉 **종료 가로채기가 이 이벤트를 받는다** — 미지수 해소.
멤버가 일하는 중이었으므로 비상 퇴근 확인 대화상자가 떴고, 누를 사람이 없어 취소로 답한 것이다.

그 뒤 앱은 3초 안에 종료되고 데몬도 깨끗이 닫혔다(`종료: 세션 3개 닫음, 2명 잠시 닫힘(suspended)` → `bye`,
`daemon.json` 삭제). **다만 취소로 답한 뒤 왜 종료까지 갔는지는 확정하지 못했다** — 대화상자를 아무도
누르지 않은 상태라 "대화상자가 저절로 닫혔다" 와 "macOS 가 그래도 종료시켰다" 를 가릴 수 없다.
사람이 Cmd+Q 를 누르고 대화상자에서 "퇴근" 을 고르는 갈래가 M10 에 남아 있다.

### M17 — 창 캡처 스크립트

```
$ bash -n dev/app/tool/capture-window.sh            → OK
$ (스크립트에 든 swift 조각) "픽셀 오피스" "pixel_office"
2753                                                 → 창 id 조회 동작
```

`screencapture` 자체는 호출하지 않았다 — 화면 기록 권한 프롬프트가 뜨는 동작이라 사용자가 한 번
허용한 뒤부터 된다.

### M6 — 통합 테스트 4종

**파일 하나씩** 돌렸다(아래 함정 참고).

```
$ PIXEL_IT=1 node --import tsx --test --test-concurrency=1 <파일>

pty-integration              → exit=0  pass 1  fail 0     (진짜 claude 를 pty 로 띄워 프롬프트까지)
office-integration           → exit=0  pass 1  fail 0     (부서 생성 → 지시 → 허가 → 파일 → 퇴근 → shutdown)
office-askuser.integration   → exit=0  pass 1  fail 0     (ask_user → question.respond → [ANSWER] → 모델이 답을 말한다)
office-teamtools.integration → exit=0  pass 1  fail 0     (hire → delegate → 팀원 작업 → 보고 → 팀장 보고)
```

teamtools 는 처음에 실패했고 원인이 플랫폼이 아니라 CLI 버전이었다 — 위 "한 것" 11 번.

### M3~M6 · M14 (codex 0.154) — 코덱스 갈래

실행 파일 탐색이 **설계 표 그대로** 동작했다 — PATH 의 `bin/codex` 는 `bin/codex.js`(노드 shim)를 가리키는
심볼릭 링크인데, 그걸 건너뛰고 vendor 안의 네이티브 바이너리를 찾는다:

```
$ ls -l $(which codex)
… bin/codex -> ../lib/node_modules/@openai/codex/bin/codex.js        ← shim
$ (데몬의 resolveCodexExe)
/Users/hjkim/.nvm/…/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex
$ npm start
[daemon] codex     : …/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex
```

M3·M4 — 부서 생성 → 출근 → 지시 한 턴:

```
부서 생성: d_3f0b6856df26  코덱스테스트  …/dev/spike-0/sandbox  head=m_0d9705c49eb3
부장: m_0d9705c49eb3  부장 [codex] starting …
status 부장 → idle (free)
task#1 → 부장
#1 thinking 부장 [TASK#1 from user] ⏎ sandbox 폴더에 codex-live.txt 를 만들고 …
#2 running 부장 mcp__team__create_team
status 파일팀장 → idle (free)
#3 running 부장 mcp__team__delegate
#4 delegating 부장 delegate — 작업 폴더 루트에 codex-live.txt 파일을 만들고 …  task#2
#5 thinking 파일팀장 [TASK#2 from 부장(부장)] ⏎ …
#6 text 부장 파일 생성 작업을 팀장에게 위임했습니다. 완료 보고를 기다리고 있습니다.
#7 idle 부장
$ cat dev/spike-0/sandbox/codex-live.txt
코덱스 실기 T48-3                                  ← 한글 그대로
```

주입 텍스트에 `<pasted_content>` 봉투가 **붙지 않았다** — 그건 claude 쪽 동작이다(함정 11).

M5 — **작업 폴더 안 쓰기는 허가를 묻지 않는다.** `codex-live.txt` 는 카드 없이 만들어졌다(`pending` 0건).
`.codex/hooks.json` 에는 `PreToolUse`·`PermissionRequest` 까지 8종이 다 등록돼 있으므로 데몬 쪽 준비는
돼 있고, codex 가 신뢰된 작업 폴더 안의 쓰기를 스스로 허용한 것이다(02 §② · D-27 과 같은 성질).
허가 경로를 실제로 타게 하려고 **폴더 밖** 쓰기를 시켰더니 카드가 떴다:

```
#24 reading 부장 Bash ls -ld /private/tmp/…/scratchpad          ← codex 전용 이벤트 종류
#25 editing 부장 apply_patch /private/tmp/…/codex-outside.txt
#26 waiting_approval 부장 apply_patch …  approval=a_0a785e34a37d
$ allow a_0a785e34a37d
→ 파일 생성됨, 내용 "밖"
```

`reading`·`editing` 은 codex 명령 휴리스틱(`codexMapping.ts`)이 붙이는 종류다 — 맥에서 그대로 맞았다.

M14 — 두 엔진 사용량이 같이 들어온다. 0.154 에서는 `/status` 경고가 **나지 않는다**:

```
claude  연결됨(max)  주간 92% 남음  5시간 41% 남음  측정 …(probe)
    모델 Fable 93% 남음
codex   연결됨(pro)  주간 59% 남음 (리셋 2026-10-05T12:13:26.000Z)  5시간 -  측정 …(turn)
  부장 [codex]    컨텍스트 10% (26k/258k)  토큰 342k  -
  파일팀장 [codex]  컨텍스트 10% (26k/258k)  토큰 186k  -
```

(codex 는 5시간 한도와 비용을 보고하지 않아 `-` 다.)

M6 — `codex.integration.test.ts`:

```
$ PIXEL_IT=1 node --import tsx --test --test-concurrency=1 test/office/codex.integration.test.ts
[IT] allow → a_787537ecbc61 (9700ms)
[IT] turn ended (12204ms): ["완료했습니다."]
[IT] …/dev/spike-0/t20.txt = "t20\n"
[IT] reporting #6 task#1 {"summary":"완료했습니다."}
[IT] session_id after first turn = 01a0ec5b-d68c-7672-be19-eae5fdf3c71e
[IT] clockOut done (15903ms); codex pid 85758 alive=false
[IT] daemon exited=true code=0 (16738ms)
ℹ pass 1   ℹ fail 0
```

**혼합 팀(claude 부장 + codex 팀원)은 실기로 보지 않았다** — 대본에 없고, 두 엔진을 따로 끝까지 봤다.
단위 테스트 `MixedTeam` 은 픽스처가 없어 스킵된다(함정 ⑤).

## 발견한 함정

M1 ①~⑤, M7 ①③④ 와 M2 의 문구는 위 "한 것" 에 있다. 저장소가 고칠 것이 없는 환경·도구 함정을 여기 적는다.

### M7 함정 ② — 경로에 한글이 있으면 `flutter analyze` 가 크래시한다

```
$ cd ~/Desktop/포트폴리오/pixel-office-dev/dev/app && flutter analyze
Unhandled exception:
FormatException: Unterminated string (at character 524)
...84%8B%E1%85%A9/pixel-office-dev/dev/app/"}],"capabilities":{"window":{"work
                                                                              ^
#6  LspByteStreamServerChannel._readMessage (package:analysis_server/src/lsp/channel/lsp_byte_stream_channel.dart:96)
analysis server exited with code 255
```

LSP 의 `Content-Length` 가 **바이트 수와 문자 수 사이에서 어긋나** 첫 메시지가 잘린다.
같은 커밋을 ASCII 경로(`/private/tmp/.../ascii-clone`)에 클론해 대조했다:

```
$ cd <ASCII 경로>/dev/app && flutter analyze
No issues found! (ran in 1.5s)
```

**Flutter/Dart 툴체인 쪽 문제**이고 저장소가 고칠 것은 없다. 맥에서 이 저장소를 볼 때는
**경로에 한글·비ASCII 문자가 없는 곳에 두라**. `flutter test` 와 `flutter pub get` 은 한글 경로에서도
정상이었다(analysis server 만 깨진다).

### 환경 함정 — 이 맥의 git·flutter 가 Xcode 라이선스에 막혀 있었다

`/usr/bin/git`·`xcodebuild`·`flutter` 가 전부 이렇게 거부한다:

```
You have not agreed to the Xcode license agreements.
Please run 'sudo xcodebuild -license' from within a Terminal window …
```

git 과 flutter 는 `DEVELOPER_DIR=/Library/Developer/CommandLineTools` 로 우회해 M1·M7 을 끝냈다.
`flutter build macos` 는 진짜 Xcode 가 필요해 우회가 안 된다(아래).

### M6 함정 — 통합 테스트를 여러 파일 한 번에 돌리면 엉킨다

처음에 `node --test` 에 통합 테스트 파일 6개를 한 번에 줬다. node 의 테스트 러너는 **파일을 병렬로**
돌리므로 실기 CLI 세션이 여러 벌 동시에 떴다(임시 폴더 `pixel-office-t25-it-…` 와 `…-t35-it-…` 가 같은
시각에 살아 있는 것을 확인). 두 파일이 각자 끝까지 갔는데도 진행이 5분 넘게 멈췄다.

파일 하나씩(`--test-concurrency=1`, 파일도 한 번에 하나) 돌리면 멀쩡하다. 플랫폼과 무관한 성질이고
(윈도우에서도 같을 것이다) 실기 테스트는 원래 한 번에 하나 돌리는 것이 맞다 — 진짜 CLI·포트·셸 락을
공유하기 때문이다. 대본을 따를 때는 **파일 단위로 순차 실행**할 것.

### 앱 GUI 를 직접 누르지 못했다

M9·M15·M16 과 M10 의 마지막 갈래는 앱 창을 클릭·타이핑해야 한다. 이 세션에서는 앱 제어 권한이 승인되지
않아 하지 못했다. 코드 문제가 아니고, 대신 확인할 수 있는 것은 전부 다른 경로로 확인했다(엔타이틀먼트는
`codesign -d --entitlements`, 창 크기는 CGWindowList, Cmd+Q 경로는 Apple Event).

## 결정

**D-49** — 맥 앱은 arch 하나로 빌드한다(유니버설 포기) + 배포 대상 12.0. Xcode 27 의 `lipo` 와 Flutter
3.44.7 템플릿 비호환 우회이고, Flutter 가 고치면 두 줄만 지우면 된다(전문은 04). D-48 ⑦(darwin tui-map)은
필요 없어졌고, D-48 의 "claude 는 맥에서 셰뱅 스크립트" 는 사실이 아니었다 — 둘 다 D-49 결과·근거에 적었다.

그 밖에 새 결정은 없다. 고친 것은 두 갈래다.

**D-48 원칙 4 로 되돌린 것**(테스트 일곱 건: 데몬 2 · 앱 5). T48-1·T48-2 가 "맥 분기는 플랫폼을 주입해
검증한다" 를 세웠는데 이 일곱 건은 주입 없이 호스트에 물어 윈도우에서만 우연히 맞고 있었다. 구현은 전부
맞았다 — 맥 문구·맥 경로 규칙·`npm` 이름이 정확히 나왔고 테스트가 옛 윈도우 문자열을 들고 있었을 뿐이다.

**저장소 바깥 사정에 맞춘 것**(D-48 과 무관). M1 함정 ①②⑤ 는 새 클론·새 npm 에서의 재현성 문제이고,
M7 함정 ③④ 는 Xcode 27 × Flutter 3.44.7 비호환이다. 후자는 `macos/` 만 건드려 윈도우 동작은 그대로다
(D-48 원칙 3). 유니버설 바이너리를 포기한 것만 제품이 눈에 보이게 달라진 점인데, 개인 도구이고
배포·공증이 D-48 범위 밖이라 받아들였다 — Flutter 가 `lipo` arg 순서를 고치면 xcconfig 한 줄을 지우면
원래대로 돌아간다.

**설계 문서에서 틀렸던 것 하나**: "npm 이 설치한 `claude` 는 맥에서 셰뱅 스크립트" 는 사실이 아니다
(2.1.284 는 `bin/claude` → `bin/claude.exe` 심볼릭 링크이고 그 파일이 **Mach-O arm64 네이티브**다 —
맥에서도 이름이 `.exe`). 탐색 규칙은 그 모양도 통과시키므로 코드는 고칠 것이 없다. 셰뱅 스크립트를
node-pty 로 띄울 수 있다는 가정 자체는 따로 확인해 뒀다(위 "미지수 둘" ①) — 언젠가 배포 형태가 바뀌어도
버티는지 본 셈이다.

## 남은 것

**사람이 앱 창을 눌러야 하는 넷.** 앱은 빌드돼 있고(`dev/app/build/macos/Build/Products/Release/pixel_office.app`)
그냥 열면 된다. 순서대로:

1. **M9** — 앱에서 부서 만들기 → "폴더 선택…" 이 네이티브 대화상자로 뜨는지, 고른 폴더로 부장이 출근하는지.
   (엔타이틀먼트는 바이너리에서 확인해 뒀으니 막힐 이유는 없다.)
2. **M15** — `Cmd+K/L/T/I/R` 로 지시 바·로그·터미널·지시문·보고서가 열리는지, 인박스 맨 위 카드가
   `Cmd+Shift+Y` / `Cmd+Shift+N` 으로 허가·거부되는지.
3. **M16** — 레티나(devicePixelRatio 2)에서 픽셀 서체(Galmuri11)와 스프라이트가 흐리지 않은지.
   `spriteScale` 이 정수로 떨어지는지가 핵심이다.
4. **M10 의 마지막 갈래** — 멤버가 일하는 중에 **Cmd+Q** → 비상 퇴근 확인 대화상자에서 "퇴근" 을 고르고
   `ps aux | grep -E "claude|pixel_office"` 가 비는지. (이벤트가 가로채기에 도달하는 것은 확인했다.)

**M17 캡처** — 위 넷을 하면서 증거를 남기려면 한 번 권한을 허용해야 한다. 처음 실행 때 macOS 가
"화면 기록" 을 물어본다:

```bash
dev/app/tool/capture-window.sh -o docs/worklog/img/T48-3-office.png
```

**`<pasted_content>` 봉투가 사용자 로그에 그대로 찍힌다** (T48-3 범위 밖, 플랫폼 무관). claude 2.1.284 가
긴 주입 텍스트를 감싸는 봉투가 `thinking.text` 에 그대로 들어가 사무실 로그·말풍선에 보인다:

```
#17 thinking 부장 ⏎  ⏎ <pasted_content id="8321"> ⏎ [REPORTS task#2 실기팀장 status=done] ⏎ …
```

`thinking.text` 는 200자로 잘리므로 그 앞자리를 봉투가 먹는다. 데몬이 저장할 때 벗길지(모든 소비자가
깨끗해진다) 앱이 그릴 때 벗길지(원문은 보존된다)는 결정이 필요하고, 저장 데이터가 바뀌면 04 에 D-## 로
적어야 한다. 테스트 쪽은 `unwrapPasted()` 로 막아 뒀으니 급하지는 않다.

**tui-map 이 고정 버전에 묶여 있다** (T48-3 범위 밖, 플랫폼 무관, 다음 과제 후보). 화면 패턴 로더는
설치된 CLI 버전을 읽지 않고 내장 상수(`BUILTIN_VERSION`)를 쓴다. 이번 실기에서 **두 엔진 다** 그 드리프트에
걸렸다:

| 엔진 | 프로젝트가 맞춘 버전 | 이 맥에 설치된 것 | 증상 |
|---|---|---|---|
| claude | 2.1(D-24 는 2.1.270) | 2.1.284 | 긴 주입 텍스트에 `<pasted_content>` 봉투 — 통합 테스트 필터가 깨졌고(고침) 사용자 로그에도 찍힌다(위) |
| codex | 0.154 | 0.159.0 | **지시가 제출되지 않는다** — 단 화면 패턴·붙여넣기는 0.159 에서도 정상이다(함정 ⑤ 표). 원인은 데몬의 세션 설정(spawn 인자·hooks)쪽으로 좁혔고 **미확정** |

할 일은 셋이다. ① **codex 0.159 의 제출 실패 원인을 끝까지 좁히기** — 맵이 아니라는 것까지는 확인했으니
(함정 ⑤) spawn 인자와 `.codex/hooks.json` 을 하나씩 붙여 가며 재현하는 일이 남았다. ② claude 2.1.284 의
`<pasted_content>` 봉투를 어디서 벗길지 정하기(위 항목). ③ **로더가 설치된 CLI 버전을 읽게** 하기 — ①이
맵 문제가 아니었으니 급한 수정은 아니지만, 두 엔진 다 버전이 앞서 나가 있는 상태 자체가 위험 신호다
(내장 상수는 claude 2.1 · codex 0.154, 설치된 것은 2.1.284 · 0.159.0). 셋 다 윈도우에서 해도 된다.

**이 맥에는 최신 codex(0.159.0)가 깔려 있다** — 확인이 끝난 뒤 되돌렸다. 즉 **지금 이 저장소로 코덱스
멤버를 띄우면 지시가 들어가지 않는다.** 쓰려면 `npm i -g @openai/codex@0.154.0` 으로 내려야 하는데, 그게
정상은 아니다 — **최신 CLI 에서 동작하는 것이 맞고**, 그러려면 위 ①(로더가 설치된 버전을 읽게 + 0.159 맵)이
실제 고칠 지점이다. 버전 고정은 임시 방편으로만 적어 둔다.

**남긴 상태.** 없다 — 사용자 요청으로 실기 데이터를 전부 지웠다. `~/Library/Application Support/pixel-office/`
는 비어 있고(부서 `맥테스트`·`코덱스테스트` 와 멤버 전부 포함), `dev/spike-0/sandbox/` 에는 `README.txt` 만
남겼다(통합 테스트가 그 경로를 신뢰된 작업 폴더로 쓴다). 앱 빌드 산출물
(`dev/app/build/macos/…/pixel_office.app`, 34M)은 M9·M15·M16 을 하려면 필요해서 그대로 뒀다.
