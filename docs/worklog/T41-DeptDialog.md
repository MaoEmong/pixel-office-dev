# T41 — 부서 만들기 다이얼로그 개선 + 연결 진단

- 날짜: 2026-09-17
- 마일스톤: M6
- 관련 설계: `docs/design/레이아웃-v2.md` §3 패스 2(빈 상태·로딩 3종, D10·D11) · 패스 3 스토리보드 3~4단계
- 사용자 요청(그대로): "부서 생성할때 작업 폴더를 입력하는게 아니라 폴더 선택으로 바꾸자.
  부서 이름이랑 부장 이름은 디폴트값으로 넣어두자."
- 커밋: `fb58dcd`(T41-1 폴더 선택·기본값) · `f8aba7b`(T41-2 연결 진단) · `155ce4e`(T41-3 claude 실행 파일) ·
  `3d45a3e`(T41-4 포트 가드) · 이 문서(T41-5)

## 목표

첫 실행 스토리보드 3~4단계("빈 사무실 → 부서 만들기")에서 **손으로 칠 것을 0 으로** 만든다. 끝나면
① 작업 폴더는 네이티브 폴더 선택기로 고르고(칸은 붙여넣기 폴백으로 남는다), ② 부서 이름·부장 이름·엔진이
기본값으로 차 있어 **폴더만 고르면 한 글자도 안 치고** 부서가 생기며, ③ 폴더가 없으면 만들기가 아예 안 켜진다.

여기에 오늘 실기에서 난 연결 사고 둘을 같이 막는다: ④ "daemon.json 없음" 이 **어느 경로를 봤는지** 말하고,
⑤ 데몬이 포트 충돌로 못 뜨면 스택 트레이스 대신 사람이 읽는 한 문단(exit 3)으로 끝나며,
⑥ claude 실행 파일 경로에 박혀 있던 **번들 버전 폴더**를 없앤다.

## 한 것

### T41-1 폴더 선택 + 기본값 (`dev/app/lib/topbar/top_bar.dart`, `lib/panel/ui_prefs.dart`)

- `file_selector: ^1.1.0`(flutter.dev 공식, Windows 는 `file_selector_windows` → 네이티브 `IFileDialog`) 추가.
  `pickDepartmentFolder()` = `getDirectoryPath(initialDirectory:, confirmButtonText: '이 폴더로')`.
- `CreateDepartmentDialog(pickDirectory:)` — 선택기는 **위젯 파라미터로 주입**한다. 테스트는 네이티브 창을
  절대 열지 않는다. `showCreateDepartmentDialog(context, pickDirectory:)` 도 같은 파라미터를 받는다
  (main.dart 의 빈 사무실 큰 버튼은 기본값 그대로).
- cwd 칸은 **읽기 전용이 아니다** — 붙여넣기·직접 입력 폴백이 살아 있고, 선택기로 고르든 손으로 치든
  `_onCwdChanged` 한 길로 모인다(이름 기본값 + 폴더 존재 확인).
- **만들기 버튼은 폴더가 실제로 있을 때만 켜진다.** 없으면 `그런 폴더가 없습니다 — "폴더 선택…" 으로 고르세요`,
  아직 안 골랐으면 버튼 옆에 이유(`작업 폴더를 골라야 만들 수 있습니다`).
- 기본값: 이름 = `departmentNameForPath(폴더)`(마지막 조각, `D:\` → `D`), 부장 이름 = `부장`, 엔진 = `claude`.
  이름은 사용자가 손댈 때까지만 폴더를 따라간다(dirty 플래그 — 칸을 비우면 다시 따라간다).
- 선택기의 시작 폴더: 마지막으로 고른 폴더의 **부모**를 `app-ui.json` 의 `lastDepartmentDir` 에 남긴다
  (`lastDepartmentDirProvider.initialDir()` 은 저장값을 다 읽은 뒤 준다).

### T41-2 연결 진단 (`lib/rpc/daemon_info.dart`, `rpc_client.dart`, `topbar/disconnected_overlay.dart`, `daemon_launcher.dart`)

- `daemonJsonMissingMessage([env])` → `daemon.json 없음(데몬 미기동) — 찾은 곳: <경로> · PIXEL_DATA_DIR 없음 ·
  LOCALAPPDATA 있음`. 경로를 정할 수조차 없으면 그렇다고 말한다.
- `RpcClient(noDaemonInfoMessage:)` 로 주입 — rpc 층은 파일 경로를 모르는 채로 둔다. `rpcClientProvider` 가 넣는다.
- 오버레이 `자세히`: **오류가 없을 때도 열리고** 안에 `daemon.json: <경로>` + 한 줄 힌트(`daemonPathHint`)
  "데몬을 아직 안 띄웠으면 '데몬 시작' — 다른 환경(샌드박스·다른 사용자)에서 띄운 데몬은 이 경로에 파일을
  쓰지 않습니다". 접혀 있을 때의 동작(스택 트레이스를 안 뿌린다)은 그대로.
- `데몬 시작` 은 `cmd /c start` 분리 실행이라 종료 코드를 못 본다 → 6초(`daemonStartTimeout`) 뒤 daemon.json 이
  안 생겼으면 `데몬이 뜨지 않았습니다 — dev/daemon 콘솔 창의 오류를 확인하세요 (포트 7420~7422 를 다른 데몬이
  쓰고 있을 수 있음)`. 확인 함수는 주입식(`checkDaemonJson`).

### T41-3 claude 실행 파일 (`dev/daemon/src/config.ts`)

`config.claudeExe` 가 `%APPDATA%\Claude\claude-code\**2.1.270**\claude.exe` 를 박고 있었다. 샌드박스 밖에서 띄운
데몬이 `dept create` 에서 `-32000 File not found: ...\2.1.270\claude.exe` 로 죽은 원인이다.
`resolveClaudeExe(env, platform)`: ① `PIXEL_CLAUDE_EXE` ② PATH 의 진짜 실행 파일(셰임 제외) ③ 번들의 **가장 높은
버전 폴더**(숫자 비교, 그 버전에 exe 가 없으면 다음 버전) ④ 폴백 `'claude'` + `tried`(찾아본 곳). 기동 로그에
`[daemon] claude : <경로>`(못 찾으면 찾아본 곳 + `PIXEL_CLAUDE_EXE` 안내)와 `[daemon] codex : …` 를 찍는다.
codex 쪽은 이미 vendor 트리를 스캔하므로 손대지 않았다.

### T41-4 포트 가드 (`dev/daemon/src/office/singleton.ts`, `Office.ts`, `index.ts`)

T30 의 단일 기동 가드는 **daemon.json 을 볼 수 있을 때만** 작동한다. 다른 환경에서 띄운 데몬은 자기
`%LOCALAPPDATA%` 에 파일을 쓰므로 pid 검사를 통과하고, 그다음 바인딩이 EADDRINUSE 로 터져 **잡히지 않은 스택
트레이스**가 나왔다.

- `DaemonStartRefusedError`(공통 조상, exit 3) ← `DaemonAlreadyRunningError`(기존) / `DaemonPortInUseError`(신규).
- `bindOrRefuse(role, port, daemonJsonPath, listen)` 이 EADDRINUSE 만 바꾸고 나머지는 그대로 올린다
  (`isAddrInUse` 는 `cause` 사슬까지 본다). `Office.start()` 가 hook·mcp 를, `index.ts` 가 ws 를 감싼다.
- 문구는 pid 거부와 **같은 첫 문장**(`이미 데몬이 돌고 있습니다`) + 포트 번호 ·
  `netstat -ano | findstr :<포트>` → `taskkill /F /PID <pid>` · 포트 환경변수 · daemon.json 경로.
- hook·mcp 에서 거부되면 daemon.json 을 **쓰기 전에** 멈추고, ws 에서 거부되면 이미 쓴 파일을 `shutdown()` 이 지운다.

### T41-5 문서

이 문서 · `dev/app/README.md`(상단 바 절에 폴더 선택·기본값, "daemon.json 은 어디서 읽나" 아래 **안 붙을 때**
문단, 테스트 건수·의존성·구조) · `dev/daemon/README.md`(머리말 포트 가드 한 줄, 환경변수 절의
`PIXEL_CLAUDE_EXE` 자동 탐지, 테스트 건수).

## 검증

```
$ cd dev/app && flutter analyze
No issues found!
$ flutter test
00:19 +446 ~1: All tests passed!          (431 +1 → 446 +1, +15)

$ cd dev/daemon && npx tsc --noEmit       # 출력 없음
$ npm test
ℹ tests 518   ℹ pass 511   ℹ fail 0   ℹ skipped 7      (509 → 518, +9)
```

새 테스트:

| 파일 | 건수 | 보는 것 |
|---|---|---|
| `dev/app/test/command/create_department_test.dart` | 8 | `departmentNameForPath`·`parentDirOf` / 폴더 선택 → 기본값 + 무타이핑 제출 / 이름 dirty / 취소·선택기 예외 / 손입력 폴백·없는 폴더 / 시작 폴더 기억·복원 |
| `dev/app/test/daemon_info_test.dart` | 4 | 경로 규칙(PIXEL_DATA_DIR·LOCALAPPDATA) / 진단 문구에 **경로와 환경변수 유무** / 경로 불가 / read 파싱 |
| `dev/app/test/command/daemon_launcher_test.dart` | +2 | 6초 타임아웃 문구(포트 7420~7422) / daemon.json 이 생기면 안 띄운다 |
| `dev/app/test/command/overlay_test.dart` | +1 | `자세히` 에 오류가 없어도 경로 + 힌트 |
| `dev/daemon/test/office/Singleton.test.ts` | +3 | EADDRINUSE → 같은 문구·exit 3·포트 번호 / 다른 오류는 그대로 · `isAddrInUse(cause)` / `Office.start()` 가 daemon.json 을 안 남긴다 |
| `dev/daemon/test/config/claudeExe.test.ts` | 6 | env 우선 / PATH 우선(셰임 제외) / 2.1.266·2.1.270·2.1.99·2.1.301 → **2.1.301** / 버전 아닌 폴더 무시 / 폴백 + 찾아본 곳 / win32 아니면 번들 안 봄 |

기존 테스트 수정: `top_bar_test.dart` 의 부서 만들기 3건(빈 칸 오류 → **버튼 비활성 + 폴더 검사**, headName 기본값),
`rpc_client_test.dart` 의 daemon.json 없음 1건(주입 문구 확인), `overlay_test.dart` 의 `자세히` 1건.

**실기는 안 했다** — 사용자가 진짜 데몬(포트 7420~7422)을 쓰고 있어 둘째 데몬·앱 창을 띄우면 충돌한다.
아래 "남은 것" 의 실기 확인 목록을 코디네이터가 대신 봐야 한다.

## 발견한 함정

1. **위젯 테스트에서 `dart:io` 의 Future 는 영영 안 끝난다.** `testWidgets` 안에서 `await Directory(p).exists()`
   를 부르면 fake-async 존이라 실제 이벤트 루프가 안 돌고, `pumpAndSettle` 이 **1분 55초 뒤 "did not complete"**
   로 죽는다(실측). `tester.runAsync` 로 감싸거나 — 여기서는 — 파일시스템 확인을 `directoryExistsProvider` 로
   빼서 테스트가 갈아끼운다. 같은 이유로 `DaemonStartButton.checkDaemonJson` 도 주입식이다.
2. **`TextField.onChanged` 는 사용자가 칠 때만 부른다.** 컨트롤러에 `text = ...` 를 넣으면 안 불린다 — 그래서
   이름 dirty 플래그를 `onChanged` 로 잡아도 "폴더 선택이 이름을 채우는 것" 과 안 부딪친다(운 좋게가 아니라
   이 성질에 기대고 있다). 반대로 **컨트롤러 리스너는 양쪽 다** 불리므로 cwd 쪽은 리스너로 묶었다.
3. **저장된 prefs 는 다이얼로그를 여는 순간 아직 안 차 있다.** `Notifier.build()` 가 비동기로 읽으므로
   `ref.read(provider)` 는 null 을 준다. `initialDir()` 처럼 **로드 Future 를 기다려 주는 접근자**가 필요하다.
4. **`cmd /c start` 로 띄운 데몬은 종료 코드를 못 본다.** 분리 실행이라 `Process.start` 의 exitCode 는 `start`
   자신의 것이다. "떴는지" 는 daemon.json 으로만 알 수 있다 → 타임아웃 확인.
5. **`%LOCALAPPDATA%` 는 환경마다 다른 폴더다.** 샌드박스·다른 사용자로 띄운 데몬은 daemon.json 을 다른 곳에
   쓰면서 **포트는 공유**한다. 그래서 "파일 없음 → 포트는 사용 중" 조합이 생기고, T30 가드가 이걸 못 잡았다.
6. **`Office.shutdown()` 은 `'shutdown'` 이벤트를 쏜다.** `index.ts` 에서 ws 실패 처리로 shutdown 을 부를 때
   그 리스너(`process.exit(0)`)가 이미 붙어 있으면 **exit 3 이 0 으로 바뀐다.** 리스너 등록 **전에** 부르도록
   순서를 지켰다.
7. **번들 버전 폴더 정렬은 문자열로 하면 틀린다** — `2.1.99` 가 `2.1.301` 을 이긴다. 숫자 조각 비교로 했다.

## 결정

새 결정 기록(D-##) 없음 — 전부 기존 결정(D-32 부서 만들기 = 부장 임명, D-40 데몬 하나만, D10/D11 로딩·빈 상태)의
구현·보강이다. 이 태스크에서 굳힌 작은 규칙 셋(문서에만 남긴다):

- 부서 만들기의 **유일한 필수 입력은 폴더**다. 나머지는 전부 기본값이 있고, 버튼은 폴더가 실제로 있을 때만 켜진다.
- 연결 실패 문구에는 **항상 찾아본 경로**가 들어간다("없다" 만으로는 다음 행동을 못 고른다).
- 기동 거부는 **한 문단 + exit 3** 하나로 모은다(pid 든 포트든 사용자가 할 일은 같다).

## 남은 것

- **실기(코디네이터 몫)**: ① 폴더 선택 버튼이 네이티브 창을 열고 취소/선택이 다 되는지 ② 폴더만 고르고
  `만들기` 를 눌러 부장이 출근하는지 ③ 두 번째 데몬을 띄웠을 때 콘솔에 `이미 데몬이 돌고 있습니다` + exit 3 이
  뜨는지(지금 도는 데몬이 있으므로 이건 **의도적으로** 확인할 수 있다) ④ 샌드박스 밖 환경에서
  `[daemon] claude : <경로>` 가 실제 설치 버전을 가리키는지(이 환경에서는 2.1.270 이 최신이라 예전 값과 같다).
- `file_selector` 를 넣으면서 Windows 플러그인 등록 파일(`windows/flutter/generated_plugin*`)이 바뀌었다 —
  **릴리즈 빌드(`flutter build windows`)는 아직 안 돌려 봤다.** 다음에 빌드할 때 한 번 확인할 것.
- 폴더 선택기의 `confirmButtonText: '이 폴더로'` 는 Windows 에서만 보인다(다른 플랫폼은 무시). 앱이 Windows
  전용이라 문제는 없다.
- 부서 만들기 다이얼로그는 아직 **"최근 폴더 목록"** 이 없다(시작 폴더 하나만 기억한다). 부서를 자주 만들게
  되면 그때 다시 본다.

## 실기 확인 (Fable, 2026-09-17)

- 새 빌드로 데몬 pid 12076 에 붙어 "부서 만들기" 다이얼로그를 열었다 — `img/T41-1-dialog.png`: "폴더 선택…" 버튼, 부서 이름 기본값, 부장 이름 `부장`, 엔진 claude, 폴더 전이라 만들기 비활성("작업 폴더를 골라야 만들 수 있습니다").
- 두 번째 데몬 기동 → `이미 데몬이 돌고 있습니다 — pid 31140 (ws 127.0.0.1:7420)` + exit 3 확인.
- 이 머신 제약: Claude 앱 환경 밖에는 `claude.exe` 가 없어(번들은 가상화 환경 안) 앱·데몬은 그 안에서 띄운다(memory `dev-environment`).
