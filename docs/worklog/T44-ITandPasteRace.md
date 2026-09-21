# T44 — T42 후속: 낡은 통합 테스트 3종 + 붙여넣기↔Enter 사이 키 끼임

- 날짜: 2026-09-21
- 마일스톤: M5 이후 정리(T42 "남은 것")
- 관련 설계: 01 §구성 요소 1(입력 직렬화) / 04 D-32 · D-34 · D-46
- 커밋: `T44-1`(임계 구간) · `T44-2`(통합 테스트 rev 3) · `T44-3`(문서)

## 목표

T42 가 "남은 것" 으로 넘긴 두 가지를 닫는다.

1. **통합 테스트 3종이 낡았다** — `askuser`·`teamtools`·`restart` 가 rev 3(T34, D-32/D-34) 이전 RPC 를 쓰고 있어서
   한도·모델과 무관하게 `-32004` 로 죽는다. codex IT(T42-1)와 같은 방식으로 되살리고 **실제로 돌려** 증거를 남긴다.
2. **붙여넣기와 Enter 사이에 낀 사용자 키가 지시를 지운다**(T42 함정 2) — 자동 paste 중에 사용자가 Esc 를 치면
   입력 상자가 비고 뒤이은 Enter 가 빈 상자에 떨어져 **지시 하나가 증발**한다(task 는 `assigned` 인 채 남는다).

## 한 것

### 1. `src/input/InputQueue.ts` — paste ~ 제출 확정을 임계 구간 하나로 (T44-1)

- `flushHead` 의 `paste()` 와 함께 임계 구간이 열리고, 제출이 **확정**(= `isIdle()` false)되거나 접힐 때
  (다이얼로그 등장 / 재시도 소진 = `submitLost`) 닫힌다.
- 구간 동안 `typeRaw(data)` 는 pty 에 쓰지 않고 순서대로 모은다(`heldUserInput()` 으로 개수를 볼 수 있다).
  구간이 닫히면 모은 것을 **친 순서 그대로** 흘리고 그 시각으로 사용자 타이핑 grace 를 다시 건다.
- **모으는 동안 grace 기준 시각은 갱신하지 않는다.** 갱신하면 pty 에 닿지도 않은 키 때문에 T42-4 의 제출 확인이
  접혀(`userTyping` 분기) "Enter 가 씹혀 큐가 영구히 막히는" 상태로 되돌아간다. 이게 이 고침에서 제일 미묘한 지점이다.
- **Ctrl+C 는 절대 모으지 않는다**: 모아 둔 키를 먼저 흘리고(사용자가 친 순서 …키… → Ctrl+C),
  아직 안 나간 Enter 예약(`tag:'submit-enter'`)과 제출 확인을 취소한 뒤 즉시 `ctrl-c`. 제출된 적이 없으므로
  `flushed` 도 내지 않는다 — 그 task 는 afterCare 의 `interrupt` 행이 `aborted` 로 닫는다.
- **두 번 제출은 구조적으로 막힌다**: 확인은 매 tick 에서 `isIdle()` 을 **먼저** 보고, 풀려 있으면 그 자리에서 끝낸다
  (재시도 Enter 는 그 뒤에만 나간다). `stop()` 은 구간을 버린다(퇴근 경로라 되돌려 줄 상자가 없다).
- 사용자 입력을 붙잡는 최대 시간은 재시도 예산이 묶는다: `enterDelay(0.3s) + 4 × submitCheck(2.5s) ≈ 10.3초`.
  정상 흐름은 `UserPromptSubmit` 이 오는 즉시(보통 1초 안) 닫힌다. 그 사이에도 Ctrl+C 는 즉시 나간다.

테스트 `test/input/InputQueue.test.ts` +7 — 전부 주입 시계 + `tick()`(실제 타이머 없음):
paste↔Enter 사이의 Esc, 확정 뒤 순서대로 재생, 재생이 grace 를 다시 거는 것, 재시도 창마다 낀 키 5개의 순서,
Ctrl+C 가 Enter 예약을 취소하는 것, Enter 가 이미 나간 뒤의 Ctrl+C, 구간 밖 타이핑은 예전 그대로.
기존 2건은 실제 CLI 의 사실(`UserPromptSubmit` → `isIdle()` false)을 반영하도록 갱신.

### 2. 통합 테스트 rev 3 (T44-2)

| 파일 | 무엇이 낡았나 | 어떻게 고쳤나 |
|---|---|---|
| `test/office/askuser.integration.test.ts`(T17) | `team.create`+`member.clockIn`(둘 다 -32004) | `department.create{headEngine:'claude'}` 하나. **force 없음** — `ask_user` 는 부장 도구다 |
| `test/office/restart.integration.test.ts`(T09) | 같음 + 도우미 인라인 사본 | `department.create` 하나 + 도우미를 `it-helpers.ts` 로 합침 |
| `test/office/teamtools.integration.test.ts`(T25) | 같음(팀장이 필요한데 `team.create` 가 디버그) | `department.create` → `team.create{force,departmentId}` → `member.instruct{force}`. **딱 이 둘만 force** |
| `test/office/integration.test.ts`(T07, 덤) | 같음 | `department.create` 하나 |

- **force 를 쓴 근거(D-34)**: teamtools 가 보려는 것은 *팀장의* `hire`→`delegate`→`report` 다. 정식 경로로 팀장을
  세우려면 부장에게 모델 턴(`create_team`)을 한 번 더 태워야 하는데 그 경로는 `ranktools.integration.test.ts`(T35)가
  이미 통째로 본다. 그래서 팀장만 디버그 길로 세우고, 살아 있는 부장 때문에 막히는 "부장에게만 지시" 게이트도
  같은 탈출구로 넘는다. 나머지 셋은 force 가 한 군데도 없다.
- **세션 id 단언을 엔진에 맞게**: Claude 는 기동 `SessionStart` 로 첫 idle 때 이미 `session_id` 가 있다
  (Codex 는 첫 프롬프트 제출 때 — D-24). askuser 에 그 단언을 새로 넣고 restart 의 `--resume` 전제와 주석으로 묶었다.
- **스냅샷 전용 RPC 는 없다**(`-32601`) — `hello` 응답으로만 온다. `snapshotOnce(port, token, tag)` 헬퍼 하나로 통일.
- **격리**: `itEnv(prefix)` 가 임시 `PIXEL_DATA_DIR` + `freePort()` 세 개를 만든다. 기본 포트 7420-7422 에 진짜 데몬이
  떠 있어도 부딪히지 않는다(D-40 — `PIXEL_FORCE_START` 는 쓰지 않는다). 프로덕션 코드는 손대지 않았다 —
  세 포트는 원래 `PIXEL_WS_PORT`/`PIXEL_HOOK_PORT`/`PIXEL_MCP_PORT` 로 열려 있다.
- **`PIXEL_IT_SANDBOX`**(테스트 전용): 멤버 cwd 를 갈아끼운다. `dev/spike-0/sandbox` 는 gitignore 대상이라
  worktree 체크아웃에는 없다 — 이번 실기도 이 변수로 저장소 본체의 sandbox 를 가리켜 돌렸다.

## 검증

```
$ cd dev/daemon && npx tsc --noEmit
(출력 없음, EXIT=0)

$ npm test
ℹ tests 539  ℹ suites 77  ℹ pass 532  ℹ fail 0  ℹ skipped 7     (baseline 532/525/7 → +7)
```

실기는 전부 `PIXEL_IT=1` + `PIXEL_IT_SANDBOX=D:/myproject/pixel-office/dev/spike-0/sandbox`,
claude 2.1.275(Opus 5), cwd `dev/spike-0/sandbox`, 임시 dataDir · 임시 포트 3개.

### askuser(T17) — 1 pass, 17.0초

```
[IT] department=d_1e666c02dfad head=m_11ad3e3c57a5 rank=head pid=1136 (843ms)
[IT] mcp.json: {"mcpServers":{"team":{"type":"http","url":"http://127.0.0.1:10600/mcp/e16580ef70…"}}}
[IT] idle (SessionStart) 2172ms session_id=f54ca71f-8314-4128-9b47-c8374061f979   ← Claude 는 기동 때 온다
[IT:c] event #3 running {"tool":"mcp__team__ask_user"}
[IT:c] event #4 asking {"tool":"ask_user","summary":"좋아하는 색은?","options":["빨강","파랑"]} q=q_98d45ffb408f
[IT] pending q_98d45ffb408f: {"source":"ask_user","question":"좋아하는 색은?","options":["빨강","파랑"]}
[IT] turn ended after asking: idle #6, status=idle derived=waiting_answer (8981ms)
[IT] [ANSWER] typed #7 (10461ms): "[ANSWER q#q_98d45ffb408f]\n파랑"
[IT:c] event #8 text {"text":"파랑"}
[IT] clockOut done (15236ms); claude alive=false
ℹ tests 1  ℹ pass 1  ℹ fail 0  ℹ duration_ms 17022
```

### restart(T09) — 1 pass, 30.4초

```
[d2:out] [office] recover 기억이(m_10b1dce83686): --resume 1ccd99e4-7890-43ed-bad4-aa220bfdffa1, assigned 0, requeued 0, expired 0
[d2:out] [office] 복구: 1명 재개, 0건 만료, 유령 1개 정리
[IT] after restart: status=starting session_id=1ccd99e4-… child_pid=10968 (7693ms)   ← session_id 유지
[IT:c2] event #6 thinking {"text":"[RESUMED] 데몬이 재시작됐다. …"}
[IT] attach screen=2273 bytes; has instruction=true greeting tokens hit=["안녕하세요","it09","부장","기억이입니다",…]
[IT] recall (25776ms): "\"안녕하세요, it09 부장 기억이입니다 — 오늘도 잘 부탁드립니다!\" 라고 인사드렸습니다."
[IT] d2 exited=true code=0 (28839ms) / leftover check: 16144=dead 10968=dead
ℹ tests 1  ℹ pass 1  ℹ fail 0  ℹ duration_ms 30554
```

`[RESUMED]` 는 **재시도 0회**로 한 번에 들어갔다(T42 실측과 같다 — Claude 는 0, Codex 는 1회).

### teamtools(T25) — 1 pass, 39.4초

```
[IT] department=d_400aa41443bb head=m_db1e609952df pid=13016 (732ms)
[IT] team=t_70d91ef3603c lead=m_2cff8c7f155c rank=lead parent=m_db1e609952df pid=10028 (852ms)
[IT] hired 보조 (m_062aed2541f9) engine=claude hiredBy=leader (10769ms)
[IT] worker INSTRUCTIONS.md: "# 역할: 파일 작성\n…"
[IT] delegating #5 task#2 → 보조 (assigned) (14609ms)
[IT:c] event #10 waiting_approval {"tool":"Write","path":"…\sandbox\hello25.txt"} → auto-approve a_e014838e0f44
[IT] leader got reports (24642ms): [REPORTS task#2 보조 status=done] …
[IT] reports text truncated (200자) — [ALL_REPORTS_IN] 은 단위 테스트가 본다
[IT] leader reported task#1: {"summary":"팀원 '보조'(파일 작성) 고용 → … `hi` 한 줄 생성 완료…","status":"done"}
[IT] hello25.txt: "hi\n" (33610ms)
ℹ tests 1  ℹ pass 1  ℹ fail 0  ℹ duration_ms 39659
```

### integration(T07, 덤) — 1 pass, 13.9초

```
[IT] department=d_709aa8b38611 head=m_9fcc36367158 rank=head pid=… status=starting
[IT] event #3 waiting_approval {"tool":"Bash","cmd":"echo t07 > t07.txt"} → allow a_b6f857eec3f7
[IT] t07.txt = "t07\n"   /   reporting event ref={"taskId":1}
[IT] daemon exited=true code=0
ℹ tests 1  ℹ pass 1  ℹ fail 0  ℹ duration_ms 13881
```

정리: 매 실행마다 부서를 지우거나 퇴근시키고 `daemon.shutdown` 까지 갔다. 실행 후 `claude.exe` 유령 0
(`Get-CimInstance Win32_Process … CommandLine like '*Temp\pixel-office*'` 로 확인), 임시 dataDir 삭제.

## 발견한 함정

1. **worktree 에는 `dev/spike-0/` 가 없다.** `dev/spike-0/sandbox/`·`dev/spike-0/*.json` 이 gitignore 대상이라
   worktree 체크아웃에는 안 딸려 온다 → `MixedTeam.test.ts` 가 픽스처(`hooklog-2.json`)를 못 찾아 **단위 스위트가
   빨갛게 시작한다**(523/515/1). 저장소 본체에서 그 파일들을 복사하면 baseline 532/525/7 이 나온다.
   IT 의 cwd 도 같은 이유로 없으므로 `PIXEL_IT_SANDBOX` 로 본체를 가리켜야 한다.
2. **rev 3 에서는 팀장도 `hiredBy:'leader'` 다**(부장의 자식이니까). "팀장이 고용한 팀원" 을 기다리면서 그 필드만
   보면 **이미 받아 둔 팀장 알림에 그대로 걸린다**(`waitFor` 는 지나간 알림도 훑는다). `rank==='member'` 로 갈라야 한다.
3. **Claude 부장은 시키면 팀부터 만든다.** T07 의 "셸 명령을 실행해줘. 다른 건 하지 마." 로는 부장이 `create_team`
   → `delegate` 를 했고 허가 요청이 **팀장 쪽에서** 떠서 테스트가 부장의 `waiting_approval` 을 3분 기다리다 죽었다.
   `"팀을 만들거나 위임하지 말고 네가 직접"` 으로 못 박아야 한다(Codex 부장은 시키는 대로 직접 했다 — T42 A).
4. **`thinking.text` 는 200자(`MAX_THINKING_CHARS`)에서 잘린다** — 보고가 길면 `[ALL_REPORTS_IN]` 꼬리가 이벤트에
   안 남는다(큐에 들어간 본문에는 있다). ranktools IT 가 이미 안 보던 것을 teamtools IT 도 조건부로 바꿨다.
5. **`daemon.notice{warn} "CLI 허가 프롬프트가 떠 있음"`(D-26)이 MCP 도구 구간에서 두 번 떴다**(teamtools 의 팀장,
   T07 의 팀장). 화면에 잠깐 뜬 허가 오버레이를 ScreenModel 이 잡은 것으로, 곧 hook 결정으로 사라지고 흐름은
   그대로 이어졌다. 지금은 알림 한 줄일 뿐이라 손대지 않았다 — 관찰 대상(§남은 것).

## 결정

새 결정 없음. D-46 ②(전송 확인은 화면이 아니라 사실로)의 연장선이고, 04-결정기록에 올릴 후보 하나:

- **D-## (임계 구간):** 자동 붙여넣기와 그 Enter 는 **한 덩어리**다. 그 사이(재시도 포함)에 들어온 사용자 키는
  pty 로 보내지 않고 모아 뒀다가 제출이 확정된 뒤 순서대로 재생한다. **Ctrl+C 만 예외** — 즉시 나가고 아직 안 보낸
  Enter 를 취소한다. 근거: 키 하나가 입력 상자를 비우면(Esc) 붙여넣은 지시가 통째로 사라지는데, 화면으로는 그것을
  구별할 수 없다(T42 함정 2 실측).

## 남은 것

- 임계 구간이 길어지면(재시도 4회 = 최대 ~10초) 사용자가 친 글자가 그동안 화면에 안 보인다. 지금은 Ctrl+C 가
  탈출구이고 실제로는 1초 안에 닫히지만, 앱 터미널 탭에 "입력 보류 중" 같은 표시를 줄지는 UI 판단으로 남긴다
  (데몬에서는 `heldUserInput()` 으로 볼 수 있다 — 알림은 일부러 안 만들었다).
- 함정 5(MCP 도구 구간의 `허가 프롬프트가 떠 있음` 경고) — 화면 판정 오탐인지 실제 오버레이인지 `src/screen` 에서
  한 번 볼 것. 흐름에는 영향이 없다.
- Codex 엔진으로 도는 IT 는 여전히 `codex.integration.test.ts` 하나뿐이다(나머지 넷은 Claude). 혼합 팀 실기는
  T42 J 가 손으로 봤다.
