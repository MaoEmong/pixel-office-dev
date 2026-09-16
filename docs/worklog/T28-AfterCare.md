# T28 — 파생 상태·후처리 정리

- 날짜: 2026-09-16
- 마일스톤: M4
- 관련 설계: 01-설계문서.md §"interrupt / fire / error 공통 후처리", §2 "멤버 표시 상태(파생)"
- 커밋: (미커밋 — 이 태스크는 코드·문서만)

## 목표

"멤버가 하던 일을 거두는" 코드가 T25·T27 를 지나며 `interrupt` / `clockOut` / `restart` / `onPtyExit` / `recover` /
`deleteTeam` 여섯 군데에 흩어졌다. 조각이 조금씩 달라서 **퇴근은 셸 락을 푸는데 팀 삭제는 안 풀고**, 팀 삭제는 MCP 토큰을
정리하지 않고, 팀장을 먼저 내보내는 바람에 이미 나가는 팀장에게 aborted 보고가 다시 들어가는 식의 구멍이 생겼다.
파생 상태(`free`/`waiting_reports`/`waiting_answer`)도 데몬(`Office.derived`)과 앱(`DerivedStatus.fromStatus`)이
따로 계산해 재접속 직후에는 서로 다른 값을 보였다.

이 태스크가 끝나면 **후처리 표 하나**(`afterCare.ts`)와 **파생 규칙 하나**(`derived.ts`)만 고치면 여섯 경로가 같이 바뀐다.

## 한 것

- **`dev/daemon/src/office/afterCare.ts` (신규)** — `settleMember(store, ctx, memberId, reason, opts?)`.
  `SETTLE_MATRIX` 가 이유별 정책(내 task / 보류 / 셸 락 / 팀장의 발행 task / 대상 interrupt / MCP)을 들고 있고,
  함수는 그 표대로 ① 셸 락 해제 → ② (팀장이면) 발행 task 정리 + 대상 중단 → ③ 내 task aborted + 발행자에게 즉시 보고
  → ④ 보류 만료 → ⑤ MCP 정리 → ⑥ 파생 알림 + `daemon.notice{info}` 를 한다. `Office` 를 import 하지 않는다
  (부작용은 전부 `SettleCtx` 콜백). 반환값 `{abortedTasks, expiredPending, interruptedMembers}`.
- **`dev/daemon/src/office/derived.ts` (신규)** — `derivedStatus(member, store, status?)`. 파생 규칙은 이제 여기 하나뿐이고
  `snapshot()` 과 `member.status` 알림이 같은 함수를 부른다.
- **`dev/daemon/src/office/Office.ts`** — 흩어져 있던 `abortTasksAndReport` / `abortTasksIssuedBy` 를 **삭제**하고
  `settle(memberId, reason)` 로 바꿨다. 호출부: `interrupt`(interrupt) · `clockOut`(clockOut|teamDelete) ·
  `restart`(restart) · `onPtyExit` 의 예상 못 한 종료(error) · `expirePendingForRestart`(recover) · `deleteTeam`(teamDelete).
  `deleteTeam` 은 **팀원 먼저 · 팀장 마지막** 순서로 퇴근시키고 살아 있지 않은 행의 MCP 토큰도 끊는다.
  `snapshot()` 은 멤버 행에 `derived` 를 실어 보낸다. `emitStatus`/`setStatus` 에 `lastDerived` 비교(`syncDerived`)를 넣어
  **raw 는 그대로인데 파생만 바뀐 경우에도** `member.status` 가 한 번 나간다(T17 의 `ask_user` 예외를 일반화).
- **`dev/daemon/src/office/types.ts`** — `SnapshotMember`(= Member + `derived`) · `OfficeSnapshot`, `OfficeApi.snapshot()` 반환 타입.
- **`dev/daemon/PROTOCOL.md`** — `snapshot.members[].derived` · `member.status` 발화 조건 · 새 "멤버 파생 상태 `derived`" 표 ·
  "후처리" 절을 이유별 표로 교체.
- **`dev/daemon/test/office/AfterCare.test.ts` (신규, 14건)** + `test/office/fakes.ts` 에 `FakeMcp`(dispose 기록).
- **앱**: `lib/model/member.dart` 에 `Member.derived`(스냅샷 전용, 없으면 null), `lib/state/office_state.dart` 가 그 값을 그대로 쓰고
  없을 때만 예전처럼 유추, `lib/office/office_scene.dart` 에 `freeSummary`("(한가함)") — 파생이 `free` 이고 화면이 "(대기)" 를
  보여 줄 자리에서만 바꾼다. 앱 테스트 2건 추가·1건 갱신.

### 최종 후처리 표

| 이유 | 내 `queued\|assigned` task | 열린 허가·질문 | 셸 락 | 팀장: 발행한 task | 팀장: 그 task 를 맡은 팀원 | MCP |
|---|---|---|---|---|---|---|
| `interrupt` | aborted + 발행자에게 즉시 보고 | 전부 expired | 해제 | **그대로** | — | 유지 |
| `clockOut`(퇴근·dismiss) | aborted + 즉시 보고 | 전부 expired | 해제 | aborted | interrupt | 끊음 |
| `error`(비정상 종료) | aborted + 즉시 보고 | 전부 expired | 해제 | aborted | interrupt | 끊음 |
| `teamDelete` | aborted + 즉시 보고 | 전부 expired | 해제 | aborted | interrupt | 끊음 |
| `restart`(member.restart) | **그대로**(같은 세션이 이어서 한다) | 전부 expired | 해제 | 그대로 | — | 유지 |
| `recover`(데몬 재시작) | 그대로(assigned 유지 · queued 재큐잉) | 허가 + TUI `AskUserQuestion` 만 expired + `error{pendingId}`, **`ask_user` 질문은 유지**(D-19) | 해제 | 그대로 | — | 유지 |

`interrupt` 만 발행 task 를 남긴다 — Ctrl+C 는 **그 팀장의 턴**을 끊는 것이지 팀에 내린 지시를 거두는 게 아니다.

### 최종 파생 상태 규칙 (`derived.ts`)

위에서부터 먼저 맞는 것: `exited`/`error`(raw 그대로) → 열린 허가 있으면 `waiting_approval` → 열린 질문 있으면
`waiting_answer` → raw 가 idle 이 아니면 raw 그대로 → 팀장 + 발행 미종료 task 있으면 `waiting_reports` →
배정 미종료 task 0 이면 `free` → 그 외 `idle`.

T25 까지와 달라진 점: ① 허가/질문 판정이 **raw 와 무관**해졌다(전에는 raw idle 일 때만 봤다), ② `exited`/`error` 는
파생이 절대 덮지 않는다(퇴근한 멤버의 정리 안 된 pending 이 "질문 대기" 로 보이는 일이 없다).
`free` 는 팀장에게도 그대로 적용한다(T25 테스트가 그렇게 고정해 뒀고, 팀장도 발행 task 가 없으면 한가한 게 맞다).

## 검증

```
$ cd dev/daemon && npx tsc --noEmit
(출력 없음)

$ npx tsx --test "test/**/*.test.ts"
ℹ tests 413
ℹ suites 58
ℹ pass 407
ℹ fail 0
ℹ skipped 6        (실기 integration 6건 — 기존과 동일)
ℹ duration_ms 35181.7307
```

새 파일 `test/office/AfterCare.test.ts` 14건 전부 통과:

```
✔ interrupt: 내 미종료 task 는 aborted + 발행자에게 즉시 보고, 열린 보류 만료, 셸 락 해제
✔ interrupt(팀장): 자기 턴만 끊는다 — 발행한 task 와 팀원은 건드리지 않는다
✔ 사용자 지시를 중단하면 내 책상에 reporting(aborted) 이벤트가 남는다
✔ 퇴근(팀장): 발행 task 전부 aborted + 대상 팀원 interrupt + MCP 토큰 정리
✔ 프로세스 비정상 종료(error): 퇴근과 같은 표로 정리된다
✔ team.delete: 팀원 먼저 · 팀장 마지막으로 퇴근시키고 토큰·셸 락을 전부 정리한다
✔ restart: 열린 보류는 만료되지만 배정된 task 는 같은 세션이 이어 하므로 남는다
✔ 표(SETTLE_MATRIX): recover 는 ask_user 질문만 남기고 나머지를 만료 + error 이벤트(D-19·D-15)
✔ 표(SETTLE_MATRIX): 이유별 정책이 설계(01 §공통 후처리)와 같다
✔ 파생: 열린 허가·질문은 raw 가 무엇이든 waiting_* 로 보인다
✔ 파생: 나간 멤버(exited/error)는 덮지 않는다
✔ 파생: raw 는 idle 그대로인데 파생만 바뀌면 member.status 가 한 번 더 나간다
✔ 파생: 후처리로 배정 task 가 사라지면 idle → free 알림이 나간다(같은 값이면 안 나간다)
✔ snapshot 의 멤버 행에 파생 상태가 실린다
```

```
$ cd dev/app && flutter analyze
No issues found! (ran in 3.1s)

$ flutter test
00:13 +163 ~1: All tests passed!
```

기존 스위트는 하나도 고치지 않았다(RpcServer.test.ts 의 `FakeOffice.snapshot` 타입, app 의 `summarize` 기대값 1건만
아래 "결정" 대로 의도적으로 갱신).

## 발견한 함정

1. **`member.restart` 는 `ask_user` 질문을 살릴 수 없다.** 표의 `restart` 행은 설계상 `recover` 와 같아야 하지만
   (D-19: 턴 종료 상태의 질문은 프로세스가 죽어도 유효), 살아 있는 프로세스를 죽이는 경로에서는 **hook 보류 취소와 pending
   만료가 어댑터의 `expireAllForMember` 하나로 묶여 있다**(`src/adapters/**` 는 T28 범위 밖). 보류를 취소하지 않으면 CLI 가
   응답을 못 받고 멈추므로 어댑터를 부를 수밖에 없고, 그러면 `ask_user` 질문도 같이 만료된다. `onPtyExit` 의 restart 분기도
   같은 함수를 부른다. → `restart` 는 T25 까지와 동일하게 **전부 만료**로 두고 표에 그대로 적었다(D-30).
2. **파생 알림을 "바뀔 때만" 으로 좁히면 `lastDerived` 가 비어 있는 첫 호출이 문제**가 될 수 있는데, 모든 멤버는
   `spawnMember` 에서 `emitStatus('starting')` 를 받아 값이 심어진다. 그래서 "raw 같고 파생 같으면 무음" 이 바로 성립한다.
3. **팀 삭제에서 팀장을 먼저 내보내면** 그 후처리가 팀원을 interrupt 하고, 팀원의 후처리가 다시 (아직 살아 있는) 팀장 큐에
   `[REPORTS … aborted]` 를 밀어 넣는다. 어차피 지울 팀에 왕복만 는다 → 팀원 먼저, 팀장 마지막.
4. 테스트에서 같은 멤버를 1.5초 안에 두 번 `interrupt` 하면 `INTERRUPT_GUARD_MS` 가드에 막힌다(두 번째 Ctrl+C = CLI 종료).
   "파생이 그대로면 알림이 안 나간다" 는 `Stop` hook 재전송으로 확인했다.

## 결정

- **D-31** (04-결정기록.md): 후처리는 표 하나(`afterCare.ts`)로, 파생은 `derived.ts` 하나로. `member.restart` 의 `ask_user`
  예외는 어댑터 구조상 적용하지 않는다. `snapshot` 이 `derived` 를 싣는다. 파생만 바뀌어도 `member.status` 를 보낸다.
- 앱 `summarize` 기대값 1건 갱신: 파생 `free` + 마지막 이벤트가 `idle` 이면 "(대기)" → **"(한가함)"**.
  ("(대기)" 는 맡은 일이 남은 idle 에만 쓴다 — 사용자가 "쟤 지금 놀아도 되나?" 를 한눈에 본다.)

## 남은 것

- `docs/03-작업계획.md` 의 T28 체크박스는 **다른 에이전트가 같은 파일을 만지고 있어 건드리지 않았다** — 이 태스크를 닫을 때 같이 체크.
- `member.restart` 에서도 `ask_user` 질문을 살리려면 어댑터에 "보류만 취소" 하는 메서드가 필요하다(T30 후보).
- `markRecoveryFailure`(복구 실패 → error)는 여전히 `store.abortTasksFor` 만 부른다. 표대로라면 발행자에게 aborted 보고까지
  가야 하지만, 복구 도중 팀장 큐에 `[REPORTS]` 를 넣는 것은 `[RESUMED]` 순서(D-20)와 얽혀 있어 T30 으로 미뤘다.
- 실기 확인(데몬 + 앱으로 팀장 퇴근·팀 삭제)은 T29 v1b 시연에서 같이 본다.
