# tui-maps — CLI 버전별 화면 패턴

`ScreenModel`(`src/screen/ScreenModel.ts`)이 headless 터미널 화면에서 "지시를 받을 수 있는가 / 작업 중인가 / 중단됐는가 / 어떤 다이얼로그가 떠 있는가 / 허가 프롬프트가 떠 있는가"를 판정할 때 쓰는 문구·키 시퀀스는 **코드가 아니라 이 폴더의 JSON에만** 둔다. CLI가 업데이트되어 문구가 바뀌면 코드가 아니라 맵을 고친다.

## 파일 이름 규칙

`<engine>-<major.minor>.json` — 예: `claude-2.1.json`, `codex-0.154.json`.

- `engine` 은 `src/pty/types.ts` 의 `Engine`(`claude` | `codex`)과 같아야 한다(파일 안의 `"engine"` 필드도 동일).
- 파일 이름의 버전은 major.minor 까지만. 안의 `"version"` 필드에는 실측한 정확한 버전(`2.1.270`, `0.154.0`)을 적는다.
- 패치 버전 안에서 문구가 바뀌면 같은 파일을 고치고 `version` 과 `source` 를 갱신한다. major.minor 가 바뀌어 화면이 달라지면 새 파일을 만든다(아래 "버전 추가").

## ScreenModel 이 맵을 고르는 방법

`src/screen/tuiMap.ts` 의 `BUILTIN` 표가 엔진 → JSON 을 정적으로 import 한다(`with { type: 'json' }`):

```ts
const BUILTIN: Record<Engine, TuiMapJson> = {
  claude: claude21,
  codex: codex0154,
};
```

`new ScreenModel({ engine })` 은 `loadTuiMap(engine)` 으로 엔진당 하나를 컴파일해 캐시한다. 즉 **엔진당 활성 맵은 한 개**이고, 어떤 버전을 쓸지는 `BUILTIN` 이 정한다. CLI 버전을 자동 감지하지는 않는다 — 데몬이 쓰는 CLI 버전(`docs/02-실측-체크리스트.md`)과 맵을 사람이 맞춘다.

테스트나 실험에서는 `new ScreenModel({ engine, tuiMap })` 으로 JSON(또는 `compileTuiMap` 결과)을 직접 주입할 수 있다.

### 버전 추가 절차

1. `src/tui-maps/<engine>-<major.minor>.json` 을 기존 파일을 복사해 만든다.
2. 실측 픽스처를 뜬다(아래 "픽스처 다시 뜨기") → 바뀐 문구를 맵에 반영하고 `verified`/`source` 를 채운다.
3. `tuiMap.ts` 의 import 와 `BUILTIN` 을 새 파일로 바꾼다(옛 파일은 지우거나, 롤백용으로 두려면 남겨도 된다 — `BUILTIN` 에 안 걸리면 로드되지 않는다).
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

### `dialogs[].kind`

`DIALOG_KINDS`(`tuiMap.ts`)에 있는 값만 허용된다.

- 자동 통과 대상(InputQueue 가 `suggestedKeys` 를 그대로 보낸다): `onboarding-enter`, `trust-folder-claude`, `trust-folder-codex`, `login-menu`, `security-notes`, `model-switch-offer`.
- **`approval-prompt`** — CLI 자체 허가 프롬프트(hook 이 없거나 만료된 뒤의 폴백, D-16). 자동 통과 금지: `detectDialog()` 는 `suggestedKeys: []` 를 주고, 허가/거부 키는 `approvalPrompt()` 가 `allowKeys`/`denyKeys` 로 따로 준다. 맵에서는 `keys`/`highlight` 대신 `allowKeys`/`denyKeys` 를 쓴다(둘 다 필수). `keys` 를 적으면 로더가 거부한다.

### `verified` / `source`

패턴마다(`promptReady`, `busy`, `interrupted`, `dialogs[]`) 실물을 봤는지 적는다(D-13).

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
