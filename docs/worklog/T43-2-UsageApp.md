# T43-2 — 사용량 표시 (앱)

- 날짜: 2026-09-21
- 마일스톤: M6
- 관련 설계: `docs/design/사용량-표시.md` §앱 · `docs/design/레이아웃-v2.md` §3 패스 1·4·6 · D-45
- 커밋: `141aedb` `e550ede` `a17facd` `de87316` (+ 문서 커밋)

## 목표

데몬(T43-1)이 내주는 `snapshot.usage` 와 `usage.engine` / `usage.member` 알림을 앱이 받아,
**엔진별 남은 주간 한도**(안 붙어 있으면 "연결 안 됨")와 **캐릭터별 컨텍스트·누적 토큰**을 네 곳에서 보여 준다:
상단 바 칩 · 사용량 팝오버 · 오른쪽 패널 한 줄 · 사무실 캔버스 경고 막대.
데몬 쪽은 다른 에이전트가 동시에 만들고 있어 **와이어 모양만 보고 가짜로** 구현·검증했다.

## 한 것

### ① 모델 + 상태 (`141aedb`)

- `dev/app/lib/model/usage.dart` — `EngineUsage{engine, connected, reason, plan, weekly, session, updatedAt}` ·
  `MemberUsage{memberId, engine, context, tokens, costUsd, updatedAt}` · `UsageWindow` · `ContextUsage` ·
  `TokenUsage` · `UsageSnapshot`. 파싱은 **필드마다 방어적**이다(설계: "CLI 가 업데이트되어 필드 이름이 바뀌면
  해당 값만 알 수 없음으로 떨어지고 나머지는 계속 돈다"): 없는 키·null·타입 불일치·파싱 실패는 그 값만 null,
  모르는 엔진 행은 통째로 버린다. `tokens.total` 이 없으면 네 항목 합, `context.percent` 가 없으면 `used/window`.
- `snapshot.dart` 에 `usage`(기본 `UsageSnapshot.empty`) 추가 — **옛 데몬에는 없는 키**라 없어도 된다.
- `state/office_state.dart` — `OfficeState.engineUsage` / `memberUsage`,
  `_applySnapshot` 병합 규칙(**엔진 행은 남기고**, 멤버 사용량은 멤버 행을 따라간다),
  `usage.engine` / `usage.member` 핸들러(비영속 — `lastSeq` 를 건드리지 않는다),
  `deleteDepartment` 에서 사라진 멤버의 사용량 정리.
- 프로바이더: `engineUsageProvider(engine)`(없으면 `EngineUsage.unknown`) · `engineUsagesProvider` ·
  `memberUsageProvider(id)` · `departmentUsageRowsProvider(deptId)`(컨텍스트 큰 순, 값 없는 사람 뒤, 같으면 createdAt).

### ② 포매터 (`141aedb`)

`dev/app/lib/usage/usage_format.dart` — 위젯 없는 순수 함수 묶음: 토큰 `999`/`358k`/`1.2M`(버림),
`remainingPercent`(100−used, 0~100), 리셋 `3일 뒤`/`5시간 뒤`/`12분 뒤`/`곧`, 절대 시각 `9월 24일 18:00`,
오래됨 `12분 전`(**10분 초과일 때만**, 아니면 null), 비용 `$1.84`, 칩 문구 3종 + 축약 2종, 툴팁 3종, 색 규칙 3종.

### ③④ 상단 바 칩 + 팝오버 (`e550ede`)

- `usage_chips.dart` — 데몬 pill 왼쪽에 칩 **항상 두 개**. 5종(기본·주황·빨강·연결 안 됨·측정 전),
  연결 안 됨은 회색 + **빈 원**(색만으로 구분하지 않는다 — 패스 6) + 이유별 툴팁.
- `usage_popover.dart` — 엔진마다 주간·5시간 막대 + 요금제 + 리셋(절대·상대) + 마지막 확인,
  아래 이 부서 캐릭터 표. 행 클릭 = 선택 + 닫힘. Esc · 바깥 클릭 · 닫기 버튼. 빈 상태 한 줄.
- `usage_bar.dart` — 공용 막대(곡률 4px, 그림자·그라데이션 없음).

### ⑤ 패널 한 줄 (`a17facd`)

`usage_line.dart` + `panel/right_panel.dart` 의 `PanelHeader` cwd 줄 아래. 늘 16px 한 줄이고,
좁아지면 꼬리(토큰 → 비용)만 말줄임한다. 툴팁에 정확한 값.

### ⑥ 캔버스 경고 막대 (`de87316`)

`SceneMember.contextPercent`(퇴근·오류는 null) → `OfficeLayout.contextWarningRect` →
`OfficePainter._paintDesk` 가 모니터 아랫변에 3px 단색 사각형. 색은 패널과 **같은 함수**(`contextWarningColor`).

### 문서

`dev/app/README.md` 에 "사용량" 절(와이어 전문 + 화면 네 곳 표 + 단위 규칙) · 구조 트리 · 상태 층 프로바이더 표 갱신.

## 검증

```
$ cd dev/app && flutter analyze
No issues found!

$ flutter test -j 2
00:46 +529 ~1: All tests passed!
```

기준선은 446 + 1 skip 이었다 → **새 테스트 83건**(모두 가짜 데몬/가짜 RPC 위에서).

| 파일 | 건수 | 보는 것 |
|---|---|---|
| `test/usage/usage_model_test.dart` | 15 | 와이어 예시 그대로 · 없는 키/null/타입 불일치 · 모르는 엔진·reason · 필드 이름 변경 · Codex(비용 없음) |
| `test/usage/usage_state_test.dart` | 11 | 스냅샷 적용 · 옛 데몬(키 없음) · 재접속(엔진 남고 멤버 정리) · 알림 2종 · 모르는 엔진/멤버 무시 · lastSeq 불변 · 표 정렬 |
| `test/usage/usage_format_test.dart` | 26 | 단위·문구·색 전부(경계값 포함) |
| `test/usage/usage_chips_test.dart` | 18 | 칩 5종 · 색 · 툴팁 · 알림 반영 · **1100px 축약** · 팝오버(막대·리셋·표 정렬·행 클릭·Esc·바깥 클릭·빈 상태) |
| `test/usage/usage_panel_test.dart` | 6 | Claude/Codex/값 없음 · 막대 색 3단 · 알림 · **420px 한 줄 유지** |
| `test/usage/usage_canvas_test.dart` | 7 | 69 없음 / 70 주황 / 90 빨강 / 퇴근·오류 없음 / 자리·두께 3px |

실기(데몬을 띄워 진짜 값으로 보는 것)는 **T43-3** 이다 — 이 태스크에서는 데몬도 앱 창도 띄우지 않았다.

## 발견한 함정

1. **상단 바에 긴 칩 두 개를 넣으면 넘친다.** 긴 꼴(`Claude 남음 45% · 3일 뒤`) 두 개는 300px 이 넘고,
   상단 바에는 이미 앱 이름·부서 탭·선택 멤버+퇴근·pill·"멤버 N · 대기 N"·보고 배지·"부서 만들기"·⋮ 가 있다.
   1400px 창에서 `RenderFlex overflowed by 160 pixels` 가 났다(기존 `top_bar_test`·`app_shell_test` 가 바로 잡아냈다).
   → 축약 경계를 **1500** 으로 두고(기본 1280·1400 창은 짧은 꼴, 1920 부터 긴 꼴), 덤으로 선택 멤버 이름을
   `Flexible` + 말줄임으로 바꿨다(긴 이름이 상단 바를 밀지 못하게). 짧은 꼴에서도 툴팁에 원문이 남는다.
2. **`▓░` 막대 글자를 쓰면 안 된다.** 설계 문구는 `컨텍스트 ▓▓▓░░░░░ 37%` 지만 번들 서체 3종
   (Galmuri11·Pretendard·D2Coding)에 그 글자가 없다 — T40 편차 ⑤ 와 같은 두부가 난다. 막대는 도형으로 그린다.
3. **`(j['engines'] as List?)` 는 문자열이 오면 던진다.** "방어적으로" 라고 써 놓고 캐스트 하나를 놓쳤다.
   `v is List ? v : const []` 로 바꿨다 — 테스트(`usage 가 딴 타입`)가 잡았다.
4. **전원 퇴근한 팀은 책상이 접힌다.** "퇴근한 멤버 → 막대 없음" 을 팀장 혼자 퇴근시켜 확인하려 했더니
   그 팀 클러스터가 통째로 "전원 퇴근" 낮은 상자가 되어 장면에서 멤버가 사라졌다(패스 2 이슈 7). 살아 있는
   팀장 + 퇴근한 팀원으로 바꿔야 "책상은 남는데 막대는 없다" 를 실제로 본다.
5. **위젯 테스트에서 `emitHello` 뒤 `pump()` 한 번으로는 부족하다.** 브로드캐스트 스트림이 리스너에 닿는 데
   한 프레임이 더 든다. `pumpAndSettle()` 을 쓴다(기존 `topbar_v2_test` 는 `pump()` 두 번으로 같은 일을 한다).
6. **테스트를 하나 돌릴 때 가짜 데몬을 루프 안에서 새로 띄우면 멈춘다.** 막대 색 3단을 데몬 3개로 확인하려다
   10분 타임아웃을 먹었다(`pumpPanel` 은 같은 테스트 안에서 overrides 목록이 바뀌는 것을 허용하지 않는다).
   데몬 하나에 `usage.member` 알림을 세 번 밀어 확인하는 쪽이 빠르고 정확하다.
7. `flutter test`(기본 동시성)에서 `panel_width_test` 가 한 번 `pumpUntil timeout` 으로 깨졌다가 단독·`-j 2` 로는
   통과했다 — T18 에 이미 적힌 부하성 플레이크다(코드 문제 아님).

## 결정

- 새 결정 번호는 만들지 않았다(전부 D-45 와 설계문서 §앱 안). 문서에 안 적혀 있어 여기서 정한 세 가지:
  1. **데이터가 아직 없는 엔진은 "연결 안 됨"(회색)이 아니라 "첫 작업 후 표시"** 로 둔다 —
     데몬이 기동 직후 `auth status` 를 묻기 전에 회색으로 깜빡이지 않게(`EngineUsage.unknown`).
  2. **칩 축약 경계 1500** (위 함정 1). 설계는 "좁으면 줄인다" 까지만 정했다.
  3. **곡률은 4px** — 옆의 데몬 pill 은 12px 이지만 새 표면은 패스 4 의 "곡률 4px 단일" 을 따랐다.
     pill 을 4 로 맞출지는 레이아웃 정리 때 같이 볼 일.

## 남은 것

- **T43-3 실기** — 진짜 데몬 + Claude 1 · Codex 1 로 한 턴씩 돌려 칩·패널·팝오버를 캡처하고,
  `PIXEL_CODEX_EXE` 를 없는 경로로 주어 "연결 안 됨" 을 확인한다. 와이어가 어긋나면 그때 맞춘다.
- 팝오버를 **키보드만으로** 여는 길이 없다(칩은 Tab 으로 포커스가 가고 Enter 로 열리지만 전용 단축키는 없다).
  필요하면 `AppShortcuts` 에 한 자리(`Ctrl+U` 등)를 내주면 된다.
- 팝오버는 상단 바 **오른쪽 위 고정**이다(누른 칩 아래로 따라가지 않는다). 칩 두 개가 붙어 있어 지금은 충분하다.
- 기간별 그래프·부서 합계·Codex 비용 추정은 설계 §범위 밖 그대로.
