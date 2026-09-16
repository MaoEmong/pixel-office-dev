# T38 — 콘솔·문서 정리 + 삭제 후 스냅샷 푸시

- 날짜: 2026-09-16
- 마일스톤: M4b
- 관련 설계: 01-설계문서.md §"직무 체계 rev 3 (2026-09-16, D-32)" · 04-결정기록.md D-32 / D-33 / D-34 / D-35 / D-36 / D-37 · dev/daemon/PROTOCOL.md
- 커밋: `<hash>` (완료 시)

## 목표

T34~T37 이 트리로 옮겨 놓은 데몬·앱을 **밖에서 보는 두 면**에서 마무리한다 — ① 다른 클라이언트가 지운 부서·팀이 화면에
유령으로 남던 것(T37 함정 ①)을 데몬이 `snapshot` 을 밀어 해소하고, ② 콘솔과 README·체크리스트에 남아 있던 2단(팀 → 팀장 →
팀원) 시절 문구를 rev 3 로 바꾼다. 이 태스크가 끝나면 콘솔만 보고도 rev 3 의 규칙(사용자는 부서만 만든다 · 지시는 부장에게만 ·
없어진 기능은 디버그 절에 `force` 로)을 알 수 있고, 창을 두 개 띄워도 서로의 삭제가 즉시 반영된다. 남은 것은 T39 시연뿐이다.

## 한 것

### 1. 트리가 바뀌면 스냅샷을 민다 (`src/office/Office.ts`, `src/office/types.ts`, `src/rpc/RpcServer.ts`)

멤버 행의 생멸은 `member.status{member}` 가 알리지만 **부서·팀 행의 생멸을 알리는 알림이 없었다.** 그래서 콘솔에서
`dept delete` 를 하면 앱에는 부서 탭과 회색 책상이 재접속할 때까지 남았다(T37 함정 ①, 그 태스크에서 데몬은 범위 밖이었다).

- `OfficeEvents` 에 **`tree: [reason]`** 추가(`'department.create' | 'department.delete' | 'team.create' | 'team.delete'`).
  Office 가 `createDepartment` / `deleteDepartment` / `createTeam` / `deleteTeam` 의 **행 확정 직후**에 낸다.
  RPC 네 개뿐 아니라 **부장의 `create_team` · `dismiss_team` 도구**(T35)도 이 네 메서드를 지나므로 같이 덮인다 —
  RpcServer 핸들러마다 따로 붙였다면 MCP 경로가 새는 구멍이 생긴다.
- `RpcServer` 는 `tree` 를 구독해 **`setImmediate` 로** 전 클라이언트에 `snapshot` 알림을 보낸다(`pushSnapshot`).
  미루는 이유는 순서다 — 요청한 클라이언트가 **응답을 먼저** 받고 그다음에 스냅샷을 받는다. 종료 중이거나 클라이언트가
  없으면 조용히 넘어간다.
- 앱은 **손댈 것이 없었다.** `_onNotification` 의 `snapshot` 가지가 이미 `hello` 와 같은 `_applySnapshot` 을 부른다 —
  departments/teams/members/pending/tasks 를 통째로 교체하고 이벤트 링버퍼·말풍선은 유지한다. 그 동등성을 테스트로 고정했다
  (아래 검증). 콘솔도 이미 `[snapshot] seq=… 갱신` 으로 받고 있었다.
- PROTOCOL.md: `snapshot` 알림 행에 **미는 시점**(네 RPC + `create_team`/`dismiss_team`)과 "hello 스냅샷과 똑같이 적용하라"
  를 명시. 네 메서드 행에도 한 줄씩. "재접속 규칙" 에 4번 추가.

### 2. 콘솔 rev 3 (`src/cli/help.ts` 신규, `src/cli/index.ts`, `src/cli/format.ts`)

- **도움말을 트리 순서 8개 절로 재편**했다(`help.ts` 의 `HELP`): 부서·트리 → 지시·터미널 → 내 책상 → 일·이벤트 → 지시문 →
  멤버 → **디버그** → 연결. `index.ts` 가 import 되는 순간 `main()` 이 도는 구조라 도움말을 별도 모듈로 뺐다(테스트 가능해졌다).
  `treeLines` 도 같은 이유로 `format.ts` 로 옮겼다.
- 문구를 rev 3 로: `say` 는 "부장에게 지시 → 팀장·팀원이면 -32004", `pending`/`answer` 는 `ask_parent` 의 from→to 와
  "상사가 굳었을 때의 오버라이드"(D-37), `tasks` 는 `발행자→대상·상태·보고`, `query` 는 `<부서|->`,
  `dept delete`·`fire` 는 **하위 트리 전원이 잎부터 정리된다**는 파급, `restart` 는 열린 `ask_*` 질문이 살아남는 것(D-36).
  `team create`/`team delete`/`hire`/`say!` 는 **디버그 절**로 모으고 정식 경로(부장의 `create_team`·`dismiss_team`,
  팀장의 `hire`)를 같이 적었다.
- **`fire` 에 확인 프롬프트**를 달았다(D-34 의 "비상구" 를 UI 로도). 대화형에서 `fire <member>` 는
  `비상 퇴근: 부장 부장B (m_…) — 하위 N명(부서 전원)도 함께 정리됩니다` 를 찍고 `y` 를 받아야 진행한다(그 밖의 입력·Ctrl+C 는 취소).
  하위 인원수는 로컬 멤버 맵의 `parentId` 를 타고 세고, **`--exec` 비대화 모드는 프롬프트 없이 진행**한다(스크립트가 이미 적어 보낸 명령이다).
  확인 상태(`Confirm`)는 여러 줄 입력(`MultiLine`)과 같은 자리에서 REPL 이 먹는다.
- 죽은 2단 주석 정리: `say` 위의 "팀장이 있는 팀에서 …(leader: …)" → 부장 게이트 설명으로. 파일 머리말도 rev 3 로.
  같은 문구가 남아 있던 `Office.instruct` 의 doc 주석과 `RpcServer.test.ts` 의 `force` 주석도 "부장에게만 지시(T34, D-32)" 로 고쳤다
  (코드 동작은 이미 rev 3 였고 설명만 T24 시절이었다). `docs/01-설계문서.md` 의 전제 6은 **고치지 않는다** — 설계문서는 덧붙이는 규칙이라
  rev 3 는 01 의 §"직무 체계 rev 3" 와 D-32 에 있다.

### 3. 문서

| 파일 | 한 것 |
|---|---|
| `dev/daemon/README.md` | 머리말에 M4b 한 줄. 콘솔 명령 목록을 **절 표**로 교체. **"직무 체계 rev 3" 절 신설** — 트리 그림, 직급별 도구 표(`RANK_TOOLS` 단일 출처), 두 겹 강제·대상 규칙, **봉투 표**(`[TASK#n from X(직급)]`·`[REPORTS…][ALL_REPORTS_IN]`·`[QUESTION/ANSWER]`·`[MESSAGE]`·`[TEAM]`·`[RESUMED]`), 후처리·복구 요약 + PROTOCOL 포인터, **스냅샷 푸시**, 디버그 전용 RPC, "T39 시연·Codex 는 9/21 이후" 포인터. "Codex 팀원(M3)" → "Codex 멤버(M3)"(엔진 문서인데 직급 이름과 겹쳤다). 구조 트리(office/mcp/store/cli) 갱신 |
| `dev/app/README.md` | 머리말을 "골격만 있다"(T11) → 현재 rev 3 요약으로. 구조 트리에 `office/`·`panel/`·`command/`·`topbar/` 와 테스트 폴더 추가. **밀려온 `snapshot` 을 `hello` 와 같은 경로로 적용한다**는 문단 추가 |
| `docs/README.md` | 한 줄 요약을 트리로 다시 씀(부서·부장·팀장·팀원, 지시는 부장에게만). 결정 이력에 **2026-09-16 rev 3 (D-32)** + 딸린 D-33~D-37. 01 행에 §"직무 체계 rev 3" |
| `docs/02-실측-체크리스트.md` | **"rev 3 (2026-09-16)" 절 신설** — 없어진 사용자 기능 표(팀원 직접 출근·팀 직접 생성·팀원 직접 퇴근·팀장에게 직접 지시)와 지금의 경로·남은 디버그 길. + **신뢰 다이얼로그 정정**(①의 "↓+Enter" 는 붙여 보내면 안 된다, T36)과 재현 로그 포인터. ① 항목에서 그 절로 가는 포인터 |
| `docs/03-작업계획.md` | T38 체크 |

## 검증

### 단위·통합 테스트

```
$ cd dev/daemon && npx tsc --noEmit
TYPECHECK OK            (출력 없음)

$ npx tsx --test "test/**/*.test.ts"
ℹ tests 479
ℹ suites 66
ℹ pass 472
ℹ fail 0
ℹ skipped 7             (T38 이전 471 → 479)

$ cd dev/app && flutter analyze
No issues found! (ran in 2.9s)

$ flutter test
00:11 +192 ~1: All tests passed!        (T38 이전 191 → 192)
```

새 테스트 — 데몬 8건(471 → 479) + 앱 1건(191 → 192):

- `test/rpc/RpcServer.test.ts` — "snapshot push: 트리가 바뀌면(부서·팀 생성/삭제) 전 클라이언트에 snapshot 알림 — 응답이 먼저다".
  가짜 Office 가 실제 Office 와 **같은 자리에서** `tree` 를 낸다. 단언: 내용이 `office.snapshot()` 과 같고, 요청한 클라이언트의
  수신 순서가 `['result', 'snapshot']` 이고, 인증 안 된 소켓에는 안 가고, 네 번의 변경에 네 번(양쪽 클라이언트 모두), **실패한 호출
  (없는 부서 삭제·force 없는 team.create)에는 0번**.
- `test/office/Tree.test.ts` — "'tree' 이벤트: 부서·팀 생성/삭제에서만 나온다(고용·퇴근은 아니다)". 고용·퇴근은 `member.status`
  담당이라 트리 알림을 내지 않는다는 것까지 고정.
- `test/cli/help.test.ts`(6) — 절 구성·rev 3 명령 존재·디버그 절이 `force` 를 밝히는지 · **없어진 2단 문구가 남아 있지 않은지**
  (`팀장에게만`, `team create <name> <cwd>`, `hire <team>`, `query <team`) · `helpLines` 모양 · `treeLines` 두 케이스.
- `dev/app/test/office_state_test.dart` — "T38: 밀려온 snapshot 알림 = hello 스냅샷 — 없어진 부서·팀·멤버·pending·task 가
  지워지고 이벤트 링은 남는다". **재접속 없이**(`helloParams.length == 1`) 적용되는 것까지 단언한다.

### 실기 — 데몬 재시작 + 콘솔 두 개

돌던 데몬(pid 27860, T34 빌드)을 콘솔로 `shutdown` 하고 새 코드로 다시 띄웠다(pid 28024). 클라이언트 **B**(구경만 하는 REPL,
파이프 입력으로 20초마다 `depts`)를 먼저 붙여 두고 **A**(`--exec`)로 조작했다.

**A — 부서 생성 → tree:**

```
po> dept create d38 D:/myproject/pixel-office/dev/daemon claude 부장38
status m_aa000f → starting (starting)
부서 생성: d_96ab7a2f16e6  d38  D:\myproject\pixel-office\dev\daemon  head=m_aa000f3d34b9  팀 0개  멤버 1명
부장: m_aa000f3d34b9  부장38 [claude] starting  부장(head) @d38 pid=29664
po> tree
[snapshot] seq=427 갱신                      ← 자기 요청의 응답 뒤에 푸시가 도착한다
d38 (d_96ab7a2f16e6)  D:\myproject\pixel-office\dev\daemon
  └ 부장 부장38 [claude] starting (m_aa000f3d34b9)
     ├ (팀 없음)
```

**B — 아무것도 안 했는데 부서·부장을 안다** (푸시 전에는 이름을 몰라 `m_aa000f` 로 찍히다가, 푸시 뒤 `부장38` 로 바뀐다):

```
po> depts
(부서 없음)
status m_aa000f → starting (starting)
[snapshot] seq=427 갱신
status 부장38 → idle (free)
status m_2e700d → starting (starting)
[snapshot] seq=427 갱신                      ← A 의 `team create`(디버그 force) 도 똑같이 밀린다
status 반장38 → idle (free)
po> depts
d_96ab7a2f16e6  d38  D:\myproject\pixel-office\dev\daemon  head=m_aa000f3d34b9  팀 1개  멤버 2명
```

**A — 팀 생성(디버그) → tree → 부장 외 지시는 -32004:**

```
po> team create d38 t1 claude 반장38
팀 생성: t_abd032c97e39  t1  dept=d_96ab7a2f16e6  …  lead=m_2e700da39ef0  members=1/4
팀장: m_2e700da39ef0  반장38 [claude] starting  팀장(lead) @t1 pid=11072
po> tree
[snapshot] seq=427 갱신
d38 (d_96ab7a2f16e6)  D:\myproject\pixel-office\dev\daemon
  └ 부장 부장38 [claude] free (m_aa000f3d34b9)
     ├ 팀 t1 (t_abd032c97e39)  정원 1/4
     │  └ 팀장 반장38 [claude] starting (m_2e700da39ef0)

po> say 반장38 안녕
오류 [-32004] 부장에게만 지시할 수 있습니다 (head: 부장38) {"headId":"m_aa000f3d34b9"}
```

**A — 부장 지시 → 부서 삭제(잎부터):**

```
po> say 부장38 조용히 있어라. 아무 도구도 쓰지 마라.
task#2 → 부장38
po> dept delete d38
#428 idle 반장38 session ended: prompt_input_exit      ← 팀장 먼저
status 반장38 → exited (exited)
#429 thinking 부장38 [TASK#2 from user] ⏎ 조용히 있어라. 아무 도구도 쓰지 마라.
#430 idle 반장38 clocked out
#431 reporting 부장38 부장38 의 작업이 중단됐습니다 (부서 삭제).  task#2
[daemon:info] 부장38 후처리(부서 삭제): task 1건 중단
#432 idle 부장38 session ended: prompt_input_exit      ← 부장 마지막
status 부장38 → exited (exited)
부서 삭제: d38
po> depts
(부서 없음)
po> tree
[snapshot] seq=433 갱신
(부서 없음)
```

**B — 재접속 없이 유령이 사라진다**(T37 함정 ① 해소. 예전에는 여기서 부서 줄이 그대로 남았다):

```
… (A 의 삭제 이벤트들이 그대로 흘러온 뒤)
[snapshot] seq=433 갱신
po> depts
(부서 없음)
```

**`fire` 확인 프롬프트**(같은 데몬, 파이프 REPL):

```
po> dept create d38b D:/myproject/pixel-office/dev/daemon claude 부장B
부서 생성: d_27b5d065856d  d38b  …  head=m_3b4bd486f91f  팀 0개  멤버 1명
[snapshot] seq=433 갱신
status 부장B → idle (free)
po> fire 부장B
비상 퇴근: 부장 부장B (m_3b4bd486f91f)
정말 퇴근시킬까요? y 를 입력하면 진행, 그 밖의 입력은 취소
취소했습니다                                  ← n(= y 가 아닌 입력)
po> members
m_3b4bd486f91f  부장B [claude] idle  부장(head) @d38b pid=6852   ← 그대로 살아 있다
po> fire 부장B
비상 퇴근: 부장 부장B (m_3b4bd486f91f)
정말 퇴근시킬까요? y 를 입력하면 진행, 그 밖의 입력은 취소
#434 idle 부장B session ended: prompt_input_exit               ← y
status 부장B → exited (exited)
#435 idle 부장B clocked out
퇴근: 부장B (m_3b4bd486f91f)
```

## 발견한 함정

1. **스냅샷 푸시를 RpcServer 핸들러에 붙이면 MCP 경로가 샌다.** 부장이 `create_team`/`dismiss_team` 도구로 만든 팀·지운 팀은
   RPC 를 거치지 않는다. 그래서 Office 의 네 메서드에서 `tree` 이벤트를 내고 RpcServer 는 그걸 구독만 한다 —
   "트리가 바뀌는 곳" 과 "알리는 곳" 이 1:1 이 된다.
2. **푸시를 동기로 보내면 응답보다 먼저 도착한다.** `createDepartment` 는 응답을 만들기 전에 이벤트를 내므로, 구독자가 바로
   보내면 클라이언트가 `snapshot` → `result` 순서로 받는다(스냅샷을 적용한 뒤 응답으로 또 한 번 같은 행을 쓰는, 무해하지만
   헷갈리는 순서). `setImmediate` 로 미루면 `result` → `snapshot` 이 된다. 테스트가 그 순서를 고정한다.
3. **`src/cli/index.ts` 는 import 하는 순간 `main()` 이 돈다.** 그래서 `HELP`·`treeLines` 는 테스트에서 건드릴 수 없었다.
   순수한 부분을 `help.ts`/`format.ts` 로 옮기고 나서야 "2단 문구가 남아 있지 않다" 같은 단언을 쓸 수 있었다.
4. **`--exec` 는 첫 실패에서 멈춘다.** 실기에서 `say 반장38`(-32004 를 확인하려는 의도) 뒤에 `dept delete` 를 같이 넣었더니
   거기서 끊겨 삭제가 안 돌았다. 실패를 **기대하는** 명령은 따로 실행해야 한다(설계상 맞는 동작이라 고치지 않았다).

## 결정

새 결정 기록(D-##)은 없다. D-32~D-37 의 마감 작업이다. 다만 두 가지를 이번에 못 박았다:

- **스냅샷 푸시의 트리거는 "트리 모양이 바뀌는 네 메서드" 다**(멤버 행의 생멸은 계속 `member.status` 담당). 푸시가
  `member.status` 를 대체하지 않는다 — 전자는 행 집합, 후자는 상태·파생이다.
- **`fire` 의 확인은 콘솔(대화형)에만** 둔다. RPC `member.clockOut` 은 비상구라 그대로 열려 있고, 앱은 T37 이 이미 확인
  다이얼로그를 갖고 있다.

## 남은 것

- **T39 v1b 시연(트리)**: 부서 → 부장 → 팀 → 팀원 → 보고 상향 → `ask_parent`/`ask_user` → 부장 퇴근 시 부서 정리 →
  셸 뮤텍스를 앱 창 캡처로. 이번 실기는 콘솔만 봤다(앱은 T37 캡처가 최신).
- **앱에서 푸시를 눈으로 확인**: 단위 테스트와 콘솔 두 개로는 확인했지만, 릴리스 빌드를 띄워 놓고 콘솔에서 `dept delete` 를
  했을 때 탭이 사라지는 장면은 T39 에서 캡처한다.
- Codex 엔진으로 rev 3 를 도는 것은 **2026-09-21 이후**(D-23 한도) — `docs/worklog/T23-MixedTeam.md` §"9/21 이후 확인 목록".
- 콘솔 `--exec` 의 "실패하면 멈춤" 은 그대로 뒀다. 실기 스크립트에서 -32004 같은 **기대된 실패**를 확인하려면 명령을 나눠야 한다.
