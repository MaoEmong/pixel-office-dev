# T45 — 사용량 마무리(서브에이전트 토큰) + 허가 프롬프트 오탐(D-26)

- 날짜: 2026-09-21
- 마일스톤: M7 정리
- 앞선 기록: `T43-5-ClaudeTokens.md`(§남은 것 1번) · `T44-ITandPasteRace.md`(§남은 것 2번, 함정 5) · T43-3 실기
- 범위: `dev/daemon/src/usage/**` · `src/screen/**` · `src/tui-maps/**` · `src/input/InputQueue.ts` 만.
  앱(`dev/app/**`)과 `src/index.ts`·`src/office/Office.ts`·`singleton.ts`·`PtyManager`·`RpcServer` 는 건드리지 않았다(T46 와 겹치지 않게).
- 커밋: `0538945`(T45-1 서브에이전트 토큰) · `e206cc6`(T45-2 오탐) · 이 문서 + README

## 목표

T43-5 와 T44 가 "남은 것" 으로 넘긴 두 가지를 닫는다.

1. **서브에이전트 토큰이 집계에 안 들어간다.** CLI 2.1.275 는 Task 도구 줄을 본 transcript 에 섞지 않고
   `<sessionId>/subagents/agent-*.jsonl` 에 따로 쓴다. 멤버가 Task 를 많이 쓰면 살아 있는 동안의 숫자가
   그만큼 낮게 보인다.
2. **`CLI 허가 프롬프트가 떠 있음` 경고가 MCP 도구 구간에 뜬다**(D-26 오탐). T44 가 통합 테스트에서 두 번,
   T43-3 코디네이터가 실기에서 한 번(`mcp__team__report` 직후) 봤다. **흐름은 매번 정상으로 이어졌다.**

---

# Part 1 — Claude 서브에이전트 토큰

## 판정해야 했던 것

`cost-state.modelUsage`(세션이 끝날 때 CLI 자신이 적는 최종 회계)가 **서브에이전트 몫을 포함하는가?**

- **포함한다면** → 살아 있는 동안에도 서브에이전트 파일을 더해야 한다. 그래야 세션이 끝나 cost-state 가
  이기는 순간 숫자가 튀지 않고 수렴한다.
- **포함하지 않는다면** → 더하면 안 된다. 더했다가 세션이 끝나면 값이 **줄어드는** 화면이 된다.

## 증거 — 실측 3세션

이 기계의 `~/.claude/projects/**` 를 전수로 훑었다(113 세션):

```
cost-state 가 있는 세션          82
subagents/ 폴더가 있는 세션       9
**둘 다** 있는 세션                0     ← 비교할 자료가 아예 없었다
```

서브에이전트 폴더가 있는 9개는 전부 데스크탑 앱 세션이고 cost-state 를 남기지 않는다. 그래서 **직접 만들었다.**

**함정부터:** `claude -p "…"`(print 모드)로 3번 돌려 봤지만 **cost-state 가 한 줄도 안 남았다.** cost-state 는
**대화형 CLI 프로세스가 끝날 때만** 적힌다. 그래서 node-pty 로 sandbox(`dev/spike-0/sandbox`)에서
`%APPDATA%\Claude\claude-code\2.1.275\claude.exe` 를 띄우고, Task 도구를 쓰게 한 뒤 `/exit` 로 끝내는 식으로
3세션을 만들었다.

```
세션                cost-state cacheCreate   본 파일만    본+서브에이전트
8a9bae68 (sub 1개)          50,870          17,972       50,822   (-0.09%)
a2281b58 (sub 2개)          43,322          15,703       43,285   (-0.09%)
f56e74cf (sub 1개)          28,519          14,769       28,489   (-0.11%)
                                           └ -48~-66%   └ 0.1% 안
```

`cacheCreate` 로 가른 이유: T43-5 가 밝힌 "세션 끝의 숨은 호출" 은 **캐시를 읽기만** 하므로 이 칸을 흐리지
않는다. 출력 토큰도 같은 방향이다(예: a2281b58 — 본 파일만 421, 본+서브 1,655, cost-state 1,686).

→ **결론: cost-state 는 서브에이전트 몫을 포함한다.** 더해야 한다.

총합 기준 오차는 본 파일만 −48~−66% → 본+서브 −23~−36% 로 줄어든다. 남은 차이는 전부 T43-5 가 이미 밝힌
`cacheRead`(세션 끝 숨은 호출이 그 시점 컨텍스트 전체를 다시 읽는다)와 배경 haiku 다 — 구조적으로 못 센다.

## 한 것

### `src/usage/claudeTranscriptReader.ts`

- `claudeSubagentsDir(transcriptPath)` — `…/<sessionId>.jsonl` → `…/<sessionId>/subagents`. `.jsonl` 이 아니면 `null`.
- `listClaudeSubagentFiles(path, cap = MAX_SUBAGENT_FILES)` — `agent-*.jsonl` 만(같은 폴더의 `agent-*.meta.json`
  에는 usage 가 없다), **mtime 새것부터** `cap`(기본 **50**)개. 폴더가 없으면 빈 배열(정상), 실패해도 안 던진다.

### `src/usage/ClaudeTranscriptUsage.ts`

- `addUsageTokens(a, b)` · `claudeTotalsOf(states)` — 파일별 누적 상태를 합치는 **순수** 함수.
  파일마다 상태가 따로이므로 id 중복 제거도 파일 안에서만 하면 된다(본 파일과 서브에이전트 파일의
  `message.id` 집합이 서로 소임을 테스트가 실측 픽스처로 못 박는다).

### `src/usage/UsageTracker.ts`

턴 종료(`applyClaudeTurnEnd`)에 한 단계가 붙었다:

```
① 본 transcript 증분 누적
①-b 서브에이전트 파일 증분 누적  ← 새로 생김
②  cost-state 가 있으면 그쪽이 최종값(그대로)
```

멤버당 상태 `MemberSubagentState { transcriptPath, tracked: Map<path, state>, retired, retiredPaths }`:

- **상한 밖으로 밀린 파일은 합계만 접어 두고 놓아 준다**(`retired`). 그냥 버리면 누적 토큰이 **줄어드는**
  화면이 되는데, 토큰은 세션 안에서 단조 증가해야 한다.
- 놓아 준 경로는 `retiredPaths` 에 남겨 **다시 잡지 않는다**(0 부터 다시 읽으면 이중 계산이다).
  끝난 서브에이전트 파일은 더 자라지 않으므로 다시 잡을 이유도 없다.
- 본 transcript 경로가 바뀌면(= `--resume` 이 새 세션 파일을 팠다) 이 상태를 **통째로** 버린다.
  회계 단위가 세션 하나라는 T43-5 의 규칙 그대로다.
- 멤버 삭제(`removeMember`)·기동 정리(`pruneMissingMembers`)에서 같이 지운다.

**와이어 모양(`UsageTokens`)은 그대로다** — 앱이 고칠 것이 없다.

---

# Part 2 — `CLI 허가 프롬프트가 떠 있음` 오탐 (D-26)

## 재현 + 증거

기존 로그로는 못 잡았다: `dev/spike-0/*.log` · `dev/spike-1/out/` 어디에도 `Do you want to proceed` 가 없다
(그 캡처들은 MCP 도구를 쓰지 않았다).

그래서 **옵트인 덤프**를 넣고(`PIXEL_SCREEN_DEBUG=1`, `ScreenModel.detectDialog()` 가 `approval-prompt` 로
판정할 때 화면을 통째로 적는다) T44 가 오탐을 봤던 통합 테스트를 그대로 돌렸다:

```
PIXEL_IT=1 PIXEL_IT_SANDBOX=D:/myproject/pixel-office/dev/spike-0/sandbox \
PIXEL_USAGE_PROBE=0 PIXEL_SCREEN_DEBUG=1 PIXEL_SCREEN_DEBUG_FILE=… \
npx tsx --test test/office/teamtools.integration.test.ts
```

한 번에 재현됐다(경고 2회 + 덤프 2장, claude 2.1.275).

```
=== approval-prompt #1 dialog=permission-prompt at=…T13:58:43.112Z ===
❯ [TASK#1 from user]
  team MCP 도구로 팀원 '보조'를 hire하고(역할: 파일 작성), …

  Calling team… (ctrl+o to expand)

────────────────────────────────────────────────────────────────────────────
 Tool use

   team — Hire Tool: (MCP)

   name: "보조"
   role: "파일 작성"
   …
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for team — Hire commands in D:\…\sandbox
   3. No

 Esc to cancel · Tab to amend
=== end ===
```

## 근본 원인 — **판정은 틀리지 않았다**

화면에는 **진짜 허가 프롬프트**가 떠 있었다. "MCP 도구 출력에 Allow 라는 글자가 섞였다" 도,
"패턴이 느슨해서 엉뚱한 줄에 걸렸다" 도 아니다.

일어난 일은 이것이다: **CLI 는 MCP 도구의 허가 프롬프트를 먼저 그리고, 곧이어 도착한 우리
`PermissionRequest` hook 의 `allow` 로 그 화면을 지운다.** 두 번째 덤프의 이력 줄이 그 증거다 —
`⎿ Allowed by PermissionRequest hook`. `mcp__team__*` 는 D-22 에 따라 데몬이 **보류 없이 즉시 allow** 하므로
사람이 답할 일이 애초에 없다.

두 번째 실측(지속 시간 계측을 덧붙여 재현)에서 **떠 있던 시간이 정확히 나왔다**:

```
=== approval-prompt #1 … at=…T14:01:17.784Z held=0ms ===
--- approval-prompt gone after 502ms (now kind=none) at=…T14:01:18.286Z
=== approval-prompt #2 … at=…T14:01:20.822Z held=0ms ===
--- approval-prompt gone after 502ms (now kind=none) at=…T14:01:21.324Z
```

**502ms = InputQueue 폴링 정확히 한 판.** 두 번 모두 같았다. 즉 프롬프트가 보이는 판이 **딱 한 번**이다.

같은 실행에서 **진짜로 사람이 답해야 하는** 허가(팀원의 `Write` — 데몬이 hook 을 붙잡고 카드를 띄운다)는
덤프가 **한 장도 없다.** 붙잡힌 허가에는 CLI 가 이 프롬프트를 그리지 않는다. 그래서 "떠 있는 시간" 이
둘을 가르는 신호로 충분하다.

→ **오탐의 정체: 아무도 답할 필요가 없는 프롬프트를 사람에게 알린 것.**
진짜 프롬프트(hook 이 없거나 만료된 D-16 폴백)는 사람이 답할 때까지 **무한히** 떠 있다.

## 고침

### 1. `InputQueue` — 알림에만 지속 창을 건다 (근본 고침)

`TIMING.dialogBlockedNoticeMs = 3000`. 통과 키가 없는 다이얼로그가 **연속으로** 그만큼 보여야
`dialogBlocked` 를 낸다. 502ms 의 6배 여유이고, 화면 기반 idle 판정의 안정 창(`IDLE_SCREEN_STABLE_MS`)과
같은 크기다.

**늦춰지는 것은 사람에게 가는 알림 한 줄뿐이다** — 큐를 막는 `blocked('dialog')` 도, "키를 절대 안 보낸다" 도
보는 즉시 그대로다. 다이얼로그가 사라지면 창이 리셋되므로 깜빡여도 경고가 새지 않는다.

이것은 **눈 감고 거는 디바운스가 아니다**: 두 경우의 **지속 시간 분포가 실측으로 완전히 갈린다**
(502ms 고정 vs 무한). 판정 신호 자체를 지속성으로 바꾼 것이다.

### 2. `src/tui-maps/claude-2.1.json` — 패턴을 줄 단위로 (부수적 강화)

```diff
- "all": ["Do you want to proceed\\?"]
+ "all": ["^\\s*Do you want to proceed\\?\\s*$", "^\\s*[❯>]?\\s*1\\.\\s+Yes\\b"]
```

이번 오탐의 원인은 **아니지만**, 옛 패턴은 화면 아무 데나 그 문장이 있으면 걸렸다 — 모델이 영어로
"Do you want to proceed?" 라고 **쓰기만 해도** 허가 프롬프트가 된다. 실측 4장(T21 Bash 2장 + 이번 MCP 2장)
전부 ① 그 문장이 **줄 전체**이고 ② `1. Yes` 줄이 있다. 제목(` Bash command` vs ` Tool use`)과 항목 수
(4 vs 3)는 도구마다 다르므로 쓰지 않았다.

### 3. `ScreenModel` — `PIXEL_SCREEN_DEBUG` (진단 도구, 남겨 둔다)

`approval-prompt` 판정이 날 때 화면을 통째로 적고, **사라진 시각까지** 남긴다. 같은 화면은 한 번만 적고
인스턴스당 200장이 상한이며, 변수가 없으면 아무 일도 하지 않고 실패해도 던지지 않는다.

## 재검증 (실기)

고친 뒤 **같은 IT 를 그대로 다시** 돌렸다:

```
--- approval-prompt gone after 511ms (now kind=none)     ← 프롬프트는 여전히 잡힌다(판정은 그대로)
경고 `CLI 허가 프롬프트가 떠 있음`: 0건                    ← 오탐이 사라졌다
ℹ pass 1  ℹ fail 0   (43.5초)
[IT] leftover check: 12496=dead 37064=dead 16872=dead
```

---

## 검증

```
$ npx tsc --noEmit
(출력 없음)

$ npm test
ℹ tests 771
ℹ suites 118
ℹ pass 764
ℹ fail 0
ℹ skipped 7        (PIXEL_IT=1 통합 테스트)
```

기준선 742/735/7 → **+29 테스트**. (worktree 기준선을 만들려면 gitignore 대상인
`dev/spike-0/hooklog-2.json`·`hooklog-codex.json` 을 저장소 본체에서 복사해야 한다 — T44 함정 1 그대로.)

| 파일 | 건수 | 보는 것 |
|---|---|---|
| `test/usage/ClaudeTranscriptUsage.test.ts` | +12 | **cost-state 가 서브에이전트를 포함한다는 실측 대조**(세션 2개) · 본 파일과 서브 파일의 id 가 안 겹친다 · `claudeTotalsOf`/`addUsageTokens` · 폴더 규칙 · `.meta.json` 거르기 · 새것부터 상한 · 폴더 없음 · 실측 파일 증분 읽기 |
| `test/usage/UsageTracker.test.ts` | +11 | 실측 세션 그대로 더해진다(1개·2개) · 폴더 없으면 예전 그대로 · 서브 파일 증분 · 새 서브에이전트가 다음 턴에 잡힌다 · **상한을 넘겨도 합계가 줄지 않는다** · resume 리셋 · cost-state 가 이긴다 · 멤버 삭제 · 목록 읽기 예외 삼킴 · Codex 는 안 본다 |
| `test/screen/screens.test.ts` | +2 | 실측 MCP 프롬프트 화면이 `approval-prompt` 로 잡힌다(항목 3개·제목 `Tool use`) · **같은 문장이 모델 산문에 있으면 안 잡힌다** |
| `test/input/InputQueue.test.ts` | +3(기존 2건 갱신) | **한 판 만에 사라지는 프롬프트는 경고 없음(오탐 회귀)** · 참 양성은 그대로 경고 · 깜빡이면 창이 다시 열린다 · 큐 차단은 지연 없음 |
| `test/office/ScreenWatch.test.ts` | +1(기존 1건 갱신) | 진짜 Office 알림 경로에서 실측 MCP 화면 → 경고 0 · 계속 떠 있으면 경고 1 |

픽스처는 전부 실측이다:
`claude-transcript-agents{,2}-{main,sub1,sub2}.jsonl`(위 실기 세션 2개에서 `attachment` 줄만 뺀 것 — T43-5 와
같은 규칙, 숫자는 손대지 않았다), `test/screen/fixtures/claude/approval-prompt-mcp.txt`(IT 덤프 그대로).

## 함정

1. **`claude -p` 는 cost-state 를 안 남긴다.** print 모드로 세션 3개를 만들고서야 알았다 — 회계 줄은
   **대화형 프로세스가 끝날 때** 적힌다. 서브에이전트 회계를 실측하려면 pty 로 띄워 `/exit` 로 끝내야 한다.
2. **서브에이전트 파일에 상한을 걸면 누적 토큰이 줄어든다.** "새것 50개" 만 보면 51번째가 생기는 순간
   1번 파일의 몫이 화면에서 사라진다. 놓아 줄 때 **합계를 접어 두고** 경로를 기억해 다시 잡지 않는 것이
   이 고침에서 제일 미묘한 지점이다.
3. **오탐이라고 부르기 전에 화면을 봐야 한다.** T44 는 "화면에 잠깐 뜬 허가 오버레이" 로 추정했고 그 추정은
   맞았지만, "패턴이 느슨해서" 라는 가설로 갔다면 엉뚱한 곳을 고쳤을 것이다. 덤프 한 장이 30분을 아꼈다.
4. **붙잡힌 허가(카드가 뜨는 경우)에는 이 프롬프트가 안 그려진다.** 같은 실행의 팀원 `Write` 허가는 덤프가
   없다. 그래서 "떠 있는 시간" 으로 가르는 것이 두 경우를 뒤섞지 않는다.
5. **`ScreenWatch.test.ts` 는 실제 타이머로 돈다.** 알림 창을 3초로 늘리면 그 테스트의 `sleep` 도 같이
   늘려야 한다(`TIMING.dialogBlockedNoticeMs` 를 import 해서 쓰게 해 뒀다 — 상수를 바꾸면 따라온다).
6. **transcript 폴더를 `fs.open` 으로 열면 Windows 에서는 성공한다**(T43-5 함정 3). 서브에이전트 목록도
   `stat().isFile()` 로 걸렀다.

## 결정

- **서브에이전트 토큰을 더한다.** 근거는 위 실측 3세션 — `cost-state` 가 그 몫을 포함하므로, 더하지 않으면
  세션이 끝나는 순간 숫자가 **위로 튄다**(본 파일만 기준 +48~65%). 더하면 0.1% 안에서 수렴한다.
- **회계 단위는 여전히 "본 transcript 파일 하나".** 서브에이전트 상태는 그 파일에 딸린 것이고, 경로가
  바뀌면 같이 버린다.
- **파일 상한은 50, 넘치면 합계만 남기고 놓아 준다.** 파일마다 `seenIds`(최대 2000개)를 들고 있어 무제한은
  메모리가 샌다. 놓아 준 파일을 **다시 잡지 않는** 것이 이중 계산을 막는 유일한 규칙이다.
- **허가 프롬프트 경고는 "지속" 으로 판정한다.** 화면 문구가 아니라 **떠 있는 시간**이 두 경우를 가르는
  실측 신호다(502ms 고정 vs 무한). 패턴 조이기는 별개의 강화이고, 이번 오탐의 원인이 아니었다.
- **큐 차단은 절대 늦추지 않는다.** 허가 프롬프트 위에 키가 나가는 일은 한 판도 있어서는 안 된다 —
  지연시킨 것은 사람에게 가는 알림뿐이다.
- **`PIXEL_SCREEN_DEBUG` 를 남긴다.** 화면 판정은 본질적으로 "그 순간의 화면" 이 유일한 증거라, 다음에
  같은 종류의 의심이 들 때 다시 만들 도구가 아니라 켜기만 하면 되는 도구여야 한다.

## 남은 것

- **살아 있는 동안 여전히 0~4% 과소**(서브에이전트를 더한 뒤 기준). 배경 haiku 와 세션 끝 숨은 호출은
  transcript 에 줄을 남기지 않아 구조적으로 못 센다 — T43-5 §남은 것 그대로다.
- **서브에이전트 파일 목록을 턴 종료마다 `readdir` 한다.** 파일이 수십 개면 `stat` 도 그만큼이다. 지금은
  턴당 한 번이라 무시할 만하지만, 더 잦아지면 mtime 캐시가 필요하다.
- **옛 CLI 가 서브에이전트 줄을 본 파일에 섞는다면 이중 계산이 된다**(그때는 두 파일이 같은 `message.id` 를
  갖는다). 2.1.275 는 섞지 않고, 테스트가 "id 가 안 겹친다" 를 실측으로 못 박아 뒀다 — CLI 가 바뀌면 그
  테스트가 먼저 깨진다.
- **Codex 의 서브에이전트는 확인하지 않았다.** rollout 의 `total_token_usage` 가 턴마다 누적값을 주므로
  같은 문제가 없을 가능성이 높지만 실측한 적은 없다.
- **컴팩션(`PreCompact`) 뒤 값이 어떻게 튀는지** 여전히 미확인(T43-0 부터 남아 있는 항목).
- **다른 CLI 다이얼로그에도 같은 "한 프레임" 현상이 있는지** 모른다. 지속 창은 `approval-prompt` 만이 아니라
  통과 키가 없는 다이얼로그 전부에 걸리므로 생기면 같이 걸러진다.
