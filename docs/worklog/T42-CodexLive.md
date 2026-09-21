# T42 — Codex 실기 점검 (9/21 이후 확인 목록 A~J + 부장 codex)

- 날짜: 2026-09-21
- 마일스톤: M3/M4 이월분 정리 (실기)
- 관련 설계: 01 §2 이벤트 매핑(Codex 열) · §구성 요소 1(어댑터·InputQueue·TeamTools MCP) / 02 §④ / 04 D-04, D-19, D-22, D-23, D-24, D-25, D-32, D-34
- 커밋: `T42-1` ~ `T42-6`

## 목표

ChatGPT 계정 사용량 한도(D-23, 리셋 2026-09-21 13:58)가 풀렸다. **모델 턴이 필요해 T20·T21·T22·T23·T39 가 이월했던 것**이
`T23-MixedTeam.md` §"9/21 이후 확인 목록 A~J" 하나로 모여 있었다. 그것을 **진짜 데몬 + 릴리스 앱**으로 한 번에 돌리고,
막히는 것은 고치고, 증거를 남긴다. 여기에 T39 가 더해 둔 **부장을 codex 로 임명**(create_team/delegate/report/ask_user)도 붙인다.

실기 환경: 데몬 `npm start`(포트 7420-7422, 실제 dataDir) · 앱 `flutter build windows --release` 로 새로 빌드한 exe ·
cwd `dev/spike-0/sandbox` · codex-cli 0.154.0 / gpt-6-astra high(주간 한도 87% 남음) · claude 2.1.275.

## 결과 — A~J + 부장 codex

| # | 항목 | 결과 | 증거 | 결함 → 고침 |
|---|---|---|---|---|
| **A** | 통합 테스트 그린 (`PIXEL_IT=1 … codex.integration.test.ts`) | **수정 후 통과** | 아래 §A 실행 로그(23.8초, 1 pass) | 테스트가 rev 3 이전 경로였다 → `T42-1` |
| **B** | Codex 도구 구간 이벤트 실물 대조 | **통과** | A 의 `running/waiting_approval/text/idle` + 실기 `#1000 editing apply_patch` · `#1001 reading Get-Content` · `#1020 running Set-Content` | 없음 (설계 §2 표대로) |
| **C** | `ask_user` 실제 호출 | **통과** | `#1012 running mcp__team__ask_user` → `#1013 asking` → `answer` → `#1015 thinking [ANSWER q#…]` → `#1016 text 파랑` | 없음 |
| **D** | MCP 도구의 `tool_name` 실물 | **통과(+수정)** | hook 원문: `mcp__team__create_team` 등. `PermissionRequest` 8건은 **전부 `Bash`** — MCP 도구에는 안 뜬다 | 넓은 휴리스틱 제거 → `T42-3` |
| **E** | 질문 폴백 실전 | **통과** | `#1026 text …어느 쪽으로 할까요?` → `#1027 idle` → `#1028 asking(폴백)` → 답 `JSON`(봉투 없음) → `#1029 thinking JSON` → `#1030 text` | 없음 (`QUESTION_PATTERNS` 조정 불필요) |
| **F** | 보고 폴백 실전 | **통과** | A 의 `reporting #6 task#1`, 실기 `#1024 reporting … task#48` | 없음 |
| **G** | `Interrupt` hook 실물 페이로드 | **통과** | 아래 §G. 키 7개 확정, 픽스처·테스트로 고정 | 없음 (어댑터는 payload 를 안 읽는다) |
| **H** | 승인 프롬프트 화면 픽스처 `approval-exec` | **통과(+수정)** | `fixtures/codex/approval-prompt.txt` 실물 캡처 → `verified:true` | 항목 문구·푸터가 추정과 달랐다 → `T42-5` |
| **I** | 턴 종료 hook 없는 화면의 idle 판정 | **보류(조건 미발생)** | 아래 §I — 한도 화면 말고는 재현이 안 된다. 폴백(D-25)은 이미 구현·단위 검증됨 | 없음 |
| **J** | 혼합 팀 실기 마무리 | **통과** | 부장(codex) → 팀장 2명(codex/claude) → 팀원(claude/codex) 4단 왕복, `img/T42-7-mixed-team.png` | 없음 |
| **+** | **부장 = codex** (`create_team`/`delegate`/`report`/`ask_user`/`ask_parent`) | **통과** | 아래 §부장 codex, `img/T42-1·2·3·4.png` | v1 제한은 경고 한 줄뿐이었다(하드 게이트 없음) |
| **+** | `codex resume <id>` 재시작 복구 | **수정 후 통과** | 아래 §resume | **`[RESUMED]` 가 입력 상자에 갇혀 큐가 영구히 막혔다** → `T42-4` |
| **+** | 신뢰 다이얼로그 자동 통과 | **미발생** | 이 기계의 `~/.codex/config.toml` 이 `C:\Users\User` 와 `d:\myproject` 를 통째로 신뢰한다 → 그 아래 새 폴더에서도 안 뜬다(§신뢰) | — |

## 증거

### A. 통합 테스트

`dev/daemon/test/office/codex.integration.test.ts` 는 한도와 **무관하게** 세 군데가 낡아서 죽고 있었다(T42-1).

1. `team.create`/`member.clockIn` 은 T34(D-34)부터 디버그 전용 → `-32004 … (force:true 필요)`,
   `team.create` 는 `departmentId` 필수.
2. 스냅샷 전용 RPC 가 없다(`hello` 응답으로만 온다) → `-32601 method not found: snapshot`.
3. 부팅 직후 `session_id` 를 단언하고 있었다 — Codex 의 `SessionStart` 는 **첫 프롬프트 때** 온다(D-24). 부팅 시점 null 이 정상.

지금은 사용자의 정식 경로 `department.create{headEngine:'codex'}` 로 Codex 멤버(부장) 하나를 세운다.

```
$ cd dev/daemon && PIXEL_IT=1 npx tsx --test test/office/codex.integration.test.ts
[IT] department=d_257c8f917cbc head=m_5567aef651b2 rank=head engine=codex pid=15924 (803ms)
[IT] hooks.json: pixel-office events=SessionStart,UserPromptSubmit,PreToolUse,PermissionRequest,PostToolUse,Stop,Interrupt,SessionEnd
[IT] boot idle, session_id=null (5397ms)  ← Codex 는 여기서 null 이 정상(D-24)
[IT] instruct task#1 (5401ms)
[IT:c] event #1 thinking {"text":"[TASK#1 from user]\n셸 명령 \"echo t20 > ../t20.txt\"를 …"}
[IT:c] event #2 running {"tool":"Bash","cmd":"echo t20 > ../t20.txt"}
[IT:c] event #3 waiting_approval {"tool":"Bash","cmd":"echo t20 > ../t20.txt",
        "summary":"상위 폴더는 쓰기 허용 범위 밖입니다. 요청하신 명령으로 t20.txt 파일을 만들도록 허용할까요?"}
[IT] allow → a_c69faf4f7e30 (13436ms)
[IT:c] event #4 text {"text":"명령을 실행해 상위 폴더에 `t20.txt`를 만들었습니다."}
[IT:c] event #5 idle {}
[IT:c] event #6 reporting {"summary":"명령을 실행해 상위 폴더에 `t20.txt`를 만들었습니다."}
[IT] session_id after first turn = 01a0c2d1-eccd-7600-934f-a73f84bb03a3
[IT:c] event #7 idle {"summary":"interrupted"}        ← 퇴근 Ctrl+C 가 Interrupt hook 도 낸다
[IT:c] event #8 idle {"summary":"session ended: other"}
[IT] clockOut done (22705ms); codex pid 15924 alive=false
ℹ tests 1  ℹ pass 1  ℹ fail 0  ℹ duration_ms 24106
```

다른 `*.integration.test.ts`(askuser·teamtools·restart)도 **같은 이유로 낡아 있다**(`team.create`/`clockIn` force,
`snapshot` RPC). 이번 태스크 범위 밖이라 손대지 않았다 — "남은 것" 참고.

### D. MCP 도구의 실물 `tool_name` — 넓은 휴리스틱 제거

hook 원문을 볼 길이 없어서(어댑터는 payload 를 다 읽지 않고 데몬 로그에도 안 남는다) `hook.js` 에 **옵트인 진단**을 넣었다(T42-2):
`PIXEL_HOOK_LOG=<파일>` 이면 보낸 페이로드와 받은 결정을 JSONL 로 덧붙인다. 그렇게 받은 원문:

```
PreToolUse   {"tool_name":"mcp__team__create_team","tool_input":{"name":"개발","leadName":"코덱팀장","engine":"codex"}}
PostToolUse  {"tool_name":"mcp__team__create_team", …}
PreToolUse   {"tool_name":"mcp__team__delegate","tool_input":{"to_member":"m_6cddaa…","task":"sandbox 폴더에 …"}}
PreToolUse   {"tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Add File: …t42-lead.txt\n+hello\n*** End Patch"}}
```

- **Codex 도 Claude 와 똑같이 `mcp__team__*` 로 보낸다.** T22 가 후보로 적어 둔 `team.ask_user`/`team/ask_user` 는 전부 아니었다.
- **MCP 도구에는 `PermissionRequest` 가 아예 안 뜬다** — `PreToolUse → PostToolUse` 로 바로 간다.
  실측 `PermissionRequest` 8건은 **전부 `Bash`**. 즉 **D-22(`mcp__team__*` 자동 allow)는 Codex 에서 실제로 발화하지 않는다**(무해).
- → `CodexHooksAdapter.isTeamTool` override 와 `TEAM_TOOL_NAMES` 를 삭제하고 Base 의 접두사 판정만 쓴다.
  넓은 판정은 남의 MCP 서버 도구(`myteam__ask_user` 같은)를 잘못 자동 허가할 위험만 남는다.

### G. `Interrupt` hook 실물 페이로드 (02 §④ 의 마지막 미확인 항목)

데몬을 거치지 않고 스파이크 방식으로 직접 잡았다(임시 프로브 HTTP 서버 + `.codex/hooks.json` → 긴 턴 유도 → busy 확인 → Ctrl+C):

```
[probe] SessionStart      {"session_id":"01a0c2d5-…","hook_event_name":"SessionStart","model":"gpt-6-astra","permission_mode":"default","source":"startup"}
[probe] UserPromptSubmit  {… ,"turn_id":"01a0c2d5-4432-…","prompt":"1부터 50까지 …"}
[probe] ctrl+c (turn running)
[probe] Interrupt         {"session_id":"01a0c2d5-…","turn_id":"01a0c2d5-4432-…","transcript_path":"C:\\Users\\User\\.codex\\sessions\\…jsonl",
                           "cwd":"D:\\…\\sandbox","hook_event_name":"Interrupt","model":"gpt-6-astra","permission_mode":"default"}
[probe] SessionEnd        {… ,"reason":"other"}
```

키는 **7개뿐**(`session_id turn_id transcript_path cwd hook_event_name model permission_mode`) — 도구·이유 같은 추가 정보는 없다.
어댑터가 payload 를 안 읽는 현재 구현이 맞다. 픽스처(`test/fixtures/hooklog-codex-t42.json`)와 테스트로 고정했다.

**덤으로 확인된 것:** `Interrupt` 는 Ctrl+C 전용이 아니다. 실기에서 **Esc 로 턴을 끊어도** 발화한다
(`#1033 thinking [TASK#51…]` → `type 코덱부장 \e` → `#1034 idle 코덱부장 interrupted`). 빈 프롬프트에서의 퇴근 Ctrl+C 도
`Interrupt` → `SessionEnd` 순으로 낸다(A 의 이벤트 #7·#8).

### H. 승인 프롬프트 실물 (`capture-codex.ts`)

hooks.json 이 없는 신뢰 cwd 에서 4단계(`echo x > ../x.txt`)를 띄웠다.

```
  Would you like to run the following command?

  Environment: local

  Reason: 상위 폴더의 x.txt에 x를 쓰도록 허용하시겠습니까? 기존 파일이 있으면 덮어씁니다.

  $ echo x > ../x.txt

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `echo x > ../x.txt` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
```

esc → `✗ You canceled the request to run echo x > ../x.txt` → READY. 즉 T21 의 추정 중
**제목·`allowKeys:['enter']`·`denyKeys:['esc']` 는 맞았고 항목 문구·푸터만 달랐다.** `approval-exec` 를 `verified:true` 로.
`Reason:` 줄이 hook 의 `tool_input.description`(허가 카드에 싣는 그 한국어 문장)과 같은 문장인 것도 확인.
같은 실행에서 T21 이 못 받았던 **도구 실행 중 화면**(`working-1~4.txt`)도 받았다.

> 운영에서는 이 화면이 거의 안 뜬다 — `PermissionRequest` hook 이 붙어 있으면 Codex 는 TUI 오버레이 대신 hook 결정을 쓴다(D-04).

### I. 턴 종료 hook 없이 끝나는 화면

D-25 화면 기반 idle 폴백(`Office.watchScreenIdle`)은 T23b 에서 이미 들어가 있다. 이번 실기의 질문은
"한도 화면 말고도 그런 경우가 있는가" 였고, **만들어 보려 했지만 안 됐다:**

- 슬래시 명령(`/status`)은 `UserPromptSubmit` 자체가 안 와서 `working` 으로 올라가지도 않는다(갇힐 일이 없다).
- Esc 중단·Ctrl+C 중단은 둘 다 `Interrupt` hook 이 와서 즉시 `idle{interrupted}`.
- 정상 턴은 전부 `Stop` 이 왔다(이번 세션 25건).

**판정: 보류(조건 미발생).** 폴백 자체는 단위 테스트로 검증돼 있고, 발화하면 `idle{summary:'screen-idle'}` 이 남으므로
실사용에서 뜨는지 지켜보면 된다. (원래 재현 경로였던 사용량 한도 화면은 한도가 풀려 재현 불가.)

### 부장 = codex (T39 "남은 것")

`dept create t42 <sandbox> codex 코덱부장` → 화면 부팅 감시로 `idle`. 데몬은 `daemon.notice{warn}`
"부장 엔진이 codex 입니다 — v1 권장은 claude" 한 줄만 낸다. **하드 게이트는 어디에도 없었다**(`Office.createDepartment` 의
경고뿐, `PROTOCOL.md` 에도 "허용하지만 권장은 claude"). 그래서 "풀어야 할 제한" 은 없고, 경고 문구만 실측에 맞게 고칠지가 남는다(§결정).

한 번의 지시로 4종이 다 돌았다:

```
#993  thinking  코덱부장 [TASK#45 from user] … create_team … delegate … report …
#994  running   코덱부장 mcp__team__create_team
#995  running   코덱부장 mcp__team__delegate
#996  delegating 코덱부장 delegate — sandbox 폴더에 t42-lead.txt … task#46
#997  thinking  코덱팀장 [TASK#46 from 코덱부장(부장)] …
#1000 editing   코덱팀장 apply_patch D:\…\sandbox\t42-lead.txt
#1001 reading   코덱팀장 Bash Get-Content -LiteralPath 'D:\…\t42-lead.txt'
#1002 running   코덱팀장 mcp__team__report
#1003 reporting 코덱팀장 … task#46
#1004 thinking  코덱부장 [REPORTS task#46 코덱팀장 status=done] …
#1007 running   코덱부장 mcp__team__report
#1008 reporting 코덱부장 개발 팀의 코덱팀장이 … 작성·확인했습니다.  task#45   ← 내 책상까지
```

`ask_user`(C)와 `ask_parent`(혼합 팀에서 코덱팀장 → 코덱부장)도 같은 봉투로 돈다. 실측에서 본 Codex 의 `mcp__team__*` 도구는
**9종 중 8종**: create_team · delegate · report · ask_user · ask_parent · reply · hire · dismiss.

### J. 혼합 팀

부서 하나에 **부장(codex) → 팀장 2명(codex / claude) → 팀원(claude / codex)**. 부장이 두 팀장에게 동시에 위임하고,
각 팀장이 자기 팀원에게 다시 위임해 파일 두 개를 만들고 보고가 4단으로 올라왔다.

```
#1043 delegating 코덱부장 → 코덱팀장   task#53      #1047 delegating 코덱부장 → 클로드팀장  task#54
#1053 running   클로드팀장 mcp__team__hire         #1058 asking 코덱팀장 ask_parent — … memberId를 알려 주시겠습니까?
#1062 editing   파일이(claude) Write t42-mix-b.txt  #1089 running 파일작성(codex) Bash [System.IO.File]::WriteAllText(…)
#1093 reporting 파일작성 → #1098 reporting 코덱팀장 → #1106 reporting 코덱부장  task#52 (내 책상)
```

두 파일 모두 생겼다(`t42-mix-a.txt`=a, `t42-mix-b.txt`=b). Claude 팀원의 `Write` 만 허가 카드가 떴고(`a_d970b4…`)
Codex 쪽은 workspace 안이라 허가 없이 돌았다 — 엔진별 승인 정책 차이가 그대로 보인다.

### resume 복구 (새로 찾은 결함)

데몬을 하드 킬하고 같은 dataDir 로 다시 띄웠다. 5명 전원 재개(`codex resume <id>` / `claude --resume`).
그런데 **Codex 두 명은 `[RESUMED]` 지시가 입력 상자에 그대로 남고 제출되지 않았다.**

```
[screen] › [RESUMED] 데몬이 재시작됐다. 진행 중이던 작업: 없음. 직속 부하: 코덱팀장(팀장), …
[screen]   … 현재 상태를 점검하고 이어서 진행하라.
[screen]   gpt-6-astra high · D:\myproject\pixel-office\dev\spike-0\sandbox      ← 입력 상자에 텍스트가 남아 있다
po> tasks
task#57 queued user→코덱부장: …                                                  ← 다음 지시도 안 나간다
po> type 코덱부장 \r
#1131 text 코덱부장 resumed / #1132 thinking 코덱부장 [RESUMED] …                 ← 손으로 Enter 를 치면 그대로 제출된다
```

원인: 화면은 prompt ready 인데 **세션 복원이 끝나기 전이라 Enter 가 버려진다**(T21 의 `model: loading` 함정과 같은 부류인데,
복원된 대화가 헤더를 밀어내 `promptReady.noneOf` 로는 못 막는다). 부작용이 크다 — 여러 줄 텍스트가 입력 상자를 채우면
상태줄이 `statusWithin:3` 밖으로 밀려 `promptReady()` 까지 false 가 되어 **그 멤버의 큐가 영구히 막힌다.**

고침(T42-4): InputQueue 가 Enter 뒤 "프롬프트가 실제로 들어갔는가" 를 확인한다. 판정은 화면 문자열이 아니라
**들어갔을 때만 생기는 사실** — `UserPromptSubmit` → status working → `isIdle()` false. 2.5초 동안 계속 idle 이면
Enter 를 한 번 더(최대 4회). 다이얼로그·사용자 타이핑 중에는 확인을 접는다. 빈 입력 상자의 Enter 는 두 CLI 모두 무동작이라 안전하다.

재검증 — 같은 시나리오를 다시 돌리니 정확히 한 번씩 재시도하고 둘 다 통과했다:

```
[office] 코덱부장: 프롬프트가 안 들어가 Enter 를 다시 보냄 (1)
[office] 코덱팀장: 프롬프트가 안 들어가 Enter 를 다시 보냄 (1)
#1154 thinking 코덱부장 [RESUMED] …      #1155 text 코덱팀장 resumed
```

Claude 멤버 3명은 재시도가 필요 없었다(0회).

**같이 나온 것:** 턴을 한 번도 안 돈 Codex 멤버는 `session_id` 가 없어(D-24) 재시작에서
`error{restart: no session id to resume}` 가 된다(`img/T42-8-codex-resume-error.png` — 붉은 링 + `⚠ 오류`).
`rehire` 로 즉시 회복된다(새 세션, 잃을 맥락도 없다). 자동으로 새 세션을 띄울지는 결정 사항으로 남긴다(§결정 D-45 후보).

### 신뢰 다이얼로그

이 기계의 `~/.codex/config.toml` 에 `[projects.'C:\Users\User']` 와 `[projects.'d:\myproject']` 가 `trusted` 로 들어 있다.
**신뢰는 조상 폴더에서 상속된다** — 그 아래 방금 만든 빈 폴더(`dev/spike-0/sandbox-t42b`, `%TEMP%\t42-untrusted`)에
Codex 부장을 세워도 다이얼로그가 안 떴다(둘 다 바로 `idle`). 따라서 이번 실기에서는 **자동 통과가 발화할 조건이 없었다.**
Codex 신뢰 다이얼로그 자체는 T02/T21 픽스처로 검증돼 있다(`trust-directory`, `verified:true`).

## 캡처 (window-only, 릴리스 exe)

| 파일 | 내용 |
|---|---|
| `img/T42-1-codex-head.png` | 부장 = codex. 책상 이름표 `코덱부장 · 👑부장 · Codex`(파란 배지), **파란 셔츠** 캐릭터 |
| `img/T42-2-codex-head-team.png` | 부장(codex)이 `create_team` 으로 만든 팀 `개발` + 팀장(codex). 모니터에 `[REPORTS task#46 …]` |
| `img/T42-3-codex-report.png` | 부장 선택 → 로그 탭에 `mcp__team__create_team` / `위임` / `보고` 한 줄씩 |
| `img/T42-4-codex-report-tab.png` | 보고서 탭 — 부장이 사용자에게 올린 보고 2건(지시 원문 + 요약) |
| `img/T42-5-codex-askuser.png` | Codex 의 `ask_user` 질문 카드(`좋아하는 색은?` · 빨강/파랑 버튼), 캐릭터가 내 책상으로 |
| `img/T42-6-codex-approval.png` | **Codex 허가 카드** — `Bash · t42-approve.txt 쓰기`, Codex 가 쓴 한국어 사유, 명령 원문, 허가/거부 |
| `img/T42-7-mixed-team.png` | **혼합 팀** — 부장(Codex) · 팀 개발(Codex 팀장 + Claude 팀원) · 팀 백엔드(Claude 팀장 + Codex 팀원). 파란 셔츠 = Codex |
| `img/T42-8-codex-resume-error.png` | 재시작 복구에서 세션이 없던 Codex 팀원 — 붉은 링 + `⚠ 오류` 말풍선 |

허가는 **앱의 `허가` 버튼을 실제로 눌러** 통과시켰다(콘솔 아님) → `#1022 text … 작성했습니다` + 파일 생성 확인.

## 고친 결함

| # | 결함 | 고침 | 테스트 |
|---|---|---|---|
| 1 | `codex.integration.test.ts` 가 rev 3 이전 RPC 를 쓴다(-32004 / -32602 / -32601) + Codex 의 첫 `session_id` 를 잘못 단언 | 정식 경로 `department.create{headEngine:'codex'}` 로. 보고 폴백 확인 추가 | 그 IT 자체(PIXEL_IT=1) |
| 2 | CLI hook 원문을 볼 방법이 없다(T20·T22·T23 이 세 번 이월한 이유) | `hook.js` 에 옵트인 `PIXEL_HOOK_LOG` JSONL | `HookReceiver.test.ts` +2 |
| 3 | Codex MCP 도구 자동 allow 휴리스틱이 지나치게 넓다(`team` + 도구 이름) | 실물이 `mcp__team__*` 로 확정 → override 삭제, Base 접두사만 | `CodexHooksAdapter.test.ts` (기존 2건 교체 + T42 실물 재생 6건) |
| 4 | **Codex `resume` 직후 `[RESUMED]` 가 입력 상자에 갇혀 그 멤버의 큐가 영구히 막힌다** | InputQueue 에 제출 확인 + Enter 재전송(최대 4회) + `submitRetried`/`submitLost` 알림 | `InputQueue.test.ts` +4 |
| 5 | `approval-exec` 가 추정 패턴(`verified:false`)이고 항목 문구가 실물과 다르다 | 실물 캡처로 픽스처화, `verified:true`, notes 갱신 | `screens.test.ts` (합성 → 실물, +2) |

## 검증

```
$ cd dev/daemon && npx tsc --noEmit
(출력 없음, EXIT=0)

$ npm test
ℹ tests 532  ℹ suites 76  ℹ pass 525  ℹ fail 0  ℹ skipped 7     (baseline 518/511/7 → +14)

$ PIXEL_IT=1 npx tsx --test test/office/codex.integration.test.ts
ℹ tests 1  ℹ pass 1  ℹ fail 0
```

앱은 빌드만 했고 코드는 건드리지 않았다(앱 스위트 446 그대로).

정리: 부서 3개 모두 삭제 → 멤버 0 → `shutdown`. `codex.exe`/`claude.exe` 유령 0, 포트 7420-7422 해제 확인.

## 발견한 함정

1. **Codex 의 신뢰는 조상 폴더에서 상속된다.** `~/.codex/config.toml` 의 `[projects.'d:\myproject']` 하나면 그 아래
   새 폴더에도 다이얼로그가 안 뜬다(`~/.claude.json` 과 같다 — 02 §④ rev 3 주석). 신뢰 다이얼로그를 재현하려면
   신뢰된 조상이 **없는** 경로를 써야 한다.
2. **`type <member> <슬래시명령>` 은 큐를 헝클 수 있다.** `/status` 오버레이가 떠 있는 동안 큐가 지시를 paste 했고,
   그 사이에 보낸 Esc 가 입력 상자를 비워 Enter 가 빈 상자에 떨어졌다 — 지시 하나가 증발했다(task 는 `assigned` 인 채).
   사용자 타이핑 grace(3초)는 "사용자 → 자동" 방향만 막고 "자동 paste 중 사용자 입력" 은 못 막는다. T42-4 의 제출 확인이
   절반은 덮지만(안 들어간 것을 감지) 지워진 텍스트까지 되살리지는 못한다. src/input 후속 후보.
3. **Esc 도 `Interrupt` hook 을 낸다** — Codex 의 `esc to interrupt` 는 Ctrl+C 와 같은 경로다. 별도 처리 불필요.
4. **보고 폴백이 오래된 `assigned` task 에도 달라붙는다.** 취소되지 않고 남아 있던 task#50·#51 이 나중 턴의 요약으로
   한꺼번에 `reported` 됐다(`#1109`, `#1110`). 엔진 공통·기존 동작이고 표시상의 문제라 손대지 않았다.
5. **`query <부서> -` 는 안 먹는다** — 콘솔 도움말의 `query <부서|-> [beforeSeq]` 에서 `-` 는 *부서* 자리의 와일드카드인데
   `beforeSeq` 자리에 주면 `-32602`. 도움말 표기가 오해를 부른다(사소).

## 결정

새 결정 없음. 04-결정기록에 올릴 후보 셋(상위에서 번호 부여):

- **D-## (Codex MCP 도구 이름):** Codex 도 MCP 도구를 `mcp__team__<tool>` 로 보내고, **MCP 도구에는 `PermissionRequest` 를
  띄우지 않는다**(PreToolUse → PostToolUse). 따라서 D-22(자동 allow)는 Claude 전용으로 동작하고 Codex 에서는 무동작이다.
  어댑터는 엔진 공통으로 접두사 하나만 본다.
- **D-## (제출 확인):** 자동 타이핑은 Enter 를 보낸 것으로 끝내지 않고 **프롬프트가 들어갔는지**(= `isIdle()` 이 풀리는지)를
  2.5초 창으로 확인해 최대 4회까지 Enter 를 다시 보낸다. 화면 문자열로 판정하지 않는다. 다 실패하면 사용자에게 알린다.
- **D-## (턴 없는 Codex 멤버의 재시작):** Codex 는 첫 턴 전에는 `session_id` 가 없어(D-24) 재시작에서 `error` 가 된다.
  지금은 사용자가 `rehire` 한다. **잃을 맥락이 없으므로 새 세션으로 자동 재스폰**해도 되는데, "복구는 언제나 resume" 규칙을
  깨는 예외라 결정으로 올린다.

또 하나: `Office.createDepartment` 의 경고 "v1 권장은 claude(오케스트레이션 도구 실측이 Claude 기준)" 는 이제 사실이 아니다
(이번에 Codex 부장으로 8종 도구가 다 돌았다). 문구를 고치거나 경고를 없애는 것은 상위 판단으로 남긴다 — 이 태스크에서는
실측만 바꿨다.

## 남은 것

- **다른 통합 테스트 3개(`askuser`·`teamtools`·`restart`)도 rev 3 이전 RPC 를 쓴다** — `team.create{force,departmentId}`,
  `member.clockIn{force}`, `snapshot` RPC 없음. 이번 범위 밖이라 그대로 뒀다. 별도 태스크에서 한 번에.
- 함정 2(자동 paste 중 사용자 입력으로 지시가 증발) — src/input 후속.
- 함정 2(T23)의 `approval-prompt` 에서 `dialogPassed` 대신 `blocked` — **이미 고쳐져 있다**(D-26, T23b). 이번 실기에서
  Codex 허가는 전부 hook 으로 처리돼 그 화면이 뜨지 않았다.
- 목록 I(화면 기반 idle 폴백 발화) — 조건 미발생. 실사용 로그에서 `idle{summary:'screen-idle'}` 이 뜨는지 관찰.
- Claude `login-success` 다이얼로그 — 여전히 미검증(상시).
- `SessionStart(source=compact)` 재주입 — 02 "남은 것" 그대로(모델 턴과 무관, 긴 세션 필요).
