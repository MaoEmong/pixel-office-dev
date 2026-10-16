# 픽셀 오피스 (가칭)

AI 코딩 에이전트(Claude Code, Codex) 팀을 **픽셀아트 사무실**에서 지휘하는 개인용 Windows 데스크탑 툴.

캐릭터 하나 = 실제 `claude` / `codex` CLI 세션 하나다. 상주 데몬이 CLI 를 가상 터미널(ConPTY)에 띄우고, CLI 의 **hooks** 로 무슨 일이 벌어지는지 받고, 지시는 터미널에 그대로 타이핑한다. 그 결과를 Flutter 사무실에서 관전하고, 셸 허가를 내주고, 보고를 받는다.

조직은 **부서 → 부장 → 팀장 → 팀원** 3단 트리(rev 3, [D-32](docs/04-결정기록.md)). 내가 만드는 것은 **부서(= 프로젝트 폴더)와 부장**뿐이고, 부장이 팀을 만들어 팀장을 배치하고 팀장이 팀원을 고용한다. **지시는 아래로 한 칸씩, 보고·질문은 위로 한 칸씩.** 나는 셸 허가와 멤버별 지시문, 그리고 비상시 퇴근으로 개입한다.

```
나 ──부서 만들기(부장 임명)──▶ 부장(head) ──create_team──▶ 팀장(lead) ──hire──▶ 팀원(member)
 ◀──── 보고 · ask_user · 셸 허가 ────┘        ◀── 보고 · ask_parent ──┘     ◀── 보고 · ask_parent ──┘
```

## 지금 상태 (2026-10-16)

로컬 PC 사용이 기본이다. 프로젝트 폴더에 세션을 저장하고, 부장과 작업을 구체화한 뒤
회의 결과에 따라 실행·승인·보고·검수를 진행한다. 원하는 사용자만 Tailscale로
모바일·다른 PC의 브라우저를 연결할 수 있다. 개발자 도메인이나 자체 중계 서버는 필요 없다.

- **프로젝트별 저장**: `.pixel-office/sessions/`에 실제 CLI 기록과 이벤트를 저장하고 재시작 후 복구한다.
- **부장 판단으로 단계 진행**: 목표 구체화 → 부장이 시작 → 팀장 회의·실행 → 부장 검증·단계 정리 → 다음 단계 또는 전체 완료.
- **단계 기록**: 완료한 일, 검증 결과, 당시 팀별 보고와 회의 결정, 다음 단계를 저장한다. 완료할 때 화면에 요약을 알리고 `단계 기록`에서 다시 볼 수 있다.
- **QR·키 기기 등록**: PC에서 승인한 기기를 재사용하며, 한쪽에서 해제하면 접근을 차단한다.
- **선택 원격 접속**: Tailscale Serve는 개인 네트워크 전용이다. Funnel 공개 접속은 별도 선택이며 기본으로 켜지지 않는다.

Windows에서 실제 CLI 작업·승인·보고·재시작 복구와 PC/브라우저 직접 조작을 확인했다.
T55 검증은 백엔드 1,203개, Flutter 748개 통과이며 T56 관련 검사도 통과했다.
모바일 폭 390px의 브라우저 검증은 완료했고, 실제 휴대폰 LTE/5G 조작 검증은 아직 진행하지 않았다.

**연결 안내**: [스크린샷 HTML 안내서](docs/원격접속.html) · [텍스트 안내서](docs/원격접속.md).
HTML은 파일을 내려받아 브라우저에서 열면 된다. 스크린샷을 포함한 단일 파일이며 이미지 확대·목차·인쇄를 지원한다.

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
    03-작업계획.md        태스크 분해와 진행 상태 — **진행 상태의 단일 기준**
    원격접속.md/html       Tailscale 개인 연결·QR 등록·문제 해결 (HTML에 실제 화면 포함)
    04-결정기록.md        D-01~D-48 (append-only, 맨 위에 목차 표)
    worklog/            태스크별 기록 T##-*.md + 창 캡처 img/
    design/             와이어프레임
  dev/
    daemon/             Node 상주 데몬 (TypeScript)  → dev/daemon/README.md
      PROTOCOL.md         WS JSON-RPC·이벤트·후처리 계약 — 앱과 데몬의 유일한 기준
      src/                office · rpc · pty · screen · hooks · adapters · mcp · input · store · cli
      src/tui-maps/       CLI 버전별 화면 패턴 JSON
      test/               node:test + 선택 실제 CLI/브라우저 통합 검증
    app/                Flutter 데스크탑 앱 (Windows · macOS 러너 포함, 맥 실기 전)  → dev/app/README.md
      lib/                rpc · model · state · topbar · office · panel · command
      test/               위젯·상태 테스트
      tool/capture-window.ps1   창 단위 캡처 (worklog 증거용, 전체 화면 캡처 금지)
    spike-0/            0단계 실측 스파이크와 sandbox(실기용 작업 폴더)
```

## 실행

### 실행 환경·로그인 문제가 있을 때

최근 개선 사항과 검사 결과는 [2026-10-16 작업 정리](docs/worklog/2026-10-16-ChangesSummary.md)에서 확인할 수 있다.
그 이후의 승인·질문 상태, 재시작 복구, 자동 단계 진행과 실행 사전 검사는 [추가 작업 정리](docs/worklog/2026-10-16-ReliabilityAndAutonomousStages.md)에 정리했다.

앱은 데몬 시작 전에 Node.js 24 이상과 필요한 모듈을 검사하고, 누락 시 복구 방법을 표시한다.
시작 후에는 상단 ⋮ → **환경 점검 · CLI 로그인**에서 사용할 엔진의 설치·인증을 확인한다.
캐릭터 선택 후 **선택 멤버 검사**는 프로젝트 전용 세션의 로그인도 확인한다.
Windows Codex 멤버는 실제 명령 실행도 확인한다. 계획 확정·팀원 업무 배정·중단 업무 재개 전에는
담당자의 로그인과 실행 환경을 검사하고, 실패하면 업무를 보내기 전에 원인과 필요한 조치를 팝업으로 안내한다.
응답 지연은 고정된 검사 명령만 한 번 더 확인하며 사용자 작업을 임의로 반복하지 않는다.
터미널에서 로그인한 정보는 앱의 AI 세션에도 반영된다. 로그인 갱신은 서로 공유하며 대화 기록과 설정은 프로젝트별로 보관한다.
로그인 만료로 답변이 멈추면 오류 팝업에서 **터미널 열기 · 로그인 복구**를 선택한다.
터미널의 **로그인 연결 · 요청 재시도**는 로그인 상태를 확인하고 답변하지 못한 요청을 이어간다.
새 로그인이 필요하면 **로그인** 버튼으로 앱 안에서 진행한다. **터미널 명령** 입력란에서는 `/help`, `/status` 같은 명령을 AI 업무 지시와 별도로 실행한다.
확인된 미설치·로그아웃 상태에서는 사용자 작업과 AI의 팀·팀원 생성을 실행 전에 거부한다.
고친 뒤 다시 검사·다시 시도한다. 자세한 내용은 [환경 문제 해결](docs/환경-문제해결.md).

같은 화면의 **사용 엔진**에서 사용할 서비스를 선택한다. 기본은 **부장과 같은 엔진만 사용**이다.
Claude만 결제했다면 **Claude Code만 사용**, Codex만 사용한다면 **Codex만 사용**으로 지정한다.
두 서비스를 사용할 때만 **Claude Code + Codex 사용**을 선택한다. 로그인 상태로 결제 여부를 추정하지 않는다.
이 선택은 PC의 DB에 저장되고 생성·재고용·재시작·세션 복구·새 지시에도 적용된다.
이미 진행 중인 작업을 강제로 종료하지는 않는다.

원격 연결 서버의 포트 충돌·DB 오류가 발생해도 로컬 작업은 계속 사용할 수 있다.
**기기 연결 · 원격 조작 → 원격 연결 다시 시작**으로 재시도한다.
창 설정 저장 실패는 화면에 안내하고 **다시 저장**할 수 있으며, 계속 일하기 설정은 저장 성공 전까지 이전 값을 유지한다.
앱 잠금을 저장하지 못하면 폴더 권한·디스크 공간을 확인하는 재시도 화면을 표시한다.

오류는 아이콘·원인·해결 안내·재시도 버튼이 있는 패널로 표시한다. 자세한 로그는 **오류 상세**에서 펼친다.
환경 점검의 **동시 작업 제한**에서 전체 멤버 세션 수(기본 16개)와 부서별 팀 수(기본 8개)를 조정할 수 있다.
제한을 낮춰도 이미 실행 중인 세션을 강제로 종료하지 않는다.

프로젝트 폴더를 이동했다면 자동으로 빈 폴더를 만들지 않고 실행을 중단한다.
부서의 모든 멤버를 퇴근시킨 뒤 상단 ⋮ → **프로젝트 폴더 다시 연결**에서 이동한 원래 폴더를 선택한다.
기존 대화를 이어가려면 프로젝트의 `.pixel-office` 폴더도 함께 이동해야 한다.
작업 시작·대화 전송 실패는 부분 상태를 되돌리며, 응답 시간 초과 후 같은 요청을 다시 보내도 중복 실행을 방지한다.

### 모바일·다른 PC 연결 (선택)

로컬에서만 사용한다면 이 설정을 건너뛴다. 원격으로 연결할 때는 다음 순서로 진행한다.

1. 작업 PC와 접속할 기기에 Tailscale을 설치하고 같은 개인 네트워크에 연결한다.
2. 작업 PC에서 `tailscale serve --bg http://127.0.0.1:7423`을 실행한다.
   HTTPS 활성화 화면에서는 선택 항목 **Funnel을 해제**하고 HTTPS만 켠다.
3. 출력된 HTTPS 주소를 앱 상단 ⋮ → 기기 연결·원격 조작 → 외부 접속 설정에 저장한다.
4. QR/키를 만들고 원격 브라우저에서 등록을 요청한다. PC에서 기기 이름·지문을 확인해 승인한다.
5. 같은 브라우저·주소를 사용하면 다음부터 자동 인증된다. 작업 PC와 데몬은 실행 중이어야 한다.

작업 데이터는 PC에 저장되고 브라우저에는 기기 인증 정보만 보관된다. QR/키는 5분·1회용이며
이미 승인한 기기 등록은 해제 전까지 유지된다. 주소 변경·브라우저 데이터 삭제 시 재등록한다.
연결을 폐기하려면 PC의 등록 기기에서 '연결 해제'를 누르거나 원격 화면의 '이 기기'에서 해제한다.
앱을 닫고 원격 작업을 계속하려면 '앱을 닫아도 계속 일하기'를 켠다. PC 절전·종료에서는 사용할 수 없다.

상세 절차와 오류 해결은 [스크린샷 안내서](docs/원격접속.html)에서 확인한다.
개인 계정·PC 주소·등록 키는 공개 안내서에 포함하지 않는다.
게이트웨이 7423만 전달하며 로컬 RPC 7420·hook 7421·MCP 7422는 외부에 연결하지 않는다.

### 셸 자동 승인

자동 승인 판단은 실행 셸의 문법을 따른다. Windows에서 실행하는 Bash도 역슬래시를
이스케이프로 해석하므로 `c\url`처럼 명령 이름을 가린 요청은 자동 승인하지 않는다.
PowerShell·CMD의 정상적인 폴더 안 경로는 경로로 검사하고, CMD의 caret·환경 변수로
명령 이름을 가리는 요청은 승인을 묻는다.
Codex가 실제 셸 정보 없이 합성한 `Bash` hook이나 일반 `shell` 도구 요청은
셸을 추측하지 않고 승인 카드를 띄운다. 파일 편집 자동 승인 규칙은 유지하며,
`.pixel-office` 등 인증·세션 설정 폴더 접근은 자동 승인하지 않는다.

### 프로젝트별 세션 저장

부서의 작업 폴더 안에 `.pixel-office/sessions/<멤버 ID>/`를 자동 생성한다.
사용자가 환경변수를 설정할 필요는 없다.

```text
프로젝트/.pixel-office/
  .gitignore
  sessions/<멤버 ID>/
    session.json            이름·직급·엔진·CLI 세션 ID
    events.jsonl            작업·승인·보고 이벤트
    claude-settings.json    Claude hooks·사용량 설정
    mcp.json                Claude 팀 도구 연결 설정
    claude/                 Claude의 대화 기록·설정
    codex/                  Codex의 대화 기록·설정·SQLite 상태
```

실제 CLI 기록은 해당 멤버 폴더에 직접 저장한다. 기존 세션을 재개할 때는
그 세션의 기존 대화 기록만 복사하고 원본은 보존한다. 로그인·사용자 설정을 최초 실행 시
기존 CLI 홈에서 초기화하므로 이 폴더에는 인증 정보도 포함될 수 있다.
`.pixel-office/.gitignore`가 폴더 내용 전체를 Git에서 제외한다.
멤버별로 갱신된 로그인 정보는 다시 덮어쓰지 않는다.

부서 목록과 앱의 공통 DB·포트·로그는 `%LOCALAPPDATA%/pixel-office`에 유지한다.
사용량 확인용 숨은 세션은 프로젝트 세션이 아니므로 기존 공통 저장 위치를 사용한다.
Windows Codex hooks는 공백 있는 Node 실행 경로도 호출할 수 있게 PowerShell로 실행한다.
실제 Codex 0.162.0-alpha.17.2에서 프로젝트 저장, 작업 승인·보고, 재시작 후 대화 복구를 검증했다.
Claude의 파일 기반 로그인 상태가 없는 환경에서는 프로젝트 전용 CLI 홈에서 로그인이 필요할 수 있다.

저장 위치 지정은 CLI가 지원하는 [Claude 구성 디렉터리](https://code.claude.com/docs/en/env-vars)와
[Codex 구성](https://developers.openai.com/codex/config-advanced)을 세션 실행 환경에만 적용한다.

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

**M1~M9 · M11~M17 을 맥에서 확인했다** — 단위·통합 테스트, 부서 만들기부터 허가·보고까지 한 바퀴를
**claude·codex 두 엔진 다**, 앱 빌드와 Finder 실행, 폴더 선택 대화상자·단축키·레티나 픽셀 서체,
데몬·앱 강제 종료 후의 자동 재시작·유령 정리·부모 감시. **M10 만 건너뛰었다** — Cmd+Q 와 같은 경로가
종료 가로채기에 닿는 것은 확인했고, 작업 중 확인 대화상자를 눌러 끝까지 가는 갈래만 안 봤다.

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

### 윈도우에서 받는 경우 (읽고 시작할 것)

아래 표는 T48/T49 당시의 확인 범위를 기록한 것이다. 이후 T54~T56에서는 Windows에서
실제 작업·회의·승인·보고·재시작 복구와 기기 등록·원격 화면을 검증했다.

이 저장소는 원래 **윈도우 우선**이고 위 "실행" 절이 그대로 적용된다. T48/T49 당시에는 —
**T48(맥 지원)과 T49(CLI 버전 드리프트)의 모든 변경은 macOS 에서만 실기했다.** 윈도우 쪽은 플랫폼을 주입한
단위 테스트로만 덮여 있고 실제로 돌려 보지 않은 상태였다(D-48 원칙 3 은 "윈도우 동작은 안 바뀐다" 지만, 당시 근거가
실기가 아니라 테스트다). 윈도우에서 뭔가 어긋나면 아래가 1순위 용의자다.

| 바뀐 것 | 윈도우에 닿나 | 확인한 방법 |
|---|---|---|
| `dev/daemon/package.json` 의 test glob 을 따옴표로 감쌈 | **닿는다** — 셸마다 다르게 도는 유일한 변경 | 윈도우에서는 cmd 가 따옴표를 벗겨 **node 가 직접 glob** 한다. 그 경로를 재현해 905건을 찾는 것까지 봤다. 틀렸다면 **0건으로 즉시 드러난다** |
| 윈도우를 가정하던 테스트 일곱 건에 플랫폼 주입 | 닿는다 | 윈도우 단정을 **명시적으로** 하도록 되돌린 것이다(전에는 호스트가 윈도우라 우연히 맞았다) |
| tui-map 로더가 **설치된 CLI 버전**을 읽는다(T49) | 닿는다 | 못 읽으면 폴백, 맞는 맵이 없으면 근접 버전. `win32` 로 0.100·0.154·0.159·0.160 조합을 돌려 확인 |
| `create_team` 결과에 `teamId` 추가 | 닿는다 | 플랫폼 무관. PROTOCOL 표·테스트도 같이 고쳤다 |
| `dev/app/macos/**`, `tool/capture-window.sh` | **안 닿는다** | 맥 전용 파일. 윈도우 러너는 손대지 않았다 |

숫자에 대해:

- 새로 클론하면 데몬 **905건**이 맞다. 실측 hook 로그(`dev/spike-0/*.json`)가 `.gitignore` 라 MixedTeam
  스위트 10건이 스킵된다 — 그 파일을 로컬에 들고 있는 원래 개발 머신에서만 915건이 나온다.
- **스킵 개수는 맥과 다르다.** win32 전용 테스트들이 윈도우에서는 돌기 때문에 스킵이 줄고 통과가 는다. 정상이다.
- `test/rpc/RpcServer.test.ts` 의 `detachAll` 중복은 **이전부터 있던 flaky** 다(단독 8회 중 1회 실패,
  마지막 수정 T46-3). 맥 특유가 아니고 이 작업과도 무관하다 — 받아서 돌렸을 때 이것 하나가 깨졌다면 그 탓이다.

위의 맥 전용 주의(인텔 맥 `ARCHS`, 경로에 한글 금지)는 윈도우에는 해당 없다.


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

회의를 거치는 새 작업 방식은 하단 `부장과 대화 · 회의 보기`에서 사용한다.
먼저 목표를 이야기하면 부장이 범위와 완료 기준을 정리하고 직접 회의를 시작한다.
팀별 보고가 모이면 부장이 검증해 단계 결과를 기록하고, 남은 목표가 있으면 다음 단계 회의를 연다.
단계 진행 확인이나 검수 완료 버튼을 반복해서 누를 필요는 없다. 하단 최근 완료 요약과
`단계 기록` 탭에서 완료한 일·검증 결과·팀별 보고·다음 진행을 확인할 수 있다.
로그인과 기존 명령 승인 설정은 그대로 적용되며, 실제로 막힌 문제를 완료로 처리하지 않는다.
[작업 흐름 설계](docs/design/회의-작업흐름.md)에 단계와 저장 계약이 정리돼 있다.

### 회의·작업 실패 복구와 저장 관리

- 회의 전달·업무 배정·보고를 저장 실패에 맞춰 복구하고, 기존 계획의 **업무 배정 재시도**를 제공한다.
- 멤버 패널의 **제출 확인 필요 → 지시 재제출**은 기존 입력에 Enter만 다시 보낸다.
- 주요 변경 요청은 응답 유실 뒤 같은 요청을 재시도해도 중복 실행되지 않도록 식별자를 유지한다.
- **환경 점검 → 저장 상태 · DB 백업**에서 저장 오류 확인 및 DB 백업을 실행한다. 로그 용량과 과거 작업안 보존을 관리한다.

복구 절차와 보호 범위는 [환경 문제 해결](docs/환경-문제해결.md), 구현·검증은 [T63 작업 기록](docs/worklog/T63-RemainingFailureRecovery.md)을 참고한다.
