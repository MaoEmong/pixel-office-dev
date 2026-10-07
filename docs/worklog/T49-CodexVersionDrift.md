# T49 — codex 0.159 에서 지시가 제출되지 않던 원인 (CLI 버전 드리프트)

- 날짜: 2026-09-29
- 마일스톤: M6
- 관련 결정: **D-50**(이 작업에서 추가) / 확장한 것 D-48 ⑦(tui-map 로더 규칙) / 취소한 추정 T48-3 M4 함정 ⑤
- 앞선 기록: `docs/worklog/T48-3-MacLive.md` "한 것" 12 · "남은 것" ①③
- 브랜치: `T48-3`
- 환경: **macOS 26.6 / arm64** · Node v24.18.0 · **codex 0.159.0** · claude 2.1.284

## 목표

T48-3 이 "남은 것" 으로 넘긴 둘을 끝낸다.

1. **최신 codex(0.159)로 지시가 제출되지 않는 원인을 확정하고 고친다.** T48-3 은 "맵 문제는 아니다" 까지
   확인하고 원인을 **데몬의 세션 설정**(spawn 인자 · `.codex/hooks.json`)으로 좁혀 두었다.
2. **로더가 내장 상수 대신 설치된 CLI 버전을 읽게** 한다(두 엔진 다 버전이 앞서 나가 있었다 —
   상수는 claude 2.1 · codex 0.154, 설치된 것은 2.1.284 · 0.159.0).

## 결과 요약

| # | 확인 | 결과 |
|---|---|---|
| 1 | 원인 확정 | **찾았다 — 세션 설정이 아니다.** 0.159 가 새로 만든 **폴더 신뢰 모달**을 옛 맵이 못 읽었다(아래 "원인") |
| 2 | 앞선 추정(hooks·spawn 인자) | **둘 다 무죄.** 맨 `codex`(인자 0개, hooks 없음)도 똑같이 실패했다 |
| 3 | 고침 | `codex-0.159.json` 추가 + 로더가 `--version` 을 읽어 맵을 고른다 |
| 4 | 실기 검증 | `codex.integration.test.ts` 한 바퀴 통과 — 신뢰 안 된 폴더(모달 통과, 재시도 0회)와 신뢰된 폴더(모달 없음, 재시도 1회 = D-46 의 평소 모양) **두 갈래 다** · 확인용 세션 복구 |
| 5 | 회귀 | 데몬 단위 테스트 884 → **905**(896 통과 · 9 스킵) |

## 한 것

### 1. 이분 탐색 — 인자와 hooks 를 하나씩 붙였다 (그리고 둘 다 무죄였다)

T48-3 이 남긴 대본대로, 맨 pty 스폰에 데몬의 설정을 한 단계씩 얹으며 제출 여부를 봤다
(`node-pty` + 실제 `ScreenModel`, 120×40, 괄호 붙여넣기 + `\r`):

| # | 붙인 것 | 제출 |
|---|---|---|
| A | 없음 (맨 `codex`) | **안 됨** |
| B | `--dangerously-bypass-hook-trust` | 안 됨 |
| C | + `-c approval_policy="on-request" -c sandbox_mode="workspace-write"` | 안 됨 |
| D | + `-c mcp_servers.team.url=…` | 안 됨 |
| E | + `.codex/hooks.json`(8종) | 안 됨 |

**A 에서 끝났다.** 아무것도 붙이지 않아도 실패하므로 원인은 데몬의 세션 설정이 아니다 — T48-3 의 추정
(특히 "`UserPromptSubmit` hook 이 제출 경로에 끼어 있다")은 **틀렸다**. 곁가지로 확인한 것 둘:

- **0.159 의 hook 은 정상이다.** 같은 실험에서 `SessionStart` · `UserPromptSubmit` · `Stop` 이 모두
  우리 hook 스크립트로 왔다. 바이너리에 박힌 `user-prompt-submit.command.output` JSON 스키마도 확인했는데
  모든 필드에 기본값이 있어 **우리가 돌려주는 `{}`(pass-through)가 그대로 유효**하다.
- 그런데 **0.159 는 폴더가 신뢰되기 전에는 hook 을 아예 로드하지 않는다** — 모달을 통과하기 전에는
  `SessionStart` 조차 오지 않았다(`--dangerously-bypass-hook-trust` 를 줘도 그렇다). 신뢰 모달을 못 넘기면
  센서가 통째로 죽는다는 뜻이다.

### 2. 원인 — 0.159 의 신뢰 모달이 **준비 화면 뒤에** 뜨고, 옛 맵은 그것을 모른다

변형 A 를 신뢰 안 된 폴더에서 화면을 통째로 찍어 보니 순서가 이렇다.

```
----- 스폰 직후 | ready=true busy=false dialog=none
› Ask Codex to do anything
  ? for shortcuts
----- 25초 뒤 | ready=true  busy=false  dialog=none     ← 판정이 안 바뀐다
  Folder access
  /Users/…/codexprobe-late
  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. …
› 1. Trust and continue
  2. Quit
  enter continue · esc quit
```

한 줄로: **준비 화면이 먼저 그려지고, 모달이 몇 초 늦게 올라온다.** 그런데 두 화면 모두
`dialog=none` · `ready=true` 다. 왜 그런지가 이 버그의 전부다.

- 0.154 의 신뢰 다이얼로그는 `Do you trust the contents of this directory?` + `1. Yes, continue` /
  `2. No, quit` + `Press enter to continue` 였다. 0.159 는 **문구·선택지·푸터가 전부 다르다** →
  `dialogs[].all` 이 안 맞아 `detectDialog()` 가 `none` 을 준다.
- 그러면 `promptReady()` 가 막아 줘야 하는데, 0.154 맵의 판정은 "하단에 `› ` 로 시작하는 줄이 있고 3줄 안에
  ` · ` 가 있으면 준비" 다. 모달의 강조 줄이 **`› 1. Trust and continue`** 이고 푸터가
  **`enter continue · esc quit`** 이라 **둘 다 맞는다** → `ready=true`.

그래서 데몬은 이렇게 움직였다.

1. `promptReady()=true` → 멤버를 `idle` 로 올린다(실기 로그의 `idle` 까지는 정상이었던 이유).
2. 첫 지시를 **모달 위에** 붙여넣는다. 모달은 목록 선택기라 **글자를 버린다**.
3. 300ms 뒤 Enter → `1. Trust and continue` 가 선택된다. 모달이 닫히고 폴더가 신뢰된다.
4. 입력 상자는 **비어 있다**. `isIdle()` 은 계속 true → `checkSubmit()` 이 2.5초마다 Enter 를 4번 더
   보내지만 **빈 상자의 Enter 는 무동작**이다 → `submitLost`.

실기 로그가 정확히 그 모양이었다:

```
[daemon:info] 부장: 프롬프트가 안 들어가 Enter 를 다시 보냄 (1)…(4)
[daemon:warn] 부장: 지시가 입력 상자에 남아 제출되지 않았습니다
```

> 경고 문구는 사실과 조금 다르다 — 지시는 입력 상자에 **남은 게 아니라 버려졌다**. 문구는 T42 의
> `codex resume` 상황(정말 상자에 남는다)에서 온 것이라 그대로 두었다.

**확인용 세션이 같이 실패한 것도 같은 원인이다.** 그 세션의 cwd 는 늘 새 폴더
(`<dataDir>/usage-probe/codex`)라 매번 모달을 만나고, `/status` 타이핑이 모달에 버려졌다
(`/status 화면이 뜨지 않았습니다`).

**대조**: 이미 신뢰된 폴더에서는 **인자·hooks 를 다 붙여도 첫 Enter 에 제출된다**(0.159에서
`• Working (0s • esc to interrupt)` 확인). 즉 0.159 자체는 멀쩡하고, 갈리는 것은 신뢰 모달 하나다.

### 3. T48-3 이 "콘솔 클라이언트의 렌더링 아티팩트" 라고 한 것은 맞다

`›Ask Codex to do anything`(공백 없음)은 실제 화면이 아니다. 이번에도 실화면은
`› Ask Codex to do anything` 이고 `? for shortcuts` 다. 그 판단은 그대로 유효하다.

### 4. 고친 것 ① — `codex-0.159.json`

0.154 맵을 뜨고 **실측으로 달라진 넷만** 바꿨다.

| 바뀐 것 | 0.154 | 0.159 |
|---|---|---|
| 신뢰 모달 | `Do you trust the contents of this directory?` · `1. Yes, continue`/`2. No, quit` · `Press enter to continue` | `Folder access` + `Trust this folder? …` · `1. Trust and continue`/`2. Quit`(또는 `2. Back to Agent Command Center`) · `enter continue · esc quit` |
| 하단 푸터 | `? for shortcuts` | `? for shortcuts` **+ 같은 줄에** `⚠ n warnings · f2 to view` |
| `/status` 계정 줄 | `Account:  <이메일> (Pro)` | `Account:  Pro (More)` |
| `/status` 괘선 | `│ … │` 로 감싼 패널 | 괘선 없음(한도 줄 모양은 같다) |

- 신뢰 모달은 `all: ["Trust this folder\\?"]` 로 잡고, 강조에 따라 `1.` → `['enter']`,
  `2.` → `['up','enter']`. **`esc` 는 넣지 않았다** — 0.159 푸터는 `esc quit` 이고 실제로 종료된다.
- 0.158 이하 문구도 **같은 맵에 함께** 뒀다(`trust-directory-legacy`). 어느 버전에서 바뀐지 모르므로
  0.155~0.158 이 이 맵으로 내려올 수 있다.
- `promptReady.noneOf` 에 `Trust this folder\?` 를 **일부러 겹쳐** 넣었다. 다이얼로그 매칭이 미래에 또
  어긋나도 "모달이 떠 있는데 준비됐다" 고 말하지 않게 하는 이중 안전장치다 — T49 는 바로 그 한 줄이 없어서
  지시를 잃었다.
- `skipLines` 의 `^\s*\? for shortcuts\s*$` 는 **줄 끝 고정을 풀었다**. 0.159 는 같은 줄에 경고를 붙이므로
  고정한 채로는 안 걸러지고, 그러면 `inputBoxRow()` 가 입력 상자를 못 찾아 **책상 모니터의 마지막 줄이
  `? for shortcuts  ⚠ 4 warnings · f2 to view` 로** 뜬다(사용자에게 보이는 자리다).
- `/status` 요금제 패턴은 `Pro (More)` 에서 `Pro` 를 집는다. 옛 패턴은 `<이메일> (Pro)` 모양을 전제해
  0.159 화면에서 **`More`** 를 요금제로 읽었다. 새 패턴은 이메일이 돌아오면 요금제를 **비운다**(D-45 ② —
  이메일을 흘리는 것보다 낫다).

### 5. 고친 것 ② — 로더가 `--version` 을 읽는다

`src/screen/cliVersion.ts`(새 파일) + `tuiMap.ts`.

- 데몬 기동 때 `<exe> --version` 을 한 번(타임아웃 5초) 돌려 `major.minor` 를 뽑는다. `claude` 는
  `2.1.284 (Claude Code)`, `codex` 는 `codex-cli 0.159.0` 을 찍으므로 **첫 `숫자.숫자`** 를 쓴다.
  실패는 기동 실패가 아니다 — 못 읽으면 폴백으로 간다. `spawnSync` 는 `platform.ts` 주입구로만 부른다.
- 맵 선택은 **근접 규칙**: 같은 버전 → 낮은 중 가장 높은 것 → 가장 낮은 것. 정확히 안 맞으면 **경고 한 줄**.
- `BUILTIN_VERSION`(엔진당 고정 버전) → **`FALLBACK_VERSION`**(못 읽었을 때만). 값은 **우리가 가진 가장
  새 맵**이다(옛 이름은 별칭으로 남겼다).
- **버전 감지는 `ScreenModel` 이 하나라도 생기기 전에** 끝나야 한다(`ScreenModel` 은 만들 때 맵을 컴파일해
  캐시한다) → `index.ts` 에서 `usage.start()`·`usageProbe.start()` **위**에 놓았다.

기동 로그:

```
[daemon] claude 2.1.284 (Claude Code) → tui-map 2.1
[daemon] codex codex-cli 0.159.0 → tui-map 0.159
```

### 6. 픽스처 캡처 도구를 하나 더 만들었다

`test/screen/tools/capture-codex-trust.ts`. 기존 `capture-codex.ts` 는 **신뢰된 cwd** 를 전제한다
(승인이 hook 이 아닌 TUI 로 뜨게 하려고) — 그 전제에서 이 모달은 **영원히 안 뜬다**. 그래서 신뢰 안 된
새 폴더로 띄우는 시나리오를 따로 뒀다: 모달(1번 강조) → ↓(2번 강조) → ↑+Enter → READY → 제출 →
작업 중 → 턴 종료 → `/status`.

> 함정: 모달에 **Esc 를 보내면 codex 가 그냥 종료된다**(`esc quit`). 처음 캡처에서 경고 패널을 닫으려고
> Esc 를 보냈다가 세션을 죽였다 — 그 뒤 화면이 전부 빈 화면으로 찍혔다.

## 검증

### 단위 테스트

```
$ cd dev/daemon && npx tsc --noEmit
(출력 없음, exit 0)
$ npm test
ℹ tests 905   ℹ pass 896   ℹ fail 0   ℹ skipped 9
```

새로 더한 것(0.154 → 0.159 로 바꾼 것이 아니라 **둘 다** 검사한다):

- `test/screen/screens.test.ts` — 0.159 화면 7건. 신뢰 모달 감지·강조별 키(`esc` 가 안 나가는 것 포함)·
  `2. Back to Agent Command Center` 변형·READY/작업 중/턴 종료 판정·새 경고 푸터가 마지막 줄로 안 나가는 것.
  마지막 한 건은 **0.154 맵으로 0.159 화면을 보면 `dialog=none` · `ready=true` 가 되는 것**을 못 박았다 —
  버그를 그대로 재현하는 테스트다.
- `test/usage/usageScreen.test.ts` — 0.159 `/status` 5건(요금제 `Pro`, 옛 맵이면 `More`, 이메일이 돌아오면
  요금제를 비움).
- `test/usage/UsageProbe.test.ts` — 확인용 세션을 **두 버전으로** 돌린다(0.154 화면 · 0.159 화면).
  `setInstalledCliVersion()` 을 고정해 두므로 **이 PC 에 깔린 codex 가 무엇이든 결과가 같다.**
- `test/screen/cliVersion.test.ts`(새 파일) — 17건. `--version` 파싱(두 CLI 실제 출력 모양)·ENOENT·0 아닌
  종료 코드·근접 규칙 4가지(같음/더 새것/사이/더 낡음)·폴백·캐시 무효화.
- `test/screen/tuiMapPlatform.test.ts` — 이름 규칙을 **파일 자신의 `version`** 기준으로 바꿨다(엔진당 맵이
  여러 개가 됐다). "폴백은 최신 맵" 을 지키는 테스트를 더했다.

### 실기 — 통합 테스트 한 바퀴 (codex 0.159.0)

sandbox 는 **신뢰 목록에 없던** 폴더다(= 실패했던 그 조건).

```
$ PIXEL_IT=1 npx tsx --test test/office/codex.integration.test.ts
[daemon] claude 2.1.284 (Claude Code) → tui-map 2.1
[daemon] codex codex-cli 0.159.0 → tui-map 0.159
[IT] department=d_6df56718a19f head=m_a0ecd1eb8512 engine=codex pid=95789 (253ms)
[IT] hooks.json: pixel-office events=SessionStart,UserPromptSubmit,PreToolUse,PermissionRequest,PostToolUse,Stop,Interrupt,SessionEnd
[IT] boot idle (756ms)
[IT] instruct task#1 (758ms)
[IT:c] event #1 thinking …  #2 running {"tool":"Bash","cmd":"echo t20 > ../t20.txt"}
[IT:c] event #3 waiting_approval …
[IT] allow → a_a5bdcd9df9f5 (10264ms)
[IT] turn ended (11814ms): ["완료했습니다."]
[IT] …/dev/spike-0/t20.txt = "t20\n"
[IT] clockOut done (15781ms); codex pid 95789 alive=false
✔ real daemon + real Codex: clockIn → instruct → waiting_approval → allow → file → clockOut
ℹ pass 1   ℹ fail 0
```

**재시도 로그가 한 줄도 없다** — 첫 Enter 에 제출됐다(신뢰 모달은 InputQueue 가 통과했다).

같은 테스트를 **한 번 더** 돌렸다(이제 sandbox 는 앞선 실행에서 신뢰됐으므로 **모달이 안 뜬다**):

```
[IT] instruct task#1 (694ms)
[office] 코덱스: 프롬프트가 안 들어가 Enter 를 다시 보냄 (1)
[IT] waiting_approval #3 … → allow → turn ended (11527ms): ["완료했습니다."]
✔ real daemon + real Codex: … (17281ms)      ℹ pass 1  ℹ fail 0
```

**재시도 1회가 났고, 이것은 회귀가 아니다** — D-46 ② 가 적어 둔 Codex 의 평소 모양이다("실기: Codex 멤버당
재시도 1회, Claude 0회"). 즉 두 갈래가 다 확인됐다: **모달이 뜨는 경우**(신뢰 안 된 폴더)는 InputQueue 가
모달을 통과한 뒤 첫 Enter 에 제출되고, **모달이 없는 경우**는 옛날부터 그랬듯 재시도 1회로 들어간다.
T49 의 증상은 "재시도 4회를 다 쓰고 포기" 였고, 그것은 두 갈래 어디에서도 다시 나지 않았다.

### 실기 — 확인용 세션(`/status`)

데몬을 임시 데이터 폴더로 한 번 띄웠다(`PIXEL_USAGE_PROBE_SEC=0` = 기동 뒤 한 번).
`사용량 확인용 세션(codex): /status 화면이 뜨지 않았습니다` 경고는 **나오지 않았고**, DB 에 값이 들어왔다:

```
engine_usage[codex] = {"connected":true,"plan":"pro",
  "weekly":{"usedPercent":45,"resetsAt":"2026-10-05T12:13:00.000Z"},"session":null,"source":"probe"}
engine_usage[claude] = {"connected":true,"plan":"max","weekly":{"usedPercent":10},…,"source":"probe"}
```

화면은 `Weekly limit: [███████████░░░░░░░░░] 55% left (resets 9:13 PM on 5 Oct)` — 45% used 로 뒤집힌 것이
맞다(D-45 ③). 요금제도 `Pro (More)` 에서 `pro` 를 읽었다.

## 남은 것

- **claude 2.1.284 의 `<pasted_content>` 봉투**가 사용자에게 보이는 로그·말풍선에 그대로 찍힌다
  (T48-3 M4 함정 ④). 테스트 쪽은 `unwrapPasted()` 로 막아 뒀지만 표시 경로는 그대로다 — 어디서 벗길지
  (어댑터 입구 / 표시 직전) 정하는 일이 남았다. 이번 작업 범위 밖이다.
- **0.159 맵의 미검증 항목 둘**: `interrupted`(중단 화면)과 `approval-prompt`·`model-switch-offer` 는
  0.159 에서 못 띄웠다(사용량 한도에 안 걸렸고, 승인은 hook 이 먼저 답한다) → 0.154 패턴을 그대로 두고
  `verified:false` 로 적었다. 실제로 뜨는 날 `capture-codex-trust.ts` 에 단계를 붙이면 된다.
- **부팅 중 `│ model: loading`** 을 0.159 에서 못 봤다(1초 안에 모달까지 갔다). `noneOf` 는 0.154 값을
  그대로 뒀다 — 맞으면 막고 아니면 없는 화면이라 해가 없다.
- 이 작업은 **플랫폼 무관**이다. 윈도우에서 따로 확인할 것은 없지만, 윈도우 실기 때 기동 로그의
  `→ tui-map …` 두 줄만 보면 된다.
