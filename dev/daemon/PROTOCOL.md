# 데몬 ↔ 클라이언트 프로토콜 (v1a 초안, T07에서 확정)

전송: WebSocket `ws://127.0.0.1:7420`. 봉투: **JSON-RPC 2.0** (요청 `{jsonrpc:"2.0", id, method, params}` / 응답 `{jsonrpc:"2.0", id, result|error}` / 알림 `{jsonrpc:"2.0", method, params}`).
인증: 데몬 기동 시 `%LOCALAPPDATA%\pixel-office\daemon.json`(= `${PIXEL_DATA_DIR}/daemon.json`)에 `{ "wsPort", "hookPort", "mcpPort", "token", "pid", "startedAt", "version" }`를 쓴다(포트는 실제 바인딩된 값; `mcpPort` 는 TeamTools MCP(T17, 아래) 포트; token 은 기동마다 새로 만든 32바이트 hex; 정상 종료 시 파일 삭제). 클라이언트는 첫 요청 `hello`에 token을 넣는다. 불일치면 에러 응답(-32001) 후 소켓 종료(close code 4001). `hello` 전에 다른 메서드를 부르면 같은 처리. 인증 후의 오류 응답은 소켓을 끊지 않는다.

`params` 는 항상 객체(없으면 `{}`). 클라이언트→데몬 알림(id 없는 요청)은 정의된 것이 없으며 무시된다. 결과가 따로 없는 메서드는 `{}` 를 돌려준다.

## 클라이언트 → 데몬 (요청)

| method | params | result |
|---|---|---|
| `hello` | `{ token, since?: number, client: { name, version } }` | `{ daemon: { version, pid }, snapshot }` 후 `seq > since` 인 `event` 알림 replay(응답이 먼저, replay 는 오름차순). `since` 없으면 스냅샷만. |
| `events.query` | `{ teamId?, memberId?, beforeSeq?, limit? }` | `{ events: OfficeEvent[] }` (seq 내림차순 아님 — 오름차순 반환. `beforeSeq` 미만 중 최신 `limit`(기본 200)건; 다음 페이지는 첫 건 seq 를 `beforeSeq` 로) |
| `team.create` | `{ name, cwd, leaderEngine: 'claude'\|'codex', maxMembers?, allowedEngines? }` | `{ team, leader: Member }` — M4 전(v1a)에는 팀장 자동 출근 없이 `team`만. `cwd` 가 폴더가 아니면 -32602. |
| `team.delete` | `{ teamId }` | `{}` — 멤버 전부 clockOut 후 삭제 |
| `member.clockIn` | `{ teamId, engine, name, instructions? }` | `{ member }` — CLI 스폰(문으로 입장). 팀 정원(`maxMembers`) 초과 -32003, 팀에서 허용 안 된 엔진 -32602. v1a: `rank:'member'`, `hiredBy:'user'`. |
| `member.clockOut` | `{ memberId }` | `{}` — 진행 task aborted 후처리, 프로세스 종료(Claude `/exit`). 행은 `status:'exited'` 로 남는다(rehire 가능). 이미 exited/error 면 -32003. |
| `member.rehire` | `{ memberId }` | `{ member }` — exited/error 멤버를 같은 설정으로 재스폰(`--resume` 시도). 아직 살아 있으면 -32003(→ `member.restart`). |
| `member.restart` | `{ memberId }` | `{ member }` — 지시문 즉시 반영용 재스폰(`--resume`) 후 큐에 `[RESUMED] …` 시스템 메시지. 종료된 멤버에도 허용. |
| `member.instruct` | `{ memberId, text }` | `{ taskId }` — `tasks(from:'user', status:'queued')` 생성 후 입력 큐에 `[TASK#n from user]\n<text>` 타이핑. 실제로 pty 에 들어가면 `assigned`, 그 턴의 `Stop` 에서 `reported`(report_text = 마지막 assistant 메시지, v1a 보고). 종료된 멤버 -32003. |
| `member.type` | `{ memberId, data }` | `{}` — 터미널 탭 직접 타이핑 (raw bytes, 큐 우선). 빈 문자열 허용. |
| `member.attach` | `{ memberId, cols, rows }` | `{ screen: string(ANSI serialize), cols, rows }` 이후 `term` 알림 구독. attach 한 클라이언트가 "마지막 attach 클라이언트"가 되어 그 크기로 즉시 resize. cols 20~500, rows 5~300 밖은 -32602. 이 데몬 세션에서 한 번도 스폰되지 않은 멤버(재시작 전 멤버 등)는 -32003. |
| `member.detach` | `{ memberId }` | `{}` — 연결이 끊기면 자동 detach. |
| `member.resize` | `{ memberId, cols, rows }` | `{}` — 마지막 attach 클라이언트만 유효(다른 클라이언트의 호출은 오류 없이 무시) |
| `member.interrupt` | `{ memberId }` | `{}` — Ctrl+C. 큐의 미전송 지시는 버리고 그 멤버의 미종료 task aborted·열린 pending expired. Ctrl+C 두 번이면 CLI 가 종료되므로 1.5초 안의 두 번째 호출은 -32003. `Stop` hook 이 없으므로 화면에 준비 문구가 보이면 데몬이 `idle{summary:'interrupted'}` 이벤트로 idle 처리. |
| `member.instructions.get` | `{ memberId }` | `{ markdown }` (없으면 `""`) |
| `member.instructions.set` | `{ memberId, markdown }` | `{}` — 다음 SessionStart부터 반영. 파일: `${dataDir}/teams/<teamId>/members/<memberId>/INSTRUCTIONS.md` |
| `approval.respond` | `{ pendingId, behavior: 'allow'\|'deny', updatedInput?, message?, alwaysThisSession?: boolean }` | `{}` — `message` 는 deny 시 모델에게 보여줄 사유(기본 "Denied by user"). `alwaysThisSession` 은 allow 일 때 같은 멤버·같은 도구의 다음 허가 요청을 데몬이 자동 allow(데몬 메모리, 재시작 시 초기화). 없는 pending -32002, approval 이 아니면 -32602, 이미 answered/expired -32003. |
| `question.respond` | `{ pendingId, answers: Record<string,string> }` | `{}` — `answers` 는 `{ "<question>": "<label>" }`(자유 답도 `label` 자리에). 오류 코드는 approval.respond 와 동일. **출처별 처리(T17):** TUI `AskUserQuestion`(payload 에 `tool_input` 있음)은 hook 결정으로 돌려주고, TeamTools `ask_user`(payload `source:'ask_user'`)는 pending 을 answered 로 닫은 뒤 그 멤버 입력 큐에 `[ANSWER q#<pendingId>]\n<답>` 시스템 메시지를 넣는다(아래 "TeamTools MCP"). 값이 전부 빈 문자열이면 -32602. 멤버가 실행 중이 아니면 -32003. |
| `daemon.shutdown` | `{}` | `{}` — 응답 후 `daemon.notice{level:'info'}` 를 보내고 전원 정중히 종료(`/exit`) → 모든 소켓 close code 1001 → 프로세스 종료. 멤버 status 는 바꾸지 않는다(T09 재시작 복구용). |

에러 코드: `-32001` 인증 실패, `-32002` 없는 멤버/팀/pending, `-32003` 상태 오류(예: 이미 종료), `-32004` 직급 규칙 위반(M4), `-32602` 파라미터. 그 외 JSON-RPC 표준: `-32700` JSON 파싱 실패(id null), `-32600` 봉투 오류(`jsonrpc:"2.0"`·`method` 누락), `-32601` 없는 메서드, `-32000` 내부 오류. 에러 객체는 `{ code, message, data? }`.

## 데몬 → 클라이언트 (알림)

| method | params |
|---|---|
| `event` | `OfficeEvent` — `{ seq, ts, teamId, memberId, kind, detail, ref }` (영속, 전역 단조 seq) |
| `snapshot` | `{ seq, teams, members, pending, tasks }` — `hello` 응답에 포함되지만 데몬이 필요 시 재전송 가능. `pending` 은 `status:'open'` 만, `tasks` 는 `queued|assigned` 만. |
| `term` | `{ memberId, data }` — attach한 클라이언트에만, 비영속 |
| `member.status` | `{ memberId, status, derived, member? }` — `status` 는 `starting|idle|working|waiting_approval|waiting_answer|exited|error`, `derived` 는 파생 상태(v1a: idle 인데 열린 질문 pending 이 있으면 `waiting_answer`(T17 — `ask_user` 는 턴이 끝난 뒤에도 질문이 열려 있다), idle 이고 배정 task 없으면 `free`, 그 외는 status 와 같음; `waiting_reports` 는 M4). `member` 는 그 시점의 Member 행(새 멤버 출근을 다른 클라이언트가 알 수 있게; 행이 삭제됐으면 생략). status 값이 실제로 바뀔 때만 온다 — 예외: `ask_user` 질문에 답하면 status 가 그대로여도 `derived` 갱신을 위해 한 번 더 온다. |
| `daemon.notice` | `{ level: 'info'\|'warn'\|'error', message }` — 예: hook 보류 타임아웃, 알 수 없는 멤버 토큰, 첫 실행 다이얼로그 자동 통과, 자동 allow, 데몬 종료 |

## 오피스 이벤트

`kind`: `thinking | text | reading | editing | running | waiting_approval | asking | delegating | reporting | idle | error`
`detail`: `{ tool?, path?, cmd?, summary?, text? }` — `text`는 턴 단위 코얼레스(Stop의 last_assistant_message)
`ref`: `{ approvalId?, questionId?, taskId? }`

v1a 에서 데몬이 만드는 이벤트(어댑터 표는 worklog T04 참고):
- `asking{tool:'ask_user', summary:<question>, options?:string[]}` ref `{questionId}` — TeamTools `ask_user` 호출(T17). TUI `AskUserQuestion` 의 `asking{tool:'AskUserQuestion'}` 과 `detail.tool` 로 구분. 답이 들어가면 `thinking{text:'[ANSWER q#<id>]\n…'}` 로 보인다.
- `reporting{summary}` ref `{taskId}` — `Stop` 시점에 그 멤버의 `assigned` task 를 `reported` 로 닫으면서(report_text = 직전 `text`), 내 책상 "보고".
- `idle{summary:'interrupted'}` — `member.interrupt` 후 화면 준비 문구로 idle 판정.
- `idle{summary:'clocked out'}` — `member.clockOut`.
- `error{summary:'process exited (code N)', exitCode}` — 데몬이 의도하지 않은 프로세스 종료(사용자 `/exit`·크래시). clockOut/restart/shutdown 에는 없음.
- 재시작 복구(T09, 아래 "재시작 복구")가 만드는 이벤트:
  - `error{summary:'재지시 필요: 허가 요청이 재시작으로 만료됨', pendingId, pendingType:'approval'}` ref `{approvalId}` — 열려 있던 허가 요청은 hook 프로세스와 함께 죽었으므로 `expired`.
  - `error{summary:'재지시 필요: 질문이 재시작으로 만료됨', pendingId, pendingType:'question'}` ref `{questionId}` — TUI `AskUserQuestion` 질문(payload 에 `tool_input` 있음)만. M2 `ask_user` 질문은 열린 채 남는다.
  - `error{summary:'restart: no session id to resume'}` — `session_id` 가 없어 되살리지 못한 멤버(status `error`, 미종료 task aborted). `member.rehire` 로 새 세션.
  - `error{summary:'restart: spawn failed: …'}` / `error{summary:'restart: recovery failed: …'}` — 재스폰 자체가 실패(status `error`).
  - `error{summary:'resume failed; started fresh session', exitCode, sessionId}` — `--resume` 직후(10초 안) 0 이 아닌 코드로 죽음(세션 파일 없음 증상) → `session_id` 를 지우고 새 세션으로 한 번 더 스폰. task 는 그대로.
  - `text{summary:'resumed'}` — 되살린 세션의 `SessionStart(source=resume)`(어댑터, T04).

## 엔진별 동작 차이 (T20)

같은 오피스 이벤트·pending·RPC 를 쓰지만, 엔진(`member.engine`)에 따라 데몬 안에서 다르게 처리되는 것들이다. 클라이언트가 알아야 할 것만 적는다.

| | Claude Code 2.1 | Codex CLI 0.154 |
|---|---|---|
| hook 주입 | `--settings <세션 json>` | `<cwd>/.codex/hooks.json` + `--dangerously-bypass-hook-trust` (같은 cwd 의 팀원들이 공유, 멤버 식별은 `PIXEL_MEMBER`). 남이 쓴 파일이면 덮어쓰지 않고 `daemon.notice{warn}` |
| 스폰 인자 | `--permission-mode default` (+ `--mcp-config`) | `-c approval_policy="on-request" -c sandbox_mode="workspace-write"`, 재개는 `resume <id>` 서브커맨드 |
| `reading`/`editing`/`running` | `PreToolUse` 의 **도구 이름**(Read/Edit/Bash …) | 도구는 `Bash` 하나뿐 → **명령 문자열 휴리스틱**. `cat`·`rg`·`ls`·`sed -n`·`type`·`Get-Content`·`git diff\|log\|status` 등만 `reading`, `apply_patch` 는 `editing`, 나머지는 `running`. 애매하면 `running` |
| `waiting_approval` detail | `{tool, path\|cmd, summary?}` | `{tool:'Bash', cmd, summary}` — `summary` 는 Codex 가 보내는 한국어 승인 문구(`tool_input.description`) |
| 질문(`asking`) | TUI `AskUserQuestion` + TeamTools `ask_user` | **TUI 질문이 없다.** `asking` 은 TeamTools `ask_user` 뿐 → `question.respond` 는 항상 `[ANSWER q#<id>]` 주입 경로 |
| 첫 `idle` | `SessionStart` hook(기동 직후) | **`SessionStart` 가 첫 프롬프트 제출 때 온다**(실측 T20). 데몬이 화면 준비(prompt ready)를 보고 `starting → idle` 로 올린다 — 클라이언트에는 그냥 `member.status idle` 로 보인다 |
| 중단 | `Ctrl+C` → Stop hook 없음 → 화면으로 `idle{summary:'interrupted'}` | `Ctrl+C` → **`Interrupt` hook**(3초 클램프) → 같은 `idle{summary:'interrupted'}` |
| 퇴근(`member.clockOut`) | `/exit` + Enter | `Ctrl+C`(idle 이면 한 번에 exit 0). 2초 안에 안 죽으면 `Ctrl+C` 한 번 더, 그래도 안 죽으면 강제 종료 |
| 첫 실행 다이얼로그 | 온보딩 + 폴더 신뢰(↓+Enter) | 폴더 신뢰 "Do you trust the contents of this directory?" → Enter (ScreenModel 감지, InputQueue 가 통과 → `daemon.notice{info}`) |
| TeamTools MCP | `--mcp-config` 로 주입 | M3(아직 주입 안 함) — Codex 멤버는 `ask_user` 를 쓸 수 없다 |

`SessionEnd` 의 `reason` 이 `clear`/`resume` 이면 두 엔진 모두 종료로 보지 않는다(같은 프로세스에서 새 `SessionStart` 가 따라온다).

## 재시작 복구

데몬이 기동할 때(`daemon.json` 기록 직후, WS 서버가 열리기 전) 이전 기동이 DB 에 남긴 멤버를 되살린다. 클라이언트는 아무것도 요청하지 않아도 된다 — `hello` 때 스냅샷과 `since` replay 로 결과를 본다.

1. **대상:** `members.status ∈ {starting, idle, working, waiting_approval, waiting_answer}`. `exited`/`error` 는 손대지 않는다(`member.rehire` 대상).
2. **유령 정리:** 이전 데몬이 하드 킬됐으면 ConPTY 자식(`child_pid`)이 살아남는다(T09 실측 — 정상 종료 때만 같이 죽는다). 그 pid 가 살아 있고 프로세스 이름이 엔진 이름(`claude`/`codex`)을 포함하면 트리째 종료한 뒤 진행한다. 이름이 다르면(pid 재사용) 건드리지 않고 `daemon.notice{warn}` 만.
3. **pending:** 열린 `approval` 전부 → `expired` + `error{재지시 필요…, pendingId}`. 열린 `question` 중 TUI `AskUserQuestion`(payload `tool_input` 있음) → 같은 처리. 그 외 질문(M2 `ask_user`, 턴 종료 상태)은 그대로 `open` — 스냅샷 `pending` 에 남는다.
4. **재스폰:** `session_id` 가 있으면 `member.rehire` 와 같은 경로로 `--resume <session_id>`(status `starting` → SessionStart 로 `idle`). 없으면 status `error` + `error{restart: no session id to resume}`, 미종료 task aborted.
5. **[RESUMED]:** 되살린 멤버의 입력 큐에 시스템 메시지를 먼저 넣는다(idle ∧ 프롬프트 준비 시 붙여넣기 — `thinking{text:'[RESUMED] …'}` 이벤트로 보인다):
   `[RESUMED] 데몬이 재시작됐다. 진행 중이던 작업: task#<id>: <instruction 첫 80자>(, …) | 없음. 마지막 확인된 행동: <kind 요약>; …(그 멤버의 최근 이벤트 5건, 오래된 것부터; 복구가 새로 쓴 이벤트는 제외) | 없음. [만료된 허가·질문: N건(필요하면 다시 요청하라).] 현재 상태를 점검하고 이어서 진행하라.`
6. **tasks:** `assigned` 는 그대로(위 문장에 열거되어 멤버가 이어서 진행). `queued` 는 [RESUMED] 뒤에 id 순으로 다시 큐에 넣는다(`[TASK#n from user]\n<text>`, 들어가면 `assigned`).
7. **폴백:** `--resume` 한 프로세스가 10초 안에 0 이 아닌 코드로 죽으면 세션 파일이 없는 것으로 보고 `session_id` 를 지운 뒤 새 세션으로 **한 번** 더 스폰(`error{resume failed; started fresh session}` + `daemon.notice{warn}`), 같은 [RESUMED]·queued task 를 다시 큐에. 그 세션도 죽으면 일반 비정상 종료(`error{process exited}`, status `error`, task aborted).
8. **알림:** 복구가 끝나면 `daemon.notice{level:'info', message:'복구: N명 재개, M건 만료[, K명 재개 불가][, 유령 J개 정리]'}` 를 내고 같은 문구를 콘솔(`[office] 복구: …`)에 남긴다. 되살릴 것이 없으면 알림 없음. 이 알림은 WS 서버가 열리기 전에 나가므로 보통 클라이언트는 받지 못한다 — 결과는 스냅샷(`members.status`, `pending`, `tasks`)과 `error`/`text{resumed}` 이벤트로 본다.
9. 복구는 멤버 단위로 실패를 삼킨다(한 멤버가 실패해도 나머지 진행, 실패한 멤버는 status `error`). `daemon.json` 처리는 그대로(기동 시 덮어쓰고 정상 종료 시 삭제).

## TeamTools MCP (T17: `ask_user`)

데몬이 CLI 세션에 노출하는 MCP 서버. 클라이언트(앱)가 부르는 것이 아니라 **멤버의 CLI 가 도구로 부른다.**

- **엔드포인트:** `http://127.0.0.1:<mcpPort>/mcp/<memberToken>` — MCP **Streamable HTTP** 전송(`@modelcontextprotocol/sdk`, 무상태: 세션 id 없음, 요청마다 새 서버 인스턴스). `mcpPort` 는 config(`PIXEL_MCP_PORT`, 기본 7422)·`daemon.json`. 모르는 토큰·다른 경로·종료된 멤버의 토큰은 404 `{ jsonrpc, error:{code:-32001, message:'unknown member token'} }`. 토큰은 hook 과 같은 식별 용도(보안 경계 아님, 로컬 전용).
- **주입:** Claude 는 스폰 때마다 `${dataDir}/sessions/<memberId>/mcp.json` = `{ "mcpServers": { "team": { "type": "http", "url": "http://127.0.0.1:<mcpPort>/mcp/<memberToken>" } } }` 을 쓰고 `--mcp-config <그 파일>` 을 붙인다(clockIn/rehire/restart/재시작 복구 전부). 도구는 Claude 안에서 `mcp__team__ask_user` 로 보인다(첫 호출은 `PermissionRequest` → `approval` pending 을 탈 수 있다). Codex 주입은 M3.
- **도구 `ask_user({ question: string, options?: string[] })`** — 비블로킹. 데몬이:
  1. `pending(question)` 생성 — payload `{ source:'ask_user', question, options: string[] }` (**`tool_input` 없음** — D-19: 재시작 복구가 이 질문을 유효한 것으로 남긴다. TUI 질문 payload 는 `{ questions, tool_input }`).
  2. `asking{tool:'ask_user', summary:question, options?}` ref `{questionId}` 이벤트.
  3. status `waiting_answer`(도구 완료 `PostToolUse` 로 곧 `working`, 턴이 끝나면 `idle` — 이때 `derived` 는 `waiting_answer`).
  4. 도구 결과 텍스트: `질문 q#<id> 등록됨. 사용자의 답은 "[ANSWER q#<id>]" 메시지로 도착한다. 답이 필요하면 이 턴을 끝내고 기다려라.` (`<id>` = pending id, 예 `q_1a2b3c4d5e6f`).
  멤버가 실행 중이 아니거나 question 이 비면 `isError` 결과.
- **답 주입:** `question.respond{pendingId, answers}` → pending `answered`(answer = answers) → 그 멤버 입력 큐에 시스템 메시지 `[ANSWER q#<id>]\n<답>` — 답이 하나면 label 만, 여럿이면 `<question>: <label>` 줄마다. 큐 규칙은 다른 자동 타이핑과 같다(idle ∧ 프롬프트 준비 ∧ 사용자 타이핑 아님): 답이 pending 을 먼저 닫으므로 "열린 질문 없음" 게이트가 그 순간 열린다. **질문이 열린 동안 쌓인 항목(`[TASK#n]`, `[RESUMED]`)보다 답이 먼저 들어간다.** 같은 멤버에 열린 질문이 둘이면 둘 다 답해야 흐른다. 턴이 아직 진행 중(`waiting_answer`)에 답하면 status 는 `working` 으로 두고 `Stop` 뒤에 흘린다.
- **만료:** `member.interrupt`/`clockOut`/프로세스 종료는 다른 pending 과 같이 `expired`. 재시작 복구는 `ask_user` 질문을 **열린 채** 둔다(위 "재시작 복구" 3) — 되살린 세션의 `[RESUMED]` 는 답이 올 때까지 큐에 머물고, 답하면 `[ANSWER]` → `[RESUMED]` 순으로 들어간다.

## 재접속 규칙

1. 클라이언트는 마지막으로 적용한 `seq`를 기억한다.
2. `hello{since}` → 스냅샷(`snapshot.seq` 포함) → `seq > snapshot.seq`인 이벤트만 적용(replay 이중 적용 방지).
3. `term`은 replay하지 않는다. 터미널 탭은 `member.attach`로 현재 화면을 다시 받는다.
