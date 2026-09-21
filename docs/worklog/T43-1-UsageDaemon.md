# T43-1 — 사용량 표시 (데몬)

- 날짜: 2026-09-21
- 마일스톤: M7
- 설계: `docs/design/사용량-표시.md` (결정 D-45). 실측 근거: `docs/worklog/T43-0-UsageSpike.md`, 원자료 `dev/spike-1/out/`
- 범위: `dev/daemon/**` 만. 앱(T43-2)은 병렬 진행, 실기(T43-3)는 뒤에.

## 목표

앱이 보여 줄 세 가지를 데몬이 모아서 내보낸다.

1. **엔진(Claude/Codex)별 주간 남은 한도** — 안 붙어 있으면 "연결 안 됨" + 이유
2. **캐릭터별 누적 토큰·비용**
3. **캐릭터별 컨텍스트 양**

전제는 D-45 다: **자격 증명 파일을 읽지 않고 벤더 API 를 직접 부르지 않는다.** CLI 가 스스로 내주는 것만 쓴다 —
statusLine 페이로드, CLI 가 쓰는 기록 파일, 무해한 하위 명령(`auth status`/`login status`). 이메일은 저장도 표시도
하지 않고, 멤버 세션에 슬래시 명령을 밀어 넣지 않는다.

## 한 것

### 1. 순수 파서 + 꼬리 읽기 (`src/usage/`)

파일·네트워크를 건드리지 않는 함수로 떼어 놓아 실측 캡처만으로 단위 테스트가 된다.

| 함수 | 읽는 것 | 함정 |
|---|---|---|
| `parseClaudeStatusLine(payload)` | `rate_limits.{seven_day,five_hour}` · `context_window` · `cost` | **첫 API 호출 전·`--resume` 직후엔 `rate_limits` 키 자체가 없다** → weekly/session null(이전 값 유지) |
| `parseClaudeCostState(tail)` | 마지막 `type:"cost-state"` 줄의 `modelUsage` 합산 + `totalCostUSD` | assistant 줄의 `usage` 를 직접 더하면 **이중 계산**된다(같은 응답이 여러 줄) |
| `parseCodexTokenCounts(tail)` | `limit_id==="codex"` ∧ `primary!=null` 인 **마지막** `token_count` | `limit_id:"premium"` + `info:null` + `primary:null` 인 **빈 이벤트**가 앞뒤로 섞인다 |
| `parseClaudeAuthStatus(stdout)` | `loggedIn` · `subscriptionType` **뿐** | 같은 JSON 에 `email`·`orgId`·`orgName` 이 있지만 **읽지 않는다**(D-45 ②) |
| `parseCodexLoginStatus(stdout, exit)` | `Logged in` / `Not logged in` / 종료 코드 | 임시 `CODEX_HOME` 이면 stderr 에 PATH 별칭 경고가 섞인다(판정에는 영향 없음) |

- 단위 정규화는 `types.ts` 한 곳: **`usedPercent`(쓴 비율 0~100)** + **ISO 8601 UTC**. 유닉스 초는 여기서 바꾼다.
- **필드별 방어**: 값 하나가 없거나 이름이 바뀌면 그 값만 `null` 이고 나머지는 계속 돈다.
- `tail.ts` — 비동기 · 최대 64KB · **잘린 첫 줄 폐기** · 실패하면 `''`(호출자는 이전 값 유지).

### 2. `UsageTracker` (`src/usage/UsageTracker.ts`)

메모리 상태 + DB 영속 + **변화 감지**. 입력 세 갈래(statusLine · 턴 종료 꼬리 · 연결 폴링)를 한 곳에서 합친다.

- **바뀔 때만 emit.** 값이 같으면 아무 일도 하지 않는다.
- 값이 같아도 마지막 확인이 `refreshMs`(60초)를 넘겼으면 **`updatedAt` 만 올려 한 번 민다** — 앱이 "N분 전 기준"
  이라고 말하는데 방금 다시 확인한 값을 10분 전 것처럼 보여 주면 거짓말이 된다. 상한이 있어 분당 한 번을 넘지 않는다.
- **연결 폴링은 `updatedAt` 을 건드리지 않는다**(그건 "한도 숫자를 마지막으로 확인한 시각"이다).
- **요금제는 덮어쓰지 않는다** — Codex 요금제는 `login status` 가 아니라 rollout 의 `plan_type` 이 준다.
- `statusLineText()` → `컨텍스트 37% · 주간 45% 남음`(모르는 칸은 뺀다, 둘 다 모르면 빈 문자열).

### 3. 연결 폴링 (`src/usage/connection.ts`)

`claude auth status` / `codex login status` 를 **5초 타임아웃**으로. 실행 파일은 `config.ts` 의 해석기를 그대로 쓴다
(T41 `resolveClaudeExeDetailed` · `resolveCodexExe`). 스폰할 때 `CLAUDE_CODE*`·`CLAUDE_CONFIG_DIR` 을 지운다
(`pty/env.ts` 의 `stripDaemonEnv` 를 빼내 공유). 판정: 못 찾음 `not-installed` / 로그아웃 `logged-out` /
오류·타임아웃·모양 변경 `unknown`.

### 4. statusLine 경로

- `src/hooks/statusline.js` — hook.js 와 같은 방식(stdin JSON → POST → 응답을 stdout). **실패 규약만 다르다**:
  빈 줄 + 즉시 exit 0, 연결 1.5초·전체 3초 상한. 이 스크립트는 화면을 다시 그릴 때마다 돌기 때문에 붙들면
  상태줄이 아니라 TUI 전체가 멈춘 것처럼 보인다.
- `HookReceiver` 에 `POST /status/<memberToken>` → `status-line` 이벤트, 응답 `text/plain` 한 줄. **보류 없음**,
  **모르는 토큰은 404**(hook 과 달리 pass-through 로 감쌀 이유가 없고 상태줄에 오류 본문이 새면 안 된다).
- `hookSettings.buildClaudeSessionSettings(hook, port, statusLineScriptPath?)` → `statusLine{type:'command', padding:0}`.
  **Codex 에는 statusLine 이 없어 주입하지 않는다.**

### 5. 턴 종료 연동

어댑터가 `Stop`(과 Codex `Interrupt`)에서 `turnEnd{memberId, transcriptPath}` 를 낸다 — hook 페이로드에는 토큰 숫자가
하나도 없으므로(T43-0 Q4) 이건 "지금 값을 다시 읽어라" 는 신호다. Office 가 받아 꼬리를 읽는다. 화면 idle 폴백
(D-25, `Stop` 없이 끝난 턴)에서도 같은 길을 탄다. 경로는 **모든 hook 페이로드와 statusLine 이 주므로** 런타임에
기억해 두고(`rt.transcriptPath`) 조립하지 않는다.

### 6. 스키마 v3 · 와이어

- `engine_usage(engine PK, json, updated_at)` — **남긴다**(마지막으로 본 한도 표시용).
- `member_usage(member_id PK → members(id) ON DELETE CASCADE, json, updated_at)` — 멤버와 함께 사라진다.
  부서 삭제·팀 삭제 경로가 그대로 탄다(+ Office 가 메모리 상태도 같이 비운다).
- `snapshot.usage{engines[], members[]}` + 알림 `usage.engine`/`usage.member`(비영속·seq 없음·바뀔 때만).
  모양은 `PROTOCOL.md` "사용량" 절에 그대로 적었다(reasons enum · 신선도 · "Claude 한도는 첫 턴 뒤에 온다").
- 콘솔 `usage` 명령 + `format.ts`(`formatEngineUsage`/`formatMemberUsage`/`formatTokens`/`usageLines`).

### 7. 정리 (T42/D-46)

`createDepartment` 의 `daemon.notice{warn}` **"부장 엔진이 codex 입니다 — v1 권장은 claude" 를 지웠다.**
T42 실기에서 Codex 부장이 `create_team`·`delegate`·`report`·`ask_user`·`reply` 를 전부 통과해 근거가 사라졌다.
테스트는 이제 **경고가 나오지 않는 것**을 지킨다. PROTOCOL 문장도 고쳤다.

## 검증

```
$ npx tsc --noEmit
(출력 없음)

$ npm test
ℹ tests 647
ℹ suites 97
ℹ pass 640
ℹ fail 0
ℹ skipped 7        (PIXEL_IT=1 통합 테스트)
ℹ duration_ms 37797
```

기준선은 532/525/7 이었다 → **+115 테스트**. 새로 추가한 것:

| 파일 | 건수 | 보는 것 |
|---|---|---|
| `test/usage/parse.test.ts` | 26 | 실측 페이로드 3종(턴 후·첫 턴 전·resume), 빈 codex 이벤트 섞임, 필드 이름 변경 방어, **이메일 없음** |
| `test/usage/tail.test.ts` | 7 | 64KB 경계에 이벤트가 걸린 경우, 없는 파일·폴더·빈 파일 |
| `test/usage/UsageTracker.test.ts` | 21 | 변화 감지(같은 값 침묵 / 60초 뒤 신선도 / 값 변경 즉시), 영속·재기동, 멤버 삭제 |
| `test/usage/connection.test.ts` | 14 | 판정 표 4종, exe 해석, 환경변수 정리, **이메일 없음** |
| `test/hooks/StatusLine.test.ts` | 12 | `/status` 경로(404 포함) + statusline.js 실제 자식 프로세스 왕복(실패 경로) |
| `test/store/MigrationV3.test.ts` | 8 | v2 DB 파일에서 열기, 기존 행 불변, cascade 두 경로, 멱등, v1 → v3 |
| `test/office/Usage.test.ts` | 11 | 스냅샷·알림·턴 종료·부서 삭제·statusLine 주입 여부·**이메일 없음** |
| `test/cli/usageFormat.test.ts` | 12 | 콘솔 출력 5종 + 단위 포맷 |
| `test/pty/hookSettings.test.ts` | +3 | statusLine 주입 유무 |

**짧은 실기 자체 점검**(격리 `PIXEL_DATA_DIR` + 포트 7520~7522, 끝나고 내림 — 7420~7422 는 건드리지 않았다):

```
[daemon] usage     : 연결 확인 기동 시 한 번만 (PIXEL_USAGE_POLL_SEC)
po> usage
claude  연결됨(max)  한도 미확인 — 첫 작업 후 표시
codex   연결됨(요금제 ?)  한도 미확인 — 첫 작업 후 표시
(멤버 사용량 없음 — 첫 턴 뒤에 들어옵니다)

# PIXEL_CODEX_EXE 를 없는 경로로 주고 재기동(T43-3 이 쓸 길)
po> usage
claude  연결됨(max)  한도 미확인 — 첫 작업 후 표시
codex   연결 안 됨(설치 안 됨)

# DB
version 3
tables: departments, engine_usage, events, member_usage, members, pending, schema_version, sqlite_sequence, tasks, teams
engine_usage: {"engine":"claude","connected":true,"plan":"max","weekly":null,…,"reason":null}
              {"engine":"codex","connected":false,"plan":null,…,"reason":"not-installed"}
```

행에 이메일·orgId 가 없다. 멤버가 한 번도 안 돌았으니 한도가 `null` 인 것도 설계대로다.

## 함정

1. **`Office.start()` 에서 연결 폴링을 켜면 안 된다.** 처음엔 거기서 켰는데, Office 단위 테스트 40여 개가 전부
   `office.start()` 를 부르므로 **테스트마다 진짜 `claude.exe`/`codex.exe` 를 두 번씩 띄우게 된다.** 폴링은
   `index.ts`(실제 데몬 진입점)가 켜고 `Office.shutdown()` 이 끈다 — Office 는 멤버 CLI 말고 다른 프로세스를
   스스로 띄우지 않는다는 규칙으로 정리했다.
2. **`updatedAt` 을 변화 감지에서 빼야 한다.** 그냥 비교하면 statusLine 이 화면을 다시 그릴 때마다(턴 하나에 5~6번)
   알림이 나간다. 반대로 완전히 빼 버리면 값이 안 변하는 동안 앱의 "N분 전" 이 영영 늙는다. 그래서 "값은 같지만
   60초 지났으면 한 번" 규칙을 뒀다.
3. **꼬리 64KB 의 첫 줄은 버려야 한다.** 안 버리면 반쪽 JSON 이 파서에 들어간다(파서가 삼키긴 하지만, 깨진 UTF-8
   선두 바이트까지 같이 사라지는 게 깔끔하다). 경계에 `token_count` 가 걸린 경우를 테스트로 박아 뒀다.
4. **`member_usage` FK.** v1 → v2 마이그레이션이 `ALTER TABLE members RENAME` 으로 다른 테이블의 `REFERENCES` 를
   고쳐 쓰는 사고가 있었다(T39). v3 테이블은 v1 DB 에는 존재하지 않고 `SCHEMA_SQL` 에서 새로 만들어지므로 같은 함정에
   걸리지 않는다 — v1 → v3 을 한 번에 태우는 테스트로 확인했다.
5. **`resetsAt` 를 눈으로 확인할 것.** `1790132400` 은 `2026-09-23T03:00:00Z` 이고 실측 화면의 `Resets Sep 23, 12pm
   (Asia/Seoul)` 과 같다. 처음에 기댓값을 눈대중으로 적었다가 테스트가 잡아냈다.
6. **`statusline.js` 는 절대 붙들면 안 된다.** hook.js 는 사용자 답을 몇 시간이고 기다리지만 이쪽은 정반대다.
   연결 1.5초 + 전체 3초 상한을 둘 다 걸었다.

## 결정

- **상태 줄 문구는 `컨텍스트 37% · 주간 45% 남음`**(설계 그대로). 모르는 칸은 뺀다 — 사용자 전역 statusLine 을
  덮어쓰는 자리라 사람이 봐도 이상하지 않아야 한다.
- **`unknown` 은 "물어봤는데 대답을 못 들었다"** 이지 "한도를 모른다" 가 아니다. 값 없음(`weekly:null`)과
  연결 안 됨(`connected:false`)은 끝까지 다른 상태로 유지했다(T43-0 열린 위험 4).
- **Codex `Interrupt` 도 턴 종료로 친다.** rollout 에 `token_count` 가 적혔으면 반영되고, 없으면 값이 그대로라
  조용하다 — 손해가 없다.
- **`parseCodexTokenCounts` 의 `info` 폴백**: 고른 이벤트(`limit_id==='codex'` ∧ `primary!=null`)의 `info` 가
  비어 있으면 **`info` 가 있는 마지막 이벤트**로 떨어진다. 설계 문장은 "같은 이벤트" 지만, 정상 캡처에서는 같은
  이벤트이고 예외 상황에서 값을 통째로 잃는 것보다 낫다. (설계에서 벗어난 유일한 지점 — 넓히는 쪽이다.)
- **연결 폴링 시작 위치**는 위 함정 1 대로 `index.ts`.

## 남은 것

- **T43-2(앱)와의 와이어 대조** — 필드 이름(`cacheCreate`, `session`, `reason`, ISO 시각)을 앱 모델과 맞춰 볼 것.
- **T43-3 실기**: Claude 1 + Codex 1 로 한 턴씩 돌려 실제 숫자가 들어오는지. `PIXEL_CODEX_EXE` 미설치 표시는 이미
  자체 점검에서 확인했고, **실제 한도 숫자가 statusLine/rollout 으로 들어오는 것은 아직 실기로 못 봤다**(단위
  테스트는 실측 캡처로 통과).
- Codex 다른 요금제의 `secondary`(5시간) 실물 — 여전히 미확인. 코드는 있으면 싣고 없으면 `null`.
- 컴팩션(`PreCompact`) 이후 컨텍스트 값이 어떻게 튀는지.
- 서브에이전트(`isSidechain`)를 멤버 집계에 넣을지 — 지금은 `cost-state` 가 주는 대로 **포함**된다(haiku 행이 합산에
  들어간다). 사용자가 보는 "그 팀원이 쓴 양" 으로는 맞아 보이지만 결정으로 못 박지는 않았다.
- 범위 밖으로 남긴 것: 숨은 유틸리티 세션(턴 없이 한도 갱신) · 모델별 주간 한도 · 기간별 그래프 · Codex 비용 추정.
