# T43-5 — Claude 캐릭터의 누적 토큰

- 날짜: 2026-09-21
- 마일스톤: M7
- 설계: `docs/design/사용량-표시.md`(D-45). 앞선 기록: `T43-0-UsageSpike.md`(실측), `T43-1-UsageDaemon.md`(구현), `T43-3`(실기)
- 범위: `dev/daemon/**` 만. 앱은 건드리지 않았다(와이어 모양이 그대로라 고칠 것이 없다).
- 커밋: `49c2a68`(누적기) · `96c1bb8`(배선) · 이 문서

## 목표

T43-3 실기 캡처(`docs/worklog/img/T43-3-3-popover.png`)에서 **Claude 캐릭터만 토큰 칸이 `—`** 였다. 비용은
나오는데 토큰이 없다. Codex 캐릭터는 둘 다 나온다.

원인은 코디네이터가 짚은 그대로였고, 실측으로 다시 확인했다: **`type:"cost-state"` 줄은 CLI 프로세스가
끝날 때만 적힌다.**

```
살아 있는 세션 29a4b8c0-….jsonl   cost-state 0개   assistant 줄 있음
끝난 세션     ab967759-….jsonl   cost-state 1쌍   assistant 줄 있음
```

(88개 파일 전수: 75개에 cost-state 가 있고 13개에 없다. 없는 쪽은 아직 살아 있거나 비정상 종료한 세션이다.
있는 쪽도 "한 번" 이 아니라 **끝날 때마다 두 줄씩** 적힌다 — 같은 파일을 `--resume` 으로 다시 열었다가
또 끝내면 4줄·6줄이 된다.)

우리 멤버 세션은 몇 시간씩 살아 있다. 그래서 `parseClaudeCostState` 가 영원히 빈손이었고, 토큰은 `null` 인 채
statusLine 이 주는 비용만 들어왔다. **살아 있는 동안 쓸 토큰 출처가 하나도 없었다.**

## 한 것

### 1. `src/usage/ClaudeTranscriptUsage.ts` — 순수 증분 누적기

이전 상태 + 새로 덧붙은 텍스트 → 새 상태. 파일을 열지 않는다.

```ts
interface ClaudeTranscriptState {
  path: string;            // 이 상태가 따라가는 파일(바뀌면 리셋)
  offset: number;          // 다음에 읽을 바이트 위치
  partialLine: string;     // 줄 한가운데서 끊긴 조각
  seenIds: string[];       // 이미 센 message.id — 최근 2000개
  counted: Record<id, …>;  // id → 마지막에 센 값(같은 id 가 또 오면 빼고 다시 더한다)
  byModel: Record<model, {input,output,cacheRead,cacheCreate,thinking}>;
  partial: boolean;        // 20MB 상한 때문에 앞을 못 읽었다(내부 표식 — 와이어에 안 나간다)
}
```

`claudeTranscriptTotals(state)` 가 와이어 값 `{input, output, cacheRead, cacheCreate, total}` 을 만든다.
한 줄도 못 셌으면 **`null`**(= "아직 모른다"; `0` 을 썼다는 뜻이 아니다).

### 2. `src/usage/claudeTranscriptReader.ts` — 얇은 겉껍질

`readClaudeTranscriptUsage(file, prev, maxScanBytes=20MB)`:

- **덧붙은 바이트만** 읽는다(멤버마다 오프셋). 버퍼를 **마지막 줄바꿈에서 잘라** 디코딩하므로 UTF-8 문자가
  경계에서 쪼개지지 않는다.
- 파일이 **줄었으면** 잘림·회전 → 0 부터 다시 센다. **경로가 바뀌었으면** 리셋(아래 결정).
- 오프셋이 0 인데 파일이 20MB 를 넘으면 **뒤 20MB 만** 읽고 잘린 첫 줄을 버린 뒤 `partial:true`.
- 상한 안에 줄바꿈이 하나도 없으면 그 구간을 포기한다 — 그러지 않으면 같은 자리를 영원히 다시 읽는다.
- **실패하면 `null`**(파일 없음·폴더·잠김). 호출자는 이전 상태·이전 값을 그대로 둔다.

### 3. `UsageTracker.applyClaudeTurnEnd` 배선

```
① 증분 누적  → 살아 있는 동안의 토큰(유일한 출처)
② cost-state → 있으면 **그쪽이 최종값**(CLI 자신의 계산)
비용         → statusLine cost.total_cost_usd, cost-state.totalCostUSD 가 최종
```

- 누적 상태는 `Map<memberId, ClaudeTranscriptState>` 로 **메모리에만** 둔다.
- 멤버가 사라지면(부서·팀 삭제, `pruneMissingMembers`) 상태도 같이 버린다.
- 증분 읽기가 던져도 삼킨다 — 꼬리의 `cost-state` 만으로도 값이 들어온다.

## 실측 — per-message 합 vs cost-state

`~/.claude/projects/D--myproject-pixel-office-dev-spike-0-sandbox/` 의 **88개 실제 transcript** 전수.

### 어느 줄이 usage 를 들고 있나

```
줄 종류 수: attachment 3253 · assistant 761 · user 657 · last-prompt 398 · system 358 · mode 324 ·
           permission-mode 321 · atis-latch 321 · file-history-snapshot 266 · ai-title 236 ·
           cost-state 182 · bridge-session 60 · file-history-delta 11 · queue-operation 8
usage 를 가진 줄 종류: assistant 761  ← 이것뿐
```

### 같은 `message.id` 가 여러 줄

내용 블록이 스트리밍되면서 같은 응답이 여러 줄로 적힌다. **중복 481건 중 112건은 앞뒤 값이 다르다** —
앞 줄이 중간값이고 뒤 줄이 완성값이다:

```
msg_018p5thgj7xRsRwqhE4tC6z7  [in 3, out 1,  cr 14601, cc 2920]  →  [in 3, out 206, cr 14601, cc 2920]
msg_01P82bFAYywBDt2xqSajTvnm  [in 1, out 46, cr 17883, cc 196]   →  [in 1, out 2196, cr 17883, cc 196]
```

→ **id 마다 마지막 값 하나**만 센다. 그냥 더하면 이중 계산이고, 첫 값을 쓰면 과소 계산이다.

### 합이 cost-state 와 맞는가 — **맞는다(배경 모델 제외)**

cost-state 의 `modelUsage` 를 **transcript 에 줄이 남은 모델**과 **그렇지 않은 모델**로 갈라 비교했다
(`claude-opus-5[1m]` 는 assistant 줄에 `claude-opus-5` 로 적히므로 창 크기 접미사를 떼고 견준다):

```
cost-state 가 있는 세션 76개
  줄 합 == cost-state(보이는 모델) 가 **토큰 단위로 정확히 일치**:  38개 (50%)
  |차이| 중앙값:                                                   0.09%
  배경 모델 버킷은 76개 전부 claude-haiku-*  (제목 생성)
  배경 비중: 최소 0.00% · 중앙값 0.50% · 최대 3.81%
```

**구조적 차이 두 가지** — 둘 다 "우리가 못 세는" 쪽이다:

1. **배경 haiku 호출.** 세션 제목(`ai-title`)을 만드는 haiku 요청은 API 는 탔는데 transcript 에 assistant
   줄을 남기지 않는다. 76개 세션 전부에서 이 버킷이 있었고 캐시가 언제나 0 이다(짧은 단발 호출).
   세션당 거의 고정이라 **짧은 세션일수록 비중이 크다**(1턴짜리 `50cc7bea` 는 2.06%, 긴 세션은 0.1% 미만).
2. **주 모델의 숨은 호출.** 세션이 끝날 때 `input≈504, output≈25, cacheRead = 그 시점 컨텍스트 전체` 인
   호출이 한 번 더 잡히는 세션이 있다(전체의 절반). 역시 줄로 남지 않는다. 확인:
   ```
   3c207e23 #64 cost-state  opus in=510 out=982 cr=178097 cc=18611
            줄 합(3턴)      opus in=6   out=956 cr=127676 cc=18175
            차이            in +504 out +26 cr +50421 cc +436
                                          └─ 50421 = 48114 + 2307 = 직전 턴 뒤 컨텍스트 전체
   ```

역방향(줄 합 > cost-state)이 4건 있었다. 전부 **같은 파일 안에서 대화가 갈아엎힌 채 이어진** 세션이다
(`cacheRead` 가 중간에 첫 턴 값으로 되돌아간다). 마지막 CLI 프로세스의 cost-state 는 그 프로세스가 실제로
쏜 것만 담으므로, 파일 전체를 훑는 우리 합이 더 커진다. **cost-state 가 있으면 그쪽을 쓰므로 표시값은
영향받지 않는다.**

→ 결론: **살아 있는 동안 우리 숫자는 CLI 의 `/cost` 보다 0~4% 낮다.** 세션이 끝나면 cost-state 로 정확히
맞춰진다. 토큰은 "얼마나 썼나" 를 가늠하는 참고 수치이므로 이 정도 과소 표시는 `—` 보다 훨씬 낫다.

### 사고 토큰(thinking) — **`output` 에 이미 들어 있다**

이 판정이 이번 태스크에서 가장 확실하게 갈린 부분이다.

```
3c207e23 1턴  줄:         out=323  output_tokens_details.thinking_tokens=200
         cost-state:      outputTokens=323  thinkingTokens=200
```

`323 == 323`. 더해졌다면 cost-state 의 `outputTokens` 가 523 이어야 한다. 그리고 "정확히 일치" 판정을 받은
38개 세션 전부에서 `sum(output_tokens) == cost-state.outputTokens` **이면서** 동시에
`sum(thinking_tokens) == cost-state.thinkingTokens` 였다 — 두 식이 동시에 성립하려면 thinking 이 output 의
**부분집합**이어야 한다.

→ **`thinkingTokens` 를 `output` 에 더하지 않는다.** 내부 `byModel` 에는 따로 들고만 있다(진단용).

### `--resume` — 새 파일이면 **리셋**

두 가지 경우가 실물로 다르다.

**(a) 같은 파일에 이어 쓰는 경우**(`bridge-session` 줄, 같은 `sessionId`·같은 `startTime`) — CLI 가 직전
cost-state 를 **복원**하고 그 위에 더한다:

```
357de20d #47  cost-state  haiku[1950,41]  opus-5[1m][540,179,133158,10949]
357de20d #119 cost-state  haiku[1950,41]  opus-5[1m][540,179,133158,10949]  ← 그대로 보존
                                          opus-5    [508,265,142041,15008]  ← 새 프로세스 몫
```

**(b) `--resume` 이 새 파일을 파는 경우** — 새 `sessionId`·새 `startTime`, 그리고 **금액이 0 부터 다시 시작**:

```
99d3da71.jsonl  cost-state  $0.335247   opus[610, 973, 377712, 11687]   ← 원본 세션이 여기서 끝남
d5477a7c.jsonl  cost-state  $0.124848   opus[2,   93,  37792,  10264]   ← resume 이 판 새 파일
                                        └ 앞 세션의 $0.335 를 이어받지 않았다
```

→ **회계 단위는 transcript 파일 하나다.** CLI 자신의 `/cost`·`/usage` 화면이 새 파일에서 0 부터 다시
세므로 우리도 **경로가 바뀌면 리셋**한다. 파일을 넘어 더하면 앱 숫자가 CLI 화면과 어긋나고, 사용자가
둘을 대조할 때 우리 쪽이 틀린 것이 된다. (a) 는 같은 경로라 자동으로 이어진다.

### 서브에이전트(`isSidechain`)

CLI 2.1.275 는 서브에이전트 줄을 **본 transcript 에 섞지 않는다** — `<sessionId>/subagents/agent-*.jsonl`
로 따로 쓴다. 이 기계의 본 transcript 에는 `isSidechain:true` 가 **한 줄도 없다**(`false` 20,930건).

그래서 지금 배선으로는 **서브에이전트 토큰이 집계에 안 들어간다**(cost-state 가 생기면 들어간다 — 그건
프로세스 단위 회계다). 누적기 자체는 `isSidechain` 을 **거르지 않는다**: id 가 다르므로 이중 계산이 아니고,
옛 CLI 처럼 본 파일에 섞여 들어오면 그대로 잡힌다. 실측 서브에이전트 파일에서 잘라 온 픽스처로 테스트를
박아 뒀다.

## 검증

```
$ npx tsc --noEmit
(출력 없음)

$ npm test
ℹ tests 742
ℹ suites 115
ℹ pass 735
ℹ fail 0
ℹ skipped 7        (PIXEL_IT=1 통합 테스트)
ℹ duration_ms 36588
```

기준선 711/704/7 → **+31 테스트**.

| 파일 | 건수 | 보는 것 |
|---|---|---|
| `test/usage/ClaudeTranscriptUsage.test.ts` | 22 | 실측 종료 세션 2개와 cost-state 대조 · **살아 있는 세션에 cost-state 가 0개임을 실물로 확인** · thinking 부분집합 · 중복 id · id 상한 · 청크 경계(1/7/64/997/5000자) · 깨진 JSON·합성 줄 · 서브에이전트 · assistant 0줄 · 증분 읽기 · 회전 · 경로 변경 · 20MB 상한 · 없는 파일 |
| `test/usage/UsageTracker.test.ts` | +9 | 살아 있는 세션에서 토큰이 들어온다 · 증분 증가 · cost-state 가 이긴다 · 비용 인계 · resume 리셋 · 재기동 복구 · 멤버 삭제 · 예외 삼킴 · Codex 는 이 길을 안 탄다 |

픽스처 6개는 실측 transcript 에서 **`attachment` 줄만 빼고**(usage 를 들고 있지 않다 — 전수 확인) 그대로
옮긴 것이다. 숫자를 손대지 않았다.

### 짧은 실기

격리 `PIXEL_DATA_DIR` + 포트 7520~7522 + `PIXEL_USAGE_PROBE=0`(7420~7422 는 건드리지 않았다).

```
po> dept create t435 D:/myproject/pixel-office/dev/spike-0/sandbox claude 반장
부서 생성: d_dacbbd2a9425  t435  head=m_ef5aff1e9a00

po> say m_ef5aff1e9a00 1+1 이 몇인지 한 줄로만 답해 줘. 파일은 건드리지 마.
#6 text 반장 1+1 = 2 — 파일은 건드리지 않았고, 팀을 만들 일도 아니어서 바로 보고만 올렸습니다.
#7 idle 반장

po> usage
claude  연결됨(max)  주간 34% 남음 (리셋 2026-09-23T03:00:00.000Z)  5시간 82% 남음 (리셋 2026-09-21T17:00:00.000Z)  측정 2026-09-21T12:15:46.525Z(turn)
codex   연결됨(요금제 ?)  한도 미확인 — 첫 작업 후 표시
  반장 [claude]  컨텍스트 5% (51k/1.0M)  토큰 150k  $0.3118  2026-09-21T12:16:00.211Z
```

**`토큰 150k`** — 고쳐진 값이다(전에는 `토큰 -`). 그 세션의 transcript 를 직접 세어 맞춰 봤다:

```
29a4b8c0-….jsonl  cost-state 0개  고유 id 3개  합계 149,940  {in 6, out 1258, cacheRead 127098, cacheCreate 21578}
```

149,940 → `150k`. **cost-state 가 0개인데 토큰이 나온다** = 이번 태스크가 고치려던 것 그대로.

끝내고 부서 삭제 → `shutdown` → 포트 7520~7522 LISTENING 없음 · `t435-data` 로 뜬 `claude.exe` 없음 ·
데몬 프로세스(pid 24040) 없음까지 확인했다.

## 함정

1. **`cost-state` 를 "세션당 한 번" 으로 믿으면 안 된다.** 끝날 때마다 **두 줄씩**(20~30ms 차이로 같은 값)
   적히고, 같은 파일을 여러 번 열었다 닫으면 4줄·6줄이 된다. 우리는 **마지막 것**만 쓴다 — 지금 파서가
   이미 그렇게 한다.
2. **중복 줄의 앞 값이 다르다.** "같은 응답이 여러 줄" 까지는 T43-0 이 봤지만, **앞 줄이 중간값**이라는 것은
   이번에 서브에이전트 파일에서야 드러났다(spike-0 코퍼스에서는 우연히 값이 같았다). 첫 값을 쓰는 구현은
   조용히 과소 계산한다 — 그래서 누적기가 **빼고 다시 더한다**.
3. **Windows 는 폴더도 `fs.open` 이 된다.** 처음엔 폴더 경로에 `{offset:0}` 상태를 돌려줬다. `isFile()` 로
   막았다(`tail.ts` 는 `size<=0` 덕에 우연히 피하고 있었다).
4. **오프셋은 바이트, 줄은 문자다.** 청크를 바이트로 자르고 문자로 파싱하면 UTF-8 이 경계에서 쪼개진다.
   버퍼를 **마지막 줄바꿈에서 잘라** 디코딩해 이 문제를 아예 없앴다(`\n` 은 언제나 문자 경계다).
5. **`screen-idle` 이 진짜 턴 종료보다 먼저 온다.** 실기에서 `say` 직후 `#2 idle screen-idle` 이 떠
   `--wait-idle` 이 일찍 풀렸고, 그 시점에 `usage` 를 치니 토큰이 아직 `-` 였다. 실제 `Stop` 은 한참 뒤였다.
   **버그가 아니다**(D-25 폴백이 원래 그렇다) — 실기할 때 `usage` 는 `text`/`idle` 이벤트를 본 뒤에 칠 것.
6. **한 줄이 상한보다 클 수 있다.** transcript 의 `attachment` 줄은 100KB 를 넘는다. 상한 안에 줄바꿈이
   없으면 그 구간을 **포기**하지 않으면 같은 자리를 영원히 다시 읽는다.

## 결정

- **살아 있는 동안은 줄 합, 끝나면 cost-state.** 둘을 섞지 않는다(더하지도, 큰 쪽을 고르지도 않는다).
  cost-state 는 CLI 자신의 회계이고 우리 합보다 항상 더 많이 안다.
- **`thinkingTokens` 를 `output` 에 더하지 않는다.** 위 실측대로 이미 포함돼 있다.
- **transcript 경로가 바뀌면 리셋한다.** CLI 의 `/cost` 가 파일 단위로 리셋되므로(실측 99d3da71 → d5477a7c)
  우리도 같아야 사용자가 두 화면을 대조했을 때 맞는다. 같은 파일에 이어 쓰는 resume 은 자동으로 이어진다.
- **서브에이전트 줄을 거르지 않는다.** id 가 달라 이중 계산이 아니다. 지금 CLI 는 본 파일에 안 섞지만
  거르는 코드를 넣어 둘 이유가 없다.
- **누적 상태는 영속하지 않는다.** `member_usage` 에 **합계**가 이미 남아 있어 재기동 직후에도 화면이 비지
  않고, 오프셋은 그 멤버의 첫 턴 종료 때 파일을 0 부터 한 번 훑어 되찾는다(이중 계산 없음 — id 로 센다).
  오프셋까지 DB 에 넣으면 "DB 의 오프셋과 실제 파일이 어긋났을 때" 라는 새 실패 모드가 생긴다.
- **20MB 상한과 `partial` 은 내부에만 둔다.** 와이어 모양(`UsageTokens`)을 바꾸지 않았다 — 앱이 고칠 것이
  없어야 한다.
- **`ClaudeTranscriptUsage` 는 파일을 열지 않는다.** IO 는 `claudeTranscriptReader` 로 분리해 누적 규칙을
  실측 텍스트만으로 테스트한다.

## 남은 것

- **서브에이전트 파일(`<sessionId>/subagents/agent-*.jsonl`)은 안 읽는다.** 멤버가 Task 도구를 많이 쓰면
  살아 있는 동안의 숫자가 그만큼 더 낮게 보인다(세션이 끝나면 cost-state 가 메운다). 읽으려면 디렉터리
  감시가 필요해서 이번 범위 밖으로 뒀다.
- **살아 있는 동안 0~4% 과소.** 배경 haiku·숨은 주 모델 호출은 transcript 에 줄을 남기지 않아 구조적으로
  못 센다. 표시에 "약(≈)" 같은 표식을 붙일지는 앱 쪽 판단(지금은 붙이지 않았다).
- 컴팩션(`PreCompact`) 뒤 값이 어떻게 튀는지는 여전히 미확인(T43-0 부터 남아 있는 항목).
- Codex 쪽은 손대지 않았다 — rollout 의 `total_token_usage` 가 턴마다 누적값을 주므로 같은 문제가 없다.
