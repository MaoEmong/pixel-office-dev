# T36 — 후처리·복구·파생 상태 트리화

- 날짜: 2026-09-16
- 마일스톤: M4b
- 관련 설계: 01-설계문서.md §"직무 체계 rev 3"(후처리: 상위가 퇴근하면 하위 트리 전체 정리, `waiting_reports` 는 자식 있는 모든 직급) · §"interrupt / fire / error 공통 후처리" · §"데몬 재시작 복구"
- 커밋: `<hash>` (완료 시)

## 목표

T28 이 만든 후처리 표(`SETTLE_MATRIX`)와 T09 의 재시작 복구는 "팀장 하나 + 팀원들" 2단을 전제로 돌고 있었다.
D-32 로 직급이 3단 트리가 된 뒤로는 두 곳이 어긋난다 — ① 부장이 퇴근해도 그 아래 팀장·팀원 세션이 그대로 남아
받을 사람 없는 보고를 준비하고, ② 데몬을 재시작하면 팀원이 부장보다 먼저 깨어나 상사가 없는 채로 보고를 올린다.
이 태스크가 끝나면 **상위가 사라지면 그 하위 트리 전체가 잎부터 정리되고**, **복구는 뿌리부터 순서대로 깨우며**,
재시작이 턴 종료 질문을 더 이상 잃지 않는다(D-31 이 남긴 한계). 덤으로 T34 가 남긴 "빈 폴더 신뢰 다이얼로그 함정" 의
원인을 찾아 고친다.

## 한 것

### 1. 하위 트리 후처리 — `src/office/afterCare.ts`

- `SettleReason` 에 **`parentGone`**(상위가 사라져 따라 정리되는 부하)과 **`departmentDelete`** 추가. 표가 8행이 됐다.
- `SettlePolicy` 에 칸 셋 추가:
  - `subtree` — 살아 있는 하위 트리를 잎부터 정리하는가(`clockOut`/`error`/`teamDelete`/`departmentDelete` 만 true).
  - `cancelHolds` — 어댑터의 열린 hook 보류를 끊는가(복구만 false). `pending` 칸과 갈라놓은 것이 D-36 의 핵심.
  - `reportToIssuer` — 내 task 를 끊을 때 발행자에게 `[REPORTS … aborted]` 를 보내는가(`parentGone` 만 false).
- `settleMember` 에 ⓪단계 추가: `policy.subtree` 면 `store.subtreeOf(memberId)` 를 **잎부터** 훑으며 자식마다
  `settleMember(..., 'parentGone')` + `ctx.endSession(childId)`. 이미 나간 행(`exited`/`error` ∧ 세션 없음)은 건너뛴다(멱등).
- `leavesFirst(subtree, rootId)` 를 별도 함수로 뺐다 — DFS 배열을 그냥 뒤집으면 **형제 순서까지 뒤집혀서**(이음·하루 → 하루·이음)
  로그와 테스트가 읽기 어려워진다. 깊이만 뒤집고 같은 깊이 안에서는 원래 순서를 지킨다.
- `parentGone` 은 보고를 버리는 대신 그 멤버 이력에 `idle{summary:'task#n aborted (상위 정리)'}` 를 남긴다 —
  왜 끊겼는지가 사무실 로그에서 사라지면 안 된다.
- `SettleCtx` 에 `cancelHolds(memberId)` · `endSession(memberId)` 추가, `SettleSummary` 에 `settledChildren` 추가
  (`daemon.notice` 에 "하위 N명 정리" 로 나온다).
- `keepsQuestion` 은 `derived.ts` 의 `isTurnEndingQuestion` 을 그대로 재수출(판정이 두 벌이 되지 않게).

### 2. 복구 순서 — `src/office/Office.ts`

- `RANK_DEPTH` 상수 하나를 정리 순서(`settleOrder`, 잎부터)와 복구 순서(`recoverOrder`, 뿌리부터)가 함께 본다.
- `recover()` 가 `recoverOrder` 로 **부장 → 팀장 → 팀원** 순 재스폰.
- `recoverMember()` 에 **parent-gone 게이트**: `parentId` 가 있는데 부모 행이 없거나 `exited`/`error` 면
  `markRecoveryFailure(member, 'restart: parent gone')` 로 두고 재스폰하지 않는다(pending 은 `expireQuestions:true` 로 전부 만료 —
  되살릴 세션이 아예 없는 멤버다). 순서가 뿌리부터라 부모의 성패가 자식 차례에는 이미 결정돼 있다.
- `buildResumedText` 에 `issued`(내가 낸 미종료 task) · `children`(살아 있는 직속 부하) 칸 추가. 자식이 있는 직급에만 붙는다:
  `… 맡긴 일(보고 대기): task#13 → 초안 써라. 직속 부하: 이음(팀원), 하루(팀원). …`
- 하위 트리 정리로 끝낸 세션의 종료 대기를 `childExits` 에 모아 두고 `clockOut`/`deleteTeam`/`deleteDepartment` 가
  반환 전에 `drainChildExits()` 로 기다린다(팀·부서 행을 지우기 전에 자식이 다 나가 있어야 한다).
- `endChildSession()` — 큐를 비우고 정중히 종료 → `finishMember(… '상위 정리')`. `[TEAM] -<이름>` 알림은 내지 않는다
  (받을 상사가 바로 지금 사라지는 중).
- `deleteDepartment` 의 후처리 이유를 `teamDelete` → `departmentDelete` 로.
- `onPtyExit` 의 `exitMode === 'restart'` 경로가 `cancelHolds` + `expirePendingFor({keepTurnEndingQuestions:true})` 를 쓴다
  (퇴근은 그대로 전부 만료).

### 3. 파생 상태 — `src/office/derived.ts`

- `TURN_ENDING_QUESTION_SOURCES = ['ask_user', 'ask_parent']` + `isTurnEndingQuestion(pending)` 을 여기 한 곳에 뒀다
  (후처리·어댑터가 같은 함수를 본다).
- `waiting_answer` 는 질문 종류를 가리지 않는다(TUI `AskUserQuestion` · `ask_user` · `ask_parent`) — 기존 코드가 이미
  그랬고 T35 의 `ask_parent` pending 이 `type:'question'` 이라(D-37) 그대로 맞물린다. 테스트로 고정했다.
- `waiting_reports` 가 직급 무관인 것(T34)과 `free` 가 "잎이 한가함" 인 것도 테스트로 고정. 코드 변경은 주석뿐.

### 4. D-31 후속: 보류 취소와 pending 만료 분리 — `src/adapters/BaseHooksAdapter.ts`

- `expireAllForMember(id)` = `cancelHolds(id)` + `expirePendingFor(id)` 래퍼로 남기고 둘을 따로 노출.
- `cancelHolds(id)` — 보류 중인 hook 결정 핸들과 셸 게이트 보류만 `{}` 로 닫는다(게이트에는 `AbortSignal` 도, T27 ③).
- `expirePendingFor(id, {keepTurnEndingQuestions})` — pending 행 만료 + `waiting_* → working`.
  살아남은 질문이 있으면 status 를 되돌리지 않는다(아직 답을 기다리는 중이다).
- 결과: `member.restart` 가 **보류는 끊고 `ask_user`/`ask_parent` 질문은 남긴다**(D-36).

### 5. 빈 폴더 신뢰 다이얼로그 함정 — `src/screen/ScreenModel.ts` · `src/input/InputQueue.ts`

- `DialogDetection` 에 `highlightDriven`(그 다이얼로그의 키가 tui-map `highlight` 로 갈리는가) 추가.
- `InputQueue.tick` — `highlightDriven` 이고 키가 둘 이상이면 **마지막 확인 키를 떼고 이동 키만** 보낸다.
  다음 폴링에서 권장 키가 확인 키 하나로 줄어든 것(= 강조가 원하는 항목에 와 있는 것)을 **다시 보고 나서** Enter.
- 반복 가드(`dialogRepeatGuardMs` 2초)를 `kind` 가 아니라 **`kind + 보낸 키**` 로 건다. 같은 키는 2초에 한 번,
  키가 달라졌으면(이동이 먹혔다) 즉시 — 그래야 확인이 2초 늦어지지 않는다.

### 6. 문서·테스트

- PROTOCOL.md: "후처리" 표를 8행 + `hook 보류`·`하위 트리` 칸으로 교체, `member.clockOut` 행, "재시작 복구" 1·5번 항목.
- 04-결정기록.md: **D-35**(팀 삭제는 task 를 남기고 부서 삭제는 지운다), **D-36**(보류 취소 / pending 만료 분리).
  D-31 의 딸린 결정(한계)에 "→ D-36 으로 대체" 표시.
- 새 테스트: `test/office/TreeAfterCare.test.ts`(10), `test/office/RecoveryTree.test.ts`(5),
  `test/input/DialogHighlight.test.ts`(4). 기존 `test/office/AfterCare.test.ts` 는 T36 규칙으로 갱신 + 4건 추가.
- T28·T34·T25 가 "부하는 남는다" 로 고정해 뒀던 테스트 3건을 새 규칙으로 갱신(아래 "발견한 함정" ②).

## 최종 후처리 표

| 이유 | 내 `queued\|assigned` task | hook 보류 | 열린 허가·질문 | 셸 락 | 내가 발행한 task | 그 task 를 맡은 부하 | 하위 트리 | MCP |
|---|---|---|---|---|---|---|---|---|
| `interrupt` | `aborted` + 발행자에게 즉시 보고 | 취소 | 전부 만료 | 해제 | **그대로** | — | 그대로 | 유지 |
| `clockOut` | `aborted` + 즉시 보고 | 취소 | 전부 만료 | 해제 | `aborted` | `interrupt` | **잎부터 정리** | 끊음 |
| `error` | `aborted` + 즉시 보고 | 취소 | 전부 만료 | 해제 | `aborted` | `interrupt` | **잎부터 정리** | 끊음 |
| `teamDelete` | `aborted` | 취소 | 전부 만료 | 해제 | `aborted` | `interrupt` | **잎부터 정리** | 끊음 |
| `departmentDelete` | `aborted` | 취소 | 전부 만료 | 해제 | `aborted` | `interrupt` | **잎부터 정리** | 끊음 |
| `parentGone` | `aborted`, **보고는 버림**(이력만) | 취소 | 전부 만료 | 해제 | `aborted` | — | (호출자가 이미 잎부터) | 끊음 |
| `restart` | **그대로** | 취소 | 허가·TUI 질문만 만료, **`ask_*` 유지**(D-36) | 해제 | 그대로 | — | 그대로 | 유지 |
| `recover` | 그대로(`queued` 재큐잉) | (이미 없음) | 허가·TUI 질문만 만료 + `error` 이벤트, **`ask_*` 유지**(D-19) | 해제 | 그대로 | — | 그대로 | 유지 |

## 검증

### 단위·통합 테스트

```
$ npx tsc --noEmit
(출력 없음)

$ npx tsx --test "test/**/*.test.ts"
ℹ tests 471
ℹ pass 464
ℹ fail 0
ℹ skipped 7
```

(T36 시작 시점 431건 → T35 가 병행해 추가한 것 + 이 태스크의 19건.)

새 파일만 따로:

```
$ npx tsx --test "test/office/TreeAfterCare.test.ts"
  ✔ clockOut(팀장): 하위 팀원 둘이 먼저 나가고 팀장이 마지막 — 전부 exited + 토큰 정리
  ✔ clockOut(부장): 부서 전원(팀원 → 팀장 → 부장)이 잎부터 나간다
  ✔ 프로세스 비정상 종료(error, 팀장): 같은 표로 하위 트리가 정리된다
  ✔ department.delete: 트리 전체를 잎부터 내보내고 부서·팀·멤버 행을 지운다
  ✔ parentGone: aborted 보고는 사라지는 상위 큐에 안 들어가고 그 멤버 이력에만 남는다
  ✔ interrupt(팀장): 자기 턴만 끊는다 — 하위 팀원과 그들의 task 는 그대로
  ✔ restart(팀장): 하위는 계속 돈다 — 되살아난 세션이 그 보고를 받는다
  ✔ 결함 ⑤ 회귀: team.delete 는 tasks 행을 지우지 않는다(task 는 부서 소유, D-33·D-35)
  ✔ department.delete 는 반대로 task 를 함께 지운다(프로젝트 자체가 사라진다, D-35)
  ✔ leavesFirst: 깊은 쪽부터, 같은 깊이 안에서는 원래 순서
ℹ pass 10  fail 0

$ npx tsx --test "test/office/RecoveryTree.test.ts"
  ✔ 트리 순서: 행 순서가 잎부터여도 부장 → 팀장 → 팀원 순으로 재스폰한다
  ✔ [RESUMED]: 상위는 "맡긴 일 + 직속 부하", 잎은 배정 task 만
  ✔ 상사가 되살아나지 못하면 부하는 error{restart: parent gone} 이고 재스폰하지 않는다
  ✔ 부장이 살아 돌아오면 그 아래는 정상 복구된다(게이트가 부모 status 하나만 본다)
  ✔ buildResumedText: issued/children 이 비면 문장이 T09 그대로다
ℹ pass 5  fail 0
```

### 빈 폴더 신뢰 다이얼로그 — 실측 재현과 확인

재현 스크립트는 데몬과 **같은 부품**(`PtyManager` + `ScreenModel` + `InputQueue`)을 그대로 쓴다.

먼저 `dev/spike-0/` 아래 새 폴더로는 **재현되지 않았다** — `~/.claude.json` 의 `projects` 에 `D:\myproject` 가
이미 있어서 그 아래는 신뢰 다이얼로그가 아예 안 뜬다(Claude 가 상위 폴더 등록을 따라간다). T34 때는 그 항목이 없었다.
그래서 신뢰된 조상이 없는 새 폴더(`D:\po-t36-<ts>`)로 재현했다.

**① 재현(고치기 전 동작 그대로 = ↓와 Enter 를 150ms 간격으로):**

```
11:25:28.350 spawned pid 16424 cwd D:/po-t36-1789557926
11:25:28.870 >>> KEY down
11:25:28.871 ### dialogPassed trust-folder-claude
----- 11:25:28.976 dialog=trust-folder-claude keys=[down,enter] ready=false -----
 Accessing workspace:
 D:\po-t36-1789557926
 ...
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
-----------------------------------------------------------
11:25:29.037 >>> KEY enter
11:25:30.596 *** EXIT {"exitCode":1}          ← T34 가 본 그 증상
```

**② 원인 — 다이얼로그가 뜬 직후 한 번 더 렌더되며 선택을 `No, exit` 로 되돌린다.**
`down` 하나만 보내고 100ms 간격으로 강조를 찍어 보면:

```
   628ms dialog= trust-folder-claude keys= [ 'down', 'enter' ] | ❯ No, exit
   643ms --- settled 0ms, sending down ---
   744ms after down +100ms: ❯ Yes, I trust this folder     ← 키는 먹었다
   846ms after down +200ms: ❯ No, exit                     ← 그런데 되돌아온다
   954ms after down +300ms: ❯ No, exit
   ... (2초까지 계속 No, exit)
  2808ms --- sending enter ---
  4366ms *** EXIT {"exitCode":1}
```

다이얼로그가 안정된 뒤(2초 대기) 같은 `down` 을 보내면 강조가 그대로 남는다:

```
  2613ms --- settled 2000ms, sending down ---
  2721ms after down +100ms: ❯ Yes, I trust this folder
  ... (2초 내내 유지)
  4772ms --- sending enter ---
 10898ms screen now:  ▐▛███▛█   Claude Code v2.1.270 …     ← 정상 진입
```

즉 키 시퀀스 자체는 맞았고, **"지금 강조" 를 보고 만든 Enter 를 150ms 뒤에 쏘는 것** 이 문제였다.
그 사이에 CLI 가 선택을 되돌리면 Enter 가 `No, exit` 에 떨어진다. 폴더가 비었는지와는 무관하고,
**신뢰 다이얼로그가 뜨는 모든 새 폴더**가 대상이다(T34 의 `dev/sandbox-t34` 는 그때 신뢰된 조상이 없었다).

**③ 고친 뒤(현재 코드) — 같은 조건:**

```
11:54:19.602 spawned pid 25372 cwd D:/po-t36-fix-1789559657
11:54:20.119 >>> KEY down                 ← 이동 키만
11:54:22.172 >>> KEY down                 ← 되돌아갔으므로 가드(2s) 뒤 한 번 더
----- 11:54:22.406 dialog=trust-folder-claude keys=[enter] ready=false -----
   No, exit
 ❯ Yes, I trust this folder
-----------------------------------------------------------
11:54:22.673 >>> KEY enter                ← 강조를 다시 보고 나서 확인(가드를 안 기다린다)
----- 11:54:23.965 dialog=none ready=true -----
▐▛███▛█   Claude Code v2.1.270
  ▝▝ ▝▝    D:\po-t36-fix-1789559657
❯ Try "create a util logging.py that..."
  ⏸ manual mode on · ? for shortcuts · ← for agents
```

통과까지 약 3초(되돌아가지 않으면 ~0.7초). 임시 폴더(`D:\po-t36-*`, `dev/spike-0/sandbox-new-*`)와
그 과정에서 `~/.claude.json` 에 생긴 신뢰 항목은 전부 지웠다.

### 결함 ⑤(T29) 확인

D-33 이 `tasks.team_id` → `tasks.department_id`(`ON DELETE CASCADE`) 로 옮긴 덕에 **이미 해소돼 있었다.**
스키마(`src/store/schema.ts`)에 `teams` → `tasks` FK 가 없으므로 `deleteTeam` 은 task 를 건드리지 않는다.
회귀 테스트로 고정했고(위 TreeAfterCare 8·9번), 부서 삭제 쪽 동작까지 D-35 로 못 박았다.

## 발견한 함정

1. **신뢰 다이얼로그는 "지금 강조" 를 믿고 키를 붙여 보내면 안 된다.** 위 검증 ②. 일반화하면
   *강조에 따라 키가 갈리는 다이얼로그에서는 확인 키를 예약해 두면 안 된다* — 화면을 다시 보고 보내야 한다.
   `~/.claude.json` 의 `projects` 에 **상위 폴더**가 등록돼 있으면 그 아래는 다이얼로그가 안 뜨므로,
   재현하려면 신뢰된 조상이 없는 경로를 써야 한다(이것 때문에 처음엔 재현에 실패했다).
2. **T28·T34·T25 테스트 3건이 옛 규칙("상위가 나가도 부하는 남는다")을 고정하고 있었다.** T36 이 뒤집는 규칙이라
   테스트를 새 규칙으로 갱신했다(`TeamTools.test.ts`, `Tree.test.ts`, `AfterCare.test.ts`).
   `TeamRank.test.ts` 의 "부장이 나가면 팀장 직접 지시가 열린다" 는 게이트만 보는 테스트라
   `clockOut` 대신 `store.updateMember(head, {status:'exited'})` 로 바꿨다 — 진짜 퇴근은 이제 팀장도 데려간다.
3. **`subtreeOf` 배열을 그냥 `reverse()` 하면 형제 순서가 뒤집힌다.** 깊이 우선 배열이라 뒤집으면 잎부터는 맞지만
   같은 깊이의 형제가 역순이 된다. `leavesFirst()` 로 깊이만 뒤집었다.
4. **`FakePty` 는 kill 된 세션을 맵에서 지운다.** 퇴근 뒤 그 멤버의 `pastes` 를 보려면 `pty.session(id)` 를
   **미리** 잡아 둬야 한다(`no fake session for …` 에러의 정체).
5. **`Office.onPtyExit` 에도 같은 만료 규칙이 필요했다.** 후처리 표만 고치면 `restart` 가 질문을 살려 두지만,
   그 직후 pty 가 죽으며 `onPtyExit` 가 `expireAllForMember` 로 다시 전부 지운다. 두 곳이 같은 규칙을 봐야 한다.

## 결정

- D-35 · `team.delete` 는 보고 이력을 남기고, `department.delete` 는 task 까지 지운다(T29 결함 ⑤ 마무리).
- D-36 · hook 보류 취소와 pending 만료를 갈라 `member.restart` 도 턴 종료 질문을 살린다(D-31 딸린 결정 정정).

## 남은 것

- **실기 확인은 T39 시연에서.** 여기 실측은 신뢰 다이얼로그 경로만 진짜 CLI 로 돌렸고, 하위 트리 정리·복구 순서는
  가짜 pty 로만 검증했다. T39 에서 부장 퇴근 → 부서 전원 정리, 데몬 재시작 → 트리 순서 재개를 창 캡처로 남긴다.
- **앱(T37)**: `member.status` 로 자식들이 연달아 `exited` 가 되는 것을 사무실 화면이 자연스럽게 그리는지
  (한꺼번에 사라지는 것처럼 보이지 않는지) 확인 필요.
- **`parentGone` 후 `rehire` 의 UX**: 행은 남지만 상사도 나간 상태라 혼자 되살리면 부모가 `exited` 인 자식이 된다.
  트리를 통째로 되살리는 "부서 재개" 가 필요한지는 T39 에서 사용자와 본다.
