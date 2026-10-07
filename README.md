# 픽셀 오피스 (가칭)

AI 코딩 에이전트(Claude Code, Codex) 팀을 **픽셀아트 사무실**에서 지휘하는 개인용 Windows 데스크탑 툴.

캐릭터 하나 = 실제 `claude` / `codex` CLI 세션 하나다. 상주 데몬이 CLI 를 가상 터미널(ConPTY)에 띄우고, CLI 의 **hooks** 로 무슨 일이 벌어지는지 받고, 지시는 터미널에 그대로 타이핑한다. 그 결과를 Flutter 사무실에서 관전하고, 셸 허가를 내주고, 보고를 받는다.

조직은 **부서 → 부장 → 팀장 → 팀원** 3단 트리(rev 3, [D-32](docs/04-결정기록.md)). 내가 만드는 것은 **부서(= 프로젝트 폴더)와 부장**뿐이고, 부장이 팀을 만들어 팀장을 배치하고 팀장이 팀원을 고용한다. **지시는 아래로 한 칸씩, 보고·질문은 위로 한 칸씩.** 나는 셸 허가와 멤버별 지시문, 그리고 비상시 퇴근으로 개입한다.

```
나 ──부서 만들기(부장 임명)──▶ 부장(head) ──create_team──▶ 팀장(lead) ──hire──▶ 팀원(member)
 ◀──── 보고 · ask_user · 셸 허가 ────┘        ◀── 보고 · ask_parent ──┘     ◀── 보고 · ask_parent ──┘
```

## 지금 상태 (2026-09-29)

**M0~M6 완료 = v1b + 디자인 완료.** 성공 기준 1~10을 전부 실제 데몬·앱으로 통과했다(기준 표는 [01 §Success Criteria](docs/01-설계문서.md)).

| 단계 | 내용 | 상태 |
|---|---|---|
| M0 | 데몬 스파이크 (pty · hooks · 이벤트 · SQLite · 콘솔 클라이언트) | 완료 (T10) |
| M1 | Flutter 사무실 최소 + 터미널 탭 | 완료 (T14) |
| M2 | 내 책상 루프 (허가·질문 카드, 이동, 보고서, 재시작) — **v1a** | 완료 (T19) |
| M3 | Codex 어댑터 · 혼합 팀 | 완료 (T23) |
| M4 | 팀 · 오케스트레이터 · TeamTools · 지시문 · 셸 뮤텍스 | 완료 (T29) |
| M4b | 직무 체계 rev 3 (부장→팀장→팀원 트리) | 완료 (T39) |
| M5 | 안정화 (오류 포즈·재고용·보존·단일 데몬) — **v1b** | 완료 (T30·T31) |
| M6 | 디자인 (레이아웃 v2, 스프라이트) | **완료** (T32 [레이아웃 v2](docs/design/레이아웃-v2.md) → T40/T40d [구현](docs/worklog/T40-LayoutV2.md) → T33 [스프라이트·서체](docs/worklog/T33-Sprites.md), D-42~D-44) |

**v1 이후(2026-09-21).** Codex 실기 점검을 닫았다(T42 — 이월 목록 A~J 중 I 만 보류, 부장을 codex 로도 통과, [worklog](docs/worklog/T42-CodexLive.md)). **사용량 표시**를 넣었다(T43 — 상단 엔진 칩·사용량 패널·캐릭터별 컨텍스트/토큰/비용, 숨은 확인용 세션이 5분마다 `/usage`·`/status` 를 읽는다, 토큰·서버 조회 없음 D-45, [설계](docs/design/사용량-표시.md)). 낡은 통합 테스트와 붙여넣기↔Enter 키 끼임도 정리했다(T44). **앱·데몬·AI 세션을 한 몸으로 묶었다**(T46, D-47 — 앱을 켜면 데몬이 같이 뜨고, 닫으면 전부 같이 꺼지고, 어느 쪽이 죽어도 남는 프로세스가 없고, 다시 켜면 어제의 조직이 말없이 출근한다, [설계](docs/design/수명주기.md) · [실기](docs/worklog/T46-3-LifecycleLive.md)).

## 폴더

```
pixel-office/
  docs/               설계·계획·결정·작업 기록  → docs/README.md 부터
    01-설계문서.md        설계(rev 2) + 직무 체계 rev 3 + 실측 반영 + 설계 변경 이력
    02-실측-체크리스트.md  CLI·hooks·pty 실측 결과와 근거
    03-작업계획.md        태스크 분해 T00~T48 과 진행 상태 — **진행 상태의 단일 기준**
    04-결정기록.md        D-01~D-48 (append-only, 맨 위에 목차 표)
    worklog/            태스크별 기록 T##-*.md + 창 캡처 img/
    design/             와이어프레임
  dev/
    daemon/             Node 상주 데몬 (TypeScript)  → dev/daemon/README.md
      PROTOCOL.md         WS JSON-RPC·이벤트·후처리 계약 — 앱과 데몬의 유일한 기준
      src/                office · rpc · pty · screen · hooks · adapters · mcp · input · store · cli
      src/tui-maps/       CLI 버전별 화면 패턴 JSON
      test/               node:test (905건)
    app/                Flutter 데스크탑 앱 (Windows · macOS 러너 포함, 맥 실기 전)  → dev/app/README.md
      lib/                rpc · model · state · topbar · office · panel · command
      test/               위젯·상태 테스트 (721건)
      tool/capture-window.ps1   창 단위 캡처 (worklog 증거용, 전체 화면 캡처 금지)
    spike-0/            0단계 실측 스파이크와 sandbox(실기용 작업 폴더)
```

## 실행

사전 조건: **Node 24+**(데몬이 `node:sqlite` 를 쓴다), **Flutter**(Windows 데스크탑), `claude` 실행 파일 + 로그인, (선택) `codex` + 로그인.

`claude` 는 `npm install -g @anthropic-ai/claude-code` 로 설치하고 한 번 실행해 로그인해 둔다. 데몬은 실행 파일을
`PIXEL_CLAUDE_EXE` → PATH 의 `claude.exe` → **npm 전역의 `bin/claude.exe`**(PATH 에는 `.cmd` 셰임만 오른다) → Claude
데스크탑 앱 번들 순으로 찾는다. Claude 데스크탑 앱의 번들만 있는 컴퓨터에서는 그 앱의 가상화된 환경 밖(탐색기 더블클릭)에서
`claude.exe` 가 보이지 않으므로 반드시 npm 으로 따로 설치한다(2026-09-22 실측).

**앱만 켜면 된다.** 데몬은 앱이 **콘솔 창 없이** 같이 띄우고, 앱을 닫으면 AI 세션까지 같이 꺼진다
(D-47 이 D-02 의 기본 동작을 뒤집었다 — 전문 `docs/design/수명주기.md`, 실기 `docs/worklog/T46-3-LifecycleLive.md`).

```bash
# 0) 한 번만 — 데몬의 의존성(앱이 이 폴더를 찾아 띄운다)
cd dev/daemon && npm install

# 1) 앱 — 이것만 켜면 데몬도 같이 뜬다
cd dev/app
flutter pub get
flutter run -d windows            # 개발 실행
flutter build windows --release   # build\windows\x64\runner\Release\pixel_office.exe

# 2) (선택) 데몬을 콘솔에서 따로 — 디버깅·로그를 눈으로 볼 때만
cd dev/daemon && npm start        # ws 7420 / hook 7421 / mcp 7422, 데이터 %LOCALAPPDATA%\pixel-office

# 앱 없이 데몬만 만져 보려면 (디버깅·시연용 REPL — 앱이 띄운 데몬에도 그대로 붙는다)
cd dev/daemon && npm run cli      # help 로 명령 목록
```

앱은 `%LOCALAPPDATA%\pixel-office\daemon.json` 에서 포트·토큰을 읽어 붙고, 2초 안에 붙을 데몬이 없으면
직접 띄운다(이미 도는 데몬이 있으면 그대로 붙는다 — 데몬은 하나만 뜬다, D-40).
데몬 로그는 `%LOCALAPPDATA%\pixel-office\daemon.log`(최근 1MB). 못 띄우면 그 로그 마지막 8줄과
`다시 시도` 가 화면에 뜬다. 앱을 닫아도 데몬을 남기고 싶으면 상단 바 `⋮` → "앱을 닫아도 계속 일하기".

첫 화면에서 **"부서 만들기"** → 이름 · 작업 폴더(cwd) · 부장 엔진 · 부장 이름 → 부장이 출근한다. 그다음은 아래 지시 바로 **부장에게만** 말하면 된다.

### 맥에서 실행 (T48 · D-48 — **macOS 26.6 / arm64 에서 실기 확인**)

운영체제에 닿는 코드는 데몬 `src/platform.ts` · 앱 `lib/platform/platform.dart` 한 곳에 모아 두었다.
확인 순서는 [docs/design/맥-지원.md](docs/design/맥-지원.md) 의 "2단계 대본" M1~M17 이고, 실기 결과는
[docs/worklog/T48-3-MacLive.md](docs/worklog/T48-3-MacLive.md) 에 있다.

**M1~M8 · M10~M14 · M17 을 맥에서 확인했다** — 단위·통합 테스트, 부서 만들기부터 허가·보고까지 한 바퀴를
**claude·codex 두 엔진 다**, 앱 빌드와 Finder 실행, 데몬·앱 강제 종료 후의 자동 재시작·유령 정리·부모 감시.
앱 창을 직접 눌러야 하는 M9(폴더 선택 대화상자)·M15(단축키)·M16(레티나 픽셀 서체)와 M10 의 확인 대화상자
갈래만 남았다.

```bash
# 사전: Xcode(앱 빌드에는 명령줄 도구만으로는 안 된다), Node 24+, Flutter(맥 데스크탑 켜기), claude 설치 + 로그인
sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch   # 동의 전에는 git·flutter 까지 거부한다
flutter config --enable-macos-desktop
npm install -g @anthropic-ai/claude-code && claude       # 한 번 실행해 로그인
npm install -g @openai/codex && codex login              # (선택) Codex — 최신으로 된다(0.159.0 실기 확인, T49)

git clone https://github.com/MaoEmong/pixel-office-dev.git && cd pixel-office-dev
cd dev/daemon && npm install && npx tsc --noEmit && npm test     # 896건 + 스킵된 MixedTeam 9건 = 905
cd ../app && flutter pub get && flutter analyze && flutter test  # 720 통과 · 2 스킵
flutter build macos --release
open build/macos/Build/Products/Release/pixel_office.app         # Finder 더블클릭과 같다
```

- 데이터 폴더는 `~/Library/Application Support/pixel-office`(데몬·앱 같은 규칙, `PIXEL_DATA_DIR` 로 덮어씀). 데몬 로그도 거기 `daemon.log`.
- 맥 GUI 앱은 터미널의 PATH 를 물려받지 않아 앱이 `node` 를 절대 경로로 찾는다(`PIXEL_NODE` → PATH → Homebrew → nvm → volta). 못 찾으면 화면에 `node 를 찾지 못했습니다` — `PIXEL_NODE=/opt/homebrew/bin/node` 처럼 지정.
- 앱은 **샌드박스를 끄고** 빌드한다(데몬을 띄우고 홈 폴더를 읽어야 한다 — 개인 툴, 앱스토어 배포는 범위 밖). 서명 없는 로컬 빌드라 첫 실행에 Gatekeeper 가 막으면 시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기".
- 단축키는 `Cmd+K/L/T/I/R`, 인박스 허가·거부는 `Cmd+Shift+Y` / `Cmd+Shift+N`.
- **`npm install` 뒤 pty 가 `posix_spawnp failed` 로 죽으면** npm 11.16+ 가 node-pty 의 설치 스크립트를 막아 `prebuilds/darwin-*/spawn-helper` 에 실행 권한이 없는 것이다 — `dev/daemon` 에서 `npm approve-scripts --allow-scripts-pending`(또는 그 파일에 `chmod +x`). 윈도우에는 없는 문제다(T48-3 M1 함정 ①).
- **저장소를 경로에 한글·비ASCII 가 없는 곳에 두라.** 있으면 `flutter analyze` 의 analysis server 가 LSP 메시지를 잘라 `FormatException` 으로 죽는다(툴체인 쪽 문제, `flutter test`·`pub get` 은 무관). T48-3 M7 함정 ②.
- **`flutter build macos` 가 Xcode 27 에서 그냥은 안 된다.** 이 저장소는 `macos/Runner/Configs/Release.xcconfig` 에 `ARCHS = arm64` 을 박고 배포 대상을 12.0 으로 올려 두었다(T48-3 M7 함정 ③④). 인텔 맥에서 빌드하려면 그 줄을 `x86_64` 로 바꾼다 — 유니버설 바이너리는 Xcode 27 의 `lipo` 가 `-verify_arch` 에 arch 를 둘 받지 않아 못 만든다.
- **CLI 버전을 고정하지 않아도 된다(T49 에서 해결).** 데몬이 기동할 때 `claude --version`·`codex --version` 을 읽어 **설치된 버전에 맞는 화면 패턴(tui-map)** 을 고른다. 기동 로그에 `codex codex-cli 0.159.0 → tui-map 0.159` 처럼 찍히고, **맞는 맵이 없으면 경고 한 줄**과 함께 가장 가까운 맵으로 내려 잡는다 — 그 경고가 보이면 화면 문구가 바뀌었을 수 있다는 신호다(맵 추가 절차는 `dev/daemon/src/tui-maps/README.md`).
  - 내려간 이력: 0.159 로는 코덱스 멤버에게 지시가 제출되지 않았다. 원인은 spawn 인자도 `.codex/hooks.json` 도 아니고 **0.159 에서 새로 생긴 폴더 신뢰 모달**("Folder access / Trust this folder?")이었다 — 준비 화면이 그려진 **뒤에** 뜨는데 옛 맵이 그 문구를 몰라 "준비됨" 으로 보고, 모달 위에 붙여넣은 지시가 버려졌다. 지금은 `codex-0.159.json` 이 그 모달을 안다(D-49). 0.154 를 계속 쓰는 사람도 그대로 동작한다(맵을 둘 다 싣는다).
  - 남은 드리프트: claude 2.1.284 가 긴 주입 텍스트를 `<pasted_content>` 로 감싼다 — 테스트 쪽은 `unwrapPasted()` 로 막아 뒀지만 **사용자에게 보이는 로그·말풍선에는 그 봉투가 그대로 찍힌다**(T48-3 M4 함정 ④).
- **통합 테스트(`PIXEL_IT=1`)는 파일 하나씩 돌린다.** `node --test` 는 파일을 병렬로 돌리는데, 실기 CLI·포트·셸 락을 공유해 여러 파일이 동시에 뜨면 엉킨다(T48-3 M6 함정).
- 가장 큰 미지수였던 둘은 T48-3 에서 확인됐다: 셰뱅 스크립트(`#!/usr/bin/env node`)는 심볼릭 링크를 거쳐서도 node-pty 가 진짜 TTY 로 띄운다(다만 npm 이 설치한 `claude` 2.1.284 는 **셰뱅 스크립트가 아니라 Mach-O arm64 네이티브**이고 맥에서도 이름이 `claude.exe` 다). SIGHUP 은 정상 종료 경로를 그대로 타고 `daemon.json` 까지 치운다.
- 창 캡처는 `dev/app/tool/capture-window.sh`(창 단위). 처음 실행에 macOS 가 "화면 기록" 권한을 물어본다.

## 검증

```bash
cd dev/daemon && npx tsc --noEmit && npm test     # 905건 (PIXEL_IT=1 이면 실제 CLI 통합 테스트 포함)
cd dev/app    && flutter analyze && flutter test  # 721건
# 새로 클론한 곳에서는 MixedTeam 스위트(10건)가 스킵된다 — 실측 hook 로그가 .gitignore 되어 있다(dev/spike-0/*.json).
```

## 더 읽을 것

- 새로 오면 **[docs/03-작업계획.md](docs/03-작업계획.md) → [docs/01-설계문서.md](docs/01-설계문서.md) → [docs/04-결정기록.md](docs/04-결정기록.md)** 순서.
- 앱·데몬의 와이어 계약은 **[dev/daemon/PROTOCOL.md](dev/daemon/PROTOCOL.md)** 하나가 기준이다.
- 특정 태스크의 "왜 이렇게 했나" 는 `docs/worklog/T##-*.md` → 04 의 D-## 번호.
