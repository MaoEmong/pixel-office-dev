# T06 — Store (SQLite 영속 저장소)

- 날짜: 2026-09-14
- 마일스톤: M1
- 관련 설계: 01-설계문서.md §구성 요소 1(SQLite, 델타·영속 분리, 대기 정책, interrupt/fire 후처리, 데몬 재시작 복구), §2 오피스 이벤트 스키마, §4 팀·직급 모델
- 커밋: (미커밋 — 이 태스크는 커밋하지 않음)

## 목표

데몬이 팀·멤버·이벤트·pending·tasks 를 `node:sqlite`(Node 24 내장, D-08) 에 동기 API 로 읽고 쓸 수 있다. `hello{since}` 재접속용 스냅샷과 seq 기반 replay, `events.query` 과거 페이징, interrupt/fire/error 후처리(`abortTasksFor`, `expireAllForMember`), 보고 버퍼링 판정(`openTasksIssuedBy`)이 저장소 한 계층에서 끝난다. 데몬을 껐다 켜도 `seq` 가 되돌아가지 않는다.

## 한 것

- `dev/daemon/src/store/types.ts` — 공개 타입. `OfficeEventKind` = `thinking|text|reading|editing|running|waiting_approval|asking|delegating|reporting|idle|error`(설계문서 §2 표와 동일). `Team`, `Member`, `OfficeEvent`, `Pending`, `Task`, `Snapshot` 과 Create/Update/Query 입력 타입. `USER_ACTOR = 'user'`(tasks.from_member 의 사용자 값).
- `dev/daemon/src/store/schema.ts` — `SCHEMA_VERSION = 1`, `schema_version` 테이블 + `teams / members / events / pending / tasks` DDL(모두 `IF NOT EXISTS`). 열거값은 CHECK 제약. `members.member_token UNIQUE`. FK: `members.team_id → teams(id) ON DELETE CASCADE`, `pending.member_id → members(id) ON DELETE CASCADE`, `tasks.team_id → teams(id) ON DELETE CASCADE`. `events` 는 이력이라 FK 없음(멤버·팀 삭제 후에도 남고 `seq INTEGER PRIMARY KEY AUTOINCREMENT` 로 재사용 금지). `tasks.from_member/to_member` 는 `'user'` 가 올 수 있어 FK 없음.
- `dev/daemon/src/store/Store.ts` — `DatabaseSync` 래퍼. 생성자 `new Store(dbPath = DEFAULT_DB_PATH)`; 기본 `${config.dataDir}/pixel-office.db`(폴더 자동 생성), 테스트는 `':memory:'`. 파일 DB 는 `journal_mode = WAL`, `enableForeignKeyConstraints: true`, `synchronous = NORMAL`. 모듈 로드 시 `node:sqlite` ExperimentalWarning 필터 설치(아래 "발견한 함정" 참고).
- `dev/daemon/test/store/Store.test.ts` — `node:test`, 인메모리 7건 + 임시 파일 close/reopen 1건.

### 공개 API (전부 동기)

| 영역 | 메서드 |
|---|---|
| teams | `createTeam(input)`, `getTeam(id)`, `listTeams()`, `updateTeam(id, partial)`, `deleteTeam(id)` → members·tasks·(members 의) pending cascade, events 는 남음 |
| members | `createMember(input)`(token 미지정 시 48자 hex 자동), `getMember(id)`, `getMemberByToken(token)`, `listMembers(teamId?)`, `updateMember(id, partial)`(updated_at 갱신), `deleteMember(id)` → pending cascade, tasks·events 는 남음 |
| events | `appendEvent({teamId, memberId, kind, detail?, ref?, ts?})` → seq 포함 전체 행, `eventsSince(seq, limit=1000)`(seq 초과, 오름차순), `eventsQuery({teamId?, memberId?, beforeSeq?, limit=200})`(beforeSeq 미만 중 최신 limit 건을 **오름차순**으로; 다음 페이지는 첫 건 seq 를 beforeSeq 로), `lastSeq()`(`sqlite_sequence` 기준 — 삭제해도 안 줄어듦), `pruneEvents({keepPerTeam=50000})` → 삭제 건수 |
| pending | `createPending({memberId, type, payload})`(id 접두 `a_`/`q_`), `getPending(id)`, `listOpenPending(memberId?)`, `answerPending(id, answer)`(open 일 때만 answered), `expirePending(id)`(open 일 때만 expired), `expireAllForMember(memberId)` → 만료된 행들 |
| tasks | `createTask({teamId, fromMember, toMember, instruction, status='queued'})`, `getTask(id)`, `updateTask(id, partial)`, `listTasks({teamId?, toMember?, fromMember?, status?: TaskStatus\|TaskStatus[]})`, `openTasksIssuedBy(memberId)`(from=memberId & queued/assigned), `abortTasksFor(memberId)`(to=memberId & queued/assigned → aborted, report_status='aborted') → 변경된 행들 |
| 기타 | `snapshot()` → `{ seq: lastSeq(), teams, members, pending(open), tasks(queued/assigned) }`, `transaction(fn)`, `close()`, `path` |

## 검증

```
$ cd dev/daemon && npx tsx --test test/store/*.test.ts
▶ Store (in-memory)
  ✔ team + members: create / get / list / update / token lookup / delete cascade (5.7104ms)
  ✔ deleteMember cascades pending but keeps tasks/events (2.0447ms)
  ✔ events: append returns seq, eventsSince / eventsQuery paging (3.6293ms)
  ✔ pending lifecycle: open → answered / expired, expireAllForMember (2.1912ms)
  ✔ tasks lifecycle, listTasks filters, openTasksIssuedBy, abortTasksFor (2.33ms)
  ✔ snapshot shape: seq + teams + members + open pending + open tasks (2.6497ms)
  ✔ pruneEvents keeps newest keepPerTeam per team; seq does not reset (2.2185ms)
✔ Store (in-memory) (21.8792ms)
▶ Store (file, WAL, reopen)
  ✔ seq is monotonic across close/reopen and after deletes (19.0709ms)
✔ Store (file, WAL, reopen) (19.2035ms)
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

파일 DB 테스트는 `os.tmpdir()` 아래 `nested/pixel-office.db`(중첩 폴더 자동 생성 확인)에 팀+멤버 2명, 이벤트 3건(seq 1,2,3) → 이벤트 전부 prune → close → 재오픈 → `lastSeq()===3`, 다음 `appendEvent` 가 seq 4. 즉 재시작·삭제 후에도 seq 가 1 로 돌아가지 않는다(PROTOCOL.md 재접속 규칙의 전제).

```
$ cd dev/daemon && npm run typecheck
src/screen/tuiMap.ts(103,66): error TS2367: This comparison appears to be unintentional because the types
  '"login-menu" | "onboarding-enter" | "security-notes" | "trust-folder-claude" | "trust-folder-codex"' and '"none"' have no overlap.
```

`src/store/`·`test/store/` 에는 에러 0건. 위 1건은 T06 범위 밖(`src/screen/`, 다른 태스크 파일)이라 손대지 않음 — "남은 것" 참고.

ExperimentalWarning 필터 확인(임시 스크립트: Store 를 import 해 `:memory:` DB 를 열고 닫은 뒤 다른 경고 두 개를 emit):

```
$ node -e "import('node:sqlite')"                       # 필터 없음(기준)
(node:27296) ExperimentalWarning: SQLite is an experimental feature and might change at any time

$ npx tsx warncheck.mts                                 # Store import 후
(node:24760) ExperimentalWarning: other experimental thing
(node:24760) DeprecationWarning: something deprecated
done; listenerCount(warning)=1
```

SQLite 경고만 사라지고 다른 ExperimentalWarning·DeprecationWarning 은 그대로 Node 기본 출력으로 나온다.

## 발견한 함정

1. **같은 ms 에 만든 행의 정렬이 무작위였다.** `listMembers`/`listOpenPending`/`listTeams` 를 `ORDER BY created_at, id` 로 짰더니 `created_at`(ISO, ms 해상도)이 같은 두 행이 랜덤 UUID id 순으로 나와 테스트 3건이 간헐적으로 실패(멤버 [팀장, 팀원] 순서가 뒤집힘). `ORDER BY rowid` 로 교체 — TEXT PRIMARY KEY 테이블도 암묵적 rowid 가 있고 삽입순이 보장된다. 이후 8/8 안정.
2. **`node:sqlite` ExperimentalWarning 은 "필터만 추가"로는 못 막는다.** Node 는 기본 경고 프린터를 `process.on('warning')` 리스너로 등록해 두므로, 리스너를 하나 더 얹어 무시해도 기본 프린터가 그대로 찍는다. 그리고 `emitWarning` 은 `nextTick` 으로 이벤트를 내므로, ESM 호이스팅으로 `node:sqlite` 가 먼저 로드돼도 Store 모듈 본문에서 동기적으로 필터를 걸면 늦지 않다. 구현: 기존 리스너 목록을 잡아 두고(`process.listeners('warning')`) 그것들을 떼어낸 뒤, "SQLite ExperimentalWarning 이면 무시, 아니면 원래 리스너들에 그대로 전달"하는 리스너 하나로 감싼다. `removeAllListeners` 는 쓰지 않고, 모듈이 두 번 평가돼도 `Symbol.for` 플래그로 한 번만 설치. 이후 추가되는 리스너는 영향 없음.
3. Windows 에서 동적 `import('D:/...')` 는 `ERR_UNSUPPORTED_ESM_URL_SCHEME` — 검증 스크립트는 `file:///D:/...` 로.

## 결정

- 정렬 기준 = rowid(삽입순). `created_at` 은 표시용으로만.
- `deleteTeam`/`deleteMember` 는 events 를 지우지 않는다(이력·seq 연속성). tasks 는 팀 삭제 시만 cascade, 멤버 삭제 시엔 남긴다(보고 이력).
- `answerPending`/`expirePending` 은 `status='open'` 일 때만 바꾼다(늦게 온 응답이 expired 를 덮어쓰지 않도록). 이미 닫힌 행은 현재 상태를 그대로 돌려준다.
- `abortTasksFor` 는 `status='aborted'` 와 함께 `report_status='aborted'` 도 채운다(상위에 `[REPORTS ... status=aborted]` 를 보낼 때 그대로 쓰기 위해).
- 새 D-## 없음(D-08 범위 내 구현).

## 남은 것

- `src/screen/tuiMap.ts:103` 의 TS2367 은 T06 밖 파일이라 그대로 둠. 해당 태스크(T05 화면/TUI 맵)에서 `d.kind === 'none'` 비교를 제거하거나 `DIALOG_KINDS` 타입을 넓혀야 `npm run typecheck` 가 전체 통과한다.
- 마이그레이션 스텝 없음(`schema_version` 1 만). 버전 올릴 때 `Store.migrate()` 에 단계 추가.
- `pruneEvents` 호출 주기(데몬 기동 시 1회 + 주기)는 T07 데몬 본체에서.
