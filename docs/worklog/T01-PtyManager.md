# T01 — PtyManager

- 날짜: 2026-09-14
- 마일스톤: M0
- 관련 설계: 01 §구성 요소 1 (PtyManager), §실측 결과 반영 / 02 §①②④ / 04 D-03, D-07
- 커밋: (미커밋 — 상위 태스크에서 묶어 커밋)

## 목표

멤버 하나당 실제 CLI(`claude` | `codex`) 하나를 node-pty(ConPTY)에 띄우고, 바이트 입출력·특수 키·bracketed paste·리사이즈·종료를 한 객체로 다룰 수 있다. 스폰 시 세션 단위 hooks 설정(Claude `--settings`, Codex `<cwd>/.codex/hooks.json`)과 정리된 환경변수(`CLAUDE_CODE*` 제거, `PIXEL_MEMBER` 주입)가 스파이크에서 검증된 모양 그대로 나간다. 화면 재구성(T02)·hook 수신(T03)·입력 큐(T05)는 이 클래스의 `data`/`exit` 이벤트와 `PtySession` 위에 얹힌다.

## 한 것

- `dev/daemon/src/pty/types.ts` — 공개 타입. `Engine = 'claude' | 'codex'`, `KeyName = 'enter'|'down'|'up'|'ctrl-c'|'esc'`, `SpawnOptions { memberId, memberToken, engine, cwd, resumeSessionId?, cols?, rows?, hookScriptPath, hookPort, extraArgs? }`, `ExitInfo { exitCode, signal? }`, `PtySession { memberId, engine, pid, alive, write, paste, sendKeys, resize, kill }`.
- `dev/daemon/src/pty/env.ts` — `sanitizeEnv(base, memberToken)`: `DROP_ENV_RE = /^(CLAUDE_?CODE|CLAUDECODE|CLAUDE_CONFIG_DIR)/i` 에 걸리는 키를 버리고 `PIXEL_MEMBER`, `TERM=xterm-256color`(`CHILD_TERM`) 세팅. 입력 객체는 건드리지 않음.
- `dev/daemon/src/pty/args.ts` — `buildClaudeArgs(settingsPath, resume?, extra?)` → `['--settings', p, '--permission-mode', 'default', ...('--resume', id), ...extra]`. `buildCodexArgs(resume?, extra?)` → `[...('resume', id), '--dangerously-bypass-hook-trust', '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"', ...extra]`.
- `dev/daemon/src/pty/hookSettings.ts` — hooks 설정 생성기(순수 함수) + 파일 쓰기.
  - `buildHookCommand(script, port, event)` → `node <슬래시경로> <port> <Event>` (경로에 공백이 있을 때만 큰따옴표). `toForwardSlashes()`.
  - `CLAUDE_HOOK_EVENTS`(11개: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Notification, Stop, SubagentStop, PreCompact, SessionEnd), `CODEX_HOOK_EVENTS`(8개: SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop, Interrupt, SessionEnd), `HOOK_TIMEOUT_SEC = 600`.
  - `buildClaudeSessionSettings()` → `{ hooks: { <Event>: [ { hooks: [ { type:'command', command, timeout:600 } ] } ] } }`. `writeClaudeSessionSettings(dataDir, memberId, …)` → `<dataDir>/sessions/<memberId>/claude-settings.json` (폴더 생성, 항상 덮어씀).
  - `buildCodexHooksFile()` → 같은 구조 + `description: "pixel-office"` 마커. `ensureCodexHooksFile(cwd, …)` → `<cwd>/.codex/hooks.json`. 파일이 있는데 마커가 없으면 **덮어쓰지 않고** `{ written:false, reason }` 반환. `isPixelOfficeHooksFile()` 은 `description` 이 `pixel-office` 로 시작하면 우리 것으로 본다(스파이크가 남긴 `"pixel-office spike"` 도 덮어써도 되는 파일).
- `dev/daemon/src/pty/PtyManager.ts` — `class PtyManager extends EventEmitter<{ data:[memberId, chunk]; exit:[memberId, ExitInfo]; warn:[memberId, message] }>`
  - 생성자 `new PtyManager(partialConfig?)` — `claudeExe/codexExe/dataDir/cols/rows` 를 `config.ts` 기본값 위에 덮어쓸 수 있다(테스트에서 dataDir 격리용).
  - `spawn(opts): PtySession` — 동기. 엔진별 hook 설정 파일 준비 → `sanitizeEnv` → `pty.spawn(exe, args, { name:'xterm-256color', cols, rows, cwd, env })`. 같은 memberId 로 살아 있는 세션이 있으면 throw. Codex hooks.json 을 건드리지 못하면 `warn` 이벤트(리스너 없으면 `console.warn`).
  - `get(memberId)`, `list()`, `kill(memberId, { graceful?, timeoutMs? }): Promise<void>` — graceful 이면 Claude `/exit`+Enter, Codex Ctrl+C×2(300ms 간격)를 보내고 `timeoutMs`(기본 5000) 안에 exit 이 안 오면 강제 종료. exit 이벤트 후 resolve(강제 종료 후 3초 상한).
  - `PtySession`: `write(text)`(죽은 세션이면 throw), `paste(text)` = `ESC[200~ + text + ESC[201~` (CR 없음 — 호출자가 `sendKeys('enter')`), `sendKeys()` = `KEY_BYTES` 표(`enter:'\r', down:'\x1b[B', up:'\x1b[A', 'ctrl-c':'\x03', esc:'\x1b'`), `resize(cols, rows)`, `kill()`, `pid`, `alive`.
  - `PtyManager.ts` 가 `types/args/env/hookSettings` 를 전부 re-export 하므로 다른 모듈은 `../pty/PtyManager.js` 하나만 import 하면 된다.
  - **exit 시 ConPTY 자원 직접 해제** (`releaseConptyResources`, 아래 함정 1).
- `dev/daemon/test/pty/env.test.ts` — `sanitizeEnv`/`DROP_ENV_RE`/`buildClaudeArgs`/`buildCodexArgs` 단위 테스트 9건(스폰 없음).
- `dev/daemon/test/pty/hookSettings.test.ts` — 명령 문자열·이벤트 목록·파일 구조·마커 판정·경로·임시 폴더 파일 쓰기(남의 hooks.json 보존 포함) 14건(스폰 없음).
- `dev/daemon/test/pty/integration.test.ts` — `PIXEL_IT=1` 일 때만 실행. 실제 `claude.exe` 를 `dev/spike-0/sandbox` 에 스폰 → headless xterm 으로 화면 재구성 → `? for shortcuts` / `shift+tab to cycle` 대기(최대 60s, `trust this folder` 보이면 ↓+Enter) → 세션 설정 파일 존재 확인 → resize → `kill(graceful)` → exit 이벤트·`alive=false`·`list()` 비었는지 확인. hook 수신기는 안 띄우므로 hook 은 실패(무해)하고, 스크립트 경로는 존재하지 않는 더미.

## 검증

```
$ node --version
v24.14.1

$ npm run typecheck
> pixel-office-daemon@1.0.0 typecheck
> tsc --noEmit
(오류 없음, EXIT=0)
```
첫 실행 때는 `src/screen/tuiMap.ts(103,66): error TS2367`(T02 범위) 하나가 있었고 `src/pty/`·`test/pty/` 는 0건. T02 쪽이 고친 뒤 재실행해 전체 0건 확인.

```
$ npx tsx --test test/pty/*.test.ts        (PIXEL_IT 없음 → 통합 테스트 skip)
▶ sanitizeEnv
  ✔ drops CLAUDE_CODE*/CLAUDECODE*/CLAUDE_CONFIG_DIR case-insensitively, keeps the rest
  ✔ sets PIXEL_MEMBER and forces TERM=xterm-256color
  ✔ skips undefined values and returns only strings
  ✔ does not mutate the input
  ✔ DROP_ENV_RE matches the documented prefixes
▶ buildClaudeArgs
  ✔ fresh session
  ✔ resume + extra args appended
▶ buildCodexArgs
  ✔ fresh session
  ✔ resume subcommand goes first, extra args last
▶ buildHookCommand
  ✔ uses forward slashes and `node <script> <port> <event>` shape
  ✔ quotes the script path only when it contains whitespace
  ✔ toForwardSlashes leaves forward-slash paths alone
▶ buildClaudeSessionSettings
  ✔ has exactly the 11 verified Claude events
  ✔ each event has one matcher group with one command hook, timeout 600, event name as last arg
  ✔ has no marker key at top level (only hooks) and round-trips through JSON
▶ buildCodexHooksFile
  ✔ carries the pixel-office marker and the 8 verified Codex events
  ✔ uses the same hook shape as Claude
▶ isPixelOfficeHooksFile
  ✔ true for our file and for the spike marker prefix
  ✔ false for foreign files, missing description, and invalid JSON
▶ paths
  ✔ claudeSettingsPath is <dataDir>/sessions/<memberId>/claude-settings.json
  ✔ codexHooksPath is <cwd>/.codex/hooks.json
▶ file writers (temp dir, no spawn)
  ✔ writeClaudeSessionSettings creates dirs and writes valid settings
  ✔ ensureCodexHooksFile writes when absent, overwrites its own file, refuses a foreign file
﹣ spawns real claude, reaches the input prompt, then exits cleanly # set PIXEL_IT=1 to run
ℹ tests 24  ℹ pass 23  ℹ fail 0  ℹ skipped 1  ℹ duration_ms 253.8824
```

통합 테스트(실제 claude.exe, bash 에서):
```
$ time (PIXEL_IT=1 npx tsx --test test/pty/*.test.ts)
[IT] spawned pid=28556 engine=claude cwd=D:\myproject\pixel-office\dev\spike-0\sandbox
[IT] ready=true after 2153ms raw=1293 bytes trustDialogs=0
--- screen tail ---

                                                                                                      ● high · /effort
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ Try "fix typecheck errors"
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← for agents
--- end ---
[IT] kill done alive=false exits=[{"id":"it-claude","exitCode":0}]
✔ spawns real claude, reaches the input prompt, then exits cleanly
ℹ tests 24  ℹ pass 24  ℹ fail 0  ℹ skipped 0  ℹ duration_ms 5785.2598

real    0m7.226s
```
관찰: sandbox 는 이미 신뢰된 폴더라 다이얼로그 없이 2.1초 만에 입력 프롬프트 도달. `--permission-mode default` 가 먹어 상태줄에 `manual mode on`. `/exit` 로 exitCode 0. hook 은 수신기가 없어 조용히 실패(존재하지 않는 더미 스크립트 경로라 화면에 "hook error" 도 남지 않았음). 실행 후 남은 claude.exe 없음(`tasklist` 로 확인).

## 발견한 함정

1. **자연 종료된 세션이 이벤트 루프를 붙든다 (node-pty 1.1.0, win32 ConPTY, useConptyDll=false).** 첫 통합 실행에서 테스트는 4.7초에 통과했는데 러너 프로세스가 영원히 안 끝났다(300초 타임아웃으로 백그라운드행, `taskkill /T` 로 정리). 원인: `windowsPtyAgent.js` 의 `_$onProcessExit` → `_cleanUpProcess` 는 conout 소켓만 destroy 하고 `exit` 를 올린다. pseudoconsole 핸들(`_ptyNative.kill(pty)`)·conout **worker 스레드**(`_conoutSocketWorker.dispose()`)·conin 소켓은 `agent.kill()` 에서만 해제된다. `/exit` 로 끝난 세션(graceful 경로는 `proc.kill()` 을 안 부름)은 worker 스레드가 남아 Node 가 종료되지 않는다 — 데몬에서는 세션이 끝날 때마다 스레드가 하나씩 새는 셈.
   - 1차 우회 `onExit` 안에서 `proc.kill()`: 동작하지만 node-pty 가 `conpty_console_list_agent` 를 fork 해 이미 죽은 콘솔에 `AttachConsole` 을 시도 → 그 자식이 stderr 에 스택 트레이스(`Error: AttachConsole failed`)를 찍고, 부모는 5초 타임아웃까지 기다린다(테스트 9.8초).
   - 최종: `releaseConptyResources(proc)` — agent 내부 필드(`_inSocket.destroy()`, `_ptyNative.kill(_pty, _useConptyDll)`, `_conoutSocketWorker.dispose()`)를 직접 정리. 필드 모양이 다르면(node-pty 버전 변경) `proc.kill()` 로 폴백. 노이즈·지연 없이 5.8초. **node-pty 를 올리면 이 함수부터 다시 볼 것.**
2. `@xterm/headless` 는 번들된 CJS 라 Node ESM 에서 named import(`import { Terminal }`)가 안 된다 → `import xterm from '@xterm/headless'; const { Terminal } = xterm;` (T02 `ScreenModel.ts` 와 같은 방식).
3. `PtyManager.kill(graceful)` 의 exit 대기는 `exit` 이벤트에 건 1회성 리스너라, 세션이 없거나 이미 죽었으면 리스너를 걸기 전에 return 한다(리스너 누수 없음).

## 결정

- 새 결정 없음. D-03(hook 명령 = `node hook.js`, 멤버 식별 = `PIXEL_MEMBER`), D-07(재시작 = `--resume`/`codex resume`)을 그대로 코드에 옮김.
- 스펙 대비 작은 편차: (a) `warn` 이벤트 추가(Codex hooks.json 을 남의 파일이라 못 쓸 때). (b) Codex 마커 판정은 `description === "pixel-office"` 완전 일치가 아니라 `startsWith("pixel-office")` — 스파이크가 남긴 `"pixel-office spike"` 파일을 덮어쓸 수 있게. (c) `kill()` 은 `Promise<void>` 를 돌려주며 `graceful` 외에 `timeoutMs` 옵션이 있다. (d) 생성자에 config 일부를 덮어쓰는 인자가 있다(테스트 격리용).

## 남은 것

- Codex 실제 스폰 통합 테스트는 안 돌렸다(스파이크 `pty-codex.js` 로 인자·hooks.json 형식은 검증됨). T20(CodexHooks) 에서 같은 통합 테스트를 `engine:'codex'` 로 추가.
- `--resume` 경로는 인자 생성만 단위 테스트. 실기동 확인은 T09(재시작 복구).
- hook `timeout` 상한(600 → 86400) 재확인은 T10.
- 온보딩·신뢰 다이얼로그 통과는 통합 테스트에 최소(trust → ↓+Enter)만 넣었다. 실제 판정·키 매핑은 T02 ScreenModel + `tui-maps/claude-2.1.json` 이 담당.
