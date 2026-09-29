# tui-maps — CLI 버전별 화면 패턴

`ScreenModel`(`src/screen/ScreenModel.ts`)이 headless 터미널 화면에서 "지시를 받을 수 있는가 / 작업 중인가 / 중단됐는가 / 어떤 다이얼로그가 떠 있는가 / 허가 프롬프트가 떠 있는가"를 판정할 때 쓰는 문구·키 시퀀스는 **코드가 아니라 이 폴더의 JSON에만** 둔다. CLI가 업데이트되어 문구가 바뀌면 코드가 아니라 맵을 고친다.

## 파일 이름 규칙

`<engine>-<major.minor>[-<platform>].json` — 예: `claude-2.1.json`, `codex-0.154.json`, (필요할 때) `claude-2.1-darwin.json`.

- `engine` 은 `src/pty/types.ts` 의 `Engine`(`claude` | `codex`)과 같아야 한다(파일 안의 `"engine"` 필드도 동일).
- 파일 이름의 버전은 major.minor 까지만. 안의 `"version"` 필드에는 실측한 정확한 버전(`2.1.270`, `0.154.0`)을 적는다.
- 패치 버전 안에서 문구가 바뀌면 같은 파일을 고치고 `version` 과 `source` 를 갱신한다. major.minor 가 바뀌어 화면이 달라지면 새 파일을 만든다(아래 "버전 추가").

### 플랫폼 접미사 (T48-1 · D-48 ⑦)

로더는 **플랫폼 접미사가 붙은 파일을 먼저** 찾고, 없으면 접미사 없는 파일로 떨어진다:

```
claude-2.1-darwin.json   →   claude-2.1.json
```

접미사는 `process.platform` 값 그대로(`darwin` · `linux` · `win32`)다. **한 플랫폼에서만 화면이 다를 때 쓴다** — 첫 실행 신뢰 다이얼로그·준비 문구·`/usage`·`/status` 는 CLI 가 그리는 것이라 운영체제와 무관할 가능성이 높지만, 맥의 기본 터미널 크기·서체·유니코드 폭 때문에 **줄바꿈 위치**가 달라질 수 있다.

지금 저장소에는 접미사 파일이 **하나도 없다**(모든 플랫폼이 같은 맵을 쓴다). 맥 실기(`docs/design/맥-지원.md` 2단계 M3·M14)에서 화면이 다르면 그때 `PIXEL_SCREEN_DEBUG=1` 로 덤프를 떠서 `claude-2.1-darwin.json` 을 만들고 **바뀐 줄만** 고친다. 덧붙일 때 할 일은 두 줄이다: `tuiMap.ts` 의 import 한 줄 + `BUILTIN_FILES` 표의 한 줄(키가 파일 이름이다).

## ScreenModel 이 맵을 고르는 방법

`src/screen/tuiMap.ts` 의 `BUILTIN_FILES` 표가 **파일 이름 → JSON** 을 정적으로 import 한다(`with { type: 'json' }`), 그리고 `BUILTIN_VERSION` 이 엔진마다 쓸 버전을 정한다:

```ts
export const BUILTIN_VERSION: Record<Engine, string> = { claude: '2.1', codex: '0.154' };
export const BUILTIN_FILES: Record<string, TuiMapJson> = {
  'claude-2.1.json': claude21,
  'codex-0.154.json': codex0154,
};
```

`new ScreenModel({ engine })` 은 `loadTuiMap(engine)`(= `loadTuiMap(engine, process.platform)`) 으로 엔진·플랫폼당 하나를 컴파일해 캐시한다. 어떤 파일을 쓸지는 `resolveTuiMapFile()` 이 위의 접미사 규칙으로 고른다. 즉 **엔진당 활성 맵은 (플랫폼마다) 한 개**이고, 어떤 버전을 쓸지는 `BUILTIN_VERSION` 이 정한다. CLI 버전을 자동 감지하지는 않는다 — 데몬이 쓰는 CLI 버전(`docs/02-실측-체크리스트.md`)과 맵을 사람이 맞춘다.

테스트나 실험에서는 `new ScreenModel({ engine, tuiMap })` 으로 JSON(또는 `compileTuiMap` 결과)을 직접 주입할 수 있다.

### 버전 추가 절차

1. `src/tui-maps/<engine>-<major.minor>.json` 을 기존 파일을 복사해 만든다.
2. 실측 픽스처를 뜬다(아래 "픽스처 다시 뜨기") → 바뀐 문구를 맵에 반영하고 `verified`/`source` 를 채운다.
3. `tuiMap.ts` 의 import 를 더하고 `BUILTIN_FILES` 에 **파일 이름 키**로 등록한 뒤 `BUILTIN_VERSION` 을 새 버전으로 바꾼다(옛 파일은 지우거나, 롤백용으로 두려면 남겨도 된다 — `BUILTIN_VERSION` 이 가리키지 않으면 로드되지 않는다). 플랫폼 전용 맵을 더할 때는 `BUILTIN_FILES` 에 한 줄만 더한다(`BUILTIN_VERSION` 은 그대로).
4. `npx tsx --test "test/screen/*.test.ts"` 로 화면별 판정을 확인한다. 로더는 잘못된 정규식·모르는 `kind`/키·`approval-prompt` 규칙 위반을 **로드 시점에 throw** 하므로 데몬 기동 시 바로 드러난다.

## 스키마 요약

`TuiMapJson`(`tuiMap.ts`) 참고. 정규식은 JavaScript `RegExp`(u 플래그, `dialogs[].all` 은 m 플래그 추가). **JSON 이므로 백슬래시는 두 번**(`"\\s"`, `"\\?"`). `node -e "JSON.parse(require('fs').readFileSync('src/tui-maps/x.json','utf8'))"` 로 먼저 확인할 것.

| 섹션 | 뜻 |
|---|---|
| `promptReady.anyOf` | 화면 하단 `scanLines` 줄 안에 하나라도 보이면 준비 |
| `promptReady.noneOf` | 화면 어디든 보이면 준비 문구가 있어도 **비준비**(Codex `model: loading`) |
| `promptReady.inputLine` | (Codex) `prompt` 줄 아래 `statusWithin` 줄 안에 `status` 가 보이면 준비 |
| `busy.anyOf` | 작업 중 표시(스피너 줄, `esc to interrupt` 상태줄). `promptReady` 보다 우선 |
| `interrupted.anyOf` | Ctrl+C 뒤 중단 안내 |
| `inputBox` / `skipLines` | 책상 모니터 "마지막 줄" 계산에서 제외할 입력 상자·괘선·상태줄 |
| `dialogs[]` | 순서 = 우선순위. `all` 전부 매치하면 그 `kind` 와 통과 `keys`(`highlight` 로 현재 강조 항목에 따라 키를 바꿀 수 있다) |
| `usage` | **확인용 세션**(T43-4)이 여는 사용량 화면. 없으면 그 엔진은 화면에서 한도를 읽지 않는다 — 아래 절 |

### `usage` — 사용량 화면 (T43-4, D-45)

확인용 세션(`src/usage/UsageProbe.ts`)이 `/usage`(Claude) · `/status`(Codex) 를 열어 한도를 읽는다.
**CLI 문구는 코드에 한 글자도 없다** — 파서(`src/usage/parse/usageScreen.ts`)는 여기 적힌 정규식만 쓴다.

| 키 | 뜻 |
|---|---|
| `command` | 화면을 여는 슬래시 명령. 그대로 **타이핑**하고(붙여넣기 아님) 0.7초 뒤 Enter |
| `closeKeys` | 화면을 닫는 키 순서(보통 `["esc"]`) |
| `scrollback` | `true` 면 뷰포트가 아니라 **버퍼 전체**를 읽는다. Codex TUI 는 인라인 렌더라 패널이 40줄 위로 밀린다(T43-0 Q7) |
| `ready` | "패널이 다 그려졌다" 표지. **전부** 보여야 한다. 확인용 세션은 명령을 치기 **전의 `ready[0]` 등장 횟수**를 세 두고 그보다 늘어났을 때만 읽는다 — 스크롤백에 남은 지난번 패널을 새 것으로 착각하지 않게 |
| `blocks[]` | 한도 블록. **이름 있는 그룹**(`(?<percent>…)` 필수, `(?<resets>…)`·`(?<label>…)`·`(?<model>…)`)만 읽는다 |
| `blocks[].target` | `weekly`/`session` 이면 그 칸에 바로. `auto` 면 한 정규식이 여러 블록을 잡고 `label` 을 `sessionLabel`/`weeklyLabel` 에 대어 가른다 — 둘 다 아니면 **모델별 한도**(`model` 그룹이 라벨) |
| `blocks[].percentIs` | `used`(Claude `NN% used`) 또는 `left`(Codex `NN% left`). 데몬 안에서는 전부 `usedPercent` 로 통일한다(D-45 ③) |
| `plan` | 요금제(선택). 이름 있는 그룹 **`plan` 하나만** 읽는다 — 같은 줄에 계정 이메일이 있어도 그 그룹은 **만들지 않는다**(D-45 ②) |

규칙:

- 같은 칸을 여러 번 잡으면 **뒤의 것이 이긴다**(스크롤백에 옛 패널이 남는다).
- 리셋 문자열(`Sep 23, 12pm (Asia/Seoul)` · `14:02 on 28 Sep`)은 `parse/resetText.ts` 가 ISO(UTC)로 바꾼다.
  **연도가 화면에 없으므로** 작년·올해·내년 중 `now` 에 가장 가까운 것을 고른다. 못 읽어도 **퍼센트는 살린다**(`resetsAt:null`).
- 블록이 **하나도** 안 맞으면 그 판을 통째로 버리고 `daemon.notice{warn}` 을 **엔진당 데몬 수명에 한 번**만 낸다.
- 로더가 `(?<percent>…)` 없는 패턴·모르는 `target`/`percentIs` 를 **로드 시점에** 거부한다.
- 검증은 `test/usage/usageScreen.test.ts` 가 **실측 캡처**(`test/fixtures/usage/screens/`, 원본 `dev/spike-1/out/`)로 한다.
  Codex 의 `5h limit` 줄만 **미검증**이다 — Pro 계정에서는 나오지 않는다(rollout `secondary` 도 전수 null).

### `dialogs[].kind`

`DIALOG_KINDS`(`tuiMap.ts`)에 있는 값만 허용된다.

- 자동 통과 대상(InputQueue 가 `suggestedKeys` 를 그대로 보낸다): `onboarding-enter`, `trust-folder-claude`, `trust-folder-codex`, `login-menu`, `security-notes`, `model-switch-offer`.
- **`approval-prompt`** — CLI 자체 허가 프롬프트(hook 이 없거나 만료된 뒤의 폴백, D-16). 자동 통과 금지: `detectDialog()` 는 `suggestedKeys: []` 를 주고, 허가/거부 키는 `approvalPrompt()` 가 `allowKeys`/`denyKeys` 로 따로 준다. 맵에서는 `keys`/`highlight` 대신 `allowKeys`/`denyKeys` 를 쓴다(둘 다 필수). `keys` 를 적으면 로더가 거부한다.

### `verified` / `source`

패턴마다(`promptReady`, `busy`, `interrupted`, `dialogs[]`, `usage`) 실물을 봤는지 적는다(D-13).

- `verified: true` — `source` 에 적힌 **실제 화면 캡처 픽스처**(`test/screen/fixtures/…`)로 `test/screen/screens.test.ts` 가 검사한다. `verified:true` 인데 `source` 가 없으면 `ScreenModel.test.ts` 가 실패한다.
- `verified: false` — 추정 패턴. `source` 에 근거(바이너리 문자열, 문서 등)와 왜 실물을 못 봤는지 적는다. 실기동에서 확인되면 픽스처를 추가하고 `true` 로 바꾼다.
- 파일 상단 `source` / `notes` 에는 실측 조건(날짜, 터미널 크기, 플래그)과 함정을 적는다.

현재 미검증: Claude `login-success`(항상 로그인된 상태라 못 봄) 하나뿐이다.

Codex `approval-exec` 는 **T42(2026-09-21)에 실물로 확정**됐다(`fixtures/codex/approval-prompt.txt`). T21 이 바이너리
문자열로 추정했던 제목·키(`allowKeys:['enter']`, `denyKeys:['esc']`)는 맞았고, 항목 문구만 달랐다 —
실물은 `› 1. Yes, proceed (y)` / `2. …don't ask again for commands that start with … (p)` /
`3. No, and tell Codex what to do differently (esc)`, 푸터는 `Press enter to confirm or esc to cancel`.
제목 위에 `Environment: local` 과 `Reason: <한국어 승인 문구>`(= hook `tool_input.description` 과 같은 문장)가 붙는다.
같은 캡처에서 **도구가 실제로 도는 중 화면**(`working-1~4.txt`)도 처음 받았다.

## 픽스처 다시 뜨기

픽스처는 **실제 CLI 를 ConPTY 로 띄워 ScreenModel 이 보는 그대로**(뷰포트 = `buffer.active.baseY` 기준, 각 줄 오른쪽 공백 제거, 뒤쪽 빈 줄 제거) 평문으로 저장한 것이다. 스파이크 시절 `screen()` 헬퍼는 버퍼 0행부터 읽어 Codex(일반 버퍼 + 스크롤백) 작업 중 화면이 안 남았으므로, 반드시 아래 도구를 쓴다.

```
cd dev/daemon
# Codex: 신뢰된 cwd + .codex/hooks.json 없는 폴더(승인이 hook 이 아닌 TUI 로 뜨게)
npx tsx test/screen/tools/capture-codex.ts <cwd>
#   env: PIXEL_CODEX_EXE(실행 파일), CODEX_MODEL(모델 덮어쓰기), CODEX_CAPTURE_LOG(프레임 로그 경로)
# Claude: 신뢰된 cwd(기본 dev/spike-0/sandbox), --settings 없이 → hooks 없음 → 허가는 TUI 프롬프트
npx tsx test/screen/tools/capture-claude.ts [cwd]
#   env: PIXEL_CLAUDE_EXE, CLAUDE_CAPTURE_LOG
```

- 산출물: `test/screen/fixtures/codex/*.txt`, `test/screen/fixtures/claude/*.txt`. 프레임 로그(화면이 바뀔 때마다 한 프레임 + `ready/busy/intr/dialog` 판정)는 기본 `test/screen/tools/.capture-*.log` — 커밋하지 말 것. 로그에서 원하는 프레임을 골라 픽스처로 옮겨도 된다(`--- FRAME … --- END ---` 블록).
- 시나리오는 `capture-*.ts` 안에 있다(READY → 작업 중 → Ctrl+C 중단 → 승인 프롬프트 거부 → 종료). 새 화면이 필요하면 시나리오에 단계를 추가한다. 도구는 끝나면 반드시 자식 프로세스를 kill 하고, 승인 실험으로 생긴 파일을 지운다.
- 픽스처를 갱신했으면 `screens.test.ts` 의 기대값(마지막 줄 문구 등)과 맵의 `source` 를 같이 갱신한다.
- 한글이 섞인 줄은 2칸 문자라 120칸을 넘어 줄바꿈될 수 있다. 판정 함수는 내용 기준이라 무해하지만, 행 번호를 검사하는 테스트는 주의.
