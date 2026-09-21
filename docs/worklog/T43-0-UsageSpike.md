# T43-0 — 사용량 데이터 실측 스파이크

- 날짜: 2026-09-21
- 마일스톤: M7(예정)
- 성격: **측정만 한다. 기능은 만들지 않는다.** 코디네이터가 설계할 수 있게 "어디서 무슨 값을 얼마나 신선하게
  얻을 수 있는가" 를 실기로 확인한 문서.
- 커밋: 없음(의도적으로 커밋하지 않음). 스크립트·원자료는 `dev/spike-1/` 에 그대로 둔다.

## 목표

앱에서 보여 주고 싶은 것은 둘이다.

1. **엔진별 주간 남은 사용량** — Claude / Codex 각각. CLI 가 없거나 로그인이 안 돼 있으면 "연결 안 됨".
2. **개체(팀원 세션)별 사용량과 컨텍스트 양**.

이걸 **사용자 자신의 구독 CLI 를 pty 로 몰아서** 얻을 수 있는지, 토큰 파일을 읽거나 벤더 API 를 직접
때리지 않고 얻을 수 있는지 확인했다. 결론부터: **둘 다 얻을 수 있다.** Claude 는 `statusLine` 페이로드가
거의 완전한 답이고, Codex 는 rollout JSONL 의 `token_count` 이벤트가 거의 완전한 답이다. 각각 "턴이
한 번도 없었을 때" 의 구멍이 하나씩 있고, 그 구멍은 TUI 화면(`/usage`, `/status`)이 메운다.

## 실측 환경

| 항목 | 값 |
| --- | --- |
| claude 실행 파일 | `C:\Users\User\AppData\Roaming\Claude\claude-code\2.1.275\claude.exe` |
| claude 버전 | `2.1.275 (Claude Code)` — **지시서의 2.1.270 은 이미 없다**(번들 폴더에 `2.1.271`·`2.1.275` 만 존재). `config.ts` 의 "가장 높은 버전" 규칙이 제대로 동작했다. |
| codex 실행 파일 | `...\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe` |
| codex 버전 | `codex-cli 0.154.0` (TUI 가 `0.155.1` 업데이트 알림을 띄운다) |
| 계정 | Claude = Max, Codex = Pro |
| 세션 cwd | `dev/spike-0/sandbox` |
| 데몬 | **띄우지 않았다.** hook 포트는 7440(claude)·7441(codex) — 7420~7422 는 건드리지 않음. |

스크립트와 원자료:

```
dev/spike-1/
  resolve-exe-lib.js            config.ts 와 같은 규칙으로 exe 찾기
  statusline-dump.js            statusLine 페이로드를 JSONL 로 적는 작은 스크립트
  pty-claude-usage.js           claude: hooks+statusLine 주입, 턴 1회, /context /cost /status /usage
  pty-claude-usage-fresh.js     claude: 턴 없이 /usage 만
  pty-claude-resume-statusline.js  claude: --resume 후 턴 없이 statusLine 관찰
  pty-codex-usage.js            codex: hooks 주입, 턴 2회, /status
  pty-codex-status.js           codex: 스크롤백 포함 /status 캡처(턴 전/후)
  pty-codex-status2.js          codex: 열자마자 /status
  inspect-claude-transcript.js  transcript JSONL 의 usage 집계
  inspect-codex-rollout.js / scan-rollouts.js
  parse-screens.js              화면 텍스트 → 구조체 (정규식 제안 + 검증)
  out/*.txt  out/*.json  out/*.jsonl   화면 덤프·hook 로그·statusLine 페이로드
```

---

## Claude Code

### Q1. transcript JSONL 의 `usage`

`transcript_path` 는 **모든 hook 페이로드에 들어 있다**(`SessionStart`·`UserPromptSubmit`·`Stop` 전부).
예: `C:\Users\User\.claude\projects\D--myproject-pixel-office-dev-spike-0-sandbox\<sessionId>.jsonl`
— 프로젝트 폴더 이름은 cwd 를 슬러그로 바꾼 것이고, 파일 이름은 세션 id 다. **경로를 직접 조립할 필요가 없다.**

`type:"assistant"` 줄의 `message.usage`:

```json
{
  "input_tokens": 2,
  "cache_creation_input_tokens": 14495,
  "cache_read_input_tokens": 29413,
  "output_tokens": 3,
  "output_tokens_details": { "thinking_tokens": 0 },
  "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
  "service_tier": "standard",
  "cache_creation": { "ephemeral_1h_input_tokens": 14495, "ephemeral_5m_input_tokens": 0 },
  "iterations": [ { "input_tokens": 2, "output_tokens": 3, "cache_read_input_tokens": 29413, "cache_creation_input_tokens": 14495 } ]
}
```

`message.model` 은 `claude-opus-5`(별칭 없는 짧은 이름), 같은 줄의 최상위에 `session_id`·`version`·`cwd`·`gitBranch` 가 있다.

**(a) 세션 누적 토큰** — 직접 합산하면 **이중 계산된다**. 같은 응답이 여러 줄로 기록되고 `usage` 가
그대로 복제된다. 실측(`50bf151e…jsonl`, assistant 4줄):

```
uuid ef377b0e reqId req_011Cf8pxuazpGER8fZFThzke msgId msg_011Cf8pxv7FR3z7azG5joN3A in 2 out 173 cr 39249
uuid 77b4f1f6 reqId req_011Cf8pxuazpGER8fZFThzke msgId msg_011Cf8pxv7FR3z7azG5joN3A in 2 out 173 cr 39249   ← 같은 응답
uuid 5e47a226 reqId req_011Cf8py9jHzKr86MemhY1rt msgId msg_011Cf8pyAHYGWZ4jFfUeLHvb in 2 out 174 cr 54140
uuid 23a2df17 reqId req_011Cf8pyLyUMjv3ZkTohv8wi msgId msg_011Cf8pyMWy94ZpKhDNomEcu in 2 out 160 cr 54993
```

→ 합산할 거면 **`message.id`(또는 `requestId`)로 중복을 제거**해야 한다.

하지만 합산할 필요가 없다. 같은 파일에 **`type:"cost-state"`** 줄이 주기적으로 append 된다 —
이게 CLI 자신이 계산한 누적값이다:

```json
{
  "type": "cost-state",
  "sessionId": "50cc7bea-750f-4e3f-8492-4c4595194b6d",
  "totalCostUSD": 0.16072150000000002,
  "totalAPIDuration": 2133, "totalToolDuration": 0,
  "totalLinesAdded": 0, "totalLinesRemoved": 0,
  "totalDuration": 133957, "startTime": 1789974812217,
  "modelUsage": {
    "claude-haiku-4-5-20251001": { "inputTokens": 910, "outputTokens": 14, "thinkingTokens": 0,
                                   "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0,
                                   "webSearchRequests": 0, "costUSD": 0.00098 },
    "claude-opus-5[1m]":         { "inputTokens": 2, "outputTokens": 3, "thinkingTokens": 0,
                                   "cacheReadInputTokens": 29413, "cacheCreationInputTokens": 14495,
                                   "webSearchRequests": 0, "costUSD": 0.1597415 }
  },
  "hasUnknownModelCost": false
}
```

**모델별로 나뉘어 있고**(서브에이전트가 쓴 haiku 도 따로 잡힌다) 비용까지 들어 있다. 마지막 `cost-state`
줄만 읽으면 그 세션의 누적이 끝난다.

**(b) 현재 컨텍스트 크기** = **마지막 assistant 메시지의 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`**.
실측으로 정확히 맞는다:

```
transcript 계산: 2 + 14495 + 29413 = 43910
statusLine     : context_window.total_input_tokens = 43910
/context 화면   : 43.9k/1m tokens (4%)
```

**컨텍스트 창 크기(한계)는 transcript 에 없다.** `context_window|max_tokens|contextWindow` 로 전체를
훑어도 0건. → 창 크기는 **statusLine 의 `context_window.context_window_size`**(실측 `1000000`)에서
받아야 하고, statusLine 이 없을 때만 모델 → 창 매핑으로 폴백한다. 모델 이름이 `claude-opus-5[1m]`
처럼 `[1m]` 접미사로 창을 표시하므로 매핑 자체는 어렵지 않지만, 접미사 규칙은 언제든 바뀐다.

### Q2. statusLine 페이로드 ← **가장 깨끗한 개체별 채널**

`--settings` 에 이렇게 같이 넣으면 hooks 와 함께 동작한다(충돌 없음):

```json
{
  "hooks": { "...": "..." },
  "statusLine": { "type": "command", "command": "node D:/.../statusline-dump.js D:/.../out/statusline.jsonl", "padding": 0 }
}
```

턴이 끝난 뒤의 실제 페이로드(전문, 비밀값 없음):

```json
{
  "session_id": "50cc7bea-750f-4e3f-8492-4c4595194b6d",
  "transcript_path": "C:\\Users\\User\\.claude\\projects\\D--…-sandbox\\50cc7bea-….jsonl",
  "cwd": "D:\\myproject\\pixel-office\\dev\\spike-0\\sandbox",
  "scratchpad_dir": "…",
  "prompt_id": "22bec952-bdc2-42eb-9b86-840bc197271b",
  "effort": { "level": "high" },
  "session_name": "1+1 계산",
  "model": { "id": "claude-opus-5[1m]", "display_name": "Opus 5 (1M context)" },
  "workspace": { "current_dir": "…", "project_dir": "…", "added_dirs": [], "repo": { "host": "github.com", "owner": "…", "name": "…" } },
  "version": "2.1.275",
  "output_style": { "name": "default" },
  "cost": { "total_cost_usd": 0.16072150000000002, "total_duration_ms": 132988,
            "total_api_duration_ms": 2133, "total_lines_added": 0, "total_lines_removed": 0 },
  "context_window": {
    "total_input_tokens": 43910,
    "total_output_tokens": 3,
    "context_window_size": 1000000,
    "current_usage": { "input_tokens": 2, "output_tokens": 3,
                       "cache_creation_input_tokens": 14495, "cache_read_input_tokens": 29413 },
    "used_percentage": 4,
    "remaining_percentage": 96
  },
  "exceeds_200k_tokens": false,
  "prompt_cache": { "warm": true, "caching_observed": true, "ttl": "1h", "expires_at": 1789978524,
                    "requests": 1, "misses": 0, "hit_ratio": 0.6698474151673879,
                    "cache_write_tokens": 14495, "recache_tokens_if_cold": 43910 },
  "fast_mode": false,
  "thinking": { "enabled": true },
  "rate_limits": {
    "five_hour": { "used_percentage": 17, "resets_at": 1789992000 },
    "seven_day": { "used_percentage": 54, "resets_at": 1790132400 }
  }
}
```

**`rate_limits.seven_day` = 주간 사용량, `five_hour` = 5시간 세션 한도. `resets_at` 은 유닉스 초.**
`context_window` 는 개체별 컨텍스트를 퍼센트까지 계산해서 준다. `cost.total_cost_usd` 는 누적 비용.
즉 앱이 보여 주려는 값이 **거의 전부 이 한 장에 있다.**

**언제 터지는가(실측 타임라인, out/statusline.jsonl):**

| # | 시각 | 직전 간격 | `rate_limits` | 계기 |
| --- | --- | --- | --- | --- |
| 0 | 07:13:33 | — | **없음** | 세션 시작(아직 API 호출 0회). `context_window.current_usage` 도 `null`, `used_percentage` `null` |
| 1 | 07:15:25 | +111,196ms | 있음 | 턴 종료 직후(`Stop` hook 이 07:15:24.7) |
| 2~5 | 07:15:31~45 | +3.3~6.8초 | 있음 | `/context`·`/usage` 같은 화면 조작으로 다시 그릴 때 |

- **idle 일 때는 안 터진다.** 20초 동안 가만히 두고 센 결과 `1 → 1`. 즉 **폴링 채널이 아니라 이벤트 채널**이다.
- **첫 API 호출 전에는 `rate_limits` 키가 아예 없다.** `--resume` 으로 기록 있는 세션을 다시 열어 봐도
  마찬가지였다 — `context_window` 는 transcript 에서 복원돼 채워지지만 `rate_limits` 는 `undefined`:
  ```
  07:26:54 statusLine fires: 1
  07:26:54 0 rate_limits= undefined ctx= {"total_input_tokens":43910,…,"used_percentage":4,"remaining_percentage":96}
  ```
- 발화 빈도는 "상태줄을 다시 그릴 때마다" 라서 긴 턴 중에도 여러 번 온다. 데몬이 **마지막 값만 유지**하면 된다.

### Q3. `/usage`·`/status`·`/context`·`/cost` 화면

측정치(모두 `Stop` hook 이 안 뜸 = **모델 턴을 소비하지 않는다**):

| 명령 | 입력→화면 멎을 때까지 | 모델 턴 | 내용 |
| --- | --- | --- | --- |
| `/context` | 2,972ms | 없음 | 컨텍스트 보드 + `43.9k/1m tokens (4%)` + 카테고리별(시스템 프롬프트/도구/메모리/스킬/메시지/자동압축 버퍼) |
| `/cost` | 2,439ms | 없음 | **`/usage` 와 같은 화면**(Settings/Status/Config/**Usage**/Stats 탭 다이얼로그의 Usage 탭) |
| `/status` | 2,168ms | 없음 | 같은 다이얼로그의 Status 탭 — 버전·세션 id·`Login method: Claude Max account`·이메일·모델 |
| `/usage` | 2,184ms | 없음 | Usage 탭 |

`/usage` 원문(`dev/spike-1/out/claude-screen-05-usage.txt`, 발췌):

```
   Settings  Status   Config   Usage   Stats

   Session

   Total cost:            $0.1607
   Total duration (API):  2s
   Total duration (wall): 2m 5s
   Total code changes:    0 lines added, 0 lines removed
   Usage by model:
       claude-haiku-4-5:  910 input, 14 output, 0 cache read, 0 cache write ($0.0010)
          claude-opus-5:  2 input, 3 output, 29.4k cache read, 14.5k cache write ($0.1597)
   Prompt cache (main):   1 request · 67% of input tokens from cache · no misses · warm (1h TTL, …)

   Current session
   ████████▌                                          17% used
   Resets 9pm (Asia/Seoul)

   Current week (all models)
   ███████████████████████████▌                       55% used
   Resets Sep 23, 12pm (Asia/Seoul)

   Current week (Fable)
   ███████████████████████████▌                       55% used
   Resets Sep 23, 11:59am (Asia/Seoul)
```

- **한도 블록은 세 개다**: `Current session`(5시간), `Current week (all models)`, `Current week (<모델 표시명>)`.
- 세 번째 블록의 괄호 안은 **모델 표시명**이고 실측값은 `Fable` 이었다(Opus 가 아니다). 즉 **문자열을
  하드코딩하면 안 되고 괄호 안을 그대로 읽어야 한다**.
- 리셋은 **사람이 읽는 상대 표기 + 타임존**(`9pm (Asia/Seoul)`, `Sep 23, 12pm (Asia/Seoul)`)이다.
  **절대 타임스탬프가 아니다** — 연도도 없다. statusLine 의 `resets_at`(유닉스 초)과 대조된다.
- `Total cost` / `Usage by model` 도 같은 화면에 있어 세션 누적을 화면에서도 얻을 수 있다.

**턴 없이 열어도 한도가 나온다.** 세션을 새로 띄워 `/usage` 만 친 결과(`out/claude-full-usage-fresh.txt`):

```
   Total cost:            $0.0000
   Usage:                 0 input, 0 output, 0 cache read, 0 cache write

   Current session
   ██████████                                         20% used
   Resets 9pm (Asia/Seoul)

   Current week (all models)
   ███████████████████████████▌                       55% used
   Resets Sep 23, 12pm (Asia/Seoul)
```

→ **토큰 0, 비용 $0 인데 한도는 보인다.** 그러니까 "숨은 유틸리티 세션 하나를 띄워 두고 주기적으로
`/usage` 만 열어 읽는" 설계가 **할당량을 전혀 쓰지 않고** 가능하다. 단, 세션을 새로 띄우는 데
**60초 넘게 걸렸다**(ready 감지까지 60.6초, `/usage` 렌더까지 63.6초) — 유틸리티 세션은 **한 번 띄워
계속 유지**해야지 매번 새로 띄우면 안 된다.

**일하는 에이전트를 방해하지 않고 열 수 있는가** — 화면을 띄우고 `Esc` 로 닫는 동안 모델 턴은 없었지만,
**입력 큐에 슬래시 문자열을 밀어 넣는 것 자체가 사용자가 타이핑 중인 세션을 깨뜨릴 수 있다.**
멤버 세션에 대고 치지 말고 **엔진마다 숨은 유틸리티 세션 1개**를 쓰는 편이 안전하다.

파싱 제안(실제 캡처로 검증 완료, `dev/spike-1/parse-screens.js`):

```js
// 한도 블록 3종 — 라벨 / "NN% used" / "Resets …"
const CLAUDE_BLOCK =
  /^\s*(Current session|Current week \(([^)]+)\))\s*$\n^\s*\S*\s*(\d+)% used\s*$\n^\s*Resets ([^\n]+?)\s*$/gm;
// 세션 비용·모델별 토큰
const CLAUDE_COST = /^\s*Total cost:\s+\$([\d.]+)/m;
const CLAUDE_MODEL_ROW =
  /^\s*([a-z0-9.\-]+(?:\[[^\]]+\])?):\s+([\d.]+k?) input, ([\d.]+k?) output, ([\d.]+k?) cache read, ([\d.]+k?) cache write \(\$([\d.]+)\)/gim;
// /context — 앞에 보드 글리프(⛶ ⛁ …)가 같은 줄에 붙으므로 행머리 앵커를 쓰면 안 된다
const CLAUDE_CONTEXT = /([\d.]+k?)\/(\d+[km]?) tokens \((\d+)%\)/i;
```

검증 결과:

```json
{ "session5h":   { "usedPercent": 17, "resetsText": "9pm",             "tz": "Asia/Seoul" },
  "weeklyAll":   { "usedPercent": 55, "resetsText": "Sep 23, 12pm",    "tz": "Asia/Seoul" },
  "weeklyModel": { "model": "Fable", "usedPercent": 55, "resetsText": "Sep 23, 11:59am", "tz": "Asia/Seoul" },
  "context":     { "used": "43.9k", "window": "1m", "percent": 4 } }
```

### Q4. hook 페이로드에 사용량이 있는가 — **없다**

받은 키 전부:

```
SessionStart      session_id, transcript_path, cwd, scratchpad_dir, hook_event_name, source, model
UserPromptSubmit  session_id, transcript_path, cwd, scratchpad_dir, prompt_id, permission_mode, hook_event_name, prompt
Stop              session_id, transcript_path, cwd, scratchpad_dir, prompt_id, permission_mode, effort,
                  hook_event_name, stop_hook_active, last_assistant_message, background_tasks, session_crons
```

토큰·비용·컨텍스트 숫자는 **하나도 없다**. hook 의 역할은 **"지금 값을 다시 읽어라" 는 신호**(특히 `Stop`)와
`transcript_path` 포인터뿐이다.

### Q5. "연결 안 됨" 판정 — 로그아웃 없이

**`claude auth status` 가 JSON 을 그대로 준다**(기본이 `--json`). 로그인 상태:

```json
{ "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
  "analyticsDisabled": false,
  "projectsDirectory": "C:\\Users\\User\\.claude\\projects",
  "configDirectory": "C:\\Users\\User\\.claude",
  "email": "…", "orgId": "…", "orgName": "…", "subscriptionType": "max" }
```
종료 코드 0.

로그아웃 상태는 **실제로 로그아웃하지 않고** `CLAUDE_CONFIG_DIR` 을 빈 임시 폴더로 돌려서 재현했다:

```json
{ "loggedIn": false, "authMethod": "none", "apiProvider": "firstParty",
  "analyticsDisabled": false, "projectsDirectory": "…\\fakehome\\claude\\projects",
  "configDirectory": "…\\fakehome\\claude" }
```
종료 코드 **1**. `email`·`orgId`·`subscriptionType` 키 자체가 사라진다.

소요 시간: **280 / 261 / 264 ms**(3회). 값싸다.

- **exe 없음**은 `config.ts` 의 `resolveClaudeExeDetailed().found === false` 로 이미 구분된다 —
  `tried[]` 를 그대로 "어디를 봤는지" 로 보여 줄 수 있다.
- TUI 시작 화면에는 계정/플랜 줄이 따로 없다. 대신 `/status` 탭에 `Login method: Claude Max account`,
  `Organization`, `Email` 이 있다 — 하지만 `auth status` 가 훨씬 싸고 정확하므로 화면은 폴백으로만.

---

## Codex

### Q6. rollout JSONL 의 `token_count` — **확정**

**경로를 추측할 필요가 없다.** Codex hook 페이로드도 `transcript_path` 로 rollout 파일을 준다:

```json
{ "session_id": "01a0c2d3-7225-7eb3-a099-97e0d35c866b",
  "turn_id": "01a0c2d4-375f-7363-ab4a-b1a289d811b9",
  "transcript_path": "C:\\Users\\User\\.codex\\sessions\\2026\\09\\21\\rollout-2026-09-21T16-17-12-01a0c2d3-7225-7eb3-a099-97e0d35c866b.jsonl",
  "cwd": "…", "hook_event_name": "Stop", "model": "gpt-6-astra",
  "permission_mode": "default", "stop_hook_active": false, "last_assistant_message": "2" }
```

파일 이름은 `rollout-<로컬시각>-<sessionId>.jsonl` 이고 `YYYY/MM/DD` 로 나뉜다 — 세션 id 로 훑어도 찾을
수 있지만(`scan-rollouts.js` 가 그렇게 한다) **hook 이 주는 경로를 쓰는 게 맞다.**

0.154.0 의 `event_msg/token_count` 전문:

```json
{
  "timestamp": "2026-09-21T07:18:12.597Z",
  "ordinal": 22,
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "info": {
      "total_token_usage":  { "input_tokens": 43716, "cached_input_tokens": 21632, "cache_write_input_tokens": 0,
                              "output_tokens": 10, "reasoning_output_tokens": 0, "total_tokens": 43726 },
      "last_token_usage":   { "input_tokens": 21868, "cached_input_tokens": 21632, "cache_write_input_tokens": 0,
                              "output_tokens": 5,  "reasoning_output_tokens": 0, "total_tokens": 21873 },
      "model_context_window": 258400
    },
    "rate_limits": {
      "limit_id": "codex",
      "limit_name": null,
      "primary":   { "used_percent": 12, "window_minutes": 10080, "resets_at": 1790571738 },
      "secondary": null,
      "credits":   { "has_credits": false, "unlimited": false, "balance": "0" },
      "individual_limit": null,
      "spend_control_reached": null,
      "plan_type": "pro",
      "rate_limit_reached_type": null
    }
  }
}
```

- **`primary.window_minutes: 10080` = 7일 = 주간 한도.** `used_percent` 는 정수 퍼센트,
  `resets_at` 은 **유닉스 초**(1790571738 = 2026-09-28 14:02 KST — `/status` 화면과 일치).
- **`secondary` 는 이 Pro 계정에서 계속 `null`** 이었다(9개 세션 전수). 5시간 창에 해당하는 값은
  **플랜에 따라 있을 수도 없을 수도 있다** — 있으면 같은 모양일 것으로 보이지만 **미확인**이다.
  앱은 `secondary == null` 이면 5시간 줄을 아예 그리지 않아야 한다.
- `plan_type: "pro"` 로 플랜을 알 수 있다. `credits.balance` 는 문자열.
- `model_context_window: 258400` — **컨텍스트 창 한계가 여기 들어 있다.** Claude 와 달리 별도 매핑이 필요 없다.
- 컨텍스트 현재 크기는 `info.last_token_usage.input_tokens`(마지막 요청의 입력) 로 본다.
  `/status` 가 `21.8K used / 258K` 라고 표시한 값과 `last_token_usage.input_tokens = 21868` 이 일치한다.
- **누적은 `info.total_token_usage`** — CLI 가 직접 합산해 준다(직접 더할 필요 없음).

**언제 쓰이는가 — 턴마다 한 번.** 2턴짜리 세션에서 정확히 2개:

```
token_usage_record@2026-09-21T07:18:06.126Z | token_count@2026-09-21T07:18:06.128Z   ← 턴1
token_usage_record@2026-09-21T07:18:12.596Z | token_count@2026-09-21T07:18:12.597Z   ← 턴2
```

`Stop` hook 과 거의 동시(밀리초 차)다. → **`Stop` hook 을 받으면 rollout 꼬리를 읽으면 된다.**

`token_usage_record`(`type` 최상위, `event_msg` 아님)는 턴 단위 상세다 — `thread_id`/`turn_id`/`response_id`
와 `usage`·`turn_token_usage`·`thread_token_usage`. **`rate_limits` 는 여기 없다.**

**함정 두 가지(전수 스캔으로 확인):**

1. 턴이 한 번도 없는 세션의 rollout 은 `session_meta` 한 줄뿐 — `token_count` 가 **0개**다.
2. `token_count` 가 있어도 **`info: null`, `rate_limits.limit_id: "premium"`, `primary: null`** 인
   빈 이벤트가 있다(9/16·9/17 세션들에서 관찰). → **`limit_id === "codex"` 이고 `primary != null` 인
   마지막 이벤트**를 골라야 한다.

전수 스캔 결과(오늘치):

```
16-08-53 exec  tc 1  primary {"used_percent":11,"window_minutes":10080,"resets_at":1790571738}  secondary null
16-10-47 exec  tc 1  primary {"used_percent":11,…}                                              secondary null
16-15-32 cli   tc 2  primary {"used_percent":12,…}                                              secondary null
16-17-12 cli   tc 2  primary {"used_percent":12,…}                                              secondary null
16-17-46 cli   tc 0  primary none                                      ← 턴 0회 세션
16-22-36 cli   tc 6  primary {"used_percent":13,…}                                              secondary null
```

### Q7. Codex `/status` 화면

**주의: Codex TUI 는 인라인 렌더**(스크롤백을 쓴다)라 xterm 뷰포트 40줄만 읽으면 패널이 잘린다.
`term.buffer.active.length` 전체(스크롤백 포함)를 읽어야 한다 — `pty-codex-status.js` 가 그렇게 한다.

턴 1회 뒤의 원문(`out/codex-full-03-status-after-turn.txt`):

```
╭─────────────────────────────────────────────────────────────────────────────────╮
│  >_ OpenAI Codex (v0.154.0)                                                     │
│                                                                                 │
│ Visit https://chatgpt.com/codex/settings/usage for up-to-date                   │
│ information on rate limits and credits                                          │
│                                                                                 │
│  Model:                gpt-6-astra (reasoning high, summaries auto)             │
│  Model provider:       openai                                                   │
│  Directory:            D:\myproject\pixel-office\dev\spike-0\sandbox            │
│  Permissions:          Workspace (Ask for approval)                             │
│  Agents.md:            ~\.codex\AGENTS.md                                       │
│  Account:              <이메일> (Pro)                                           │
│  Collaboration mode:   Default                                                  │
│  Session:              01a0c2d5-e195-7c71-9a3e-73da28c6c7ab                     │
│                                                                                 │
│  Context window:       96% left (21.8K used / 258K)                             │
│  Weekly limit:         [██████████████████░░] 88% left (resets 14:02 on 28 Sep) │
╰─────────────────────────────────────────────────────────────────────────────────╯
```

- **`% left`(남은 비율)** 로 쓴다 — Claude 는 `% used`(쓴 비율)다. **부호가 반대다.**
- 리셋은 `14:02 on 28 Sep` — 역시 연도 없음, 로컬 시각.
- **세션을 열자마자(턴 0회) 쳐도 `Weekly limit` 줄은 나온다**(`out/codex-full-05-status-fresh.txt`).
  다만 그때는 **`Context window` 줄이 없다**. 즉 주간 한도는 무턴으로 얻을 수 있고, 컨텍스트는 턴이 있어야 한다.
- 렌더 시간: **2,478ms / 2,509ms / 4,310ms / 4,828ms**(4회). **모델 턴은 발생하지 않았다**(`Stop` hook 없음).
- 5시간 한도 줄은 **이 계정에서 나오지 않는다**(rollout `secondary: null` 과 일치).

파싱 제안(검증 완료):

```js
const CODEX_ACCOUNT = /^\s*│?\s*Account:\s+(\S+)\s+\(([^)]+)\)/m;
const CODEX_CTX     = /Context window:\s+(\d+)% left \(([\d.]+[KM]?) used \/ ([\d.]+[KM]?)\)/;
const CODEX_WEEK    = /Weekly limit:\s+\[[^\]]*\]\s+(\d+)% left \(resets ([^)]+)\)/;
// 플랜에 따라 나올 수 있는 5시간 줄(미확인 — 나오면 같은 모양으로 가정)
const CODEX_5H      = /5h limit:\s+\[[^\]]*\]\s+(\d+)% left \(resets ([^)]+)\)/;
```

결과: `{ account: { email, plan: "Pro" }, context: { leftPercent: 96, used: "21.8K", window: "258K" },
weekly: { leftPercent: 88, usedPercent: 12, resetsText: "14:02 on 28 Sep" } }`

**함정:** hook 신뢰가 안 된 상태에서 `/status` 를 치면 **한도 화면이 아니라 "Hooks 검토" 패널이 뜬다**
(`⚠ 8 hooks need review before they can run.` + 이벤트별 표 + `Press t to trust all`).
`--dangerously-bypass-hook-trust` 를 주면 안 뜬다. 데몬은 이미 이 플래그를 쓰므로 실사용에선 문제없지만,
**화면 파싱은 "우리가 기대한 패널이 맞는지" 를 먼저 확인해야 한다**(예: `Weekly limit:` 가 없으면 실패로 처리).

### Q8. Codex hook 페이로드 / `login status`

hook 페이로드 키: `session_id, turn_id, transcript_path, cwd, hook_event_name, model, permission_mode`
(+ `prompt` 또는 `stop_hook_active`·`last_assistant_message`). **사용량 숫자는 없다.** Claude 와 같다.

`codex login status`:

```
연결됨:     "Logged in using ChatGPT"     종료 코드 0   (55 / 54 / 56 ms)
연결 안 됨: "Not logged in"               종료 코드 1
```

연결 안 됨은 `CODEX_HOME` 을 빈 임시 폴더로 돌려서 **실제 로그아웃 없이** 재현했다. (임시 폴더를 쓰면
`WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries
under temporary dir …` 경고가 stderr 로 나오지만 판정에는 영향 없다. 실제 판정은 stdout 문자열/종료 코드로.)

---

## Q9. 단위 — 벤더마다 다르다

| | Claude | Codex |
| --- | --- | --- |
| 주간 값 | `seven_day.used_percentage` = **쓴 %**(정수) | `primary.used_percent` = **쓴 %**(정수) / 화면은 **남은 %** |
| 주간 리셋 | `resets_at` **유닉스 초** (화면은 `Sep 23, 12pm (Asia/Seoul)`) | `resets_at` **유닉스 초** (화면은 `14:02 on 28 Sep`) |
| 주간 창 길이 | 7일 고정(이름이 `seven_day`) | `window_minutes: 10080` 로 **명시** |
| 5시간(세션) 한도 | `five_hour.{used_percentage, resets_at}` — **있다** | `secondary` — 이 Pro 계정에선 **null**(플랜별) |
| 모델별 주간 한도 | `Current week (<모델명>)` 블록이 **화면에만** 있다(statusLine 에는 없음) | 없음 |
| 컨텍스트 창 | statusLine `context_window_size`(1,000,000) | rollout `model_context_window`(258,400) |
| 플랜 | `auth status.subscriptionType` = `"max"` | `rate_limits.plan_type` = `"pro"` / 화면 `(Pro)` |
| 비용(USD) | `cost.total_cost_usd`, `cost-state.totalCostUSD` | **없다**(토큰만) |

→ 앱이 "주간 사용량 N% · 리셋 D일 H시간 후" 로 통일하려면 **내부 표준을 `usedPercent`(쓴 비율) +
`resetsAt`(유닉스 초, UTC)** 로 잡고, Codex 화면에서 읽을 때만 `100 - leftPercent` 로 뒤집으면 된다.
"D일 H시간 후" 는 `resetsAt - now` 로 앱이 계산한다 — **화면의 사람 표기를 파싱해 날짜로 되돌리지 마라**
(연도가 없어 연말에 깨진다).

## Q10. 데이터 → 출처 요약

| 데이터 | 1순위 출처 | 폴백 | 신뢰도 | 갱신 방식 |
| --- | --- | --- | --- | --- |
| **Claude 주간 사용량** (`usedPercent`, `resetsAt`) | statusLine `rate_limits.seven_day` | 유틸리티 세션 `/usage` 화면 `Current week (all models)` | **상** (구조화 JSON, 유닉스 초) | 이벤트: `Stop` 직후 statusLine 발화 → 마지막 값 유지. **API 호출 전엔 없음** → 그때만 `/usage` |
| **Claude 5시간 한도** | statusLine `rate_limits.five_hour` | `/usage` `Current session` | **상** | 위와 같음 |
| Claude 모델별 주간 한도 | `/usage` 화면 `Current week (<모델명>)` | 없음 | **하**(화면 문자열, 라벨이 `Fable` 처럼 바뀜) | 유틸리티 세션 폴링 5~10분 |
| **Claude 멤버 컨텍스트** (`used/window/percent`) | statusLine `context_window` | transcript 마지막 assistant `input+cache_creation+cache_read`(창 크기는 모델 매핑) | **상** | 이벤트: 턴 종료. `--resume` 직후에도 채워져 있음 |
| **Claude 멤버 누적 토큰·비용** | transcript 마지막 `cost-state` 줄(모델별 분리) | statusLine `cost.total_cost_usd` (총액만) | **상** | 이벤트: `Stop` hook → transcript 꼬리 재읽기 |
| **Claude 연결 여부·플랜** | `claude auth status`(JSON, ~270ms) | `config.ts` exe 탐색 실패 / `/status` 화면 | **상** | 폴링 60초 + 세션 스폰 실패 시 즉시 |
| **Codex 주간 사용량** | rollout `token_count.rate_limits.primary`(`limit_id==="codex"`, `primary!=null` 인 마지막 것) | 유틸리티 세션 `/status` 화면 `Weekly limit` | **상** | 이벤트: `Stop` hook → `transcript_path` 꼬리 읽기(턴마다 1개) |
| Codex 5시간 한도 | rollout `rate_limits.secondary` | `/status` 의 `5h limit` 줄(**미확인**) | **하**(이 계정에선 항상 null) | 있을 때만 표시 |
| **Codex 멤버 컨텍스트** | rollout `info.last_token_usage.input_tokens` / `info.model_context_window` | `/status` `Context window:` | **상** | 이벤트: `Stop` |
| **Codex 멤버 누적 토큰** | rollout `info.total_token_usage` | `token_usage_record.thread_token_usage` | **상** | 이벤트: `Stop` |
| **Codex 연결 여부·플랜** | `codex login status`(~55ms) + `rate_limits.plan_type` | `/status` 의 `Account: … (Pro)` | **상** | 폴링 60초 |
| Codex 비용(USD) | **없음** | — | — | 토큰만 보여 준다 |

**CLI 업데이트에 무엇이 깨지는가**

- **깨지기 쉬운 것(상 → 하 순으로 위험):** 화면 파싱 전부. Claude `/usage` 는 이미 모델 라벨이 `Fable`
  이고 탭 구성(`Settings Status Config Usage Stats`)도 버전마다 바뀐다. Codex `/status` 는 Hooks 검토
  패널에 가로채인 전례가 있다. → 화면 파싱은 **폴백으로만** 쓰고, 실패하면 조용히 "값 없음" 으로 떨어뜨리고
  1순위가 올 때까지 이전 값을 회색으로 보여 준다(파싱 실패를 오류 팝업으로 만들지 말 것).
- **비교적 안전한 것:** statusLine 스키마(계약으로 문서화된 통합 지점), Codex rollout 이벤트 스키마.
  그래도 **키가 없을 때 크래시하지 않게** 전부 옵셔널로 읽어야 한다.
- **버전 고정 금지:** T41 에서 이미 데인 것처럼 `claude-code\2.1.270` 같은 경로를 박으면 안 된다.
  실제로 오늘 2.1.270 은 없었고 2.1.275 였다.

**갱신 전략 권고**

1. 개체별(컨텍스트·누적 토큰·비용)은 **전부 이벤트 구동**. `Stop` hook 을 받으면 그 멤버의 statusLine
   마지막 값 / rollout 꼬리를 읽어 `member.usage` 알림을 민다. 폴링 필요 없음.
2. 엔진별 주간 사용량은 **statusLine / rollout 이 주는 값을 캐시**하고, **엔진마다 숨은 유틸리티 세션 1개**를
   유지해 **5~10분 간격**으로 `/usage`(Claude) · `/status`(Codex) 를 열어 보정한다. 무턴이라 할당량을 안 쓴다.
   멤버가 한 명이라도 돌고 있으면 이벤트 쪽이 더 신선하므로 **둘 중 최신 것**을 쓴다.
3. 연결 여부는 **60초 폴링** + 세션 스폰 실패 시 즉시 재확인. `auth status`/`login status` 둘 다 0.3초 이하.

---

## 제안 — PROTOCOL 에 추가할 모양

```jsonc
// 알림: engine.usage — 엔진(=구독) 단위. 값이 바뀔 때만 민다.
{
  "engine": "claude",            // 'claude' | 'codex'
  "connected": true,             // exe 없음/로그아웃이면 false
  "notConnectedReason": null,    // 'exe_missing' | 'logged_out' | null  (false 일 때만)
  "account": { "plan": "max" },  // claude: subscriptionType, codex: plan_type. 이메일은 넣지 않는다.
  "weekly":    { "usedPercent": 54, "resetsAt": 1790132400, "windowMinutes": 10080 },
  "session5h": { "usedPercent": 17, "resetsAt": 1789992000, "windowMinutes": 300 },   // 없으면 null
  "perModel":  [ { "label": "Fable", "usedPercent": 55, "resetsAt": null } ],          // claude 화면 전용, 비어도 됨
  "source": "statusLine",        // 'statusLine' | 'rollout' | 'screen' — 화면 출처면 신뢰도 낮음을 UI 가 안다
  "measuredAt": 1789975000       // 이 값을 실제로 읽은 시각(유닉스 초). 앱이 "N분 전 기준" 을 쓸 수 있다
}

// 알림: member.usage — 개체(팀원 세션) 단위. Stop 직후.
{
  "memberId": "m-…",
  "engine": "claude",
  "sessionId": "50cc7bea-750f-4e3f-8492-4c4595194b6d",
  "model": { "id": "claude-opus-5[1m]", "displayName": "Opus 5 (1M context)" },
  "context": { "used": 43910, "window": 1000000, "percent": 4 },
  "tokens":  { "input": 2, "output": 3, "cacheRead": 29413, "cacheWrite": 14495, "total": 43913 },  // 세션 누적
  "costUsd": 0.1607,             // codex 는 null
  "byModel": [                   // claude cost-state.modelUsage. codex 는 빈 배열
    { "model": "claude-haiku-4-5-20251001", "input": 910, "output": 14, "cacheRead": 0, "cacheWrite": 0, "costUsd": 0.00098 }
  ],
  "measuredAt": 1789975000
}
```

- `snapshot` 에도 `engines: EngineUsage[]` 과 `members[].usage` 를 같이 실어 **재접속 직후 화면이 맞게** 한다
  (T28 의 `derived` 와 같은 원칙 — 클라이언트가 다시 계산하지 않는다).
- RPC `usage.refresh{ engine? }` 를 두면 앱의 "새로고침" 버튼이 유틸리티 세션에 화면 열기를 시킬 수 있다
  (응답은 `{}`, 결과는 알림으로).
- **퍼센트는 "쓴 비율" 로 통일**한다. Codex 화면의 `% left` 는 데몬이 뒤집어서 넣는다.
- `resetsAt` 은 **유닉스 초(UTC)** 로 통일. 사람 표기 계산은 앱이 한다.
- `source` 와 `measuredAt` 을 반드시 같이 보낸다 — 값이 오래됐을 때 UI 가 "10분 전 기준" 이라고 말할 수 있다.

## 열린 위험

1. **Codex 5시간 한도를 확인하지 못했다.** Pro 계정에서 `secondary` 는 전수 `null` 이었다. 다른 플랜
   (Plus/Business)에서 어떤 모양인지 모른다. → 앱은 **`session5h == null` 을 정상으로** 다뤄야 하고,
   Codex 카드에는 5시간 줄이 아예 없을 수 있다.
2. **Claude 는 첫 API 호출 전까지 `rate_limits` 를 주지 않는다.** `--resume` 도 마찬가지. 즉 아침에
   앱을 켜고 아무도 일을 안 시키면 statusLine 만으로는 주간 사용량을 못 보여 준다. 유틸리티 세션 +
   `/usage` 가 **선택이 아니라 필수**다.
3. **유틸리티 세션 기동이 느리다** — Claude 세션 하나 띄워 `/usage` 를 읽기까지 **약 64초**. 앱 시작
   직후 "불러오는 중" 상태가 1분 가까이 갈 수 있다. 유틸리티 세션은 데몬 기동과 함께 미리 띄워 두고
   **계속 살려 둬야** 한다(세션 하나가 상주하는 비용은 토큰 0).
4. **화면 파싱의 수명.** `Current week (Fable)` 처럼 라벨이 모델 이름을 그대로 쓴다. 탭 구성·문구는
   버전마다 바뀐다. 파싱 실패를 "연결 안 됨" 으로 오인하면 안 된다 — **"값 없음" 과 "연결 안 됨" 은 다른 상태**다.
5. **멤버 세션에 슬래시 명령을 밀어 넣는 것은 위험하다.** 모델 턴은 안 먹지만 사용자가 그 세션의
   터미널을 보고 있거나 입력 중이면 화면이 튄다. 유틸리티 세션으로 분리할 것.
6. **statusLine 은 전역 설정과 병합된다.** 사용자가 이미 `~/.claude/settings.json` 에 `statusLine` 을
   걸어 뒀다면 세션 `--settings` 가 덮어쓴다(우리 것이 이긴다). 사용자의 상태줄이 우리 세션에서만
   사라지는 셈 — 우리 세션은 사용자가 직접 쓰는 세션이 아니므로 실害는 없지만, 상태줄 출력 문자열은
   **사람이 봐도 이상하지 않게**(예: 모델·컨텍스트 요약) 만들어 두는 게 좋다. 이번 스파이크는
   `PIXEL-STATUSLINE` 이라고만 찍었다.
7. **동시 실행 중이던 다른 에이전트와 sandbox 공유.** 이 스파이크가 `dev/spike-0/sandbox/.codex/hooks.json`
   을 잠깐 덮어썼다가 원래 파일로 되돌렸다. 둘 다 `description: "pixel-office"` 마커라 데몬이 다시
   써도 문제없지만, **같은 cwd 를 여러 주체가 쓰면 hooks.json 이 경합한다**는 사실은 기록해 둔다.

## 남은 것

- Codex 다른 플랜에서 `secondary`(5시간) 실물 확인.
- Claude 주간 한도에 **실제로 근접했을 때** 화면/페이로드가 어떻게 바뀌는지(경고 문구, `rate_limit_reached_type`
  대응물) — 지금은 55% 라 관찰 불가.
- 컴팩션(`PreCompact`) 이후 컨텍스트 값이 어떻게 튀는지.
- 서브에이전트(`isSidechain: true`)를 개체별 집계에 넣을지 — transcript 에 섞여 들어오고 `cost-state`
  에는 haiku 로 잡힌다. 앱에서 "그 팀원이 쓴 양" 에 포함하는 게 맞아 보이지만 결정 필요.
