# T08 — 콘솔 클라이언트 (RpcClient + REPL)

- 날짜: 2026-09-14
- 마일스톤: M1
- 관련 설계: 01-설계문서.md §구성 요소 1 "와이어 프로토콜", §3(재접속 `hello{since}`), `dev/daemon/PROTOCOL.md`
- 커밋: (미커밋 — 이 태스크는 커밋하지 않음)

## 목표

Flutter 앱 없이도 터미널에서 데몬을 전부 조작할 수 있다: 팀/멤버 생성, 지시, 터미널 attach, 허가/질문 응답, 이벤트 조회, 지시문 편집, 종료. 재사용 가능한 JSON-RPC 클라이언트(`RpcClient`)를 분리해 두어 T10 데모 스크립트(비대화 `--exec` 모드)와 나중의 다른 Node 클라이언트가 같은 코드를 쓴다. T07(서버)과 병렬 작업이라 **실제 데몬 없이 PROTOCOL.md 만 보고** 구현했고, 검증은 테스트 안의 가짜 ws 서버 + 스크래치 가짜 데몬으로 했다.

## 한 것

- `dev/daemon/src/cli/RpcClient.ts` — `ws` 기반 JSON-RPC 2.0 클라이언트.
  - `connect(url?)` (기본 `ws://127.0.0.1:<daemon.json.wsPort ?? config.wsPort>`), `hello({token?, since?, client?})` → `HelloResult{daemon, snapshot}`, `call(method, params, timeoutMs=15000)` (id 상관, 에러 응답 → `RpcError{code,message,data}` throw, 타임아웃 `-2`, 연결 끊김 `-1`), `close()`.
  - `readDaemonInfo(dataDir=config.dataDir)` / `daemonInfoPath()` / `defaultWsUrl()` 내보냄. `hello` 에 token 이 없으면 `${config.dataDir}/daemon.json` 에서 읽는다.
  - `lastSeq`: `event` 알림의 seq 와 `snapshot.seq`(hello 결과·`snapshot` 알림)의 최댓값. **seq ≤ lastSeq 인 `event` 는 'event' 로 내보내지 않는다**(재접속 규칙 2 — 스냅샷에 이미 반영된 replay 제거). hello 응답의 `snapshot.seq` 는 뒤따르는 replay 보다 먼저 반영되도록 응답 핸들러 안에서 동기적으로 갱신.
  - 이벤트: `notification`(원본 전부), `event`, `snapshot`, `term`, `member.status`, `daemon.notice`, `open`, `close`(열렸던 소켓이 닫힐 때만 — 접속 실패는 아님), `error`.
  - `connectWithRetry({url?, intervalMs=1000, maxAttempts=∞, hello?, onAttemptFailed?})` → 접속 재시도 후 hello. 한 번 동기화된 뒤면 `since=lastSeq` 를 자동으로 넣고 token/client 는 저장된 것을 재사용.
- `dev/daemon/src/cli/parse.ts` — 순수 함수: `tokenize`(따옴표·이스케이프), `parseLine`(`rawAfter(i)` 로 원문 꼬리 추출 — `say`/`type` 용), `resolveMember`/`resolveTeam`(id 정확 → 이름 정확 → id 접두 → 이름 접두, 모호하면 `CliError`; 같은 이름이 여럿이면 exited/error 아닌 것이 하나일 때 그것), `resolvePendingId`(접두), `parseAnswerArgs`(`q=label` 쌍 또는 단일 label), `unescapeTyped`/`typedPayload`(`\n \r \t \e \\ \xHH \uHHHH`; 끝이 `\n`/`\r` 이 아니면 `\r` 추가), `parseArgv`(`--exec/-e`, `--wait-idle`, `--url`, `--token`, `--timeout`, `--help`).
- `dev/daemon/src/cli/format.ts` — `stripAnsi`(CSI/OSC/DCS/2바이트 ESC/C0 제거, `\t \n \r` 유지), `detailSummary`, `formatEvent`(`#seq kind member 요약  approval=.. task#..`), `formatMember/Team/Task/Pending`, `pendingSummary`/`questionsOf`(approval: `tool_name + command|file_path|path`, question: `질문 [옵션|옵션]`), `LocalPending`.
- `dev/daemon/src/cli/index.ts` — REPL(`node:readline`) + 비대화 모드. 시작 시 `connectWithRetry`(5회) → hello → 스냅샷 요약(팀·멤버 상태·열린 pending·열린 task). 로컬 상태: teams/members/pending Map, tasks, 이벤트 링버퍼 500건, attach 중인 멤버. 알림은 프롬프트 줄을 지우고 위에 찍은 뒤 프롬프트 복원(TTY 일 때만; 파이프 입력이면 명령을 `po> ` 로 echo). 연결이 끊기면 자동 재접속(2초 간격 30회) 후 스냅샷 재적용, attach 중이었으면 `member.attach` 재호출(규칙 3: term 은 replay 안 됨).
- `dev/daemon/test/cli/RpcClient.test.ts` — 테스트 안에서 PROTOCOL 대로 동작하는 가짜 ws 서버(`hello` 토큰 검증·`since` replay, `echo` 지연 응답, `fail`, `hang`, 알림 push) 10건.
- `dev/daemon/test/cli/parse.test.ts` — 파싱·해석·포맷 11건.

### 명령 목록 (`help`)

| 명령 | RPC | 설명 |
|---|---|---|
| `teams` | — | 팀 목록 |
| `team create <name> <cwd> [claude\|codex]` | `team.create` | 팀 생성 (팀장 엔진 기본 claude; 결과의 `leader` 는 있으면 표시) |
| `team delete <team>` | `team.delete` | 팀 삭제 |
| `members` | — | 멤버 목록 (`id 이름 [engine] status rank team= pid=`) |
| `hire <team> <claude\|codex> <name>` | `member.clockIn` | 출근 |
| `fire <member>` | `member.clockOut` | 퇴근 |
| `rehire <member>` / `restart <member>` | `member.rehire` / `member.restart` | 재출근 / 재시작 |
| `say <member> <text...>` | `member.instruct` | 지시 → `task#n → 이름` 출력 |
| `type <member> <text>` | `member.type` | raw 타이핑. 이스케이프 지원, 끝이 `\n`/`\r` 아니면 Enter(`\r`) 자동 |
| `attach <member>` / `detach` | `member.attach` / `member.detach` | 화면(ANSI 제거, `[screen]`) 출력 후 `[term]` 스트림 |
| `int <member>` | `member.interrupt` | Ctrl+C |
| `resize <member> <cols> <rows>` | `member.resize` | |
| `pending` | — | 열린 허가/질문 (스냅샷 + 라이브 `waiting_approval`/`asking` 이벤트) |
| `allow <pending>` / `deny <pending> [message]` | `approval.respond` | pending id 접두 허용 |
| `answer <pending> <q>=<label> ...` / `answer <pending> <label>` | `question.respond` | 단일 label 은 질문이 하나이고 payload 를 아는(스냅샷 출처) 경우만 |
| `events [n]` | — | 최근 수신 이벤트 (기본 20) |
| `query <team\|-> [beforeSeq] [limit]` | `events.query` | 과거 이벤트 |
| `tasks` | — | 스냅샷의 열린 task |
| `instr get <member>` / `instr set <member> [text]` | `member.instructions.get/set` | set 은 text 생략 시 여러 줄 입력(`.` 로 종료, Ctrl+C 취소) |
| `refresh` | (재접속) | 스냅샷 다시 받기 |
| `help` / `quit` / `shutdown` | — / — / `daemon.shutdown` | |

`<member>`/`<team>`/`<pending>` 은 id·이름·접두 어느 것이든. 라이브 출력 형식: `#seq kind 이름 요약`, `status 이름 → status (derived)`, `[term] ...`, `[daemon:level] message`, `[snapshot] seq=..`.

### 비대화 모드

```
npm run cli -- --exec "hire t1 claude 하루" --exec "say 하루 안녕" --wait-idle 하루 [--timeout 600000] [--url ws://..] [--token ..]
```

`--exec` 를 순서대로 실행(하나라도 실패하면 exit 1 로 중단) → `--wait-idle <member>` 가 있으면 그 멤버의 idle(`idle` 이벤트 또는 `member.status idle`)까지 대기 → 종료. 대기 시작 시점에 멤버가 idle/starting 으로 보이면 **working 을 한 번 본 뒤의 idle 만 인정**(출근 직후의 늦은 idle 알림 등 stale idle 에 속지 않도록). 실행 중 도착하는 알림은 그대로 출력되므로 데모 로그로 쓸 수 있다.

## 검증

```
$ cd dev/daemon && npx tsx --test test/cli/*.test.ts
▶ RpcClient
  ✔ hello: 결과 반환, snapshot.seq → lastSeq, since 없으면 replay 없음
  ✔ call: id 상관 — 응답 순서가 섞여도 각 호출이 제 결과를 받는다
  ✔ call: error 응답 → RpcError{code,message,data}
  ✔ call: 타임아웃 / 연결 종료 시 대기 중 호출 거부
  ✔ hello: 토큰 불일치 → -32001 후 소켓 종료
  ✔ 알림: notification 원본 + 타입별 이벤트, event 로 lastSeq 추적, 중복 seq 무시
  ✔ 재접속: connectWithRetry 가 since=lastSeq 로 hello 하고 replay 중 snapshot.seq 이하만 건너뛴다
  ✔ 재접속: replay 가 스냅샷보다 앞서 있어도(since < snapshot.seq 의 replay) 순서대로 적용
  ✔ connectWithRetry: 접속 실패 시 재시도 후 포기
  ✔ readDaemonInfo / hello 의 token 자동 읽기
▶ tokenize / parseLine (2)  ▶ resolveMember (3)  ▶ answer / type / argv (3)  ▶ format (3)
ℹ tests 21  ℹ pass 21  ℹ fail 0

$ npx tsc --noEmit
src/office/Office.ts(124,5): error TS2322: ...   ← T07(병렬 작업 중) 파일. src/cli, test/cli 에는 에러 0건.
```

실제 데몬이 없어 스크래치 폴더(프로젝트 밖)에 PROTOCOL.md 의 일부를 흉내낸 가짜 데몬(`daemon.json` 기록, hello/team.create/member.clockIn/instruct→working·idle 이벤트/attach+term/approval·question.respond/instructions/events.query/shutdown)을 띄우고 `PIXEL_DATA_DIR` 로 가리켜 `index.ts` 를 통째로 돌렸다.

```
$ PIXEL_DATA_DIR=<scratch>/data npx tsx src/cli/index.ts --exec "hire alpha claude 하루" --exec "pending" \
    --exec "allow a_" --exec "answer q_1 파랑" --exec "say 하루 안녕 세상" --exec "attach 하루" \
    --exec "type 하루 ls\n" --exec "type 하루 \e" --exec "instr get 하루" --exec "query alpha 100 5" --wait-idle 하루 --timeout 3000
데몬 vfake (pid 12372) 연결됨 — ws://127.0.0.1:7499  seq=10
팀 1개
  t1  alpha  D:\proj  leader=-  members=1/4
멤버 1명
  m0  기존 [codex] waiting_approval  member team=alpha pid=111
열린 pending 2건
  a_1  approval  기존  Bash rm -rf x
  q_1  question  기존  색? [파랑|빨강]
po> hire alpha claude 하루
출근: m2abcdef  하루 [claude] starting  member team=alpha pid=4242
po> pending
a_1  approval  기존  Bash rm -rf x
q_1  question  기존  색? [파랑|빨강]
    Q: 색?  → 파랑 | 빨강
po> allow a_
allow: a_1
po> answer q_1 파랑
answer: q_1 {"색?":"파랑"}
po> say 하루 안녕 세상
task#1 → 하루
po> attach 하루
── 하루 화면 (120x40) ──
[screen] > hello
[screen] ✔ ready
── 이후 [term] 로 스트림 (detach 로 해제) ──
po> type 하루 ls\n
po> type 하루 \e
po> instr get 하루
── 하루 지시문 ──
  # 역할
  - 테스트
──
po> query alpha 100 5
#1 idle 기존
[wait-idle] 하루 의 working → idle 대기 (최대 3000ms)
[term] streamed line
status 하루 → working
#11 thinking 하루 task#1
#12 running 하루 Bash npm test
#13 text 하루 답: 안녕 세상
#14 idle 하루 task#1
[wait-idle] 하루 idle (event)
EXIT=0

(가짜 데몬이 받은 것)
[fake] approval {"pendingId":"a_1","behavior":"allow"}
[fake] question {"pendingId":"q_1","answers":{"색?":"파랑"}}
[fake] type "ls\n"          ← \n 으로 끝나 Enter 미추가
[fake] type "\u001b\r"      ← ESC + Enter 자동
```

파이프 입력으로 대화형 경로(여러 줄 `instr set`, `deny ... message`, EOF 시 정리)도 확인:

```
$ printf 'instr set 기존\n# 역할\n- 줄1\n- 줄2\n.\nresize 기존 100 30\nattach 기존\ndetach\ndeny a_1 위험함\nquit\n' | npx tsx src/cli/index.ts
po> instr set 기존
지시문 입력 (기존). 마침표 한 줄(.)로 종료, Ctrl+C 취소
지시문 저장: 기존 (14자) — 다음 SessionStart 부터 반영, 즉시는 restart 기존
po> resize 기존 100 30
resize 기존 → 100x30
...
po> deny a_1 위험함
deny: a_1
po> quit
EXIT=0
[fake] instr "# 역할\n- 줄1\n- 줄2"
[fake] approval {"pendingId":"a_1","behavior":"deny","message":"위험함"}
```

오류 경로: 없는 멤버(`오류: 멤버를 찾을 수 없습니다: 없는사람`, exit 1), 모르는 명령, 잘못된 토큰(`오류 [-32001] auth`), `daemon.json` 없음(`데몬 정보가 없습니다: ...\daemon.json — 데몬이 실행 중인지 확인하세요 (npm start)`), `--exec shutdown` 으로 가짜 데몬 종료.

## 발견한 함정

1. **hello 응답과 replay 의 경쟁.** hello 결과(`snapshot.seq`)와 뒤따르는 replay `event` 들이 같은 TCP 청크로 오면 `ws` 가 message 이벤트를 연달아 동기 발행하므로, `await hello()` 뒤에서 lastSeq 를 올리면 늦다(replay 가 먼저 처리돼 중복 적용). 응답 핸들러 안에서 `result.snapshot.seq` 를 동기적으로 반영하도록 함. 테스트 "재접속: … snapshot.seq 이하만 건너뛴다" 가 이 경우를 잡는다.
2. **`ws` 는 접속 실패 시에도 `close` 를 낸다.** 재시도 루프 중 매 실패마다 REPL 의 "연결 끊김 — 재접속" 핸들러가 재진입하는 것을 막기 위해 소켓이 실제로 열렸을 때만 `close` 를 emit.
3. **파이프 입력의 readline.** EOF 직후 `close` 가 오는데 아직 처리 중인 줄이 있으면 `quit()` 이 소켓을 먼저 닫아 뒤 명령이 전부 `-1` 로 실패했고, 닫힌 뒤 `rl.prompt()` 를 부르면 `ERR_USE_AFTER_CLOSE` 로 크래시. `close` 시 quit 을 명령 체인 뒤에 걸고, closed 플래그로 prompt 를 막음. 또 `clearLine/cursorTo` 는 TTY 가 아니면 `[2K[1G` 가 그대로 찍히므로 TTY 일 때만.
4. **wait-idle 의 stale idle.** 출근 직후 늦게 도착한 `status idle` 이 `say` 뒤의 대기를 즉시 풀어 버렸다. 시작 시 멤버가 idle/starting 로 보이면 working(비-idle 상태·이벤트)을 본 뒤의 idle 만 인정하도록 바꿈.
5. 스크래치의 가짜 데몬에서 `import 'ws'` 는 node_modules 가 없어 실패 → `file:///.../node_modules/ws/wrapper.mjs` 절대 경로로 import (프로젝트에 파일을 추가하지 않기 위해).

## 결정

이 태스크는 `04-결정기록.md` 편집 범위 밖이라 여기에만 적는다.

- 클라이언트 자체 에러 코드는 `-1`(연결 없음/닫힘), `-2`(타임아웃) — JSON-RPC 예약 범위(-32000~-32768)와 서버 코드와 겹치지 않게.
- `event` 는 seq ≤ lastSeq 면 버린다(RpcClient 층에서). 콘솔 로그 관점에선 replay 를 다시 찍어도 무해하지만, pending 맵처럼 "적용"하는 상태가 있으므로 PROTOCOL 규칙 2 를 클라이언트 층에서 한 번에 지키는 편이 안전.
- `type` 의 Enter 는 `\r`(pty 관례). `\n` 으로 끝나면 그대로 보낸다.

## PROTOCOL.md 에서 추정한 것 (T07 과 맞출 것)

1. **`approval.respond` 에 `message` 가 없다.** 과제의 `deny <id> [message]` 를 위해 message 가 주어질 때만 `{ pendingId, behavior:'deny', message }` 로 보낸다. 서버가 파라미터를 엄격히 검사하면 `-32602` 가 날 수 있음 — PROTOCOL 에 `message?` 를 추가하거나, 클라이언트에서 빼야 함.
2. **라이브 pending 은 payload 가 없다.** `event`(`waiting_approval`/`asking`)에는 `ref.approvalId/questionId` 와 `detail` 요약만 있어, 접속 중 생긴 질문은 질문 원문·옵션을 모른다. 그래서 `answer <id> <label>`(단일) 은 스냅샷 출처 pending 에서만 되고, 라이브 것은 `answer <id> <question>=<label>` 이나 `refresh` 후에만 가능. 데몬이 `pendingCreated` 를 알림(`pending {Pending}`)으로 흘려 주거나 `asking` detail 에 questions 를 넣어 주면 해소된다.
3. **pending 이 다른 클라이언트에 의해 닫히거나 expired 될 때 알림이 없다.** 로컬 pending 맵은 내가 응답한 것만 지우므로 stale 할 수 있음(`refresh` 로 복구). `pending.resolved`/`snapshot` 재전송 중 하나가 있으면 좋겠다.
4. **스냅샷만 다시 받는 요청이 없다.** `refresh` 는 소켓을 닫고 `hello{since}` 로 재접속한다.
5. `hello{since}` replay 범위 — `since < seq` 인 것 전부인지, `snapshot.seq` 초과만인지 불명확. 클라이언트는 어느 쪽이든 되도록 seq ≤ snapshot.seq 를 버린다.
6. 토큰 불일치 시 "에러 응답 후 소켓 종료" — 에러 응답 없이 바로 끊겨도 `-1` 로 거부되도록 처리(테스트는 응답 후 종료 순서).
7. `member.instruct` 의 `taskId` 타입을 `Task.id`(number)로 가정. `team.create` 의 `leader` 는 v1a 에선 없을 수 있다고 봐서 선택적으로 처리.
8. `member.status.derived` 는 `string | null` 로, `daemon.notice.level` 은 자유 문자열로 가정. 알 수 없는 method(`-32601`)는 표에 없지만 표준 코드로 매핑.
9. 같은 클라이언트가 다른 멤버를 `attach` 하면 이전 멤버를 자동 detach 하는지 불명확 — 클라이언트가 먼저 `member.detach` 를 보낸다.
10. `daemon.json` 위치는 PROTOCOL 의 `%LOCALAPPDATA%\pixel-office` 가 아니라 `config.dataDir`(`PIXEL_DATA_DIR` 우선) 를 따른다 — 데몬도 `config` 를 쓸 것이므로 같은 위치일 것.

## 남은 것

- 실제 데몬(T07)에 붙여 본 적이 없다. T07 완료 후 `npm start` + `npm run cli` 로 `hire → say → attach → allow/answer → fire` 한 바퀴를 돌려 위 추정 1·2·5 를 확정할 것.
- `pending` 의 approval 상세(`permission_suggestions`)는 표시하지 않는다. `allow` 에 `alwaysThisSession`/`updatedInput` 옵션도 미노출.
- `--wait-idle` 은 멤버 하나만. 여러 멤버/`waiting_approval` 까지 기다리기는 T10 필요 시.
- 터미널 attach 는 ANSI 를 벗긴 텍스트만 — 진짜 터미널 렌더링은 Flutter 쪽(xterm) 몫.
