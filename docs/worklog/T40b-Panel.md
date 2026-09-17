# T40b — 레이아웃 v2: 오른쪽 패널 · 상단 바 · 지시 바 (T40-4 · T40-5)

- 날짜: 2026-09-17
- 마일스톤: M6
- 관련 설계: `docs/design/레이아웃-v2.md` §3 패스 1~6 · §6 T40-4/T40-5 · 04-결정기록 **D-42**
- 커밋: `3fbcafb`(T40-4) · `d3a3b67`(T40-5) · `<hash>`(문서)
- 짝: **T40a**(사무실 캔버스, `lib/office/**`)가 같은 브랜치 밖에서 병렬로 진행 — 이 worklog 는 패널·크롬 절반만 다룬다.

## 목표

레이아웃 v2 리뷰(T32/D-42)가 확정한 것 중 **오른쪽 패널·상단 바·지시 바·오버레이·키보드**를 구현한다.
끝나면 ① 허가·질문이 선택 멤버와 무관하게 한 곳(전역 인박스)에 모이고 ② 허가 카드가 "생각 없이 누를 수 있는"
요약 줄 + 주 버튼 둘이 되고 ③ 보고서가 카드 스택이 아니라 문서로 읽히고 ④ 패널 폭이 손에 맞게 움직이며
(터미널은 80열) ⑤ 데몬 상태가 한 줄로 설명되고 ⑥ 손이 키보드에서 떨어지지 않는다.

## 한 것

### T40-4 오른쪽 패널

1. **전역 인박스 — `lib/panel/inbox.dart` (신규, D6)**
   - `inboxItemsProvider(backfillMemberId)` = 사용자 몫 pending(`userInboxPendings`, `Pending.goesToUser`)
     + 만료 흔적(`globalRedoNeededProvider` ∪ 선택 멤버 백필의 `redoNeededProvider`)을 **오래된 순**으로.
   - `PendingInbox` 위젯: 헤더 `내 책상 · 대기 N` → 카드 2장(`inboxExpandedCards`) → `+N` 접힌 줄(클릭 펼침 / "접기").
   - `Alt+Y`/`Alt+N` 은 `HardwareKeyboard.addHandler` 로 인박스가 직접 듣고 맨 위 **허가** 카드에만 적용
     (질문 카드면 무시, 끊겨 있으면 무시). 맨 위 카드에 힌트 글자(`approvalShortcutHint`).
   - `inboxFocusProvider.focus(pendingId)` → 접혀 있으면 펼치고 `Scrollable.ensureVisible`.
   - `inboxCountProvider` 를 상단 바 "대기 N" 이 쓴다(화면 두 곳이 같은 수를 말하게).
2. **허가 카드 재설계 — `lib/panel/approval_summary.dart`(신규, 순수 함수) + `pending_card.dart`**
   - `approvalHeadline` / `approvalVerb` / `approvalTarget` / `isDangerousCommand` / `approvalMetaLine` /
     `approvalExpiryAt` / `formatExpiryClock` / `isApprovalExpirySoon` / `isApprovalExpired`.
   - 카드 골격(`_CardFrame`): 첫 줄(틴트 + `위험` 태그) · 오른쪽 위 메타 · 본문 · 버튼 · 푸터(단축키 힌트).
   - 명령은 3줄 클램프 + `전체 보기`(`Key('approval.command')` / `Key('approval.showAll')`).
   - 주 버튼 `허가`(채움 초록 `#7ED3A1`) · `거부`(테두리 빨강) 높이 32, 보조 둘은 오른쪽 끝 `TextButton`
     (폭이 모자라면 `Wrap` 으로 아래 줄).
   - 질문 카드도 같은 골격 + 옵션 버튼을 채움으로(주), 자유 입력은 보조.
   - `PendingCards(memberId)` 는 이제 **사용자 몫이 아닌** pending(= `ask_parent` 안내)만 그린다.
3. **만료 카드** — `RedoCard(expired: true)` 가 회색 `만료 — 재지시`(`redoExpiredTitle`). 인박스 안에 들어간다.
4. **보고서 탭 문서 흐름 — `report_tab.dart`**
   - `reportHeaderLine` / `splitReportBody`(코드·경로 줄만 고정폭) / `reportDateLabel` / 6줄 클램프 + `펼치기`.
   - `MemberReport.status`(reporting 이벤트의 `status`, 없으면 task 보고는 `done`).
   - 미확인 배지: `reportReadProvider`(멤버 → 읽은 seq) + `reportUnreadProvider`(전역 링의 `reporting` 수).
     `_PanelTabBar` 가 탭 변경을 듣고 보고서 탭에서 `markRead`.
5. **패널 폭·터미널 — `panel_splitter.dart` · `ui_prefs.dart`(둘 다 신규)**
   - `panelWidthProvider`(`PanelWidthState{preferred, terminalActive}`) — 420~720, 기본 480,
     `app-ui.json` 저장(`FileUiPrefsStore`, 테스트는 `MemoryUiPrefsStore`), 터미널 탭 열면 660.
   - `PanelSplitter(office, panel)` + `PanelDragHandle`(`DragStartBehavior.down`) + `TerminalOverlay`.
   - `terminalOverlayProvider` 가 켜지면 `RightPanel` 의 터미널 탭 자리는 안내 문구로 바뀐다.
6. **패널 헤더 상태 점** — `labels.dart` 에 `LegendCategory`(7칸) + `legendCategory(...)`,
   헤더 점이 그 색·모양(보고 대기는 외곽선 원)을 쓴다. `ask_parent` 로 기다리는 중이면 "내 차례" 가 아니라 "대기".
   `labels.dart` 에 팔레트 토큰(`panelFocusRing`, `panelScrollbar*`, `panelDanger*`)도 같이 뒀다.

### T40-5 상단 바 · 지시 바 · 오버레이 · 키보드

7. **`topbar/daemon_pill.dart`(신규)** — `daemonPillLabel`/`daemonPillColor` + `DaemonPill`(노랑 1Hz 점멸,
   `연결 중 · N초` 카운터) + `ReportCountBadge`.
8. **`topbar/disconnected_overlay.dart`(신규, main.dart 에서 분리)** — pill 과 같은 문구,
   `backoffForAttempt`(1→2→4→5초)로 채우는 진행 바, `데몬 시작`/`다시 연결`, 예외는 `자세히` 로만 펼침.
9. **`top_bar.dart`** — 부서 탭 폴더 아이콘, `대기 N` = `inboxCountProvider`, `보고 N` 배지(부장 미확인),
   옛 `_StatusChip` 삭제.
10. **`command_bar.dart`** — `TargetChip`(정적 `♛ <부장>에게` / 회색 `부장 없음`), placeholder 예시 문장,
    전송 스피너 최소 200ms(`Timer`, dispose 에서 취소), `commandBarFocusProvider`(Ctrl+K).
11. **`command/shortcuts.dart`(신규)** — `AppShortcuts` 가 Ctrl+K/L/T/I/R · Esc 를 묶는다. `shortcutHintLine`.
12. **`main.dart`** — `pixelOfficeTheme()`(포커스 링 2px `#CCFFFFFF`, 6px 스크롤바), `AppShortcuts`,
    `PanelSplitter`, `selectPendingFromOffice()`(T40a 배선 대기).

## 검증

```
$ flutter analyze
No issues found! (ran in 3.3s)

$ flutter test        # 착수 전 193건(+1 skip)
00:16 +260 ~1: All tests passed!
```

새 테스트 파일(건수는 `flutter test <파일>` 기준):

| 파일 | 건 | 덮는 규칙 |
|---|---|---|
| `test/panel/approval_summary_test.dart` | 14 | 동사 추출(파일·셸·기타) · 대상 · 위험 패턴(+`dart format` 오탐 없음) · 만료 계산/표기 |
| `test/panel/inbox_test.dart` | 9 | 선택 무관 · 오래된 순 · ask_parent/비부장 ask_user 제외 · 2장 + "+N" · Alt+Y/N(및 Alt 없이·질문 카드일 때 무시) · 만료 카드 · 스크롤 포커스 · 답하면 사라짐 |
| `test/panel/report_flow_test.dart` | 7 | 헤더 줄 · 본문 쪼개기(코드 펜스 포함) · 날짜 라벨 · 6줄 클램프 · `[TASK]` 틴트 블록 · 미확인 배지 |
| `test/panel/panel_width_test.dart` | 7 | 420~720 클램프 · 저장/복원 · 드래그 · 터미널 660 왕복 · Ctrl+T 오버레이(attach 한 곳) · `member.resize` |
| `test/panel/legend_test.dart` | 7 | 범례 7칸 매핑 전 분기 + 헤더 상태 점 |
| `test/command/overlay_test.dart` | 4 | backoff 계산 · pill 문구 · 진행 바(불확정 포함) · 예외 "자세히" 접힘 |
| `test/command/shortcuts_test.dart` | 5 | Ctrl+L/I/R · Ctrl+K nonce · Ctrl+T 토글 + Esc 우선순위 · 부장 없을 때 Esc |
| `test/command/topbar_v2_test.dart` | 4 | 폴더 아이콘·툴팁 · "대기 N" 이 사용자 몫만 · "보고 N" 배지와 클릭 · 부하 보고는 안 셈 |
| `test/command/theme_test.dart` | 3 | 스크롤바 6px · 포커스 링 2px 0.8 · 다크 단일 |
| `pending_card_test.dart` 에 추가한 그룹 | 6 | 3줄 클램프 토글 · 짧은 명령은 클램프 없음 · 만료 메타/회색 카드 · 위험 틴트 유무 · 버튼 높이 32 · 힌트 노출 조건 |

고친 기존 테스트: `pending_card_test`(제목·옵션 버튼 타입·인박스 순서), `right_panel_test`(인박스 배치·보고서 헤더),
`report_tab_test`(헤더 줄), `redo_card_test`(만료 카드가 인박스로), `member_gone_banner_test`("+N" 접힘),
`top_bar_test`(pill 3상태), `command_bar_test`(정적 칩), `panel_harness`(패널 기본 폭 380 → 480×700).

실행은 하지 않았다(지시대로 데몬·앱 창 없이 단위·위젯 테스트만). 통합 캡처는 T40a 와 병합한 뒤.

## 발견한 함정

1. **`ref` 를 `dispose()` 에서 쓰면 riverpod 3 이 던진다** — `Bad state: Using "ref" when a widget is about to or
   has been unmounted is unsafe.` `_PanelTabBar` 가 dispose 에서 `panelWidthProvider.notifier` 를 읽다가 트리 전체가
   깨졌다(테스트 9건 동시 실패). notifier 를 `didChangeDependencies` 에서 필드에 잡아 두고 dispose 는 그것만 쓴다.
2. **인박스가 세로로 커지면서 패널 Column 이 넘쳤다**(`RenderFlex overflowed by 36 pixels`).
   인박스가 자기 높이를 재면(내부 `ConstrainedBox` + 스크롤) 감싸는 쪽과 스크롤이 두 겹이 된다.
   → 인박스는 **높이를 재지 않는 Column** 으로 두고, `RightPanel` 이 `LayoutBuilder` 로 패널 높이의 55%
   (`inboxMaxHeightFraction`)까지만 주는 스크롤 영역을 만든다. `Flexible` + `Expanded` 를 한 Column 에 같이 쓰면
   loose 쪽이 덜 쓴 공간이 바닥에 빈칸으로 남으므로 쓰지 않았다.
3. **위젯 테스트의 기본 화면은 800×600** 이라 `pumpPanel(size: Size(480, 2000))` 같은 큰 상자는 그냥 넘친다.
   인박스 standalone 테스트는 `SingleChildScrollView(child: PendingInbox())` 로 감싸고, 접힌 줄을 누르기 전에
   `tester.ensureVisible` 을 한다.
4. **`tester.drag` 는 터치 슬롭 18px 를 먹는다** — 60 을 끌었는데 40 만 움직였다. 손잡이에
   `DragStartBehavior.down` 을 주면(실제로도 그게 맞다 — 잡은 지점부터 따라와야 한다) 그대로 들어온다.
   `touchSlopX: 0` 은 반대로 드래그가 아예 인식되지 않았다.
5. **`GestureDetector` 에 수평 드래그와 더블탭을 같이 달면 더블탭이 안 온다**(움직임 없는 탭도 드래그 인식기가
   아레나를 이긴다). "더블클릭 = 기본 폭" 은 테스트로 지킬 수 없어 **뺐다**.
6. **`Future.delayed` 로 스피너 최소 노출을 만들면 테스트가 "A Timer is still pending" 으로 죽는다.**
   위젯이 취소할 수 있는 `Timer` 필드로 바꾸고 dispose 에서 cancel.
7. **프로바이더는 게으르다** — `FakeRpcClient.emitHello()` 를 아무도 `officeProvider` 를 읽기 전에 부르면
   OfficeNotifier 가 아직 스트림을 구독하지 않아 스냅샷이 통째로 사라진다. 단축키 테스트에서
   `c.read(officeProvider)` 로 먼저 깨운다.
8. **같은 멤버에 `member.attach` 를 두 번 걸면 안 된다** — 나중에 죽는 쪽의 `member.detach` 가 살아 있는 쪽 구독을
   끊는다. Ctrl+T 오버레이가 열리면 패널 터미널 탭을 같은 프레임에 내려(안내 문구로 교체) attach 가 언제나 하나이게 했다.
9. **만료 흔적(`error{pendingId}`)은 전역 이벤트 링에만 있다** — 백필(`events.query`)은 선택 멤버 것만 불러오므로
   전역 인박스가 백필을 볼 방법이 없다. `PendingInbox(backfillMemberId:)` 로 선택 멤버의 백필만 추가로 합친다
   (pendingId 로 중복 제거).

## 결정

레이아웃 v2 문서가 이미 D-42 로 04 에 들어가 있어 **새 D-## 는 만들지 않았다**. 구현하며 문서가 정하지 않은
자잘한 갈래를 고른 것만 적는다(실사용에서 뒤집히면 그때 D-## 로).

1. **"fallback = 첫 토큰" 의 범위** — 문서의 동사 규칙은 셸에 대해 "못 하면 첫 토큰 그대로" 라고 했지만
   셸은 `실행` 이 이미 기본값이라 첫 토큰이 쓰일 자리가 없다. 그래서 첫 토큰 폴백은 **셸이 아닌 도구에 명령이
   있을 때**만 쓴다(예: `WeirdTool{command:'deploy --prod'}` → `deploy`). 셸은 삭제/푸시/쓰기/실행 넷.
2. **위험 패턴 `format` 은 줄 첫머리(또는 `;`/`&`/`|` 뒤)에서만** — 그냥 `\bformat\b` 로 잡으면 `dart format .`,
   `flutter format` 이 전부 빨개진다. 디스크 포맷만 잡는다.
3. **대상이 없으면 첫 줄은 `❗ Bash · 삭제`** — 문서 예시는 대상이 있는 경우뿐이다. `rm -rf build` 처럼
   경로 같은 토큰이 없으면 대상 자리를 비우고 동사만 남긴다(`· ·` 로 비는 칸을 만들지 않는다).
4. **보고 헤더의 `<status>`** — `reporting` 이벤트에 상태 필드가 없다. `detail.status` 가 있으면 그것,
   없으면 task 보고는 `done`, task 없는 보고는 생략하고 `작업 없음` 만 붙인다.
5. **`PendingCards(memberId)` 의 새 뜻** — "그 멤버의 pending" 이 아니라 "**사용자 몫이 아닌** 그 멤버의 pending".
   결과적으로 `ask_parent` 안내와, 옛 데몬이 보낼 수 있는 비-부장 `ask_user` 가 여기에 남는다.
6. **미확인 보고 수는 전역 이벤트 링의 `reporting` 만 센다** — `memberReportsProvider` 를 쓰면 상단 바가 부장의
   백필(`events.query`)을 유발한다. 배지 하나 때문에 RPC 를 부르지 않는다.
7. **읽음 표시는 세션 로컬**(앱을 껐다 켜면 0). 저장하는 앱 로컬 값은 패널 폭 하나뿐(`app-ui.json`).
8. **패널 폭 하한이 420 이라 위젯 테스트 하네스를 480×700 으로 올렸다**(전에는 380×600).
9. **범례 매핑 사본** — T40a 가 `office_scene.dart` 에 같은 함수를 내놓기 전까지 `labels.dart` 에 7칸을 둔다.
   코드에 `TODO(T40a 병합)` 을 박아 뒀고, 병합 때 한쪽을 지우면 된다.

## 남은 것

- **T40a 와의 배선 한 줄**: `main.dart` 의 `OfficeView(...)` 에 `onSelectPending: (id) => selectPendingFromOffice(ref, id)`
  를 넣어야 내 책상 슬롯 클릭이 인박스 스크롤로 이어진다. 함수와 `inboxFocusProvider` 는 이미 있고, TODO 주석 자리만 비워 뒀다.
- **범례 매핑 일원화**: `labels.dart` 의 `LegendCategory`/`legendCategory` ↔ T40a 의 `office_scene.dart` 사본 통합.
- **통합 캡처**: 병합 뒤 실제 창에서 인박스·pill·오버레이·터미널 오버레이 캡처(문서화 규칙 5, 창 단위).
- T40-1·2·3·6(사무실 캔버스·페인터·내 책상 슬롯·빈 상태 연출)과 T33(스프라이트)은 이 태스크 범위 밖.
- 패널 폭 저장 파일(`app-ui.json`)은 지금 `panelWidth` 하나만 쓴다. 퇴근 접기·클러스터 색 같은 앱 로컬 상태가
  늘면 같은 파일에 키를 더하면 된다.
