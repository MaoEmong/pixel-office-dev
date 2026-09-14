# T12 — 사무실 캔버스 (CustomPainter)

- 날짜: 2026-09-15
- 마일스톤: M1
- 관련 설계: 01-설계문서.md §구성 요소 3 "Flutter 데스크탑"(캐릭터 상태 3중 표현, 내 책상, 문), §2 오피스 이벤트 스키마, §4 팀·직급 모델; `docs/design/office-sketch.html` 와이어프레임; 04-결정기록 D-09(CustomPainter)
- 커밋: (미커밋 — 오케스트레이터가 main.dart 배선 후 묶어서 커밋)

## 목표

T11 프로바이더만 보고 사무실을 그리는 위젯. 이 태스크가 끝나면 `main.dart` 의 `OfficeArea` 자리에 `OfficeView` 를 넣기만 하면 멤버마다 책상(라벨·엔진 배지·모니터 텍스트)과 캐릭터(원 + 이름 첫 글자 + 말풍선)가 그려지고, 허가/질문을 기다리는 캐릭터는 아래 가운데 "내 책상" 앞에 줄을 서며 내 책상 안에 대기 목록이 나온다. 탭하면 멤버 id 가 콜백으로 나가 오른쪽 패널(T13)·지시 바(T14)가 대상을 바꿀 수 있다. 이동 애니메이션은 T16 — 여기서는 즉시 배치.

## 한 것

이전 시도가 남긴 `lib/office/`·`test/office/` 를 검토해 이어서 완성했다(구조는 그대로, 아래 "발견한 함정"의 세 가지를 고침).

- `dev/app/lib/office/office_scene.dart` — 순수 Dart 장면 모델. 상태 층 맵(members / latestEvent / pending)을 화면에 필요한 값만 추린 불변 `OfficeScene{members: List<SceneMember>, queue: List<QueueEntry>}` 로 바꾼다. 값 비교(`==`) 가능 → 페인터 `shouldRepaint` 가 불필요한 repaint 를 거른다.
  - `OfficeScene.build({members, latestEvents, pending, teamId})` — 멤버는 `createdAt` 순(= 책상 번호), `teamId` 를 주면 그 팀 멤버와 그 멤버들의 pending 만(책상 번호는 팀 안에서 다시 매김), null 이면 전체.
  - 줄 서기: `status` 가 `waiting_approval` / `waiting_answer` 인 멤버만. 순서 = 열린 pending 의 `createdAt` 순으로 멤버가 처음 나타나는 순서, pending 없이 waiting 인 멤버는 그 뒤에 createdAt 순. pending 만 남고 status 가 working 으로 돌아간 멤버는 자리로.
  - `summarize(status, event)` — 모니터·말풍선 공용 한 줄: exited → `(퇴근)`, error 상태 → `⚠ 오류`(이벤트보다 우선); reading `📖 <basename>`, editing `✎ <basename>`, running `▶ <cmd 첫 줄 40자>`, thinking `…`, idle `(대기)`, waiting_approval `❗ 허가 대기`, asking `❓ 질문`, error `⚠ 오류`, text `💬 <text>`, delegating `→ 위임`, reporting `📋 보고`; 이벤트가 없으면 status 로(`(출근 중)`/`(대기)`/`…`/waiting 문구). `basename` 은 `/`·`\` 모두.
  - `isAlertFor` — waiting 상태이거나 마지막 이벤트가 waiting_approval/asking/reporting 이면 alert 말풍선(gone 이면 아니오).
  - `pendingLabel(Pending)` — `허가: <command|file_path|path|tool_name>` / `질문: <첫 질문>`. `QueueEntry.line(i)` = `"1. 이음 — 허가: rm -rf build/"`.
  - `SceneMember.bubbleText` = 요약을 rune 28자로 자르고 `…`.
- `dev/app/lib/office/office_layout.dart` — 순수 기하(`dart:ui` 만). `OfficeLayout(size, deskCount)`.
  - 책상 격자: 한 줄 4개, 필요한 만큼 줄. 기준 치수는 와이어프레임 그대로(책상 160×100, 캐릭터 r 14, 내 책상 260×110, 문 8×60).
  - `scale`: 너비 900 미만이면 `width/900`(하한 0.45); 줄이 많아 격자 + 줄 서는 띠 + 내 책상이 높이를 넘으면 세로에 맞춰 추가 축소. 글꼴은 `fontScale = scale.clamp(0.75, 1)`.
  - `deskRect(i)` / `monitorRect(i)` / `seatCenter(i)`(책상 아랫변에 걸친 원) / `seatBubbleAnchor(i)`(책상 위) / `myDeskRect`(아래 가운데) / `queueSlot(k)`(내 책상 위, 왼쪽부터) / `queueBubbleAnchor(k)`(홀수 번째는 `queueBubbleTier` 만큼 한 단 위 — 겹침 방지) / `doorRect`·`doorLabelPos`(왼쪽 가장자리 세로 중앙) / `emptyHintCenter`.
  - `placements(scene)` → `List<CharacterPlacement{memberId, center, bubbleAnchor}>`, `hitTest(p, scene)` → 캐릭터(반지름 +4 여유, 나중에 그린 것 우선) → 책상 → null.
- `dev/app/lib/office/office_painter.dart` — `OfficePainter extends CustomPainter`. 어두운 팔레트(`OfficeColors`, 바탕 0xFF1B1F2A 는 main.dart 와 동일), 평면 도형, 에셋 없음, 텍스트는 전부 `TextPainter`(maxLines 1, `…`). 그리기 순서: 바둑판 바닥 → 문 → 책상(라벨 "책상 N · 이름", 엔진 배지 Claude 주황/Codex 파랑 테두리, 모니터 = 검은 사각형 + 고정폭 초록 텍스트; 줄에 선 멤버의 모니터는 `(자리 비움)` 회색) → 내 책상(굵은 보라 테두리, "내 책상", 대기 목록 줄마다 구분선, 넘치면 `… 외 N건`, 없으면 `(대기 없음)`) → 빈 상태 힌트 "출근 버튼으로 캐릭터를 고용하세요" → 캐릭터(원 색: working 파랑 / idle 초록 / waiting 노랑 / starting 회색 / exited·error 진회색+회색 글자, 선택이면 흰 링) → 말풍선(연회색 몸통 + 꼬리, alert 는 굵은 주황 테두리 + 굵은 글씨, 화면 밖으로 안 나가게 가로 클램프; gone 멤버는 말풍선 없음).
  - `semanticsBuilder`: 책상마다 `"책상 N · 이름 · Claude · <요약>[ · 내 책상 줄]"`(button, selected), 내 책상 `"내 책상 · 대기 없음"` 또는 목록, 문 `"문"`. 위젯 테스트가 이 라벨로 검증.
  - `lastLayout` / `lastPlacements`: 마지막 paint 의 레이아웃·배치(테스트에서 참조). `shouldRepaint` = 장면 값이 다르거나 선택이 바뀔 때만.
  - `fontFamily`/`fontFamilyFallback`: 앱에서는 null(시스템 기본), 미리보기 렌더에서 FontLoader 로 올린 글꼴을 쓸 때만.
- `dev/app/lib/office/office_view.dart` — **`class OfficeView extends ConsumerWidget`**.
  - 생성자: `OfficeView({Key? key, String? selectedMemberId, ValueChanged<String?>? onSelectMember, String? teamId})`. `teamId` null = 전체 멤버.
  - 프로바이더(전부 `lib/office/` 안에서 파생, `lib/state` 는 안 건드림): `officeLatestEventsProvider`(`officeProvider.select(latestEvent)` — office_state 에는 멤버별 family `latestEventProvider(id)` 만 있어 맵 전체를 여기서 슬라이스), `officeSceneProvider(teamId)`(`Provider.family<OfficeScene, String?>` — `membersProvider` + `officeLatestEventsProvider` + `openPendingProvider` 를 watch 해 `OfficeScene.build`).
  - `LayoutBuilder` 로 크기를 받아 `CustomPaint(painter: OfficePainter)`, `GestureDetector.onTapUp` → `OfficeLayout.hitTest(localPosition)` → `onSelectMember(id | null)`.
  - `export 'office_scene.dart' show OfficeScene, SceneMember, QueueEntry;`
- 테스트 `dev/app/test/office/`:
  - `office_fixtures.dart` — `member()`, `event()`, `approval()`, `question()` 헬퍼.
  - `office_layout_test.dart` 11건 — 슬롯(4/줄, 열 정렬, 겹침 없음, 내 책상과 안 겹침, 1.0 배율 치수), 내 책상·문·줄 자리(+ 말풍선 단 번갈아), 축소(너비/세로), 배치(pending 순 줄), 히트 테스트(캐릭터→책상→null), 빈 장면.
  - `office_scene_test.dart` 12건 — summarize 전 kind, status 우선, 이벤트 없음, alert, basename/truncate, pendingLabel, createdAt 순·라벨·배지·말풍선 자르기, 줄 순서, pending 없는 waiting, **teamId 필터**, 값 비교.
  - `office_view_test.dart` 8건 — `officeProvider.overrideWith(() => FakeOfficeNotifier(state))` 로 데몬 없이: 멤버 2명 렌더(라벨·배지·running 모니터 요약), 시맨틱 라벨, waiting_approval 멤버가 내 책상 줄로 이동 + 목록 `"1. 모시 — 허가: rm -rf build/"`, 탭 → `['m1','m2',null,null]`, 빈 상태, 900 미만 축소, teamId 필터, shouldRepaint.
  - `office_preview_test.dart` — `OFFICE_PREVIEW_OUT=<폴더>` 를 주면 6명(작업·실행·허가 대기·대기·퇴근·질문) 장면을 1000×700 / 640×520 / 빈 상태 PNG 로 렌더(Windows 글꼴을 FontLoader 로 올림). 미설정이면 skip.

## 검증

```
$ cd dev/app && flutter analyze
Analyzing app...
No issues found! (ran in 3.6s)
```
(작업 도중 한때 `test/panel/panel_harness.dart` 의 `Override` 타입 오류 2건이 보였다 — T13 쪽 파일, 이 태스크 범위 아님. 최종 실행에서는 사라짐.)

```
$ flutter test test/office/
00:01 +31 ~1: All tests passed!
```
(~1 = OFFICE_PREVIEW_OUT 미설정으로 건너뛴 미리보기.)

```
$ OFFICE_PREVIEW_OUT=<scratch>/preview flutter test test/office/office_preview_test.dart
wrote <scratch>/preview/T12-office.png
wrote <scratch>/preview/T12-office-narrow.png
wrote <scratch>/preview/T12-office-empty.png
00:00 +1: All tests passed!
```

PNG 로 눈으로 확인한 것(이 태스크는 `docs/worklog/img/` 에 파일을 추가하지 않기로 해 임시 폴더에만 렌더; 위 명령으로 언제든 재생성):
- 1000×700: 책상 6개가 4+2 로 두 줄, 각각 "책상 N · 이름" + Claude/Codex 배지, 모니터에 `✎ tiles.dart` / `▶ flutter test tes…` / `(자리 비움)` / `(대기)` / `(퇴근)`. 캐릭터 원 + 첫 글자, 퇴근자는 회색, 선택된 "이" 에 흰 링. 허가 대기·질문 멤버 둘이 내 책상 앞에 줄, 말풍선 `❓ 질문`·`❗ 허가 대기` 가 한 단씩 엇갈려 겹치지 않음. 내 책상에 `1. 질문이 — 질문: 어느 폴더에 둘까요?` / `2. 이음 — 허가: rm -rf build/ && flutter build …`. 왼쪽 가장자리에 문 + "문".
- 640×520: scale 0.71 로 전부 축소, 오른쪽 책상이 화면 안에 들어옴.
- 빈 상태: 바닥 + 문 + 내 책상 `(대기 없음)` + 가운데 힌트만.

## 발견한 함정

- **이전 시도의 `office_preview_test.dart` 가 영원히 멈춤**: `FontLoader` 용 글꼴 파일을 `testWidgets` 본문에서 `await File.readAsBytes()` 했는데, 위젯 테스트는 FakeAsync 존이라 실제 IO 가 끝나지 않는다. 글꼴 로드도 `tester.runAsync` 안으로 옮겨 해결(첫 실행에서 300초 타임아웃으로 확인).
- **줄 선 캐릭터의 말풍선 겹침**: 줄 간격(2r + 14)이 말풍선 너비(70~90px)보다 좁아 `❓ 질문` 과 `❗ 허가 대기` 가 겹쳤다. 간격을 2r + 20 으로 넓히고 홀수 번째 말풍선을 `queueBubbleTier`(30·scale)만큼 올려 두 단으로 배치.
- 테스트 기본 글꼴(Ahem)은 네모만 그리므로 렌더 확인에는 Windows 글꼴(맑은 고딕·Segoe UI Emoji·Consolas)을 올려야 한다. 앱에서는 시스템 기본 글꼴이 한글·이모지를 폴백하므로 별도 지정 없음.
- `latestEventProvider` 는 family(id별)라 화면 전체 장면을 만들려면 `officeProvider.select((s) => s.latestEvent)` 로 맵을 통째로 봐야 한다 — `lib/state` 를 못 고치므로 `lib/office/office_view.dart` 에 `officeLatestEventsProvider` 로 둠.

## 결정

- 장면 모델(`OfficeScene`)을 페인터·레이아웃과 상태 층 사이에 두어 상태 층 형태 변화는 `OfficeScene.build` 한 곳에서만 흡수 — 새 결정 번호 없음(구현 구조).
- 줄 서기 판정은 pending 존재가 아니라 `member.status.isWaiting` 기준(pending 은 순서만). 상태 층이 status 변화 시 pending 을 지우는 T11 휴리스틱과 어긋나도 화면이 status 를 따르도록.

## 남은 것

- `main.dart` 배선: `OfficeArea` → `OfficeView(selectedMemberId:, onSelectMember:, teamId:)` (오케스트레이터).
- T16: 자리 ↔ 내 책상 이동 애니메이션(지금은 즉시 배치). `CharacterPlacement` 를 보간 대상으로 쓰면 된다.
- 와이어프레임의 "책상 4 · (빈 자리) / 고용 대기"(빈 책상 슬롯)는 그리지 않음 — 멤버 수만큼만.
- 대기 목록이 내 책상 높이를 넘으면 `… 외 N건` 으로 접음. 전체는 오른쪽 패널(T13).
