# T34 — 데이터 모델·RPC 트리화 (직무 체계 rev 3)

- 날짜: 2026-09-16
- 마일스톤: M4b
- 관련 설계: 01-설계문서.md §"직무 체계 rev 3 (2026-09-16, D-32)" · 04-결정기록.md D-32 / **D-33** / **D-34**
- 커밋: `<hash>` (완료 시)

## 목표

데몬의 뼈대를 2단(팀 → 팀장 → 팀원)에서 **3단 트리(부서 → 부장 → 팀장 → 팀원)** 로 옮긴다. 이 태스크가 끝나면
사용자는 `department.create` 하나로 부서(=프로젝트 cwd)를 만들고 부장만 임명하며, 그 아래는 전부 멤버가 멤버를 만든다.
지시는 부장에게만 가고(-32004), 부서를 지우면 하위 트리 전체가 잎부터 정리된다. T35(직급별 도구)·T36(후처리·복구
트리화)·T37(앱 트리 UI)이 올라탈 스키마·Store API·RPC·Office API가 여기서 확정된다.

## 한 것

### 1. 스키마 v2 + v1 마이그레이션 (`src/store/schema.ts`, `src/store/Store.ts`)

새 표 `departments(id, name, cwd, head_id, created_at)`. 나머지 표의 변화:

| 표 | 변화 |
|---|---|
| `teams` | `department_id NOT NULL REFERENCES departments ON DELETE CASCADE` 추가. `cwd`(= 부서 cwd)·`leader_id` 유지 |
| `members` | `department_id NOT NULL`(cascade) · `parent_id NULL REFERENCES members ON DELETE SET NULL` 추가, **`team_id` 를 nullable 로**(부장은 부서 직속), `rank CHECK IN ('head','lead','member')` |
| `tasks` | `team_id` → **`department_id`**(부서 FK, cascade). 팀 없는 부장도 사용자 task 를 받는다 (D-33) |
| `events` | `department_id` 추가(기본 `''`). `team_id` 는 남기되 팀 없는 부장은 `''`. `pruneEvents` 파티션도 부서로 |
| `pending` | 그대로 |

**v1 → v2 마이그레이션**(`Store.migrate()`): CHECK 제약과 NOT NULL/FK 가 바뀌어 ALTER 로는 안 되므로
`teams`/`members`/`tasks` 를 통째로 다시 만든다 — ① `*_v1` 으로 rename(+ v1 인덱스 제거, `events` 에 컬럼 추가)
→ ② `SCHEMA_SQL` 로 v2 테이블 생성 → ③ 한 트랜잭션으로 복사 → ④ `*_v1` drop. FK 는 그동안만 `PRAGMA foreign_keys = OFF`.

복사 규칙(**개발 DB 한 개를 위한 것**이라 단순·충실하게):

- **팀 하나 = 부서 하나.** 이름·cwd·`created_at` 을 그대로 물려받는다.
- 그 팀의 **팀장(rank `'leader'`)이 부장(`'head'`)** 이 되고 `departments.head_id` 가 된다.
- **옛 팀 행은 그 부서의 팀으로 남고** `teams.leader_id` 도 그 부장을 가리킨다 — 즉 *부장이 레거시 팀의 팀장을 겸한다.*
  (2단 데이터에는 팀장 역할이 하나뿐이라 새 인격을 지어내지 않는 쪽을 골랐다.)
- 옛 팀원은 rank `'member'` + `parent_id` = 그 부장. 팀장이 없던 팀의 팀원은 `parent_id null`(콘솔 `tree` 의 "부모 없는 멤버").
- `tasks`·`events` 는 그 부서 id 를 받고 **행이 사라지지 않는다**(id·seq 도 그대로 — AUTOINCREMENT 되감김 없음).

### 2. 타입·Store API (`src/store/types.ts`, `src/store/Store.ts`)

- `Department { id, name, cwd, headId, createdAt }` / `Team.departmentId` / `Member.rank: 'head'|'lead'|'member'` ·
  `Member.departmentId` · `Member.teamId: string | null` · `Member.parentId: string | null` /
  `Task.departmentId` / `OfficeEvent.departmentId` / `Snapshot.departments`.
- `CHILD_RANK = { head:'lead', lead:'member', member:undefined }` — 고용 사슬의 단일 출처.
- Store: `createDepartment/getDepartment/listDepartments/updateDepartment/deleteDepartment`(teams+members+tasks cascade),
  `liveHead(departmentId)`, `liveLead(teamId)`, **`liveLeader` 는 `liveLead` 별칭으로 유지**(T24 호출부 churn 최소화),
  `childrenOf(memberId)`(살아 있는 자식만), `parentOf`, `subtreeOf`(깊이 우선·순환 안전·나간 행 포함),
  `listTeams(departmentId?)`, `listDepartmentMembers(departmentId)`, `listTasks({departmentId})`,
  `eventsQuery({departmentId})`.

### 3. RPC (`src/rpc/RpcServer.ts`, `PROTOCOL.md`)

| method | 상태 |
|---|---|
| `department.create{name, cwd, headEngine, headName?}` → `{department, head}` | **신규.** 사용자가 하는 유일한 생성 |
| `department.delete{departmentId}` | **신규.** 하위 트리 잎부터 정리 후 삭제 |
| `department.tree{}` → `{departments:[{department, head?, teams:[{team, lead?, members}], orphans}]}` | **신규.** 읽기 전용(콘솔 `tree`·T37) |
| `team.create{departmentId, name, leadEngine?, leadName?, …, force:true}` → `{team, lead}` | **디버그 전용**(force 없으면 -32004). `cwd` 파라미터 없어짐(부서 cwd) |
| `member.clockIn{parentId?, departmentId?, teamId?, rank?, …, force:true}` | **디버그 전용**(force 없으면 -32004) |
| `member.clockOut{memberId}` | 그대로 — **누구든 내보낼 수 있는 비상구**로 문서화(D-34) |
| `member.instruct` | 게이트가 "팀장에게만" → **"부장에게만"**. `-32004 "부장에게만 지시할 수 있습니다 (head: <이름>)"`, `data:{headId}`. 범위는 팀이 아니라 **부서** |
| `hello` 스냅샷 | `departments[]` 추가. 멤버 행에 `departmentId/teamId/parentId/rank` |
| `events.query` | `departmentId?` 추가 |

### 4. Office (`src/office/Office.ts`)

- `createDepartment` / `deleteDepartment` / `tree()` 추가. `createTeam` 은 `{departmentId, …}` → `{team, lead}` 로.
- **`hireChild({parentId?, departmentId?, teamId?, name, rank, engine, instructions?, role?, hiredBy?})` 가 트리의 단일 스폰 경로**다.
  `department.create`(부장) · `createTeam`(팀장) · `hire`(팀원)가 전부 여기로 들어오고, 직급 사슬(head→lead→member)과
  부장/팀장 중복, 팀 정원(`maxMembers`, 팀장도 한 자리)을 이 한 곳에서 강제한다. `role` 을 주면 `# 역할: <role>` 지시문이 붙는다.
- `hireByLeader`(T25)는 `hireChild({parentId, rank:'member'})` 의 얇은 래퍼로 남겼다 — T35가 도구를 다시 겨냥할 때까지.
- `clockIn` 은 두 갈래(D-34): `parentId` 를 주면 `hireChild`(사슬 검사 그대로), 안 주면 부서·팀에 바로 꽂는 디버그 경로
  (살아 있는 상사가 있으면 자동으로 그 아래로).
- `[TEAM]` 알림이 "팀장에게" → **"직속 상사에게"**(`notifyTeamChange` → `notifyParent`, `parent_id` 기준).
- 셸 락 키가 `member.teamId` → **`member.departmentId`**(D-33).
- 이벤트에 `departmentId` 를 싣는다(`Office.appendEvent`, `BaseHooksAdapter.appendEvent`).
- 지시문 경로는 `teams/<teamId 또는 departmentId>/members/<memberId>/INSTRUCTIONS.md` — 접두사를 그대로 둬 기존 파일이 살아 있다.

### 5. 파생 상태·후처리 (`src/office/derived.ts`, `src/office/afterCare.ts`)

- `waiting_reports` 에서 **rank 검사를 뺐다** — "raw idle + 내가 낸 미종료 task 가 있다" 면 직급 무관(부장도 팀장도).
  `free` 는 그대로 "잎이 한가함".
- `settleMember` 의 ②단계(`발행 task abort + 대상 interrupt`)에서도 rank 검사를 뺐다. SETTLE_MATRIX 표 자체는 그대로다.
  **하위 트리를 따라 내려가는 정리는 T36** — 여기서는 "부장이 나가면 그가 팀장에게 낸 일이 거둬지고 그 팀장이 interrupt 된다"
  까지만(부하 행은 남는다).
- `deleteDepartment` 는 `settleOrder`(팀원 → 팀장 → 부장)로 잎부터 퇴근시킨 뒤 행을 지운다. `deleteTeam` 도 같은 순서.

### 6. 지시문 (`src/office/instructions/context.ts`, `templates.ts`) — T35가 확정할 최소 수정

- `RANK_LABEL = { head:'부장', lead:'팀장', member:'팀원' }`. 템플릿 범위가 `Team` → `TemplateScope{name,cwd,maxMembers,allowedEngines}`
  (팀이 있으면 팀, 팀 없는 부장은 부서). `headTemplate` 추가.
- 프리앰블이 **직급 + 상사 + 직속 부하**를 싣는다. **로스터가 팀 전체 → 직속 부하만**으로 바뀐 것이 핵심이다
  (D-32: 말을 걸 수 있는 상대가 상사 하나와 직속 부하들뿐인데 팀 전체를 보여 주면 없는 권한을 착각한다).

  ```
  [사무실] 너는 픽셀 오피스 부서 "alpha" 의 팀 "t1" 의 팀원 이음(엔진 claude)이다.
  - 직급: 팀원 (부장 → 팀장 → 팀원; 지시·고용은 바로 아래로만, 보고·질문은 바로 위로만)
  - 작업 폴더: …
  - 상사: 반장(팀장) — 보고·질문은 여기로만 올린다.
  - 직속 부하: (없음)
  - 도구 이름: mcp__team__report, mcp__team__ask_user (도구 목록에 없으면 ToolSearch로 찾는다).
  ```

### 7. MCP·콘솔

- `src/mcp/TeamToolsServer.ts`: `TeamToolRank` 가 `'head'|'lead'|'member'`, 팀장 전용 게이트가 `rank === 'lead'`.
  **부장에게는 아직 `report`/`ask_user` 만 보인다** — 직급별 도구 목록은 T35.
- 콘솔(`src/cli/`): `depts`, `dept create <name> <cwd> [engine] [부장이름]`, `dept delete <dept>`, `tree`(부서 → 부장 → 팀/팀장 → 팀원).
  `team create` 는 `<dept> <name>` 을 받고 `force:true` 를 붙인다. `hire <parent> <engine> <name>` 도 `force:true`.
  `query <부서>`, 멤버 줄에 직급 한글 라벨.

### 8. 테스트

- 신규: `test/store/Migration.test.ts`(v1 파일을 직접 만들어 놓고 여는 4건), `test/office/Tree.test.ts`(트리 동작 7건).
- 갱신: `Store`(부서·트리 질의·cascade), `TeamRank`(부서 생성·사슬·게이트·삭제·스냅샷·tree), `Instructions`(프리앰블 3종),
  `RpcServer`(FakeOffice + 새 메서드·force 게이트), `AfterCare`/`TeamTools`/`Recovery`/`ShellMutex`/`Office`/`AskUser`/
  `CodexFallback`/`CodexRouting`/`MixedTeam`/`ScreenWatch`/어댑터/CLI/MCP.
- **의도적으로 바뀐 기대값**(설계상 없어진 동작):
  - `member.clockIn` 은 이제 `force:true` 없이는 -32004 → RpcServer.test 가 두 경우를 모두 본다.
  - "팀장에게만 지시" 문구·코드가 "부장에게만 지시(head)" 로 → TeamRank.test.
  - `team.delete` 가 더는 tasks 를 지우지 않는다(부서 소유) → Store.test 가 "남는다" 를 단언하고 `deleteDepartment` 가 지우는 것을 이어서 본다.
  - 셸 뮤텍스의 "다른 팀은 서로 막지 않는다" → "다른 **부서**는 서로 막지 않는다"(같은 부서의 다른 팀은 막는다는 새 테스트를 Tree.test 에 추가).
  - 지시문 프리앰블의 `rosterLines`(팀 전체) → `childrenLine`/`parentLine`(직속만).

## 검증

```
$ npx tsc --noEmit
(출력 없음)

$ npx tsx --test "test/**/*.test.ts"
ℹ tests 431
ℹ suites 60
ℹ pass 425
ℹ fail 0
ℹ skipped 6          (T34 이전 413 → 431; skip 6건은 기존 실기 전용)
```

실기(데몬 재시작 + 콘솔). 먼저 돌던 데몬(pid 18928, v1 DB)을 `shutdown` 하고 새 코드로 다시 띄웠다 — 기동 때
v1(events 414행) → v2 마이그레이션이 한 번에 돌았다.

```
$ node -e "... SELECT version FROM schema_version"     # 종료 직후
version {"version":1}   events 414

$ npx tsx src/index.ts &                                # 새 코드로 기동 (pid 27860)
[daemon] listening
$ node -e "... SELECT version FROM schema_version"
version {"version":2}
departments 0  teams 0  members 0  tasks 0  events 414   ← 이력 보존
```

```
po> dept create d34 D:/myproject/pixel-office/dev/daemon claude 부장
status m_3d61e1 → starting (starting)
부서 생성: d_58364fe94d9e  d34  D:\myproject\pixel-office\dev\daemon  head=m_3d61e19c1660  팀 0개  멤버 1명
부장: m_3d61e19c1660  부장 [claude] starting  부장(head) @d34 pid=20680
[daemon:info] 부장: passed first-run dialog (trust-folder-claude)
status 부장 → idle (free)

po> tree
d34 (d_58364fe94d9e)  D:\myproject\pixel-office\dev\daemon
  └ 부장 부장 [claude] free (m_3d61e19c1660)
     ├ (팀 없음)

po> say 부장 당신의 직급과 상사, 직속 부하를 한 줄로 답하라. 도구는 쓰지 마라.
task#1 → 부장
#416 thinking 부장 [TASK#1 from user] ⏎ 당신의 직급과 상사, 직속 부하를 한 줄로 답하라. …
#417 text 부장 나는 부서 d34의 부장이고, 상사는 사용자(사람)이며, 직속 부하(팀장)는 아직 없습니다.
#418 idle 부장
[wait-idle] 부장 idle (event)          ← 프리앰블의 직급·상사·직속 부하가 실제로 먹혔다

po> team create d34 t1 claude 반장
팀 생성: t_6efb22f5fff5  t1  dept=d_58364fe94d9e  D:\myproject\pixel-office\dev\daemon  lead=m_88d14e3176c8  members=1/4
팀장: m_88d14e3176c8  반장 [claude] starting  팀장(lead) @t1 pid=26672
status 반장 → idle (free)

po> tree
d34 (d_58364fe94d9e)  D:\myproject\pixel-office\dev\daemon
  └ 부장 부장 [claude] free (m_3d61e19c1660)
     ├ 팀 t1 (t_6efb22f5fff5)  정원 1/4
     │  └ 팀장 반장 [claude] free (m_88d14e3176c8)

po> say 반장 안녕
오류 [-32004] 부장에게만 지시할 수 있습니다 (head: 부장) {"headId":"m_3d61e19c1660"}

po> dept delete d34
#420 idle 반장 session ended: prompt_input_exit      ← 팀장 먼저
status 반장 → exited (exited)
#422 idle 부장 session ended: prompt_input_exit      ← 부장 마지막
status 부장 → exited (exited)
부서 삭제: d34
po> depts
(부서 없음)
po> members
(멤버 없음)
po> teams
(팀 없음)
```

## 발견한 함정

1. **빈 폴더에서 Claude CLI 가 신뢰 다이얼로그 통과 직후 exit 1.** 첫 시도에서 `dev/sandbox-t34`(그때 막 만든 빈 폴더)에
   부서를 만들었더니 `passed first-run dialog (trust-folder-claude)` 뒤에 `error 부장 process exited (code 1)`.
   같은 명령을 이미 쓰던 폴더(`dev/daemon`)로 하면 정상. T34 범위 밖이라 파고들지 않았지만 **T39 시연 전에 재현·확인 필요**
   (신뢰 다이얼로그의 선택지 순서가 폴더 상태에 따라 다를 가능성 — ScreenModel 의 `trust-folder-claude` 맵 확인).
2. **SQLite 테이블 재작성의 인덱스 이름.** `ALTER TABLE … RENAME TO x_v1` 은 인덱스를 따라 옮기므로 이름이 그대로 점유된다.
   그 상태에서 `CREATE INDEX IF NOT EXISTS` 를 돌리면 조용히 no-op 이 되고, `x_v1` 을 drop 할 때 인덱스도 같이 사라져
   **새 테이블이 인덱스 없이 남는다.** rename 전에 옛 인덱스를 `DROP INDEX IF EXISTS` 로 먼저 지운다(`V1_RENAME_SQL`).
3. **연속 두 항목의 입력 큐 지연.** `[TEAM] +…` 뒤에 `[TEAM] -…` 이 붙는 시나리오는 `enterDelayMs(300) + busyAfterFlushMs(1500)`
   때문에 700ms 로는 안 나온다. Tree.test 는 `SECOND_FLUSH_MS = 2400` 을 쓴다.
4. **MCP `dispose` 는 여러 번 불린다**(clockOut 의 settle + disposeRuntime). 토큰 정리를 단언할 때는 집합으로 비교해야 한다.

## 결정

- D-33 · 트리 스키마의 소유 관계: task·event·셸 락은 **부서** 소유, 부장은 팀에 속하지 않는다.
- D-34 · 없어진 사용자 기능은 지우지 않고 `force:true` 뒤로 숨긴다.

## 남은 것

- **T35**: 직급별 도구 목록(부장 `create_team`/`dismiss_team`/`delegate`/`reply`/`report`/`ask_user`, 팀장 기존 5개 + `ask_parent`,
  팀원 `report`/`ask_parent`). 지금은 부장에게 `report`/`ask_user` 만 보이고 `create_team` 은 디버그 RPC 로만 가능하다.
  지시문 템플릿 3종의 문장·도구 줄도 T35에서 확정(여기서는 직급 라벨·상사 줄·부장 템플릿만 최소로 넣었다).
- **T36**: 후처리의 하위 트리 정리(부모 퇴근 → `subtreeOf` 를 뒤에서부터 잎부터 clockOut), 복구 순서(부장 → 팀장 → 팀원),
  `SETTLE_MATRIX` 에 head/lead 행. `Store.subtreeOf` 가 그 입력으로 준비돼 있다.
- **T37**: 앱이 아직 2단 스냅샷을 가정한다(`teams[]` 만 읽고 `rank:'leader'` 를 본다) — 부서 탭·부장 임명 다이얼로그와 함께 교체.
- **T38**: README·02 체크리스트에 없어진 기능(사용자 팀원 출퇴근) 표시.
- 빈 폴더 신뢰 다이얼로그 함정(위 ①) 재현 확인.
