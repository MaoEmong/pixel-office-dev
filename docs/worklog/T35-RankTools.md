# T35 — TeamTools 직급별 도구 (직무 체계 rev 3)

- 날짜: 2026-09-16
- 마일스톤: M4b
- 관련 설계: 01-설계문서.md §"직무 체계 rev 3 (2026-09-16, D-32)" · 04-결정기록.md D-32 / D-33 / D-34 / **D-37**
- 커밋: `<hash>` (완료 시)

## 목표

T34가 만든 3단 트리(부서 → 부장 → 팀장 → 팀원)에 **직급별 도구**를 채운다. 이 태스크가 끝나면 부장은 `create_team` 으로
팀을 만들고 팀장에게만 `delegate` 하며, 팀장은 `hire` 로 팀원을 만들고, 보고는 팀원 → 팀장 → 부장 → 내 책상으로 한 칸씩
올라가고, 질문은 `ask_parent` 로 한 칸씩 올라가 `reply` 로 내려온다. 사용자를 부르는 길(`ask_user`)은 부장에게만 남는다.
덤으로 T29 결함 ②(열린 질문으로 끝낸 턴이 사용자 task 를 닫아 버려 진짜 보고가 거절되던 것)를 고친다.

## 한 것

### 1. 직급별 도구 목록의 단일 출처 (`src/mcp/TeamToolsServer.ts`)

`RANK_TOOLS` 표 하나가 **MCP 서버의 등록 목록 · Office 의 게이트 · 지시문 템플릿의 "도구 이름" 줄 · PROTOCOL 표**를
모두 먹인다 — 갈라질 수가 없다.

| 직급 | 도구 |
|---|---|
| 부장(head) | `create_team` · `dismiss_team` · `delegate` · `reply` · `report`(→사용자) · `ask_user` |
| 팀장(lead) | `hire` · `dismiss` · `delegate` · `reply` · `report`(→부장) · `ask_parent` |
| 팀원(member) | `report`(→팀장) · `ask_parent` |

- 도구 등록은 `canUseTool(member.rank, tool)` 로 가른다(첫 겹). 콜백 안에서 `resolveMember(token)` 로 **다시 읽어**
  `rankToolMessage(tool, rank)` 로 거절한다(둘째 겹). `ask_user` 만 문구가 특별하다 —
  `부장만 사용자에게 질문할 수 있습니다. ask_parent를 쓰세요.`(`ASK_USER_HEAD_ONLY_MESSAGE`).
- 새 결과 문구: `createTeamResultText`(`팀 <name> 생성, 팀장 <leadName>(<id>) 출근.`) · `dismissTeamResultText` ·
  `replyResultText` · `askParentResultText`. `reportResultText` 의 `to` 가 `'user'|'leader'` → **`'user'|'parent'`**
  (`직속 상사(으)로 올라간다`) — 팀장→부장 보고에 "팀장으로 올라간다" 고 적히던 거짓말을 지웠다.
- 옛 `LEADER_ONLY_TOOLS`/`EVERYONE_TOOLS`/`leaderOnlyToolMessage` 는 없앴다.

### 2. 규칙을 세 관문으로 (`src/office/Office.ts`)

도구 메서드마다 흩어져 있던 "같은 팀인가 / 팀장인가" 검사를 **세 개의 private 관문**으로 모았다.

| 관문 | 하는 일 |
|---|---|
| `requireToolRank(memberId, tool)` | 살아 있는 멤버 + `RANK_TOOLS[rank]` 에 그 도구가 있는가 (-32004) |
| `requireChild(parent, targetId, tool)` | `delegate`/`reply`/`dismiss` 의 대상이 **살아 있는 직속 부하**(`parent_id`)인가 |
| `requireParent(member, tool)` | `ask_parent` 의 상대 = 살아 있는 직속 상사 |

팀(`team_id`)이 아니라 **트리 간선(`parent_id`)** 이 기준이라, 부장이 손자(팀원)에게 직접 시키거나 팀장이 남의 팀
팀원에게 시키는 길이 한 곳에서 막힌다. 새 메서드:

- `teamCreateTeam(headId, {name, leadName, engine?, instructions?})` → `createTeam`(부서 = 부르는 부장의 부서).
  `CreateTeamParams.leadInstructions` 를 추가해 팀장의 `INSTRUCTIONS.md` 초안이 **스폰 전에** 저장된다.
- `teamDismissTeam(headId, teamId)` — 자기 부서, 팀장 `idle`, 팀 전체 미종료 task 0 일 때만 `deleteTeam`(잎부터).
- `teamReply(parentId, {toMember, text})` — 그 부하에게 **나를 향해 열린** `ask_parent` 가 있으면 `answerAskUser` 로
  닫고(`[ANSWER q#n]`), 없으면 `[MESSAGE from <나>]`.
- `askParent(memberId, {question, options?})` — pending(question) + `asking{tool:'ask_parent', to, toName}` +
  status `waiting_answer` + **상사 큐**에 `[QUESTION from <이름> q#<id>]`.
- `teamAskUser` = 부장 게이트 + 기존 `askUser`. `askUser` 자체(= `askUserUnchecked`)는 직급을 보지 않는다 —
  Codex 질문 폴백(T22)처럼 **데몬이 스스로 만드는 질문**이 있기 때문.

기존 메서드는 관문만 갈아 끼웠다: `teamHire`/`teamDismiss`/`teamDelegate`/`teamReport`.

### 3. 봉투·버퍼 (`Office.ts`)

- `taskMessage(task, fromName, fromRank?)` — `[TASK#n from <이름>(부장|팀장)]`. 라벨이 발행자의 rank 에서 온다
  (전에는 항상 `(팀장)` 이었다). 새 빌더 `buildQuestionText` / `buildMessageText`.
- **보고 버퍼를 부모 단위로** 일반화(문구·주석). `bufferReport` 에서 흘리는 부분을 `flushReportBuffer` 로 뽑았고,
  `blocked` 를 즉시 보낸 뒤에도 한 번 부른다 — `blocked` 가 마지막 미종료 task 였을 때 버퍼에 남은 `done` 보고가
  영영 안 가던 T25 의 구멍을 막았다.
- `deliverReports` 의 경고 문구 `보고를 전달할 팀장이 없습니다` → `… 상사가 없습니다`.

### 4. 결함 ② — 열린 질문으로 끝낸 턴은 승격하지 않는다 (`afterOfficeEvent`)

```ts
if (this.store.listOpenPending(ev.memberId).some((p) => p.type === 'question')) return;
if (this.store.openTasksIssuedBy(ev.memberId).length > 0) return;   // D-29(기존)
```

T29 시연에서 팀장이 `ask_user` 로 턴을 끝내자 v1a 승격이 "질문했습니다" 한마디로 사용자 task 를 닫아 버렸고,
답을 받은 뒤의 진짜 `report` 가 `이미 보고됐습니다` 로 거절됐다. 답이 들어오면 pending 이 닫히므로 **그다음 턴**에서
평소대로 승격된다. `ask_user`·`ask_parent`·TUI 질문 모두에 걸린다.

### 5. 지시문 템플릿 3종 확정 (`src/office/instructions/templates.ts`)

`toolNames(rank)` 가 `RANK_TOOLS` 를 읽는다. 본문은 rev 3 규칙으로 다시 썼다.

- **부장**: 팀이 없으면 `create_team`, 위임은 팀장에게만(팀원은 네 부하가 아니다), `[ALL_REPORTS_IN]` 이 오면 취합해
  사용자에게 `report`, 올라온 질문은 `reply` 로 답하고 **진짜 중요한 것만** `ask_user`, 끝난 팀은 `dismiss_team`.
- **팀장**: "작은 일은 팀원 없이 직접 해도 된다"(D-32 비용 조항)를 1번으로, 막히면 `ask_parent` 로 부장에게.
- **팀원**: "너에게는 report 와 ask_parent 두 도구뿐이다", 사용자에게 직접 묻지 않는다.

### 6. PROTOCOL.md

`## TeamTools MCP` 절을 rev 3 로 다시 썼다 — 직급별 도구 표(9개), 대상 규칙 두 줄, isError 문구 목록,
**봉투 표**(`[TASK#n from X(직급)]` · `[REPORTS …][ALL_REPORTS_IN]` · `[QUESTION from X q#n]` · `[ANSWER q#n]` ·
`[MESSAGE from X]`), `create_team`/`dismiss_team`/`ask_parent`+`reply` 절 신설, `ask_parent` payload 모양,
승격을 건너뛰는 두 경우(D-29 + 결함 ②). 이벤트 표에 `asking{tool:'ask_parent', to, toName}` 추가.

### 7. 콘솔 (`src/cli/`)

- `pending` 줄이 `q_ab12  question  이음 → 반장(ask_parent)  어느 폴더에 …` 로 from/to 를 보여 준다(`formatPending`).
- `asking` 이벤트로만 알게 된 pending 에도 `source`/`to` 를 실어 둔다(`onEvent`) — refresh 없이도 위 줄이 맞는다.
- `tasks` 끝에 `열린 ask_parent N건` 을 덧붙인다(위로 올라간 질문도 진행 중인 일이다).

## 검증

```
$ npx tsc --noEmit
(출력 없음)

$ npx tsx --test "test/**/*.test.ts"
ℹ tests 463
ℹ suites 63
ℹ pass 455
ℹ fail 1        ← T36(동시 작업)의 신규 테스트 "재시작 복구의 트리 순서" 하나. T35 범위는 전부 green
ℹ skipped 7
```

신규 테스트: `test/office/RankTools.test.ts` 13건(create_team·hire 트리 / delegate 사슬 봉투 / delegate 대상 규칙 /
보고 사슬 3단 / 부모 단위 버퍼 + blocked / ask_parent↔reply / ask_user 부장 전용 / question.respond 오버라이드 /
dismiss_team / **결함 ② 2건** / 문구 빌더). `test/mcp/TeamToolsServer.test.ts` 는 직급 3종 목록·부장 도구·ask_parent·
직급 강제(두 겹)로 갱신. `AskUser.test.ts` 는 `ask_user` 왕복을 **부장**으로(헬퍼 `headIn`), `Instructions.test.ts` 는
템플릿 3종 문장으로 갱신.

### 실기(opt-in, 실제 Claude 3세션) — `test/office/ranktools.integration.test.ts`

```
$ PIXEL_IT=1 npx tsx --test test/office/ranktools.integration.test.ts

[IT] dept=d_b5336907d55a head=m_c51229b841ad pid=28900 (755ms)
[IT] head idle (2202ms)
[IT] instruct task#1 (2205ms)
event #3 running {"tool":"mcp__team__create_team"}
[IT] create_team → lead 팀장A (m_f2923f23f89b) team=t_7dba622da17d parent=m_c51229b841ad (7961ms)
event #4 running {"tool":"mcp__team__delegate"}
[IT] head delegating task#2 → 팀장A (10523ms)
[IT] lead got: "[TASK#2 from 부장(부장)]\nhello35.txt에 hi 라고 쓰는 팀원을 하나 고용해서 시키고 결과를 보고해라. …"
event #10 running {"tool":"mcp__team__hire"}
[IT] lead hired 팀원A (m_6853ba28ddc0) parent=m_f2923f23f89b (15666ms)
[IT] lead delegating task#3 → 팀원A (19306ms)
event #13 thinking "[TASK#3 from 팀장A(팀장)]\n… hello35.txt 파일을 만들고 내용을 정확히 'hi' 로 써라 …"
event #17 waiting_approval {"tool":"Bash","cmd":"printf 'hi' > …/hello35.txt && od -c …"}   ← 테스트가 자동 allow
[IT] lead got reports:  [REPORTS task#3 팀원A status=done] … [ALL_REPORTS_IN]
[IT] head got reports:  [REPORTS task#2 팀장A status=done] …
event #34 running {"tool":"mcp__team__report"}
[IT] head reported task#1: {"summary":"'개발' 팀장A가 팀원A를 고용해 hello35.txt에 'hi'를 썼고, 파일 내용 확인 완료.", "status":"done", …}
[IT] hello35.txt: "hi" (39063ms)
[IT] daemon exited=true code=0 (45298ms)
[IT] leftover check: 24912=dead 24208=dead 2356=dead
✔ real daemon + real Claude head: create_team → delegate → lead hire → member works → reports climb → head report (46913ms)
ℹ tests 1  pass 1  fail 0
```

한 번에 돌았다(47초). 부장이 `ToolSearch` → `create_team` → `delegate` 를, 팀장이 `hire` → `delegate` → `report` 를,
팀원이 `Bash` → `report` 를 스스로 골랐고 봉투(`[TASK#2 from 부장(부장)]` / `[TASK#3 from 팀장A(팀장)]`)도 그대로 나왔다.
이 테스트가 띄운 claude.exe 3개만 정리됐다.

## 발견한 함정

1. **`thinking` 이벤트의 텍스트는 200자(`MAX_THINKING_CHARS`)에서 잘린다.** 실기에서 `[REPORTS …]` 뒤의
   `[ALL_REPORTS_IN]` 을 이벤트로 단언하려다 실패했다 — 큐에 들어간 본문에는 있는데 이벤트에는 꼬리가 없다.
   실기 단언은 봉투의 **머리**(`^\[REPORTS task#n <이름> status=…\]`)로만 하고, 꼬리는 단위 테스트가 본다.
2. **MCP 서버는 요청마다 도구 목록을 다시 만든다** — "목록을 받은 뒤 강등되면 isError" 를 테스트하려고 직급만 바꾸면
   다음 요청의 목록에서 도구가 아예 빠져 `-32602 Tool ask_user not found` 가 된다. 둘째 겹을 보려면
   `resolveMember` 가 **빌드 때와 콜백 때 다르게** 답하게 해야 한다(T25의 "멤버 없음" 테스트와 같은 수법).
3. **큐는 한 항목을 흘린 뒤 `busyAfterFlushMs`(1500ms) 동안 쉬고, 멤버가 `working` 이면 아예 안 흘린다.**
   보고 사슬 테스트에서 상사에게 `[REPORTS]` 가 들어가는 것을 보려면 그 상사의 턴을 `Stop` 으로 먼저 끝내야 하고
   (안 그러면 `working` 이라 큐가 멈춘 채다), 연속 두 항목은 `NEXT_FLUSH_MS(2400)` 를 기다려야 한다.
4. **`blocked` 보고가 버퍼를 굶겼다**(T25 부터 있던 구멍). `blocked` 는 버퍼를 건너뛰고 즉시 나가는데, 그것이 마지막
   미종료 task 였으면 이미 쌓여 있던 `done` 보고가 흘릴 계기를 영영 못 얻는다. `flushReportBuffer` 를 뒤에 한 번 더 부른다.

## 결정

- D-37 · `ask_parent` 는 `ask_user` 와 같은 pending 한 종류로 두고, 답하는 길을 둘로 연다(상사의 `reply` = 정식,
  사용자의 `question.respond` = 광고하지 않는 오버라이드).

## 남은 것

- **T36**: 후처리·복구·파생의 트리화(동시 진행 중). 이 글을 쓰는 시점에 `재시작 복구의 트리 순서` 테스트 1건이 빨간색인데
  T35 범위 밖이다.
- **T37**: 앱이 `ask_parent` 질문 카드를 **내 책상에 올리지 않아야** 한다(부장의 `ask_user` 만 내 책상). 대신 그 팀장·팀원
  캐릭터 위 말풍선으로 보여 주고, 사용자 오버라이드(`question.respond`)는 UI 에 광고하지 않는다.
- **T38**: README·02 체크리스트에 rev 3 도구 표 반영.
- `dismiss_team` 은 지금 팀을 **삭제**한다(`deleteTeam`). "팀은 남기고 사람만 내보내기" 가 필요해지면 그때 나눈다.
- 부장이 `ask_parent` 를 부를 수 없는 것처럼, 팀원이 `reply` 를 못 쓰는 것도 규칙이다 — 팀원이 위에 되묻는 길은
  `ask_parent` 하나뿐이다(대화가 길어지면 상사가 `delegate` 로 다시 낸다). 실기에서 불편하면 T39에서 다시 본다.
