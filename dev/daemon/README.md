# pixel-office daemon

실제 `claude` / `codex` CLI를 가상 터미널(ConPTY)에 띄우고, hooks로 상태를 받고, 사무실 UI에 이벤트를 흘려주는 상주 프로세스. M0 완료(2026-09-15): 콘솔 클라이언트만으로 고용→지시→허가/질문→재접속→재시작 복구까지 동작. M3 완료(2026-09-16, T23): 같은 팀에 Claude 팀원과 Codex 팀원을 섞어도 각자 자기 이벤트·pending·터미널로 동작한다(엔진별 차이는 아래 "Codex 팀원" 절).

## 실행

```bash
npm install
npm start                 # 데몬 1회 실행 (ws://127.0.0.1:7420, hook 7421, MCP 7422)
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
| `PIXEL_WS_PORT` | 7420 | WebSocket(JSON-RPC) 포트 — 앱·콘솔 클라이언트가 붙는다 |
| `PIXEL_HOOK_PORT` | 7421 | CLI hooks가 POST하는 HTTP 포트 (`/hook/<memberToken>/<event>`) |
| `PIXEL_MCP_PORT` | 7422 | TeamTools MCP(Streamable HTTP) 포트 — CLI 세션이 `/mcp/<memberToken>` 으로 붙는다(T17) |
| `PIXEL_DATA_DIR` | `%LOCALAPPDATA%\pixel-office` | `daemon.json`(토큰·세 포트)·DB·세션 설정·멤버 지시문 |
| `PIXEL_CLAUDE_EXE` | 데스크탑 앱 번들 `claude.exe` | claude 실행 파일 |
| `PIXEL_CODEX_EXE` | **자동 탐지**(아래) | codex 실행 파일 |
| `PIXEL_HOOK_TIMEOUT_SEC` | 86400 | 세션 hooks timeout(허가·질문 보류 상한, D-16) |

세 포트는 전부 `127.0.0.1` 전용이고 기동할 때마다 `daemon.json` 에 실제 값이 적힌다(클라이언트는 그 파일을 읽는다).

**`PIXEL_CODEX_EXE` 자동 탐지 (`src/config.ts resolveCodexExe`, T22).** node-pty(ConPTY)는 PATH 의 `codex.cmd`/`codex.ps1`
셰임을 띄우지 못한다(T20 함정 4). 그래서 기본값이 `'codex'` 가 아니라 다음 순서로 **실제 실행 파일**을 찾은 결과다:
1. `PIXEL_CODEX_EXE` 가 있으면 그대로(존재 검사 안 함 — 사용자가 지정한 경로를 존중),
2. npm 전역 루트(`%APPDATA%\npm`, `%LOCALAPPDATA%\npm`, `%ProgramFiles%\nodejs`)의
   `node_modules/@openai/codex/node_modules/@openai/codex-*/vendor/*/bin/codex.exe` 스캔(플랫폼 패키지·타깃 폴더 이름이 버전마다 달라 하드코딩하지 않는다),
3. PATH 의 **진짜** `codex.exe`(셰임 제외),
4. 그래도 없으면 `'codex'` — 스폰이 실패하면서 오류로 드러난다(조용히 다른 것을 띄우지 않는다).

`claude` 는 npm 전역 설치를 권장한다(데스크탑 앱 번들 경로는 앱 업데이트마다 버전 폴더가 바뀐다).

## Codex 팀원 (M3)

`member.clockIn{engine:'codex'}` 이면 데몬이 Claude 와 **같은 오피스 이벤트·pending·RPC** 로 보이게 감싼다. 클라이언트는
`member.engine` 을 책상 배지에 쓰는 것 말고는 구분할 필요가 없다. 계약 표는 `PROTOCOL.md` §"엔진별 동작 차이", 아래는 운영에 필요한 것만.

- **hook 주입:** `<cwd>/.codex/hooks.json`(마커 `pixel-office`) + `--dangerously-bypass-hook-trust`. 같은 cwd 의 팀원들이 파일을
  공유하고 멤버 식별은 `PIXEL_MEMBER` 환경변수로 한다. 남이 쓴 파일이면 덮어쓰지 않고 `daemon.notice{warn}` 만 낸다.
  Codex 는 `SessionEnd`·`Interrupt` 의 timeout 을 3초로 클램프하며 경고 배너를 띄운다(정상) — 이 둘은 절대 보류하지 않는다.
- **스폰 인자:** `-c approval_policy="on-request" -c sandbox_mode="workspace-write"`, 재개는 `codex resume <id>` 서브커맨드.
- **MCP 주입:** `-c mcp_servers.team.url="http://127.0.0.1:<mcpPort>/mcp/<memberToken>"` — 그 실행에만 적용되고
  `~/.codex/config.toml` 은 건드리지 않는다. Claude 는 같은 URL 을 `--mcp-config <세션 mcp.json>` 으로 받는다. 서버 이름은 둘 다 `team`.
  실기에서 `/mcp verbose` 가 `team: connected (1 tool) · Tools: ask_user` 로 보인다(T22).
- **이벤트 매핑:** Codex 의 도구는 사실상 `Bash` 하나뿐이라 **명령 문자열 휴리스틱**으로 가른다 —
  `cat`/`rg`/`ls`/`sed -n`/`git diff|log|status` 등은 `reading`, `apply_patch` 는 `editing`, 나머지(쓰기 리다이렉트 포함)는 `running`.
  모르면 `running`(과장된 reading 보다 안전). Claude 는 도구 이름표(`Read`/`Write`/`Bash`)로 그대로 가른다.
- **첫 `idle`:** Codex 의 `SessionStart` 는 기동이 아니라 **첫 프롬프트 제출 때** 온다(T20 실측). 그래서 Codex 멤버만
  화면 준비(prompt ready)를 0.5초 주기로 보고 `starting → idle` 로 올린다(`Office.watchBootReady`, 최대 180초).
- **다이얼로그 자동 통과:** 폴더 신뢰("Do you trust the contents of this directory?") → **Enter**,
  한도 안내의 모델 전환 제안(`model-switch-offer`) → **Esc**(현재 모델 유지, 사용자 설정을 바꾸지 않는다 — T21).
  ScreenModel 이 감지하고 InputQueue 가 키를 보내며 `daemon.notice{info}` 를 남긴다. 사용자가 터미널 탭에서 직접 치는 중이면 얹지 않는다.
  CLI 자체 **허가 프롬프트**(`approval-prompt`)는 감지만 하고 **키를 절대 자동으로 보내지 않는다**(두 엔진 공통, T21).
- **퇴근:** `Ctrl+C` **한 번**(idle 프롬프트면 그것으로 exit 0). 2초 안에 안 죽으면 한 번 더, 그래도 안 죽으면 강제 종료.
  무조건 두 번 보내면 이미 죽은 뒤의 키가 새어 나간다(T20 함정 3). Claude 는 `/exit` + Enter.
- **폴백(Codex 전용, `src/office/codexFallback.ts`):** 모델이 도구를 안 부르고 말로만 턴을 끝낼 때를 위해 턴 종료 메시지를 승격한다 —
  질문처럼 보이면 `ask_user` 와 같은 모양의 question pending(`payload.fallback:'codex-stop'`, 답은 `[ANSWER q#…]` 봉투 **없이** 주입),
  아니면 진행 중이던 task 의 보고(`reported` + `report_text`). 질문이 보고보다 먼저다.
- **유령 정리:** 재시작 복구는 `child_pid` 의 프로세스 이름이 `codex` 를 포함할 때만 종료한다(pid 재사용 보호).

**2026-09-21 이후 재확인 목록** — ChatGPT 계정이 사용량 한도(리셋 2026-09-21 13:58, D-23)라 **모델 턴이 필요한 항목**은 전부 이월돼 있다.
한 번에 돌릴 수 있게 `docs/worklog/T23-MixedTeam.md` §"9/21 이후 확인 목록" 에 모아 두었다(통합 테스트는
`PIXEL_IT=1 npx tsx --test test/office/codex.integration.test.ts`).

## 구조

```
src/
  index.ts        진입점 — Office + RpcServer 기동, SIGINT 정중 종료
  config.ts       설정
  office/         Office 오케스트레이터(T07) + 재시작 복구·유령 정리(T09) + 엔진 라우팅·Codex 부팅 감시(T20) + codexFallback(T22) + 오류 코드
  rpc/            WebSocket JSON-RPC 서버(T07) — 계약은 PROTOCOL.md
  pty/            PtyManager — CLI 스폰·입출력·세션 hooks 설정 파일(T01)
  screen/         ScreenModel — headless xterm 화면 상태, 준비/다이얼로그 판정(T02)
  hooks/          HookReceiver + hook.js(CLI가 실행하는 브리지) + 결정 JSON 빌더(T03)
  adapters/       BaseHooksAdapter(공통 뼈대) + ClaudeHooksAdapter(T04) / CodexHooksAdapter·codexMapping(T20) — hook 이벤트 → 오피스 이벤트·pending
  mcp/            TeamToolsServer — Streamable HTTP MCP `/mcp/<memberToken>`, `ask_user`(T17). 두 엔진 공통
  input/          InputQueue — 타이핑 직렬화, prompt-ready 게이팅, 다이얼로그 통과(T05)
  store/          node:sqlite 저장소 — teams/members/events(seq)/pending/tasks(T06)
  cli/            콘솔 클라이언트(T08) — RpcClient + REPL/--exec
  tui-maps/       CLI 버전별 화면 패턴 JSON (verified 플래그)
test/             node:test (모듈별 폴더; *.integration.test.ts 는 PIXEL_IT=1)
```

## 데이터 흐름 (한 멤버)

```
RPC member.instruct ─▶ Store.tasks ─▶ InputQueue ─(idle ∧ promptReady)─▶ pty.paste + Enter
claude.exe|codex.exe ──stdout──▶ ScreenModel(화면) ──▶ term 알림(attach 클라이언트)
claude.exe|codex.exe ──hooks(node hook.js)──▶ HookReceiver ─▶ adapterFor(member.engine) ─▶ Store.events/pending ─▶ event/member.status 알림
approval.respond / question.respond ─▶ Adapter.resolve* ─▶ 보류 중인 hook 응답(allow/deny/answers)
```

멤버마다 pty·ScreenModel·InputQueue·어댑터 라우팅·MCP 엔드포인트가 따로다 — 엔진이 섞여도 서로 간섭하지 않는다(T23 `test/office/MixedTeam.test.ts`).

## 설계·결정

`../../docs/01-설계문서.md`, `../../docs/04-결정기록.md`, 태스크별 기록 `../../docs/worklog/`. 프로토콜 `PROTOCOL.md`.
