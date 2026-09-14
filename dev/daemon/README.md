# pixel-office daemon

실제 `claude` / `codex` CLI를 가상 터미널(ConPTY)에 띄우고, hooks로 상태를 받고, 사무실 UI에 이벤트를 흘려주는 상주 프로세스. M0 완료(2026-09-15): 콘솔 클라이언트만으로 고용→지시→허가/질문→재접속→재시작 복구까지 동작.

## 실행

```bash
npm install
npm start                 # 데몬 1회 실행 (ws://127.0.0.1:7420, hook 7421)
npm run dev               # tsx watch
npm run cli               # 콘솔 클라이언트 REPL (help 로 명령 목록)
npm run cli -- --exec "hire demo claude 하루" --exec "say 하루 안녕" --wait-idle 하루   # 비대화형
npm test                  # node:test 전체 (PIXEL_IT=1 이면 실제 CLI 통합 테스트 포함)
npm run typecheck
```

콘솔 클라이언트 핵심 명령: `team create <name> <cwd> [claude|codex]` · `hire <team> <engine> <name>` · `say <member> <text>` · `pending` · `allow <id>` / `deny <id>` / `answer <id> <label>` · `attach <member>` / `detach` · `type <member> <text>` · `int <member>` · `fire <member>` · `events [n]` · `query <team>` · `shutdown`.

## 환경변수

| 변수 | 기본값 | 의미 |
|---|---|---|
| `PIXEL_WS_PORT` | 7420 | WebSocket(JSON-RPC) 포트 |
| `PIXEL_HOOK_PORT` | 7421 | CLI hooks가 POST하는 HTTP 포트 |
| `PIXEL_DATA_DIR` | `%LOCALAPPDATA%\pixel-office` | `daemon.json`(토큰)·DB·세션 설정·멤버 지시문 |
| `PIXEL_CLAUDE_EXE` | 데스크탑 앱 번들 `claude.exe` | claude 실행 파일 |
| `PIXEL_CODEX_EXE` | `codex` | codex 실행 파일 |
| `PIXEL_HOOK_TIMEOUT_SEC` | 86400 | 세션 hooks timeout(허가·질문 보류 상한, D-16) |

## 구조

```
src/
  index.ts        진입점 — Office + RpcServer 기동, SIGINT 정중 종료
  config.ts       설정
  office/         Office 오케스트레이터(T07) + 재시작 복구·유령 정리(T09) + 오류 코드
  rpc/            WebSocket JSON-RPC 서버(T07) — 계약은 PROTOCOL.md
  pty/            PtyManager — CLI 스폰·입출력·세션 hooks 설정 파일(T01)
  screen/         ScreenModel — headless xterm 화면 상태, 준비/다이얼로그 판정(T02)
  hooks/          HookReceiver + hook.js(CLI가 실행하는 브리지) + 결정 JSON 빌더(T03)
  adapters/       ClaudeHooksAdapter — hook 이벤트 → 오피스 이벤트·pending(T04); Codex는 T20
  input/          InputQueue — 타이핑 직렬화, prompt-ready 게이팅, 다이얼로그 통과(T05)
  store/          node:sqlite 저장소 — teams/members/events(seq)/pending/tasks(T06)
  cli/            콘솔 클라이언트(T08) — RpcClient + REPL/--exec
  tui-maps/       CLI 버전별 화면 패턴 JSON (verified 플래그)
test/             node:test (모듈별 폴더; *.integration.test.ts 는 PIXEL_IT=1)
```

## 데이터 흐름 (한 멤버)

```
RPC member.instruct ─▶ Store.tasks ─▶ InputQueue ─(idle ∧ promptReady)─▶ pty.paste + Enter
claude.exe ──stdout──▶ ScreenModel(화면) ──▶ term 알림(attach 클라이언트)
claude.exe ──hooks(node hook.js)──▶ HookReceiver ─▶ ClaudeHooksAdapter ─▶ Store.events/pending ─▶ event/member.status 알림
approval.respond / question.respond ─▶ Adapter.resolve* ─▶ 보류 중인 hook 응답(allow/deny/answers)
```

## 설계·결정

`../../docs/01-설계문서.md`, `../../docs/04-결정기록.md`, 태스크별 기록 `../../docs/worklog/`. 프로토콜 `PROTOCOL.md`.
