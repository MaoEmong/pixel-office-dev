# 데몬 ↔ 클라이언트 프로토콜 (v1a 초안, T07에서 확정)

전송: WebSocket `ws://127.0.0.1:7420`. 봉투: **JSON-RPC 2.0** (요청 `{jsonrpc:"2.0", id, method, params}` / 응답 `{jsonrpc:"2.0", id, result|error}` / 알림 `{jsonrpc:"2.0", method, params}`).
인증: 데몬 기동 시 `%LOCALAPPDATA%\pixel-office\daemon.json`(= `${PIXEL_DATA_DIR}/daemon.json`)에 `{ "wsPort", "hookPort", "mcpPort", "token", "pid", "startedAt", "version" }`를 쓴다(포트는 실제 바인딩된 값; `mcpPort` 는 TeamTools MCP(T17, 아래) 포트; token 은 기동마다 새로 만든 32바이트 hex; 정상 종료 시 파일 삭제). 클라이언트는 첫 요청 `hello`에 token을 넣는다. 불일치면 에러 응답(-32001) 후 소켓 종료(close code 4001). `hello` 전에 다른 메서드를 부르면 같은 처리. 인증 후의 오류 응답은 소켓을 끊지 않는다.

`params` 는 항상 객체(없으면 `{}`). 클라이언트→데몬 알림(id 없는 요청)은 정의된 것이 없으며 무시된다. 결과가 따로 없는 메서드는 `{}` 를 돌려준다.

## 클라이언트 → 데몬 (요청)

| method | params | result |
|---|---|---|
| `hello` | `{ token, since?: number, client: { name, version } }` | `{ daemon: { version, pid }, snapshot }` 후 `seq > since` 인 `event` 알림 replay(응답이 먼저, replay 는 오름차순). `since` 없으면 스냅샷만. |
| `events.query` | `{ departmentId?, teamId?, memberId?, beforeSeq?, limit? }` | `{ events: OfficeEvent[] }` (seq 내림차순 아님 — 오름차순 반환. `beforeSeq` 미만 중 최신 `limit`(기본 200)건; 다음 페이지는 첫 건 seq 를 `beforeSeq` 로) |
| `department.create` | `{ name, cwd, headEngine: 'claude'\|'codex', headName? }` | `{ department, head: Member }` — **사용자가 하는 유일한 생성**(T34, D-32). 부서 행 → 부장 멤버(`rank:'head'`, `parentId:null`, `teamId:null`, `hiredBy:'user'`, 이름 `headName ?? '부장'`, 엔진 `headEngine`) → CLI 스폰 → `department.headId` 기록. 부장 출근은 보통 멤버와 같은 경로라 `member.status{starting}` 알림이 다른 클라이언트에도 나간다. `headEngine:'codex'` 도 허용하지만 `daemon.notice{warn}` 로 "v1 권장은 claude". 오류: `cwd` 가 폴더가 아님·모르는 엔진·빈 이름 → -32602. 부장 스폰이 실패하면 부서 행도 되돌린다. |
| `department.delete` | `{ departmentId }` | `{}` — 하위 트리 전체(팀원 → 팀장 → 부장, **잎부터**)를 후처리·퇴근시키고 부서·팀·멤버·task 행을 지운다. events 는 남는다. 없는 부서 -32002. |
| `department.tree` | `{}` | `{ departments: [{ department, head?, teams: [{ team, lead?, members: [] }], orphans: [] }] }` — 읽기 전용 트리. 멤버 행에는 스냅샷과 같은 `derived` 가 붙는다. `orphans` 는 어느 팀에도 안 붙은(부장 이외) 멤버 — 디버그 경로로만 생긴다. 콘솔 `tree`. |
| `team.create` | `{ departmentId, name, leadEngine?, leadName?, maxMembers?, allowedEngines?, force: true }` | `{ team, lead: Member }` — **T34 부터 디버그 전용**: `force:true` 가 없으면 -32004(정식 경로는 부장의 `create_team` 도구, T35). 팀은 부서 안에서만 만들어지고 **cwd 는 부서 cwd** 다(D-32 "한 부서 안의 팀들은 같은 cwd"). 팀장 멤버(`rank:'lead'`, `parentId` = 그 부서의 살아 있는 부장, `hiredBy:'leader'`, 이름 `leadName ?? '팀장'`, 엔진 `leadEngine ?? 부장 엔진`)가 자동 출근하고 `team.leaderId` 가 채워진다. 팀장도 정원(`maxMembers`, 기본 4)의 한 자리다. 오류: 없는 부서 -32002, 살아 있는 부장 없음 -32003, 모르는 엔진·`allowedEngines` 밖·`maxMembers < 1` -32602. 팀장 스폰이 실패하면 팀 행도 되돌린다. |
| `team.delete` | `{ teamId }` | `{}` — 그 팀의 팀원 → 팀장 순으로 퇴근시키고 팀·멤버 행 삭제. 부장과 task 행은 남는다(task 는 부서 소유). |
| `member.clockIn` | `{ parentId?, departmentId?, teamId?, engine, name, instructions?, rank?: 'head'\|'lead'\|'member', force: true }` | `{ member }` — **T34 부터 디버그 전용**: `force:true` 가 없으면 -32004(사용자는 부서를 만들어 부장만 임명한다, D-32). `hiredBy` 는 항상 `'user'` 라 상위가 `dismiss` 할 수 없다. 두 갈래다. **`parentId` 를 주면** 정식 고용 경로와 같은 직급 사슬 검사를 받는다(head → lead → member, 어긋나면 -32004). **주지 않으면** `departmentId`/`teamId` 로 바로 꽂는 디버그 경로이고, 살아 있는 상사가 있으면 자동으로 그 아래로 붙는다. `rank` 기본값은 부모가 있으면 부모 아래 직급, 없으면 `teamId` 가 있으면 `'member'`·없으면 `'head'`. 정원 초과·부장/팀장 중복 -32003, 없는 부서·팀 -32002, 모르는 rank·엔진 -32602. 상사가 있으면 그 상사 큐에 `[TEAM] 팀원 변경: +<이름>(<engine>[, 역할: …])`. |
| `member.clockOut` | `{ memberId }` | `{}` — **누구든 내보낼 수 있는 비상구**(T34: 사용자가 팀장·팀원을 직접 출근시키는 기능은 없앴지만 퇴근은 남겼다 — 굳은 세션을 사용자가 치울 길이 없으면 안 된다). 진행 task aborted 후처리(발행자에게 `[REPORTS … status=aborted]` 즉시 전달, T25), 프로세스 종료(Claude `/exit`). 행은 `status:'exited'` 로 남는다(rehire 가능). 이미 exited/error 면 -32003. 그 멤버의 **직속 상사** 큐에 `[TEAM] 팀원 변경: -<이름>`. **상위(부장·팀장)를 퇴근시키면** 그가 낸 미종료 task 가 전부 aborted 되고 그 일을 맡고 있던 부하가 interrupt 된다(부하 행은 남는다 — 하위 트리까지 따라 내려가는 정리는 T36). |
| `member.rehire` | `{ memberId }` | `{ member }` — exited/error 멤버를 같은 설정으로 재스폰(`--resume` 시도). 아직 살아 있으면 -32003(→ `member.restart`). |
| `member.restart` | `{ memberId }` | `{ member }` — 지시문 즉시 반영용 재스폰(`--resume`) 후 큐에 `[RESUMED] …` 시스템 메시지. 종료된 멤버에도 허용. |
| `member.instruct` | `{ memberId, text, force?: boolean }` | `{ taskId }` — `tasks(from:'user', status:'queued')` 생성 후 입력 큐에 `[TASK#n from user]\n<text>` 타이핑. 실제로 pty 에 들어가면 `assigned`, 그 턴의 `Stop` 에서 `reported`(report_text = 마지막 assistant 메시지, v1a 보고). 종료된 멤버 -32003. **"부장에게만 지시"(T34, D-32):** 대상이 부장이 아니고 **그 부서에** 살아 있는 부장이 있으면 **-32004** `"부장에게만 지시할 수 있습니다 (head: <부장 이름>)"`(`data: { headId }`) — task 는 만들어지지 않는다. 부장이 exited/error 로 나가면 게이트가 열려 팀장·팀원 직접 지시가 허용된다. `force: true` 는 이 게이트를 넘는 **디버그 탈출구**로, 앱은 보내지 않는다. 터미널 탭 직접 타이핑(`member.type`)은 "지시"가 아니라 게이트와 무관하다. |
| `member.type` | `{ memberId, data }` | `{}` — 터미널 탭 직접 타이핑 (raw bytes, 큐 우선). 빈 문자열 허용. |
| `member.attach` | `{ memberId, cols, rows }` | `{ screen: string(ANSI serialize), cols, rows }` 이후 `term` 알림 구독. attach 한 클라이언트가 "마지막 attach 클라이언트"가 되어 그 크기로 즉시 resize. cols 20~500, rows 5~300 밖은 -32602. 이 데몬 세션에서 한 번도 스폰되지 않은 멤버(재시작 전 멤버 등)는 -32003. |
| `member.detach` | `{ memberId }` | `{}` — 연결이 끊기면 자동 detach. |
| `member.resize` | `{ memberId, cols, rows }` | `{}` — 마지막 attach 클라이언트만 유효(다른 클라이언트의 호출은 오류 없이 무시) |
| `member.interrupt` | `{ memberId }` | `{}` — Ctrl+C. 큐의 미전송 지시는 버리고 그 멤버의 미종료 task aborted·열린 pending expired. Ctrl+C 두 번이면 CLI 가 종료되므로 1.5초 안의 두 번째 호출은 -32003. `Stop` hook 이 없으므로 화면에 준비 문구가 보이면 데몬이 `idle{summary:'interrupted'}` 이벤트로 idle 처리. |
| `member.instructions.get` | `{ memberId }` | `{ markdown }` — **사용자 파일만**(없으면 `""`). 지시문 편집기가 보는 값이라 기본 템플릿을 섞지 않는다. |
| `member.instructions.set` | `{ memberId, markdown }` | `{}` — 다음 SessionStart부터 반영. 파일: `${dataDir}/teams/<teamId>/members/<memberId>/INSTRUCTIONS.md` |
| `member.instructions.effective` | `{ memberId }` | `{ markdown }` — **다음 SessionStart 에 실제로 주입될 전체 텍스트**(런타임 프리앰블 + 유효 지시문, 아래 "멤버 지시문 주입"). 읽기 전용·부작용 없음. 콘솔 `instr effective <member>`. |
| `approval.respond` | `{ pendingId, behavior: 'allow'\|'deny', updatedInput?, message?, alwaysThisSession?: boolean }` | `{}` — `message` 는 deny 시 모델에게 보여줄 사유(기본 "Denied by user"). `alwaysThisSession` 은 allow 일 때 같은 멤버·같은 도구의 다음 허가 요청을 데몬이 자동 allow(데몬 메모리, 재시작 시 초기화). 없는 pending -32002, approval 이 아니면 -32602, 이미 answered/expired -32003. |
| `question.respond` | `{ pendingId, answers: Record<string,string> }` | `{}` — `answers` 는 `{ "<question>": "<label>" }`(자유 답도 `label` 자리에). 오류 코드는 approval.respond 와 동일. **출처별 처리(T17):** TUI `AskUserQuestion`(payload 에 `tool_input` 있음)은 hook 결정으로 돌려주고, TeamTools `ask_user`(payload `source:'ask_user'`)는 pending 을 answered 로 닫은 뒤 그 멤버 입력 큐에 `[ANSWER q#<pendingId>]\n<답>` 시스템 메시지를 넣는다(아래 "TeamTools MCP"). **Codex 질문 폴백**(payload 에 `fallback:'codex-stop'`, 아래 "Codex 폴백")은 봉투 없이 답 본문만 넣는다. 값이 전부 빈 문자열이면 -32602. 멤버가 실행 중이 아니면 -32003. |
| `daemon.shutdown` | `{}` | `{}` — 응답 후 `daemon.notice{level:'info'}` 를 보내고 전원 정중히 종료(`/exit`) → 모든 소켓 close code 1001 → 프로세스 종료. 멤버 status 는 바꾸지 않는다(T09 재시작 복구용). |

에러 코드: `-32001` 인증 실패, `-32002` 없는 멤버/팀/부서/pending, `-32003` 상태 오류(예: 이미 종료, 정원 초과, 부장·팀장 중복), `-32004` 직급 규칙 위반(T34 "부장에게만 지시", 고용 사슬 위반, TeamTools 의 직급 전용 도구, **디버그 전용 메서드를 `force` 없이 부름**), `-32602` 파라미터. 그 외 JSON-RPC 표준: `-32700` JSON 파싱 실패(id null), `-32600` 봉투 오류(`jsonrpc:"2.0"`·`method` 누락), `-32601` 없는 메서드, `-32000` 내부 오류. 에러 객체는 `{ code, message, data? }`.

## 데몬 → 클라이언트 (알림)

| method | params |
|---|---|
| `event` | `OfficeEvent` — `{ seq, ts, departmentId, teamId, memberId, kind, detail, ref }` (영속, 전역 단조 seq). `departmentId` 는 T34 부터, `teamId` 는 팀이 없는 부장의 이벤트에서 `''`. |
| `snapshot` | `{ seq, departments, teams, members, pending, tasks }` — `hello` 응답에 포함되지만 데몬이 필요 시 재전송 가능. `pending` 은 `status:'open'` 만, `tasks` 는 `queued|assigned` 만. **`members[]` 의 각 행에는 Member 칼럼 + `derived`(그 시점의 파생 상태, 아래 표)가 같이 온다(T28)** — 클라이언트가 파생 규칙을 다시 구현하지 않아도 재접속 직후 화면이 맞는다. |
| `term` | `{ memberId, data }` — attach한 클라이언트에만, 비영속 |
| `member.status` | `{ memberId, status, derived, member? }` — `status` 는 raw(`starting\|idle\|working\|waiting_approval\|waiting_answer\|exited\|error`), `derived` 는 **파생 상태**(아래 표). `member` 는 그 시점의 Member 행(새 멤버 출근을 다른 클라이언트가 알 수 있게; 행이 삭제됐으면 생략). **status 값이 바뀔 때 + `derived` 만 바뀔 때** 온다(T28 — 예: 팀장이 raw `idle` 인 채로 `delegate` 하면 `free → waiting_reports`). 둘 다 그대로면 오지 않는다. |
| `daemon.notice` | `{ level: 'info'\|'warn'\|'error', message }` — 예: hook 보류 타임아웃, 알 수 없는 멤버 토큰, 첫 실행 다이얼로그 자동 통과, 자동 allow, 데몬 종료. **자동 통과할 수 없는 다이얼로그**(CLI 자체 허가 프롬프트 `approval-prompt`, D-23/D-26)는 `{level:'warn', message:'<이름>: CLI 허가 프롬프트가 떠 있음 — 카드로 답하거나 터미널에서 직접 답하세요'}` 로 **한 번만** 나온다(그 다이얼로그가 사라졌다 다시 뜨면 다시 한 번). 데몬은 이때 키를 보내지 않는다 — 사용자가 "재지시 필요" 카드나 터미널 탭에서 답해야 한다. |

## 멤버 파생 상태 `derived` (T28, 01 §2 "멤버 표시 상태(파생)")

raw `status` 는 "CLI 프로세스가 어떤 상태인가" 일 뿐이다 — `idle` 은 **턴이 끝났다**는 뜻이지 "할 일이 없다" 가 아니고, `ask_user` 질문은 턴이 끝난 뒤에도 열려 있다. 사무실 화면(포즈·모니터·말풍선)이 보는 값은 그래서 `derived` 다. 데몬 안에서 이 규칙을 계산하는 곳은 `src/office/derived.ts` 하나이고, `snapshot.members[].derived` 와 `member.status.derived` 가 같은 함수를 쓴다 — 클라이언트는 다시 계산하지 말고 받은 값을 그대로 쓴다.

| `derived` | 조건(위에서부터 먼저 맞는 것) |
|---|---|
| `exited` / `error` | raw 가 그것이면 무조건(나간 멤버는 파생이 덮지 않는다) |
| `waiting_approval` | 열린 `pending(approval)` 이 있다 — raw 가 무엇이든 |
| `waiting_answer` | 열린 `pending(question)` 이 있다 — raw 가 무엇이든(`ask_user` 는 raw `idle` 에서도 열려 있다, T17) |
| raw 값 그대로 | raw 가 `idle` 이 아니다(`starting` / `working`) |
| `waiting_reports` | raw `idle` + 자기가 낸(발행한) 미종료 task 가 있다 — **직급 무관**(T34: 부장도 팀장도 부하 보고를 기다리면 같은 상태) |
| `free` | raw `idle` + 열린 pending 없음 + 자기에게 배정된 미종료 task 없음 + 발행한 미종료 task 도 없을 때(= 잎이 한가함) |
| `idle` | 그 외(= raw `idle` 인데 아직 `queued\|assigned` task 를 들고 있다) |

## 부서·팀·직급 트리 (T34, D-32 "직무 체계 rev 3")

```
사용자 ──부서 생성·부장 임명──▶ 부장(head) ──팀 생성·팀장 배치──▶ 팀장(lead) ──팀원 고용──▶ 팀원(member)
   ◀── 보고·ask_user (부장만) ──┘        ◀── 보고·ask_parent ──┘         ◀── 보고·ask_parent ──┘
```

직급은 **부장/팀장/팀원 3단 트리**다(01 §"직무 체계 rev 3"). 클라이언트가 보는 필드는 스냅샷·`member.status.member` 에 그대로 실린다.

- `Department`: `{ id, name, cwd, headId, createdAt }` — **부서 = 프로젝트(cwd)**. 한 부서의 팀·멤버는 모두 이 폴더에서 일한다(팀별 worktree 분리는 v2).
- `Team`: `{ id, departmentId, name, cwd, leaderId, maxMembers, allowedEngines, createdAt }` — `cwd` 는 당분간 부서 cwd 와 같다.
- `Member.rank`: `'head' | 'lead' | 'member'` — 부장은 부서당 한 명, 팀장은 팀당 한 명(둘 다 살아 있는 기준).
- `Member.departmentId` / `Member.teamId` / `Member.parentId`: 부장은 `teamId: null`·`parentId: null`(부서 직속), 팀장은 자기 팀 + `parentId` = 부장, 팀원은 팀장의 팀 + `parentId` = 팀장.
- `Member.hiredBy`: `'user' | 'leader'` — `'leader'` 는 "상위 멤버가 고용" 이라는 뜻(v1 값을 그대로 쓴다). 사용자가 출근시킨 멤버는 상위가 `dismiss` 할 수 없다.
- **살아 있는 부장·팀장** 판정은 `headId`/`leaderId` 가 아니라 `members` 에서 `rank ∧ status ∉ {exited, error}` 로 한다(나간 뒤에도 id 는 남는다). 데몬도 같은 기준(`Store.liveHead` / `Store.liveLead`).
- **고용·해고·지시는 바로 아래로만, 보고·질문은 바로 위로만.** 사슬을 건너뛰는 고용(부장 → 팀원 등)은 -32004.
- **지시 대상:** 살아 있는 부장이 있으면 사용자 지시는 부장에게만(`member.instruct` -32004). 앱의 지시 바는 선택 멤버가 부장이 아니면 부장으로 돌리거나 비활성화한다(T37). 부장이 없는 부서는 아무 멤버에게나 지시할 수 있다.
- **사용자가 직접 할 수 있는 것은 부서 생성(부장 임명)·퇴근·중단·재시작·터미널 타이핑뿐이다.** 팀 생성(`team.create`)과 멤버 출근(`member.clockIn`)은 `force:true` 디버그 경로로만 남아 있다.

## 오피스 이벤트

`kind`: `thinking | text | reading | editing | running | waiting_approval | asking | delegating | reporting | idle | error`
`detail`: `{ tool?, path?, cmd?, summary?, text? }` — `text`는 턴 단위 코얼레스(Stop의 last_assistant_message)
`ref`: `{ approvalId?, questionId?, taskId? }`

v1a 에서 데몬이 만드는 이벤트(어댑터 표는 worklog T04 참고):
- `asking{tool:'ask_user', summary:<question>, options?:string[]}` ref `{questionId}` — TeamTools `ask_user` 호출(T17). TUI `AskUserQuestion` 의 `asking{tool:'AskUserQuestion'}` 과 `detail.tool` 로 구분. 답이 들어가면 `thinking{text:'[ANSWER q#<id>]\n…'}` 로 보인다.
- `reporting{summary}` ref `{taskId}` — `Stop` 시점에 그 멤버의 `assigned` task 를 `reported` 로 닫으면서(report_text = 직전 `text`), 내 책상 "보고".
- `reporting{summary, status:'done'|'blocked'|'aborted', files?}` ref `{taskId}` — TeamTools `report` 호출(T25). 발행자가 사용자인 task 면 이것이 내 책상 "보고"이고, 팀장이 낸 task 면 팀장에게 `[REPORTS …]` 가 따로 들어간다(아래 "TeamTools MCP"). 중단 후처리(`interrupt`/퇴근/비정상 종료)도 사용자 task 에 `reporting{status:'aborted'}` 를 남긴다.
- `delegating{tool:'delegate', summary:<task>, to:<memberId>, toName, status:'assigned'|'queued'}` ref `{taskId}` — 팀장이 `delegate` 로 팀원에게 일을 넘겼다(T25). 이벤트는 **팀장**에게 붙는다(사무실에서 "위임" 표시). `status:'queued'` 면 그 팀원이 바빠서 줄을 선 것이고, 유휴가 되면 데몬이 전달한다(따로 이벤트를 내지 않는다 — `thinking{text:'[TASK#n from …]'}` 으로 보인다).
- `idle{summary:'interrupted'}` — `member.interrupt` 후 화면 준비 문구로 idle 판정.
- `idle{summary:'screen-idle'}` — **턴 종료 hook 없이 프롬프트로 돌아온 화면**의 폴백(T23b, D-25). 멤버가 `working`/`waiting_approval`/`waiting_answer` 인데 ① 열린 pending 이 하나도 없고 ② 화면에 다이얼로그·busy 표시가 없고 prompt ready 이고 ③ 그 사이 새 hook 이 오지 않은 상태가 **3초 연속**이면 데몬이 이 이벤트를 내고 status 를 `idle` 로 내린다(500ms 폴링, 멤버당 타이머 하나, 세션이 끝나면 정지). 실제 사례: Codex 사용량 한도 안내는 화면에만 뜨고 `Stop` 을 내지 않아 멤버가 `working` 에 갇혔다. 보류(허가·질문)가 열려 있거나 busy 표시가 있으면 절대 나오지 않는다.
- `running{cmd?, summary:'셸 대기 중 (락: <이름>)', waiting:'shell-lock', holder:<memberId>}` — **팀 셸 뮤텍스**(T27, 아래 "팀 셸 뮤텍스")에서 다른 멤버가 락을 쥐고 있어 이 멤버의 셸 명령이 줄을 섰다. 그 도구의 보통 `running{tool, cmd}` **바로 뒤에** 대기 한 번당 한 번만 나온다(말풍선이 "대기 중"으로 끝난다). `member.status` 는 `working` 그대로 — CLI 는 도구를 부른 채 데몬 응답을 기다린다. 락을 받으면 이벤트를 따로 내지 않는다(앞의 `running` 이 그대로 유효).
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
| 질문(`asking`) | TUI `AskUserQuestion` + TeamTools `ask_user` | **TUI 질문이 없다.** TeamTools `ask_user`(T22 주입) + **질문 폴백**(턴 종료 메시지가 질문이면 데몬이 승격, 아래 "Codex 폴백") |
| 첫 `idle` | `SessionStart` hook(기동 직후) | **`SessionStart` 가 첫 프롬프트 제출 때 온다**(실측 T20). 데몬이 화면 준비(prompt ready)를 보고 `starting → idle` 로 올린다 — 클라이언트에는 그냥 `member.status idle` 로 보인다 |
| 중단 | `Ctrl+C` → Stop hook 없음 → 화면으로 `idle{summary:'interrupted'}` | `Ctrl+C` → **`Interrupt` hook**(3초 클램프) → 같은 `idle{summary:'interrupted'}` |
| 퇴근(`member.clockOut`) | `/exit` + Enter | `Ctrl+C`(idle 이면 한 번에 exit 0). 2초 안에 안 죽으면 `Ctrl+C` 한 번 더, 그래도 안 죽으면 강제 종료 |
| 첫 실행 다이얼로그 | 온보딩 + 폴더 신뢰(↓+Enter) | 폴더 신뢰 "Do you trust the contents of this directory?" → Enter (ScreenModel 감지, InputQueue 가 통과 → `daemon.notice{info}`) |
| TeamTools MCP | `--mcp-config <세션 mcp.json>` 로 주입 | `-c mcp_servers.team.url="http://127.0.0.1:<mcpPort>/mcp/<memberToken>"`(T22, 그 실행에만 — `~/.codex/config.toml` 은 안 건드린다). 실기동에서 `/mcp` 가 `team: connected (1 tool) · Tools: ask_user` 로 보인다 |
| 보고(`reporting`) | TeamTools `report`(M4) / v1a 는 턴 종료 메시지 승격 | 같음(**폴백**: 아래 "Codex 폴백") |

`SessionEnd` 의 `reason` 이 `clear`/`resume` 이면 두 엔진 모두 종료로 보지 않는다(같은 프로세스에서 새 `SessionStart` 가 따라온다).

## 셸 뮤텍스 (T27 · T34 에서 범위가 부서로)

같은 폴더에서 일하는 멤버 둘이 동시에 빌드·테스트·쓰기 명령을 돌리지 않도록 **부서당 셸 락 하나**를 둔다(01 §구성 요소 1). 클라이언트가 호출하는 RPC 는 없다 — 데몬이 hook 단계에서 처리하고, 클라이언트는 이벤트·알림으로만 본다.

- **언제 잡나:** 셸 도구(`Bash`/`PowerShell`, Codex 의 셸 도구 포함)의 `PreToolUse`. 허가(`PermissionRequest`) 여부와 무관하다 — 읽기 명령은 허가 없이 실행되기 때문(실측 02 §②). **읽기 전용 명령(`cat`·`ls`·`git status`·`sed -n` …)은 잡지 않는다**(D-27): 서로 부딪히지 않는데 팀 전체를 직렬화하게 된다. 판정은 엔진 공통(`isReadOnlyCommand`), 애매하면 "쓰기"로 보고 잡는다.
- **기다리는 동안:** 두 번째 셸의 `PreToolUse` **응답을 보류**한다(그 CLI 는 도구 실행 전에 멈춰 있다). 클라이언트에는 위 `running{waiting:'shell-lock'}` 이벤트 하나로 보인다. 줄은 FIFO(hook 도착 순).
- **언제 푸나(01 §해제 표 + 실측):** ① `PostToolUse` **또는 `PostToolUseFailure`**(실패 때는 `PostToolUse` 가 안 온다) — `tool_use_id` 로 짝을 맞춘다. ② 그 멤버의 `Stop`·턴 종료(안전망). ③ `member.interrupt` / 퇴근 / 프로세스 종료 / 재시작 후처리. ④ 보유 상한 30분 초과 → 강제 해제 + `daemon.notice{level:'warn', message:'<이름>: 셸 락을 <N>초째 쥐고 있어 강제로 해제함 (<명령 80자>)'}`.
- **hook 이 먼저 끊기면:** 보류 상한(D-16)·연결 끊김으로 응답이 pass-through(`{}`)로 나가면(D-11) 그 명령은 데몬 허락 없이 실행된다. 데몬은 그 대기 자리를 줄에서 **뺀다**(아무도 안 기다리는 락을 넘겨받아 팀이 굳는 것을 막는다). 뮤텍스가 한 번 뚫리는 것이 명령을 포기시키는 것보다 낫다는 D-11 그대로다.
- **경계:** 락은 `departments.id` 단위다(T34 — 한 부서의 팀들은 **같은 cwd** 를 쓰므로 팀 단위로는 서로를 못 막는다). 다른 부서는 서로 막지 않고, 같은 부서면 팀·직급·엔진이 달라도(Claude ↔ Codex) 같은 락을 쓴다.

## 멤버 지시문 주입 (T26b)

멤버마다 자기 지시문이 있다(01 §전제 7 · §멤버 지시문 주입). 데몬은 그것을 `SessionStart` hook 의 `additionalContext` 로 돌려준다 — **startup·resume·clear·compact 네 source 모두**에서 다시 오므로 compaction·`/clear` 로 유실되지 않는다(D-05). 프로젝트의 `CLAUDE.md`/`AGENTS.md` 는 건드리지 않는다.

주입되는 텍스트 = **런타임 프리앰블 + 유효 지시문**. `member.instructions.effective` 가 이 텍스트를 그대로 돌려준다(콘솔 `instr effective <member>`).

- **유효 지시문** = 사용자 `INSTRUCTIONS.md` 에 **본문이 있으면** 그 파일, 없으면 **직급별 기본 템플릿**(부장 = 부서 오케스트레이션 규칙, 팀장 = 팀 오케스트레이션 규칙 + `hire`/`dismiss`/`delegate`/`report`/`ask_user`, 팀원 = 역할 규칙 + `report`/`ask_user`). 템플릿 문장은 앱의 "기본 템플릿 넣기"(T26a)와 같고, 데몬 쪽에는 동적 머리말(`# <이름> — <부장|팀장|팀원> @ <부서 또는 팀>`, 작업 폴더·엔진·역할·상사)과 팀 설정 숫자(정원·허용 엔진)가 더 붙는다. 직급별 도구 목록 확정은 T35.
- **`hire` 가 쓴 `# 역할: <role>` 한 줄뿐인 파일은 "본문 없음"** 으로 본다 — 그건 사용자가 쓴 지시문이 아니라 역할 메타데이터라(`[TEAM]` 알림이 되읽는다) 기본 템플릿을 덮지 않고, 대신 그 역할이 템플릿 머리말 `- 역할: …` 에 실린다. `hire`/`member.clockIn` 에 `instructions` 를 같이 주면 그것이 본문이 되어 템플릿을 대신한다.
- **기본 템플릿은 파일로 저장하지 않는다.** 지시문 파일은 사용자(앱·콘솔 `instr set`)나 `hire`/`clockIn` 의 `instructions` 로만 생긴다. 기본값은 주입할 때마다 계산하므로, 데몬의 템플릿을 고치면 지시문을 따로 쓰지 않은 멤버 전원에게 다음 SessionStart 부터 바로 반영된다.
- **프리앰블은 사용자 파일이 있어도 늘 붙는다** — 사용자가 쓴 지시문에는 "나는 누구이고 팀에 누가 있는가" 가 없기 때문이다.

  ```
  [사무실] 너는 픽셀 오피스 부서 "alpha" 의 팀 "t1" 의 팀원 이음(엔진 claude)이다.
  - 직급: 팀원 (부장 → 팀장 → 팀원; 지시·고용은 바로 아래로만, 보고·질문은 바로 위로만)
  - 작업 폴더: D:\myproject\alpha
  - 상사: 반장(팀장) — 보고·질문은 여기로만 올린다.
  - 직속 부하: (없음)
  - 도구 이름: mcp__team__report, mcp__team__ask_user (도구 목록에 없으면 ToolSearch로 찾는다).
  아래는 너의 지시문(INSTRUCTIONS.md)이다 — 프로젝트의 CLAUDE.md/AGENTS.md 위에 얹히는 개인 규칙이다.
  ```

  **로스터는 팀 전체가 아니라 직속 부하만**이다(T34, D-32 — 트리에서 말을 걸 수 있는 상대가 상사 한 명과 직속 부하들뿐이라, 팀 전체를 보여 주면 없는 권한을 착각한다). 살아 있는(exited/error 가 아닌) 자식만 싣고, 역할은 각자 지시문 첫 줄의 `# 역할:` 에서 읽는다. 부장 줄은 `- 상사: 사용자(사람) — 사용자에게 직접 보고·질문할 수 있는 직급은 너뿐이다.` 다. 도구 이름 줄은 직급에 따라 다르다 — D-22: Claude 는 MCP 도구를 지연 로딩하므로 이름이 적혀 있어야 `ToolSearch` 로 찾아 첫 턴부터 쓴다.
- **길이 상한:** 전체 3000자(한국어 기준 ~2500토큰). 넘으면 **사용자 본문만** 뒤에서 자르고 `[… 지시문이 길어 여기서 잘렸습니다. 전문은 이 멤버의 INSTRUCTIONS.md 에 있습니다.]` 를 붙인다. 프리앰블(정체·로스터·도구)은 통째로 남는다.
- 엔진 무관: Claude·Codex 어댑터가 같은 텍스트를 같은 방식으로 돌려준다(Codex 는 `SessionStart` 가 첫 프롬프트 제출 때 온다 — T20).

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

## TeamTools MCP (T17 `ask_user` · T25 `hire`/`dismiss`/`delegate`/`report`)

데몬이 CLI 세션에 노출하는 MCP 서버. 클라이언트(앱)가 부르는 것이 아니라 **멤버의 CLI 가 도구로 부른다.**

- **엔드포인트:** `http://127.0.0.1:<mcpPort>/mcp/<memberToken>` — MCP **Streamable HTTP** 전송(`@modelcontextprotocol/sdk`, 무상태: 세션 id 없음, 요청마다 새 서버 인스턴스). `mcpPort` 는 config(`PIXEL_MCP_PORT`, 기본 7422)·`daemon.json`. 모르는 토큰·다른 경로·종료된 멤버의 토큰은 404 `{ jsonrpc, error:{code:-32001, message:'unknown member token'} }`. 토큰은 hook 과 같은 식별 용도(보안 경계 아님, 로컬 전용).
- **주입:** Claude 는 스폰 때마다 `${dataDir}/sessions/<memberId>/mcp.json` = `{ "mcpServers": { "team": { "type": "http", "url": "http://127.0.0.1:<mcpPort>/mcp/<memberToken>" } } }` 을 쓰고 `--mcp-config <그 파일>` 을 붙인다(clockIn/rehire/restart/재시작 복구 전부). 도구는 Claude 안에서 `mcp__team__ask_user` 로 보인다(첫 호출은 `PermissionRequest` → `approval` pending 을 탈 수 있다).
  **Codex 는 같은 URL 을 `-c mcp_servers.team.url="…"` 인자로 받는다(T22)** — 그 실행에만 적용되고 `~/.codex/config.toml` 은 건드리지 않는다(`codex mcp add <name> --url` 이 쓰는 키와 같다). 서버 이름은 두 엔진 모두 `team`. MCP 도구의 `PermissionRequest` 는 두 엔진 모두 데몬이 자동 allow 한다(D-22; Codex 의 `tool_name` 모양이 아직 미확인이라 `team` + 도구 이름이 둘 다 들어 있으면 우리 도구로 본다).
- **도구 `ask_user({ question: string, options?: string[] })`** — 비블로킹. 데몬이:
  1. `pending(question)` 생성 — payload `{ source:'ask_user', question, options: string[] }` (**`tool_input` 없음** — D-19: 재시작 복구가 이 질문을 유효한 것으로 남긴다. TUI 질문 payload 는 `{ questions, tool_input }`).
  2. `asking{tool:'ask_user', summary:question, options?}` ref `{questionId}` 이벤트.
  3. status `waiting_answer`(도구 완료 `PostToolUse` 로 곧 `working`, 턴이 끝나면 `idle` — 이때 `derived` 는 `waiting_answer`).
  4. 도구 결과 텍스트: `질문 q#<id> 등록됨. 사용자의 답은 "[ANSWER q#<id>]" 메시지로 도착한다. 답이 필요하면 이 턴을 끝내고 기다려라.` (`<id>` = pending id, 예 `q_1a2b3c4d5e6f`).
  멤버가 실행 중이 아니거나 question 이 비면 `isError` 결과.
- **답 주입:** `question.respond{pendingId, answers}` → pending `answered`(answer = answers) → 그 멤버 입력 큐에 시스템 메시지 `[ANSWER q#<id>]\n<답>` — 답이 하나면 label 만, 여럿이면 `<question>: <label>` 줄마다. 큐 규칙은 다른 자동 타이핑과 같다(idle ∧ 프롬프트 준비 ∧ 사용자 타이핑 아님): 답이 pending 을 먼저 닫으므로 "열린 질문 없음" 게이트가 그 순간 열린다. **질문이 열린 동안 쌓인 항목(`[TASK#n]`, `[RESUMED]`)보다 답이 먼저 들어간다.** 같은 멤버에 열린 질문이 둘이면 둘 다 답해야 흐른다. 턴이 아직 진행 중(`waiting_answer`)에 답하면 status 는 `working` 으로 두고 `Stop` 뒤에 흘린다.
- **만료:** `member.interrupt`/`clockOut`/프로세스 종료는 다른 pending 과 같이 `expired`. 재시작 복구는 `ask_user` 질문을 **열린 채** 둔다(위 "재시작 복구" 3) — 되살린 세션의 `[RESUMED]` 는 답이 올 때까지 큐에 머물고, 답하면 `[ANSWER]` → `[RESUMED]` 순으로 들어간다.

### 도구 목록과 직급 (T25)

| 도구 | 직급 | 인자 | 결과 텍스트 |
|---|---|---|---|
| `hire` | **팀장만** | `{ name, role, engine?: 'claude'\|'codex', instructions? }` | `팀원 <name> (<memberId>) 출근. 엔진 <engine>.` |
| `dismiss` | **팀장만** | `{ memberId }` | `팀원 <name> (<memberId>) 퇴근. 자리가 하나 비었다.` |
| `delegate` | **팀장만** | `{ to_member, task }` | `task#<id> → <name> (assigned\|queued) …` |
| `report` | 전원 | `{ taskId, summary, files?, status: 'done'\|'blocked'\|'aborted' }` | `task#<id> 보고 접수(status=<s>). 팀장/사용자 책상(으)로 올라간다.` |
| `ask_user` | 전원 | `{ question, options? }` | 위 T17 참고 |

**직급은 데몬이 강제한다(01 §TeamTools, D-06). 모델이 주장하는 직급은 보지 않는다 — 요청마다 store 의 `members.rank` 를 다시 읽는다.** T34 에서 rank 값이 `head|lead|member` 로 바뀌었고 위 표의 "팀장만" 은 `rank='lead'` 를 뜻한다 — **부장(head)에게는 아직 `report`/`ask_user` 만 보인다. 직급별 도구 목록(부장 `create_team`/`dismiss_team`/`delegate`/`reply`, 팀원 `ask_parent` …)은 T35 가 확정한다.** 두 겹이다:

1. **도구 목록이 직급별로 다르다.** 팀원의 `tools/list` 에는 `report`·`ask_user` 만 나온다(팀장 전용 도구는 등록되지 않으므로 이름으로 불러도 `-32602 Tool hire not found`). 팀장은 5개 전부.
2. **호출 시점에 한 번 더 본다.** 목록을 받은 뒤 직급이 바뀌거나 멤버가 사라지면 `isError` + 한국어 사유(`hire 실패: hire 는 팀장만 쓸 수 있는 도구입니다. 팀원은 report 와 ask_user 만 쓸 수 있습니다.` / `… 멤버를 찾을 수 없습니다(이미 퇴근했을 수 있습니다).`).

도구가 실패할 때는 **턴을 죽이지 않고** `isError:true` + `"<도구> 실패: <한국어 사유>"` 텍스트를 돌려준다. 사유는 Office 가 던진 오류 문구 그대로다:

- `hire`: `hire 는 팀장만 할 수 있습니다 (<이름> 은(는) 팀원)` / `team <팀> is full (N/M)`(정원) / `팀 <팀> 에서 허용되지 않은 엔진: codex (허용: claude)` / `role 이 비었습니다 …`
- `dismiss`: `사용자가 출근시킨 팀원은 퇴근 버튼으로만 내보낼 수 있습니다 (<이름>)` / `팀장은 dismiss 할 수 없습니다` / `<이름> 은(는) 같은 팀이 아닙니다` / `<이름> 이(가) 아직 working 입니다 — 보고를 기다리거나 먼저 중단시키세요` / `<이름> 에게 미종료 task 가 N건 있습니다 (task#12) — 보고를 기다리세요` / `<이름> 에게 열린 허가·질문이 있습니다 — 먼저 처리하세요`
- `delegate`: `<이름> 은(는) 같은 팀이 아닙니다` / `자기 자신에게는 위임할 수 없습니다` / `팀장에게는 위임할 수 없습니다` / `<이름> 은(는) exited 입니다 — hire 로 새 팀원을 만드세요`
- `report`: `task#<id> 은(는) 당신에게 배정된 작업이 아닙니다 — 받은 [TASK#n] 의 번호로 보고하세요` / `task#<id> 은(는) 이미 보고됐습니다` / `task#<id> 은(는) 중단된 작업입니다` / `task not found: #<id>`

### `hire` (팀장 전용)

`member.clockIn` 과 같은 경로로 CLI 를 띄우되 **`hiredBy:'leader'`**(그래서 팀장이 `dismiss` 할 수 있다), `rank:'member'`, 엔진은 지정하지 않으면 **팀장과 같은 엔진 → `claude` → 팀 허용 목록 첫 번째** 순으로 고른다. 지시문은 `# 역할: <role>` 한 줄로 시작하고 `instructions` 가 있으면 그 아래에 붙는다(`${dataDir}/teams/<teamId>/members/<memberId>/INSTRUCTIONS.md`, 사용자가 앱에서 덮어쓸 수 있다). 정원(`maxMembers`, 팀장도 한 자리)을 넘으면 `isError`. **팀장 자신이 한 일이므로 `[TEAM]` 알림은 가지 않는다.**

### `delegate` (팀장 전용)

1. `tasks(from=<팀장 id>, to=<팀원 id>, status:'queued')` 행 생성.
2. 대상이 **지금 받을 수 있으면**(멤버 status `idle` ∧ 열린 pending 없음 ∧ 프로세스 살아 있음) 그 팀원 입력 큐에 시스템 메시지 `[TASK#<id> from <팀장 이름>(팀장)]\n<task>` 를 넣고 `assigned` 로 바꾼다. 아니면 `queued` 로 남는다.
3. `delegating{tool:'delegate', summary:<task 300자>, to:<memberId>, toName, status:'assigned'|'queued'}` ref `{taskId}` 이벤트(팀장에게 붙는다 — 사무실의 "위임" 표시).
4. **유휴 감시:** `queued` 로 남은 task 는 그 팀원의 status 가 `idle` 이 되는 순간 데몬이 같은 모양으로 전달한다(`member.status` 알림 직후). 같은 task 가 두 번 들어가지 않는다.

### `report` (전원)

`taskId` 는 **그 멤버에게 배정된** task 여야 한다(남의 task 는 `isError`). task 는 `reported` + `report_status` + `report_text`(= `summary`, `files` 가 있으면 `\n파일: a, b` 가 붙는다)가 되고 보고자에게 `reporting{summary, status, files?}` ref `{taskId}` 이벤트가 남는다. 올라가는 곳은 발행자에 따라 다르다.

- **발행자가 사용자**(`tasks.from_member = 'user'`, 즉 `member.instruct` 로 만들어진 task — 보통 팀장이 받는다): 그걸로 끝이다. `reporting` 이벤트 + `report_text` 가 곧 내 책상 "보고"다.
- **발행자가 팀장**(= `delegate` 로 만들어진 task): **버퍼링**한다.
  - `status:'done'|'aborted'` → 팀장별 버퍼에 쌓아 두고, **그 팀장이 발행한 미종료(`queued|assigned`) task 가 0 이 되는 순간** 한 덩어리로 팀장 입력 큐에 넣는다:

    ```
    [REPORTS task#12 하루 status=done]
    A 끝
    파일: a.txt

    [REPORTS task#13 이음 status=done]
    B 끝

    [ALL_REPORTS_IN]
    ```

  - `status:'blocked'` → **버퍼를 건너뛰고 즉시** 단독 전달(`[ALL_REPORTS_IN]` 없음). 팀장이 바로 손을 쓸 수 있어야 하기 때문.
  - 팀장이 이미 나갔으면 전달하지 않고 `daemon.notice{warn}` 만 낸다(보고는 `tasks.report_text` 에 남아 있다).
- **`report` 를 안 부르고 턴만 끝낸 경우**(v1a 보고 승격, 엔진 공통): `Stop` 의 마지막 메시지로 `assigned` task 를 닫는 기존 경로가 **같은 버퍼를 탄다**(`status=done`). 그래서 팀원이 도구를 잊어도 팀장이 `[ALL_REPORTS_IN]` 을 영영 못 받고 굳는 일은 없다. 반대로 `report` 로 이미 닫힌 task 는 `assigned` 가 아니므로 **두 번 보고되지 않는다.**
- **보고를 기다리는 턴 종료는 승격하지 않는다(D-29).** 그 멤버가 `delegate` 로 낸 미종료 task 가 하나라도 있으면 `Stop` 승격을 건너뛴다 — 팀장이 "맡겼고 기다리는 중" 이라고 말하며 턴을 끝낸 것을 완료로 오해해 사용자 task 를 닫아 버리면, 나중의 진짜 `report` 가 "이미 보고됐습니다" 로 거절된다. 그 task 는 `[ALL_REPORTS_IN]` 뒤 턴의 승격이나 `report` 도구가 닫는다.

### 후처리 (T25·T28, 01 §"interrupt / fire / error 공통 후처리")

중단·퇴근·비정상 종료·재시작·팀 삭제·데몬 복구는 **같은 후처리 표**를 탄다(데몬 구현은 `src/office/afterCare.ts` 하나). 이유별로 다른 것은 이 표가 전부다:

| 이유 | 내 `queued\|assigned` task | 열린 허가·질문 | 셸 락 | 내가 발행한 task | 그 task 를 맡은 부하 | MCP 연결 |
|---|---|---|---|---|---|---|
| `member.interrupt` | `aborted` + 발행자에게 즉시 보고 | 전부 `expired` | 해제 | **그대로** | — | 유지 |
| `member.clockOut`(퇴근·`dismiss`) | `aborted` + 즉시 보고 | 전부 `expired` | 해제 | `aborted` | `interrupt` | 끊음 |
| 프로세스 비정상 종료 | `aborted` + 즉시 보고 | 전부 `expired` | 해제 | `aborted` | `interrupt` | 끊음 |
| `team.delete` | `aborted` | 전부 `expired` | 해제 | `aborted` | `interrupt` | 끊음 |
| `member.restart` | **그대로**(같은 세션이 이어서 한다) | 전부 `expired` | 해제 | 그대로 | — | 유지 |
| 데몬 재시작 복구 | 그대로(`assigned` 유지 · `queued` 재큐잉) | 허가 + TUI `AskUserQuestion` 만 `expired`(+ `error{summary:'재지시 필요…', pendingId}`), **`ask_user` 질문은 유지**(D-19) | 해제 | 그대로 | — | 유지 |

- **즉시 보고**란: 발행자에게 버퍼를 건너뛰고 `[REPORTS task#n <이름> status=aborted]\n<이름> 의 작업이 중단됐습니다 (…).` 가 바로 간다. 발행자가 사용자면 대신 `reporting{status:'aborted'}` 이벤트.
- **상위가 나가도 부하 자체는 남는다** — 팀장이 `hire` 한 팀원도 자르지 않는다(퇴근은 사용자 권한). 그 상위의 보고 버퍼는 비운다. T34 부터 이 규칙은 **직급을 가리지 않는다**(부장이 나가면 그가 팀장에게 낸 일이 거둬진다). 하위 트리를 따라 내려가며 정리하는 것은 T36.
- **`department.delete` 는 팀원 → 팀장 → 부장 순(잎부터)** 으로 퇴근시킨 뒤 부서·팀·멤버·task 행을 지운다. 위를 먼저 내보내면 그 후처리가 아래를 interrupt 하고 그 후처리가 다시 위 큐에 보고를 밀어 넣어 왕복만 는다.
- `interrupt` 만 발행 task 를 남긴다: Ctrl+C 는 **그 팀장의 턴**을 끊는 것이지 팀에 내린 지시를 거두는 게 아니다.
- `team.delete` 는 **팀원 먼저, 팀장 마지막** 순으로 퇴근시킨다(팀장을 먼저 내보내면 남은 팀원 중단 → 이미 나가는 팀장에게 보고, 하는 왕복만 는다). 살아 있지 않던 멤버의 MCP 토큰도 끊는다. T34 부터 **task 행은 팀이 아니라 부서 소유**라 팀을 지워도 보고 이력이 남는다.
- 후처리가 실제로 뭔가를 치웠으면(`task` 중단 또는 팀원 중단) `daemon.notice{level:'info', message:'<이름> 후처리(<이유>): task N건 중단, …'}` 이 한 번 나온다.
- 후처리로 파생 상태가 바뀌면(예: 배정 task 가 0 이 되어 `idle → free`) raw `status` 가 그대로여도 `member.status` 가 한 번 더 나간다.

### 사용자 개입 알림 `[TEAM]` (T25, 01 §4 · T34 에서 트리 간선 단위로)

사용자가 누군가를 출근·퇴근시키면(`member.clockIn{force:true}` / `member.clockOut`) **그 멤버의 직속 상사**(팀이 아니라 `parent_id`) 입력 큐에 시스템 메시지가 들어간다:

- `[TEAM] 팀원 변경: +<이름>(<engine>, 역할: <role>)` — `역할` 은 그 팀원 지시문 첫 줄이 `# 역할: …` 일 때만 붙는다.
- `[TEAM] 팀원 변경: -<이름>`

상사가 스스로 부른 `hire`/`dismiss` 에는 알림이 가지 않는다(자기가 한 일이다). 상사가 없는 부장의 출근·퇴근에도 가지 않는다.

## Codex 폴백 (T22)

Codex 멤버에게도 TeamTools MCP 가 붙지만(위 표), 모델이 `ask_user`/`report` 를 **안 부르고 말로만 끝내는** 턴이 있다. 그러면 사무실에서는 아무 일도 일어나지 않으므로, 데몬이 턴 종료(`Stop`)의 `last_assistant_message` 를 보고 두 가지를 승격한다. **Codex 멤버에만** 적용되고 Claude 멤버의 동작은 그대로다.

1. **질문 폴백** — 마지막 줄이 질문처럼 보이면(물음표 `?`/`？` 로 끝나거나 `알려 주세요`·`확인해 주세요`·`어떻게 할까요`·`어느 쪽`·`which`·`should I` 같은 표현) 데몬이 `ask_user` 와 **같은 모양의** pending 을 만든다:
   - pending `question`, payload `{ source:'ask_user', question:<마지막 줄, 300자>, options: [], fallback:'codex-stop' }` — `tool_input` 이 없으므로 D-19 규칙대로 재시작에도 살아남고, 앱의 질문 카드·내 책상 줄서기는 `ask_user` 와 똑같이 그린다.
   - `asking{tool:'ask_user', summary:<질문>, fallback:'codex-stop'}` ref `{questionId}` 이벤트.
   - `member.status` 는 `idle` 그대로(턴은 끝났다), **`derived` 가 `waiting_answer`** — 캐릭터가 내 책상으로 걸어온다.
   - 그 멤버에 이미 열린 질문이 있으면 새로 만들지 않는다(중복 방지).
   - **답 주입이 다르다:** 기다리는 MCP 호출이 없으므로 `question.respond` 는 `[ANSWER q#<id>]` 봉투 없이 **답 본문만** 보통 프롬프트로 넣는다(사용자가 직접 친 것과 같은 모양). 큐 규칙(열린 pending 이 닫히면 흐른다, 답이 먼저)은 `ask_user` 와 같다.
2. **보고 폴백** — 질문이 아니고 그 멤버에 `assigned` task 가 있으면 v1a 보고 경로(`Stop` → `reported`, `report_text` = 마지막 메시지, `reporting{summary}` ref `{taskId}`)가 그대로 돈다. 이 경로는 원래 엔진 공통이라 Codex 가 `report` 도구를 못 불러도 보고가 올라간다.
3. **질문이 보고보다 먼저다.** 질문으로 끝난 턴은 "끝난 작업"이 아니므로 task 는 `assigned` 로 남는다 — 답한 뒤의 턴에서 보고가 닫힌다.

## 재접속 규칙

1. 클라이언트는 마지막으로 적용한 `seq`를 기억한다.
2. `hello{since}` → 스냅샷(`snapshot.seq` 포함) → `seq > snapshot.seq`인 이벤트만 적용(replay 이중 적용 방지).
3. `term`은 replay하지 않는다. 터미널 탭은 `member.attach`로 현재 화면을 다시 받는다.
