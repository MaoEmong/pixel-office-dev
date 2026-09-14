# pixel-office daemon

실제 `claude` / `codex` CLI를 가상 터미널(ConPTY)에 띄우고, hooks로 상태를 받고, 사무실 UI에 이벤트를 흘려주는 상주 프로세스.

## 실행

```bash
npm install
npm run dev        # tsx watch (개발)
npm start          # 1회 실행
npm run cli        # 콘솔 클라이언트 (T08 이후)
npm test           # node:test + tsx
npm run typecheck
```

## 환경변수

| 변수 | 기본값 | 의미 |
|---|---|---|
| `PIXEL_WS_PORT` | 7420 | WebSocket(JSON-RPC) 포트 |
| `PIXEL_HOOK_PORT` | 7421 | CLI hooks가 POST하는 HTTP 포트 |
| `PIXEL_DATA_DIR` | `%LOCALAPPDATA%\pixel-office` | 토큰·DB·멤버 지시문 |
| `PIXEL_CLAUDE_EXE` | 데스크탑 앱 번들 `claude.exe` | claude 실행 파일 |
| `PIXEL_CODEX_EXE` | `codex` | codex 실행 파일 |

## 구조

```
src/
  index.ts        진입점
  config.ts       설정
  pty/            PtyManager — CLI 스폰·입출력 (T01)
  screen/         ScreenModel — headless xterm 화면 상태 (T02)
  hooks/          HookReceiver + hook.js (T03)
  adapters/       ClaudeHooks / CodexHooks → 오피스 이벤트 (T04, T20)
  store/          node:sqlite 저장소 (T06)
  rpc/            WebSocket JSON-RPC 서버 (T07)
  cli/            콘솔 클라이언트 (T08)
  tui-maps/       CLI 버전별 화면 패턴 (준비 문구·다이얼로그)
test/             node:test
```

## 설계·결정

`../../docs/01-설계문서.md`, `../../docs/04-결정기록.md`. 프로토콜은 `PROTOCOL.md` (T07).
