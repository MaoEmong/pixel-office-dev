# T02 — ScreenModel

- 날짜: 2026-09-14
- 마일스톤: M0
- 관련 설계: 01-설계문서.md §구성 요소 1 "ScreenModel", §실측 결과 반영(첫 실행 다이얼로그·중단), 02-실측-체크리스트.md ① ④
- 커밋: (미커밋 — 상위 태스크에서)

## 목표

멤버당 headless 터미널(`@xterm/headless` + serialize 애드온) 하나가 pty 출력을 전부 받아, (a) attach 시 보낼 직렬화 화면, (b) 책상 모니터의 "마지막 줄", (c) 첫 실행 다이얼로그 감지 + 통과 키, (d) prompt ready 판정의 단일 소스가 된다. 화면 문구·키 시퀀스는 코드가 아니라 CLI 버전별 JSON(`src/tui-maps/`)에만 둔다.

## 한 것

작업 시작 시점에 `src/screen/`·`src/tui-maps/`·`test/screen/`에 이전 시도가 남아 있었으나 **셋 다 깨진 상태**였다: 두 JSON이 JSON 문법 위반(`"\? for shortcuts"`, `"\s"` — JSON 은 `\?`·`\s` 이스케이프를 허용하지 않음)이라 `tsx`가 로드 자체를 못 했고, `tuiMap.ts`에 TS2367 타입 오류, 화면별 판정 테스트는 없었다. 이를 고치고 부족한 부분을 채웠다.

- `dev/daemon/src/screen/ScreenModel.ts` — 공개 API:
  - `new ScreenModel({ engine: 'claude'|'codex', cols, rows, tuiMap?, scrollback? })`
  - `feed(data): Promise<void>` (xterm write 는 비동기 → 화면 읽기 전 await), `resize(cols, rows)`, `serialize(): string` (ANSI, 스크롤백 포함), `lines(): string[]` (보이는 rows 줄, `translateToString(true)`, `baseY` 기준 = 뷰포트), `trimmedLines()`, `text()`, `lastLines(n)`, `lastNonEmptyLine()`, `promptReady()`, `detectDialog(): { kind, suggestedKeys }`, `busyIndicator()`, `interrupted()`, `dispose()`, getter `cols`/`rows`/`engine`/`tuiMap`.
  - `lastNonEmptyLine()` 의 입력 상자 식별을 다시 썼다: **"아래에 빈 줄·괘선·상태줄만 있는 prompt 줄"** 을 입력 상자로 본다(`inputBoxRow()`). Codex 는 지난 프롬프트를 `› ` 로 다시 그리고 신뢰 다이얼로그 강조도 `›` 라서 "마지막 `›` 줄" 규칙으로는 작업 중 화면·다이얼로그에서 엉뚱한 줄이 잘려 나갔다.
- `dev/daemon/src/screen/tuiMap.ts` — JSON → RegExp 컴파일 + 검증(잘못된 정규식·모르는 key/kind 는 로드 시점에 throw). TS2367 수정(`d.kind` 를 `string` 으로 받아 검사).
- `dev/daemon/src/tui-maps/claude-2.1.json`, `codex-0.154.json` — 유효한 JSON 으로 재작성(백슬래시 이중화). 각 항목에 `verified` 와 출처 로그를 적었다.
- `dev/daemon/test/screen/screens.test.ts` (신규, 21건) — 스파이크 로그에서 복사한 `fixtures/*.txt` 로 화면별 `promptReady`/`detectDialog`/`lastNonEmptyLine`/`busyIndicator`/`interrupted` 검사. `ScreenModel.test.ts` (기존 8건: feed 비동기, 뷰포트, resize, serialize 왕복, tui-map 로딩·검증·주입) 는 잘못된 기대값 1건 수정.

## 검증

```
$ cd dev/daemon && node -e "for (const f of ['src/tui-maps/claude-2.1.json','src/tui-maps/codex-0.154.json']) { JSON.parse(require('fs').readFileSync(f,'utf8')); console.log(f,'OK'); }"
src/tui-maps/claude-2.1.json OK
src/tui-maps/codex-0.154.json OK

$ npm run typecheck
> tsc --noEmit
(출력 없음 — 오류 0)

$ npx tsx --test test/screen/*.test.ts
✔ feed is async: lines() reflects data only after await
✔ lines() is the viewport (bottom rows), not the top of the scrollback
✔ resize changes cols/rows and keeps the bottom of the screen visible
✔ serialize() roundtrip: ANSI colours + wide chars + cursor moves reproduce the same lines()
✔ serialize() roundtrip after resize
✔ loadTuiMap compiles the built-in JSON maps once per engine
✔ compileTuiMap rejects bad regex / unknown key / unknown kind
✔ a custom tuiMap (JSON or compiled) can be injected
✔ claude: onboarding theme picker → onboarding-enter, enter
✔ claude: login method menu → login-menu, enter
✔ claude: security notes → security-notes, enter
✔ claude: trust dialog with "No, exit" highlighted → trust-folder-claude, down+enter
✔ claude: trust dialog with "Yes, I trust this folder" highlighted → enter only
✔ claude: fullscreen renderer offer → onboarding-enter, enter (run8)
✔ claude: READY screen → promptReady, no dialog, last line skips rule/effort/status lines
✔ claude: READY screen with grey autosuggest text in the input box is still ready and ignored
✔ claude: working screen → busy, not ready, last line is the spinner
✔ claude: busy is detected from the spinner line alone (status line may lag)
✔ claude: "✻ Cogitated for 9s · done" is a completion marker, not busy
✔ claude: Interrupted screen after ctrl-c → interrupted AND promptReady (no Stop hook, idle by screen)
✔ claude: Interrupted screen at 80x30 (after resize in the spike) behaves the same
✔ claude: after Stop the answer text is the last line and the prompt is ready
✔ codex: trust dialog with "Yes, continue" highlighted → trust-folder-codex, enter
✔ codex: trust dialog with "No, quit" highlighted → up+enter
✔ codex: READY screen → promptReady via placeholder, no dialog
✔ codex: READY screen without the placeholder still counts as ready ("› " line + status line with " · ")
✔ codex: boot screen (model loading) is already prompt-ready
✔ codex: working screen (no input line at the bottom) is not ready
✔ codex: after Stop the prompt is ready again and the status line is skipped
ℹ tests 29  ℹ pass 29  ℹ fail 0
```

패턴 출처(로그에서 실물 확인):

| 패턴 | 로그 |
|---|---|
| `Choose the text style` | run3 |
| `Select login method` | run3, run4 |
| `Security notes` + `Press Enter to continue` | run4 |
| `trust this folder` / `❯ No, exit` 기본 강조 | run4, run5, run6 |
| `Try the new fullscreen renderer?` | run8 |
| `? for shortcuts` | run8, run9 |
| `shift+tab to cycle` | run7 |
| `esc to interrupt`, 스피너 `✢ Newspapering… (6s · ↓ 250 tokens)` | run8, run9 |
| `Interrupted · What should Claude do instead?` | run9 |
| Codex `Do you trust the contents of this directory?` / `› 1. Yes, continue` | run-codex2 |
| Codex `› Ask Codex to do anything` + `gpt-6-astra high · <cwd>` | run-codex3, run-codex5 |

## 발견한 함정

- **JSON 안의 정규식 이스케이프.** `"\?"`·`"\s"` 는 JSON 문법 오류다. 반드시 `"\\?"`·`"\\s"`. esbuild(tsx) 는 `Syntax error "?"` 로 파일 로드 자체를 거부한다 → 런타임 전에 잡히긴 하지만, 맵 파일을 고칠 때 `node -e "JSON.parse(...)"` 로 먼저 확인할 것.
- **실제 화면에 NBSP(U+00A0).** Claude 의 `⎿  Interrupted …` 줄은 `⎿` 뒤 두 번째 공백이 NBSP 다. 정규식은 `\s` 로 맞춰야 하고(`\s` 는 NBSP 포함), 문자열 `===` 비교는 깨진다. 모니터 텍스트 표시엔 무해.
- **Codex 의 `›` 는 입력 상자 전용이 아니다.** 제출한 프롬프트를 이력에 `› …` 로 다시 그리고, 신뢰 다이얼로그 강조도 `›` 다. "마지막 `›` 줄 = 입력 상자" 규칙은 작업 중 화면에서 답변 전체를 잘라 먹었다 → "아래에 빈 줄/상태줄/괘선만 있는 prompt 줄" 규칙으로 교체.
- **`✻ Cogitated for 9s · done`** 은 작업 중 표시가 아니라 **완료 표시** 다(run9). 작업 중에는 `✢ Newspapering… (6s · …)` 처럼 `…` + `(` 가 붙은 스피너 줄과 `esc to interrupt` 상태줄이 뜬다. busy 는 그 둘로 판정한다.
- **스파이크 `screen()` 헬퍼는 버퍼 0행부터 읽는다.** Claude(alt buffer, flicker-free) 는 0행 = 화면이지만 Codex(일반 버퍼 + 스크롤백) 는 스크롤백 상단이 찍힌다 → Codex 작업 중 화면(스피너·상태줄·중단 문구)이 로그에 없다. ScreenModel 은 `buffer.active.baseY + y` 로 뷰포트를 읽는다(테스트 "lines() is the viewport").
- **한글 + 오른쪽 공백 패딩된 픽스처는 120칸을 넘어 줄바꿈된다** (한글은 2칸). 실제 화면과 행 번호가 1~2 어긋날 수 있으나 판정 함수는 내용 기준이라 영향 없음. 정확한 행 번호를 검사하려면 픽스처에서 trailing space 를 지울 것.
- 이전 시도의 `serialize()` 왕복 테스트 기대값 `' bg  tXil'` 은 산술 오류(CUP `2;8` 은 1-based 8열 = `i`). 실제 동작 `' bg  taXl'` 이 맞다.

## 결정

04-결정기록.md 는 이 태스크 범위 밖이라 안 건드렸다. 상위에서 번호 부여할 후보:

- 화면 문구·키 시퀀스는 코드가 아니라 `src/tui-maps/<engine>-<version>.json` 에만 둔다. 로더가 로드 시점에 정규식·키·kind 를 검증해 잘못된 맵은 데몬 기동 시 바로 죽는다(런타임 조용한 실패 방지).
- `promptReady()` 는 다이얼로그 감지·busy 감지보다 **후순위** — 다이얼로그나 스피너가 보이면 준비 문구가 있어도 false.
- 입력 상자 식별 규칙: "아래에 빈 줄·skipLines 만 있는 prompt 줄"(Claude 는 추가로 윗줄 괘선).

## 남은 것

- **로그로 검증 못 한 패턴** (JSON 에 `verified:false` 표기, 실기동에서 확인):
  - Claude `Login successful` + `Press Enter` (dialogs[login-success]) — 어느 로그에도 없음. 스파이크는 이미 로그인된 상태였음.
  - Codex `busy` (`esc to interrupt`) 와 `interrupted` (`Conversation interrupted|Interrupted`) — 위 함정대로 Codex 작업 중 화면이 로그에 없음. M3 에서 `baseY` 기준으로 다시 캡처해 확정.
- Codex 상태줄 패턴 `^\s*\S+ (default|minimal|low|medium|high|xhigh) · ` 는 모델명이 공백 없는 한 단어라는 가정. 모델명이 바뀌면 skipLines 조정.
- 스피너 글리프 집합 `[✻✢✶✽✳*·]` 은 run8/run9 에서 본 것 + Claude Code 스피너로 알려진 것. 새 글리프가 나오면 JSON 에 추가.
