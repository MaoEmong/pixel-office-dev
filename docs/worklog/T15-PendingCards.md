# T15 — 허가·질문 카드

- 날짜: 2026-09-15
- 마일스톤: M2
- 관련 설계: 01-설계문서.md §구성 요소 3 "Flutter 데스크탑"(허가·질문 카드, 모달 없음, "내 책상" 큐와 오른쪽 카드가 같은 `pending` 을 본다), `dev/daemon/PROTOCOL.md`(`approval.respond`, `question.respond`, Pending payload), `docs/design/office-sketch.html`(카드 모양), worklog T04(pending payload 실제 형태) · T11(openPendingProvider 파생 규칙) · T13(RightPanel)
- 커밋: (미커밋 — 이 태스크는 커밋하지 않음)

## 목표

멤버가 허가(`PermissionRequest`)나 질문(`AskUserQuestion` / M2 `ask_user`)으로 막히면 오른쪽 패널 헤더 아래에 카드가 뜨고,
거기서 **허가 / 거부(사유) / 이번 세션 항상 허가 / 수정해서 허가**, 질문이면 **옵션 선택 · 직접 입력**으로 답한다. 모달 없음.
카드는 상태 층의 `openPendingProvider` 를 그대로 보므로 응답이 끝나거나(로컬 `removePending`), 멤버 status 가 waiting 을 벗어나거나,
`error{pendingId}` 가 오면 저절로 사라진다. 같은 카드를 "내 책상" 인박스에서도 쓸 수 있게 `PendingInbox` 를 미리 뒀다(배선은 나중).

## 한 것

전부 `dev/app/lib/panel/` · `dev/app/test/panel/` 안. `lib/main.dart`·`lib/office`·`lib/command`·`lib/topbar`·`lib/state`·`lib/model`·`lib/rpc` 는 건드리지 않았다.

- `lib/panel/pending_card.dart` (신규)
  - **`PendingCards({required String memberId})`** — 그 멤버의 열린 pending 을 `createdAt` 오래된 순으로 `PendingCard` 로. 없으면 `SizedBox.shrink()`.
  - **`PendingInbox()`** — 전 멤버의 열린 pending, 최신 먼저(`createdAt` 내림차순), 카드 위에 `멤버이름 · HH:MM`. 비어 있으면 "기다리는 허가·질문 없음". 내 책상 UI 용(아직 배선 안 함).
  - **`PendingCard(pending)`** — `type` 으로 `ApprovalCard` / `QuestionCard` 분기.
  - **`ApprovalCard(pending)`** — 제목 `❗ 허가 요청 — <tool_name>`(호박색 테두리).
    - 본문: `isShellTool`(Bash/PowerShell/shell/cmd, 또는 tool_input 에 `command` 만 있는 이벤트 유래 pending) → `command` 고정폭 박스 + `description`(없으면 payload.summary). `isFileTool`(Edit/Write/MultiEdit/NotebookEdit) → 파일 경로 + `filePreviewLines()` 미리보기(Write `content` 첫 줄들 / Edit `- old` `+ new` / MultiEdit 첫 edit + 개수 / NotebookEdit `new_source`, 최대 `pendingPreviewLines`=12줄, 넘치면 `… N줄 더`). 그 외 도구 → `prettyJson(tool_input)`, 12줄 넘으면 접고 `… N줄 더 보기`/`접기`.
    - 버튼: **허가**(`respondApproval(allow)`), **거부** → 사유 입력란(`ValueKey('approval-deny-reason')`)이 인라인으로 열리고 버튼이 **거부 전송**으로(Enter 도 전송; `message` 는 비어 있으면 생략 → 데몬 기본 "Denied by user"), **이번 세션 항상 허가**(`alwaysThisSession:true`), **수정해서 허가**(셸 도구만; 명령 박스가 `TextField`(`ValueKey('approval-command-editor')`)로 바뀌고 **수정한 명령으로 허가** → `rpcClient.call('approval.respond', {behavior:'allow', updatedInput:{…tool_input, command: 수정본}})` 뒤 `removePending`), **취소**(편집/거부 모드 되돌림).
    - 키: 카드 빈 곳을 누르면 카드에 포커스(`Listener.onPointerDown`, 자식이 이미 포커스면 뺏지 않음). 카드 **자체**가 primary focus 일 때만 Enter = 허가(안의 입력란·버튼 포커스면 그쪽이 처리), Esc = 카드 서브트리 포커스 해제. 전역 `Shortcuts` 없음 — 지시 바 포커스를 건드리지 않는다.
    - 보낸 뒤: `_sent` → 버튼 전부 `onPressed:null` + 작은 스피너 "전송됨". pending 이 목록에서 빠지면 카드가 내려간다. 실패(`RpcException`) → "전송 실패: <message> (<code>)" 를 띄우고 다시 연다. 단 -32002(없음)/-32003(이미 answered/expired)는 재시도가 무의미하므로 잠근 채 사유만(상태 층이 곧 지운다).
    - 연결 끊김(`connectionStateProvider != connected`) 동안은 버튼을 잠그고 "데몬 연결 안 됨 — 재접속되면 응답할 수 있습니다".
  - **`QuestionCard(pending)`** — 제목 `❓ 질문`(여러 개면 `❓ 질문 N개`, 시안색 테두리). `parseQuestions(payload)` 가 `payload.questions[]` → `payload.tool_input.questions[]` → `{question|text, options?}`(M2 ask_user) 순으로 정규화(`PendingQuestion{question, header?, options[PendingOption{label, description?}], multiSelect}`; options 는 `{label, description}` 맵이든 문자열이든).
    - 질문마다 header(작은 회색) · 질문 · 옵션(단일 선택: 버튼, 선택되면 tonal; `description` 은 `Tooltip`) 또는 multiSelect: `Checkbox` 행 · **직접 입력** `TextField`(`ValueKey('question-free-<i>')`).
    - 답 = 직접 입력(있으면 우선) 아니면 선택 라벨(multiSelect 는 옵션 순서로 `", "` 이음). **확인** 은 모든 질문에 답이 있을 때만 활성. 질문 하나·단일 선택이면 옵션을 누르는 즉시 전송(빠른 경로), 그 외는 확인으로. 직접 입력란 Enter 도 확인.
    - `respondQuestion(pendingId, {question: label})`. 전송/실패/끊김 처리는 ApprovalCard 와 같음. Esc = 포커스 해제.
  - 공용: `_CardFrame`(스케치의 2px 테두리 카드, 포커스면 테두리 진하게), `_MonoBox`(`Cascadia Mono` SelectableText), `_SentBadge`, `_ErrorLine`, `_smallButtonStyle`.
- `lib/panel/right_panel.dart` — 헤더와 `TabBar` 사이에 `ConstrainedBox(maxHeight: pendingCardsMaxHeight=320) > SingleChildScrollView > PendingCards(memberId)`. 카드가 없으면 높이 0. 배럴 export 에 `PendingCards, PendingInbox, PendingCard, ApprovalCard, QuestionCard` 추가. 탭·터미널 생명주기는 그대로.
- `test/panel/panel_harness.dart` — `pendingJson(id, {memberId, type, payload, createdAt})` 헬퍼 추가.
- `test/panel/pending_card_test.dart` (신규, 14건) · `test/panel/right_panel_test.dart` (+1건).

## 검증

```
$ cd dev/app && flutter analyze
Analyzing app...
No issues found! (ran in 3.4s)

$ flutter test test/panel/          (3회 연속)
00:03 +30: All tests passed!
00:03 +30: All tests passed!
00:03 +30: All tests passed!

$ flutter test                      (전체 — T11~T14 포함)
00:09 +104 ~1: All tests passed!
```

테스트가 확인하는 것(전부 가짜 데몬에 실제 소켓으로 붙어서, `approval.respond`/`question.respond` 파라미터를 그대로 비교):
- ApprovalCard: Bash 제목/명령/설명 + 버튼 4개 → 허가 → `{pendingId:'a1', behavior:'allow'}`, "전송됨", 버튼 잠김, 로컬 pending 제거 / 거부 → 사유란이 나타남 → `{behavior:'deny', message:'캐시 지우지 마'}` / 항상 허가 → `{behavior:'allow', alwaysThisSession:true}` / 수정해서 허가 → 편집기에 원래 명령이 들어 있고 고친 뒤 → `{behavior:'allow', updatedInput:{command:'flutter build apk', description:…}}` / 키보드: 제목 클릭 → 카드 primary focus → Esc 로 해제 → 다시 클릭 → Enter → allow / Edit: 경로 + `- a / - b / + n0…` 12줄 + `… 4줄 더`, "수정해서 허가" 없음; mcp 도구 20키 JSON 은 접혀서 `k19` 가 안 보이다가 "줄 더 보기" 로 펼침 / 데몬 -32000 → "전송 실패: db locked", 버튼 다시 열림.
- QuestionCard: 헤더·질문·옵션 버튼·툴팁·직접 입력란, 답 없으면 확인 잠김, 옵션 탭 → 즉시 `{answers:{'점심 뭐 먹을까?':'라면'}}` + 잠김 / 직접 입력 '샐러드' + 확인 → 자유 답 / multiSelect 2질문: 체크 3개, 두 번째 미답이면 확인 잠김, 즉시 전송 없음, 확인 → `{'토핑은?':'치즈, 햄','음료는?':'물'}` / M2 `{question, options:['예','아니오']}` → `{'배포할까?':'아니오'}`.
- PendingCards: 스냅샷 pending 중 m1 것만 카드, `member.status{working}` → 카드 사라짐 / 라이브 `waiting_approval{tool:Bash, cmd:'git push', summary:'푸시'}` ref approvalId → 카드(명령·요약), `error{pendingId}` → 사라짐.
- PendingInbox: 두 멤버 pending → 카드 2장 최신 먼저(`new`, `old`), `모시 ·`/`하루 ·` 이름 표시.
- RightPanel: m1 선택 → m1 의 Bash 카드만(QuestionCard 없음), 카드 위치가 `PanelHeader` 아래 · `TabBar` 위 / m2 로 바꾸면 m2 의 질문 카드만 / m1 로 돌아와 허가 → 카드 사라지고 TabBar 그대로.

실제 데몬에 붙인 화면 캡처는 `main.dart` 배선(통합 단계) 뒤에.

## 발견한 함정

- **`find.byType(Focus).first` 는 카드 노드가 아니다** — MaterialApp/Navigator 가 먼저 온다. 카드 `FocusNode` 는 `debugLabel: 'approvalCard'` 로 찾는다. 첫 버전의 키보드 테스트가 이걸로 잘못 실패했다.
- **Enter 처리는 `node.hasPrimaryFocus` 로 제한**해야 한다. `Focus.onKeyEvent` 는 자손이 포커스여도 불리므로(버블링), 조건 없이 Enter 를 먹으면 거부 사유란·명령 편집기·버튼의 Enter 까지 "허가"가 돼 버린다. 자식 버튼이 포커스면 카드가 `ignored` 를 돌려 앱 수준 `ActivateIntent` 가 그 버튼을 누른다.
- 카드 포커스는 `Listener.onPointerDown` 으로 준다(`GestureDetector` 는 안쪽 버튼이 탭을 가져가면 안 불린다). 이미 서브트리에 포커스가 있으면(입력란 타이핑 중) 뺏지 않는다.
- `OfficeNotifier.respondApproval` 은 `updatedInput` 을 받지 않는다(`lib/state` 는 이 태스크 범위 밖) → 수정해서 허가만 `rpcClientProvider` 를 직접 부르고 `removePending` 을 이어서 한다. 다른 세 경로는 기존 메서드 그대로.
- 이벤트에서 만들어진 pending(`fromEvent:true`, T11)은 `tool_input` 에 `command`/`file_path` 만 있고 `description` 이 없다 — `payload.summary` 를 설명 자리에 쓴다. 스냅샷이 오면 실제 payload 로 교체된다.

## 결정

- 질문 하나·단일 선택일 때 옵션 클릭 = 즉시 전송(확인 한 번 더 누르지 않게). 여러 질문·multiSelect·직접 입력은 확인 버튼. 새 결정 번호 없음(UI 세부).
- 카드 영역 최대 높이 320(패널 절반 남짓) — 넘치면 카드 영역 안에서 스크롤. 탭 영역이 카드에 밀려 사라지지 않게. 새 결정 번호 없음.
- -32002/-32003 응답은 "이미 닫힌 pending" 으로 보고 카드를 다시 열지 않는다(상태 층 휴리스틱이 곧 지운다 — T11 함정 항목 참고).

## 남은 것

- `PendingInbox` 를 내 책상 UI(T16/M2 캐릭터 이동·큐)에 배선. 지금은 export 만.
- 실제 데몬에 붙인 캡처(`img/T15-*.png`) — `main.dart` 배선 뒤.
- `OfficeNotifier.respondApproval` 에 `updatedInput` 파라미터 추가(lib/state, 통합 단계에서) → 카드의 직접 RPC 호출을 없앨 수 있다.
- `permission_suggestions`(Claude 가 제안하는 "항상 허용" 규칙)는 아직 표시하지 않는다 — 데몬 `alwaysThisSession` 이 멤버·도구 단위라 대응이 1:1 이 아님.
- 명령 편집기에서 Ctrl+Enter 로 바로 전송(지금은 버튼만).
