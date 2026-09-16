# T26a — 멤버 지시문 편집 탭 (앱 쪽)

- 날짜: 2026-09-16
- 마일스톤: M4(선행 — 지시문 저장소·주입은 데몬 쪽 T26b 와 병행)
- 관련 설계: 01-설계문서.md §전제 7("멤버마다 자기 지시문이 있다") · §구성 요소 3 "Flutter 데스크탑"(오른쪽 패널 탭에 **지시문** — 저장 시 "다음 세션 시작부터 반영" 또는 "지금 재시작") · §멤버 지시문 주입(프로젝트의 CLAUDE.md/AGENTS.md는 건드리지 않는다) · §열린 질문 8-2(문서 편집기에 경고 문구), `dev/daemon/PROTOCOL.md`(`member.instructions.get{memberId}` → `{markdown}`, `member.instructions.set{memberId, markdown}`(다음 SessionStart 부터 반영), `member.restart{memberId}`(`--resume` 재스폰 + `[RESUMED]`)), worklog T13 · T15 · T18
- 커밋: (미커밋 — 이 태스크는 커밋하지 않음)

## 목표

오른쪽 패널에서 선택한 멤버의 `INSTRUCTIONS.md` 를 앱 안에서 바로 고친다. 탭을 열면 데몬에서 현재 지시문을 받아 오고, 고친 뒤 **저장 (다음 세션부터)** 또는 **저장하고 지금 재시작**(확인 후 `member.restart`) 을 고른다. 비어 있는 멤버에게는 직급(팀장/팀원)에 맞는 기본 템플릿을 한 번에 넣어 준다. 자리표시였던 "변경 파일" 탭이 이 탭으로 바뀐다.

## 한 것

전부 `dev/app/lib/panel/` · `dev/app/test/panel/` 안. `lib/main.dart`·`lib/state`·`lib/model`·`lib/rpc`·`lib/office`·`lib/command`·`lib/topbar`·`dev/daemon` 은 건드리지 않았다(배선 불필요 — 아래 "남은 것").

- `lib/panel/instructions_tab.dart` (신규)
  - **`InstructionsTab(memberId)`** — 위쪽 안내 한 줄 + 전체 높이 고정폭 편집기(`TextField(maxLines: null, expands: true)`) + 버튼 줄.
    - 안내(`Key('panel.instructions.hint')`, 상수 `instructionsHint`): "이 문서는 세션 시작·재개·/clear 때마다 이 멤버에게 주입됩니다. 프로젝트의 CLAUDE.md/AGENTS.md는 건드리지 않습니다."(설계 §멤버 지시문 주입 · 8-2)
    - **불러오기**: 첫 프레임 뒤 `member.instructions.get{memberId}` → `{markdown}`. **연결 전에는 부르지 않는다** — `RpcClient.call` 은 소켓이 없으면 즉시 `not connected` 로 실패하므로 `ref.listenManual(connectionStateProvider)` 로 연결(재접속)될 때 다시 시도한다(터미널 탭의 attach 와 같은 패턴). 실패하면 사유 + **다시 시도**(`panel.instructions.retry`).
    - **dirty 추적**: 마지막으로 불러오거나 저장한 값과 편집기 내용을 비교. dirty 면 **저장** 버튼이 열리고 "저장 안 됨"(`panel.instructions.dirty`) 이 뜬다.
    - 버튼: **저장 (다음 세션부터)**(`panel.instructions.save`) → `member.instructions.set{memberId, markdown}` → "저장했어요 — 다음 세션부터 반영됩니다" / **저장하고 지금 재시작**(`panel.instructions.saveRestart`) → 확인 다이얼로그(`panel.instructions.restartDialog`, 본문 "진행 중인 작업이 있으면 중단됩니다 …") → `set` **다음** `member.restart{memberId}` / **되돌리기**(`panel.instructions.revert`) → 기준값으로 복원. 연결이 끊겨 있으면 버튼을 잠그고 "데몬 연결 안 됨 — 재접속되면 저장할 수 있습니다".
    - **기본 템플릿 넣기**(`panel.instructions.template`): 내용이 비어 있을 때만 편집기 오른쪽 아래에. `Member.rank`(`leader|member`, 멤버 행이 없으면 팀원)로 `leaderInstructionTemplate` / `memberInstructionTemplate` 을 넣는다. 넣은 직후는 dirty 라 그대로 저장할 수 있다.
  - **`instructionsCacheProvider`**(`InstructionsCache`/`InstructionsDraft`) — 멤버별 `TextEditingController` + "저장돼 있다고 아는 값". `TabBarView` 가 숨은 탭을 내리므로(T13·T18) 컨트롤러를 위젯 밖에 둬야 **쓰던 초안이 탭 전환으로 날아가지 않는다**(터미널 탭의 `terminalCacheProvider` 와 같은 이유). 이미 불러온 멤버는 탭을 다시 열어도 `get` 을 또 부르지 않는다.
  - `instructionTemplate(rank)` · `instructionsHint` · `describeRpcError(e)` 공개.
- `lib/panel/panel_tabs.dart` — `enum RightPanelTab { log, terminal, instructions, report }`. 자리표시였던 `files`("변경 파일")를 `instructions` 로 **교체**(탭 개수 4 유지, 인덱스도 그대로 — `redo_card` 의 `RightPanelTab.terminal` 요청은 영향 없음).
- `lib/panel/right_panel.dart` — TabBar 라벨 `로그 · 터미널 · 지시문 · 보고서`, 세 번째 자리에 `InstructionsTab(memberId: id)`. `_PlaceholderTab` 삭제(쓰는 곳이 없어짐). 배럴 export 에 T26 심볼 추가(`InstructionsTab`, `InstructionsCache`, `InstructionsDraft`, `instructionsCacheProvider`, `instructionTemplate`, `instructionsHint`, `leaderInstructionTemplate`, `memberInstructionTemplate`).
- 테스트 `test/panel/instructions_tab_test.dart` (신규 7건) + `test/panel/panel_harness.dart` 에 `memberJson(rank:)` 파라미터 추가 + `test/panel/right_panel_test.dart` 의 탭 라벨 단언 `변경 파일` → `지시문`. `test/panel/` 합계 41 → 48건.

## 검증

```
$ cd dev/app && flutter analyze
Analyzing app...
No issues found! (ran in 3.9s)

$ flutter test test/panel/          (3회 연속)
00:04 +48: All tests passed!
00:04 +48: All tests passed!
00:04 +48: All tests passed!

$ flutter test                      (전체, 3회 연속)
00:11 +148 ~1: All tests passed!
00:11 +148 ~1: All tests passed!
00:12 +148 ~1: All tests passed!
```

`~1` 은 `test/office/office_preview_test.dart` 의 `OFFICE_PREVIEW_OUT` 미설정 skip(T12).

새 테스트가 확인하는 것(전부 가짜 데몬에 실제 소켓으로 붙어서):
- 탭을 열면 `member.instructions.get{memberId:'m1'}` 한 번 → 편집기에 마크다운, 안내 두 문장, 저장·되돌리기는 닫혀 있고 템플릿 버튼도 없다(내용이 있으므로).
- 편집 → 저장 열림 + "저장 안 됨" → **되돌리기**로 원문 복원(저장 다시 닫힘) → 다시 편집 후 **저장** → `member.instructions.set{memberId:'m1', markdown:'원래 지시문\n말투는 반말.'}` 1회, `member.restart` 0회, "다음 세션부터 반영" 안내, 저장 버튼 다시 닫힘.
- **저장하고 지금 재시작**: 다이얼로그 "진행 중인 작업이 있으면 중단됩니다" → **취소**면 RPC 0건 → **확인**이면 `set` 다음 `restart`(요청 순서까지 단언), 둘 다 `{memberId:'m1'}`, "재시작했어요" 안내.
- 빈 지시문 + rank `member` → **기본 템플릿 넣기** → `memberInstructionTemplate`(`# 팀원 지시문` 으로 시작, `report(taskId, summary, status: done|blocked)` 포함), 버튼은 사라지고 저장이 열린다. rank `leader` → `leaderInstructionTemplate`(`# 팀장 지시문`, `mcp__team__hire` 포함).
- RightPanel 안에서: 로그 탭에서는 `get` 0회 → **지시문** 탭을 눌러야 1회 → 초안을 치고 로그 탭으로 갔다 돌아와도 초안이 그대로 남고 `get` 은 여전히 1회.
- `get` 이 -32002 로 실패 → "불러오지 못했어요 …" + 저장·재시작 잠김 → **다시 시도** → 내용이 들어온다.

실제 데몬에 붙인 캡처는 없다 — 데몬 쪽 `member.instructions.*` 구현(T26b)과 합친 뒤 시연에서 확인한다.

## 발견한 함정

- **연결되기 전의 RPC 는 즉시 실패한다.** `RpcClient._send` 는 소켓(`_channel`)이 없으면 `RpcException(closed, 'not connected')` 을 바로 돌려준다. `initState` 에서 `member.instructions.get` 을 부르면 앱이 켜지자마자 열린 탭에서는 **항상** "불러오지 못했어요" 가 뜬다(테스트 6건이 이렇게 깨졌다). 터미널 탭이 이미 쓰고 있는 방식 — `ref.listenManual(connectionStateProvider)` + 첫 프레임 뒤 시도 — 으로 바꿨다. 재접속 때 자동으로 다시 불러오는 이득도 같이 얻는다.
- **포커스가 있는 `TextField` 와 진행 표시(`CircularProgressIndicator`) 앞에서 `pumpAndSettle()` 은 끝나지 않는다.** 커서 깜빡임·무한 회전 애니메이션이 계속 프레임을 요구하기 때문. 편집기를 건드린 뒤의 탭 전환·다이얼로그는 `pump()` + `pump(Duration(milliseconds: 400~500))` 으로 애니메이션 길이만큼만 편다(실제 소켓 왕복은 기존대로 `pumpUntil`).
- **`TabBarView` 는 숨은 탭을 내린다**(T13 에서 터미널이 겪은 것과 같은 문제) — 편집기 컨트롤러를 State 에 두면 로그 탭에 다녀오는 사이 쓰던 초안이 사라진다. `instructionsCacheProvider` 로 멤버별 초안을 패널 밖에 보관했다.
- 불러오기 응답이 늦게 도착하는 사이 사용자가 이미 뭔가 쳐 넣었으면 **덮어쓰지 않고 기준값만 맞춘다**(`InstructionsDraft.adopt(setText: text.isEmpty)`) — 응답이 타이핑을 지우는 일이 없게.

## 결정

- 탭 자리는 **추가가 아니라 교체**다: 자리표시 "변경 파일"(`RightPanelTab.files`)을 지우고 같은 자리에 "지시문"을 넣어 탭 순서 `로그 · 터미널 · 지시문 · 보고서` 를 유지했다(설계 §3 의 탭 나열과 같은 순서). 변경 파일 탭은 필요해지면 다섯 번째로 되살린다. 새 결정 번호 없음.
- 기본 템플릿을 **앱에 둔다**(데몬 기본 템플릿과 별개). 설계 §멤버 지시문 주입은 "비어 있으면 데몬 기본 템플릿"이라고 적고 있지만, 앱의 버튼은 사용자가 **보고 고칠 수 있는 초안**을 편집기에 넣는 것이라 성격이 다르다. 데몬 템플릿이 확정되면 문구를 맞춘다(둘이 갈라지면 데몬 쪽이 기준). 새 결정 번호 없음.
- "저장하고 지금 재시작"은 dirty 가 아니어도 누를 수 있게 뒀다(이미 저장해 둔 지시문을 지금 반영하고 싶은 경우). "저장"만 dirty 일 때 열린다.

## 남은 것

- `lib/main.dart` 배선 **불필요** — `RightPanel(memberId)` 가 지시문 탭을 포함하고 `instructionsCacheProvider` 는 패널 안에서만 읽는다.
- 데몬 쪽 `member.instructions.get/set` 실제 구현(T26b, 병행) 과 합친 뒤 실기 확인: 저장 → 재시작 → 첫 응답에 새 지시문이 반영되는지(설계 성공 기준 7-2), 실기 캡처 `img/T26-*.png`.
- 편집기 편의(마크다운 미리보기, 저장 단축키 Ctrl+S, 글자 수/토큰 감각, 되돌리기 여러 단계)는 안 했다. `member.clockIn{instructions}` 로 출근할 때 초안을 넣는 UI(출근 다이얼로그)도 이 탭과 문구를 맞춰야 한다(M4 출근 UI).
- 여러 멤버의 지시문을 한 번에 비교/복사하는 화면 없음(멤버를 바꿔 가며 봐야 한다).
