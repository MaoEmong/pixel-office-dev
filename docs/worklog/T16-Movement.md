# T16 — 내 책상·이동 애니메이션

- 날짜: 2026-09-15
- 마일스톤: M1
- 관련 설계: 01-설계문서.md §구성 요소 3 "Flutter 데스크탑"("내 책상" = 인박스: 허가·질문·보고가 있는 멤버는 걸어와 줄을 선다, alert 말풍선 = waiting_approval/asking/reporting, hire 는 문으로 입장·dismiss/퇴근은 문으로 퇴장); T12-OfficeCanvas.md(장면/레이아웃/페인터 분리, "이동 애니메이션은 T16")
- 커밋: (미커밋 — 오케스트레이터가 묶어서 커밋)

## 목표

T12 는 줄 서는 멤버를 내 책상 앞 자리에 즉시 놓았다. 이 태스크가 끝나면 캐릭터가 자리 ↔ 내 책상 줄을 **걸어서** 오가고(ease-in-out, 220 px/s, 최소 250 ms), 새로 출근한 멤버는 문에서 자리로 들어오며, 퇴근하면 문까지 갔다가 회색으로 자리에 돌아오고, `reporting` 이벤트를 낸 멤버는 내 책상으로 와서 "📄 보고" 말풍선을 6초 띄운 뒤 돌아간다. 작업 중인 캐릭터는 자리에서 살짝 흔들린다. 시맨틱·탭 판정은 보간된 위치를 따른다. 아무것도 움직이지 않으면 Ticker 가 멈춰 쉬는 동안 연속 repaint 가 없다.

## 한 것

`lib/office/**`, `test/office/**` 만 수정. `main.dart` 의 `OfficeView(selectedMemberId:, teamId:, onSelectMember:)` 호출은 그대로 컴파일된다(소스 호환).

- `dev/app/lib/office/office_motion.dart` — **새 파일, 순수 Dart**(`dart:ui` + 모델만). 위젯·Ticker 없이 `now: Duration` 을 인자로 받는다.
  - `MovementState { from, to: CharacterPlacement, startedAt, durationMs }` — `walk(from, to, now)` 는 거리/220 px·s, 최소 250 ms; `instant(at, now)` 는 duration 0. `at(now)` 가 원 중심·말풍선 꼬리 끝을 smoothstep(`t²(3−2t)`)으로 보간, `isDone(now)`.
  - `OfficeMotion` — 멤버별 `MovementState` 맵(끝난 이동의 `to` = 지금 서 있는 자리 → 위치의 단일 소스).
    - `sync(scene, layout, now)`: 멤버별 목표 자리를 정하고(보고 방문 중 → 줄 뒤 `queueSlot(queuedCount + 방문 순서)`, `isQueued` → `queueSlot(queueIndex)`, 그 외 → `seatCenter(deskIndex)`), 목표가 바뀐 멤버는 **지금 보간 위치에서** 새 목표로 걷기 시작(걷는 도중 재목표 포함). 같은 입력을 다시 줘도 아무것도 바꾸지 않는다(build 안에서 호출 가능).
    - 새 멤버: `status == starting` 이면 `layout.doorSpawn` → 자리 "입장", 그 외(스냅샷 복원 등)는 즉시 배치. 첫 sync 는 전부 즉시.
    - 퇴근(`isGone` 으로 전이): 현재 위치 → 문, 이어서 문 → 자리(`_nextLeg`; `advance(now)` 가 첫 구간이 끝나면 두 번째 구간을 시작). 회색 원·`(퇴근)` 모니터는 T12 그대로. gone → 살아남(재출근)은 문에서 다시 들어온다.
    - 보고 방문: `SceneMember.eventKind == reporting` 이고 `eventSeq` 가 이전에 처리한 seq 와 다르면 `ReportVisit{memberId, seq, order}` 시작(줄에 서 있거나 gone 이면 시작 안 함). 취소: 줄에 서게 되거나, gone 이 되거나, **idle/text 가 아닌** 새 이벤트(seq 가 다른 reading/editing/running/… )가 오면. 만료는 위젯이 `endVisit(id, now)` 로 알린다. `bubbleOverrides` = 방문 중 멤버 → `"📄 보고"`.
    - `bobAt(now)`: `working` 이고 이동이 끝난 멤버만 `1.5·sin(2π·t)` px. `needsTicker(now)` = 이동 중 ∨ working 멤버 있음.
    - `placementsAt(now)`(장면 순서), `reset()`(캔버스 크기 변경 시 전부 즉시 재배치).
- `dev/app/lib/office/office_view.dart` — `OfficeView` 가 **`ConsumerStatefulWidget`** 이 됨(생성자·필드 동일). `_OfficeViewState with SingleTickerProviderStateMixin`:
  - Ticker 하나. 틱마다 `_motion.advance` → `needsTicker` 가 거짓이면 `stop` → `setState`. 단조 시계 = `_clockBase + ticker elapsed`(Ticker elapsed 는 start 마다 0 이라 stop 할 때 base 로 접는다; 멈춘 동안 시간이 서지만 그땐 움직이는 게 없다).
  - `LayoutBuilder` 안에서 `_sync(scene, size)`: 크기가 바뀌면 `reset`, `OfficeMotion.sync`, 보고 방문 타이머 맞추기(멤버별 `Timer(reportVisitDuration)`; 방문 seq 가 바뀌면 다시 잼, 방문이 사라지면 cancel), `_ensureTicker`.
  - 페인터에 `placements: _motion.placementsAt(now)`, `bob`, `bubbleOverrides` 전달. 탭은 `layout.hitTest(pos, scene, placementsAt(now))` — 보간 위치 기준. `dispose` 에서 Ticker·타이머 정리.
  - `export 'office_motion.dart' show MovementState, OfficeMotion, ReportVisit, reportVisitDuration, reportVisitBubble;` 추가.
- `dev/app/lib/office/office_painter.dart` — 생성자에 `placements`(null 이면 T12 처럼 `layout.placements(scene)`), `bob`(id → dy), `bubbleOverrides`(id → 텍스트, 항상 alert 굵은 테두리) 추가. 자리를 비운 판정은 `isQueued` 대신 **지금 위치가 자리와 다른가**(`_isAway`) — 걷기 시작하는 순간부터 모니터가 `(자리 비움)`. 시맨틱 사각형도 away 면 지금 위치의 원, 라벨 접미사 ` · 내 책상 줄` / ` · 📄 보고`. `shouldRebuildSemantics` 는 장면·선택·placements·bubbleOverrides, `shouldRepaint` 는 거기에 `bob` 까지(흔들림은 시맨틱을 다시 만들지 않는다).
- `dev/app/lib/office/office_scene.dart` — `SceneMember` 에 `eventKind`, `eventSeq`(마지막 이벤트, 없으면 null) 추가(값 비교·hash 포함). 요약 규칙은 그대로.
- `dev/app/lib/office/office_layout.dart` — `doorSpawn`(문 바로 안쪽, 입·퇴장 지점) 추가.
- 테스트 `dev/app/test/office/`:
  - `office_harness.dart` — **새 파일**. `office_view_test.dart` 에 있던 `FakeOfficeNotifier` / `pumpHarness`(+`teamId`) / `painterOf` / `twoMembers` 를 옮기고 `settleMotion(tester)`(3초 pump ×2 — working 멤버가 있으면 흔들림 때문에 `pumpAndSettle` 은 못 쓴다) 추가.
  - `office_motion_test.dart` 12건 — **새 파일**, 순수. `MovementState`(2000 ms/440 px, 양끝, ease 대칭, 최소 250 ms, instant), 첫 sync 즉시 배치·재호출 무해, pending → 줄로/닫히면 복귀, 걷는 도중 재목표는 보간 위치에서, starting 새 멤버는 문에서/그 외 즉시, 퇴근 자리→문→자리 + 재출근, 보고 방문(줄 뒤 자리, 📄 보고, 같은 seq 중복 없음, idle 유지, endVisit 복귀, 새 seq 재방문, running 취소), 줄 서기·퇴근이면 방문 취소, bob(1 Hz ±1.5, 걷는 중엔 없음), 사라진 멤버 정리·reset.
  - `movement_test.dart` 8건 — **새 파일**, 위젯(가짜 시계 `tester.pump(Duration)`). pending → 시간에 따라 줄 자리로 가까워져 도착·닫히면 복귀·**정지 시 `tester.binding.hasScheduledFrame == false`**(걷는 동안은 true); 시맨틱 사각형·탭 판정이 보간 위치를 따름(걷는 캐릭터 탭 → id, 비운 자리·도착 전 자리 → null); starting 새 멤버 문 입장; reporting → 내 책상에서 📄 보고, 머무는 동안 Ticker 정지(타이머만), idle 이벤트 무시, 6초 뒤 복귀; 도중 editing 이벤트면 취소·남은 타이머 무해; 퇴근 문 왕복 후 회색 자리; working 멤버 있으면 Ticker 계속(bob 값 있음, placements 엔 안 섞임); 캔버스 크기 변경은 즉시 재배치.
  - `office_view_test.dart` — 하네스 import 로 교체, "waiting_approval 멤버는 내 책상 줄로" 는 `settleMotion` 후 자리 확인(즉시 배치 가정을 의도적으로 바꿈). 나머지 T12 검증은 그대로 통과.
  - `office_preview_test.dart` — `render` 에 `placements/bob/bubbleOverrides` 추가, `T16-office-walk.png`(이음 자리→줄 절반 지점, 신입 보고 방문, 하루 흔들림) 한 프레임 추가.

## 검증

```
$ cd dev/app && flutter analyze
Analyzing app...
No issues found! (ran in 3.9s)
```

```
$ flutter test test/office/
00:01 +51 ~1: All tests passed!
```
(~1 = OFFICE_PREVIEW_OUT 미설정으로 건너뛴 미리보기. T12 31건 → 51건: motion 12 + movement 8.)

```
$ flutter test
00:10 +124 ~1: All tests passed!
```
(command / panel / state / rpc 테스트 포함 — T15 와 병행 중인 `lib/panel/**` 은 손대지 않음.)

```
$ OFFICE_PREVIEW_OUT=<temp> flutter test test/office/office_preview_test.dart
wrote <temp>/T12-office.png … wrote <temp>/T16-office-walk.png
00:00 +1: All tests passed!
```
`T16-office-walk.png` 로 확인(파일은 임시 폴더에만): 이음(선택 링)이 책상 3 과 내 책상 줄 사이 허공을 걷는 중이고 `❗ 허가 대기` 굵은 테두리 말풍선이 따라온다; 책상 3·4 모니터 `(자리 비움)`; 신입이 줄 뒤(3번째 자리)에 서서 `📄 보고` alert 말풍선; 하루는 자리에서 흔들림.

## 발견한 함정

- **`getSemantics` 는 `SemanticsFinder` 를 받지 않는다** — `find.semantics.byLabel(...).evaluate().single` 로 노드를 얻어 `rect` 를 검사.
- **Ticker 의 시간을 그대로 시계로 쓰면 안 된다**: `Ticker.elapsed` 는 `start()` 마다 0 부터라, 멈췄다 다시 켤 때 진행 중 트윈의 `startedAt` 이 미래가 된다. `_clockBase` 에 접어 단조 시계로 만들었다. `SchedulerBinding.currentFrameTimeStamp` 는 프레임 밖(프로바이더 갱신 시점)에서 assert 라 못 쓴다.
- **보고 → idle 순서**: 데몬은 `reporting` 직후 `Stop`(idle) 이벤트를 낸다. "새 이벤트가 오면 방문 취소" 를 그대로 구현하면 방문이 도착 전에 끝난다. idle/text 는 취소 대상에서 뺐다(아래 결정).
- **흔들림 때문에 `pumpAndSettle` 불가**: working 멤버가 있으면 Ticker 가 계속 돌아 settle 이 타임아웃. 테스트는 `tester.pump(Duration)` 으로 명시적으로 진행한다(`settleMotion`).
- 걷는 동안 말풍선은 자리 앵커(책상 위)와 줄 앵커(머리 위) 사이를 보간하므로 중간엔 머리 위 60 px 쯤에 떠 있다 — 기능엔 지장 없고 아래 "남은 것".

## 결정

- 위치 상태를 위젯이 아니라 순수 `OfficeMotion`(now 인자) 에 두고 위젯은 시계·Ticker·Timer 만 — T12 의 "장면/레이아웃/페인터 분리" 를 이동에도 유지. 새 결정 번호 없음(구현 구조).
- 퇴근 표현: 문까지 걸어간 뒤 **회색으로 자리에 돌아와 앉는다**(T12 의 회색 책상 유지, 문 앞에 회색 원이 쌓이지 않음). 문에서 사라지는 표현은 나중에 필요하면.
- 입장 판정은 `status == starting`(데몬 clockIn 직후 상태)으로 — 스냅샷 복원으로 한꺼번에 나타나는 멤버가 줄지어 문으로 들어오지 않게. 그 외 새 멤버는 즉시 배치.
- 보고 방문 취소 조건: idle/text 이외의 새 이벤트, 줄 서기, 퇴근. (지시서의 "새 이벤트가 오면 취소" 를 좁힘 — 위 함정.)
- 방문 말풍선 텍스트는 `"📄 보고"`(지시서), 모니터 요약은 T12 의 `"📋 보고"` 그대로(T12 scene 테스트 유지).
- working 멤버가 하나라도 있으면 흔들림 때문에 Ticker 가 계속 돈다(지시서 3항 그대로). 사무실이 완전히 정적일 때만 멈춘다.

## 남은 것

- 걷는 동안 말풍선을 머리 위에 고정하고 자리에 앉는 순간 책상 위로 옮기는 게 더 자연스럽다(지금은 두 앵커 사이 보간).
- 직선 이동뿐(책상 사이를 통과함). 경로 찾기·문 쪽 우회는 스프라이트 도입 때 같이.
- 팀 전환(`teamId` 변경)으로 나타나는 멤버는 즉시 배치 — 의도.
- `T16-office-walk.png` 를 `docs/worklog/img/` 에 넣지 않았다(T12 와 같은 방침, 위 명령으로 재생성).
