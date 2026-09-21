# T43-4 — 확인용 세션(usage probe)

- 날짜: 2026-09-21
- 마일스톤: M7
- 설계: `docs/design/사용량-표시.md` §"확인용 세션 (T43-4)" (결정 D-45). 실측 근거: `docs/worklog/T43-0-UsageSpike.md`,
  원자료 `dev/spike-1/out/`
- 앞선 태스크: T43-1(데몬 사용량) · T43-2(앱 사용량). 뒤: **T43-3 실기**(`T43-3-UsageLive.md`)
- 커밋: `88fab4a`(데몬) · `9c8d99e`(앱)

## 목표

T43-1 이 남긴 구멍 하나를 메운다.

> **Claude 의 한도 숫자는 그 엔진의 멤버가 한 턴이라도 돌아야 들어온다.** 세션을 막 띄웠거나 `--resume` 한
> 직후에는 statusLine 페이로드에 `rate_limits` 키 자체가 없다(T43-0 Q2).

그래서 ① 아침에 앱만 켜고 아무도 일을 안 시키면 숫자가 안 보이고 ② **툴 밖에서 쓴 사용량**(직접 띄운
`codex exec`, 다른 터미널의 claude)은 영영 반영되지 않는다. 사용자 지적 그대로다 — "남은 사용량 확인이
제대로 안 되는 거겠네".

실측이 답을 줬다(T43-0 Q3): **새 세션에서 `/usage` 만 치면 모델 턴 0 · 토큰 0 으로 주간 한도가 그대로 나온다.**
그러니 엔진마다 숨은 세션 하나를 띄워 두고 화면만 읽으면 **할당량을 전혀 쓰지 않고** 숫자를 따라잡을 수 있다.

## 한 것

### 1. `UsageProbe` — 확인용 세션 (`dev/daemon/src/usage/UsageProbe.ts`)

**멤버가 아니다.** 이것이 이 태스크의 중심 제약이다:

| 멤버라면 있는 것 | 확인용 세션 |
|---|---|
| `members` 행 · `member_token` | **없다**(DB 에 행이 없다) |
| 스냅샷 `members[]` · `usage.members[]` · 사무실 책상 · 이벤트 | **안 나온다** |
| hooks(`--settings`) · TeamTools MCP · statusLine | **주입하지 않는다**(`--settings` 자체가 없다) |
| 지시(InputQueue 에 들어가는 instruct/system) | **받지 않는다** — 큐는 다이얼로그 통과에만 쓴다 |
| cwd = 부서 폴더 | `<dataDir>/usage-probe/<engine>` 의 **빈 폴더** |
| Office 의 `PtyManager` | **자기 인스턴스**(섞이면 언젠가 멤버로 취급된다) |

한 판:

```
spawn → (첫 실행 다이얼로그는 InputQueue 가 통과) → promptReady
      → 슬래시 명령 타이핑 → 0.7초 뒤 Enter → 패널이 **새로** 그려질 때까지 대기
      → 파싱 → tracker.applyProbe → Esc → promptReady 복귀 확인 → 다음 판까지 대기
```

- 판정은 전부 `tick()` 한 곳(500ms)에서 하고 시각은 주입된 `now()` 다 — 테스트가 타이머 없이 돌린다(InputQueue 규칙).
- **"패널이 새로 그려졌다" 를 어떻게 아는가**: `ready[0]` 패턴의 **등장 횟수**를 명령 치기 전후로 센다.
  Codex 는 스크롤백에 지난 판의 패널이 그대로 남아 있어서 "패턴이 보인다" 만으로는 옛 값을 다시 읽는다.
- 실패는 전부 조용하다: 패턴 불일치 → 그 판을 버리고 **엔진당 데몬 수명에 한 번** `daemon.notice{warn}`.
  프로세스 death → 1분 → 2 → 4 → 8 → **10분 상한** 백오프. `connected:false` → 안 띄우고, 나중에 붙으면 그때.
- 끄기 `PIXEL_USAGE_PROBE=0`, 주기 `PIXEL_USAGE_PROBE_SEC`(기본 300).

### 2. 화면 파서 — 패턴은 tui-map 에만

`src/usage/parse/usageScreen.ts`(순수) + `resetText.ts`(순수). **코드에 CLI 문구가 한 글자도 없다** —
전부 `src/tui-maps/<engine>-<ver>.json` 의 새 **`usage` 절**에서 온다(스키마는 `src/tui-maps/README.md`).

| 엔진 | 명령 | 읽는 것 |
|---|---|---|
| claude | `/usage` | `Current session`(5시간) · `Current week (all models)`(주간) · `Current week (<라벨>)` → `models[]` |
| codex | `/status` | `Weekly limit` · `5h limit`(미검증 — Pro 에는 안 나온다) + `Account: … (Pro)` 의 **요금제만** |

- 부호는 맵의 `percentIs` 가 정한다: Claude `used`, Codex `left`(데몬이 뒤집는다, D-45 ③).
- `target:"auto"` + 이름 있는 그룹(`label`·`model`)으로 Claude 의 블록 3종을 한 정규식이 가른다.
  **모델 라벨은 괄호 안 문자열 그대로** — 실측값이 `Fable` 이었다(모델 이름이 아니다).
- 리셋 사람 표기(`Sep 23, 12pm (Asia/Seoul)` · `14:02 on 28 Sep` · `9pm`) → ISO UTC.
  못 읽으면 **퍼센트만 살리고 `resetsAt:null`**.
- 블록이 하나도 안 맞으면 `ok:false` → 값을 통째로 버린다.

### 3. `UsageTracker` — 출처 병합

확인용 세션(5분)과 턴 종료(이벤트)가 같은 칸을 대므로 **칸(weekly/session/models)마다 더 최근에 *측정된*
값이 이긴다.** 늦게 **도착**해도 오래된 측정이면 버린다(`applyProbe(engine, patch, measuredAt)`).
와이어에 `engines[].models[]`(모르면 `[]`)와 `engines[].source`(`probe`|`turn`|null)를 더했다.

### 4. 스키마 v4(추가만) — 유령 정리

`usage_probe(engine PK, child_pid, updated_at)`. 확인용 세션은 멤버가 아니라 `members.child_pid` 에 자리가
없는데, 데몬을 **하드 킬**하면 이 프로세스도 살아남는다(D-17 과 똑같은 이유). 기동할 때 이 표의 pid 를
**같은 가드**(프로세스 이름이 엔진 이름을 포함할 때만)로 정리하고 표를 비운다. 정상 종료는 `Office.shutdown()` 이 죽인다.

### 5. 곁가지

- `PtyManager.spawnBare()` — 멤버가 아닌 세션(설정 파일 없음 · `PIXEL_MEMBER` 없음).
- `ScreenModel.fullText()` — 스크롤백 포함 전체(Codex 인라인 렌더).
- `args.ts` `buildClaudeProbeArgs`(`--permission-mode default` 뿐) / `buildCodexProbeArgs`
  (`--dangerously-bypass-hook-trust` + `sandbox_mode="read-only"`).
- 콘솔 `usage` 에 모델별 줄 + 측정 출처 표시.

### 6. 앱

- `UsageModel{label, window}` · `UsageSource` + `EngineUsage.models`/`source`(방어적 파싱 — 옛 데몬은 빈 목록).
- 팝오버 엔진 블록: **주간 막대 아래** 모델별 막대를 한 줄씩(들여쓰기, 라벨 칸 66px + 막대 60px). **칩에는 안 붙인다.**
- **칩 축약 문구**(아래 "발견한 것" ①)와 **상단 바 넘침**(②)을 같이 고쳤다.

## 검증

```
$ cd dev/daemon && npx tsc --noEmit
(출력 없음)
$ npm test
ℹ tests 707   ℹ pass 700   ℹ fail 0   ℹ skipped 7

$ cd dev/app && flutter analyze
No issues found!
$ flutter test -j 2
00:46 +541 ~1: All tests passed!
```

기준선 데몬 654/647/7 → **707/700/7 (+53)**, 앱 529+1 → **541+1 (+12)**.

| 파일 | 건수 | 보는 것 |
|---|---|---|
| `test/usage/usageScreen.test.ts` | 20 | **실측 화면 그대로**(`test/fixtures/usage/screens/`): 모르는 모델 라벨 · 스크롤백에 옛 패널 · 리셋 파싱 실패 · 전혀 다른 화면 · 연말 연도 · Codex `% left` 뒤집기 · 이메일 없음 |
| `test/usage/UsageProbe.test.ts` | 14 | 한 판 전체 · 주기 · 경고 1회 · 패턴 불일치 2종 · Codex 스크롤백 · `enabled:false` · 미연결 · 백오프 스케줄 · `stop()` · pid 기록 · 빈 cwd |
| `test/usage/UsageTracker.test.ts` | +8 | 출처 병합(probe↔turn 양방향, **늦게 온 옛 측정**, 칸별) · models 영속 · 옛 v3 행 |
| `test/store/MigrationV4.test.ts` | 4 | v3 DB → v4, pid upsert/삭제, 멤버 삭제와 무관, 멱등 |
| `test/office/Usage.test.ts` | +4 | Office.start 가 안 띄움 · **스냅샷 어디에도 확인용 세션이 없음** · shutdown · 기동 유령 정리 |
| `test/pty/env.test.ts` | +3 | 확인용 세션 인자에 hook/statusLine/MCP 가 없고 `PIXEL_MEMBER` 도 없다 |
| `dev/app/test/usage/usage_model_test.dart` | +4 | models/source 파싱 · 옛 데몬 · 깨진 행 · 같음 비교 |
| `dev/app/test/usage/usage_chips_test.dart` | +6 | 팝오버 모델 줄 2종 + **1100/1280/1400/1920 레이아웃** + 축약 3단 |
| `dev/app/test/usage/usage_format_test.dart` | +2 | 새 축약 문구 · `engineChipLabelFor` |

## 발견한 것 / 함정

1. **`C 45%` / `X 연결 안 됨` 은 암호였다.** T43-2 가 1500 아래를 전부 이 꼴로 줄였는데, 패스 6 의 기본 창이
   1280·1400 이라 **사실상 늘 그 꼴**이었다. 엔진 이름은 칩이 말해 주는 유일한 것이라 마지막까지 지키기로 했다 —
   `Claude 45%`. `C 45%` 는 1000 아래의 안전망으로만 남겼다.
2. **선택한 캐릭터가 있으면 상단 바가 최소 창(1100)에서 이미 넘치고 있었다.** T43-4 와 무관한 예전 결함이다 —
   옛 `C 45%` 칩으로도 34px 넘쳤다(부서 탭과 이름은 이미 줄어들 수 있으니 남은 고정 폭이 문제였다).
   `topBarTightWidth`(1200) 아래에서 **앱 이름과 "부서 만들기" 의 글자**를 뺐다(버튼은 아이콘 + 툴팁).
   1200 인 이유는 기존 상단 바 테스트가 쓰는 1400 을 건드리지 않기 위해서다.
3. **스크롤백에 옛 패널이 남는다.** Codex `/status` 를 5분마다 열면 버퍼에 패널이 쌓인다. "패턴이 보이면 읽는다"
   로 만들면 **매번 첫 판의 값을 다시 읽는다**(값이 영영 안 변한다). 등장 **횟수**를 세는 것으로 고쳤다.
4. **`kill()` 이 같은 틱에 `onExit` 을 부른다.** 정리 중에 `onExit → fail → killSession` 으로 재진입해 실패
   횟수가 두 번 올라갔다(백오프가 1분이 아니라 2분이 된다). `p.session` 을 **먼저 비우고** 맨 마지막에 kill 한다.
5. **`stop()` 뒤의 `tick()` 이 세션을 다시 띄웠다.** `stop()` 이 `probes` 맵을 비우니 다음 tick 이 `off` 상태로
   보고 새로 스폰했다 — 데몬 종료 경로에서 CLI 가 하나 더 뜨는 셈. `tick()` 에 `running` 가드를 넣었다.
6. **슬래시 명령과 Enter 사이에 틈이 필요하다.** 스파이크가 600~700ms 를 뒀다(`/` 를 치면 명령 팔레트가 뜨고,
   글자가 다 들어가기 전에 Enter 를 보내면 엉뚱한 명령이 골라진다). `typing` 단계를 따로 뒀다.
7. **연도 고르기.** T43-0 은 "화면의 사람 표기를 파싱해 날짜로 되돌리지 마라 — 연말에 깨진다" 고 경고했다.
   처음엔 "과거 2일 ~ 미래 300일 창" 으로 걸렀는데 1월 2일에 본 `Dec 28` 이 창 밖이라 내년으로 갔다.
   **작년·올해·내년 중 `now` 에 가장 가까운 것**으로 바꾸니 양쪽이 다 맞는다(후보 간격이 1년이라 안전하다).
8. **xterm `write` 는 비동기고 큰 화면은 여러 틱에 걸쳐 파싱된다.** 테스트에서 `setImmediate` 한 번으로는
   화면이 아직 안 그려져 간헐적으로 깨졌다(같은 테스트가 한 번은 통과, 다음엔 실패). 틱마다 여러 번 양보한다.

## 결정 (04-결정기록.md 에 넣을 문장 제안 — 코디네이터가 판단)

> **D-47 · 2026-09-21 · 확인용 세션은 "멤버가 아닌 CLI 프로세스" 라는 새 범주다**
> - 맥락: D-45 는 확인용 세션을 v1 범위 밖으로 미뤘지만, 턴이 없을 때·툴 밖에서 쓴 사용량이 반영되지 않아
>   사용자 요구("남은 사용량 확인")를 절반만 채웠다(T43-1 남은 것).
> - 결정: 엔진마다 숨은 CLI 하나를 띄워 `/usage`·`/status` 화면만 읽는다. 이 프로세스는 **members 행도,
>   토큰도, hooks·MCP·statusLine 주입도, 지시도 없다** — 자기 PtyManager·자기 빈 cwd·자기 pid 표(`usage_probe`,
>   스키마 v4)를 쓴다. 화면 패턴은 tui-map 의 `usage` 절에만 두고, 안 맞으면 값을 버리고 엔진당 한 번 경고한다
>   (턴 종료 출처가 계속 값을 대므로 기능이 죽지 않는다). 같은 칸은 **더 최근에 측정된 값**이 이긴다.
> - 버린 대안: 멤버 세션에 슬래시 명령을 밀어 넣기(D-45 ⑦ 위반), 확인용 세션을 멤버로 등록해 기존 배선을
>   재사용하기(사무실·스냅샷·지시 경로에 전부 예외가 생긴다), 매번 새로 띄우기(기동 64초).
> - 근거: `docs/worklog/T43-4-UsageProbe.md`, 실기 `docs/worklog/T43-3-UsageLive.md`.

## 남은 것

- **T43-3 실기** — 이 문서의 모든 숫자는 단위 테스트(실측 캡처)까지다. 진짜로 띄워 보는 것은 다음 태스크다.
- Codex 다른 요금제의 `5h limit` 줄은 여전히 **미검증**(Pro 에는 안 나온다). 패턴은 `Weekly limit` 과 같은
  모양이라고 가정해 둔 것이다.
- 확인용 세션의 **기동 비용**: Claude 는 약 60초 + 상주 프로세스 하나. 앱을 켜 두는 시간이 짧은 사용자에게는
  손해일 수 있다 — `PIXEL_USAGE_PROBE=0` 가 그 길이다. 기본값을 바꿀지는 실기 뒤에 볼 일.
- CLI 가 업데이트되면 `usage` 절부터 깨진다(화면 파싱의 숙명). 경고가 한 번 뜨는 것으로 사용자가 알 수 있게
  했지만, **앱 화면에 "화면을 못 읽었다" 를 따로 보여 주지는 않는다**(`source` 는 모델에만 담아 뒀다).
