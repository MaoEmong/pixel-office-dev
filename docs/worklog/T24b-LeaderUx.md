# T24b — 앱 팀장 UX (지시 게이트·팀장 표시)

- 날짜: 2026-09-16
- 마일스톤: M4
- 관련 설계: 01-설계문서.md §3 화면 구성 / §4 팀·직급 모델, `dev/daemon/PROTOCOL.md` "팀·직급 (T24)"
- 커밋: `<hash>` (완료 시)

## 목표

T24 가 데몬에 만든 "사용자 지시는 팀장에게만"(-32004) 규칙을 **앱이 먼저 지킨다**. 지시 바는 팀장이 있으면 대상을
팀장으로 고정하고 팀원 항목을 비활성(툴팁)으로 막으며, 그래도 -32004 가 오면 데몬 문구를 그대로 보여 준다.
사무실 캔버스에서는 팀장이 누구인지 한눈에 보이고(책상 "팀장" 배지 + 캐릭터 금색 링), 팀장이 팀원 보고를
기다리는 상태(`waiting_reports`)가 모니터·말풍선에 나온다. 덤으로 T24 함정 4(순환 import)를 정리했다.

## 한 것

### 선택 멤버 provider 이전 (T24 함정 4)

- **`lib/state/selection.dart`**(신규) — `selectedMemberIdProvider` + `SelectedMemberId` 를 `lib/main.dart` 에서 옮겼다.
  `main.dart` 는 이제 이 파일을 import 하고, `top_bar.dart` 의 `import '../main.dart' show selectedMemberIdProvider;`
  (Dart 는 허용하지만 순환이던 것)가 사라졌다. 동작은 그대로 — 멤버 행이 사라지면(팀 삭제·스냅샷에서 빠짐) 선택 자동 해제,
  퇴근(`exited`)은 행이 남으므로 선택 유지.

### 지시 바 (`lib/command/command_bar.dart`)

- **대상 고정**: `resolveTarget(members, leaders, chosenId, activeTeamId)` — 고른 멤버의 팀에 살아 있는 팀장이 있으면
  **팀장으로 되돌린다**. 고른 멤버가 없으면 활성 팀(`activeTeamIdProvider`)의 팀장. 사무실에서 팀원을 클릭해도 지시 바는
  팀장을 가리키고 힌트도 "반장에게 지시 …" 가 된다.
- **팀원 항목 비활성**: 드롭다운 항목은 `enabled: !isGone && !blockedByLeader(m)`, 막힌 항목은 툴팁
  `commandBarLeaderOnlyTooltip`("팀장에게만 지시할 수 있어요"). 판정은 **팀 단위** — 팀장 없는 다른 팀 멤버는 그대로 고를 수 있다.
  팀장 항목에는 "· 팀장" 이 붙고, 대상이 팀장일 때 드롭다운 전체 툴팁은 "지시는 팀장에게만 갑니다".
- **-32004 처리**: `member.instruct` 가 `-32004` 로 실패하면 데몬 문구(`팀장에게만 지시할 수 있습니다 (leader: …)`)를
  배지 자리(`commandBar.error`)에 그대로 띄우고(툴팁으로 전문), `data.leaderId` 로 대상을 되돌린다. 입력은 지우지 않아 그대로
  다시 보낼 수 있다. **`force` 는 쓰지 않는다**(콘솔 `say!` 전용 디버그 탈출구).
- 오류일 때만 배지 칸을 120 → 180px 로 넓혔다(문구가 길다).

### 상태 층 (`lib/state/office_state.dart`)

- `liveLeadersByTeam(members)` / `liveLeadersProvider`(팀 id → Member) / `liveLeaderProvider(teamId)` 추가.
  규칙은 데몬 `Store.liveLeader` 와 같다: `rank == leader ∧ status ∉ {exited, error}` 인 첫 멤버(createdAt 순).
  `Team.leaderId` 는 팀장이 나가도 남으므로 게이트 기준으로 쓰지 않는다(PROTOCOL "팀·직급").

### 사무실 캔버스 (`lib/office/`)

- **`office_scene.dart`** — `SceneMember.rank`(기본 `member`) + `isLeader`, 상수 `leaderBadgeLabel`('팀장') /
  `waitingReportsSummary`('📨 보고 대기'). `summarize()` 에 파생 `waiting_reports` 분기 추가 — 마지막 이벤트(보통 `idle`)보다
  앞선다(팀장이 위임 후 idle 인데 미종료 task 가 남은 상태 — 01 §3). 사용자 응답 대기가 아니므로 `isAlert` 도 아니고 내 책상 줄에도 안 선다.
- **`office_painter.dart`** — `OfficeColors.leaderMark`(0xFFFFD166). 팀장 책상은 엔진 배지 **왼쪽**에 "팀장" 배지(책상 라벨의
  `maxWidth` 도 그만큼 줄인다), 캐릭터는 `r + 2` 금색 링(선택 링 `r + 4` 흰색보다 안쪽이라 둘 다 보인다). 퇴근·오류면 링은 안 그린다.
  시맨틱 라벨에 `· 팀장` 이 들어간다. **히트 테스트(`OfficeLayout.hitTest`, 반경 `charRadius + 4`)는 손대지 않았다.**

### 상단 바 (`lib/topbar/top_bar.dart`)

- 팀 생성 후 `leader.id` 선택·팀장 이름 필드(기본값 hint `팀장`)·팀장 배지는 T24 에서 이미 한 것 — import 만 새 provider 로 바꿨고
  동작·테스트는 그대로다.

### 문서·테스트

- **`dev/app/README.md`** — "팀·팀장 (T24 / T24b)" 절 신설(살아 있는 팀장 판정, 지시 바 규칙, 캔버스 표시, 선택 멤버 위치),
  구조 트리에 `state/selection.dart`, 프로바이더 표에 `liveLeadersProvider` / `liveLeaderProvider`.
- **`test/state/selection_test.dart`**(신규 2건) — select/해제, 퇴근은 선택 유지·행이 사라지면 자동 해제.
- **`test/command/command_bar_test.dart`**(+4건) — 팀원을 골라도 팀장에게 지시, 드롭다운 비활성+툴팁(다른 팀은 그대로),
  팀장 퇴근 시 게이트 해제, -32004 문구·대상 복귀·`force` 미사용.
- **`test/office/office_leader_test.dart`**(신규 5건) — 팀장 배지·링이 그려진다 / 팀원만 있으면 없다 / 퇴근한 팀장은 링 없음 /
  시맨틱 라벨 + 히트 테스트 불변 / `waiting_reports` 요약.
- **`test/model_test.dart`** — `waiting_reports` 의 wire·`isWaiting=false`·스냅샷 v1a 규칙으로는 안 나온다·`member.status` 파싱.
- **`test/office/office_fixtures.dart`** — `member()` 픽스처에 `rank` 인자.

## 검증

```
$ flutter analyze
No issues found! (ran in 3.5s)

$ flutter test
00:13 +161 ~1: All tests passed!
```

T24b 시작 시점 150건 → 161건(선택 2 + 지시 바 4 + 사무실 5).

```
$ flutter test test/command/command_bar_test.dart
00:01 +6: T24b: 팀장이 있으면 팀원을 골라도 지시는 팀장에게 간다
00:01 +7: T24b: 드롭다운에서 같은 팀 팀원은 비활성 + 툴팁, 팀장 없는 다른 팀은 그대로
00:01 +8: T24b: 팀장이 퇴근하면 게이트가 열려 팀원에게 직접 지시된다
00:01 +9: T24b: -32004 는 데몬 문구를 그대로 띄우고 대상을 팀장으로 되돌린다(force 안 씀)
00:01 +11: All tests passed!

$ flutter test test/office/office_leader_test.dart
00:00 +5: All tests passed!
```

실기동(진짜 데몬·CLI)은 하지 않았다 — T24 에서 게이트·팀장 자동 출근을 콘솔로 확인했고, 이번 변경은 앱 표시·대상 선택뿐이다.

## 발견한 함정

1. **`paints` 매처의 색 비교는 `==` 로 안 맞는다.** 기록된 `Paint.color` 는 float32 를 거쳐 오므로
   `Color(0xFFFFD166)` 와 `==` 가 false 다(`paints..circle(color: …)` 가 계속 실패). `paints..something((m, args) => …)`
   에서 `color.toARGB32()` 로 비교해야 한다. 덤으로 `paints..rrect(color: …)` 는 **처음 만난 같은 종류의 호출**을
   검사하다 실패하므로(책상 채움 사각형), 특정 호출만 보려면 `something` 쪽이 맞다.
2. **`dart format` 을 돌리면 안 된다.** 이 저장소는 예전(짧은) 포매터 스타일로 쓰여 있어서 Dart 3.8+ 포매터가
   무관한 줄까지 다시 접는다(한 번 돌렸다가 `_insertNewline`·중첩 삼항 두 군데를 손으로 되돌렸다). 편집은 국소적으로만.
3. **-32004 를 앱에서 자연스럽게 만들기 어렵다.** 게이트를 앱이 먼저 지키므로, 이 에러는 "앱 상태가 데몬보다 낡았을 때"
   (팀장이 방금 살아났는데 `member.status` 가 아직 안 온 경우)에만 난다. 테스트도 그 상황(로컬로는 팀장이 exited)으로 만들었다.
4. **팀원 선택과 지시 대상은 다른 개념이다.** 사무실에서 팀원을 클릭하면 오른쪽 패널·퇴근 버튼은 그 팀원을 보여 주되
   지시 바만 팀장으로 돌아간다. `_target` 은 사용자가 고른 값 그대로 두고 **표시·전송 시점에만** 팀장으로 해석한다
   (그래야 팀장이 나갔을 때 원래 고른 팀원으로 자연스럽게 돌아온다).

## 결정

- **게이트를 앱에서도 강제한다(데몬 에러에 의존하지 않는다).** 01 §4 의 "지시 바 대상은 팀장 고정" 을 그대로 따른 것이고,
  실패를 보여 주는 것보다 애초에 잘못 보낼 수 없게 하는 쪽이 낫다. -32004 처리는 상태가 어긋났을 때의 안전망으로만 남겼다.
- **판정은 팀 단위**(멤버의 팀에 살아 있는 팀장이 있는가)로 했다. 화면의 활성 팀 하나로 판정하면 드롭다운에 다른 팀 멤버가
  섞여 있을 때 틀린다(데몬 게이트도 팀 단위다).
- **`force` 는 앱에 노출하지 않는다.** T24 결정("콘솔·디버깅용")을 그대로 지켰다 — 재시도 버튼도 두지 않았다.
- **팀장 표시는 배지 + 링 둘 다.** 배지만 두면 캐릭터가 줄에 서 있을 때(책상에서 떨어져 있을 때) 누가 팀장인지 안 보이고,
  링만 두면 색 구분이 상태 색과 헷갈린다.

## 남은 것

- **문 애니메이션(팀원 출근/퇴근, hire/dismiss by leader)** — T16 의 `starting` 문 입장·퇴장 걷기가 이미 있어 그대로 동작하지만,
  "팀장이 뽑은 멤버(`hiredBy:'leader'`)" 를 구분해 보여 주는 연출은 없다. T25(TeamTools hire/dismiss) 와 함께.
- **`waiting_reports` 는 아직 데몬이 보내지 않는다**(T28 파생 상태). 앱은 오면 그릴 준비만 됐다 — 실기동 확인은 T28 이후.
- **팀장 이름 필드의 기본값**은 값이 아니라 hint('팀장')다. 비워 두면 `leaderName` 을 아예 안 보내고 데몬 기본값을 쓰는
  T24 동작을 유지하려고 그대로 뒀다.
- **`lib/panel/**`** 은 이번에도 범위 밖(다른 에이전트 작업 중) — 오른쪽 패널의 팀장/보고 대기 표시는 손대지 않았다.
