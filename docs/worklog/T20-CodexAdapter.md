# T20 — CodexHooks 어댑터·스폰

- 날짜: 2026-09-16
- 마일스톤: M3
- 관련 설계: 01 §구성 요소 1(hooks 어댑터, 대기 정책, interrupt/fire/error 후처리), §2 오피스 이벤트 스키마(Codex 열) / 02 §④ / 04 D-04, D-05, D-11, D-22
- 커밋: (미커밋 — 상위 태스크에서 묶어 커밋)

## 목표

Codex CLI(0.154.0) 팀원이 Claude 팀원과 **같은 오피스 이벤트·pending·RPC** 로 보이게 한다. hook 처리 뼈대는 T04 것을 그대로 쓰되(추출), Codex 만의 차이(도구 이름표가 없어 명령 문자열로 읽기/편집/실행을 가름, `Interrupt` hook, TUI 질문 없음, 종료가 Ctrl+C)를 어댑터 한 겹으로 흡수한다. Office 는 `member.engine` 으로 어댑터를 고르고, 스폰·퇴근·유령 정리도 엔진을 따른다.

## 한 것

### 어댑터 (공통 뼈대 추출 + Codex)

- `dev/daemon/src/adapters/BaseHooksAdapter.ts` (신규) — T04 `ClaudeHooksAdapter` 의 본체를 그대로 옮긴 추상 클래스. hook 수신·보류(hold)·pending·status·후처리·이벤트 emit 이 전부 여기에 있다. 엔진 훅 포인트 네 개만 뺐다:
  - `label` (로그 접두사), `mapTool(toolName, toolInput)` (PreToolUse 매핑), `isQuestionTool(toolName)` (PermissionRequest 를 질문으로 볼지), `approvalDetail(toolName, toolInput)` (waiting_approval detail), `onEngineEvent(req, member)` (그 엔진에만 있는 hook — 기본 pass-through).
- `dev/daemon/src/adapters/ClaudeHooksAdapter.ts` — 위 네 개만 구현하는 30줄짜리로 축소. **공개 API·이벤트·동작 전부 T04 그대로**(T04 테스트 41개 무수정 통과).
- `dev/daemon/src/adapters/CodexHooksAdapter.ts` (신규) — 같은 공개 API. Codex 차이:
  - `mapTool` = `mapCodexTool` (아래), `isQuestionTool` = 항상 false(Codex 에는 `AskUserQuestion` 이 없다 — 질문은 TeamTools `ask_user` 뿐, T22),
  - `approvalDetail` 도 같은 매핑을 써서 허가 카드에 `cmd` + Codex 가 주는 한국어 승인 문구(`tool_input.description` → `summary`)를 싣는다,
  - `onEngineEvent`: `Interrupt`(Codex 전용, timeout 3초 클램프) → 즉시 `{}` 응답 → 보류 hook·pending 정리(`expireAllForMember`) → `idle{summary:'interrupted'}` + status `idle`. 화면 판정(Office.watchInterrupted)과 같은 모양이라 클라이언트는 구분할 필요가 없다.
- `dev/daemon/src/adapters/codexMapping.ts` (신규, 순수 함수) — 설계 §2 표의 Codex 열.
  - `classifyCommand(cmd)`: `apply_patch`(조각의 첫 토큰이거나 `*** Begin Patch` 본문) → `editing`, 읽기 전용 휴리스틱 통과 → `reading`, 나머지 → `running`.
  - `isReadOnlyCommand(cmd)`: `&&`/`||`/`;`/`|`/개행으로 자른 **모든 조각**이 읽기여야 한다. 쓰기 리다이렉트(`>`, `>>`)가 있으면 즉시 false(`2>&1`·`2>/dev/null` 은 무해로 제외). 읽기 목록은 `cat rg ls dir type head tail grep findstr wc pwd tree stat Get-Content select-string jq diff fd …`, 인자까지 보는 것은 `sed`(`-n` 있고 `-i` 없을 때만), `git`(diff\|log\|status\|show\|blame\|ls-files\|rev-parse\|…), `find`(`-delete`/`-exec` 없을 때). `cd`·`pushd` 는 중립. 셸 래퍼(`bash -lc "…"`)는 안을 파싱하지 않고 `running` — **모르면 running**(표시용 이벤트라 과장된 reading 보다 안전).
  - `mapCodexTool(toolName, toolInput)`: 셸 도구(`Bash`/`shell`/…)면 위 판정 + `detail{tool, cmd, summary?}`, 편집 도구 이름(`apply_patch`/`fileChange`/…)이면 `detail{tool, path}`(입력의 `file_path` 또는 패치 본문의 `*** Update File:`), 그 외 이름(`mcp__*`, `Read` …)은 Claude 매핑 재사용.
- `dev/daemon/src/adapters/types.ts` — 이벤트 맵 이름을 `HooksAdapterEvents` 로(두 엔진 공통), `ClaudeHooksAdapterEvents` 는 별칭으로 남김.

### Office (엔진 라우팅)

- `dev/daemon/src/office/Office.ts`
  - `adapter`(Claude, 기존 이름 유지) + `codexAdapter` 를 둘 다 만들고 `adapters: Record<Engine, BaseHooksAdapter>` 로 묶었다. `adapterFor(engine)` / `adapterOf(memberId)` / `adapterForToken(token)`.
  - `receiver 'hook'` → `adapterFor(member.engine).handleHook`. `hold-timeout`/`hold-closed` → 토큰의 멤버 엔진. `expireAllForMember`(퇴근·재시작·interrupt·resume 폴백·pty 종료), `onSessionExit`, `resolveApproval`(허가 응답·자동 allow), `resolveQuestion` 전부 pending/멤버의 엔진으로 라우팅. 두 어댑터의 `event/status/pendingCreated/handler-error` 를 같은 방식으로 배선.
  - **Codex 부팅 감시 `watchBootReady()` 추가** — 아래 "발견한 함정" 1번. `starting` 인 Codex 멤버의 화면이 prompt ready(다이얼로그 없음)가 되면 `idle` 로 올린다(0.5초 주기, 최대 180초, `SessionStart` 가 먼저 오면 중단). 타이머 정리는 `clearWatches(rt)` 로 interrupt 감시와 함께.
  - ScreenModel 은 이미 `new ScreenModel({ engine: member.engine })` 이라 Codex 신뢰 다이얼로그(`trust-folder-codex` → Enter)는 T02/T05 경로 그대로 동작(실기동에서 `model-switch-offer` 다이얼로그 자동 통과도 확인).
- `dev/daemon/src/office/orphans.ts` — 변경 없음. `name.includes(engine)` 이 `codex.exe`/`codex` 를 이미 통과한다(테스트로 고정).

### pty (Codex 스폰·종료)

- `dev/daemon/src/pty/PtyManager.ts`
  - `prepareSpawnCommand(cfg, opts)` 를 모듈 함수로 분리(스폰 없이 검증하려고). Codex: `<cwd>/.codex/hooks.json`(마커 `pixel-office`, 남의 파일이면 안 건드리고 `warn`) + `[resume <id>] --dangerously-bypass-hook-trust -c approval_policy="on-request" -c sandbox_mode="workspace-write"`.
  - 정중한 종료를 `gracefulQuit(session, waitExit, {timeoutMs})` 로 분리. Claude `/exit`+Enter. **Codex 는 Ctrl+C 한 번 → 2초 대기 → 아직 살아 있을 때만 한 번 더 → 남은 시간 대기**(T21 실측: idle 프롬프트에서는 한 번이면 exit 0 + `codex resume <id>` 안내. 무조건 두 번 보내면 이미 죽은 뒤의 Ctrl+C 가 새어 나간다). 안 죽으면 호출자가 강제 종료.
  - `args.ts` / `hookSettings.ts` 는 이미 실측대로여서 그대로 뒀다(스파이크 `pty-codex.js` 와 대조 확인).

### 테스트

- `test/adapters/CodexHooksAdapter.test.ts` (23) — 실측 페이로드(`hooklog-codex.json`, `run-codex6.log`)로 SessionStart(startup/resume/지시문 주입)·UserPromptSubmit·PreToolUse(읽기/쓰기/apply_patch/mcp 도구)·PermissionRequest(보류·allow/deny/updatedInput JSON·`mcp__team__*` 즉시 allow·AskUserQuestion 이름이 와도 approval)·PostToolUse·Stop·SessionEnd(other/clear/resume)·Interrupt(보류 만료 + idle)·pty 종료·전체 흐름.
- `test/adapters/codexMapping.test.ts` (39) — 읽기/비읽기 명령 각 14종, apply_patch 오탐(`rg -n 'apply_patch'`), 패치 경로 추출, detail 모양.
- `test/office/CodexRouting.test.ts` (11) — 같은 사무실의 Claude/Codex 멤버에 **같은 hook** 을 보내 `running` vs `reading` 으로 갈리는지, Interrupt 가 Codex 에만 이벤트를 남기는지, 허가 보류가 Codex 어댑터에만 잡히고 `approval.respond` 가 같은 JSON 을 돌려주는지, 퇴근 키(Ctrl+C 1회 / 안 죽으면 2회 / Claude `/exit`), 스폰 옵션(engine·mcpConfigPath 없음·rehire resume), 부팅 idle, 지시문 주입, `reapOrphan` 의 codex 이미지 이름.
- `test/pty/spawnCommand.test.ts` (5) / `test/pty/quit.test.ts` (7).
- `test/office/fakes.ts` — 가짜 pty 의 graceful kill 이 진짜 `gracefulQuit` 를 쓰도록(첫 입력에 죽는 세션이 기본, `stubborn` 이면 두 번째 Ctrl+C 까지).
- `test/office/codex.integration.test.ts` (opt-in `PIXEL_IT=1`) — 실제 데몬 + 실제 Codex: 출근 → idle → 지시("`echo t20 > ../t20.txt`") → `waiting_approval` → allow → idle → 파일 확인·삭제 → 퇴근 → 프로세스 종료. **사용량 한도로 이번에는 끝까지 못 돌렸다(아래 검증).**
- `dev/daemon/PROTOCOL.md` — "엔진별 동작 차이 (T20)" 표 추가(hook 주입·스폰 인자·매핑·질문 없음·첫 idle·Interrupt·퇴근·다이얼로그·MCP).

## 검증

```
$ npx tsc --noEmit
tsc OK

$ npx tsx --test "test/**/*.test.ts"
ℹ tests 297
ℹ suites 46
ℹ pass 292
ℹ fail 0
ℹ skipped 5        (= opt-in 통합 테스트 5개)
ℹ duration_ms 12628.5185
```

실기동(실제 데몬 + 실제 codex.exe, `dev/spike-0/sandbox`) — 통합 테스트와 같은 경로를 진단 스크립트로 돌린 것:

```
clockIn m_6861080d739b 23676
[IT:c] status starting (starting)
[IT:c] status idle (free)
IDLE reached
--- SCREEN after idle ---
│ >_ OpenAI Codex (v0.154.0)                               │
│ model:     gpt-6-astra high   /model to change           │
│ directory: D:\myproject\pixel-office\dev\spike-0\sandbox │
⚠ `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.
⚠ clamping SessionEnd hook timeout to 3s in D:\myproject\pixel-office\dev\spike-0\sandbox\.codex\hooks.json
⚠ clamping Interrupt hook timeout to 3s in D:\myproject\pixel-office\dev\spike-0\sandbox\.codex\hooks.json
› Ask Codex to do anything
  gpt-6-astra high · D:\myproject\pixel-office\dev\spike-0\sandbox
--- END ---
instructed
[IT:c] status working (working)
[IT:c] event #1 thinking {"text":"[TASK#1 from user]\n셸 명령 \"echo t20 > ../t20.txt\"를 실행해서 상위 폴더에 파일을 만들어줘. 다른 건 하지 마."}
[office] 코덱스: passed first-run dialog (model-switch-offer)
--- SCREEN 25s after instruct ---
› [TASK#1 from user]
  셸 명령 "echo t20 > ../t20.txt"를 실행해서 상위 폴더에 파일을 만들어줘. 다른 건 하지 마.
■ You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at
Sep 21st, 2026 1:58 PM.
--- END ---
[IT:c] event #2 idle {"summary":"session ended: other"}   ← clockOut(Ctrl+C)
[IT:c] status exited (exited)
codex alive after clockOut? false
[d:out] [daemon] bye
```

여기까지 확인된 것: `.codex/hooks.json` 이 우리 마커로 쓰이고(이벤트 8종, `Interrupt` 포함) Codex 가 로드함 · 신뢰/모델 전환 다이얼로그 자동 통과 · 화면 기반 `starting → idle` · 지시 주입(`UserPromptSubmit` hook → `thinking` 이벤트) · `SessionEnd` hook → `idle{session ended: other}` · **퇴근 Ctrl+C 로 codex 프로세스 종료(alive=false)**.

확인 못 한 것: 모델 턴이 필요한 구간(`PreToolUse` → `PermissionRequest` → allow → 파일 생성 → `Stop`). ChatGPT 계정이 **2026-09-21 13:58 까지 사용량 한도**라 턴이 시작되지 않는다. `PIXEL_IT=1 npx tsx --test test/office/codex.integration.test.ts` 는 지금은 `timeout waiting for ...` 로 실패한다(테스트는 그대로 두고 헤더에 사유·재시도 날짜를 적어 뒀다). 해당 구간의 hook 왕복은 스파이크 실측 로그(`run-codex6.log`)와 그 페이로드로 만든 단위 테스트로 대체했다.

## 발견한 함정

1. **Codex 의 `SessionStart` 는 기동 때 안 온다 — 첫 프롬프트 제출 때 온다.** 스파이크 로그를 다시 보면 `spawn 09:47:00.193` → 프롬프트 입력 `09:47:08.613` → `SessionStart 09:47:09.438` → `UserPromptSubmit 09:47:09.718`(`run-codex6.log`). 그래서 hook 만 기다리면 멤버가 `starting` 에 머물고, InputQueue 의 `isIdle` 게이트가 안 열려 **첫 지시가 영원히 안 나간다**(첫 실기동에서 180초 타임아웃으로 발견). → Office 가 Codex 멤버에 한해 화면 prompt ready 로 `idle` 판정(`watchBootReady`). 이번 실기동에서는 사용량 한도 때문에 `UserPromptSubmit` 은 왔는데 `SessionStart` 는 끝내 안 왔다 — 즉 지시문 주입(`additionalContext`)이 첫 턴 전에는 안 걸릴 수 있다는 뜻이므로, `SessionStart` 가 늦게 오는 것을 전제로 둔 이 구조가 맞다.
2. **`apply_patch` 오탐.** 명령 어디든 `apply_patch` 가 있으면 editing 으로 보던 첫 구현이 `rg -n 'apply_patch' src` 를 editing 으로 잡았다(테스트에서 발견). → 조각의 **첫 토큰**이거나 `*** Begin Patch` 본문이 있을 때만.
3. **Codex 퇴근은 Ctrl+C ×2 가 아니다.** 02 §④ 의 "Ctrl+C ×2" 는 턴이 도는 중이었던 것. idle 프롬프트에서는 한 번이면 exit 0(T21 두 번 재현). 무조건 두 번 보내면 죽은 뒤의 두 번째 키가 다음 세션/사용자 터미널로 샌다. → 한 번 보내고 2초 기다렸다가 필요할 때만 한 번 더.
4. **`node-pty` 는 `codex`(PATH 의 `.ps1`/`.cmd` 셰임)를 못 띄운다.** 실기동·통합 테스트는 실제 `codex.exe`(npm 전역 vendor 경로)를 `PIXEL_CODEX_EXE` 로 넘겨야 한다. `config.codexExe` 기본값 `'codex'` 는 Windows 에서 그대로는 안 먹는다(M3 배포 때 탐지 로직 필요 — 남은 것).
5. **Codex 가 hook timeout 을 클램프한다.** `SessionEnd`/`Interrupt` 는 3초로 줄이며 경고를 띄운다(`clamping … to 3s`). 그래서 이 두 이벤트에서는 절대 hold 하면 안 된다 — 어댑터도 즉시 응답한다. 나머지 이벤트는 우리 기본값(86400)을 그대로 받는다(경고 없음).
6. **`PermissionRequest` 에는 `tool_use_id` 가 없다**(PreToolUse 에는 있다). 허가-도구 짝짓기를 id 로 하면 안 된다 — 지금은 안 쓴다.
7. Codex TUI 상단의 `⚠ 2 startup issues (1 MCP)` 는 사용자 전역 설정의 다른 MCP 서버가 뜨지 못한 것(우리와 무관). `ctrl+t` 로 확인함.

## 결정

- D-04(허가·질문은 hook 결정 반환), D-05(additionalContext), D-11(타임아웃=pass-through), D-22(`mcp__team__*` 즉시 allow)는 엔진 공통으로 그대로 적용.
- 새 결정 없음. 다만 "모르는 명령은 `running`"(과소 표시 우선)과 "Codex 는 화면으로 첫 idle 을 판정한다"는 04-결정기록에 올릴 후보.

## 남은 것

> **2026-09-21 해소 — `T42-CodexLive.md`.** 통합 테스트 재실행(A, 수정 후 통과)·`Interrupt` 실물 페이로드(G)·
> `config.codexExe` 자동 탐지 실기 확인까지 끝났다. 읽기 휴리스틱은 실사용 로그(apply_patch·Get-Content·Set-Content)로
> 한 번 대조했고 오분류는 없었다.

- **실기동 통합 테스트 재실행 — 2026-09-21 13:58 이후**(`PIXEL_IT=1 npx tsx --test test/office/codex.integration.test.ts`). 허가 왕복·파일 생성·`Stop` 이벤트까지 확인하고 이 문서 검증 절을 갱신할 것.
- Codex `Interrupt` hook 의 **실물 페이로드** 미확인(스파이크에서도 발화 안 함). 어댑터는 payload 를 읽지 않으므로 동작에는 영향 없음.
- Codex TeamTools MCP 주입(`-c mcp_servers.team.url=…`) — M3 별도 태스크. 그전까지 Codex 멤버는 `ask_user`/`report` 를 못 쓴다.
- `config.codexExe` 자동 탐지(위 함정 4).
- 읽기 휴리스틱은 표시용이라 완벽할 필요는 없지만, 실사용 로그가 쌓이면 오분류를 보고 목록을 조정할 것.
