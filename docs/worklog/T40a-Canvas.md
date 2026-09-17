# T40a — 레이아웃 v2: 사무실 캔버스 (T40-1 · T40-2 · T40-3 · T40-6)

- 날짜: 2026-09-17
- 마일스톤: M6
- 관련 설계: `docs/design/레이아웃-v2.md` §3 패스 1·2·4·6·7 / §6 T40-1·2·3·6 · 04-결정기록 D-42 / D-43
- 커밋: `98f0955`(T40-1) · `7cad447`(T40-2) · `a55a807`(T40-3) · `ded002b`(T40-6) · 이 문서
- 짝: T40b(오른쪽 패널·상단 바·지시 바)가 같은 리뷰의 나머지 절반을 병렬로 한다. 이 태스크는 `lib/office/**` 만 건드렸다.

## 목표

T37 사무실은 팀이 늘면 **세로로 줄어들기만** 했고(하한 0.45), 상태는 색 5종에 범례가 없었고, 내 책상은 텍스트 목록이었다.
이 태스크가 끝나면 사무실 캔버스가 레이아웃-v2 그림대로 움직인다 — **위는 세로 스크롤, 아래는 고정 바(내 책상 + 범례)**,
팀마다 색 카펫, 부장은 금색 카펫 + 왕관, 상태는 **13종 → 범례 7칸**이 한 함수로 매핑되고, 내 책상은 슬롯 4칸짜리
인박스 그림이 되며, 부서 0·부장만·출근·복구·퇴근 접기까지 빈 상태 연출이 붙는다. T33(스프라이트)이 꽂을 훅도 같이 냈다.

## 한 것

### 1. `lib/office/office_layout.dart` — 좌표계 둘 (T40-1)

- **콘텐츠 좌표**(스크롤): 책상 `deskRect` · 클러스터 상자 `clusters` · `seatCenter` · `visitorSpot` · `headCarpetRect`.
  **뷰포트 좌표**(고정): `doorRect` · `barRect` · `myDeskRect` · `slotCenter` · `legendRect` · 스크롤바.
  `scrollOffset` 이 0 이면 둘이 같다 — 기존 테스트·작은 부서는 예전과 똑같이 동작한다.
- 바닥 고정 바 = 내 책상 120 + 범례 24 (× scale). `viewportHeight = size.height - barHeight`,
  `contentHeight = max(viewportHeight, 마지막 줄 + 여백)`, `maxScroll`/`clampScroll`/`toContent`.
- 배율은 **폭만** 본다: `< 900` 은 `width/900`(하한 **0.6**), `900~1440` 은 1.0, `1440~2080` 은 선형으로 올라가 **1.5** 상한.
  패스 6 표(620 / 800 / 1440 / 2080)를 그대로 만족한다. 세로가 모자라면 축소가 아니라 **스크롤**.
- 폭 `≥ 1600` 이면 **5열**(`desksPerRow`). 열 간격은 화면 폭을 나누지 않고 `deskWidth + 24×scale` 로 고정 —
  그래야 왼쪽 정렬 클러스터가 폭과 무관하게 같은 모양이다.
- 클러스터: 폭 = `min(인원, 열 수)` 열 + inset, **왼쪽 정렬**, 두 개가 한 줄에 들어가면 나란히(줄 높이는 큰 쪽).
  전원 퇴근·빈 팀은 제목 줄만 남긴 **낮은 상자**.
- `visitorSpot(deskIndex, k)` · `reportSpot(k)` · `slotCenter/slotHitRect/overflowBadgeRect/slotAt` ·
  `clusterTitleAt`(제목 줄 클릭) · `hitTest(뷰포트 좌표, scene, placements, scrollOffset)` 추가.
- **T33 훅**: `spriteScale`(scale ≥ 0.75 → 2, 아니면 1 — 정수만) + `spriteCell(center)` / `spriteCellOf(deskIndex)`(32×32).

### 2. `lib/office/office_scene.dart` — 매핑 한 곳 (T40-2 · T40-6)

- **`LegendSlot`(7칸: 작업·한가·보고 대기·내 차례·대기·오류·퇴근) + `legendSlotOf(SceneMember)` 하나**가
  코드 상태 13종을 받아 색·아이콘·점선 여부를 정한다. 링 색·하단 범례·(T40b 의) 패널 상태 점이 전부 이 값을 쓴다.
- `SceneMember` 에 `derived` · `monitorSecond` · `askParentVisitorIndex` · `isShellWaiting` · `isResumed` 추가(전부 선택 인자 —
  손으로 장면을 만드는 기존 테스트는 한 줄도 안 바뀌었다). `deskLabel` 은 **이름만**, 번호는 `deskTooltip` 으로 옮겼다.
- `monitorTop`/`monitorBottom`(각 22자) + `monitorSecondLine()`(첫 줄과 같은 내용이면 둘째 줄을 만들지 않는다),
  `showsEngineBadge`/`showsRankLabel`/`showsMonitorSecondLine`/`rankBadgeAt`(글자 빼기 순서), `isResumeEvent`.
- `OfficeScene`: `myDeskHeader`("내 책상 · 대기 N") · `slotOverflow` · `slotEntry(k)` · `visitorsAt(desk)`.
- `OfficeScene.build` 에 `now` / `expandedTeamIds` / `reportCounts` 선택 인자 — 10분 지난 퇴근 책상 접기(`exitedFolded`),
  전원 퇴근 팀(`allExited`, 제목 "팀 X · 전원 퇴근 · 보고 N건"), 부장만일 때의 **점선 자리**(`isPlaceholder`).

### 3. `lib/office/office_painter.dart` — 그림 (T40-2)

카펫 6색 토큰 순환(팀 생성 순서) + 제목 태그(40% 밝게, -8px 걸침, 12px 굵게) / 부장 금색 카펫(+20px, 알파 0.12) + 왕관 도형 /
책상 라벨(이름 굵게 + 직급 + 엔진, 좁아지면 순서대로 빼기) / 모니터 2줄 / 오류 = 책상 테두리 빨강 / 복구 = 점선 테두리 /
퇴근 = 회색 책상 + 의자(캐릭터 원 없음) / 범례 7칸(24px · 11px · 점 8px, 보고 대기는 점선 링) /
내 책상(헤더 + 슬롯 4칸, 빈 칸 점선 실루엣, "+N" 배지) / 스크롤바 6px / 말풍선 정책(`showsBubble`).
스크롤 영역은 `clipRect + translate`, 바에 그려지는 캐릭터(슬롯 대기자·보고 방문자)는 클립 밖에서 따로 그린다.

### 4. `lib/office/office_view.dart` — 스크롤·클릭·연출 (T40-1 · T40-3 · T40-6)

- 스크롤을 위젯이 들고 있다(휠 `PointerScrollEvent` + 세로 드래그, `clampScroll`). **`main.dart` 는 건드리지 않았다.**
- `onSelectPending(pendingId)` · `onCreateDepartment` 콜백 추가(둘 다 선택 — T40b 가 배선한다).
- 탭 순서: 내 책상 슬롯/배지 → 클러스터 제목(퇴근 접기 토글) → 캐릭터/책상. 마우스 호버로 작업 말풍선.
- 복구 표시 3초 타이머(같은 이벤트로 다시 켜지지 않게 본 seq 를 기억), `officeReportCountsProvider`,
  `expandedExitedTeamsProvider`(앱 로컬).

### 5. `lib/office/office_motion.dart`

`MovementState.walkFor`(시간 못 박은 걷기) → 출근·재출근은 거리와 무관하게 **1.2초**. 목표 자리 규칙을
`hasSlot`(슬롯 4칸) · `showsAsVisitor`(최대 2명) 로 바꾸고, 보고 방문은 슬롯 대신 `reportSpot`.

### 6. 문서

`dev/app/README.md` 에 "사무실 캔버스 레이아웃 v2 (T40a)" 절 신설(좌표계·배율·카펫·라벨·범례·말풍선·내 책상·빈 상태·
스프라이트 훅·그리기 규칙) + 구조 트리·테스트 건수 갱신.

## 검증

```
$ flutter analyze
No issues found! (ran in 2.9s)

$ flutter test
00:13 +273 ~1: All tests passed!        (T40a 이전 193 → 273, +80. skip 1건은 기존)

$ flutter test test/office
00:03 +153 ~1: All tests passed!
```

테스트 파일별 건수(신규 4개 + 재작성 1개, 합 97건 — 이전 office 배치 테스트 17건을 포함해 갈아엎었다):

| 파일 | 건수 | 보는 것 |
|---|---|---|
| `test/office/office_layout_test.dart`(재작성) | 41 | 배율 4창·5열·스프라이트 배율 / 바·스크롤 높이·문 고정 / 클러스터 폭·나란히 / **1·4·8팀 × 폭 620·800·1440·2080 겹침 0**(12건) / 슬롯·보고 자리 / 스크롤 히트 테스트 / T37 회귀 |
| `test/office/office_legend_test.dart`(신규) | 14 | 범례 7칸 색·아이콘·점선, 13→7 매핑 7갈래, 글자 빼기 순서, 모니터 2줄 규칙, 복구 이벤트 판정 |
| `test/office/office_painter_test.dart`(신규) | 17 | 캔버스 호출을 직접 받아서: 카펫 6색·제목 태그 좌표·부장 카펫/왕관·오류 테두리·퇴근 의자·복구 점선·원 색=범례 색·범례 점 7개·"+N"·빈 슬롯 점선·스크롤바·**곡률 4px 단일·그림자/그라데이션 0** |
| `test/office/office_mydesk_test.dart`(신규) | 14 | 허가 6건 → 슬롯 4 + "+2", 5명째는 자기 책상, 동시 `ask_parent` 2명 안 겹침, 3명째 "+N", 슬롯·배지 클릭 콜백, 휠 스크롤(바는 고정·0~max 클램프), 최소 18px 클릭 목표 |
| `test/office/office_states_test.dart`(신규) | 11 | 부서 0 버튼·문구·콜백, 부장만 점선 자리, 출근 1.2초 + "(출근 중)" 노란 링 → 초록, 복구 3초, 퇴근 10분 접기·제목 클릭 토글, 전원 퇴근 낮은 상자, 보고 건수 집계 |

실기(창 캡처)는 **하지 않았다** — 지시대로 단위·위젯 테스트까지만. 통합 캡처는 T40b 와 머지한 뒤.

## 발견한 함정

1. **`Paint` 를 거친 `Color` 는 `==` 가 안 된다.** 페인터 테스트에서 `paint.color == OfficeColors.charWorking` 이
   같은 값인데도 전부 false 였다(출력은 글자 그대로 같다). `toARGB32()` 로 비교해야 한다. 값 객체라고 믿고
   테스트를 짜면 "안 그려졌다" 로 오진한다.
2. **`flutter_test` 의 `paints` 매처는 `void Function(Canvas)` 를 안 받는다**(`Object or closure painting:` 로 거절).
   CustomPainter 를 위젯 없이 검사하려면 `Canvas` 를 `implements` 한 작은 기록용 대역(`_Recorder`)을 쓰는 편이
   훨씬 쉽고, 호출 **횟수**까지 셀 수 있다(매처는 순서만 본다).
3. **좌표계를 둘로 나누면 "걸어가는 캐릭터" 가 애매해진다.** 책상은 스크롤되고 내 책상 슬롯은 고정이라,
   그 사이를 걷는 캐릭터는 두 좌표계를 가로지른다. 지금은 **슬롯 대기자·보고 방문자를 바 레이어에 그리고**
   나머지는 콘텐츠 레이어에 그린다 — 스크롤이 0 이면 완전히 같고, 스크롤 중에는 걷는 경로가 스크롤량만큼
   어긋난다(정지 상태는 언제나 정확). 실사용에서 거슬리면 T33 때 "걷는 동안만 콘텐츠 좌표로 보간" 으로 고친다.
4. **범례 점과 캐릭터 원이 같은 색이라 세다가 섞인다.** 페인터 테스트에서 "작업 파랑 원 1개" 를 셌더니 2개였다
   (범례 점이 같은 색). 반지름으로 갈랐다(캐릭터 ≥ 9, 범례 점 4).
5. **복구 표시가 영원히 깜빡였다.** 3초 타이머가 끝나 표시를 지우면 다음 빌드에서 "아직 `isResumed` 인 멤버" 를
   다시 켜서 무한 반복. **이미 보여 준 이벤트 seq 를 남겨** 두는 맵이 따로 필요하다(타이머 맵과 수명이 다르다).
6. **전원 퇴근 팀에는 `SceneMember` 자체가 없다.** "퇴근 책상 = 의자만" 테스트를 1인 팀으로 짰더니 그 팀이
   통째로 낮은 상자가 되어 책상도 캐릭터도 없었다(둘 다 맞는 동작이다). 퇴근 표현을 보려면 **살아 있는 팀원이
   남아 있는** 팀으로 테스트해야 한다.
7. **빈 슬롯 클릭이 남의 카드를 골랐다.** "+N" 배지 fallback 을 슬롯 전체에 적용했더니 빈 슬롯을 눌러도
   마지막 대기 건이 선택됐다. 빈 슬롯은 **아무 일도 하지 않는다**(선택을 지우지도 않는다)로 고정.
8. 픽스처 `event()` 의 `teamId` 는 `'t1'` 고정이다 — 팀별 집계(보고 N건) 테스트에서 팀 id 를 `t0` 으로 두면
   조용히 0 이 나온다.

## 결정

04-결정기록에 새로 적을 것은 없다(D-42·D-43 의 구현이다). 다만 스펙이 딱 떨어지지 않아 **가장 가까운 쪽으로 고른 것** 넷:

1. **클러스터 폭의 상한은 `min(인원, 4)` 가 아니라 `min(인원, 열 수)`.** 문서는 "min(인원, 4) 열" 인데 같은 문서가
   폭 1600 이상에서 5열을 쓰라고 한다 — 4 로 고정하면 5인 팀의 다섯 번째 책상이 상자 밖으로 나간다.
   4열 창에서는 두 규칙이 같다.
2. **내 책상은 바 왼쪽 정렬.** T37 은 "아래 가운데" 였지만 패스 1 의 그림이 왼쪽에 `[내 책상 · 대기 N] 슬롯 …` 을
   두고, 범례도 왼쪽부터 흐른다. 바 안에서 가운데로 띄우면 범례와 축이 어긋난다.
3. **보고 방문은 슬롯이 아니라 내 책상 오른쪽(`reportSpot`).** 옛 코드는 "줄 뒤 자리" 를 썼는데 슬롯 4칸이
   인박스 카드와 1:1 로 묶인 지금은 보고하러 온 부장이 남의 카드 자리에 서게 된다.
4. **배율 곡선**은 문서의 네 창 크기(620→0.6 이상 / 800→≈0.9 / 1440→1.0 / 2080→1.5)를 지나는 가장 단순한
   조각별 함수로 잡았다(900 미만 선형·900~1440 평평·1440~2080 선형). 문서에 곡선 자체는 없다.

## 남은 것

- **T40b 와의 접점 2개**(둘 다 이쪽은 선택 인자라 지금도 컴파일·동작에 문제 없음):
  `OfficeView.onSelectPending(pendingId)` — 인박스에서 그 카드로 스크롤, `OfficeView.onCreateDepartment` — 부서 만들기
  다이얼로그. `main.dart` 에서 넘겨 주면 끝난다(이번 태스크는 `main.dart` 무수정).
- 패널 상태 점은 `legendSlotOf` + `legendColor` 를 그대로 import 해서 쓰면 된다(T40b).
- 스프라이트는 아직 원이다 — `spriteScale`·`spriteCell` 훅만 냈다(T33).
- 실기 캡처(창 단위) 미실시 — 머지 후 통합 캡처에서 부장 카펫·카펫 색·범례·슬롯이 실제로 어떻게 보이는지 확인할 것.
  특히 함정 ③(스크롤 중 걷기 경로)과 카펫 색 위의 모니터 초록 대비는 눈으로 봐야 한다.
- 가로 스크롤·줌은 범위 밖(설계 §4). 5열보다 넓은 창은 여백으로 남는다.
