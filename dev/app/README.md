# pixel-office 데스크탑 앱 (Flutter, Windows)

데몬(`dev/daemon`)에 WebSocket 으로 붙어 사무실을 그리는 클라이언트. 와이어 계약은 `dev/daemon/PROTOCOL.md` 가 유일한 기준이다.

현재(M5 완료, 2026-09-17): **직무 체계 rev 3**(T37) — 상단 탭 = 부서, 사용자가 만드는 것은 부서(=부장 임명)뿐, 지시는 그 부서의 부장에게만,
사무실은 부장 책상 + 팀 클러스터, 내 책상에는 사용자 몫(허가 전부 + 부장 질문)만. 아래 "직무 체계 rev 3" 절이 요약이다.
여기에 **M5(T30·T31) 의 오류 표시**가 붙었다 — 세션이 죽으면 캐릭터가 **붉은 링 + `⚠ 오류` 말풍선**(퇴근은 여전히 회색·말풍선 없음)이 되고,
그 캐릭터를 누르면 오른쪽 패널 머리에 `⚠ 오류로 종료됨 (code N)` + **`재고용`** 배너가 뜬다. 누르면 `member.rehire` → `--resume` 으로
같은 문맥을 물고 되살아난다(T31 실기: 클릭 → `text: resumed` → 다음 지시 정상, `docs/worklog/T31-M5정리.md`).

## 실행

```
cd dev/app
flutter pub get
flutter run -d windows          # 개발 실행
flutter build windows --release # build\windows\x64\runner\Release\pixel_office.exe
flutter analyze && flutter test # 검증 (위젯·상태 340건)
```

데몬이 먼저 떠 있어야 한다(`cd dev/daemon && npm start`). 없으면 앱은 회색 오버레이 + "데몬 연결 안 됨" 을 보이며 1→2→4→5초 간격으로 계속 재접속을 시도한다("데몬 시작" 버튼은 T14).

## 엔진(Claude / Codex)

앱에는 **엔진별 분기가 없다.** `member.engine` 은 책상 배지(`Claude` / `Codex`)와 패널 헤더 칩에만 쓰이고, 이벤트·pending·터미널·지시 경로는
두 엔진이 같다(엔진 차이는 전부 데몬이 흡수한다 — `dev/daemon/PROTOCOL.md` §"엔진별 동작 차이"). T23 실기에서 같은 팀의 Claude 팀원과
Codex 팀원이 각자 책상·배지·터미널 탭(실제 Codex TUI)으로 보이는 것을 확인했다(`docs/worklog/T23-MixedTeam.md`).

## 직무 체계 rev 3 — 부서 · 부장 · 팀 (T37, D-32)

```
사용자 ──부서 만들기(부장 임명)──▶ 부장(head) ──create_team──▶ 팀장(lead) ──hire──▶ 팀원(member)
   ◀──── 보고·ask_user·허가 카드 ────┘        ◀── 보고·ask_parent ──┘      ◀── 보고·ask_parent ──┘
```

**사용자가 만드는 것은 부서뿐이다.** 팀·팀원은 부장·팀장이 만든다(앱에는 출근 버튼이 없다 — `member.clockIn`/`team.create` 는
`force:true` 뒤의 콘솔 전용 디버그 경로다, D-34).

- **상단 탭 = 부서**(`lib/topbar/selected_department.dart`: `selectedDepartmentIdProvider` / `activeDepartmentIdProvider`).
  "부서 만들기" 다이얼로그(이름 · 작업 폴더 cwd · 부장 엔진 · 부장 이름, 기본 `부장`) → `department.create` →
  응답의 `head` 를 바로 선택한다. 탭 오른쪽 `⋮` → "부서 삭제" → 확인 → `department.delete`(하위 트리를 잎부터 정리).
- **퇴근은 비상용으로만** 남겼다: 선택 멤버 옆 작은 버튼 → 확인 다이얼로그(경고 "비상용: 부장/팀장 퇴근 시 하위 전원이 정리됩니다")
  → `member.clockOut`.
- **지시 바**(`lib/command/command_bar.dart`): 대상이 **그 부서의 살아 있는 부장 하나로 고정**된다. 드롭다운에는 부장만 들어가고,
  살아 있는 부장이 없으면 비활성 + 안내(`commandBarNoHeadHint`). `-32004 부장에게만 지시할 수 있습니다 (head: <이름>)` 가
  오면 데몬 문구를 그대로 띄우고 `data.headId` 로 대상을 되돌린다 — `force` 는 앱에서 쓰지 않는다.
- **"살아 있는 부장/팀장" 판정**은 `departments.headId`/`teams.leaderId` 가 아니라 멤버 행의 `rank` + status 로 한다
  (데몬 `Store.liveHead`/`liveLead` 와 같은 규칙 — `liveHeadProvider(departmentId)` / `liveLeadProvider(teamId)`).
- **사무실 배치**(`lib/office/`): **부장 책상이 맨 윗줄 가운데**, 그 아래 팀마다 클러스터(제목 줄 "팀 t1 · 3명" + 팀장 책상 먼저,
  팀원 뒤). 팀 없는 멤버는 "미배정" 클러스터(정상 트리에는 없다). 배치 계획은 `OfficeScene.plan`(`OfficeDeskPlan`/`DeskCluster`)
  이고 `OfficeLayout` 이 그것으로 책상·클러스터 상자를 계산한다. 직급 배지는 "♛ 부장"(금색 `OfficeColors.headMark`) ·
  "★ 팀장"(은색 `leadMark`), 캐릭터에는 같은 색 링. 엔진 배지는 그대로.
  **레이아웃 v2(T40a, `docs/design/레이아웃-v2.md` · D-42/D-43)** 가 그 위에 올라간다 — 아래 절.
- **내 책상**에는 **사용자 몫만** 선다: 허가는 직급과 무관하게 전부(셸 허가는 안전 문제 — D-32), 질문은 부장의 `ask_user`
  (와 턴을 붙잡는 TUI `AskUserQuestion`). 판정은 `Pending.goesToUser(rank:)` 한 곳이다.
- **`ask_parent`(T35)** 질문(payload `{source:'ask_parent', question, options, from, to}`)은 상사에게 간 질문이라
  사용자 카드·줄에 나오지 않는다. 대신 그 멤버는 **직속 상사 책상 옆으로 걸어가** "❓ 상사에게 질문" 말풍선을 띄우고,
  질문한 멤버의 패널에는 안내 카드 `AskParentCard`("↑ 팀장/부장에게 질문 중")가 뜬다. 상사가 멈춰 있을 때를 위해
  "대신 답하기" 버튼으로 사용자가 `question.respond` 를 대신 보낼 수 있다(월권 경로).
- **오른쪽 패널 헤더**: `이름 · 엔진 칩 · 상태 점 + 상태` / `직급 · 상사: 이름(직급) · 직속 부하 N명`(`panelTreeLine`) / `부서 · 팀 · cwd`.
  부장이 아니면 "지시는 부장에게 — 이 멤버는 상사가 일을 줍니다 (터미널 직접 입력은 가능)" 안내가 붙는다.
  상태 점 색은 **범례 7칸**(아래 "레이아웃 v2" 절)을 따른다. 탭(로그·터미널·지시문·보고서)은 그대로다.
- **선택 멤버**는 `lib/state/selection.dart`(`selectedMemberIdProvider`). 멤버 행이 사라지면 선택이 자동 해제된다
  (퇴근은 행이 남으므로 유지).
- **다른 클라이언트가 지운 부서·팀**(콘솔 `dept delete` 등)은 데몬이 미는 `snapshot` 알림으로 사라진다(T38).
  `_onNotification` 의 `snapshot` 가지가 `hello` 와 **같은 `_applySnapshot`** 을 쓰므로 부서 탭·책상·pending·task 가 한 번에 맞춰진다
  (이벤트 링버퍼·말풍선은 유지). 재접속이나 수동 새로고침이 필요 없다.

### 사무실 캔버스 레이아웃 v2 (T40a — `lib/office/`)

기준 문서는 `docs/design/레이아웃-v2.md`(D-42 · D-43). 숫자는 전부 거기서 왔고, **색 토큰의 코드 쪽 단일 소스는
`OfficeColors`**, **상태 → 색 매핑의 단일 소스는 `office_scene.dart` 의 `legendSlotOf`** 다.

- **좌표계가 둘이다**(`OfficeLayout`): 스크롤되는 **콘텐츠**(책상·클러스터·자리·방문 자리)와 고정된 **뷰포트**
  (문·내 책상·범례·스크롤바). `scrollOffset` 이 0 이면 둘이 같다. 화면 = 위쪽 스크롤 영역 + **바닥 고정 바**
  (내 책상 120 + 범례 24, × scale). 스크롤은 `OfficeView` 가 들고 있다(휠·세로 드래그, `clampScroll` 로 0~`maxScroll`).
- **배율**은 폭만 본다(세로는 스크롤이 받는다): 하한 **0.6** · 폭 900 에서 1.0 · 1440 부터 커져 2080 에서 상한 **1.5**.
  폭 **1600 이상이면 5열**. 클러스터 상자 폭 = `min(인원, 열 수)` 열 + inset, **왼쪽 정렬**, 둘이 들어가면 한 줄에 나란히.
- **팀 카펫 6색**(`OfficeColors.carpets`, 팀 **생성 순서**로 순환) + 제목 태그(같은 색 40% 밝게, 상자 왼쪽 위 -8px, 12px 굵게).
  부장은 책상 크기는 그대로 두고 **금색 카펫(사방 +20px, 알파 0.12) + 왕관**으로 앵커한다(왕관 스프라이트는 T33).
- **책상 라벨은 이름만**(번호는 `deskTooltip`·시맨틱·로그). 좁아지면 **엔진 배지 → 직급 배지 글자(아이콘만) → 이름 말줄임** 순.
  모니터는 **2줄**(위: 명령/도구 `monitorTop`, 아래: 결과 요약 `monitorBottom`, 각 22자, scale < 0.7 이면 둘째 줄 숨김).
- **상태 13종 → 범례 7칸**: `LegendSlot`(작업 `#6C8EFF` · 한가 `#7ED3A1` · 보고 대기 초록 **점선** 📨 ·
  내 차례 `#FF9F43` ❗ · 대기 `#FFC857` ⏳ · 오류 `#FF6B6B` ⚠ · 퇴근 `#474D5E`) + `legendSlotOf(SceneMember)`.
  캐릭터 원 색·하단 범례가 이 함수를 쓰고, 오른쪽 패널의 상태 점도 **같은 함수를 import 해서 쓴다**
  (`office_scene.dart` 의 `legendSlotOf` + `office_painter.dart` 의 `legendColor`).
  오류는 책상 테두리도 빨강, 퇴근은 **회색 책상 + 의자만**(캐릭터 원 없음).
- **말풍선**: alert(내 차례·대기·오류·보고 방문·복구)는 항상, **작업 말풍선은 선택 멤버나 호버일 때만**(8명 화면이 말풍선 밭이 되지 않게).
  최대 28자 · 폭 180×scale · 2줄.
- **내 책상 = 인박스 그림**: 슬롯 **4칸**(오래된 것부터 왼쪽, 빈 칸은 점선 실루엣), 5명째부터는 자기 책상에 남고
  맨 오른쪽 슬롯 위 **"+N"**. 헤더 "내 책상 · 대기 N"(N = 전체). 슬롯·배지 클릭 = 그 멤버 선택 +
  **`OfficeView.onSelectPending(pendingId)`**(오른쪽 패널이 인박스에서 그 카드로 스크롤 — T40b 가 배선).
  `ask_parent` 로 같은 상사에게 몰리면 `visitorSpot(desk, k)` 가 `2r+8` 씩 벌리고 **최대 2명**, 3명째부터 "+N" 말풍선
  (오른쪽 끝이면 왼쪽으로 접는다). 보고 방문은 슬롯을 차지하지 않고 내 책상 오른쪽(`reportSpot`)에 선다.
- **빈 상태·연출**: 부서 0 → 가운데 큰 "부서 만들기" 버튼(**`OfficeView.onCreateDepartment`**, 다이얼로그는 상단 바 몫)
  + 한 줄 안내 / 부장만 → 점선 클러스터 자리 / `starting` → 문에서 **1.2초** 걸어와 앉고 모니터 "(출근 중)" · 노란 링 /
  복구(`text{summary:'resumed'}`·`[RESUMED]`) → 책상 점선 **3초** + `↻ 복구됨` / 퇴근 **10분** 뒤 클러스터 제목의
  **"퇴근 N"** 배지로 접힘(제목 줄 클릭 = 토글, `expandedExitedTeamsProvider` — 앱 로컬) /
  전원 퇴근 팀 → 제목만 남은 낮은 상자 "팀 X · 전원 퇴근 · 보고 N건"(보고 수 = `officeReportCountsProvider`).
- **T33 스프라이트 훅**: `OfficeLayout.spriteScale`(scale ≥ 0.75 → 2, 아니면 1 — **정수 배율만**, D-43 3) +
  `spriteCell(center)` / `spriteCellOf(deskIndex)`(32×32 셀, 지금은 원 중심과 같은 자리). 지금은 여전히 원을 그린다.
- 그리기 규칙: **곡률 4px 하나(`officeRadius`), 그림자·글로우·그라데이션 0** — 페인터 테스트가 이걸 고정한다.

## 레이아웃 v2 — 오른쪽 패널 · 상단 바 · 지시 바 (T40-4·T40-5, D-42)

전문은 `docs/design/레이아웃-v2.md`. 앱 쪽 요약:

### 전역 인박스 "내 책상 · 대기 N" (`lib/panel/inbox.dart`, D6)

**pending 의 주인은 하나다.** 오른쪽 패널 헤더 바로 아래 인박스가 사용자 몫 pending
(`Pending.goesToUser` — 허가 전부 + 부장 `ask_user` + TUI 질문) 전부를 **선택 멤버와 무관하게** 오래된 순으로 보여 준다.
사무실 내 책상의 슬롯·배지(T40a)는 같은 목록의 그림이고, 카드에 답하면 양쪽에서 같이 사라진다.

- 카드 **2장까지 펼치고**(`inboxExpandedCards`) 3장째부터 `+N` 줄로 접는다(클릭 = 펼침, "접기" 로 되돌림).
- 복구로 만료된 요청(`error{pendingId}`)은 회색 **"만료 — 재지시"** 카드(`RedoCard(expired: true)`)로 같은 목록에 섞인다.
  출처는 전역 이벤트 링 + **선택 멤버의 백필**(`PendingInbox(backfillMemberId:)` — 백필은 고른 멤버 것만 있으므로).
- 맨 위 카드에 **`Alt+Y` 허가 / `Alt+N` 거부**(카드에 힌트 글자). 인박스가 `HardwareKeyboard` 핸들러로 직접 듣는다
  — 목록 순서를 아는 쪽이 처리해야 해서. 맨 위가 질문 카드면 아무 일도 하지 않는다.
- `inboxFocusProvider.focus(pendingId)` → 그 카드로 스크롤(접혀 있으면 펼친다). 사무실 슬롯 클릭이 이걸 부른다
  (`main.dart` 의 `selectPendingFromOffice`).
- `PendingCards(memberId)` 에 남는 것은 이제 **그 멤버 몫이 아닌 카드**뿐이다 = `ask_parent` 안내("대신 답하기").
  인박스 아래 · 탭 위에 선다.

### 허가·질문 카드 (`pending_card.dart` + `approval_summary.dart`, D12)

```
❗ PowerShell · demo39-c.txt 쓰기   [위험]        요청 2분 전 · 내일 10:32 만료
클린 빌드가 필요해요                                  ← CLI description, 가변폭 13px
Set-Content demo39-c.txt -Value …                    ← 고정폭 12px, 3줄 클램프 + "전체 보기"
[ 허가 ]  [ 거부 ]              이번 세션 항상 허가 · 수정해서 허가
Alt+Y 허가 · Alt+N 거부                               ← 인박스 맨 위 카드에만
```

- **동사 추출**(`approvalVerb`): Write → 쓰기 / Edit·MultiEdit·NotebookEdit → 수정 /
  Bash·PowerShell → `Set-Content`·`Add-Content`·`Out-File`·리다이렉션(`>`/`>>`) → 쓰기, `rm`·`Remove-Item`·`del` → 삭제,
  `git push` → 푸시, 그 밖에는 실행 / 그 밖의 도구는 명령 첫 토큰(없으면 실행).
- **대상**(`approvalTarget`): `file_path|notebook_path|path` 의 마지막 조각, 없으면 명령의 마지막 "경로 같은" 토큰.
  둘 다 없으면 생략한다(`❗ Bash · 삭제`).
- **위험 패턴**(`isDangerousCommand`): `rm -rf`(`-fr` 포함) · `Remove-Item -Recurse` · `git push --force|-f` · `del /s` ·
  줄 첫머리 `format` → 첫 줄 배경 `#FF6B6B` 알파 0.15 + `위험` 태그. `dart format` 은 오탐이 아니다.
- **만료**: `createdAt + 86400초`(hook 보류 상한). 메타는 `요청 N분 전 · <오늘 10:32 | 내일 10:32 | 9/19 10:32> 만료`,
  남은 1시간부터 주황, 지나면 카드 전체가 회색 "만료 — 재지시".
- 질문 카드도 같은 골격 — 옵션 버튼이 주(채움), 자유 입력이 보조.

### 보고서 탭 — 문서 흐름 (`report_tab.dart`, 하드리젝션 ①)

카드 스택이 아니다. 보고 하나 = 헤더 줄 `보고 · 부장 · 23:08 · task#12 · done`(11px 회색) +
본문 **가변폭 14px / 행간 1.6**(코드·경로 줄만 고정폭 — `splitReportBody`), **6줄 클램프 + "펼치기"**,
보고 사이 1px 구분선, 날짜가 바뀌면 `2026-09-16` 구분선. `[TASK]` 지시는 왼쪽 세로선 대신 **배경 틴트 블록**.
**미확인 배지**: 마지막으로 보고서 탭을 연 뒤 도착한 `reporting` 수(`reportUnreadProvider`, 앱 로컬 `reportReadProvider`)를
탭 라벨 옆에 — 탭을 열면 지워진다. 상단 바 `보고 N` 은 그 부서 **부장**의 미확인 수다.

### 패널 폭 · 터미널 오버레이 (`panel_splitter.dart`, `ui_prefs.dart`)

- 드래그 손잡이로 **420~720**(기본 480), `%LOCALAPPDATA%\pixel-office\app-ui.json` 의 `panelWidth` 에 저장
  (300ms 모아서 쓰고 실패는 삼킨다). 테스트는 `uiPrefsStoreProvider` 를 `MemoryUiPrefsStore` 로 덮는다.
- **터미널 탭이 열려 있는 동안 660**(80열 × D2Coding 13px + 패딩 + 스크롤바)으로 자동 확장, 다른 탭으로 가면 원래 폭.
  이미 660 보다 넓으면 그대로 둔다.
- **`Ctrl+T`** = 사무실을 덮는 전체 폭 터미널 오버레이(Esc·닫기 버튼). 오버레이가 열리면 패널의 터미널 탭 자리는
  안내 문구로 바뀐다 — **같은 멤버에 `member.attach` 를 두 번 걸면 나중 detach 가 먼저 것을 끊기 때문**. 터미널은 한 곳에만 붙는다.
  크기가 바뀌면 `member.resize{cols, rows}` 는 그대로 나간다(`terminal_cache.dart` 의 `onResize`).

### 상태 범례 7칸 (`labels.dart` `legendCategory`, D-42 3)

| 칸 | 색 | 아이콘 | 포함 |
|---|---|---|---|
| 작업 | `#6C8EFF` | — | working · delegating · reporting |
| 한가 | `#7ED3A1` | — | idle · free |
| 보고 대기 | `#7ED3A1` 점선 | 📨 | waiting_reports |
| **내 차례** | `#FF9F43` | ❗ | waiting_approval · 부장 `ask_user` · TUI 질문 |
| 대기 | `#FFC857` | ⏳ | `ask_parent` 답 대기 · 셸 락 · starting |
| 오류 | `#FF6B6B` | ⚠ | error |
| 퇴근 | `#474D5E` | — | exited |

패널 헤더 상태 점이 이 표를 쓴다. 사무실 캔버스(T40a)도 같은 매핑을 써야 하며,
`office_scene.dart` 가 같은 함수를 export 하면 `labels.dart` 의 사본을 지운다(코드 안 TODO).

### 상단 바 · 지시 바 · 끊김 오버레이 (T40-5)

- **데몬 pill 3상태**(`topbar/daemon_pill.dart`): 초록 `데몬 v1.0 · pid 1234` / 노랑 1Hz 점멸 `연결 중 · N초` /
  빨강 `끊김 · 재시도 N회`.
- **끊김 오버레이**(`topbar/disconnected_overlay.dart`): pill 과 **같은 문구** + 다음 재시도까지의 진행 바
  (RpcClient backoff 1→2→4→5초, `backoffForAttempt`) + 주 버튼 **데몬 시작** / 보조 **다시 연결**.
  예외 문자열은 `자세히` 를 눌러야 펼쳐진다 — 첫 화면이 스택 트레이스면 안 된다(T39-8).
- **부서 탭**: 폴더 아이콘 + 이름(활성은 채운 폴더), 툴팁 cwd. 오른쪽에 `멤버 N · 대기 N`
  (대기 N = 인박스와 같은 수) 과 미확인 `보고 N` 배지(클릭 = 부장 선택 + 보고서 탭).
- **지시 바**: 드롭다운을 없애고 정적 칩 **`♛ <부장이름>에게`**(부장 없으면 회색 `부장 없음` + 입력 비활성).
  placeholder 는 예시 문장 `예: 이 저장소 구조를 파악해서 보고해`. 전송 스피너는 최소 200ms 보인다.
  `-32004` 처리(데몬 문구 그대로 + `data.headId` 로 대상 복구, `force` 안 씀)는 그대로다.
- **단축키**(`command/shortcuts.dart`, `AppShortcuts` 가 앱 전체를 감싼다):
  `Ctrl+K` 지시 바 포커스 · `Ctrl+L` 로그 · `Ctrl+T` 터미널 오버레이 토글 · `Ctrl+I` 지시문 · `Ctrl+R` 보고서 ·
  `Esc`(오버레이가 열려 있으면 닫고, 아니면 부장 선택으로 복귀). 단축키는 **포커스된 노드에서 위로** 올라오므로
  터미널·입력란이 먼저 먹은 키는 여기까지 오지 않는다. 인박스의 `Alt+Y`/`Alt+N` 은 인박스가 직접 듣는다.
- **포커스 링·스크롤바**: `pixelOfficeTheme()` 이 포커스 링 2px `#FFFFFF` 알파 0.8(`panelFocusRing`)과
  6px 팔레트 스크롤바(`panelScrollbarThickness`/`panelScrollbarThumb`)를 심는다.

### T29 결함 수정(T37)

- **③ 셸 대기가 안 보이던 것**: `running` 이벤트에 `detail.waiting`(예 `shell-lock`) 이 있으면 모니터·말풍선이 `cmd` 대신
  `summary` 를 "⏳" 를 붙여 보여 준다 — "⏳ 셸 대기 중 (락: 작가)".
- **④ 보고 방문이 끊기던 것**: 보고 직후의 `running{tool:'mcp__team__*'}` 은 보고에 딸린 뒷정리이므로 6초 방문을
  취소하지 않는다(`OfficeMotion.cancelsVisit`). 보통 도구(Bash 등)는 예전대로 취소한다.

③ 은 T39·T31 실기에서 화면으로 확인했다 — 셸 쓰기가 겹치면 대기 멤버 셋의 말풍선·모니터가 모두 `⏳ 셸 대기 중 (락: A장1)` 이 된다
(`docs/worklog/img/T31-5-shell-mutex.png`).

## 창 캡처 (worklog 증거용)

```
powershell -NoProfile -ExecutionPolicy Bypass -File tool\capture-window.ps1 -Out shot.png [-ProcessName pixel_office]
```

`PrintWindow(PW_RENDERFULLCONTENT)` 로 **그 창 하나만** 찍는다(전체 화면 캡처 금지 — 문서화 규칙 5). `-Out` 은 **현재 폴더 기준 상대 경로**로 줄 것
(절대 경로를 주면 `Join-Path` 에서 깨진다). 시연에서 앱 버튼을 눌러야 하면 합성 메시지(`PostMessage WM_LBUTTONDOWN`)는 Flutter 에 먹지 않는다 —
`SetForegroundWindow` → 위젯 안으로 몇 픽셀씩 **이동(hover)** → `mouse_event` 다운/업 순서여야 하고, 작은 위젯은 누르기 직전에 다시 캡처해
좌표를 잡아야 한다(T19 함정 6 · T29 함정 8 · T31).

## 구조

```
lib/
  main.dart                 MaterialApp(dark, pixelOfficeTheme) + AppShortcuts + TopBar / PanelSplitter(OfficeView · RightPanel) / CommandBar / DisconnectedOverlay
  rpc/
    daemon_info.dart        %LOCALAPPDATA%\pixel-office\daemon.json 읽기 (wsPort, token, pid, version …)
    rpc_client.dart         JSON-RPC 2.0 over WebSocket: connect / hello / call / 알림 스트림 / lastSeq / 자동 재접속
  model/
    department.dart team.dart member.dart office_event.dart pending.dart task.dart snapshot.dart   (store/types.ts 와 1:1, fromJson)
    models.dart             배럴
  state/
    office_state.dart       Riverpod 프로바이더 (아래 표)
    selection.dart          selectedMemberIdProvider (사무실·패널·지시 바가 공유하는 선택 멤버, T24b)
  topbar/
    top_bar.dart            부서 탭(폴더 아이콘) + 개수·"보고 N" · "부서 만들기"(부장 임명) · 부서 삭제 · 비상 퇴근
    daemon_pill.dart        데몬 상태 pill 3상태 + 상단 바 "보고 N" 배지(T40-5)
    disconnected_overlay.dart  끊김 오버레이 — 진행 바 · "데몬 시작"/"다시 연결" · 예외 "자세히" 접힘(T40-5)
    selected_department.dart  상단 부서 탭 상태(T37, T24 의 selected_team.dart 를 대체)
    daemon_launcher.dart notices.dart   데몬 시작 버튼(T14) · daemon.notice 배너
  office/                   사무실 캔버스(T12·T16·T37·T40a): office_scene/layout/painter/motion/view — 세로 스크롤 + 바닥 고정 바(내 책상·범례)
  panel/                    오른쪽 패널(T13·T15·T18·T26a·T37·T40-4):
    right_panel.dart          헤더(상태 점 = 범례 7칸) + 인박스 + 탭 4종(보고서 탭에 미확인 배지)
    inbox.dart                전역 인박스 "내 책상 · 대기 N"(2장 펼침 + "+N", Alt+Y/N, 스크롤 포커스)
    approval_summary.dart     허가 카드 첫 줄·동사·위험 패턴·만료 메타(순수 함수)
    pending_card.dart         허가/질문 카드, AskParentCard
    report_tab.dart           보고서 문서 흐름 + 미확인 배지 프로바이더
    panel_splitter.dart       사무실↔패널 드래그 분할 + Ctrl+T 터미널 오버레이
    ui_prefs.dart             앱 로컬 UI 설정(패널 폭 저장, 터미널 오버레이 상태)
  command/
    command_bar.dart          지시 바 — 대상은 그 부서의 살아 있는 부장 하나로 고정, 정적 칩(T37·T40-5)
    shortcuts.dart            앱 전역 단축키 Ctrl+K/L/T/I/R · Esc(T40-5)
test/
  fake_daemon.dart          dart:io HttpServer + WebSocketTransformer 로 만든 가짜 데몬(hello/replay/echo/fail/hang/push)
  rpc_client_test.dart      상관·에러 매핑·replay 중복 제거·재접속(since)·backoff
  model_test.dart           PROTOCOL/설계문서 예시 JSON 파싱
  office_state_test.dart    스냅샷 → 맵, member.status, event → 링버퍼/pending 파생, 재접속, **밀려온 snapshot**(T38)
  command/ office/ panel/ state/   위젯·배치·카드 테스트(T12~T40a — office/ 는 layout·scene·painter·legend·mydesk·states·motion·movement·view)
windows/runner/main.cpp     창 제목 "픽셀 오피스"
```

의존성: `flutter_riverpod`(상태), `web_socket_channel`(WS), `xterm`(터미널 탭, T13).

## daemon.json 은 어디서 읽나

`DaemonInfo.defaultPath()`:
1. 환경변수 `PIXEL_DATA_DIR` 이 있으면 `${PIXEL_DATA_DIR}\daemon.json`
2. 아니면 `%LOCALAPPDATA%\pixel-office\daemon.json` (`Platform.environment['LOCALAPPDATA']`)

데몬은 기동마다 token 을 새로 만들고 정상 종료 시 파일을 지우므로, `DaemonConnector.fromDaemonJson()` 은 **재접속 시도마다** 파일을 다시 읽는다. 파일이 없으면 그 시도는 "daemon.json 없음(데몬 미기동)" 으로 실패 처리되고 backoff 후 다시 본다.

## RPC 클라이언트 동작 (`lib/rpc/rpc_client.dart`)

- **봉투**: 요청 `{jsonrpc, id, method, params}` — id 는 1부터 증가하는 정수. 응답은 id 로 상관해 `Completer` 를 푼다. `error` 가 오면 `RpcException(code, message, data)` 로 throw. 응답이 `callTimeout`(기본 15초) 안에 안 오면 code `-2`, 도중에 소켓이 닫히면 code `-1`(대기 중이던 호출 전부).
- **연결 상태**: `disconnected → connecting → connected`. 소켓이 열려도 `hello` 가 성공해야 `connected`. `stateStream` 은 값이 바뀔 때만 흘린다.
- **hello**: `hello{token, since?, client:{name:'pixel-office', version}}`. 결과의 `snapshot.seq` 는 **응답 핸들러 안에서 동기적으로** `lastSeq` 에 반영한다 — 바로 뒤에 오는 replay `event` 보다 먼저.
- **lastSeq / 중복 제거**: `lastSeq = max(snapshot.seq, 통과한 event.seq)`. `event` 알림 중 `seq <= lastSeq` 인 것은 `events` 스트림으로 내보내지 않는다(재접속 규칙 2). 원본 알림 전부는 `notifications` 로 볼 수 있다(`term`, `member.status`, `daemon.notice`, `snapshot` 포함).
- **자동 재접속**: `start(urlProvider, tokenProvider)` 루프. 끊기면 backoff(1s → 2s → 4s → 5s 상한) 후 `connect` + `hello`. 한 번이라도 동기화된 뒤라면 `since = lastSeq` 를 넣는다. 성공한 hello 마다 `hellos` 스트림으로 `HelloResult` 가 나가므로 상태 층이 스냅샷을 다시 적용한다. `retryNow()` 로 대기를 건너뛸 수 있다("다시 연결" 버튼). 실패 횟수는 `reconnectAttempts` / `attemptStream`(실패마다 증가, 성공 시 0 — daemon.json 이 없어 소켓을 열지 못한 시도도 포함), 원인은 `lastError`.
- **term 은 replay 되지 않는다**(규칙 3). 터미널 탭(T13)은 재접속 후 `member.attach` 를 다시 불러 화면을 받아야 한다.

## 상태 층 (`lib/state/office_state.dart`)

`officeProvider` 하나가 `OfficeState` 전체를 들고, 나머지는 `select` 로 잘라 낸 파생 프로바이더다.

| 프로바이더 | 타입 | 내용 |
|---|---|---|
| `rpcClientProvider` | `RpcClient` | 앱 전체 하나. 테스트에서 override. |
| `daemonConnectorProvider` | `DaemonConnector` | url/token 공급자. 기본 daemon.json. |
| `officeProvider` | `OfficeState` (`OfficeNotifier`) | build 시 클라이언트 `start()`. `instruct`/`createDepartment`/`deleteDepartment`/`queryEvents`/`respondApproval`/`respondQuestion`/`applyEvent` 등 편의 메서드. |
| `connectionStateProvider` | `RpcConnectionState` | 상단 바·오버레이 |
| `daemonVersionProvider` / `daemonPidProvider` | `String?` / `int?` | hello 결과 |
| `reconnectAttemptsProvider` / `lastSeqProvider` | `int` | |
| `departmentsProvider` / `departmentProvider(id)` | `Map<String, Department>` / `Department?` | 스냅샷 `departments[]` — 상단 탭(T37) |
| `teamsProvider` / `teamsOfDepartmentProvider(departmentId)` | `Map<String, Team>` / `List<Team>` | 스냅샷. 부서별은 createdAt 순 |
| `membersProvider` | `Map<String, Member>` | 스냅샷 + `member.status`(행 삽입 포함) |
| `memberProvider(id)` / `memberStatusProvider(id)` / `derivedStatusProvider(id)` | family | 캐릭터 포즈용 |
| `membersOfTeamProvider(teamId)` / `membersOfDepartmentProvider(id)` | `List<Member>` | 클러스터·부서 화면 |
| `liveHeadsProvider` / `liveHeadProvider(departmentId)` | `Map<String, Member>` / `Member?` | 살아 있는 부장(rank head ∧ status ∉ {exited,error}) — **지시 게이트**(T37) |
| `liveLeadsProvider` / `liveLeadProvider(teamId)` | `Map<String, Member>` / `Member?` | 살아 있는 팀장(rank lead) |
| `childrenProvider(memberId)` / `parentProvider(memberId)` | `List<Member>` / `Member?` | 트리(`parentId`) — 패널 헤더의 상사·직속 부하 |
| `openPendingProvider` | `Map<String, Pending>` | 스냅샷 + `waiting_approval`/`asking` 이벤트로 추가, `error{pendingId}`·멤버가 waiting 을 벗어나면 제거 |
| `openTasksProvider` | `Map<int, Task>` | 스냅샷 + `instruct()` 로 추가, `reporting{taskId}`·멤버 exited/error 로 제거 |
| `globalEventsProvider` | `List<OfficeEvent>` | 링버퍼 2000 (오래된 → 최신) |
| `memberEventsProvider(id)` | `List<OfficeEvent>` | 멤버별 링버퍼 2000 |
| `latestEventProvider(id)` | `OfficeEvent?` | 말풍선 |
| `noticesProvider` | `List<DaemonNotice>` | `daemon.notice` 최근 50건 |

재접속 시 스냅샷은 departments/teams/members/pending/tasks 를 **교체**하고, 이벤트 링버퍼·말풍선은 유지한다.
데몬이 미는 `snapshot` 알림(T38 — 부서·팀 생성/삭제 때)도 **같은 경로**를 탄다: `_onNotification` → `_applySnapshot` →
없어진 행이 그 자리에서 사라진다. 그래서 콘솔에서 `dept delete` 를 해도 앱이 유령 탭을 들고 있지 않다.

`queryEvents({departmentId, memberId, beforeSeq, limit})` 는 `events.query` 래퍼다. **멤버 로그 백필은 `departmentId` 를
보내지 않는다** — T34 마이그레이션 이전 이벤트 행은 `department_id` 가 `''` 이라 부서로 거르면 옛 기록이 통째로 사라진다.
