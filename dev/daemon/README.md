# pixel-office daemon

실제 `claude` / `codex` CLI를 가상 터미널(ConPTY)에 띄우고, hooks로 상태를 받고, 사무실 UI에 이벤트를 흘려주는 상주 프로세스. M0 완료(2026-09-15): 콘솔 클라이언트만으로 고용→지시→허가/질문→재접속→재시작 복구까지 동작. M3 완료(2026-09-16, T23): 같은 부서에 Claude 멤버와 Codex 멤버를 섞어도 각자 자기 이벤트·pending·터미널로 동작한다(엔진별 차이는 아래 "Codex 멤버" 절). **M4b(2026-09-16, T34~T38): 직무 체계 rev 3 — 부서 → 부장 → 팀장 → 팀원 3단 트리**(아래 절, D-32).

## 실행

```bash
npm install
npm start                 # 데몬 1회 실행 (ws://127.0.0.1:7420, hook 7421, MCP 7422)
npm run dev               # tsx watch
npm run cli               # 콘솔 클라이언트 REPL (help 로 명령 목록)
npm run cli -- --exec "dept create demo D:/proj claude 부장" --exec "say 부장 안녕" --wait-idle 부장   # 비대화형
npm test                  # node:test 전체 (PIXEL_IT=1 이면 실제 CLI 통합 테스트 포함)
npm run typecheck
```

콘솔 클라이언트(rev 3, T38 — 절 구성은 `src/cli/help.ts`, `help` 로 전체):

| 절 | 명령 |
|---|---|
| 부서·트리 | `dept create <name> <cwd> [claude\|codex] [부장이름]` · `depts` · `dept delete <dept>` · `tree` |
| 지시·터미널 | `say <head> <text>`(부장 외에는 -32004) · `attach`/`detach` · `type <member> <text>` · `int <member>` · `resize` |
| 내 책상 | `pending`(ask_parent 는 `이음 → 반장(ask_parent)`) · `allow` / `deny` / `answer` |
| 일·이벤트 | `tasks`(발행자→대상·상태·보고) · `events [n]` · `query <부서\|->` |
| 지시문 | `instr get` / `instr effective` / `instr set` |
| 멤버 | `members` · `fire <member>`(비상 퇴근, 확인 `y`) · `rehire` · `restart` |
| 디버그 | `teams` · `team create <dept> <name> …` · `team delete` · `hire <parent> <engine> <name>` · `say!` — 전부 `force:true`(D-34) |
| 연결 | `refresh` · `shutdown` · `quit` |

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

## 직무 체계 rev 3 — 부서 · 부장 · 팀장 · 팀원 (M4b, D-32)

```
사용자 ──department.create(부장 임명)──▶ 부장(head) ──create_team──▶ 팀장(lead) ──hire──▶ 팀원(member)
   ◀──── report·ask_user (부장만) ───────┘        ◀── report·ask_parent ──┘     ◀── report·ask_parent ──┘
```

**사용자가 만드는 것은 부서 하나뿐이다.** 부서 = 프로젝트 폴더(cwd)이고, 그 아래는 전부 멤버가 멤버를 만든다.
고용·지시는 항상 바로 아래로, 보고·질문은 항상 바로 위로만 간다(`members.parent_id` 가 유일한 기준).
스키마·RPC는 T34, 도구는 T35, 후처리·복구는 T36, 앱은 T37, 콘솔·문서는 T38.

**직급별 도구**(단일 출처 `src/mcp/TeamToolsServer.ts` 의 `RANK_TOOLS` — MCP 등록 목록·Office 게이트·지시문 템플릿·PROTOCOL 표가 전부 이 표를 읽는다):

| 직급 | 도구 |
|---|---|
| 부장 `head` | `create_team` · `dismiss_team` · `delegate` · `reply` · `report`(→ 사용자) · `ask_user` |
| 팀장 `lead` | `hire` · `dismiss` · `delegate` · `reply` · `report`(→ 부장) · `ask_parent` |
| 팀원 `member` | `report`(→ 팀장) · `ask_parent` |

직급 규칙은 **데몬이 두 겹으로** 강제한다(모델 말을 믿지 않는다): 요청마다 store 에서 rank 를 다시 읽어 ① 그 직급의 도구만
`tools/list` 에 내보내고 ② 그래도 불리면 `isError` + 한국어 사유. 대상 규칙(`delegate`/`reply`/`dismiss` 는 **살아 있는 직속
부하**에게만, `report`/`ask_parent` 는 **직속 상사**에게만)은 Office 의 관문 세 개(`requireToolRank`/`requireChild`/`requireParent`)가 본다.

**봉투**(pty 큐에 들어가는 시스템 메시지 — 모델이 출처를 헷갈리지 않게 항상 같은 모양):

| 봉투 | 언제 |
|---|---|
| `[TASK#n from <이름>(<직급>)]` | 위에서 일이 내려올 때(사용자 지시는 `from user`) |
| `[REPORTS task#n <이름> status=…]` … `[ALL_REPORTS_IN]` | 부하 보고가 **부모 단위**로 버퍼링됐다가 내가 낸 미종료 task 가 0 이 되는 순간 한 덩어리로 |
| `[QUESTION from <이름> q#<id>]` / `[ANSWER q#<id>]` | `ask_parent` → 상사, 상사의 `reply`(또는 사용자 오버라이드 `question.respond`) → 본인 |
| `[MESSAGE from <이름>]` | 열린 질문이 없는데 상사가 `reply` 했을 때 |
| `[TEAM] 팀원 변경: +/-<이름>` | 사용자가 끼워 넣거나 내보낸 멤버를 **직속 상사**에게 |
| `[RESUMED] …` | 데몬 재시작·`member.restart` 후(맡긴 일·직속 부하가 함께 실린다) |

**후처리·복구**(표는 `PROTOCOL.md` §"후처리" 8행, 구현은 `src/office/afterCare.ts`):

- 상위가 사라지면(`clockOut`/`error`/`teamDelete`/`departmentDelete`) **하위 트리 전체를 잎부터** 정리한다(`parentGone`).
  `interrupt`·`restart` 는 자기 턴만 건드리고 하위는 계속 돈다.
- 재시작 복구는 **뿌리부터**(부장 → 팀장 → 팀원). 부모가 못 살아나면 그 자식은 `error{restart: parent gone}` 로 두고 재스폰하지 않는다.
- `member.restart` 는 hook 보류만 끊고 `ask_user`/`ask_parent` 질문은 살린다(D-36).

**트리가 바뀌면 스냅샷을 민다(T38).** 멤버 행의 생멸은 `member.status` 가 알리지만 **부서·팀 행의 생멸을 알리는 알림은 없어서**,
콘솔에서 지운 부서가 앱에 유령으로 남아 있었다(T37 함정 ①). 이제 `department.create`/`department.delete`/`team.create`/`team.delete`
(= 부장의 `create_team`/`dismiss_team` 포함) 뒤에 Office 가 `tree` 이벤트를 내고 RpcServer 가 전 클라이언트에 `snapshot` 알림을 보낸다.
클라이언트는 `hello` 스냅샷과 **같은 코드로** 적용하면 된다.

**디버그 전용 RPC**(D-34): 없어진 사용자 기능은 지우지 않고 `force:true` 뒤에 숨겼다 — `team.create`·`member.clockIn`
(+ `member.instruct{force}`). `force` 가 없으면 -32004. 앱은 절대 보내지 않고 콘솔의 "디버그" 절과 테스트만 쓴다.
`member.clockOut` 은 예외로 누구에게나 열려 있다 — 굳은 세션을 사용자가 치울 **비상구**(콘솔 `fire` 는 확인 `y` 를 받는다).

**아직 안 본 것:** 트리 전체 실기(부서 → 부장 → 팀 → 팀원 → 보고 상향 → 부장 퇴근 시 부서 정리)는 **T39 시연** 몫이다.
rev 3 를 **Codex 엔진**으로 돌려 보는 것은 사용량 한도 때문에 **2026-09-21 이후**로 이월돼 있다(바로 아래 절 끝의 재확인 목록).

## Codex 멤버 (M3)

멤버의 엔진이 `codex` 면(부서 생성의 `headEngine`, `create_team`/`hire` 의 `engine`) 데몬이 Claude 와 **같은 오피스 이벤트·pending·RPC** 로 보이게 감싼다. 클라이언트는
`member.engine` 을 책상 배지에 쓰는 것 말고는 구분할 필요가 없다. 계약 표는 `PROTOCOL.md` §"엔진별 동작 차이", 아래는 운영에 필요한 것만.

- **hook 주입:** `<cwd>/.codex/hooks.json`(마커 `pixel-office`) + `--dangerously-bypass-hook-trust`. 같은 cwd 의 팀원들이 파일을
  공유하고(한 부서의 팀들은 같은 cwd 다 — D-32) 멤버 식별은 `PIXEL_MEMBER` 환경변수로 한다. 남이 쓴 파일이면 덮어쓰지 않고 `daemon.notice{warn}` 만 낸다.
  Codex 는 `SessionEnd`·`Interrupt` 의 timeout 을 3초로 클램프하며 경고 배너를 띄운다(정상) — 이 둘은 절대 보류하지 않는다.
- **스폰 인자:** `-c approval_policy="on-request" -c sandbox_mode="workspace-write"`, 재개는 `codex resume <id>` 서브커맨드.
- **MCP 주입:** `-c mcp_servers.team.url="http://127.0.0.1:<mcpPort>/mcp/<memberToken>"` — 그 실행에만 적용되고
  `~/.codex/config.toml` 은 건드리지 않는다. Claude 는 같은 URL 을 `--mcp-config <세션 mcp.json>` 으로 받는다. 서버 이름은 둘 다 `team`.
  실기에서 `/mcp verbose` 가 `team: connected (1 tool) · Tools: ask_user` 로 보인다(T22 — 그때는 도구가 하나였다. T35 부터는 직급별 목록이라 팀원이면 `report, ask_parent` 가 보인다).
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
                  트리(T34: 부서·부장·팀장·팀원, hireChild 단일 스폰) + 직급 도구 관문(T35) + afterCare/derived(T36: 하위 트리 정리·복구 순서)
                  + instructions/(프리앰블·직급별 템플릿, T26b·T35)
  rpc/            WebSocket JSON-RPC 서버(T07) — 계약은 PROTOCOL.md
  pty/            PtyManager — CLI 스폰·입출력·세션 hooks 설정 파일(T01)
  screen/         ScreenModel — headless xterm 화면 상태, 준비/다이얼로그 판정(T02)
  hooks/          HookReceiver + hook.js(CLI가 실행하는 브리지) + 결정 JSON 빌더(T03)
  adapters/       BaseHooksAdapter(공통 뼈대) + ClaudeHooksAdapter(T04) / CodexHooksAdapter·codexMapping(T20) — hook 이벤트 → 오피스 이벤트·pending
  mcp/            TeamToolsServer — Streamable HTTP MCP `/mcp/<memberToken>`. **직급별 도구 표 `RANK_TOOLS`**(T35)가 여기 하나뿐. 두 엔진 공통
  input/          InputQueue — 타이핑 직렬화, prompt-ready 게이팅, 다이얼로그 통과(T05)
  store/          node:sqlite 저장소 — departments/teams/members(parent_id·rank)/events(seq)/pending/tasks(T06, 스키마 v2 = T34)
  cli/            콘솔 클라이언트(T08, rev 3 = T38) — RpcClient + REPL/--exec, parse.ts(순수 파싱)·format.ts(출력·tree)·help.ts(도움말 절)
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
