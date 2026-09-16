# T26b — 데몬 쪽 멤버 지시문: 기본 템플릿 · 런타임 프리앰블 · 주입 확인

- 날짜: 2026-09-16
- 마일스톤: M4
- 관련 설계: 01-설계문서.md §멤버 지시문 주입("`SessionStart` hook 의 `additionalContext` 반환을 1순위로 — startup/resume/clear/compact 모두에서 다시 주입되므로 compaction 유실이 없다", "비어 있으면 데몬 기본 템플릿", "프로젝트의 CLAUDE.md/AGENTS.md 는 건드리지 않는다") · §4 팀·직급 모델("팀장 지시문 기본 템플릿에 들어가는 것") · §전제 7 · §성공 기준 7-2, 04-결정기록.md **D-30**(이 태스크) · D-05 · D-22, `dev/daemon/PROTOCOL.md` §"멤버 지시문 주입 (T26b)", worklog T26a(앱 지시문 탭·템플릿 원문) · T25(hire 가 쓰는 `# 역할:` 줄, 도구 이름 줄) · T17(SessionStart additionalContext 경로) · T20(Codex 어댑터)
- 커밋: (미커밋 — 상위에서)

## 목표

멤버가 **자기가 누구인지 모른 채 일하는 상황을 없앤다.** 지시문을 한 줄도 안 쓴 멤버에게는 직급에 맞는 기본 지시문이 자동으로 가고,
지시문을 쓴 멤버에게도 "너는 어느 팀의 누구고, 팀에 누가 있고, 어떤 도구를 쓸 수 있다" 는 런타임 머리말이 **늘** 같이 간다.
`SessionStart`(startup/resume/clear/compact) 마다 다시 주입되므로 compaction·`/clear` 로 잃지 않는다. 앱(T26a)이 버튼으로 넣어 주는
템플릿과 **같은 문장**을 쓰고, 무엇이 주입될지는 `member.instructions.effective` / 콘솔 `instr effective` 로 미리 볼 수 있다.

## 한 것

### 템플릿 — `src/office/instructions/templates.ts` (신규)

- `leaderTemplate(ctx)` / `memberTemplate(ctx)` — 본문은 T26a 앱 템플릿(`leaderInstructionTemplate` / `memberInstructionTemplate`)과
  **같은 문장**. 데몬에만 더 있는 것 3가지:
  1. **동적 머리말** `# <이름> — <팀장|팀원> @ <팀>` + `- 작업 폴더:` · `- 엔진:` (+ `- 역할:` · 팀원이면 `- 팀장:`).
  2. **팀 설정에서 온 숫자** — 팀장 템플릿 4번이 "팀원 상한은 팀 설정을 따른다" → `팀원 상한은 4명(팀장 포함), 쓸 수 있는 엔진은 claude, codex.`
  3. **도구 이름 줄**을 팀원 템플릿에도 붙였다(앱 팀원 템플릿에는 없다 — 아래 "남은 것"). `toolsLine(rank)` 하나가 만든다:
     팀장 5개(`mcp__team__hire, …, mcp__team__ask_user`) / 팀원 2개(`mcp__team__report, mcp__team__ask_user`) + `(도구 목록에 없으면 ToolSearch로 찾는다)`.
     이름은 `LEADER_ONLY_TOOLS`/`EVERYONE_TOOLS`/`TEAM_MCP_NAME`(T25)에서 조립하므로 도구가 늘면 자동으로 따라온다.
- `defaultInstructions(member, team, {role?, leaderName?})` — 직급으로 템플릿을 고른다. `contextOf` · `instructionHeader` · `RANK_LABEL` · `toolNames` 도 export.
- 팀원 템플릿의 `[TASK#n from <팀장>]` 은 팀장 이름을 알면 실제 이름으로 바뀐다(`[TASK#n from 반장(팀장)]` — `taskMessage`(T25)가 실제로 넣는 문자열과 같다).

### 세션 컨텍스트 — `src/office/instructions/context.ts` (신규)

- `sessionPreamble(input)` — 사용자 지시문이 있든 없든 **늘 앞에 붙는** 5~6줄:
  정체(`[사무실] 너는 픽셀 오피스 팀 "alpha" 의 팀원 이음(엔진 claude)이다.`) + 작업 폴더 + **로스터**(`- 팀장: 반장(claude)` /
  `- 팀원: 이음(claude), 나루(codex, 역할 문서)`) + 직급별 도구 이름 줄 + "프로젝트의 CLAUDE.md/AGENTS.md 위에 얹히는 개인 규칙" 한 줄.
- `buildSessionContext({team, member, roster, instructions})` — `프리앰블 + \n\n + 유효 지시문`. `rosterLines` 도 export.
- **길이 상한** `MAX_CONTEXT_CHARS = 3000`(한국어 ≒ 글자당 1토큰 → ~2500토큰 예산). 넘으면 **사용자 본문만** 뒤에서 자르고
  `TRUNCATE_MARK`(`[… 지시문이 길어 여기서 잘렸습니다. 전문은 이 멤버의 INSTRUCTIONS.md 에 있습니다.]`)를 붙인다 — 프리앰블은 통째로 남는다
  (정체·로스터·도구 이름을 잃는 것이 제일 나쁘다). 본문 최소 200자는 보장.

### Office — `src/office/Office.ts` (작은 교체만, T28 과 병행이라 구역을 안 건드렸다)

- 어댑터 의존성 한 줄: `getInstructions: (id) => this.buildSessionContext(id) || undefined` (전에는 파일 본문 그대로).
- `effectiveInstructions(memberId)` — 사용자 파일에 **본문이 있으면** 그 파일, 없으면 `defaultInstructions(...)`.
  `hire` 가 쓴 `# 역할: <role>` **한 줄뿐인 파일은 "본문 없음"** 으로 본다(새 헬퍼 `bodyBelowRole`, export) — 그건 사용자 지시문이 아니라
  `roleOf` 가 되읽는 메타데이터라 기본 템플릿을 덮을 이유가 없다. 대신 그 역할이 템플릿 머리말 `- 역할: …` 에 실린다(D-30 ②).
- `buildSessionContext(memberId)` — 살아 있는 멤버로 로스터를 만들고(각자 지시문 첫 줄에서 역할을 읽는다) 위 두 조각을 합친다.
  hook 경로에서 불리므로 **없는 멤버에도 throw 하지 않고 `""`**.
- `getInstructions` 는 그대로(사용자 파일만) — 앱 편집기가 보는 값이다. 주석만 보강.

### RPC · 콘솔 · PROTOCOL

- `src/office/types.ts` `OfficeApi` 에 `buildSessionContext(memberId)` 추가.
- `src/rpc/RpcServer.ts`: **`member.instructions.effective {memberId}` → `{markdown}`** (읽기 전용, 부작용 없음). `get`/`set` 은 그대로.
- `src/cli/index.ts`: `instr effective <member>` — 글자 수와 함께 주입될 전문을 찍는다. `instr get` 설명에 "(사용자 파일만)" 추가, 사용법 문구 갱신.
- `PROTOCOL.md`: RPC 표에 `effective` 행 + `get` 행에 "사용자 파일만" 명시, 새 절 **"## 멤버 지시문 주입 (T26b)"**
  (유효 지시문 규칙 · `# 역할:` 예외 · 기본 템플릿을 저장하지 않는 이유 · 프리앰블 예시 · 길이 상한 · 엔진 무관).

### 지시문 파일이 생기는 경로(설계대로, 이번에 문서화만)

`hire(instructions?)`(T25) 와 `member.clockIn(instructions?)` 는 준 값을 그대로 `INSTRUCTIONS.md` 에 쓴다(`spawnNewMember` 의
`if (input.instructions !== undefined) setInstructions(...)`). **안 주면 아무것도 쓰지 않는다** — 기본값은 저장하지 않고 주입할 때마다
계산하므로, 템플릿 문장을 고치면 지시문을 따로 쓰지 않은 멤버 전원에게 다음 SessionStart 부터 반영된다(D-30 ③).

## 검증

### 타입체크 + 전체 스위트

```
$ cd dev/daemon && npx tsc --noEmit
(출력 없음)

$ npx tsx --test "test/**/*.test.ts"
ℹ tests 399
ℹ suites 57
ℹ pass 393
ℹ fail 0
ℹ skipped 6      (PIXEL_IT 미설정 통합 5건 + office preview 1건)
ℹ duration_ms 35155.9511
```

T26b 시작 390건 → **399건**(신규 9). `test/office/Instructions.test.ts`:

```
▶ 멤버 지시문 템플릿·주입 (T26b)
  ✔ 기본값은 직급이 고른다: 팀장은 hire/delegate/dismiss/report/ask_user, 팀원은 report/ask_user
  ✔ defaultInstructions(member, team): rank 로 템플릿을 고르고 role/leaderName 을 머리말에 싣는다
  ✔ 프리앰블: 사용자 파일이 있어도 정체·로스터·도구 이름이 늘 앞에 붙는다
  ✔ 로스터는 살아 있는 멤버만 — 퇴근하면 다음 주입에서 빠진다
  ✔ 사용자 파일이 기본 템플릿을 이긴다 — 단 `# 역할:` 한 줄뿐인 파일(hire)은 아니다
  ✔ 긴 사용자 지시문은 본문만 잘리고 표식이 붙는다 — 프리앰블은 통째로 남는다
  ✔ SessionStart(startup|clear|compact|resume) 모두 같은 additionalContext 를 받는다 — compaction 유실 없음(D-05)
  ✔ instructions.set 뒤 SessionStart(clear) 는 새 텍스트를 주입한다 — 재시작 없이 다음 세션부터 반영
  ✔ member.instructions.get 은 사용자 파일만, member.instructions.effective 는 주입될 텍스트
ℹ tests 9  pass 9  fail 0
```

기존 테스트 2건은 **주입 텍스트가 바뀐 만큼** 단언을 옮겼다(동작 회귀 아님):
`test/office/Office.test.ts`("hook routes by member token…") 와 `test/office/CodexRouting.test.ts`("지시문 주입은 엔진과 무관하게 같다")가
이제 `office.buildSessionContext(m.id)` 와 비교하고, 그 텍스트가 사용자 본문으로 끝나는 것(+ Codex 는 `엔진 codex` 표기)을 같이 본다.
`test/rpc/RpcServer.test.ts` 는 가짜 Office 에 `buildSessionContext` 를 추가하고 `member.instructions.effective` 왕복 1건을 더 본다.

### 실기 (진짜 데몬 + 진짜 Claude 팀장·팀원, 13초)

임시 스크립트(확인 후 삭제)로 임시 dataDir·포트 3개, cwd = `dev/spike-0/sandbox`. `team.create`(팀장 '반장') → `member.clockIn`(팀원 '이음',
`instructions: "# 역할: 파일 작성\n"` = hire 와 같은 모양) → `member.instructions.effective` 두 번 → 팀장에게 한 줄 지시.

```
[IT] team=t_4f9348a2656a leader=m_b44c4a9c7947 (801ms)
[IT] leader idle (2254ms)
[IT:c] event #1 thinking {"text":"[TEAM] 팀원 변경: +이음(claude, 역할: 파일 작성)"}
[IT] worker idle (4326ms)

===== instr effective 반장 (1070자) =====
[사무실] 너는 픽셀 오피스 팀 "it26b" 의 팀장 반장(엔진 claude)이다.
- 작업 폴더: D:\myproject\pixel-office\dev\spike-0\sandbox
- 팀장: 반장(claude)
- 팀원: 이음(claude, 역할 파일 작성)
- 도구 이름: mcp__team__hire, mcp__team__dismiss, mcp__team__delegate, mcp__team__report, mcp__team__ask_user (도구 목록에 없으면 ToolSearch로 찾는다).
아래는 너의 지시문(INSTRUCTIONS.md)이다 — 프로젝트의 CLAUDE.md/AGENTS.md 위에 얹히는 개인 규칙이다.

# 반장 — 팀장 @ it26b
- 작업 폴더: D:\myproject\pixel-office\dev\spike-0\sandbox
- 엔진: claude

## 팀장 지시문
너는 이 팀의 팀장(오케스트레이터)이다. 사용자의 [TASK#n from user] 지시를 받으면:
1. 작업을 팀원 단위로 쪼갠다. 필요한 팀원이 없으면 team MCP의 hire(name, role, engine?, instructions?)로 만든다.
2. delegate(to_member, task)로 배정한다. 팀원마다 겹치지 않는 디렉토리/파일을 맡기고, 빌드·테스트 명령은 한 번에 한 명만.
3. 보고는 [REPORTS ...] 메시지로 온다. [ALL_REPORTS_IN]이 오면 취합해 report(taskId, summary, status)로 사용자에게 보고한다.
4. 일이 끝난 팀원은 dismiss(memberId)로 정리한다. 팀원 상한은 4명(팀장 포함), 쓸 수 있는 엔진은 claude, codex.
5. 사용자에게 물어볼 것은 ask_user(question, options?)로. 답은 [ANSWER q#n] 메시지로 온다.
도구 이름: mcp__team__hire, mcp__team__dismiss, mcp__team__delegate, mcp__team__report, mcp__team__ask_user (도구 목록에 없으면 ToolSearch로 찾는다).
=====

===== instr effective 이음 (739자) =====
[사무실] 너는 픽셀 오피스 팀 "it26b" 의 팀원 이음(엔진 claude)이다.
- 작업 폴더: D:\myproject\pixel-office\dev\spike-0\sandbox
- 팀장: 반장(claude)
- 팀원: 이음(claude, 역할 파일 작성)
- 도구 이름: mcp__team__report, mcp__team__ask_user (도구 목록에 없으면 ToolSearch로 찾는다).
아래는 너의 지시문(INSTRUCTIONS.md)이다 — 프로젝트의 CLAUDE.md/AGENTS.md 위에 얹히는 개인 규칙이다.

# 이음 — 팀원 @ it26b
- 작업 폴더: D:\myproject\pixel-office\dev\spike-0\sandbox
- 엔진: claude
- 역할: 파일 작성
- 팀장: 반장

## 팀원 지시문
너는 이 팀의 팀원이다. [TASK#n from 반장(팀장)] 지시를 받으면 그 범위만 작업한다.
- 맡은 디렉토리/파일 밖은 건드리지 않는다. 빌드·테스트는 지시받은 경우에만.
- 끝나면 report(taskId, summary, status: done|blocked)로 팀장에게 보고한다. 막히면 status: blocked로 이유를 적는다.
- 사용자에게 직접 물어야 하면 ask_user(question, options?)를 쓴다.
도구 이름: mcp__team__report, mcp__team__ask_user (도구 목록에 없으면 ToolSearch로 찾는다).
=====

[IT:c] event #4 thinking {"text":"[TASK#1 from user]\n너의 역할과 팀원 목록을 한 줄로 말해줘. 도구는 쓰지 마라."}
[IT:c] event #5 text {"text":"저는 픽셀 오피스 팀 it26b의 팀장 반장(claude)이고, 팀원은 파일 작성을 맡은 이음(claude) 한 명이에요."}
[IT] done (12785ms)
```

- 팀장에게 실제로 주입된 것: 프리앰블(정체·로스터·팀장용 도구 5개) + **기본 팀장 템플릿**(지시문 파일 없음, 1070자).
- 팀원에게 주입된 것: `# 역할: 파일 작성` 한 줄짜리 파일이 있어도 **기본 팀원 템플릿**이 그대로 나가고, 역할은 머리말 `- 역할: 파일 작성` 에
  들어갔다(D-30 ②). 도구 목록도 팀원용 2개로 좁혀졌다.
- 그리고 모델이 실제로 그 내용을 쓴다: 이름·팀 이름·직급·팀원 이름·역할을 한 줄로 그대로 답했다(설계 성공 기준 7-2 의 "첫 응답에 반영" 과 같은 확인).

## 발견한 함정

1. **`[TEAM] 팀원 변경` 알림이 먼저 턴을 하나 잡아먹는다.** 실기 1회차에서 `clockIn` 직후 지시를 넣었더니, 내가 기다린 `text` 이벤트는
   내 지시의 답이 아니라 **`[TEAM]` 알림에 대한 팀장의 답**("새 팀원 이음이 합류해서 …")이었다. 팀원을 출근시킨 뒤 지시를 보내는
   실기/통합 시나리오는 `[TEAM]` 턴의 `idle` 을 먼저 기다려야 한다(T25 함정 3 "`waitFor` 는 이미 받은 알림도 매치한다" 의 사촌 —
   이번엔 "내가 기다린 이벤트가 **다른 원인**으로 먼저 발생" 이다).
2. **`hire` 가 쓴 파일이 "비어 있지 않다" 는 이유로 기본 템플릿을 전부 막는다.** 스펙 그대로 "파일이 비어 있으면 템플릿" 을 구현하면
   팀장이 `hire` 한 팀원은 영원히 `# 역할: X` 한 줄만 받는다(= `report` 도구를 써야 한다는 걸 모른다 — T25 "남은 것" 의 그 문제가
   그대로 남는다). `# 역할:` 첫 줄은 본문이 아니라 메타데이터로 보도록 `bodyBelowRole` 을 두고 예외를 명시했다(D-30 ②).
3. **주입 텍스트가 바뀌면 다른 파일의 단언이 깨진다.** `Office.test.ts` 와 `CodexRouting.test.ts` 가 `sessionStartContext('be nice')`
   처럼 **파일 본문 그대로**를 기대하고 있었다. 프리앰블을 붙이는 변경은 어댑터 계약(무엇을 돌려주는가)이 아니라 **내용**의 변경이므로,
   두 곳은 `office.buildSessionContext(id)` 와 비교하도록 옮기고 "본문으로 끝난다" 를 따로 단언했다(내용을 두 번 쓰지 않으면서 회귀는 잡힌다).
4. **프리앰블을 붙인 만큼 예산을 다시 봐야 한다.** 실기 기준 프리앰블 300~400자 + 기본 템플릿 700자 ≒ 1070자라 3000자 상한에
   사용자 본문 2000자 이상이 남는다. 다만 팀원이 많아지면 로스터가 길어지므로(멤버당 ~25자) 상한은 팀 규모와 같이 봐야 한다.

## 결정

- **D-30** (04-결정기록.md) — 주입되는 것은 "파일" 이 아니라 **프리앰블 + 유효 지시문**; 기본 템플릿은 저장하지 않고 매번 계산;
  `# 역할:` 한 줄뿐인 파일은 본문 없음; 길면 사용자 본문만 자른다; `get` 은 사용자 파일만·주입될 텍스트는 `effective`.

그 외 이 태스크에서 정한 것(번호 없이 여기에):

- **템플릿의 H1 은 머리말이 가져간다.** 앱 템플릿은 `# 팀장 지시문` 으로 시작하지만, 데몬은 머리말이 `# <이름> — 팀장 @ <팀>` 이라
  본문을 `## 팀장 지시문` 으로 한 단계 내렸다(H1 두 개 방지). 문장은 그대로다.
- **로스터에 자기 자신도 넣는다.** 빼면 "팀원: (없음)" 인데 자기는 팀원인 이상한 상태가 생긴다. 누가 "너" 인지는 첫 줄이 이름으로 말한다.
- **엔진 표기는 소문자 그대로**(`claude`/`codex`) — `[TEAM] 팀원 변경: +이음(claude, …)`(T25)와 같은 표기를 쓴다.
- **`member.instructions.effective` 는 프리앰블까지 포함한 전문**을 돌려준다. "유효 지시문만" 을 돌려주면 정작 보고 싶은 것
  (모델이 실제로 읽는 것)이 안 보인다. 이름이 `effective` 인데 프리앰블이 들어 있는 것은 PROTOCOL 에 명시했다.

## 남은 것

- **앱(T26a) 팀원 템플릿에 도구 이름 줄이 없다.** 데몬 팀원 템플릿에는 넣었다(`mcp__team__report, mcp__team__ask_user …`).
  T26a 결정("둘이 갈라지면 데몬 쪽이 기준") 대로 앱 `memberInstructionTemplate` 에 같은 줄을 넣어야 한다. 팀장 템플릿은 이미 같다.
  앱 템플릿에는 동적 머리말이 없는데, 사용자가 그걸 저장하면 파일이 본문이 되어 **템플릿 머리말이 사라진다** — 프리앰블이 정체를
  들고 있으므로 치명적이진 않지만, 앱이 넣는 초안도 데몬 `instructions.effective` 를 받아 쓰는 쪽이 낫다(앱 과제).
- **`src/adapters/types.ts` 의 `getInstructions` 주석이 낡았다**("멤버 INSTRUCTIONS.md 본문") — 이제 프리앰블이 포함된 세션 컨텍스트다.
  이번 태스크의 편집 허용 범위 밖이라 두었다. 이름도 `getSessionContext` 가 맞다(어댑터 2개 + 테스트 2개 동시 수정 필요).
- **토큰 예산은 글자 수로만 잡았다.** 실제 토크나이저로 재지 않았다(한국어 ≒ 글자당 1토큰 가정). 지시문이 길어지는 팀이 생기면
  실측해서 `MAX_CONTEXT_CHARS` 를 조정한다. 로스터가 정말 길어지는 경우(팀원 10명 이상)의 축약도 안 했다.
- **`compact` source 는 단위 테스트로만 확인했다**(실기에서 compaction 을 일으키진 않았다). Claude 가 compact 때 `SessionStart` 를
  실제로 보내는 것은 실측 02 §② 에 있으므로 경로는 같다.
- **Codex 실기 미확인** — 단위 테스트(`CodexRouting`)로 같은 텍스트가 나가는 것만 봤다. Codex 는 `SessionStart` 가 첫 프롬프트 제출
  때 오므로(T20) "첫 턴부터 반영" 의 체감이 Claude 와 다를 수 있다.
- **지시문을 바꾸고 즉시 반영하려면 여전히 `member.restart`** 이고, 그 경로에는 resume 폴백이 없다(T25 함정 2, D-18은 복구 경로 전용).
  `set` + 다음 SessionStart 는 이 태스크에서 테스트로 고정했지만, "지금 재시작" 버튼(T26a)의 안전성은 T09 후속으로 남아 있다.
