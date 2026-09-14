# 데몬 ↔ 클라이언트 프로토콜 (v1a 초안, T07에서 확정)

전송: WebSocket `ws://127.0.0.1:7420`. 봉투: **JSON-RPC 2.0** (요청 `{jsonrpc:"2.0", id, method, params}` / 응답 `{jsonrpc:"2.0", id, result|error}` / 알림 `{jsonrpc:"2.0", method, params}`).
인증: 데몬 기동 시 `%LOCALAPPDATA%\pixel-office\daemon.json`에 `{ "wsPort", "hookPort", "token", "pid", "startedAt" }`를 쓴다. 클라이언트는 첫 요청 `hello`에 token을 넣는다. 불일치면 에러 응답 후 소켓 종료.

## 클라이언트 → 데몬 (요청)

| method | params | result |
|---|---|---|
| `hello` | `{ token, since?: number, client: { name, version } }` | `{ daemon: { version, pid }, snapshot }` 후 `since < seq` 인 `event` 알림 replay. `since` 없으면 스냅샷만. |
| `events.query` | `{ teamId?, memberId?, beforeSeq?, limit? }` | `{ events: OfficeEvent[] }` (seq 내림차순 아님 — 오름차순 반환) |
| `team.create` | `{ name, cwd, leaderEngine: 'claude'\|'codex', maxMembers?, allowedEngines? }` | `{ team, leader: Member }` — M4 전(v1a)에는 팀장 자동 출근 없이 `team`만. |
| `team.delete` | `{ teamId }` | `{}` — 멤버 전부 clockOut 후 삭제 |
| `member.clockIn` | `{ teamId, engine, name, instructions? }` | `{ member }` — CLI 스폰(문으로 입장) |
| `member.clockOut` | `{ memberId }` | `{}` — 진행 task aborted 후처리, 프로세스 종료 |
| `member.rehire` | `{ memberId }` | `{ member }` — exited/error 멤버를 같은 설정으로 재스폰(`--resume` 시도) |
| `member.restart` | `{ memberId }` | `{ member }` — 지시문 즉시 반영용 재스폰(`--resume`) |
| `member.instruct` | `{ memberId, text }` | `{ taskId }` — 입력 큐에 `[TASK#n from user]` 타이핑 |
| `member.type` | `{ memberId, data }` | `{}` — 터미널 탭 직접 타이핑 (raw bytes, 큐 우선) |
| `member.attach` | `{ memberId, cols, rows }` | `{ screen: string(ANSI serialize), cols, rows }` 이후 `term` 알림 구독 |
| `member.detach` | `{ memberId }` | `{}` |
| `member.resize` | `{ memberId, cols, rows }` | `{}` — 마지막 attach 클라이언트만 유효 |
| `member.interrupt` | `{ memberId }` | `{}` — Ctrl+C |
| `member.instructions.get` | `{ memberId }` | `{ markdown }` |
| `member.instructions.set` | `{ memberId, markdown }` | `{}` — 다음 SessionStart부터 반영 |
| `approval.respond` | `{ pendingId, behavior: 'allow'\|'deny', updatedInput?, alwaysThisSession?: boolean }` | `{}` |
| `question.respond` | `{ pendingId, answers: Record<string,string> }` | `{}` |
| `daemon.shutdown` | `{}` | `{}` |

에러 코드: `-32001` 인증 실패, `-32002` 없는 멤버/팀, `-32003` 상태 오류(예: 이미 종료), `-32004` 직급 규칙 위반(M4), `-32602` 파라미터.

## 데몬 → 클라이언트 (알림)

| method | params |
|---|---|
| `event` | `OfficeEvent` — `{ seq, ts, teamId, memberId, kind, detail, ref }` (영속, 전역 단조 seq) |
| `snapshot` | `{ seq, teams, members, pending, tasks }` — `hello` 응답에 포함되지만 데몬이 필요 시 재전송 가능 |
| `term` | `{ memberId, data }` — attach한 클라이언트에만, 비영속 |
| `member.status` | `{ memberId, status, derived }` — 파생 상태(`waiting_reports` 등, M4) |
| `daemon.notice` | `{ level, message }` — 예: hook 보류 타임아웃, 알 수 없는 멤버 토큰 |

## 오피스 이벤트

`kind`: `thinking | text | reading | editing | running | waiting_approval | asking | delegating | reporting | idle | error`
`detail`: `{ tool?, path?, cmd?, summary?, text? }` — `text`는 턴 단위 코얼레스(Stop의 last_assistant_message)
`ref`: `{ approvalId?, questionId?, taskId? }`

## 재접속 규칙

1. 클라이언트는 마지막으로 적용한 `seq`를 기억한다.
2. `hello{since}` → 스냅샷(`snapshot.seq` 포함) → `seq > snapshot.seq`인 이벤트만 적용(replay 이중 적용 방지).
3. `term`은 replay하지 않는다. 터미널 탭은 `member.attach`로 현재 화면을 다시 받는다.
