# pixel-office daemon

실제 `claude` / `codex` CLI를 가상 터미널(ConPTY)에 띄우고, hooks로 상태를 받고, 사무실 UI에 이벤트를 흘려주는 상주 프로세스.

현재: **M5 완료(2026-09-17, T30·T31) = v1b**. 지나온 단계 — M0(2026-09-15): 콘솔 클라이언트만으로 고용→지시→허가/질문→재접속→재시작 복구. M3(2026-09-16, T23): 같은 부서에 Claude 멤버와 Codex 멤버를 섞어도 각자 자기 이벤트·pending·터미널로 동작(아래 "Codex 멤버" 절). **M4b(2026-09-16, T34~T39): 직무 체계 rev 3 — 부서 → 부장 → 팀장 → 팀원 3단 트리**(아래 절, D-32). **M5(2026-09-17, T30·T31): 안정화** — 단일 데몬 가드(D-40) · hook 핸들러 예외가 CLI 를 세워 두지 않는 계약 · 보존 정리(D-39) · 재접속 백오프 · 오류 포즈/재고용 실기 · 이벤트 코얼레스는 넣지 않기로 확정(D-41). 계약은 `PROTOCOL.md` §"데몬 수명·안정화 (T30)".

**데몬은 한 번에 하나만 뜬다**(D-40): `daemon.json` 의 pid 가 살아 있고 그 ws 포트가 듣고 있으면 기동을 거부하고 exit 3. 통합 테스트는 `PIXEL_FORCE_START=1` 이 아니라 **자기 `PIXEL_DATA_DIR`** 을 써야 한다.
**daemon.json 이 안 보여도** hook·MCP·ws 포트가 EADDRINUSE 면 같은 문구·같은 exit 3 으로 거부한다(T41 — 다른 환경/다른 사용자로 띄운 데몬은 자기 `%LOCALAPPDATA%` 에 daemon.json 을 쓰므로 pid 검사를 그냥 통과한다). 문구에 포트 번호와 `netstat -ano | findstr :<포트>` → `taskkill /F /PID <pid>` 가 들어 있다.

## 실행

```bash
npm install
npm start                 # 데몬 1회 실행 (ws://127.0.0.1:7420, hook 7421, MCP 7422)
npm run dev               # tsx watch
npm run cli               # 콘솔 클라이언트 REPL (help 로 명령 목록)
npm run cli -- --exec "dept create demo D:/proj claude 부장" --exec "say 부장 안녕" --wait-idle 부장   # 비대화형
npm test                  # node:test 전체 539건 (통합 테스트는 PIXEL_IT=1 없으면 skip — 아래 "테스트" 절)
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

## 테스트

`npm test` = `node --import tsx --test test/**/*.test.ts`. **단위 스위트는 CLI 를 안 띄운다**(539건, 통합 6건은 skip).

**통합 테스트(opt-in, `PIXEL_IT=1`)** 는 진짜 데몬을 자식 프로세스로 띄우고 **진짜 `claude`/`codex`** 를 출근시킨다 —
모델 턴을 쓰고 몇 십 초가 걸리므로 하나씩 돌린다(전제: `dev/spike-0/sandbox` 가 그 CLI 에서 신뢰된 폴더이고 로그인이 끝나 있을 것).

| 파일 | 무엇을 보나 | 엔진 | 실측 시간 |
|---|---|---|---|
| `test/office/integration.test.ts` (T07) | 부서 생성 → 지시 → 허가 → 파일 → 퇴근 → shutdown | claude | ~14초 |
| `test/office/askuser.integration.test.ts` (T17) | `ask_user` → `question.respond` → `[ANSWER q#…]` → 모델이 답을 말한다 | claude | ~17초 |
| `test/office/restart.integration.test.ts` (T09) | 데몬 하드 킬 → 재기동 → `--resume` 복구 → 이전 대화 회상 | claude | ~30초 |
| `test/office/teamtools.integration.test.ts` (T25) | 팀장의 `hire` → `delegate` → 팀원 작업 → `[REPORTS]` → `report` | claude | ~39초 |
| `test/office/ranktools.integration.test.ts` (T35) | 부장의 `create_team` → 팀장 `hire` → 보고 4단 상승 | claude | 수 분 |
| `test/office/codex.integration.test.ts` (T20·T42) | Codex 부장: 지시 → 허가 → 파일 → 보고 폴백 → Ctrl+C 퇴근 | codex | ~24초 |

```bash
PIXEL_IT=1 npx tsx --test test/office/askuser.integration.test.ts
PIXEL_IT=1 PIXEL_IT_SANDBOX=D:/myproject/pixel-office/dev/spike-0/sandbox \
  npx tsx --test test/office/restart.integration.test.ts     # sandbox 가 없는 체크아웃(worktree)에서
```

- **격리는 테스트가 알아서 한다**(`test/office/it-helpers.ts` 의 `itEnv()`): 매 실행마다 **임시 `PIXEL_DATA_DIR`**
  (`%TEMP%\pixel-office-<t..>-it-*`)과 **빈 포트 3개**(`PIXEL_WS_PORT`/`PIXEL_HOOK_PORT`/`PIXEL_MCP_PORT`)를 잡는다.
  기본 7420-7422 에 진짜 데몬이 떠 있어도 부딪히지 않는다 — **`PIXEL_FORCE_START` 는 쓰지 않는다**(D-40).
  포트를 손으로 줄 일은 없다(주고 싶으면 그 세 환경변수 그대로).
- **`PIXEL_IT_SANDBOX`** 는 멤버의 cwd(기본 `dev/spike-0/sandbox`)를 갈아끼우는 **테스트 전용** 변수다.
  `dev/spike-0/sandbox/` 는 gitignore 대상이라 worktree 체크아웃에는 없다(같은 이유로 `MixedTeam.test.ts` 의 픽스처
  `dev/spike-0/hooklog-*.json` 도 없다 — 단위 스위트를 그린으로 돌리려면 저장소 본체에서 복사해 온다).
- 끝나면 테스트가 스스로 치운다: 부서 삭제/퇴근 → `daemon.shutdown` → 자기 dataDir 로 스폰된 `claude.exe` 만 골라
  정리(`sweepClaudeByDataDir`) → 임시 폴더 삭제. 이 기계의 다른 CLI 프로세스는 건드리지 않는다.
- 실측 로그는 태스크 기록에: T42(codex) `docs/worklog/T42-CodexLive.md`, T44(나머지 넷) `docs/worklog/T44-ITandPasteRace.md`.

## 환경변수

| 변수 | 기본값 | 의미 |
|---|---|---|
| `PIXEL_WS_PORT` | 7420 | WebSocket(JSON-RPC) 포트 — 앱·콘솔 클라이언트가 붙는다 |
| `PIXEL_HOOK_PORT` | 7421 | CLI hooks가 POST하는 HTTP 포트 (`/hook/<memberToken>/<event>`) |
| `PIXEL_MCP_PORT` | 7422 | TeamTools MCP(Streamable HTTP) 포트 — CLI 세션이 `/mcp/<memberToken>` 으로 붙는다(T17) |
| `PIXEL_DATA_DIR` | `%LOCALAPPDATA%\pixel-office` | `daemon.json`(토큰·세 포트)·DB·세션 설정·멤버 지시문 |
| `PIXEL_CLAUDE_EXE` | **자동 탐지**(아래) | claude 실행 파일 |
| `PIXEL_CODEX_EXE` | **자동 탐지**(아래) | codex 실행 파일 |
| `PIXEL_HOOK_TIMEOUT_SEC` | 86400 | 세션 hooks timeout(허가·질문 보류 상한, D-16) |
| `PIXEL_USAGE_POLL_SEC` | 60 | 엔진 연결 확인(`claude auth status`·`codex login status`) 주기. `0` 이면 **기동 시 한 번만**(아래 "사용량") |
| `PIXEL_USAGE_PROBE` | (켬) | `0` 이면 **확인용 세션을 띄우지 않는다**(턴 종료 출처만 쓴다 — 아래 "확인용 세션") |
| `PIXEL_USAGE_PROBE_SEC` | 300 | 확인용 세션이 `/usage`·`/status` 를 여는 주기(초). 모델 턴을 쓰지 않아 할당량이 들지 않는다 |
| `PIXEL_FORCE_START` | (없음) | `1` 이면 단일 데몬 가드를 건너뛴다(D-40). **테스트는 이것 대신 `PIXEL_DATA_DIR` 을 따로 줄 것** |
| `PIXEL_PARENT_PID` | (없음) | **부모 앱의 pid**(T46-1, D-47). 값이 있으면 데몬이 2초마다 그 프로세스를 지켜보다 사라지면 스스로 정리하고 끝난다 — 아래 "수명 주기" |
| `PIXEL_KEEP_DAEMON` | (없음) | `1` 이면 **부모 감시를 끈다**. 앱을 닫아도 데몬과 세션이 남는다(D-02 의 옛 동작 = 앱 설정 "앱을 닫아도 계속 일하기") |
| `PIXEL_HOOK_LOG` | (없음) | 진단용. 파일 경로를 주면 `hook.js` 가 **CLI 가 보낸 페이로드와 우리가 돌려준 결정**을 JSONL 로 덧붙인다(T42) |

세 포트는 전부 `127.0.0.1` 전용이고 기동할 때마다 `daemon.json` 에 실제 값이 적힌다(클라이언트는 그 파일을 읽는다).

## 수명 주기 — 누가 데몬을 끄는가 (T46-1, D-47 · 설계 `docs/design/수명주기.md`, 계약 `PROTOCOL.md` "수명 주기")

앱·데몬·AI 세션은 **한 몸**이다: 앱을 켜면 데몬이 같이 켜지고, 앱을 끄면 AI 세션까지 전부 닫힌다.
데몬 쪽이 하는 일은 셋이다 — 부모 감시 · 종료 완결 · 기동 복구.

| 어떻게 띄웠나 | 부모 감시 | 앱이 사라지면 | 다시 켰을 때 |
|---|---|---|---|
| 앱이 띄움 (`PIXEL_PARENT_PID=<앱 pid>`) | **켬** — 2초마다 | 로그 `부모 앱이 사라졌다` + `daemon.notice{kind:'parent-gone'}` → `daemon.shutdown` 과 같은 정리 후 종료 | `suspended` 캐릭터가 **말없이** 다시 출근 |
| 콘솔에서 띄움 (`npm start`) | 끔 — 주인이 없다 | (아무 일 없음) | 같음 |
| 콘솔에서 띄웠는데 앱이 붙음 (`hello{parentPid}`) | **켬** — 그 앱이 주인이 된다 | 위와 같음 | 같음 |
| `PIXEL_KEEP_DAEMON=1` | **끔**(강제) | 남는다 — `hello{parentPid}` 도 무시 | 같음 |

- **종료 완결:** 어느 길로 들어오든 ① 살아 있던 멤버를 `suspended` 로 접고(하던 task 는 끊지 않는다) ② 정중히 닫고
  ③ 확인용 세션까지 죽이고 ④ **자식 pid 가 정말 사라졌는지 확인한 뒤**(안 닫혔으면 이름 확인을 거쳐 트리째)
  ⑤ 그제야 `daemon.json` 을 지운다. `daemon.shutdown` 응답은 `{closing: N}`(닫는 세션 수), 두 번째 요청은 멱등.
- **기동 복구:** `suspended` 도 되살린다. 한꺼번에 띄우는 CLI 는 **최대 3개**, 순서는 (보고 있는 부서 → 마지막 활동 부서)
  × (부장 → 팀장 → 팀원). **하던 일이 있던 캐릭터에게만** `[RESUMED]` 를 타이핑한다 — 나머지는 말없이 앉힌다(토큰 0).
- **상태 한 줄 더:** `members.status` 에 `suspended`(잠시 닫힘). 사용자 퇴근·상사 dismiss 의 `exited`, 사고의 `error` 와 다르다.
  스키마 v5 — 여는 순간 `members` 표만 자동으로 다시 만들어진다(행은 그대로).

**`PIXEL_CODEX_EXE` 자동 탐지 (`src/config.ts resolveCodexExe`, T22).** node-pty(ConPTY)는 PATH 의 `codex.cmd`/`codex.ps1`
셰임을 띄우지 못한다(T20 함정 4). 그래서 기본값이 `'codex'` 가 아니라 다음 순서로 **실제 실행 파일**을 찾은 결과다:
1. `PIXEL_CODEX_EXE` 가 있으면 그대로(존재 검사 안 함 — 사용자가 지정한 경로를 존중),
2. npm 전역 루트(`%APPDATA%\npm`, `%LOCALAPPDATA%\npm`, `%ProgramFiles%\nodejs`)의
   `node_modules/@openai/codex/node_modules/@openai/codex-*/vendor/*/bin/codex.exe` 스캔(플랫폼 패키지·타깃 폴더 이름이 버전마다 달라 하드코딩하지 않는다),
3. PATH 의 **진짜** `codex.exe`(셰임 제외),
4. 그래도 없으면 `'codex'` — 스폰이 실패하면서 오류로 드러난다(조용히 다른 것을 띄우지 않는다).

**`PIXEL_CLAUDE_EXE` 자동 탐지 (`src/config.ts resolveClaudeExe`, T41).** 예전에는 데스크탑 앱 번들의 **버전 폴더를
문자열로 박아** 뒀다(`%APPDATA%\Claude\claude-code\2.1.270\claude.exe`) — 앱이 업데이트되면 그 폴더가 사라져
`dept create` 가 `-32000 File not found: ...\claude.exe` 로 죽었다(실기). 지금 순서:
1. `PIXEL_CLAUDE_EXE` 가 있으면 그대로(존재 검사 안 함),
2. PATH 의 **진짜** `claude.exe`(`.cmd`/`.ps1` 셰임은 node-pty 가 못 띄우므로 세지 않는다),
3. `%APPDATA%\Claude\claude-code\<버전>\claude.exe` 중 **가장 높은 버전**(숫자 비교 — 그 버전에 exe 가 없으면
   다음 버전으로 내려간다),
4. 그래도 없으면 `'claude'`. 기동 로그에 `[daemon] claude : <경로>` 가 찍히고, 못 찾았으면 **찾아본 곳**과
   `PIXEL_CLAUDE_EXE` 안내가 같이 나온다.

`claude` 는 npm 전역 설치를 권장한다(그러면 2번에서 잡힌다).

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

**실기로 본 것(T39·T31):** 부서 → 부장 → 팀 → 팀원 → 보고 상향 → `ask_parent` 3단 왕복 → 상위 퇴근 시 하위 트리 잎부터 정리 → `taskkill /F` 뒤 트리 순서 복구 → 셸 뮤텍스 → 부서 삭제. T31 에서는 **부서 1 · 팀 2 · 멤버 7명**을 한꺼번에 돌려(hire → delegate → 셸 쓰기 4건 경합 → 보고 상향) 셸 락이 도착 순 FIFO 로 풀리는 것과 이벤트 밀도(31.3건/분, 피크 1초 6건 — D-41)를 쟀다.
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
  **도구 이름은 Claude 와 같은 `mcp__team__<tool>` 이고, Codex 는 MCP 도구에 `PermissionRequest` 를 띄우지 않는다**
  (`PreToolUse` → `PostToolUse` 로 바로 간다) — 즉 D-22(자동 allow)는 Codex 에서 실제로는 발화하지 않는다(T42 실측).
- **이벤트 매핑:** Codex 의 도구는 사실상 `Bash` 하나뿐이라 **명령 문자열 휴리스틱**으로 가른다 —
  `cat`/`rg`/`ls`/`sed -n`/`git diff|log|status` 등은 `reading`, `apply_patch` 는 `editing`, 나머지(쓰기 리다이렉트 포함)는 `running`.
  모르면 `running`(과장된 reading 보다 안전). Claude 는 도구 이름표(`Read`/`Write`/`Bash`)로 그대로 가른다.
- **첫 `idle`:** Codex 의 `SessionStart` 는 기동이 아니라 **첫 프롬프트 제출 때** 온다(T20 실측). 그래서 Codex 멤버만
  화면 준비(prompt ready)를 0.5초 주기로 보고 `starting → idle` 로 올린다(`Office.watchBootReady`, 최대 180초).
- **다이얼로그 자동 통과:** 폴더 신뢰("Do you trust the contents of this directory?") → **Enter**,
  한도 안내의 모델 전환 제안(`model-switch-offer`) → **Esc**(현재 모델 유지, 사용자 설정을 바꾸지 않는다 — T21).
  ScreenModel 이 감지하고 InputQueue 가 키를 보내며 `daemon.notice{info}` 를 남긴다. 사용자가 터미널 탭에서 직접 치는 중이면 얹지 않는다.
  CLI 자체 **허가 프롬프트**(`approval-prompt`)는 감지만 하고 **키를 절대 자동으로 보내지 않는다**(두 엔진 공통, T21).
- **중단:** `Interrupt` hook 은 Ctrl+C 전용이 아니다 — **Esc 로 턴을 끊어도 같은 hook 이 온다**(T42 실측). 퇴근 Ctrl+C 도
  `Interrupt` → `SessionEnd` 순으로 낸다. 페이로드는 `session_id turn_id transcript_path cwd hook_event_name model permission_mode`
  일곱 개뿐이라 어댑터가 읽을 것이 없다(`test/fixtures/hooklog-codex-t42.json`).
- **퇴근:** `Ctrl+C` **한 번**(idle 프롬프트면 그것으로 exit 0). 2초 안에 안 죽으면 한 번 더, 그래도 안 죽으면 강제 종료.
  무조건 두 번 보내면 이미 죽은 뒤의 키가 새어 나간다(T20 함정 3). Claude 는 `/exit` + Enter.
- **재시작 복구(`codex resume <id>`):** 복원 중에는 화면이 prompt ready 인데도 **Enter 가 버려진다.** 그래서 InputQueue 가
  Enter 뒤 프롬프트가 실제로 들어갔는지(= `isIdle()` 이 풀리는지) 2.5초 창으로 확인하고 최대 4회까지 다시 보낸다(T42).
  실기에서 Codex 멤버는 매번 1회 재시도가 필요했고 Claude 멤버는 0회였다. 안 그러면 `[RESUMED]` 지시가 입력 상자에 남아
  그 멤버의 큐가 영구히 막힌다.
  **턴을 한 번도 안 돈 Codex 멤버는 `session_id` 가 없어**(위 "첫 idle") 재시작에서 `error{restart: no session id to resume}`
  가 된다 — `rehire` 로 새 세션을 띄우면 된다(잃을 맥락도 없다).
- **폴백(Codex 전용, `src/office/codexFallback.ts`):** 모델이 도구를 안 부르고 말로만 턴을 끝낼 때를 위해 턴 종료 메시지를 승격한다 —
  질문처럼 보이면 `ask_user` 와 같은 모양의 question pending(`payload.fallback:'codex-stop'`, 답은 `[ANSWER q#…]` 봉투 **없이** 주입),
  아니면 진행 중이던 task 의 보고(`reported` + `report_text`). 질문이 보고보다 먼저다.
- **유령 정리:** 재시작 복구는 `child_pid` 의 프로세스 이름이 `codex` 를 포함할 때만 종료한다(pid 재사용 보호).

**실기 점검 결과(2026-09-21, T42)** — 한도가 풀린 뒤 `docs/worklog/T23-MixedTeam.md` §"9/21 이후 확인 목록 A~J" 를 한 번에 돌렸다.
결과·증거·고친 결함은 `docs/worklog/T42-CodexLive.md`. 통합 테스트는 `PIXEL_IT=1 npx tsx --test test/office/codex.integration.test.ts`
(부서 생성 → Codex 부장 → 지시 → 허가 → 파일 → 보고 → 퇴근, 약 24초).

**hook 원문 보기(진단):** `PIXEL_HOOK_LOG=<파일 경로>` 를 주고 데몬을 띄우면 `hook.js` 가 **보낸 페이로드와 받은 결정**을
JSONL 로 그 파일에 덧붙인다(옵트인, 안 주면 아무 일도 안 한다). CLI 가 실제로 무엇을 보내는지 볼 유일한 길이다 —
Codex 의 MCP 도구 이름·`Interrupt` 페이로드를 이걸로 확정했다(T42).

## 사용량 (T43, D-45)

엔진별 남은 주간 한도와 캐릭터별 컨텍스트·누적 토큰·비용을 모아 앱·콘솔에 보여 준다. 와이어 모양은 `PROTOCOL.md` 의
"사용량" 절, 설계 전문은 `../../docs/design/사용량-표시.md`, 실측 근거는 `../../docs/worklog/T43-0-UsageSpike.md`.
콘솔에서는 `usage` 한 줄이면 된다.

**원칙(D-45).** 자격 증명 파일을 읽지 않고 벤더 API 를 직접 부르지 않는다 — **CLI 가 스스로 내주는 것만** 쓴다.
계정 **이메일은 저장도 표시도 하지 않는다**(파서가 그 키를 읽지도 않는다). 멤버 세션에 `/usage`·`/status` 같은
슬래시 명령을 밀어 넣지 않는다.

**어디서 오는가**

| 값 | 출처 | 언제 |
|---|---|---|
| Claude 주간·5시간 한도, 멤버 컨텍스트·비용 | 세션 `--settings` 에 주입한 **statusLine 명령**(`src/hooks/statusline.js` → `POST /status/<memberToken>`)의 페이로드 `rate_limits`·`context_window`·`cost` | 턴 종료·화면 다시 그릴 때(이벤트) |
| Claude 멤버 누적 토큰 | **살아 있는 동안**: transcript 의 `type:"assistant"` 줄 `message.usage` 를 증분 합산(T43-5). **세션이 끝난 뒤**: 마지막 `type:"cost-state"` 줄(모델별 합산 — 배경 haiku 까지)이 이긴다 | `Stop` 직후 |
| Codex 주간 한도·요금제, 멤버 컨텍스트·누적 토큰 | rollout(JSONL)의 마지막 `token_count` 중 `limit_id==="codex"` ∧ `primary!=null` 인 것 | `Stop`·화면 idle 폴백 |
| 연결 여부·Claude 요금제 | `claude auth status`(JSON) · `codex login status` — 5초 타임아웃, `CLAUDE_CODE*`·`CLAUDE_CONFIG_DIR` 을 지우고 띄운다 | 기동 시 + `PIXEL_USAGE_POLL_SEC`(기본 60초) |
| 두 엔진 주간·5시간 한도, **모델별 주간 한도**, Codex 요금제 | **확인용 세션**(아래 절)이 읽은 `/usage`·`/status` 화면 | `PIXEL_USAGE_PROBE_SEC`(기본 300초) |
| Codex 비용(USD) | **없다** — Codex 는 토큰만 준다 | — |

두 출처(턴 종료 · 확인용 세션)가 같은 칸을 대므로 **칸마다 더 최근에 측정된 값이 이긴다.** 늦게 도착해도 오래된
측정이면 버린다 — `engines[].source` 가 `"probe"` / `"turn"` 으로 마지막에 이긴 출처를 말한다.

기록 파일은 **끝에서 64KB 만** 비동기로 읽고(`src/usage/tail.ts`), 잘린 첫 줄은 버린다. 파일이 없거나 잠겨 있으면
**이전 값을 그대로 둔다**(지우지 않는다). 파서는 필드별로 방어적이라 CLI 업데이트로 이름이 바뀌면 **그 값만** `null` 이 된다.

**Claude 토큰은 살아 있는 동안 줄 단위로 합산한다 (T43-5, `src/usage/ClaudeTranscriptUsage.ts`).**
`cost-state` 줄은 **CLI 프로세스가 끝날 때만** 적힌다(실측: 살아 있는 세션의 transcript 에 0개). 멤버 세션은 몇
시간씩 살아 있으므로 그때까지 토큰 칸이 비어 있었다 — 그래서 `type:"assistant"` 줄의 `message.usage` 를 직접 더한다.

- **멤버마다 바이트 오프셋**을 들고 덧붙은 부분만 읽는다(`claudeTranscriptReader.ts`). 파일이 줄면 회전으로 보고
  리셋, **`transcript_path` 가 바뀌면 리셋**한다 — `--resume` 이 새 파일을 파면 CLI 자신의 `/cost` 도 0 부터
  다시 세기 때문이다(실측). 재기동 뒤 첫 훑기가 20MB 를 넘으면 뒤쪽만 읽는다.
- **같은 `message.id` 는 한 번만** 센다. 내용 블록이 스트리밍되며 같은 응답이 여러 줄로 적히고 **앞 줄은
  중간값**이라 마지막 값으로 교체한다(실측 중복 481건 중 112건이 달랐다).
- **`thinkingTokens` 를 `output` 에 더하지 않는다** — `output_tokens` 에 이미 들어 있다(실측: cost-state 의
  `outputTokens` 가 줄 합과 같고 `thinkingTokens` 는 그 부분집합).
- 이 합은 CLI 의 `/cost` 보다 **0~4% 낮다.** 제목 생성용 배경 haiku 호출 등이 transcript 에 줄을 남기지 않는다.
  세션이 끝나 `cost-state` 가 나타나면 그쪽으로 정확히 맞춰진다. 근거 전문: `../../docs/worklog/T43-5-ClaudeTokens.md`.
- 누적 상태는 **메모리에만** 있다. 재기동 직후에는 `member_usage` 의 합계가 화면을 채우고, 그 멤버의 첫 턴
  종료 때 파일을 0 부터 한 번 다시 훑어 오프셋을 되찾는다(id 로 세므로 이중 계산이 없다).

**알려진 한계**

- **Claude 한도는 첫 턴 뒤에 온다.** 세션을 막 띄웠거나 `--resume` 한 직후에는 statusLine 페이로드에 `rate_limits`
  키 자체가 없다(실측). 그래서 마지막으로 본 값을 `engine_usage` 테이블에 남겨 두고 `updatedAt` 과 함께 보여 준다.
  한 번도 못 봤으면 "첫 작업 후 표시".
- **Codex 5시간 한도는 요금제에 따라 없다**(Pro 실측 전수 `null`). `session:null` 이 정상이다.
- **Codex 비용은 없다.** `costUsd` 는 언제나 `null`.
- **statusLine 은 세션당 하나**라 사용자의 전역 statusLine 설정이 이 툴이 띄운 세션에서만 덮인다(데몬 소유 세션이라
  수용). 우리 스크립트는 `컨텍스트 37% · 주간 45% 남음` 한 줄을 돌려주고, 실패하면 빈 줄을 찍고 즉시 끝난다 —
  상태줄 하나 때문에 TUI 가 멈추면 안 된다. **Codex 에는 statusLine 이 없다.**
**저장**: 스키마 v3 의 `engine_usage`(엔진 PK — 멤버가 다 나가도 남긴다) · `member_usage`(멤버 PK — 멤버 행과 함께
FK cascade 로 사라진다) + v4 의 `usage_probe`(확인용 세션 pid). 알림은 **값이 바뀔 때만** 나가고, 값이 같아도 마지막
확인이 60초를 넘겼으면 `updatedAt` 만 올려 한 번 더 민다(앱의 "N분 전 기준" 이 거짓말을 하지 않게).

### 확인용 세션 (T43-4, `src/usage/UsageProbe.ts`)

위 한계("Claude 한도는 첫 턴 뒤에 온다")를 메운다. 실측(T43-0 Q3): 새 세션에서 `/usage` 만 치면 **모델 턴 0 ·
토큰 0** 으로 주간 한도가 그대로 나온다. 그래서 **연결된 엔진마다 숨은 CLI 하나**를 띄워 두고 5분마다 화면만 읽는다 —
아무도 일하지 않은 동안에도, **툴 밖에서 쓴 사용량도** 다음 판에서 따라잡는다.

- **멤버가 아니다.** `members` 행 없음 · 스냅샷(`members`·`usage.members`)·사무실·이벤트에 안 나옴 ·
  hooks/MCP/statusLine 주입 없음 · 지시 받지 않음. cwd 는 `<dataDir>/usage-probe/<engine>` 의 빈 폴더고,
  pty 세션도 **Office 것이 아니라 UsageProbe 자기 PtyManager** 에 뜬다(멤버 목록에 섞이지 않게).
- 한 판: 프롬프트 준비 → 슬래시 명령 타이핑 → 0.7초 뒤 Enter → 패널이 **새로** 그려질 때까지 대기(화면 패턴
  등장 횟수가 늘어나는 것으로 판정 — Codex 는 스크롤백에 옛 패널이 남는다) → 파싱 → `Esc` → 프롬프트 복귀 확인.
- 첫 실행 신뢰 다이얼로그는 **멤버와 같은 길**로 통과한다(`ScreenModel` 감지 + `InputQueue` 의 강조 기반 키).
- 화면 패턴은 `src/tui-maps/<engine>-<ver>.json` 의 **`usage` 절**에만 있다(코드에 CLI 문구가 없다).
  안 맞으면 그 판을 버리고 `daemon.notice{warn}` 을 **엔진당 데몬 수명에 한 번**. 턴 종료 출처가 계속 값을 대므로
  기능은 죽지 않는다.
- 엔진이 `connected:false` 면 안 띄우고(나중에 붙으면 그때), 죽으면 **1분 → 2 → 4 → 8 → 10분(상한)** 백오프.
- Claude 는 기동에 **약 60초** 걸린다 — 그 동안은 DB 의 마지막 값 + "N분 전".
- 끄기: `PIXEL_USAGE_PROBE=0`(상주 프로세스가 싫을 때). 주기: `PIXEL_USAGE_PROBE_SEC`(기본 300).
- 종료: `Office.shutdown()` 이 죽인다. 데몬을 **하드 킬**해 살아남은 것은 다음 기동이 `usage_probe` 표(v4)의
  pid 를 보고 정리한다(이름이 엔진 이름을 포함할 때만 — 멤버 유령 정리와 같은 가드, D-17).

## 구조

```
src/
  index.ts        진입점 — Office + RpcServer 기동, 사용량 연결 폴링·확인용 세션 시작, SIGINT 정중 종료
  config.ts       설정
  office/         Office 오케스트레이터(T07) + 재시작 복구·유령 정리(T09) + 엔진 라우팅·Codex 부팅 감시(T20) + codexFallback(T22) + 오류 코드
                  트리(T34: 부서·부장·팀장·팀원, hireChild 단일 스폰) + 직급 도구 관문(T35) + afterCare/derived(T36: 하위 트리 정리·복구 순서)
                  + instructions/(프리앰블·직급별 템플릿, T26b·T35)
  rpc/            WebSocket JSON-RPC 서버(T07) — 계약은 PROTOCOL.md
  pty/            PtyManager — CLI 스폰·입출력·세션 hooks 설정 파일(T01)
  screen/         ScreenModel — headless xterm 화면 상태, 준비/다이얼로그 판정(T02)
  hooks/          HookReceiver(+ `POST /status/<memberToken>`, T43) + hook.js·statusline.js(CLI가 실행하는 브리지) + 결정 JSON 빌더(T03)
  usage/          UsageTracker(엔진·멤버 사용량 + 영속·변화 감지·출처 병합) + UsageProbe(확인용 세션, T43-4)
                  + ClaudeTranscriptUsage/claudeTranscriptReader(살아 있는 세션의 토큰 증분 누적, T43-5)
                  + parse/(statusLine·cost-state·token_count·auth·usageScreen·resetText) + tail.ts(64KB 꼬리) + connection.ts
  adapters/       BaseHooksAdapter(공통 뼈대) + ClaudeHooksAdapter(T04) / CodexHooksAdapter·codexMapping(T20) — hook 이벤트 → 오피스 이벤트·pending
  mcp/            TeamToolsServer — Streamable HTTP MCP `/mcp/<memberToken>`. **직급별 도구 표 `RANK_TOOLS`**(T35)가 여기 하나뿐. 두 엔진 공통
  input/          InputQueue — 타이핑 직렬화, prompt-ready 게이팅, 다이얼로그 통과(T05)
                  + 제출 확인·Enter 재전송(T42) + paste~제출 임계 구간(T44: 그 사이 사용자 키는 모았다가 재생, Ctrl+C 만 즉시)
  store/          node:sqlite 저장소 — departments/teams/members(parent_id·rank)/events(seq)/pending/tasks + engine_usage/member_usage/usage_probe(T06, 스키마 v4 = T43-4)
  cli/            콘솔 클라이언트(T08, rev 3 = T38) — RpcClient + REPL/--exec, parse.ts(순수 파싱)·format.ts(출력·tree)·help.ts(도움말 절)
  tui-maps/       CLI 버전별 화면 패턴 JSON (verified 플래그)
test/             node:test (모듈별 폴더; 통합 테스트 6건은 PIXEL_IT=1 — 위 "테스트" 절)
```

## 데이터 흐름 (한 멤버)

```
RPC member.instruct ─▶ Store.tasks ─▶ InputQueue ─(idle ∧ promptReady)─▶ pty.paste + Enter
claude.exe|codex.exe ──stdout──▶ ScreenModel(화면) ──▶ term 알림(attach 클라이언트)
claude.exe|codex.exe ──hooks(node hook.js)──▶ HookReceiver ─▶ adapterFor(member.engine) ─▶ Store.events/pending ─▶ event/member.status 알림
approval.respond / question.respond ─▶ Adapter.resolve* ─▶ 보류 중인 hook 응답(allow/deny/answers)
claude.exe ──statusLine(node statusline.js)──▶ POST /status ─▶ UsageTracker ─▶ usage.engine/usage.member 알림 + 상태 줄 한 줄
Stop/화면 idle ─▶ transcript·rollout 꼬리 64KB ─▶ UsageTracker(누적 토큰·Codex 한도)
```

멤버마다 pty·ScreenModel·InputQueue·어댑터 라우팅·MCP 엔드포인트가 따로다 — 엔진이 섞여도 서로 간섭하지 않는다(T23 `test/office/MixedTeam.test.ts`).

## 설계·결정

`../../docs/01-설계문서.md`, `../../docs/04-결정기록.md`, 태스크별 기록 `../../docs/worklog/`. 프로토콜 `PROTOCOL.md`.
