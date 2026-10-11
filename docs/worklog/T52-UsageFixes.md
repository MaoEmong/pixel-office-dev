# T52 — 실사용에서 걸린 다섯 건(U-01~U-05)

- 날짜: 2026-10-11
- 마일스톤: M6 이후(실사용)
- 관련 결정: **D-51**(이 작업에서 추가 — 허가 방식, D-32 ③ 을 고침)
- 앞선 기록: `docs/05-실사용-문제.md`(발견 당시의 증상·추정 — 그대로 남겨 두었다)
- 브랜치: `T52-usage-fixes`(`T51-claude-exe-lookup` 위). **워크트리 `../pixel-office-dev-T52` 에서 작업했다** — 원본 체크아웃에서 데몬과 앱이 돌고 있었다.
- 환경: macOS 26.6 / arm64 · Node v24.18.0 · Flutter(앱 720 → 739 테스트) · **claude 2.1.293** · codex 0.161(실기는 못 돌림)
- 커밋: `ddd324f`(U-04) · `435827f`(U-01) · `f20ce08`(U-05) · `fe3ebd4`(U-03) · `4d6f1af`(U-02) · `99aab7c`(실기 테스트)

## 목표

사용자가 실제로 쓰면서 걸린 다섯 건을 한 번에 고친다. 발견할 때는 코드를 건드리지 않고 `05-실사용-문제.md` 에
증상과 "짚이는 자리"(코드를 읽은 추정)만 적어 두었다 — 그 문서는 머리말에서 **"고칠 때 그대로 믿지 말고 다시
볼 것"** 이라고 경고한다. 그 경고가 맞았다.

## 추정과 실제

| | 문서의 추정 | 실제 | 어떻게 알았나 |
|---|---|---|---|
| U-01 | 승인이 status 만 바꾸고 이벤트를 안 낸다 | **맞음** + 셸 락 대기 말풍선도 같은 병 | `settlePending` · `ShellMutex` 의 `granted` 를 아무도 안 듣는다 |
| U-02 | 판별기를 그대로 쓰면 안 된다(허용 목록이어야) | **맞음**. 단 "카드의 대부분은 `ls`·`cat`" 은 틀림 — Claude 는 읽기 명령을 원래 안 묻는다 | `args.ts` 의 `--permission-mode default` · 실기 |
| U-03 | alt 버퍼라 스크롤백이 없다 → 보여 줄 게 없다 | **절반**. 스크롤백은 없지만 CLI 가 **휠을 받아 스스로 넘긴다.** 막힌 건 휠 번호였다 | claude 를 pty 로 띄워 버튼 64 · 68 을 직접 보냄 |
| U-04 | 걸어오는 동안 좌표계가 어긋난다 / 빈 슬롯이 삼킨다 | **둘 다 아님.** 페인터만 보고 방문자를 바에 그리고 `hitTest` 는 몰랐다 | 페인터의 `_inBar` 와 `hitTest` 를 나란히 읽음 |
| U-05 | Claude 는 statusLine, **Codex 는 화면에서 긁어야** | Claude 맞음. **Codex 는 모든 hook 페이로드에 `model` 이 온다** | spike-1 의 실측 hookLog |

세 건이 틀렸거나 절반만 맞았다. 특히 U-03 을 추정대로("전체 화면 제안을 거절한다") 고쳤다면 tui-map 을 다시
뜨는 큰일이 됐을 것이고, U-04 를 추정대로("좌표계 기준을 그려지는 위치로") 고쳤다면 **증상이 그대로** 남았을 것이다.

## 한 것

### U-04 — 보고하러 온 캐릭터가 안 눌리던 것 (`ddd324f`)

- `dev/app/lib/office/office_layout.dart`: `drawsInBar(m, {visiting})` — "바(뷰포트 좌표)에 그리는가" 의 판단을 한 곳으로. `hitTest` 가 방문 집합을 받는다.
- `office_painter.dart`: `_inBar` 가 `bubbleOverrides` 대신 `visitingIds` 를 본다. `bubbleOverrides` 에는 자리에 앉은 채 뜨는 "복구" 말풍선도 들어 있어, 그 멤버를 3초 동안 바 좌표로 그리고 있었다(스크롤 0 이면 안 보이는 버그).
- `office_view.dart`: 페인터와 `hitTest` 에 같은 `_visitingIds` 를 준다.

### U-01 — 말풍선이 한 박자 늦던 것 (`435827f`)

- 앱 `office_scene.dart`: `isStaleWaitEvent` — `waiting_approval`·`asking` 이벤트는 상태 주장이다. status(raw·파생)가 대기가 아니고 열린 pending 도 없으면 낡았다 → `summarize`·`isAlertFor` 가 지금 상태로 바꿔 말한다.
- 데몬 `ShellMutex.ts`: `granted` 이벤트에 `queued`(줄을 섰다가 넘겨받았는가). `Office.ts`: `noticeShellGranted` 가 `running{cmd}` 을 한 번 더 낸다.
- `PROTOCOL.md`: "락을 받으면 이벤트를 따로 내지 않는다" 를 고치고, 두 kind 가 상태 주장이라는 클라이언트 규칙을 적었다.

### U-05 — 세부 모델 표시 (`f20ce08`)

- 데몬 `usage/types.ts`: `SessionModel{id,label}` · `MemberUsage.model`. `parse/claudeStatusLine.ts`: `sessionModelOf`. `UsageTracker.ts`: `applyHookModel`(같은 id 면 건드리지 않는다 — statusLine 의 좋은 이름을 지킨다) · 옛 행은 `null`. `Office.ts`: hook 마다 `payload.model` 을 넘긴다. `cli/format.ts`: 콘솔 `usage` 에 `[claude · Opus 5.5]`.
- 앱 `model/usage.dart`: `SessionModel`(`shortLabel` 은 끝의 괄호 꾸밈만 뗀다) · `panel/right_panel.dart`: 엔진 배지 옆 모델 배지(`panel.model`, 길면 말줄임) · `office_scene.dart`: `modelLabel`·`engineModelLabel`.

### U-03 — 터미널 탭에서 위로 넘겨 보기 (`fe3ebd4`)

- 앱 `panel/terminal_cache.dart`: `StandardWheelMouseHandler` — 휠만 가로채 표준 번호(64~67)로 보고한다. xterm 4.0.0 은 68/69 로 보낸다.
- 데몬 `screen/ScreenModel.ts`: 마우스 **인코딩** 모드(`?1005`·`?1006`·`?1015`)를 파서 훅으로 지켜봤다가 `serialize()` 끝에 붙인다. 애드온은 추적 모드(`?1003h`)까지만 싣는다.

### U-02 — 부서별 허가 방식 (`4d6f1af`, D-51)

- 데몬 `adapters/autoApproval.ts`(새 파일): `decideAutoApproval` · `pathVerdict` · `strictReadOnlyVerdict` · `plainShellVerdict`. `BaseHooksAdapter.ts`: `tryAutoApprove`(넘기면 `allow()` + `detail.auto` 이벤트). `store`: `departments.approval_policy`(schema **v6**, `addApprovalPolicy` — 실제 칼럼을 보고 넣는다). `Office.updateDepartment` · RPC `department.update` · 콘솔 `dept policy`.
- 앱 `model/department.dart`: `ApprovalPolicy`. `topbar/top_bar.dart`: `ApprovalPolicyChooser` · ⋮ 메뉴 "허가 방식" · "부서 만들기 → 세부 설정"(접혀 있고, 접힌 채로도 지금 값이 보인다). `panel/log_tab.dart`: `자동 허가` 꼬리표.

## 검증

```
$ cd dev/daemon && npm run typecheck && npm test
ℹ tests 1195   ℹ pass 1185   ℹ fail 0   ℹ skipped 10   (시작할 때 907 / 898 / skip 9 — skip 은 opt-in 실기 테스트)

$ cd dev/app && flutter test && dart analyze lib test
+739 ~2: All other tests passed!           (시작할 때 720)
No issues found!

$ flutter build macos --release
✓ Built build/macos/Build/Products/Release/pixel_office.app (36.0MB)
```

`flutter analyze` 는 이 맥에서 죽는다 — 분석 서버가 **한글이 들어간 경로**(`…/포트폴리오/…`)를 못 읽는다
(`FormatException: Unterminated string`). 변경과 무관한 환경 문제이고 `dart analyze` 는 된다.

### U-03 실측 — claude 가 어떤 휠을 받는가

claude 2.1.293 을 pty 로 띄우고 대화를 세 화면쯤 쌓은 뒤 마우스 보고를 직접 써넣었다.

```
RAW modes : ?25h ?25l ?2004h ?2031h ?1004h … ?1049h ?1000h ?1002h ?1003h ?1006h
SERIALIZE : ?1049h ?2004h ?1004h ?1003h            ← ?1006h 가 빠진다

② 버튼 68(= 휠업 + Shift 비트), 옛 인코딩  → 화면이 바뀌었나: false
③ 버튼 69,                     옛 인코딩  → false
④ 버튼 64(표준 휠업),          옛 인코딩  → true
⑤ 버튼 64,                     SGR        → true
⑥ 버튼 68,                     SGR        → false
```

인코딩은 범인이 아니었다(④ 가 된다) — 그래도 `?1006h` 는 붙인다(223칸 상한, CLI 가 요청한 모양).

### 진짜 claude 로 한 바퀴 (`PIXEL_IT=1`)

```
$ PIXEL_IT=1 PIXEL_IT_SANDBOX=…/spike-0/sandbox node --import tsx --test test/office/autoapproval.integration.test.ts
[IT] U-05 model = {"id":"claude-opus-5-5","label":"claude-opus-5-5"} (775ms)
[d:out] [ClaudeHooksAdapter] auto-approve 자동이(…) Write — edit-in-cwd: 작업 폴더 안의 파일 편집(1개)
[IT] turn1 kinds = thinking editing editing(auto:edit-in-cwd) text idle
[IT] notice info: 부서 "it52" 허가 방식: edits → trust
[d:out] [ClaudeHooksAdapter] auto-approve 자동이(…) Bash — plain-shell: 위험해 보이는 것이 없다
[IT] turn2 kinds = reporting thinking running running(auto:plain-shell) text idle
[IT] waiting_approval = {"tool":"Bash","cmd":"rm -rf t52-auto-dir",…}
[IT] U-05 model after turns = {"id":"claude-opus-5-5","label":"Opus 5.5"}
[IT] U-03 attach modes = ?1049h ?2004h ?1004h ?1003h ?1006h
✔ real claude: edits → 폴더 안 Write 는 카드 없이 · trust → mkdir 는 카드 없이, rm -rf 는 카드 · 모델이 사용량에 실린다
```

기본(`ask`) 흐름이 그대로인 것도 기존 실기 테스트로 확인했다(`integration.test.ts` — `waiting_approval` → allow → 파일 생성 ✔).

### 확인하지 못한 것 — 사용자가 눈으로 볼 것

**실제 앱 창에서는 하나도 눌러 보지 않았다.** 사용자가 그 맥에서 앱을 쓰는 중이었고, 같은 이름의 창을 하나 더
띄워 화면을 조작하면 쓰고 있는 사무실을 잘못 누를 수 있어서다. 위젯 테스트는 실제 위젯 트리에 실제 포인터
이벤트를 넣지만 **창은 아니다** — T51 에서 "셸에서 `open` 으로 띄워 확인했다" 가 Finder 실행과 달랐던 것과 같은
종류의 틈이 있을 수 있다. 새 빌드에서 볼 것:

1. **U-04** 보고하러 와서 내 책상 옆에 선 캐릭터를 클릭 → 선택되는가.
2. **U-03** 터미널 탭에서 휠/트랙패드 두 손가락 → claude 대화가 위로 넘어가는가.
3. **U-01** 허가 카드를 승인 → 말풍선이 곧바로 "허가 대기" 에서 벗어나는가.
4. **U-05** 멤버를 클릭 → 엔진 배지 옆에 모델 이름이 뜨는가(Codex 멤버도).
5. **U-02** ⋮ 메뉴 → "허가 방식" → 바꾼 뒤 편집을 시키면 카드 없이 지나가고 로그에 `자동 허가` 가 붙는가.

## 발견한 함정

1. **실행 중인 체크아웃에서 고치면 안 된다.** 데몬은 `tsx`(watch 아님)로 떠 있어 TS 소스는 다시 안 읽지만, **hook 스크립트(`hook.js`·`statusline.js`)는 호출마다 새로 읽힌다** — 거기를 고치면 쓰고 있는 세션에 바로 들어간다. `flutter build` 도 돌고 있는 앱 번들을 덮어쓴다. 워크트리로 뺐다.
2. **워크트리에는 `dev/spike-0/sandbox` 가 없다**(gitignore). 실기 테스트는 `PIXEL_IT_SANDBOX` 로 원본의 sandbox 를 가리켰다.
3. **`!명령` 은 API 를 쓴다.** U-03 probe 에서 "프롬프트를 안 보내니 사용량이 없다" 고 생각하고 claude 에 `!echo …` 를 열두 번 넣었는데, bash 모드 출력 뒤에 모델이 매번 한 줄씩 답했다(짧은 턴 12번 + 뒤의 3번). 사용량 없이 대화 내용을 쌓는 방법은 찾지 못했다.
4. **`Object.hash` 는 인자 20개까지다.** `SceneMember` 가 이미 20개를 쓰고 있어 `modelLabel` 을 더하면 컴파일이 안 된다 — 뒤쪽 둘을 한 번 묶었다.
5. **데몬이 사용자의 전역 claude 설정을 바꿨다.** `fullscreen-renderer` 다이얼로그를 자동으로 Enter 하면서 `~/.claude/settings.json` 에 `"tui": "fullscreen"` 이 들어갔다. 픽셀 오피스 밖에서 claude 를 쓸 때도 전체 화면이 된다. 이번에는 건드리지 않았다(전체 화면이어도 스크롤이 되게 고쳤다).
6. **schema v6 은 되돌아갈 수 없다.** 새 데몬이 한 번 연 DB 는 옛 데몬(v5)이 `newer than supported` 로 거부한다. 브랜치를 오가며 시험할 때 주의.

## 결정

- **D-51** — 허가는 부서마다 고른다(`ask`·`edits`·`trust`). 기본은 `ask`. `docs/04-결정기록.md`.

## 남은 것

- **세부 모델 선택**(부장의 모델을 고른다 · 기본은 각 엔진의 최상위 · "세부 설정" 안) — 표시(U-05)와 접는 영역(U-02)이 들어갔으니 `--model` 을 넘기는 일만 남았다.
- 스크롤한 상태에서 캐릭터가 자리 ↔ 바를 오갈 때 한 번 튀어 보이는 것(U-04 의 모양 문제).
- 전체 화면 렌더러를 세션 단위로 못 박기(함정 5) — `--settings` 에 `tui` 를 실으면 사용자 전역 설정과 무관해진다.
- Codex 멤버로 U-05·U-02 실기.
- `T51`·`T52` 는 아직 `main` 에 없다.
