# T24 — 팀·직급 모델·출근/퇴근

- 날짜: 2026-09-16
- 마일스톤: M4
- 관련 설계: 01-설계문서.md §4 팀·직급 모델 / 전제 6 / §TeamTools MCP(직급 규칙), 04-결정기록.md D-06
- 커밋: `<hash>` (완료 시)

## 목표

팀에 **직급**이 생긴다. `team.create` 가 팀장을 자동으로 출근시키고(`{ team, leader }`), 사용자 지시는
**팀장에게만** 간다(-32004). 팀장이 나가면 게이트가 열려 팀원에게 직접 지시할 수 있고, `member.clockIn{rank:'leader'}`
로 팀장을 교체할 수 있다. T25(TeamTools `hire`)가 쓸 `hiredBy:'leader'` 경로도 Office 메서드로 미리 열어 둔다.
앱에서는 "팀 만들기"가 팀장을 자동으로 만들고, 상단 바가 선택 멤버의 팀장 배지를 보여준다.

## 한 것

### 데몬

- **`src/store/Store.ts`** — `liveLeader(teamId)` 추가. `rank='leader' ∧ status ∉ {exited,error}` 인 첫 멤버.
  직급 규칙(팀장 중복 금지·지시 게이트)의 **단일 기준**이다. `teams.leader_id` 는 팀장이 나가도 남으므로 그것만으로는
  "살아 있는 팀장" 을 판정할 수 없다.
- **`src/office/types.ts`** — `CreateTeamParams.leaderName?`, 새 `CreateTeamResult{team, leader}`,
  `ClockInParams.rank?`, `HireByLeaderParams`(T25용), `InstructOptions{force?}`.
  `OfficeApi.createTeam` 반환형이 `Team` → `CreateTeamResult` 로, `instruct` 에 `opts?` 가 붙었다.
- **`src/office/Office.ts`**
  - `createTeam()`: 팀 행 → 팀장 멤버(`rank:'leader'`, `hiredBy:'user'`, 이름 `leaderName ?? '팀장'`) → CLI 스폰 →
    `teams.leader_id` 기록 → `{team, leader}`. 팀장 스폰이 실패하면 **팀 행을 되돌린다**(팀장 없는 팀을 남기지 않는다).
    `leaderEngine:'codex'` 도 허용하되 `daemon.notice{warn}`. 새 검증: `allowedEngines` 에 없는 `leaderEngine`, `maxMembers < 1`.
    `ensureStarted()` 가 붙었다(이제 스폰을 하므로).
  - `clockIn()`: `rank` 파라미터. `'leader'` 는 `liveLeader` 가 없을 때만(있으면 -32003), 성공하면 `leader_id` 갱신.
    `hiredBy` 는 그대로 항상 `'user'`.
  - `hireByLeader()`: T25 가 쓸 경로(RPC 아님). `hiredBy:'leader'`, 부르는 쪽이 살아 있는 팀장이 아니면 -32004.
  - `spawnNewMember()`: `clockIn` / `hireByLeader` / `createTeam(팀장)` 이 공유하는 "정원·엔진 검사 + 멤버 행 + 지시문 + 스폰".
    기존 `clockIn` 본문을 그대로 뽑은 것이라 동작은 같다.
  - `instruct()`: **"팀장에게만 지시" 게이트**. 대상이 팀원이고 그 팀에 살아 있는 팀장이 있으면
    `-32004 "팀장에게만 지시할 수 있습니다 (leader: <이름>)"` + `data:{leaderId}`, task 는 만들지 않는다. `opts.force` 로만 넘는다.
  - 상수 `DEFAULT_LEADER_NAME`('팀장') / `leaderOnlyMessage(name)` export — PROTOCOL 문구와 코드가 같은 문자열을 쓴다.
  - `deleteTeam()` 은 손대지 않았다 — 이미 `listMembers(teamId)` 전원을 퇴근시키므로 팀장도 같이 나간다.
- **`src/rpc/RpcServer.ts`** — `team.create` 가 `{team, leader}` 를 그대로 반환(+ `leaderName` 파싱),
  `member.clockIn` 의 `rank`(`optRank`, 값이 다르면 -32602), `member.instruct` 의 `force`(boolean 정규화).
- **`src/cli/index.ts`**(콘솔 클라이언트) — `team create <name> <cwd> [engine] [팀장이름]`, `say` 는 -32004 를
  `오류 [-32004] 팀장에게만 지시할 수 있습니다 (leader: …)` 로 그대로 출력(기존 `printError` 경로), 디버그용 `say!`(= `force:true`).
- **`PROTOCOL.md`** — `team.create`/`team.delete`/`member.clockIn`/`member.instruct` 행 갱신, 에러 코드 설명에 -32004 의
  T24 용법 추가, 새 섹션 **"팀·직급 (T24)"**(rank·hiredBy·leaderId 의 의미, "살아 있는 팀장" 판정 규칙, 지시 대상 규칙).

### 앱 (lib/topbar 만)

- **`lib/topbar/top_bar.dart`**
  - 출근 다이얼로그: **팀장 이름** 필드(`clockIn.leaderName`, hint '팀장'), 안내 문구(`clockIn.leaderHint`)
    "팀을 만들면 팀장이 자동으로 출근합니다. 지시는 팀장에게만 갑니다.".
  - 새 팀일 때 **팀원 이름은 선택** — 비우면 `team.create` 만 부른다(= 팀장만 출근한 빈 사무실, 01 v1b 성공 기준 7).
    기존 팀에 출근할 때는 그대로 필수.
  - `team.create` 응답의 `leader.id` 를 `selectedMemberIdProvider` 로 **바로 선택**한다(지시는 팀장에게만 가므로).
  - 상단 바: 선택 멤버가 `rank:'leader'` 면 이름 앞에 왕관 배지(`topbar.leaderBadge`, 툴팁 "팀장 — 사용자 지시는 팀장에게만 갑니다").
  - `CommandBar` 는 이번 범위 밖(T24b) — 지시 바의 "팀원 선택 시 팀장으로 돌리기/비활성화" 는 아직 없다.

### 테스트

- **`test/office/TeamRank.test.ts`**(신규, 15건) — 팀장 자동 출근/기본 이름/codex 경고/파라미터 검증/스폰 실패 롤백/
  정원 한 자리, 두 번째 팀장 -32003 과 팀장 교체, `hireByLeader` 규칙, 지시 게이트(-32004 문구·data·task 미생성)·`force`·
  팀장 exit 후 해제·다른 팀 무관·`member.type` 무관, `team.delete` 전원 퇴근, 스냅샷 JSON 의 `rank`/`leaderId`.
- **기존 테스트** — `team.create` 가 이제 팀장을 스폰하므로, 팀장이 필요 없는 파일(AskUser/CodexFallback/CodexRouting/
  MixedTeam/Office/ScreenWatch)은 팀을 `store.createTeam` 으로 직접 만들도록 바꿨다(각 파일에 이유 주석). 그 파일들이 보는 것은
  멤버 수명·입력·화면·엔진 라우팅이지 팀 생성이 아니다.
- **`test/rpc/RpcServer.test.ts`** — FakeOffice 의 `createTeam`/`instruct` 시그니처 갱신 + `{team, leader}`·`rank`·`force`
  왕복과 `rank:'boss'` -32602 검증.
- **앱 `test/command/top_bar_test.dart`** — 팀 만들기(팀장 이름 전달 + 팀장 선택), 팀원 이름 빈 경우 `team.create` 만,
  팀장 배지 표시/미표시. `test/command/fake_rpc_client.dart` 의 `fakeTeam`/`fakeMember` 에 `leaderId`/`rank` 인자 추가.

## 검증

### 타입체크 + 전체 스위트

```
$ npx tsc --noEmit
(출력 없음)

$ npx tsx --test "test/**/*.test.ts"
ℹ tests 367
ℹ suites 55
ℹ pass 362
ℹ fail 0
ℹ skipped 5
ℹ duration_ms 34657.6906
```

T24 시작 시점 337건 → T24 15건 + 동시 진행한 T27(셸 뮤텍스) 15건 = 367건.

T24 파일만:

```
$ npx tsx --test "test/office/TeamRank.test.ts"
▶ 팀·직급 모델 (T24)
  ✔ team.create: 팀장이 rank leader / hiredBy user 로 자동 출근하고 teams.leader_id 가 채워진다
  ✔ team.create: leaderName 이 없으면 기본 이름 "팀장"; 공백만 줘도 기본 이름
  ✔ team.create: 팀장 엔진이 codex 여도 허용하되 daemon.notice{warn} 을 낸다 (v1 권장은 claude)
  ✔ team.create: 잘못된 파라미터 — cwd 아님 / 모르는 엔진 / allowedEngines 에 없는 팀장 엔진 / maxMembers<1
  ✔ team.create: 팀장 스폰이 실패하면 팀 행도 되돌린다(팀장 없는 팀을 남기지 않는다)
  ✔ team.create: 팀장도 정원(maxMembers)의 한 자리 — maxMembers:1 이면 팀원 출근이 거절된다
  ✔ member.clockIn{rank:leader}: 살아 있는 팀장이 있으면 -32003, 팀장이 나가면 다시 허용
  ✔ hireByLeader(T25 용): hiredBy leader / rank member, 팀장이 아닌 멤버가 부르면 -32004
  ✔ member.instruct: 살아 있는 팀장이 있으면 팀원 지시는 -32004 (팀장 본인은 통과)
  ✔ member.instruct{force:true}: 게이트를 넘는 디버그 탈출구 — 팀원에게 task 가 생긴다
  ✔ member.instruct: 팀장이 나가면(exited) 팀원 직접 지시가 열린다
  ✔ member.instruct: 게이트는 같은 팀에만 — 팀장 없는 다른 팀의 멤버는 그대로 지시된다
  ✔ member.type(터미널 직접 타이핑)은 게이트와 무관하다 — 그건 "지시"가 아니다
  ✔ team.delete: 팀장·팀원 전원을 퇴근시키고 행을 지운다
  ✔ snapshot JSON: Member.rank 와 Team.leaderId 가 그대로 실린다
✔ 팀·직급 모델 (T24) (139.7857ms)
ℹ tests 15  pass 15  fail 0
```

### 앱

```
$ flutter analyze
No issues found! (ran in 4.0s)

$ flutter test
00:12 +150 ~1: All tests passed!

$ flutter test test/command
00:03 +23: All tests passed!
```

### 실기동 (진짜 `claude` 프로세스)

데몬이 T24 코드보다 오래됐으므로(`startedAt` 2026-09-16T05:42Z) `shutdown` 후 `npx tsx src/index.ts` 로 재기동
(pid 5800, `startedAt` 2026-09-16T06:48:25Z). cwd 는 `dev/spike-0/sandbox`.

**① 팀 생성 → 팀장 자동 출근 (진짜 CLI 가 뜬다)**

```
po> team create t24 D:\myproject\pixel-office\dev\spike-0\sandbox claude 반장
status m_fc3432 → starting (starting)
팀 생성: t_f1cb5a2a4271  t24  D:\myproject\pixel-office\dev\spike-0\sandbox  leader=m_fc343285e241  members=1/4
팀장: m_fc343285e241  반장 [claude] starting  leader team=t24 pid=26576
po> members
m_fc343285e241  반장 [claude] starting  leader team=t24 pid=26576
[wait-idle] 반장 …
status 반장 → idle (free)
```

**② 팀원 출근 → 팀원 직접 지시는 -32004, force 는 통과, 팀장 지시는 통과**

```
po> hire t24 claude 이음
status m_0e3a8a → starting (starting)
출근: m_0e3a8a2ff45b  이음 [claude] starting  member team=t24 pid=21392

po> say 이음 안녕
오류 [-32004] 팀장에게만 지시할 수 있습니다 (leader: 반장) {"leaderId":"m_fc343285e241"}

po> say! 이음 강제 지시다 아무것도 하지 말고 ok 만 답해라
task#23 → 이음 (force)
po> say 반장 한 줄로 인사만 해줘
task#24 → 반장

po> query t24 99999 14
#214 thinking 이음 [TASK#23 from user] ⏎ 강제 지시다 아무것도 하지 말고 ok 만 답해라
#215 thinking 반장 [TASK#24 from user] ⏎ 한 줄로 인사만 해줘
#216 text 반장 안녕하세요! 무엇을 도와드릴까요? 👋
#217 idle 반장
#218 reporting 반장 안녕하세요! 무엇을 도와드릴까요? 👋  task#24
#219 text 이음 ok
#220 idle 이음
#221 reporting 이음 ok  task#23
```

**③ 팀장이 나가면 게이트가 열린다**

```
po> fire 반장
#222 idle 반장 session ended: prompt_input_exit
status 반장 → exited (exited)
#223 idle 반장 clocked out
퇴근: 반장 (m_fc343285e241)
po> say 이음 팀장이 나갔으니 직접 지시다. ok 만 답해라
task#25 → 이음
```

**④ 팀 삭제 → 전원 퇴장**

```
po> team delete t24
#228 idle 이음 session ended: prompt_input_exit
status 이음 → exited (exited)
#229 idle 이음 clocked out
팀 삭제: t24
po> teams
t_9a84d569bd61  demo  …            (T24 팀은 사라짐)
po> members
m_2f4a271d680e  하루 [claude] exited  member team=demo
m_a35f8ef479aa  코덱 [codex] exited  member team=demo
```

데몬 로그에 error/warn 없음.

## 발견한 함정

1. **`team.create` 가 스폰을 하게 되면서 기존 테스트가 통째로 흔들린다.** 팀장 한 명이 `pty.spawns[0]` 을 밀고 정원 한
   자리를 먹으므로, "팀만 필요했던" 테스트들이 전부 깨진다. 팀장 자동 출근을 보는 테스트는 T24 파일 하나로 몰고, 나머지는
   `store.createTeam`(팀장 없는 팀 = 팀장이 나간 상태와 같은 합법적 구성)으로 팀을 만들게 했다.
2. **`teams.leader_id` 만으로는 "팀장이 있다" 를 판정할 수 없다.** 팀장이 exited/error 가 돼도 `leader_id` 는 남는다
   (재고용·이력 때문에 지우지 않는다). 그래서 게이트·중복 검사는 전부 `Store.liveLeader`(rank + status)를 본다.
   PROTOCOL 의 "팀·직급" 섹션에 클라이언트용으로 같은 규칙을 적어 뒀다.
3. **팀장 스폰 실패 시 팀 행이 남는 사고.** 먼저 팀을 만들고 스폰하므로 스폰이 던지면 "팀장 없는 팀"이 남는다 →
   `createTeam` 에서 잡아 `deleteTeam` 으로 되돌린다. 테스트로 고정했다.
4. **선택 멤버 provider 가 `lib/main.dart` 에 있다.** 팀 생성 직후 팀장을 고르려면 `top_bar.dart` 가 그걸 써야 해서
   `import '../main.dart' show selectedMemberIdProvider;` 로 순환 import 를 만들었다(Dart 는 허용, analyze 통과).
   provider 를 `lib/state/` 로 옮기는 정리는 T24b.
5. **동시 작업(T27 셸 뮤텍스)과 같은 파일.** `src/office/Office.ts` 를 T27 이 다른 구역(toolGate/PreToolUse)에서 같이
   고치고 있었다. 작은 치환 편집만 쓰고 편집마다 다시 읽었다. 중간에 `MixedTeam.test.ts` 가 빨갛게 보였는데, HEAD 를
   worktree 로 떠서 T24 테스트 수정만 얹어 돌려 보니 10/10 통과 → T27 의 `PreToolUse` 이벤트 순서 변경 때문이었고
   T27 이 마무리하자 367건 전부 초록이 됐다. **남의 실패를 내 실패로 착각하지 않으려면 HEAD worktree 재현이 제일 싸다.**

## 결정

이 태스크의 결정은 04-결정기록.md 편집 권한 밖이라 여기에 적는다(필요하면 D-## 로 옮길 것):

- **`team.create` 결과를 `{team, leader}` 로.** `team` 만 돌려주고 클라이언트가 스냅샷에서 팀장을 찾게 하는 대안은,
  팀장 선택·"팀장에게만 지시" 안내를 만드는 쪽이 한 번 더 왕복해야 해서 버렸다. PROTOCOL 초안에 이미 이 모양이 적혀 있었다.
- **게이트 기준은 "살아 있는 팀장"(`rank` + `status`)이지 `leader_id` 가 아니다.** 팀장이 죽었는데 사용자가 아무에게도
  지시할 수 없는 상태를 만들지 않기 위해서다(01 §4 의 "사용자 개입" 정신).
- **`force` 는 프로토콜에 남기되 앱은 안 쓴다.** 콘솔(`say!`)과 디버깅용. 문서에 "디버그 탈출구" 라고 못 박았다.
- **팀장 엔진 codex 는 막지 않고 경고만.** 01 §TeamTools 는 "v1 팀장 엔진은 Claude 고정(Codex MCP 주입 검증 후 해제)"
  이지만 T22 에서 Codex MCP 주입이 확인됐으므로, 막는 대신 `daemon.notice{warn}` 로 낮췄다.
- **`hiredBy:'leader'` 는 RPC 로 열지 않는다.** 사용자는 항상 `'user'` 로 출근시킨다(그래야 팀장이 못 자른다).
  팀장 경로는 T25 의 TeamTools `hire` 만 쓰도록 Office 메서드(`hireByLeader`)로만 노출했다.

## 남은 것

- **T24b(앱):** `CommandBar` 가 팀원 선택 시 지시 대상을 팀장으로 돌리거나 비활성화 + -32004 안내. 이번 범위에서 제외됨
  (다른 에이전트가 `lib/panel/**` 를 만지고 있었고 `lib/command/**` 는 범위 밖). `selectedMemberIdProvider` 를
  `lib/state/` 로 이전.
- **문·애니메이션:** 03 의 T24 행에 있는 "문 입장/퇴장 애니메이션" 은 `lib/office/**`(범위 밖) — 미구현.
- **콘솔 `hire` 의 rank 옵션:** 팀장 교체(`clockIn{rank:'leader'}`)는 단위 테스트로만 확인했고 실기동에서는 안 해 봤다.
- **통합 테스트(`PIXEL_IT=1`)** 4개는 `team.create` 뒤에 `clockIn` 을 하므로 이제 팀장까지 3명이 뜬다. 기본 실행에서
  skip 이라 그대로 뒀다 — 다음에 IT 를 돌릴 때 정원·시간 확인 필요.
- **04-결정기록.md** 에 위 "결정" 을 D-## 로 옮기기(편집 권한 밖이었다).
