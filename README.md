# 픽셀 오피스 (가칭)

AI 코딩 에이전트(Claude Code, Codex) 팀을 **픽셀아트 사무실**에서 지휘하는 개인용 Windows 데스크탑 툴.

캐릭터 하나 = 실제 `claude` / `codex` CLI 세션 하나다. 상주 데몬이 CLI 를 가상 터미널(ConPTY)에 띄우고, CLI 의 **hooks** 로 무슨 일이 벌어지는지 받고, 지시는 터미널에 그대로 타이핑한다. 그 결과를 Flutter 사무실에서 관전하고, 셸 허가를 내주고, 보고를 받는다.

조직은 **부서 → 부장 → 팀장 → 팀원** 3단 트리(rev 3, [D-32](docs/04-결정기록.md)). 내가 만드는 것은 **부서(= 프로젝트 폴더)와 부장**뿐이고, 부장이 팀을 만들어 팀장을 배치하고 팀장이 팀원을 고용한다. **지시는 아래로 한 칸씩, 보고·질문은 위로 한 칸씩.** 나는 셸 허가와 멤버별 지시문, 그리고 비상시 퇴근으로 개입한다.

```
나 ──부서 만들기(부장 임명)──▶ 부장(head) ──create_team──▶ 팀장(lead) ──hire──▶ 팀원(member)
 ◀──── 보고 · ask_user · 셸 허가 ────┘        ◀── 보고 · ask_parent ──┘     ◀── 보고 · ask_parent ──┘
```

## 지금 상태 (2026-09-17)

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

**Codex 실기만 이월돼 있다.** ChatGPT 사용량 한도(D-23, 리셋 2026-09-21 13:58) 때문에 *모델 턴이 필요한* Codex 항목은 못 돌렸다. Codex 어댑터·MCP 주입·화면 패턴 자체는 실측 로그로 만든 단위 테스트가 덮고 있고, 이월분은 **한 목록**으로 모아 뒀다 — [worklog/T23-MixedTeam.md §"9/21 이후 확인 목록 A~J"](docs/worklog/T23-MixedTeam.md). Claude 쪽 기능은 전부 실기로 닫혔다.

## 폴더

```
pixel-office/
  docs/               설계·계획·결정·작업 기록  → docs/README.md 부터
    01-설계문서.md        설계(rev 2) + 직무 체계 rev 3 + 실측 반영 + 설계 변경 이력
    02-실측-체크리스트.md  CLI·hooks·pty 실측 결과와 근거
    03-작업계획.md        태스크 분해 T00~T41 과 진행 상태 — **진행 상태의 단일 기준**
    04-결정기록.md        D-01~D-46 (append-only, 맨 위에 목차 표)
    worklog/            태스크별 기록 T##-*.md + 창 캡처 img/
    design/             와이어프레임
  dev/
    daemon/             Node 상주 데몬 (TypeScript)  → dev/daemon/README.md
      PROTOCOL.md         WS JSON-RPC·이벤트·후처리 계약 — 앱과 데몬의 유일한 기준
      src/                office · rpc · pty · screen · hooks · adapters · mcp · input · store · cli
      src/tui-maps/       CLI 버전별 화면 패턴 JSON
      test/               node:test (711건)
    app/                Flutter 데스크탑 앱 (Windows)  → dev/app/README.md
      lib/                rpc · model · state · topbar · office · panel · command
      test/               위젯·상태 테스트 (541건)
      tool/capture-window.ps1   창 단위 캡처 (worklog 증거용, 전체 화면 캡처 금지)
    spike-0/            0단계 실측 스파이크와 sandbox(실기용 작업 폴더)
```

## 실행

사전 조건: **Node 24+**(데몬이 `node:sqlite` 를 쓴다), **Flutter**(Windows 데스크탑), `claude` 실행 파일 + 로그인, (선택) `codex` + 로그인.

```bash
# 1) 데몬 — 먼저 떠 있어야 한다. 하나만 뜬다(D-40).
cd dev/daemon
npm install
npm start                # ws 7420 / hook 7421 / mcp 7422, 데이터 %LOCALAPPDATA%\pixel-office

# 2) 앱
cd dev/app
flutter pub get
flutter run -d windows            # 개발 실행
flutter build windows --release   # build\windows\x64\runner\Release\pixel_office.exe

# 앱 없이 데몬만 만져 보려면 (디버깅·시연용 REPL)
cd dev/daemon && npm run cli      # help 로 명령 목록
```

앱은 `%LOCALAPPDATA%\pixel-office\daemon.json` 에서 포트·토큰을 읽어 붙는다. 데몬이 없으면 회색 사무실 + "데몬 시작" 버튼이 뜨고 계속 재접속을 시도한다.

첫 화면에서 **"부서 만들기"** → 이름 · 작업 폴더(cwd) · 부장 엔진 · 부장 이름 → 부장이 출근한다. 그다음은 아래 지시 바로 **부장에게만** 말하면 된다.

## 검증

```bash
cd dev/daemon && npx tsc --noEmit && npm test     # 711건 (PIXEL_IT=1 이면 실제 CLI 통합 테스트 포함)
cd dev/app    && flutter analyze && flutter test  # 541건
```

## 더 읽을 것

- 새로 오면 **[docs/03-작업계획.md](docs/03-작업계획.md) → [docs/01-설계문서.md](docs/01-설계문서.md) → [docs/04-결정기록.md](docs/04-결정기록.md)** 순서.
- 앱·데몬의 와이어 계약은 **[dev/daemon/PROTOCOL.md](dev/daemon/PROTOCOL.md)** 하나가 기준이다.
- 특정 태스크의 "왜 이렇게 했나" 는 `docs/worklog/T##-*.md` → 04 의 D-## 번호.
