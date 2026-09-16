# T21 — Codex tui-maps 보강 (실측 캡처)

- 날짜: 2026-09-16
- 마일스톤: M3
- 관련 설계: 01-설계문서.md §구성 요소 1 "ScreenModel", 02-실측-체크리스트.md ④, 04-결정기록.md D-13(`verified` 플래그)·D-16(TUI 허가 프롬프트 폴백)
- 커밋: (미커밋 — 상위 태스크에서)

## 목표

T02 에서 `verified:false` 로 남긴 Codex `busy`/`interrupted` 를 **실제 화면**으로 확정하고, Claude·Codex 양쪽의 CLI 자체 허가 프롬프트(hook 이 없거나 만료된 뒤의 "재지시 필요" 폴백 화면)를 맵에 넣어 ScreenModel 이 "허가 프롬프트가 떠 있다"를 알 수 있게 한다. 픽스처는 스파이크 로그 복사가 아니라 ScreenModel 이 보는 뷰포트(`buffer.active.baseY` 기준) 그대로 뜬다.

## 한 것

- `dev/daemon/test/screen/tools/capture.ts`(신규) — node-pty 로 CLI 를 띄우고 `ScreenModel` 에 그대로 feed 하는 캡처 하네스. 화면이 바뀔 때마다 프레임 + `ready/busy/intr/dialog` 판정을 로그에 남기고, `save()` 로 `lines()` 를 픽스처로 저장. 끝나면 자식을 반드시 kill.
- `test/screen/tools/capture-codex.ts`, `capture-claude.ts`(신규) — 시나리오(READY → 작업 중 → Ctrl+C → 승인 프롬프트 거부 → 종료). 사용법은 `src/tui-maps/README.md`.
- `test/screen/fixtures/codex/`(신규 8개): `boot-loading` `ready` `working` `interrupted` `usage-limit` `model-switch-offer` `model-switch-offer-after-esc` `exit`.
- `test/screen/fixtures/claude/`(신규 7개): `ready` `working` `approval-prompt` `approval-prompt-no-highlighted` `approval-after-deny` `exit-hint`.
- `src/screen/tuiMap.ts` — `DIALOG_KINDS` 에 `approval-prompt`·`model-switch-offer` 추가. `promptReady.noneOf`(보이면 비준비) 추가. `dialogs[]` 에 `allowKeys`/`denyKeys`(approval-prompt 전용, `keys`/`highlight` 와 배타 — 로더가 검증) 와 `source` 필드. 각 섹션에 `verified`/`source`.
- `src/screen/ScreenModel.ts` — `detectDialog()` 는 `approval-prompt` 에 대해 항상 `suggestedKeys: []`(InputQueue 가 키를 얹지 않음). 새 `approvalPrompt(): { visible, id?, allowKeys, denyKeys }`. `promptReady()` 가 `noneOf` 를 본다.
- `src/tui-maps/codex-0.154.json` — 실측으로 전면 갱신(아래 표). `src/tui-maps/claude-2.1.json` — `permission-prompt`(approval-prompt) 추가, `Press Ctrl-C again to exit` skipLine, 각 항목 `source`.
- `src/tui-maps/README.md`(신규, 한국어) — 파일 이름 규칙, 엔진→맵 선택·버전 추가, `verified`/`source`, 픽스처 재생성.
- `test/screen/screens.test.ts` +21건, `ScreenModel.test.ts` +4건(스키마 검증). 기존 "codex: boot screen (model loading) is already prompt-ready" 는 실측과 반대라 **뒤집었다**(아래 함정).

### 패턴별 검증 상태

| 엔진 | 패턴 | 이전 | 지금 | 출처 |
|---|---|---|---|---|
| codex | promptReady (`Ask Codex to do anything`, `› ` + 상태줄) | 검증 | 검증 | fixtures/codex/ready.txt |
| codex | promptReady.noneOf `model: loading` | (없음) | **검증(신규)** | fixtures/codex/boot-loading.txt + 1차 실측(Enter 무시) |
| codex | busy `esc to interrupt`, `[•◦] Working (` | 미검증 | **검증** | fixtures/codex/working.txt |
| codex | interrupted `■ Conversation interrupted` | 미검증 | **검증** | fixtures/codex/interrupted.txt |
| codex | dialog trust-folder-codex | 검증 | 검증 | fixtures/codex-trust-dialog.txt(run-codex2) |
| codex | dialog model-switch-offer → esc | (없음) | **검증(신규)** | fixtures/codex/model-switch-offer.txt → -after-esc.txt |
| codex | dialog approval-prompt(`approval-exec`) | (없음) | **미검증** | codex.exe 0.154.0 바이너리 문자열(아래) |
| claude | dialog approval-prompt(`permission-prompt`) | (없음) | **검증(신규)** | fixtures/claude/approval-prompt.txt 외 2 |
| claude | promptReady / busy / interrupted / 온보딩·신뢰 다이얼로그 | 검증 | 검증(+T21 픽스처 추가) | fixtures/claude/*.txt |
| claude | dialog login-success | 미검증 | 미검증 | 항상 로그인 상태라 못 봄 |

### Codex 승인 프롬프트 문구 (바이너리 문자열, 실물 미확인)

`codex.exe`(0.154.0) 에서 뽑은 TUI 승인 오버레이 문자열:

- 제목: `Would you like to run the following command?` / `Would you like to make the following edits?` / `Would you like to grant these permissions?` / `Do you want to approve network access to "…"?` / `<tool> needs your approval.`
- 항목: `Yes, just this once` / `Yes, and don't ask again for this command in this session` / `Yes, and don't ask again for commands that start with `…`` / `No, continue without running it` / `No, and tell Codex what to do differently`
- 맵: `allowKeys: ["enter"]`(첫 항목 강조 가정), `denyKeys: ["esc"]`(esc = 중단). `verified:false`. 사용량 한도가 풀리는 2026-09-21 이후 `capture-codex.ts` 를 다시 돌려 확정할 것(시나리오 4단계가 그대로 들어 있다).

## 검증

```
$ cd dev/daemon && npx tsc --noEmit
(이 태스크 파일 오류 0. 병행 작업 중인 src/adapters/codexMapping.ts, test/office/CodexRouting.test.ts 의 오류는 타 태스크 범위)

$ npx tsx --test "test/screen/*.test.ts"
ℹ tests 52  ℹ pass 52  ℹ fail 0

$ npm test
ℹ tests 291  ℹ pass 287  ℹ fail 0  ℹ skipped 4

$ tasklist | findstr codex.exe
(없음)  # 캡처가 띄운 codex.exe / claude.exe(pid 1464, 10944, 25808, 29152, 30316) 전부 종료 확인
```

### 캡처한 화면 (헤더·빈 줄 생략)

Codex 부팅 직후(`boot-loading.txt`, 0.3s) — 프롬프트·상태줄은 보이지만 **Enter 가 먹지 않는다**:

```
│ model:     loading   /model to change                  │
│ directory: ~\AppData\Local\Temp\…\scratchpad\codex-cwd │
› Ask Codex to do anything
  gpt-6-astra default · ~\AppData\Local\Temp\claude\…\scratchpad\codex-…
```

Codex READY(`ready.txt`, 약 4초 뒤):

```
│ model:     gpt-6-astra high   /model to change         │
⚠ 2 startup issues (1 MCP) · ctrl + t for details
⚠ `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.
› Ask Codex to do anything
  gpt-6-astra high · ~\AppData\Local\Temp\claude\…\scratchpad\codex-cwd
```

Codex 작업 중(`working.txt`) — 입력 상자와 상태줄이 그대로 남은 채 위에 Working 줄:

```
› 셸 명령 sleep 8 을 실행해줘

• Working (0s • esc to interrupt)        ← 다음 프레임은 ◦ Working (1s • esc to interrupt)

› Ask Codex to do anything
  gpt-6-astra high · ~\AppData\Local\Temp\claude\…\scratchpad\codex-cwd
```

Codex 중단(`interrupted.txt`, Working 표시 중 Ctrl+C):

```
› 셸 명령 sleep 60 을 실행해줘
■ Conversation interrupted - tell the model what to do differently. Something went wrong? Hit `/feedback` to report the
issue.
› Ask Codex to do anything
  gpt-6-astra high · ~\AppData\Local\Temp\claude\…\scratchpad\codex-cwd
```

Codex 사용량 한도 + 모델 전환 제안(`usage-limit.txt`, `model-switch-offer.txt`):

```
■ You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at
Sep 21st, 2026 1:58 PM.
  Approaching rate limits
  Switch to gpt-5.6-luna for lower credit usage?
› 1. Switch to gpt-5.6-luna                 Fast and affordable agentic coding model.
  2. Keep current model
  3. Keep current model (never show again)  Hide future rate limit reminders about switching models.
  Press enter to confirm or esc to go back
```

Codex 종료(`exit.txt`, 빈 프롬프트에서 Ctrl+C **한 번** → exit 0):

```
To continue this session, run:
  codex resume 01a0a888-dc56-7230-8060-45bf63bd5de1
```

Claude 허가 프롬프트(`approval-prompt.txt`, `--permission-mode default`, hooks 없음):

```
❯ 셸 명령 "echo x > t21-approval.txt" 를 실행해줘. 다른 건 하지 마.
  Writing x to a new file
  ⎿  $ echo x > t21-approval.txt
────────────────────────────────────────────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below

   echo x > t21-approval.txt
   Write x to a new file

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to D:\myproject\pixel-office\dev\spike-0\sandbox from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend
```

↓×3 → `❯ 4. No`(`approval-prompt-no-highlighted.txt`) → Enter → (`approval-after-deny.txt`):

```
  Ran 1 shell command
  ⎿  Interrupted · What should Claude do instead?
✻ Cogitated for 3s · done 오후 1:43
…
❯
  ⏸ manual mode on · ? for shortcuts · ← for agents
```

Claude 종료 힌트(`exit-hint.txt`, 빈 프롬프트에서 Ctrl+C 한 번): 상태줄이 `Press Ctrl-C again to exit` 로 바뀐다.

## 발견한 함정

- **Codex 부팅 화면은 준비가 아니다.** `model:     loading` 인 동안 입력 상자·상태줄이 다 보이고 T02 의 `promptReady()` 는 true 였지만, 1차 실측에서 그때 보낸 프롬프트 + Enter 는 제출되지 않고 입력 상자에 남아 다음 프롬프트와 이어 붙었다(`› 셸 명령 sleep 8 을 실행해줘셸 명령 sleep 60 을 실행해줘`). → `promptReady.noneOf: ["^\\s*│ model:\\s+loading\\b"]`. 모델명이 뜨기까지 약 4초. 기존 테스트 기대값을 뒤집었다.
- **ChatGPT 계정 사용량 한도.** 실측일에 Codex 가 `You've hit your usage limit … try again at Sep 21st, 2026` 로 모든 턴을 즉시 끝냈다(`gpt-5.6-luna` 로 바꿔도 동일, `-c preferred_auth_method="apikey"` 로 env 의 키를 쓰게 해도 auth.json 의 ChatGPT 로그인이 우선이라 동일 — 로그인 상태를 바꾸는 건 사용자 몫이라 더 가지 않음). 그래서 **승인 프롬프트는 못 띄웠고**, `busy`/`interrupted` 는 요청이 서버에 가 있는 ~1초의 `Working` 창 안에서(15ms 폴링으로 busy 감지 즉시 Ctrl+C) 잡았다. 실제 도구 실행 중 화면(명령 출력이 흐르는 상태)은 아직 못 봤지만 Working 줄·상태줄은 같을 것.
- **Codex 는 빈 프롬프트에서 Ctrl+C 한 번에 종료**된다(exit 0, 2회 확인). 체크리스트 ④의 "Ctrl+C×2" 는 `/quit` 뒤 관찰. 데몬의 퇴근 시퀀스는 두 번 보내도 무해(두 번째는 이미 죽은 pty 에 씀).
- **Claude 는 Ctrl+C 두 번을 1.2초 간격으로 보내면 안 죽었다.** 두 번째에도 `Press Ctrl-C again to exit` 가 다시 떴고 15초를 기다려도 살아 있어 kill 했다. "again" 창이 1초 안팎인 듯 — 데몬은 두 번째를 더 빨리 보내거나 kill 폴백을 유지할 것(src/pty 범위, 여기서 안 건드림).
- **Codex 작업 중에도 입력 상자·상태줄이 그대로 보인다.** T02 의 "작업 중 화면엔 입력줄이 없다" 는 스파이크 로그(버퍼 0행) 착시였다. `promptReady()` 가 busy 를 먼저 보는 순서 덕에 판정은 맞는다.
- **Claude `4. No` 거부는 Ctrl+C 와 같은 화면**(`⎿  Interrupted · What should Claude do instead?`) 을 남긴다 → `interrupted()` true + `promptReady()` true. 앱은 이걸 "중단" 이 아니라 "거부됨" 으로 읽어야 할 수 있다(어댑터에서 pending 상태와 함께 판단).
- 이 셸 환경에서 bash 히어독(`<<'EOF'`)이 깨진다 — 긴 텍스트는 파일로 쓴 뒤 `cat >>`.

## 결정

- `approval-prompt` 는 다이얼로그 kind 로 감지하되 **자동 통과 키를 절대 주지 않는다**(`suggestedKeys: []`). 허가/거부 키는 `approvalPrompt()` 로만 노출 — 앱의 "재지시 필요" 카드가 "허가/거부" 버튼을 붙이고 싶을 때 쓴다. → 04-결정기록 후보(상위에서 번호).
- `promptReady.noneOf` 도입: 준비 문구가 있어도 특정 문구가 보이면 비준비.
- Codex `model-switch-offer` 는 `esc` 로 자동 통과(현재 모델 유지, 설정 변경 없음). "never show again" 은 사용자 설정을 바꾸므로 고르지 않는다.
- InputQueue(src/input, 이 태스크 범위 밖)는 `approval-prompt` 에 대해 빈 키 시퀀스를 보내고 `dialogPassed('approval-prompt')` 를 emit 한다. 키는 안 나가므로 안전하지만 이벤트 이름이 어색하다 → InputQueue 에서 `suggestedKeys.length === 0` 이면 `dialogPassed` 대신 `blocked('approval')` 로 다루는 게 좋다(후속).

## 남은 것

- **Codex 승인 프롬프트 실물 캡처** — 2026-09-21 한도 리셋 후 `npx tsx test/screen/tools/capture-codex.ts <신뢰된 cwd>` 재실행(시나리오 4단계 `echo x > ../x.txt`). 문구·항목 순서·esc 효과 확정 후 `approval-exec` 를 `verified:true` 로.
- Codex 실제 도구 실행 중 화면(명령 출력 스트리밍) 픽스처 — 같은 재실행에서 `working-*.txt` 로 나온다.
- Claude `login-success` 다이얼로그 — 여전히 미검증.
- 02-실측-체크리스트 ④ 갱신(Ctrl+C 한 번 종료, 부팅 loading 중 입력 무시) — 이 태스크 허용 경로 밖이라 상위에서.
- InputQueue 의 `approval-prompt` 처리(위 결정) — src/input 담당 태스크에서.
