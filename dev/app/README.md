# pixel-office 데스크탑 앱 (Flutter, Windows)

데몬(`dev/daemon`)에 WebSocket 으로 붙어 사무실을 그리는 클라이언트. 와이어 계약은 `dev/daemon/PROTOCOL.md` 가 유일한 기준이다.

현재(M5 완료, 2026-09-17): **직무 체계 rev 3**(T37) — 상단 탭 = 부서, 사용자가 만드는 것은 부서(=부장 임명)뿐, 지시는 그 부서의 부장에게만,
사무실은 부장 책상 + 팀 클러스터, 내 책상에는 사용자 몫(허가 전부 + 부장 질문)만. 아래 "직무 체계 rev 3" 절이 요약이다.
여기에 **M5(T30·T31) 의 오류 표시**가 붙었다 — 세션이 죽으면 캐릭터가 **붉은 링 + `⚠ 오류` 말풍선**(퇴근은 여전히 회색·말풍선 없음)이 되고,
그 캐릭터를 누르면 오른쪽 패널 머리에 `⚠ 오류로 종료됨 (code N)` + **`재고용`** 배너가 뜬다. 누르면 `member.rehire` → `--resume` 으로
같은 문맥을 물고 되살아난다(T31 실기: 클릭 → `text: resumed` → 다음 지시 정상, `docs/worklog/T31-M5정리.md`).

## 실행 · 수명 주기 (T46-2, D-47 · `docs/design/수명주기.md`)

```
cd dev/app
flutter pub get
flutter run -d windows          # 개발 실행
flutter build windows --release # build\windows\x64\runner\Release\pixel_office.exe
flutter analyze && flutter test # 검증 (위젯·상태 659건 +1 skip)
```

**데몬을 먼저 띄울 필요가 없다.** 앱이 주인이고, 데몬과 AI 세션은 앱의 부속으로 같이 켜지고 같이 꺼진다
(D-47 이 D-02 의 기본 동작을 뒤집었다). 코드는 `lib/lifecycle/`.

**켤 때**(`main()` → `DaemonSupervisor`)

1. `<데이터 폴더>/app.lock` 으로 **앱을 하나만** 켠다. 이미 켜져 있으면 `픽셀 오피스가 이미 실행 중입니다` 만
   보이고 끝낸다(창이 둘이면 한쪽을 닫을 때 다른 쪽의 데몬이 죽는다). 죽은 pid 의 낡은 잠금은 빼앗는다.
2. `daemon.json` 을 읽어 **2초** 동안 붙어 본다. 이미 도는 데몬이 있으면(콘솔에서 띄웠거나 지난번 것이
   남아 있으면) 새로 띄우지 않고 그대로 붙는다.
3. 못 붙으면 앱이 **직접, 콘솔 창 없이** 띄운다: `dev/daemon` 을 `findDaemonDir()` 로 찾아
   `package.json` 의 `scripts.start`(= `tsx src/index.ts`)를 **`node --import tsx src/index.ts`** 로 실행한다
   (npm 을 끼지 않아 프로세스가 하나다). 환경변수 둘을 넘긴다 — `PIXEL_PARENT_PID=<앱 pid>` 와
   **`PIXEL_DAEMON_LOG=<데이터 폴더>\daemon.log`**. 로그 파일은 기동 때 최근 1MB 만 남기고 자른다
   (뒤쪽을 남기므로 **직전 데몬이 죽은 까닭이 잘려 나가지 않는다** — T46-3 실측).
   - **콘솔 창이 왜 안 뜨나(윈도우 실측):** 콘솔이 없는 GUI 앱에서 `Process.start` 를 **기본 모드(파이프)**
     로 부르면 자식에게 콘솔 자체가 생기지 않는다(`GetConsoleWindow()` 가 0). `inheritStdio` 만 보이는
     콘솔 창을 만든다.
   - **그런데 파이프에 로그를 흘리면 안 된다(T46-3 실기):** 읽는 쪽이 앱 하나뿐이라, 앱이 `taskkill /F` 로
     죽으면 그 뒤 데몬의 `console.log` 한 줄이 **데몬의 이벤트 루프를 멈춘다**(write 가 영영 안 끝난다).
     그래서 **데몬이 `PIXEL_DAEMON_LOG` 에 직접** 쓰고 파이프에는 아무것도 흐르지 않는다. 앱은 파이프를
     계속 읽기는 한다 — node·tsx 의 네이티브 크래시는 console 을 안 거치고 fd 로 나오기 때문이다.
4. 붙을 수 있게 된 순간(감시자가 `running`) **재접속 backoff 를 즉시 깨운다**(`RpcClient.retryNow()`).
   이게 없으면 `daemon.json` 이 나온 뒤에도 앱이 자기 backoff(최대 5초)를 다 기다렸다(실측 3.8초 → 8.0초).
5. 오버레이는 `사무실을 여는 중…` → 붙으면 사라진다. **10초**(2 + 8) 안에 못 붙으면
   `데몬을 시작하지 못했습니다` + `daemon.log` 마지막 8줄 + `다시 시도`. 옛 `데몬 시작` 버튼(보이는 콘솔 창을
   띄운다 — 원인을 눈으로 볼 마지막 수단)은 **이 실패 화면에만** 남는다.

**데몬이 죽으면**(§4) 앱이 알아챈다 — 자식 종료 알림, 또는 소켓 끊김 + `daemon.json` 의 pid 가 죽어 있음.
**즉시 1회 → 2초 → 5초 → 10초, 최대 4회** 다시 띄운다. 그동안 오버레이는
`데몬이 멈춰 다시 시작하는 중 · 세션을 복구합니다`(+ `daemon.notice{kind:'recovering', total, done}` 이 오면
`복구 2 / 5`). **1분 안에 3번** 죽으면 재시작을 멈추고 `데몬이 반복해서 종료됩니다` + 로그를 보여 준다.

> **죽음을 세는 두 자리(T46-3).** `_watchChild` 는 **붙은 뒤에야** 달리므로, 그것만 보면 *띄우자마자 죽는*
> 데몬 — 즉 crash-loop 의 본모습 — 이 한 번도 세어지지 않는다(실기에서 3번 죽여도 실패 화면이 안 떴고
> 36초 뒤에 4번째 데몬이 떴다). 그래서 `_spawnOnce` 가 **스폰 직후부터** `exitCode` 를 지켜보다가 붙기 전에
> 죽으면 그것도 센다. 그리고 포기(`_abandoned`)가 정해지면 **돌고 있던 재시작 일정이 그것을 덮지 못한다**
> — `다시 시도` 만 그 깃발을 푼다.

**끌 때**(창 X · Alt+F4 · 작업 표시줄 — `AppLifecycleListener.onExitRequested`)

1. 일하는 중인 캐릭터(범례 "작업" 칸)가 있으면 확인 한 번:
   `일하는 중인 캐릭터가 N명 있습니다. 닫으면 전부 멈춥니다. (다음에 켜면 이어서 합니다)`. 없으면 안 묻는다.
2. 감시자를 멈추고 `daemon.shutdown` → `정리하는 중…` 을 띄운 채 데몬 프로세스가 사라질 때까지 **최대 8초**
   → 넘으면 `taskkill /PID <pid> /T /F` 로 트리째 끝낸다(손자 `claude.exe`·`codex.exe` 까지 간다).
3. 앱이 직접 띄운 데몬이 아니어도 똑같이 끈다 — 규칙이 하나여야 예측 가능하다.

**옛 동작(D-02)으로 돌리려면** — 상단 바 `⋮` → **"앱을 닫아도 계속 일하기"**(기본 꺼짐,
`<데이터 폴더>/app-ui.json` 의 `keepDaemonOnExit`). 켜면 앱을 닫아도 데몬과 세션이 남는다.
켠 채로 앱을 켜면 `PIXEL_PARENT_PID` 도 `hello{parentPid}` 도 보내지 않는다(부모 감시 자체가 안 켜진다).
**앱을 켠 뒤에 켰다면** 데몬은 이미 그 pid 를 들고 기동한 뒤라, 닫기 직전에 앱이
**`daemon.stopWatchingParent`** 를 보내 감시를 꺼 준다(T46-3 실기 — 이 말이 없으면 "계속 일하기" 인데도
데몬이 "부모가 사라졌다" 로 보고 사무실을 정리해 버렸다). 개발용으로는 환경변수 `PIXEL_KEEP_DAEMON=1`
(그 세션 내내 켜지고 메뉴에서 끌 수 없다). 데몬을 콘솔에서 따로 돌리며 앱을 껐다 켜고 싶을 때 쓴다.

**상태 하나 추가**: `members.status` 의 `suspended`(잠시 닫힘) — 정상 종료로 닫혔다가 다음 기동에 말없이
되살아날 캐릭터. 회색 책상 + 모니터 `(잠시 닫힘)`, 되살아나는 동안만 잠깐 보인다. **퇴근·오류가 아니라서
재고용 배너가 뜨지 않고 맡은 task 도 중단되지 않는다.**

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
  "부서 만들기" 다이얼로그(작업 폴더 · 이름 · 부장 이름 · 부장 엔진) → `department.create` →
  응답의 `head` 를 바로 선택한다. 탭 오른쪽 `⋮` → "부서 삭제" → 확인 → `department.delete`(하위 트리를 잎부터 정리).
  **폴더 선택 + 기본값(T41)** 은 아래 절.
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
  부장은 책상 크기는 그대로 두고 **금색 카펫(사방 +20px, 알파 0.12) + 왕관 스프라이트**로 앵커한다(T33).
- **책상 라벨은 이름만**(번호는 `deskTooltip`·시맨틱·로그). 좁아지면 **엔진 배지 → 직급 배지 글자(아이콘만) → 이름 말줄임** 순.
  모니터는 **2줄**(위: 명령/도구 `monitorTop`, 아래: 결과 요약 `monitorBottom`, 각 22자, scale < 0.7 이면 둘째 줄 숨김).
- **상태 13종 → 범례 7칸**: `LegendSlot`(작업 `#6C8EFF` · 한가 `#7ED3A1` · 보고 대기 초록 **점선** ✉ ·
  내 차례 `#FF9F43` ❗ · 대기 `#FFC857` ◷ · 오류 `#FF6B6B` ⚠ · 퇴근 `#474D5E`) + `legendSlotOf(SceneMember)`.
  캐릭터 링 색·하단 범례가 이 함수를 쓰고, 오른쪽 패널의 상태 점도 **같은 함수를 import 해서 쓴다**
  (`office_scene.dart` 의 `legendSlotFor`/`legendSlotOf` + `office_painter.dart` 의 `legendColor` — T40c 에 사본을 없앴다).
  오류는 책상 테두리도 빨강, 퇴근은 **회색 책상 + 의자 소품만**(캐릭터 안 그림).
- **말풍선**: alert(내 차례·대기·오류·보고 방문·복구)는 항상, **작업 말풍선은 선택 멤버나 호버일 때만**(8명 화면이 말풍선 밭이 되지 않게).
  최대 28자 · 폭 180×scale · 2줄.
- **내 책상 = 인박스 그림**: 슬롯 **4칸**(오래된 것부터 왼쪽, 빈 칸은 점선 실루엣), 5명째부터는 자기 책상에 남고
  맨 오른쪽 슬롯 위 **"+N"**. 헤더 "내 책상 · 대기 N"(N = 전체). 슬롯·배지 클릭 = 그 멤버 선택 +
  **`OfficeView.onSelectPending(pendingId)`**(오른쪽 패널이 인박스에서 그 카드로 스크롤 — `main.dart` 가 배선, T40c).
  슬롯 k 는 **인박스 카드 k 와 1:1** 이다 — 한 멤버가 카드 2장을 들면 그 멤버는 자기 첫 카드 자리에 서고
  나머지 칸은 카드만 있는 빈 슬롯으로 남는다(T40c).
  `ask_parent` 로 같은 상사에게 몰리면 `visitorSpot(desk, k)` 가 `2r+8` 씩 벌리고 **최대 2명**, 3명째부터 "+N" 말풍선
  (오른쪽 끝이면 왼쪽으로 접는다). 보고 방문은 슬롯을 차지하지 않고 내 책상 오른쪽(`reportSpot`)에 선다.
- **빈 상태·연출**: 부서 0 → 가운데 큰 "부서 만들기" 버튼(**`OfficeView.onCreateDepartment`**, 다이얼로그는 상단 바 몫)
  + 한 줄 안내 / 부장만 → 점선 클러스터 자리 / `starting` → 문에서 **1.2초** 걸어와 앉고 모니터 "(출근 중)" · 노란 링 /
  복구(`text{summary:'resumed'}`·`[RESUMED]`) → 책상 점선 **3초** + `↻ 복구됨` / 퇴근 **10분** 뒤 클러스터 제목의
  **"퇴근 N"** 배지로 접힘(제목 줄 클릭 = 토글, `expandedExitedTeamsProvider` — 앱 로컬) /
  전원 퇴근 팀 → 제목만 남은 낮은 상자 "팀 X · 전원 퇴근 · 보고 N건"(보고 수 = `officeReportCountsProvider`).
- 그리기 규칙: **곡률 4px 하나(`officeRadius`), 그림자·글로우·그라데이션 0** — 페인터 테스트가 이걸 고정한다.

### 스프라이트 (T33 — `lib/office/office_sprites.dart`, D-43)

캐릭터·소품은 **픽셀 아틀라스**다. `assets/sprites/characters.png` **256×96 = 32×32 셀 8열 × 3줄**:

| 줄 | 열 0..7 |
|---|---|
| 0 | 포즈 8종 — idle · type1 · type2 · think · alert · ask · report · error |
| 1 | 걷기 — 왼쪽 4프레임 · 오른쪽 4프레임(왼쪽의 **좌우 반전**) |
| 2 | 소품·아이콘 — 왕관 · 별 · 의자 + 봉투 · 모래시계 · 경고 · 느낌표 · 물음표 |

- **만드는 법**: `dart run tool/gen_sprites.dart` (순수 Dart, 의존성 0 — PNG 인코더 포함).
  `--preview=<path> --zoom=8 --bg=1B1F2A` 로 확대본, `--bounds` 로 소품의 실제 경계(= `SpriteProp.inCell`)를 찍는다.
  **왜 직접 그렸나**(D-43 4 는 Kenney CC0 우선이었다)와 라이선스는 `assets/LICENSES.md`.
- **포즈 매핑**: `spritePoseOf(SceneMember, visiting:)`. 입력이 **`LegendSlot`** 이라 링 색과 포즈가 같은 곳에서
  갈라진다(퇴근 → 캐릭터 없음 + 의자, 오류 → error, 보고 방문/reporting → report, `ask_parent` → ask,
  내 차례 → alert, 작업 → type(thinking 이면 think), 나머지 → idle).
- **애니메이션**: 타이핑 2프레임 **0.5초**(`typeFrameAt`), 걷기는 시간이 아니라 **걸어온 거리**(14px/프레임,
  `OfficeMotion.walkAt` → `walkFrameFor`), 방향은 출발→도착 dx 부호.
- **배율은 정수만**(D-43 3): `OfficeLayout.spriteScale`(scale ≥ 0.75 → 2, 아니면 1) × 32px 셀,
  `alignSpriteRect` 으로 왼쪽 위를 정수 픽셀에 맞추고 `FilterQuality.none` + `isAntiAlias: false`.
  텍스트·선은 연속 레이아웃 scale 을 그대로 쓴다(둘은 분리다).
- **외형**(D-43 5): 아틀라스에 셔츠 `#FF00FF` · 머리 `#00FFFF`(각각 그늘 키 하나씩)를 남겨 두고,
  불러올 때 픽셀 한 판으로 바꿔 **엔진 2종 × 이름 해시 머리색 4종 = 8벌**을 캐시한다
  (`SpriteSheet.load` ← `spriteSheetProvider`). 이름 해시는 FNV-1a(`String.hashCode` 는 실행마다 달라질 수 있다).
  직급은 **왕관/별 소품**으로만 구분한다.
- **링은 발치에**: 원이던 시절과 달리 스프라이트는 세로로 길고 머리가 좁아 같은 자리에 두면 링이 머리 옆으로
  삐져나온다. `OfficePainter.ringCenter` 가 링을 `spriteFeetDy`(셀 가운데 + 12 × 배율)로 내린다.
- **안전망**: `OfficePainter.sprites == null` 이면 **예전 원 + 머리글자**를 그린다 — 에셋을 읽는 첫 프레임과
  아틀라스를 안 넘긴 테스트·미리보기가 그 경로다.

### 서체 3종 (T33, 전부 OFL 1.1 — `assets/fonts/`)

| 쓰는 곳 | 서체 | 어디서 |
|---|---|---|
| 사무실 캔버스(라벨·말풍선·모니터) | **Galmuri11** | `office_painter.dart` `officeFontFamily` (페인터 기본값) |
| 오른쪽 패널·상단 바·지시 바 | **Pretendard** | `main.dart` `appFontFamily` → `ThemeData.fontFamily` |
| 터미널·고정폭 | **D2Coding** | `panel/labels.dart` `panelMonoFallback` (주 서체는 아직 Cascadia Mono) |

**폴백에 시스템 서체를 먼저 두지 않는다.** T40 편차 ⑤ 에서 `📨` `⏳` `♛` 가 전부 두부(□)로 나왔는데, 원인은
"시스템 서체에 있겠지" 였다 — Flutter Windows 의 시스템 폴백이 그 글자를 못 냈다. 그래서 캔버스는
`[D2Coding, Pretendard, Malgun Gothic]`, 패널은 `[D2Coding, Galmuri11, Malgun Gothic]` 순으로 **번들 서체끼리** 먼저
메운다(`♛` 는 D2Coding 에만, `❗` `❓` 는 Galmuri11 에만 있다). 세 서체 어디에도 없는 이모지는 아예 쓰지 않는다 —
`📨`→`✉` · `⏳`→`◷` · `📖`→`◫` · `📋`·`📄`→`▤` · `💬`→`❝`. 이 규칙은 `test/office/office_fonts_test.dart` 의
**허용 목록**이 지킨다(새 기호를 넣으면 테스트가 막는다).

캔버스 글자 크기는 `officeFontPx(base, fontScale)` 로 **정수 반올림**한다 — 픽셀 서체는 정수 크기에서만 또렷하다.
범례 아이콘·직급 배지는 글자가 아니라 **아틀라스에 그린 아이콘**이다(흰 실루엣 + `ColorFilter.srcIn` 으로 범례 색).

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
- **T40d ②**: 인박스 블록 하나가 `min(패널 높이 × 55%, 내용)` 높이를 가지고 **카드만 그 안에서 스크롤**한다
  (`RecoveryHint` · `PendingCards` 는 `PendingInbox(belowCards:)` 로 같은 스크롤 영역에). 헤더와 `+N`·"접기" 줄은
  스크롤 **밖**에 고정이라 접힘선 아래로 밀리지 않고, 탭은 언제나 그 아래에 보인다. 높이 상한이 없으면
  (감싸는 쪽이 스크롤을 주는 호출) 예전처럼 그냥 쌓는다.

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
  둘 다 없으면 생략한다(`❗ Bash · 삭제`). **T40d ③**: 토큰은 따옴표를 아는 `shellTokens` 로 끊고
  `stripTargetWrappers` 로 감싼 따옴표·괄호와 꼬리 구두점을 벗긴다 — `…ReadAllBytes("D:\x\t40-a.txt")` → `t40-a.txt`,
  `cat "a b.txt"` → `a b.txt`.
- **T40d ①**: 첫 줄은 **한 줄 고정**(`maxLines: 1`, 메타는 `Expanded` 뒤 — 전에는 `Spacer` 가 폭을 반 먹어
  `쓰 / 기` 로 접혔다). 폭이 모자라면 `fitApprovalHeadline(panelWidth:)` 가 **대상만 가운데 말줄임**하고
  (`t40-…txt`) 동사는 그대로 둔다. 글자 폭은 한글·이모지 2칸의 반각 칸(`displayColumns`)으로 센다.
- **위험 패턴**(`isDangerousCommand`): `rm -rf`(`-fr` 포함) · `Remove-Item -Recurse` · `git push --force|-f` · `del /s` ·
  줄 첫머리 `format` → 첫 줄 배경 `#FF6B6B` 알파 0.15 + `위험` 태그. `dart format` 은 오탐이 아니다.
- **만료**: `createdAt + 86400초`(hook 보류 상한). 메타는 `요청 N분 전 · <오늘 10:32 | 내일 10:32 | 9/19 10:32> 만료`,
  남은 1시간부터 주황, 지나면 카드 전체가 회색 "만료 — 재지시".
- 질문 카드도 같은 골격 — 옵션 버튼이 주(채움), 자유 입력이 보조.

### 보고서 탭 — 문서 흐름 (`report_tab.dart`, 하드리젝션 ①)

카드 스택이 아니다. 보고 하나 = 헤더 줄 `보고 · 부장 · 23:08 · task#12 · done`(11px 회색) +
본문 **가변폭 14px / 행간 1.6**(코드·경로 줄만 고정폭 — `splitReportBody`), **6줄 클램프 + "펼치기"**
(**T40d ④**: 원문 줄이 아니라 **표시 줄** 기준 — `clampReportBody` 가 `TextPainter` 로 재서 여섯째 표시 줄 끝에서
자른다. `SelectableText` 는 커서 자리만큼 좁게 접으므로 `reportBodyCaretGutter` 를 빼고 잰다),
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
- **T40d ⑤**: `CachedTerminal` 이 **데몬이 아는 크기**(`sentCols/sentRows`)를 기억하고 `syncSize` 한 길로만
  resize 를 보낸다. `attach` 응답이 오면 `markAttached` 가 알린 크기와 지금 뷰 크기를 맞춰 보고 어긋나면 그 자리에서
  보낸다 — attach 응답을 기다리는 사이의 크기 변화는 `onResize` 가 "아직 attach 전"이라 버리고 xterm 은
  **같은 크기로 다시 부르지 않기** 때문(`panel_width_test` 가 4판 중 1판 깜빡이던 원인).

### 상태 범례 7칸 (`office/office_scene.dart` `legendSlotFor`, D-42 3)

| 칸 | 색 | 아이콘 | 포함 |
|---|---|---|---|
| 작업 | `#6C8EFF` | — | working · delegating · reporting |
| 한가 | `#7ED3A1` | — | idle · free |
| 보고 대기 | `#7ED3A1` 점선 | 📨 | waiting_reports |
| **내 차례** | `#FF9F43` | ❗ | waiting_approval · 부장 `ask_user` · TUI 질문 |
| 대기 | `#FFC857` | ⏳ | `ask_parent` 답 대기 · 셸 락 · starting |
| 오류 | `#FF6B6B` | ⚠ | error |
| 퇴근 | `#474D5E` | — | exited |

매핑 함수는 **하나뿐이다**(T40c): `legendSlotFor({status, derived, eventKind, askingParent, shellWaiting, queued})`,
장면이 있는 사무실은 껍데기 `legendSlotOf(SceneMember)`. 색은 `office_painter.dart` 의 `legendColor(LegendSlot)`.
캐릭터 링·하단 범례·패널 헤더 상태 점·보고서 탭 배지가 전부 이 둘을 import 해서 쓴다
(`panel/labels.dart` 에 있던 사본 `LegendCategory`/`legendCategory` 는 지웠다).

### 상단 바 · 지시 바 · 끊김 오버레이 (T40-5)

- **데몬 pill 3상태**(`topbar/daemon_pill.dart`): 초록 `데몬 v1.0 · pid 1234` / 노랑 1Hz 점멸 `연결 중 · N초` /
  빨강 `끊김 · 재시도 N회`.
- **끊김 오버레이**(`topbar/disconnected_overlay.dart`): pill 과 **같은 문구** + 다음 재시도까지의 진행 바
  (RpcClient backoff 1→2→4→5초, `backoffForAttempt`) + 주 버튼 **데몬 시작** / 보조 **다시 연결**.
  예외 문자열은 `자세히` 를 눌러야 펼쳐진다 — 첫 화면이 스택 트레이스면 안 된다(T39-8).
- **부서 만들기 다이얼로그**(T41, `topbar/top_bar.dart` `CreateDepartmentDialog`): 작업 폴더를 **치지 않고 고른다**.
  - `폴더 선택…` 버튼 → `file_selector` 의 `getDirectoryPath()`(Windows 는 네이티브 `IFileDialog`). 칸 자체는
    그대로 편집 가능 — 경로 붙여넣기 폴백이 살아 있다.
  - **폴더가 실제로 있을 때만** `만들기` 가 켜진다(`Directory.exists`). 없으면 `그런 폴더가 없습니다 — "폴더 선택…"
    으로 고르세요`, 아직 안 골랐으면 버튼 옆에 `작업 폴더를 골라야 만들 수 있습니다`.
  - **기본값**: 부서 이름 = 고른 폴더 이름(`departmentNameForPath`), 부장 이름 = `부장`, 엔진 = `claude`.
    이름은 사용자가 고치기 전까지만 폴더를 따라간다(칸을 비우면 다시 따라간다). → **폴더만 고르면 한 글자도
    안 치고 만들 수 있다.**
  - 마지막으로 고른 폴더의 **부모**가 `app-ui.json` 의 `lastDepartmentDir` 에 남아 다음 선택기가 거기서 열린다
    (`panel/ui_prefs.dart` `lastDepartmentDirProvider`).
  - 테스트는 **네이티브 창을 절대 안 연다**: 선택기는 위젯 파라미터(`CreateDepartmentDialog(pickDirectory:)`),
    폴더 존재 확인은 `directoryExistsProvider` 로 갈아끼운다(위젯 테스트의 fake-async 존에서는 `dart:io` 의
    Future 가 영영 안 끝난다).
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

## 사용량 (T43-2, D-45 · `docs/design/사용량-표시.md`)

엔진별 남은 한도와 캐릭터별 컨텍스트·누적 토큰을 앱에서 본다. **앱은 계산하지 않는다** — 데몬이 주는
`usedPercent`(쓴 비율)를 받아 전부 **"남음 N%"** 로 뒤집어 보여 줄 뿐이고(D-45 3), 계정 이메일은 어디에도 없다(D-45 2).

**와이어**(데몬 T43-1 과 1:1, 없는 키·null·타입 불일치는 그 값만 "모름"으로 떨어진다):

```jsonc
// snapshot 에 추가 — 옛 데몬처럼 키가 없어도 된다
"usage": {
  "engines": [ { "engine": "claude", "connected": true, "reason": null, "plan": "max",
                 "weekly":  { "usedPercent": 55, "resetsAt": "2026-09-24T09:00:00Z" },
                 "session": { "usedPercent": 12, "resetsAt": "…" },   // 5시간 한도, 없으면 null
                 "models": [ { "label": "Fable", "usedPercent": 55, "resetsAt": "…" } ],  // 모델별 주간, 없으면 []
                 "updatedAt": "2026-09-21T10:12:03Z",
                 "source": "probe" } ],      // 'probe'(확인용 세션 화면) | 'turn'(턴 종료) | null
  "members": [ { "memberId": "m_…", "engine": "claude",
                 "context": { "used": 74210, "window": 200000, "percent": 37 },
                 "tokens":  { "input": 1200, "output": 5400, "cacheRead": 310000, "cacheCreate": 42000, "total": 358600 },
                 "costUsd": 1.84,            // Codex 는 null
                 "updatedAt": "…" } ]
}
// 알림(비영속 · seq 없음 · 바뀔 때만) — lastSeq 를 건드리지 않는다
{ "method": "usage.engine", "params": { …engines[] 한 원소… } }
{ "method": "usage.member", "params": { …members[] 한 원소… } }
```

- 모르는 엔진(`gemini` …) 행은 버린다. `connected:false` 의 `reason` 은 `not-installed` / `logged-out` / 그 밖은 `unknown`.
- `tokens.total` 이 없으면 네 항목의 합, `context.percent` 가 없으면 `used/window` 로 계산한다.
- **`models[].label` 은 CLI 가 준 문자열 그대로다**(실측값이 `Fable` 이었다 — 모델 이름이 아닐 수 있다). 앱은 해석하지
  않고 그대로 찍는다. 라벨이나 퍼센트가 없는 행만 버린다. Codex 는 언제나 빈 목록이고, 키가 없는 옛 데몬도 빈 목록이다.
- **`source` 는 팝오버에도 칩에도 안 쓴다**(지금은). 있는 그대로 모델에만 담아 둔다 — 값이 어디서 왔는지는
  사용자가 물어볼 질문이 아니고, 신선도는 `updatedAt` 이 이미 말한다.
- **엔진 행은 남고 멤버 행은 따라간다**: 재접속 스냅샷에 없는 엔진은 마지막 값을 그대로 두고(설계 스키마 v3),
  멤버 행이 사라지면 그 사용량은 지운다. 행이 없는 멤버의 `usage.member` 알림은 무시한다.

**화면 네 곳** (사용량은 참고 정보다 — 패스 1 시선 서열에서 허가 카드보다 아래, 평소엔 조용하고 위험할 때만 색이 든다):

| 자리 | 보이는 것 |
|---|---|
| 상단 바 칩 2개(데몬 pill 왼쪽) | `Claude 남음 45% · 3일 뒤` / `Codex 연결 안 됨` / `Claude · 첫 작업 후 표시`. 값이 10분 넘게 낡으면 꼬리에 `· 12분 전`. 색: 남음 >50 기본 · 20~50 주황 · <20 빨강 · 연결 안 됨 회색(빈 원) |
| 사용량 팝오버(칩 클릭) | 엔진마다 주간 막대 + **모델별 막대 한 줄씩**(주간 바로 아래, 들여쓰기 — 없으면 줄 없음) + 5시간 막대(없으면 줄 없음) + 요금제 + 리셋 `9월 24일 18:00 (3일 뒤)` + 마지막 확인, 아래 **이 부서 캐릭터 표**(이름·직급·엔진·컨텍스트 막대+%·토큰·비용) 컨텍스트 큰 순. 행 클릭 = 그 캐릭터 선택 + 닫힘. Esc·바깥 클릭·닫기 버튼 |
| 오른쪽 패널 헤더(cwd 줄 아래) | `컨텍스트 [막대] 37% (74k / 200k) · 토큰 358k · $1.84`. 막대 <70 기본 · 70~89 주황 · ≥90 빨강. Codex 는 비용 없음. 값 없으면 `사용량 — 첫 턴 뒤 표시` |
| 사무실 캔버스 | 컨텍스트 **≥70% 일 때만** 그 책상 모니터 아랫변에 3px 막대(주황/빨강). 그 아래는 아무것도 안 그린다 |

- 단위는 `lib/usage/usage_format.dart` 한 곳에서 만든다: 토큰 `999` / `358k` / `1.2M`(**버림** — 358,600 은 358k),
  리셋 `3일 뒤` / `5시간 뒤` / `12분 뒤` / `곧`, 오래됨은 10분을 넘겼을 때만, 비용 `$1.84`.
- 막대는 **도형**이다. `▓░` 같은 글자는 번들 서체 3종에 없어 두부가 된다(T40 편차 ⑤).
**좁은 창에서 글자를 빼는 순서** (패스 1 D7 "글자 빼기"). 상단 바가 이미 빽빽해서 긴 꼴 칩 두 개는 1400 창에서
실제로 넘쳤다. 어느 꼴에서든 **툴팁에 원문이 그대로** 있다.

| 폭 | 칩 | 상단 바 |
|---|---|---|
| 1500↑ | `Claude 남음 45% · 3일 뒤` | 그대로 |
| 1200~1500 | `Claude 45%` — "남음"·리셋·신선도만 뺀다 | 그대로 |
| 1200↓ | `Claude 45%` | 앱 이름(`픽셀 오피스`)과 "부서 만들기" 의 **글자**를 뺀다(버튼은 아이콘 + 툴팁) |
| 1000↓ | `C 45%` — 마지막 수단(지원 범위 밖의 안전망) | 〃 |

- **T43-4 에서 고친 것 둘**: ① 1500 아래의 짧은 꼴이 `C 45%` / `X 연결 안 됨` 이라 **무슨 글자인지 알 수 없었다**
  (기본 창 1280·1400 이 전부 그 꼴이었으니 사실상 늘 암호였다) → 엔진 이름을 마지막까지 지킨다.
  ② 선택한 캐릭터가 있으면 **최소 창(1100)에서 상단 바가 이미 넘치고 있었다**(옛 칩으로도 34px) →
  `topBarTightWidth`(1200) 아래에서 앱 이름과 버튼 글자를 뺀다. 레이아웃 테스트가 1100·1280·1400·1920 에서
  "칩 둘 + 긴 선택 캐릭터 이름 + 부서 탭 셋" 이 넘치지 않는 것을 지킨다.

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
  main.dart                 app.lock → "계속 일하기" 설정 → DaemonSupervisor.start() → MaterialApp(dark, pixelOfficeTheme)
                            + LifecycleGate + AppShortcuts + TopBar / PanelSplitter(OfficeView · RightPanel) / CommandBar / 오버레이
  lifecycle/                수명 주기(T46-2, D-47 · 위 "실행 · 수명 주기" 절):
    daemon_process.dart       데몬 띄우기(콘솔 창 없이) · daemon.log 1MB · tasklist 생존 확인 · taskkill /T /F
    daemon_supervisor.dart    attaching → starting → running → restarting → failed | stopped (시계·스폰 주입 = 단위 테스트 가능)
    exit_flow.dart            확인 → daemon.shutdown → 8초 → 트리 강제 종료(위젯을 모른다)
    lifecycle_gate.dart       AppLifecycleListener(onExitRequested) 배선 + 끊김을 감시자에게 알림
    lifecycle_providers.dart  감시자 상태 · 일하는 중 인원 · 오버레이 표시 조건 · daemon.log 꼬리
    app_lock.dart already_running_app.dart   앱 하나만(pid + 이미지 이름 가드)
  rpc/
    daemon_info.dart        %LOCALAPPDATA%\pixel-office\daemon.json 읽기 (wsPort, token, pid, version …)
    rpc_client.dart         JSON-RPC 2.0 over WebSocket: connect / hello / call / 알림 스트림 / lastSeq / 자동 재접속
  model/
    department.dart team.dart member.dart office_event.dart pending.dart task.dart snapshot.dart   (store/types.ts 와 1:1, fromJson)
    usage.dart              엔진·멤버 사용량(T43, D-45) — 방어적 파싱
    models.dart             배럴
  state/
    office_state.dart       Riverpod 프로바이더 (아래 표)
    selection.dart          selectedMemberIdProvider (사무실·패널·지시 바가 공유하는 선택 멤버, T24b)
  topbar/
    top_bar.dart            부서 탭(폴더 아이콘) + 개수·"보고 N" · "부서 만들기"(부장 임명) · 부서 삭제 · 비상 퇴근
    daemon_pill.dart        데몬 상태 pill 3상태 + 상단 바 "보고 N" 배지(T40-5)
    disconnected_overlay.dart  오버레이 6종(T40-5 → T46-2) — 여는 중 · 다시 시작 중(+복구 N/M) · 실패(+로그 8줄) ·
                            정리하는 중 · 감시자 없음(옛 화면). 예외는 어느 화면에서든 "자세히" 접힘
    selected_department.dart  상단 부서 탭 상태(T37, T24 의 selected_team.dart 를 대체)
    daemon_launcher.dart notices.dart   데몬 시작 버튼(T14) · daemon.notice 배너
  office/                   사무실 캔버스(T12·T16·T37·T40a·T33): office_scene/layout/painter/motion/view + office_sprites
                            — 세로 스크롤 + 바닥 고정 바(내 책상·범례), 캐릭터·소품은 32×32 픽셀 아틀라스
  usage/                    사용량 표시(T43-2, 아래 절): usage_format(순수 포매터·색) · usage_bar ·
                            usage_chips(상단 바 엔진 칩) · usage_popover · usage_line(패널 한 줄)
assets/
  sprites/characters.png    스프라이트 아틀라스(생성기 tool/gen_sprites.dart) — 출처·라이선스는 assets/LICENSES.md
  fonts/                    Galmuri11 · Pretendard(Regular/Bold) · D2Coding + OFL 전문 3개
tool/
  gen_sprites.dart          아틀라스 생성기(순수 Dart). `dart run tool/gen_sprites.dart`
  capture-window.ps1        창 단위 캡처(worklog 증거용)
  panel/                    오른쪽 패널(T13·T15·T18·T26a·T37·T40-4):
    right_panel.dart          헤더(상태 점 = 범례 7칸) + 인박스 + 탭 4종(보고서 탭에 미확인 배지)
    inbox.dart                전역 인박스 "내 책상 · 대기 N"(2장 펼침 + "+N", Alt+Y/N, 스크롤 포커스)
    approval_summary.dart     허가 카드 첫 줄·동사·위험 패턴·만료 메타(순수 함수)
    pending_card.dart         허가/질문 카드, AskParentCard
    report_tab.dart           보고서 문서 흐름 + 미확인 배지 프로바이더
    panel_splitter.dart       사무실↔패널 드래그 분할 + Ctrl+T 터미널 오버레이
    ui_prefs.dart             앱 로컬 UI 설정(패널 폭 저장, 터미널 오버레이 상태, 부서 폴더 선택기의 시작 폴더 T41,
                              "앱을 닫아도 계속 일하기" T46-2)
  command/
    command_bar.dart          지시 바 — 대상은 그 부서의 살아 있는 부장 하나로 고정, 정적 칩(T37·T40-5)
    shortcuts.dart            앱 전역 단축키 Ctrl+K/L/T/I/R · Esc(T40-5)
test/
  fake_daemon.dart          dart:io HttpServer + WebSocketTransformer 로 만든 가짜 데몬(hello/replay/echo/fail/hang/push)
  rpc_client_test.dart      상관·에러 매핑·replay 중복 제거·재접속(since)·backoff
  model_test.dart           PROTOCOL/설계문서 예시 JSON 파싱
  daemon_info_test.dart     daemon.json 경로 규칙(PIXEL_DATA_DIR / LOCALAPPDATA) + 못 찾았을 때의 진단 문구(T41)
  office_state_test.dart    스냅샷 → 맵, member.status, event → 링버퍼/pending 파생, 재접속, **밀려온 snapshot**(T38)
  app_shell_test.dart       T40c 접점 — OfficeShell 통째로: 슬롯 클릭 → 인박스 스크롤, 부서 0 버튼 → 부서 만들기 다이얼로그
  command/ office/ panel/ state/   위젯·배치·카드 테스트(T12~T41 — office/ 는 layout·scene·painter·legend·mydesk·states·motion·movement·view,
                            command/create_department_test.dart 는 폴더 선택기·기본값 T41)
  usage/                    사용량(T43-2): usage_model(방어적 파싱) · usage_state(스냅샷·알림·프로바이더) ·
                            usage_format(단위·문구·색) · usage_chips(칩 5종·축약·팝오버) · usage_panel · usage_canvas
  lifecycle/                수명 주기(T46-2): daemon_supervisor(가짜 시계로 재시작 일정·crash-loop) ·
                            daemon_process(node 로 진짜 자식을 띄워 로그·환경변수·트리 kill 확인) · app_lock ·
                            exit_flow · keep_daemon · overlay_lifecycle · hello_params · recovery_notice
windows/runner/main.cpp     창 제목 "픽셀 오피스"
```

의존성: `flutter_riverpod`(상태), `web_socket_channel`(WS), `xterm`(터미널 탭, T13),
`file_selector`(부서 작업 폴더 선택 — Windows 는 `file_selector_windows`, T41).

## daemon.json 은 어디서 읽나

`DaemonInfo.defaultPath()`:
1. 환경변수 `PIXEL_DATA_DIR` 이 있으면 `${PIXEL_DATA_DIR}\daemon.json`
2. 아니면 `%LOCALAPPDATA%\pixel-office\daemon.json` (`Platform.environment['LOCALAPPDATA']`)

데몬은 기동마다 token 을 새로 만들고 정상 종료 시 파일을 지우므로, `DaemonConnector.fromDaemonJson()` 은 **재접속 시도마다** 파일을 다시 읽는다. 파일이 없으면 그 시도는 "daemon.json 없음(데몬 미기동)" 으로 실패 처리되고 backoff 후 다시 본다.

### 안 붙을 때 (T41)

`%LOCALAPPDATA%` 는 **띄운 환경마다 다른 폴더**를 가리킨다. 실기 사고: 탐색기에서 띄운 앱이 `daemon.json 없음`
만 보여 줬는데, 파일은 다른 환경(샌드박스)에서 띄운 데몬의 `%LOCALAPPDATA%` 에 멀쩡히 있었다. 그래서 지금은
**어디를 봤는지**까지 말한다.

- 오류 문구(`daemonJsonMissingMessage()`, `rpc/daemon_info.dart`):
  `daemon.json 없음(데몬 미기동) — 찾은 곳: <경로> · PIXEL_DATA_DIR 없음 · LOCALAPPDATA 있음`.
  `RpcClient(noDaemonInfoMessage:)` 로 주입한다(rpc 층은 파일 경로를 모른다).
- 끊김 오버레이의 `자세히`: 오류가 없을 때도 열리고 안에 `daemon.json: <경로>` + 한 줄
  "데몬을 아직 안 띄웠으면 '데몬 시작' — 다른 환경(샌드박스·다른 사용자)에서 띄운 데몬은 이 경로에 파일을
  쓰지 않습니다". 접혀 있을 때는 예전처럼 아무것도 안 뿌린다.
- `데몬 시작` 은 `cmd /c start` 분리 실행이라 **종료 코드를 못 본다** → 6초(`daemonStartTimeout`) 뒤
  daemon.json 이 안 생겼으면 "데몬이 뜨지 않았습니다 — dev/daemon 콘솔 창의 오류를 확인하세요
  (포트 7420~7422 를 다른 데몬이 쓰고 있을 수 있음)".
- 확인 순서: ① 오버레이 `자세히` 의 경로에 파일이 있나 ② 없으면 `dev/daemon` 콘솔 창에 `이미 데몬이 돌고
  있습니다`(exit 3, 포트 충돌 포함 — `dev/daemon/README.md`) 가 찍혔나 ③ 앱과 데몬을 **같은 환경**에서 띄웠나
  (둘 다 탐색기 / 둘 다 같은 터미널). 정 안 되면 양쪽에 같은 `PIXEL_DATA_DIR` 을 주면 환경 차이가 사라진다.

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
| `engineUsageProvider(engine)` | `EngineUsage` | 스냅샷 `usage.engines` + `usage.engine` 알림. **없으면 null 이 아니라** `EngineUsage.unknown`(= "첫 작업 후 표시") |
| `engineUsagesProvider` | `Map<Engine, EngineUsage>` | 팝오버가 두 엔진을 한 번에 |
| `memberUsageProvider(id)` | `MemberUsage?` | 스냅샷 `usage.members` + `usage.member` 알림 |
| `departmentUsageRowsProvider(deptId)` | `List<DepartmentUsageRow>` | 팝오버 표 — 컨텍스트 큰 순, 값 없는 사람 뒤 |

재접속 시 스냅샷은 departments/teams/members/pending/tasks 를 **교체**하고, 이벤트 링버퍼·말풍선은 유지한다.
데몬이 미는 `snapshot` 알림(T38 — 부서·팀 생성/삭제 때)도 **같은 경로**를 탄다: `_onNotification` → `_applySnapshot` →
없어진 행이 그 자리에서 사라진다. 그래서 콘솔에서 `dept delete` 를 해도 앱이 유령 탭을 들고 있지 않다.

`queryEvents({departmentId, memberId, beforeSeq, limit})` 는 `events.query` 래퍼다. **멤버 로그 백필은 `departmentId` 를
보내지 않는다** — T34 마이그레이션 이전 이벤트 행은 `department_id` 가 `''` 이라 부서로 거르면 옛 기록이 통째로 사라진다.
