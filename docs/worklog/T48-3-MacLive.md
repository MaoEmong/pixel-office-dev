# T48-3 — 맥 실기 (2단계 대본 M1~M17)

- 날짜: 2026-09-29
- 마일스톤: M6
- 관련 설계: `docs/design/맥-지원.md` "2단계 대본" M1~M17 / D-48 / 짝 T48-1(데몬)·T48-2(앱)
- 커밋: `9dfe30d`(데몬 소스) `75e8ec6`(데몬 테스트) `c5a4010`(앱 테스트) + 이 문서
- 브랜치: `T48-3` (아직 푸시하지 않았다)
- 실기 환경: **macOS 26.6.2 (25G83) · arm64** / Node v24.18.0 · npm 11.16.0 / Flutter 3.44.7 · Dart 3.12.2 /
  CocoaPods 1.17.0 / Xcode 27.0 **설치돼 있으나 라이선스 미동의**
- 저장소 위치: `~/Desktop/포트폴리오/pixel-office-dev` (경로에 **한글**이 들어 있다 — M7 함정 ②)

## 목표

T48-1·T48-2 가 윈도우에서 "플랫폼을 주입해" 고정해 둔 맥 분기를, **진짜 맥에서** 대본 M1~M17 대로 돌려
맞는지 본다. 어긋난 것은 고치고, 맥에서만 드러나는 것은 기록한다.

## 결과 요약

| # | 확인 | 결과 |
|---|---|---|
| M1 | 데몬 `npm install` → `tsc --noEmit` → `npm test` | **통과** (함정 4개를 고친 뒤 — 아래) |
| M2 | `npm start` 로그의 실행 파일 탐색 | **부분** — 탐색 뿌리·데이터 폴더·기동·종료는 확인, `claude` 자체는 미설치 |
| M3 | `dept create` → 신뢰 다이얼로그 → idle | **막힘** (`claude` 미설치·미로그인) |
| M4 | `say` 한 턴의 이벤트 순서 | **막힘** (동일) |
| M5 | 쓰기 명령 허가 → `approve` | **막힘** (동일) |
| M6 | `PIXEL_IT=1` 통합 테스트 4종 | **막힘** (동일) |
| M7 | 앱 `pub get` · `analyze` · `test` · `build macos --release` | **부분** — 앞 셋 통과(함정 2개 고침), 빌드는 **막힘**(Xcode 라이선스) |
| M8~M17 | Finder 실행·폴더 선택·Cmd+Q·재기동·kill -9·사용량·단축키·레티나·창 캡처 | **막힘** (M7 빌드 산출물이 없다) |

막힌 것의 원인은 코드가 아니라 **이 맥의 사전 준비 두 가지**다 → "남은 것" 에 정확한 명령을 적어 뒀다.
대본이 "가장 큰 미지수" 로 꼽은 둘은 준비 없이도 확인할 길이 있어 **먼저 확인했다**(아래 "미지수 둘").

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

### M2 — 실행 파일 탐색·기동·종료 (claude 없이 확인한 것)

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

## 발견한 함정

M1 ①~⑤, M7 ①은 위 "한 것" 에 있다. 코드와 무관한 환경 함정 둘을 더 적는다.

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

## 결정

새 결정 없음. 고친 것은 전부 D-48 원칙 3("윈도우 동작은 1비트도 바뀌지 않는다")과
원칙 4("맥 분기는 플랫폼을 주입해 검증한다") 안에서의 수정이다 — 원칙 4 를 **지키지 못하고 있던 테스트
여섯 건**(데몬 2 · 앱 5 중 겹침 제외)을 원칙대로 되돌린 것이다.

M1 함정 ①②⑤ 는 플랫폼 분기가 아니라 **새 클론·새 npm 에서의 재현성** 문제라 D-48 과 무관하다.

## 남은 것

M3~M6 · M8~M17 은 **코드 문제로 막힌 것이 아니다.** 이 맥에 사전 준비 두 가지가 빠져 있다.

**① Xcode 라이선스 동의** — M7 의 `flutter build macos --release` 와 그 뒤 M8~M17 전부가 여기 걸려 있다.
Xcode 27.0 은 이미 설치돼 있고 `xcode-select -p` 도 Xcode.app 을 가리킨다. 비밀번호가 필요해 내가 못 돌린다:

```bash
sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch
```

**② `claude` 설치 + 로그인** — M2 의 나머지와 M3~M6 이 여기 걸려 있다. 로그인은 대화형이라 내가 못 한다:

```bash
npm install -g @anthropic-ai/claude-code && claude
```

설치 직후 **함정 ①** 이 다시 나올 수 있다(npm 11.16+). `claude` 가 pty 에서 안 뜨면:

```bash
npm approve-scripts --allow-scripts-pending    # dev/daemon 에서
```

(선택) M4~M6 의 Codex 갈래를 보려면 `codex` 도 설치·로그인. 지금은 없어서
`resolveCodexExe()` 가 `'codex'` 를 그대로 돌려준다 — `claude` 쪽처럼 "못 찾았다" 를 말하지 않는다.
윈도우도 같은 동작이라 맥 회귀는 아니지만, 실패가 spawn 시점까지 미뤄진다는 점은 적어 둔다.

준비가 끝나면 M2 의 나머지부터 M17 까지 이어서 돌리고 이 문서에 표를 채운다.
`tool/capture-window.sh`(M17) 는 아직 안 만들었다 — M8 이 열리는 시점에 만든다.
