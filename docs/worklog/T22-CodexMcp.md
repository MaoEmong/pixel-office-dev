# T22 — Codex MCP 주입 · 폴백(질문/보고)

- 날짜: 2026-09-16
- 마일스톤: M3
- 관련 설계: 01-설계문서.md §구성 요소 1(TeamTools MCP, CodexHooks 어댑터) · §2 이벤트 매핑 표의 Codex 열("delegating/reporting … + 폴백: 턴 종료 메시지 승격") · 02 §④ "Codex `-c mcp_servers.team.url=…` 주입 — M3" · 04 D-19(질문 pending 구분), D-22(`mcp__team__*` 자동 allow), D-23(사용량 한도), D-24(`config.codexExe` 자동 탐지는 T22)
- 커밋: (미커밋 — 상위 태스크에서 묶어 커밋)

## 목표

Codex 팀원도 Claude 팀원과 **같은 TeamTools MCP** 를 쓰게 한다(`ask_user`). 그리고 Codex 모델이 도구를 안 부르고 말로만 턴을
끝내는 경우에도 사무실이 멈추지 않도록, 턴 종료 메시지를 **질문 pending** 또는 **task 보고**로 승격하는 폴백을 넣는다.
덤으로 T20 함정 4(`config.codexExe` 기본값 `'codex'` 가 node-pty 로 안 뜬다)를 자동 탐지로 없앤다.

## 한 것

### 1. Codex MCP 주입 (`-c mcp_servers.team.url=…`)

- `dev/daemon/src/pty/args.ts` — `buildCodexArgs(resume?, extra?, { mcpUrl })` 가 `-c mcp_servers.team.url="<url>"` 을 붙인다
  (`CODEX_MCP_SERVER_NAME='team'`, `CODEX_MCP_URL_KEY(name)`). 값은 TOML 로 파싱되므로 URL 을 큰따옴표로 감싼다.
- `dev/daemon/src/pty/types.ts` — `SpawnOptions.mcpUrl`(Codex 전용. Claude 는 기존 `mcpConfigPath`).
- `dev/daemon/src/pty/PtyManager.ts` — `prepareSpawnCommand` 가 codex 분기에서 `mcpUrl` 을 넘긴다.
- `dev/daemon/src/office/Office.ts` — `mcpUrl(member)` 를 새로 두고(`http://127.0.0.1:<mcpPort>/mcp/<memberToken>`)
  `writeMcpConfig`(Claude)와 codex 스폰 인자가 **같은 함수**를 쓴다. 스폰 때마다 다시 계산되므로 clockIn/rehire/restart/
  재시작 복구 전부 같은 경로다. `~/.codex/config.toml` 은 건드리지 않는다(그 실행에만 적용).
- 키 이름 확인(실측, 아래 검증 참고): `codex mcp add team --url <url>` 이 config.toml 에 쓰는 모양이 `[mcp_servers.team] url = "…"`
  이고, `-c mcp_servers.team.url="…"` 오버라이드도 `codex mcp list` 에 그대로 뜬다. **stdio 셰임은 필요 없었다**(과제의 대안
  `src/mcp/stdio-shim.js` 는 만들지 않았다 — streamable HTTP 가 그대로 붙는다).

### 2. `config.codexExe` 자동 탐지

- `dev/daemon/src/config.ts` — `resolveCodexExe(env?, platform?)` 신설, `config.codexExe` 의 기본값이 됐다. 순서:
  1. `PIXEL_CODEX_EXE`(있으면 그대로 — 존재 검사 안 함),
  2. npm 전역(`%APPDATA%\npm`, `%LOCALAPPDATA%\npm`, `%ProgramFiles%\nodejs`)의
     `node_modules/@openai/codex/node_modules/@openai/codex-*/vendor/*/bin/codex.exe` **스캔**(플랫폼 패키지·타깃 폴더 이름이
     버전마다 달라서 하드코딩하지 않는다),
  3. PATH 의 **진짜** `codex.exe`(`.cmd`/`.ps1` 셰임은 node-pty 가 못 띄우므로 세지 않는다 — T20 함정 4),
  4. 그래도 없으면 `'codex'`(스폰이 실패하며 오류로 드러난다).
- 문서: `PIXEL_CODEX_EXE` 는 config.ts 주석 + 이 문서 + PROTOCOL 표에. `test/office/codex.integration.test.ts` 의 자체 탐지
  함수도 `resolveCodexExe()` 로 교체했다.

### 3. 폴백 (Codex 전용, Claude 동작은 그대로)

- `dev/daemon/src/office/codexFallback.ts`(신규, 순수 함수) — `lastLine` / `looksLikeQuestion` / `detectQuestion` /
  `isFallbackQuestion` / `CODEX_FALLBACK='codex-stop'` / `FallbackQuestionPayload`.
  질문 판정 = 마지막 비어 있지 않은 줄(목록 기호·강조 제거)이 `?`/`？` 로 끝나거나 `알려 주세요|알려 줘|확인해 주세요|확인 부탁|
  어떻게 할까요|어느 쪽|선택해 주세요|골라 주세요|진행할까요|맞나요|which|should I` 에 걸릴 때. 질문 본문은 그 줄(최대 300자).
- `dev/daemon/src/office/Office.ts`
  - **보고 폴백은 이미 있었다.** `afterOfficeEvent` 의 "idle(요약 없음) → assigned task 를 reported(report_text = 직전 text)"
    가 엔진 공통이라 Codex 도 그대로 탄다(T18 v1a 보고). 확인하고 Codex 단위 테스트로 고정했다.
  - **질문 폴백 추가** — `codexQuestionFallback(member, lastText)`: Codex 멤버의 턴 종료에서 질문이 감지되면
    pending(question, payload `{source:'ask_user', question, options:[], fallback:'codex-stop'}`) + `asking{tool:'ask_user',
    summary, fallback}` + `emitStatus`(실제 status 는 `idle` 그대로, **파생만 `waiting_answer`**). 이미 열린 질문이 있으면 안 만든다.
    **질문이 보고보다 먼저** — 질문으로 끝난 턴은 보고로 치지 않고 task 를 `assigned` 로 남긴다.
  - `answerAskUser` 가 폴백 pending 이면 `[ANSWER q#<id>]` 봉투 없이 **답 본문만** 큐에 넣는다(기다리는 MCP 호출이 없다).
    `buildAnswerText` 를 `answerBody(answers)` + 봉투로 쪼갰다(`buildAnswerText` 의 동작·서명은 그대로).

### 4. 정리(dispose)·자동 allow

- `Office.finishMember` 에서도 `disposeMcp(memberId)` 를 부른다. 퇴근 경로는 두 갈래인데(살아 있는 세션 → pty exit →
  `onPtyExit`→`disposeMcp`, 프로세스 없이 status 만 살아 있던 행 → `finishMember`) 뒤쪽이 비어 있었다. 엔진 공통.
- `BaseHooksAdapter.isTeamTool(toolName)` 훅 포인트 신설(기본 `mcp__team__` 접두사, D-22). `CodexHooksAdapter` 가 override —
  이름에 `team` **과** 도구 이름(`ask_user`)이 **둘 다** 있으면 우리 도구로 보고 즉시 allow. Codex 가 MCP 도구의 `tool_name` 을
  어떤 모양으로 보내는지는 모델 턴이 필요해 아직 미확인이라, 코드에 `TODO(2026-09-21 이후)` 를 달았다
  (`src/adapters/CodexHooksAdapter.ts` 의 `TEAM_TOOL_NAMES`).

### 5. 문서·테스트

- `dev/daemon/PROTOCOL.md` — "엔진별 동작 차이" 표의 `TeamTools MCP`·`질문` 칸 갱신 + `보고(reporting)` 행 추가,
  "TeamTools MCP" 절의 주입 문단에 Codex 경로 추가, `question.respond` 행에 폴백 한 줄, **새 절 "Codex 폴백 (T22)"**.
- 테스트(+21건, 전부 신규 또는 보강)
  - `test/office/CodexFallback.test.ts`(신규 12) — 순수 함수 4 + Office 8(보고 폴백, 질문 폴백 pending/이벤트/파생/task 유지,
    중복 방지 2종(열린 질문 / 답한 뒤 마지막 메시지 없는 턴), 폴백 답=봉투 없음, 진짜 `ask_user` 답=`[ANSWER q#…]` 유지,
    Claude 무변화, 죽은 세션 무시).
  - `test/config/codexExe.test.ts`(신규 5) — 가짜 vendor 트리로 우선순위·셰임 무시·이 기계의 실제 설치.
  - `test/pty/spawnCommand.test.ts`(+1) — codex 인자에 `-c mcp_servers.team.url="…"`(resume 조합 포함).
  - `test/office/CodexRouting.test.ts`(+1, 1 수정) — 스폰 옵션 `mcpUrl`(Claude 는 `mcpConfigPath`), rehire 재주입,
    퇴근·프로세스 종료의 `mcp.dispose(memberToken)`.
  - `test/adapters/CodexHooksAdapter.test.ts`(+2) — `team.ask_user`/`team/ask_user`/`team__ask_user`/`mcp__team__ask_user` 자동 allow,
    남의 MCP 도구(`other.ask_user`, `team.delete_repo`, `ask_user`, `teamcity.build`)는 계속 사용자 결정 대기.
  - `test/office/tools/t22-live.ts`(신규, 러너 대상 아님) — 실기동 진단 스크립트(아래 검증).

## 검증

```
$ cd dev/daemon && npx tsc --noEmit
(출력 없음, EXIT=0)

$ npx tsx --test "test/**/*.test.ts"
ℹ tests 318
ℹ suites 49
ℹ pass 313
ℹ fail 0
ℹ skipped 5        (= opt-in 통합 테스트 5개)
ℹ duration_ms 12720.5906
```

### Codex MCP 설정 키 확인 (`codex mcp`)

```
$ codex.exe mcp add --help
Usage: codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)
      --url <URL>   URL for a streamable HTTP MCP server

$ CODEX_HOME=<임시> codex.exe mcp add team --url "http://127.0.0.1:7422/mcp/abc123"
Added global MCP server 'team'.
$ cat <임시>/config.toml
[mcp_servers.team]
url = "http://127.0.0.1:7422/mcp/abc123"

$ CODEX_HOME=<빈 임시> codex.exe mcp list -c 'mcp_servers.team.url="http://127.0.0.1:7422/mcp/tok"'
Name  Url                            Bearer Token Env Var  Status   Auth
team  http://127.0.0.1:7422/mcp/tok  -                      enabled  Unsupported
```

→ 우리가 붙이는 `-c mcp_servers.team.url="…"` 이 `[mcp_servers.team] url` 과 같은 키다. **stdio 셰임 불필요.**

### 실기동: `/mcp` 캡처 (실제 데몬 + 실제 Codex, 모델 턴 없음)

```
$ npx tsx test/office/tools/t22-live.ts
[T22] codex exe (resolveCodexExe): C:\Users\User\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe
[T22] cwd: D:\myproject\pixel-office\dev\spike-0\sandbox
[d:out] [office] mcp       : http://127.0.0.1:3319/mcp/<memberToken> (TeamTools: ask_user)
[d:out] [daemon] pixel-office daemon v1.0.0 pid=29260
[d:out] [daemon] data dir : C:\Users\User\AppData\Local\Temp\pixel-office-t22-live-sDOBO8
[d:out] [daemon] ws        : ws://127.0.0.1:3317
[d:out] [daemon] hook port : 3318 (D:/myproject/pixel-office/dev/daemon/src/hooks/hook.js)
[d:out] [daemon] listening
[IT:c] status starting (starting)
[T22] clockIn m_855ed33726e8 pid=17272 token=909b9c24e4ded7fbbf44b35de266652078a9445db16fbe0d
[T22] expected MCP url: http://127.0.0.1:3319/mcp/909b9c24e4ded7fbbf44b35de266652078a9445db16fbe0d
[IT:c] status idle (free)
[T22] boot idle
```

`/mcp` 실행 화면(데몬의 ScreenModel 로 재구성한 평문):

```
/mcp

🔌  MCP Tools

  • azide1337-antigravity-unity-mcp-server: failed (0 tools)
  • bbanana: connected (40 tools)
  • codex_apps: connected (211 tools)
  • cua_repl: connected (2 tools)
  • node_repl: connected (4 tools)
  • team: connected (1 tool)

  Use /mcp verbose for tools and resources.
```

`/mcp verbose` 의 team 항목:

```
  • team: connected (1 tool)
    • Auth: Unsupported
    • Tools: ask_user
    • Resources: (none)
    • Resource templates: (none)
```

`/status`(같은 실행):

```
│  Model:                       gpt-6-astra (reasoning high, summaries auto)              │
│  Directory:                   D:\myproject\pixel-office\dev\spike-0\sandbox             │
│  Permissions:                 Workspace (Ask for approval)                              │
│  Session:                     01a0a8af-24b8-7920-8953-e5e50accc9ed                      │
│  Weekly limit:                [░░░░░░░░░░░░░░░░░░░░] 0% left (resets 13:58 on 21 Sep)   │
```

```
[IT:c] event #1 idle {"summary":"session ended: other"}
[IT:c] status exited (exited)
[T22] clockOut done; codex alive=false
[d:out] [daemon] bye
[T22] daemon exited=true code=0
```

여기까지 **실기동으로 확인된 것**: `PIXEL_CODEX_EXE` 없이 자동 탐지된 `codex.exe` 로 스폰됨 · 우리 `-c mcp_servers.team.url`
주입이 Codex 에 먹혀 **`team` 서버가 connected, 도구 `ask_user` 하나**로 보임 · 전역 `~/.codex/config.toml` 은 안 건드림
(다른 서버 목록은 사용자의 기존 설정, `azide1337-…: failed` 는 우리와 무관 — T20 함정 7) · 퇴근(Ctrl+C)으로 프로세스 종료.
`/status` 는 주간 한도 0%(21일 13:58 리셋)를 그대로 보여 준다 — 모델 턴이 왜 안 도는지의 증거.

## 발견한 함정

1. **`-c` 값은 TOML 로 파싱된다.** URL 을 따옴표 없이 주면 TOML 파싱이 실패해 "raw string" 으로 떨어지는데(도움말에 그렇게
   적혀 있다) 우리는 확실하게 `mcp_servers.team.url="http://…"` 로 감싼다. `codex mcp list -c …` 로 먼저 눈으로 확인했다.
2. **`/mcp` 는 슬래시 팝업을 띄운다.** `member.type` 으로 `/mcp` 를 친 뒤 바로 Enter 를 보내면 팝업의 선택 항목이 실행된다
   (우리 경우 `/mcp` 자체). 캡처 스크립트는 타이핑과 Enter 사이에 1.2초를 둔다.
3. **Codex 는 MCP 도구를 `/mcp verbose` 에서만 이름까지 보여 준다.** `/mcp` 는 개수만("1 tool").
4. **질문 폴백은 `status` 를 건드리면 안 된다.** `waiting_answer` 로 올리면 InputQueue 의 `isIdle` 게이트(= status idle ∧ 열린
   pending 없음)가 두 겹으로 막혀, 답한 뒤에도 큐가 흐르지 않는다. 열린 pending 만으로 이미 게이트는 닫히므로 status 는 `idle`
   그대로 두고 `derived` 만 `waiting_answer` 로 알린다(캐릭터 이동·카드는 derived 를 본다).
5. **폴백 질문에 `[ANSWER q#…]` 봉투를 씌우면 안 된다.** 그 봉투는 `ask_user` 도구 결과가 "답은 이 모양으로 온다"고 모델에게
   약속했기 때문에 쓰는 것이다. 폴백은 그런 약속이 없으므로 봉투가 있으면 모델이 무슨 말인지 모른다 → 답 본문만 넣는다.
6. **`which`/`should I` 휴리스틱은 오탐 가능.** 영어 평서문에 `which` 가 들어가면 질문으로 잡힐 수 있다(마지막 줄만 보므로
   빈도는 낮다). 오탐의 대가는 "안 해도 될 질문 카드가 하나 뜬다" 정도라 일단 설계 문구대로 두고, 실사용 로그를 보고 좁힌다.

## 결정

- 새 결정 없음(D-19·D-22 를 그대로 확장). 04-결정기록에 올릴 후보 둘:
  - 폴백 질문도 payload `source:'ask_user'` 를 유지하고 `fallback:'codex-stop'` 표식만 더한다 → 재시작 복구(D-19)·앱 카드·
    내 책상 큐가 코드 변경 없이 그대로 동작. 다른 점은 **답 주입 모양**뿐.
  - 질문이 보고보다 우선한다(질문으로 끝난 턴의 task 는 `assigned` 유지).

## 남은 것 / 9/21 이후 확인 목록

> **2026-09-21 해소 — `T42-CodexLive.md`.** 1~5 전부 실기로 확인했다. 특히 2번의 답: Codex 도 MCP 도구를
> **`mcp__team__*`** 로 보내고 **MCP 도구에는 `PermissionRequest` 를 아예 띄우지 않는다** → D-22 는 Codex 에서 무동작이고,
> `TEAM_TOOL_NAMES` 휴리스틱은 지웠다. 3번(질문 폴백)은 `QUESTION_PATTERNS` 조정 없이 그대로 통과했다.

ChatGPT 계정 사용량 한도(**2026-09-21 13:58** 리셋, D-23)라 **모델 턴이 필요한 것**은 전부 이월한다. 리셋 후 아래를 순서대로:

1. **Codex 가 `ask_user` 를 실제로 부르는지** — `PIXEL_IT=1` 로 `test/office/codex.integration.test.ts` 를 돌린 뒤, 같은 방식으로
   "team MCP 의 ask_user 로 나에게 물어봐" 지시 → `asking{tool:'ask_user'}` → `question.respond` → `[ANSWER q#…]` 왕복 확인
   (T17 의 Claude 통합 테스트와 같은 시나리오의 Codex 판을 추가할 것).
2. **MCP 도구의 `tool_name` 실물** — `PermissionRequest` 가 뜨는지, 뜬다면 이름이 `team.ask_user` 인지 다른 모양인지.
   확인 후 `CodexHooksAdapter.isTeamTool` 휴리스틱을 정확한 이름으로 좁히고 `TEAM_TOOL_NAMES` 의 TODO 를 지운다.
   (Codex 는 MCP 도구에 승인 프롬프트를 안 띄울 가능성도 있다 — 그러면 D-22 는 Codex 에서 무의미해진다.)
3. **질문 폴백 실전 검증** — 모델이 질문으로 턴을 끝내게 유도해 `asking` → 답(봉투 없는 보통 프롬프트) → 모델이 이어서 답하는지.
   판정 표현 목록(`QUESTION_PATTERNS`)의 오탐·누락도 이때 조정.
4. **보고 폴백 실전 검증** — 지시 → 작업 → `Stop` → task `reported`(report_text) 확인(T20 통합 테스트의 뒷부분과 같이).
5. **Codex `Interrupt` hook 실물 페이로드**(T20 에서 이월) — 턴이 돌아야 Ctrl+C 로 발화시킬 수 있다.
6. 그 외 이 태스크 범위 밖: 나머지 TeamTools 도구(`hire`/`dismiss`/`delegate`/`report`)와 직급별 노출 — M4.
