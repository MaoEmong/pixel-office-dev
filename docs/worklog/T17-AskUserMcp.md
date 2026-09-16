# T17 — TeamTools MCP 서버(ask_user)

- 날짜: 2026-09-16
- 마일스톤: M2
- 관련 설계: 01-설계문서.md §구성 요소 1 "TeamTools MCP (HTTP streamable)" · `ask_user` · §데몬 재시작 복구 · §이벤트 매핑 `asking`
- 커밋: (미커밋 — 상위에서)

## 목표

멤버의 CLI 가 **데몬에게** 질문을 던질 수 있게 한다. 데몬이 MCP(Streamable HTTP) 서버를 열고 Claude 세션마다
`--mcp-config` 로 주입하면, 모델은 `mcp__team__ask_user({question, options?})` 를 부르고 **즉시 돌려받은 안내대로 턴을 끝낸다**.
사용자가 앱의 질문 카드(T15)에서 답하면 데몬이 그 멤버 pty 에 `[ANSWER q#<id>]\n<답>` 을 타이핑해 대화가 이어진다.
TUI `AskUserQuestion`(hook 결정으로 돌려주는 기존 경로)과 달리 **턴을 붙잡지 않으므로** 답이 늦어도 CLI 가 hook 타임아웃으로
망가지지 않고, 데몬이 재시작해도 질문이 살아남는다.

## 한 것

- `dev/daemon/src/mcp/TeamToolsServer.ts`(신규)
  - `http.createServer` 를 `config.mcpPort`(기본 7422, `PIXEL_MCP_PORT`)·127.0.0.1 에 열고 `/mcp/<memberToken>` 에서 SDK 의
    `StreamableHTTPServerTransport` 를 태운다. `listen(port) → 실제 포트`, `close()`, `dispose(memberToken)`,
    `liveConnections()`, `knownTokens()`, `port`.
  - **무상태 세션**(`sessionIdGenerator: undefined`). SDK 의 무상태 전송은 재사용을 거부하고 `McpServer` 는 전송 하나에만 붙으므로
    **요청마다 `McpServer` + 전송을 새로 만들고 응답이 닫히면(`finish`/`close`) 버린다**(도구 등록은 싼 작업). 토큰별 항목(`entries`)이
    그 멤버의 살아 있는 연결(SSE 포함)을 들고 있다가 퇴근·종료 때 `dispose(token)` 으로 끊는다. 세션 id 가 없으니 데몬이 죽었다
    살아나도 클라이언트는 그냥 다시 initialize 하면 된다.
  - 호스트 연결점 `TeamToolsHost { resolveMember(token), askUser(memberId, input) }`(테스트에서 가짜). 모르는 토큰·종료된 멤버·다른
    경로는 404 `{jsonrpc, error:{code:-32001, message:'unknown member token'}}`.
  - 도구 `ask_user({ question: string, options?: string[] })`(zod). 결과 텍스트는 `askUserResultText(id)` =
    `질문 q#<id> 등록됨. 사용자의 답은 "[ANSWER q#<id>]" 메시지로 도착한다. 답이 필요하면 이 턴을 끝내고 기다려라.`
    호스트가 throw 하면 `isError` 결과(턴을 죽이지 않는다).
- `dev/daemon/src/office/Office.ts`
  - 생성자에서 실제 `TeamToolsServer` 를 만든다(`OfficeOptions.mcp` 로 주입 가능). `start()` 가 `mcp.listen(cfg.mcpPort)` →
    `daemon.json.mcpPort` + 콘솔 `[office] mcp : http://127.0.0.1:<port>/mcp/<memberToken>`. `shutdown()` 이 닫는다.
  - `askUser(memberId, {question, options})`: 살아 있는 런타임 확인 → `pending(question)` payload
    **`{source:'ask_user', question, options}`(`tool_input` 없음 — D-19)** → `asking{tool:'ask_user', summary:question, options?}`
    ref `{questionId}` → status `waiting_answer`. 빈 question 은 -32602, 멤버 없음 -32002, 실행 중 아님 -32003.
  - `respondQuestion()` 분기: `isAskUserPayload(payload)`(= `source==='ask_user'` ∧ `tool_input` 없음)면 `answerAskUser()`,
    아니면 기존 TUI hook 결정 경로 그대로.
  - `answerAskUser()`: `buildAnswerText()`(빈 답이면 -32602 — pending 은 열린 채) → `store.answerPending` → status 는
    **그대로 두고**(턴이 이미 끝나 보통 idle) `derived` 갱신용 `member.status` 한 번 더 발행, 아직 `waiting_answer`(PostToolUse 전)면
    `working` → 큐를 비웠다가 `[ANSWER q#<id>]\n<답>`(kind `system`)를 넣고 **원래 있던 항목을 그 뒤에** 다시 넣는다.
  - `writeMcpConfig(member)`: `${dataDir}/sessions/<memberId>/mcp.json` =
    `{"mcpServers":{"team":{"type":"http","url":"http://127.0.0.1:<mcpPort>/mcp/<memberToken>"}}}` 를 **스폰 때마다** 쓰고
    `spawnMember` 가 `mcpConfigPath`(Claude 만, Codex 는 M3)로 넘긴다 → clockIn/rehire/restart/재시작 복구 전부 같은 경로.
  - `disposeMcp(memberId)`: pty exit·`disposeRuntime`(퇴근·재스폰)에서 그 토큰의 MCP 연결을 끊는다.
  - `derived()`: idle 인데 열린 question pending 이 있으면 `waiting_answer`(ask_user 는 턴이 끝나도 질문이 열려 있다).
  - export: `buildAnswerText(questionId, answers)`(답 1개면 label 만, 여럿이면 `<question>: <label>` 줄), `isAskUserPayload`.
- `dev/daemon/src/pty/args.ts` · `types.ts` · `PtyManager.ts`: `buildClaudeArgs(settings, resume?, extra?, {mcpConfigPath})` →
  `--resume` 뒤·extraArgs 앞에 `--mcp-config <path>`. `SpawnOptions.mcpConfigPath`(Claude 전용).
- `dev/daemon/src/config.ts`: `mcpPort`(`PIXEL_MCP_PORT`, 기본 7422). `src/office/types.ts`: `DaemonInfo.mcpPort`,
  `AskUserParams`, `AskUserPayload`, `TeamToolsServerLike`.
- `dev/daemon/package.json`: `@modelcontextprotocol/sdk@^1.30.0`, `zod@^4.6.5`.
- `dev/daemon/PROTOCOL.md`(추가만): `daemon.json` 에 `mcpPort`, `question.respond` 의 출처별 처리, `member.status` 의 파생
  `waiting_answer`, `asking{tool:'ask_user'}` 이벤트, 새 섹션 **"TeamTools MCP (T17: `ask_user`)"**(엔드포인트·주입·도구·답 주입·만료).
- 테스트
  - `test/mcp/TeamToolsServer.test.ts`(신규 6건): 실제 SDK `Client` + `StreamableHTTPClientTransport` 로 tools/list 스키마,
    `ask_user` → 호스트 호출·등록 텍스트, 호스트 throw → `isError`·빈 question → 스키마 오류, 모르는 토큰/경로 404,
    토큰 2개 분리·`dispose`·`close`, `tokenFromUrl`.
  - `test/office/AskUser.test.ts`(신규 10건): 가짜 pty/receiver + **진짜** TeamToolsServer(임시 포트). mcp.json 내용·스폰 인자
    (codex 는 없음), MCP 왕복 → pending/이벤트/status/파생, 404·-32003·-32602, 질문이 열린 동안 instruct 보류 → 답 → `[ANSWER]`
    먼저·`[TASK#n]` 나중, 턴 진행 중 답 → `working` → Stop 뒤 flush, 열린 질문 2개면 둘 다 답해야 흐름, TUI 질문은 기존 경로,
    **재시작 복구: ask_user pending open 유지 · `[RESUMED]` 대기 → 답 → `[ANSWER]` → `[RESUMED]`**, interrupt 만료·clockOut dispose,
    `buildAnswerText`.
  - `test/office/it-helpers.ts`(신규): 통합 테스트 공용(데몬 자식 프로세스, WS JSON-RPC 클라이언트 + `waitEvent/waitStatus/autoApprove`,
    임시 포트, dataDir 로 이 테스트의 claude.exe 만 골라 정리). `test/office/askuser.integration.test.ts`(신규, `PIXEL_IT=1`).
  - 기존: `Office.test.ts`(daemon.json 키에 `mcpPort`), `Recovery.test.ts`·`integration.test.ts`·`restart.integration.test.ts`
    (`mcpPort: 0` / `PIXEL_MCP_PORT` 임시 포트 — 기본 7422 에 진짜 데몬이 떠 있으면 `start()` 가 EADDRINUSE 로 죽는다),
    `test/pty/env.test.ts`(`--mcp-config` 인자 순서).

## 검증

```
$ cd dev/daemon && npx tsc --noEmit
(출력 없음, EXIT=0)

$ npx tsx --test test/mcp/TeamToolsServer.test.ts
▶ TeamToolsServer (T17)
  ✔ tools/list exposes ask_user with question(required)/options(optional) schema (78.6922ms)
  ✔ ask_user → host.askUser(memberId, {question, options}) and returns the registration text (non-blocking) (24.6924ms)
  ✔ host throw → isError result with the message; schema violation (empty question) → error (21.9177ms)
  ✔ unknown token → 404 (client connect fails); wrong path → 404 (5.705ms)
  ✔ two members are separated by token; dispose(token) drops that member only; close() ends everything (80.7209ms)
  ✔ tokenFromUrl (0.9922ms)
ℹ tests 6  ℹ pass 6  ℹ fail 0

$ npx tsx --test test/office/AskUser.test.ts
▶ Office ask_user (T17)
  ✔ clockIn(claude): writes sessions/<id>/mcp.json pointing at /mcp/<token> and passes mcpConfigPath; codex gets none (29.6227ms)
  ✔ MCP ask_user over HTTP → pending(question, source ask_user, no tool_input) + asking event + waiting_answer; result text (79.8737ms)
  ✔ unknown token → 404; exited member token → 404; member not running → isError (25.3467ms)
  ✔ while an ask_user question is open, instruct waits; respond → pending answered, [ANSWER q#id] pasted first, then the queued [TASK#n] (3095.8821ms)
  ✔ answer arriving mid-turn (status waiting_answer, before PostToolUse) → working; [ANSWER] flushes after Stop (1295.5493ms)
  ✔ two open questions: the first answer alone does not open the gate; both answers flush in answer order (3106.8971ms)
  ✔ TUI AskUserQuestion pending still goes through the hook decision (no [ANSWER] injection) (685.3175ms)
  ✔ restart recovery: ask_user pending stays open, [RESUMED] waits for the answer; respond → [ANSWER] then [RESUMED] (3035.6733ms)
  ✔ interrupt expires the open ask_user question; clockOut disposes the MCP entry (21.8589ms)
  ✔ buildAnswerText: single answer → label only; several → "question: label" lines (3.45ms)
ℹ tests 10  ℹ pass 10  ℹ fail 0

$ npx tsx --test test/**/*.test.ts        # 전체
ℹ tests 185  ℹ suites 32  ℹ pass 181  ℹ fail 0  ℹ skipped 4 (PIXEL_IT 미설정 통합 4건)
```

통합(실제 데몬 + 실제 Claude 2.1.270, sandbox = `dev/spike-0/sandbox`, 임시 dataDir·임시 포트 3개):

```
$ PIXEL_IT=1 npx tsx --test test/office/askuser.integration.test.ts
[d:out] [office] mcp       : http://127.0.0.1:11304/mcp/<memberToken> (TeamTools: ask_user)
[d:out] [daemon] pixel-office daemon v1.0.0 pid=29140
[d:out] [daemon] data dir : C:\Users\User\AppData\Local\Temp\pixel-office-t17-it-t2aYql
[d:out] [daemon] ws        : ws://127.0.0.1:11301
[d:out] [daemon] hook port : 11303 (D:/myproject/pixel-office/dev/daemon/src/hooks/hook.js)
[d:out] [daemon] listening
[IT:c] status starting (starting)
[IT] clockIn member=m_d82c4ed80747 pid=25096 (707ms)
[IT] mcp.json: {"mcpServers":{"team":{"type":"http","url":"http://127.0.0.1:11304/mcp/a9f0bcdff4c4854ec6e8e84ba9fcfe6fd0138648e0bd94a2"}}}
[IT:c] status idle (free)
[IT] idle (SessionStart) 2027ms
[IT] instruct task#1 (2029ms)
[IT:c] status working (working)
[IT:c] event #1 thinking {"text":"[TASK#1 from user]\nteam MCP 서버의 ask_user 도구로 나에게 '좋아하는 색은?' 하고 물어봐 (옵션: 빨강, 파랑). 답이 오면 그 색을 한 줄로 말해줘."}
[IT:c] event #2 running {"tool":"ToolSearch"}
[IT:c] event #3 running {"tool":"mcp__team__ask_user"}
[IT:c] event #4 waiting_approval {"tool":"mcp__team__ask_user"}
[IT:c] auto-approve a_fbcaddcc3ed2 (mcp__team__ask_user)
[IT:c] status waiting_approval (waiting_approval)
[IT:c] status working (working)
[IT:c] event #5 asking {"tool":"ask_user","summary":"좋아하는 색은?","options":["빨강","파랑"]} q=q_4e3ee0bdf518
[IT] asking #5 q=q_4e3ee0bdf518 summary="좋아하는 색은?" options=["빨강","파랑"] (7230ms)
[IT:c] status waiting_answer (waiting_answer)
[IT] pending q_4e3ee0bdf518: {"source":"ask_user","question":"좋아하는 색은?","options":["빨강","파랑"]}
[IT:c] status working (working)
[IT:c] event #6 text {"text":"질문을 등록했어요 (q#q_4e3ee0bdf518): **좋아하는 색은?** — 빨강 / 파랑. 답이 오면 그 색을 한 줄로 말씀드릴게요."}
[IT:c] event #7 idle {}
[IT:c] event #8 reporting {"summary":"질문을 등록했어요 (q#q_4e3ee0bdf518): …"}
[IT:c] status idle (waiting_answer)
[IT] turn ended after asking: idle #7, status=idle derived=waiting_answer (9911ms)
[IT:c] status idle (free)
[IT] question.respond → 파랑 (9913ms)
[IT:c] status working (working)
[IT:c] event #9 thinking {"text":"[ANSWER q#q_4e3ee0bdf518]\n파랑"}
[IT] [ANSWER] typed #9 (11393ms): "[ANSWER q#q_4e3ee0bdf518]\n파랑"
[IT:c] event #10 text {"text":"좋아하는 색은 파랑이네요."}
[IT:c] event #11 idle {}
[IT] reply to [ANSWER] (13046ms): ["좋아하는 색은 파랑이네요."]
[IT] final status=idle derived=free
[IT:c] event #12 idle {"summary":"session ended: prompt_input_exit"}
[IT:c] status exited (exited)
[IT] clockOut done (16308ms); claude alive=false
[d:out] [daemon] bye
[IT] daemon exited=true code=0 (16331ms)
[IT] leftover check: 25096=dead
✔ real daemon + real Claude: ask_user via --mcp-config → question.respond → [ANSWER] → model says the color (17897.7807ms)
ℹ tests 1  ℹ pass 1  ℹ fail 0
```

즉 **Claude 2.1.270 + `--mcp-config` + Streamable HTTP 는 그대로 동작한다**: 세션에만 붙고(전역 설정 오염 없음), 도구 이름은
`mcp__team__ask_user`, 첫 호출은 `PermissionRequest` → 우리 approval pending 을 탄다(테스트는 자동 allow), 결과 텍스트대로
모델이 턴을 끝내고, 답 주입 뒤 같은 세션이 이어서 답한다(질문 → 답까지 약 13초).

## 발견한 함정

1. **무상태 Streamable HTTP 전송은 재사용 불가.** `sessionIdGenerator: undefined` 인 `StreamableHTTPServerTransport` 에 두 번째
   요청을 넣으면 SDK 가 거부하고, `McpServer` 는 전송 하나에만 붙는다 → 멤버당 서버를 하나 만들어 두는 대신 **요청마다** 서버+전송을
   만들고 응답이 닫히면 버린다. 멤버 단위로 관리해야 하는 것(퇴근 시 SSE 끊기)은 토큰별 `entries` 로 따로 들고 있다.
2. **Claude 는 MCP 도구를 지연 로딩한다.** 통합 로그의 `running{tool:'ToolSearch'}`(event #2) — 2.1.270 은 MCP 도구를 바로 노출하지
   않고 ToolSearch 로 찾아 쓴다. 그래서 지시문에 "team MCP 서버의 ask_user 도구로" 처럼 서버·도구 이름을 적어 주는 편이 확실하다.
3. **MCP 도구 첫 호출은 허가 요청을 탄다**(`--permission-mode default` 이므로). 앱에서는 질문 카드 전에 허가 카드가 한 번 뜬다.
   자동 allow 나 `alwaysThisSession` 으로 넘기면 된다.
4. **통합 테스트 러너가 안 끝나던 문제.** `it-helpers.Client.autoApprove` 가 1시간짜리 `setTimeout` 으로 대기하고 있어 테스트가
   통과해도 프로세스가 살아 있었다. `waitFor`/`waitLine` 의 타임아웃 타이머를 `unref()` 해서 해결(대기 중에는 WS 소켓·자식 stdio 가
   루프를 살려 두므로 진짜 타임아웃은 그대로 뜬다).
5. **기존 통합 테스트도 MCP 포트를 임시 포트로 받아야 한다.** 안 그러면 기본 7422 에 실제 데몬이 떠 있을 때
   `office.start()` 가 EADDRINUSE 로 죽는다(`test/office/integration.test.ts`, `restart.integration.test.ts` 에 `PIXEL_MCP_PORT` 추가).

## 결정

- D-19(기존): 질문 pending 의 TUI/ask_user 구분은 `payload.tool_input` 유무 — 이번 구현이 그 규칙을 그대로 따른다
  (`ask_user` payload 에 `tool_input` 을 **넣지 않는다**, 추가로 `source:'ask_user'` 표식).
- 새 결정은 없다. 아래 두 가지는 이 worklog 에만 남긴다(설계 범위 안의 구현 선택):
  - 무상태 MCP 세션(요청마다 서버+전송) — 함정 1.
  - 답 대기 게이트는 **별도 플래그 없이** "열린 pending 이 있으면 flush 안 함"(T05 `isIdle`)을 그대로 쓴다. 답이 pending 을 먼저
    닫으므로 게이트가 그 순간 열리고, 답 항목을 큐 **맨 앞**에 넣어(기존 항목을 뺐다가 뒤에 다시 넣는다) `[ANSWER]` 가 먼저 들어간다.
    열린 질문이 둘이면 둘 다 답해야 흐른다.

## 남은 것

- 나머지 TeamTools 도구(`hire`/`dismiss`/`delegate`/`report`)와 직급별 노출 — M4.
- Codex 주입(`-c mcp_servers.team.url=...`) — M3(T20). 지금은 `mcpConfigPath` 를 Claude 에만 넘긴다.
- 앱(Flutter) 쪽 질문 카드는 T15 것을 그대로 쓴다(payload `{question, options, source}` 도 기존 카드가 처리) — v1a 시연(T19)에서 확인.
- `member.status` 의 파생 `waiting_answer` 를 앱이 어떻게 그릴지(말풍선·내 책상 이동)는 T16 로직을 따르되 T19 에서 눈으로 확인.
