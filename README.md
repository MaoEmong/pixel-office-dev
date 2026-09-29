# 픽셀 오피스 (가칭)

AI 코딩 에이전트(Claude Code, Codex) 팀을 **픽셀아트 사무실**에서 지휘하는 개인용 Windows 데스크탑 툴.

캐릭터 하나 = 실제 `claude` / `codex` CLI 세션 하나다. 상주 데몬이 CLI 를 가상 터미널(ConPTY)에 띄우고, CLI 의 **hooks** 로 무슨 일이 벌어지는지 받고, 지시는 터미널에 그대로 타이핑한다. 그 결과를 Flutter 사무실에서 관전하고, 셸 허가를 내주고, 보고를 받는다.

조직은 **부서 → 부장 → 팀장 → 팀원** 3단 트리(rev 3, [D-32](docs/04-결정기록.md)). 내가 만드는 것은 **부서(= 프로젝트 폴더)와 부장**뿐이고, 부장이 팀을 만들어 팀장을 배치하고 팀장이 팀원을 고용한다. **지시는 아래로 한 칸씩, 보고·질문은 위로 한 칸씩.** 나는 셸 허가와 멤버별 지시문, 그리고 비상시 퇴근으로 개입한다.

```
나 ──부서 만들기(부장 임명)──▶ 부장(head) ──create_team──▶ 팀장(lead) ──hire──▶ 팀원(member)
 ◀──── 보고 · ask_user · 셸 허가 ────┘        ◀── 보고 · ask_parent ──┘     ◀── 보고 · ask_parent ──┘
```

## 지금 상태 (2026-09-21)

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
      test/               node:test (818건)
    app/                Flutter 데스크탑 앱 (Windows)  → dev/app/README.md
      lib/                rpc · model · state · topbar · office · panel · command
      test/               위젯·상태 테스트 (659건)
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

## 검증

```bash
cd dev/daemon && npx tsc --noEmit && npm test     # 818건 (PIXEL_IT=1 이면 실제 CLI 통합 테스트 포함)
cd dev/app    && flutter analyze && flutter test  # 659건
```

## 더 읽을 것

- 새로 오면 **[docs/03-작업계획.md](docs/03-작업계획.md) → [docs/01-설계문서.md](docs/01-설계문서.md) → [docs/04-결정기록.md](docs/04-결정기록.md)** 순서.
- 앱·데몬의 와이어 계약은 **[dev/daemon/PROTOCOL.md](dev/daemon/PROTOCOL.md)** 하나가 기준이다.
- 특정 태스크의 "왜 이렇게 했나" 는 `docs/worklog/T##-*.md` → 04 의 D-## 번호.
