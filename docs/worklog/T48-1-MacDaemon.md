# T48-1 — 맥 지원 (데몬 쪽)

- 날짜: 2026-09-29
- 마일스톤: M6
- 관련 설계: `docs/design/맥-지원.md`(전문 · 데몬 표 · 2단계 대본) · 04-결정기록 **D-48**, D-17(유령 정리), D-40(데몬 하나), D-47(수명 주기)
- 커밋: `cf003f2` `cc25c23` `937a82f` `353db59` `<docs>` (브랜치 `worktree-agent-acd06b67b9c918546`)
- 환경: **윈도우 11에서만 작업했다.** 맥 분기는 전부 플랫폼을 주입한 단위 테스트로만 검증했다(D-48 원칙 4) — 아래 "맥에서 확인" 이 2단계 몫이다.

## 목표

데몬의 운영체제에 닿는 코드를 `src/platform.ts` 한 곳으로 모으고 맥·리눅스(유닉스) 분기를 넣는다. 끝나면 맥에서
`npm install && npm test` 가 돌 준비가 되고, 데몬이 맥의 데이터 폴더·실행 파일·프로세스 조작·안내 문구·종료 신호를
**맥 방식으로** 쓴다. 윈도우 동작은 1비트도 바뀌지 않는다(D-48 원칙 3 — 기존 테스트 818건 그대로 통과).

## 한 것

### 1. `src/platform.ts` (신규) — 운영체제에 닿는 코드 전부

주입구 하나(`PlatformDeps`: `platform` · `env` · `homedir` · `spawnSync` · `kill` · `isFile` · `readdir`)와
`createPlatform(over?)`, 그리고 실제 OS 에 붙은 한 벌 `host`. 내보내는 연산:

| 이름 | 윈도우 | 유닉스(맥·리눅스) |
|---|---|---|
| `dataDir()` | `%LOCALAPPDATA%\pixel-office` | 맥 `~/Library/Application Support/pixel-office` · 리눅스 `$XDG_DATA_HOME/pixel-office` 또는 `~/.local/share/pixel-office`. `PIXEL_DATA_DIR` 이 전부를 덮는다 |
| `dataDirLabel()` | `%LOCALAPPDATA%\pixel-office` | 오류 문구에 쓰는 사람용 표기 |
| `npmGlobalRoots()` / `npmModulesRoots()` | `%APPDATA%\npm` · `%LOCALAPPDATA%\npm` · `%ProgramFiles%\nodejs`(+`\node_modules`) | `PIXEL_NPM_PREFIX/lib/node_modules`, 없으면 `/opt/homebrew/…` · `/usr/local/…` · `~/.npm-global/…` · `~/.nvm/versions/node/*/…`(최신 먼저) · `~/.volta/tools/image/node/*/…` |
| `resolveClaudeExe(Detailed)()` | env → PATH `claude.exe`(셰임 제외) → npm 전역 → 앱 번들 최신 버전 | env → PATH `claude`(셰뱅 스크립트 OK) → npm 전역. **앱 번들 단계 없음** |
| `resolveCodexExe()` | npm 전역 vendor `codex.exe` → PATH | npm 전역 vendor `codex`(`codex-darwin-arm64` 류를 스캔) → PATH |
| `isProcessAlive(pid)` | `kill(pid,0)`, `EPERM` = 살아 있음 | 같음 |
| `processImageName(pid)` | `tasklist /FI "PID eq <pid>" /FO CSV /NH` 파싱 | `ps -p <pid> -o comm=` 의 basename(소문자) |
| `killTree(pid)` | `taskkill /PID <pid> /T /F` | `ps -axo pid=,ppid=` **한 번** → 트리 구성 → **아래부터** `SIGKILL` |
| `processStartTime(pid)` | PowerShell `Get-CimInstance Win32_Process`(ISO) | `LC_ALL=C ps -p <pid> -o lstart=` → `Mon Sep 29 10:11:12 2026` 손으로 파싱 |
| `hintForKillingPid(pid)` | `taskkill /F /PID <pid>` | `kill <pid>` |
| `hintForFindingPortOwner(port)` | `netstat -ano \| findstr :<port> → taskkill /F /PID <pid>` | `lsof -i :<port> → kill <pid>` |
| `shutdownSignals()` / `installShutdownSignals()` | `SIGINT`·`SIGTERM` | **+ `SIGHUP`** |

곁딸린 순수 함수도 같이 내보낸다(테스트가 직접 부른다): `parseLstart` · `parsePidPpid` · `killOrder` ·
`parseTasklistCsv` · `compareVersionDesc` · `baseName`.

호출처 교체: `config.ts`(dataDir·두 실행 파일 — 옛 이름은 다시 내보내 호출처·테스트를 안 건드렸다) ·
`office/orphans.ts`(세 연산) · `office/parentWatch.ts`(두 연산) · `office/singleton.ts`(생존 + 안내 문구 둘 + 폴더 표기) ·
`pty/PtyManager.ts`(ConPTY 자원 해제를 윈도우 전용으로 게이트) · `index.ts`(종료 신호).

### 2. 위험한 셸 명령 판별 — `src/adapters/mapping.ts`

`DANGER_PATTERNS` 표 하나에 **두 계열을 같이** 넣고 `isDangerousCommand` · `dangerousMatches` · `dangerousReasons` 를
내보낸다. **플랫폼을 보지 않는다**(D-48 ④: 맥에서 PowerShell 을, 윈도우에서 git-bash 를 쓸 수 있다).

- 유닉스: `rm -r|-rf|-fr|--recursive` · `rm -f` · `sudo` · `chmod -R` · `chown -R` · `git push --force|-f` ·
  `git reset --hard` · `git clean -f*` · 파일 리다이렉션 `>`/`>>`(`2>&1`·`/dev/null`·`$null`·`nul` 은 뺀다) ·
  `mv`(피연산자 둘 = 덮어쓰기) · `truncate` · `dd if=/of=/bs=` · `mkfs*`
- PowerShell/CMD(예전 것 유지): `Remove-Item -Recurse|-Force` · `del /s` · `rd|rmdir /s` · 첫머리 `format`
- 안전망: 위험 명령은 `isReadOnlyCommand` 에서 **절대** 읽기 전용이 아니다(셸 뮤텍스 D-27). 지금도 전부 "쓰기" 로
  떨어지지만, 읽기 목록에 새 명령을 더할 때 사고가 나지 않도록 못을 박았다.
- `CODEX_SHELL_TOOLS` 에 맥 기본 셸 이름 `sh`·`zsh` 추가.

### 3. hook·statusLine 명령의 인용 — `test/pty/hookSettings.test.ts`

생성기(`buildHookCommand`/`buildStatusLineCommand`)는 **이미** 공백이 있을 때만 큰따옴표로 감싸고 있었다(T40 이전부터).
고칠 것은 없었고, **맥 경로로 규칙을 못 박았다**: `/Users/me/Library/Application Support/pixel-office/hooks/hook.js`
로 Claude `--settings` JSON 의 11개 이벤트 + `statusLine`, Codex `.codex/hooks.json` 의 8개 이벤트를 검사하고,
셸이 볼 토큰이 `node` · 인용된 경로 · 포트 · 이벤트 **넷**임을 확인한다. 공백이 든 dataDir·cwd 에 실제로 써 보는 것도 한 건.

### 4. `SIGHUP` — `src/platform.ts` + `src/index.ts`

`installShutdownSignals(onSignal)` 하나로 바꿨다. 유닉스에서는 `SIGINT`·`SIGTERM`·**`SIGHUP`** 셋을 걸고
윈도우에서는 예전 그대로 둘만 건다(노드가 윈도우에서 콘솔 닫힘을 `SIGHUP` 으로 흉내내기도 하지만 계약이 아니라 걸지 않는다).
세 신호 모두 **같은 핸들러**(정중히 종료 → 두 번째 신호는 즉시 exit 1)로 간다.

### 5. tui-map 로더의 플랫폼 접미사 — `src/screen/tuiMap.ts`

`BUILTIN`(엔진 → JSON) 을 `BUILTIN_FILES`(**파일 이름** → JSON) + `BUILTIN_VERSION`(엔진 → major.minor) 로 갈랐다.
`resolveTuiMapFile(engine, platform)` 이 `<engine>-<ver>-<platform>.json` → `<engine>-<ver>.json` 순으로 고르고,
`loadTuiMap(engine, platform = process.platform)` 은 플랫폼까지 캐시 키에 넣는다. **darwin 파일은 아직 없다** —
맥 실기에서 줄바꿈이 다를 때 만든다(D-48 ⑦). 규칙과 "추가는 두 줄" 절차는 `src/tui-maps/README.md`.

### 6. 문서

- `dev/daemon/README.md`: "플랫폼 — 윈도우 · 맥 · 리눅스" 절(항목 12개 표 · 셰뱅 설명 · 환경변수 3개 ·
  "맥에서만 알 수 있는 것"), 환경변수 표에 `PIXEL_NPM_PREFIX` 추가와 `PIXEL_DATA_DIR` 기본값을 OS 별로 고침,
  실행 파일 탐지 절을 유닉스 단계까지 갱신.
- `src/tui-maps/README.md`: 파일 이름 규칙에 플랫폼 접미사 절.
- 이 파일.

## 검증

```
$ cd dev/daemon && npx tsc --noEmit
(출력 없음)

$ npm test
ℹ tests 884
ℹ suites 143
ℹ pass 877
ℹ fail 0
ℹ skipped 7          # 통합 테스트 7건(PIXEL_IT=1 없으면 skip) — 기준선과 같다
```

기준선(작업 전)은 818건/811통과/7skip 이었다. 늘어난 66건이 이 태스크의 새 테스트고 **기존 818건은 한 줄도 고치지 않았다**
(윈도우 동작 불변의 증거).

| 새 테스트 파일 | 건수 | 무엇을 고정하나 |
|---|---|---|
| `test/platform/platform.test.ts` | 36 | 데이터 폴더 4플랫폼 경로 + `PIXEL_DATA_DIR` · npm 뿌리(윈도우 3개 · `PIXEL_NPM_PREFIX` · 맥 7개, nvm 최신 먼저) · 맥의 claude/codex 탐색(PATH 셰뱅 · npm 전역 · 못 찾음 → tried 3줄 · 번들 단계 없음) · `isProcessAlive`(EPERM/ESRCH/이상한 pid) · `processImageName`(맥 basename · 윈도우 CSV · pid 불일치) · `killTree`(윈도우 인자 · 맥 3단 트리 아래부터 · ESRCH 무시 · ps 실패) · `processStartTime`(LC_ALL=C 인자 · lstart 파싱 · 윈도우 PowerShell) · 안내 문구 · 신호 목록/등록 |
| `test/adapters/dangerous.test.ts` | 16 | 유닉스 패턴 9종 · PowerShell/CMD 패턴 5종 · 표 자체(id 중복·설명) · "위험 = 읽기 전용 아님" · 셸 도구 이름 |
| `test/screen/tuiMapPlatform.test.ts` | 8 | 후보 순서 · darwin 우선 · 다른 플랫폼은 폴백 · 지금은 전부 폴백 · 둘 다 없으면 던짐 · 플랫폼별 캐시 · 표와 실제 파일 일치 |
| `test/pty/hookSettings.test.ts`(추가분) | 6 | 맥 공백 경로 인용(hook · statusLine · Claude JSON 11이벤트 · Codex 8이벤트 · 실제 쓰기 · 윈도우 불변) |

**가짜만 쓴다**: `spawnSync` 와 `kill` 은 전부 주입한 가짜다 — 이 PC 에서 진짜 `ps`/`kill`/`lsof` 를 부르는 테스트는 없다.
파일 트리(실행 파일 탐색)만 임시 폴더를 쓴다(윈도우 테스트가 예전부터 그렇게 한다).

## 발견한 함정

1. **npm 전역 "뿌리" 의 뜻이 플랫폼마다 다르다.** 윈도우 뿌리는 prefix(`%APPDATA%\npm`)라 그 아래에 `node_modules`
   가 한 칸 더 있고, 유닉스 뿌리는 `$(npm prefix -g)/lib/node_modules` 자체다(스코프 폴더를 바로 품는다).
   같은 함수로 뭉치면 맥에서 `@anthropic-ai` 를 못 찾는다 → `npmGlobalRoots()`(사람이 이해하는 뿌리)와
   `npmModulesRoots()`(경로 계산용)를 갈라 비대칭을 **한 곳에서** 흡수했다. 패키지 경로를 만드는 코드는 후자만 쓴다.
2. **`npm prefix -g` 는 부르면 안 된다.** 설계 표에 "비싸다" 고 적힌 그대로다(노드 프로세스 하나). 데몬 기동 때
   `config.ts` 가 실행 파일을 해석하므로 기동이 그만큼 늦어진다. 그래서 `PIXEL_NPM_PREFIX` + 잘 알려진 자리 목록으로 갔다.
3. **맥 `ps` 에는 `--ppid` 가 없다.** 트리를 리눅스식으로 `ps -o pid= --ppid <pid>` 로 캐면 맥에서 조용히 실패한다
   → `ps -axo pid=,ppid=` **한 번**으로 전체를 읽어 트리를 만든다(호출도 한 번이라 더 싸다).
4. **트리는 아래부터 죽여야 한다.** 부모를 먼저 `SIGKILL` 하면 자식이 `init`(pid 1)에 재부모되어 그다음 조회에서
   사라진다 — 유령이 남는 바로 그 사고(D-17). `killOrder()` 가 BFS 를 뒤집어 깊은 쪽부터 돌려준다.
5. **`lstart` 파싱을 `Date.parse` 에 맡기지 않았다.** 로캘·엔진에 따라 해석이 갈릴 수 있어 `LC_ALL=C` 를 못 박고
   `Mon Sep 29 10:11:12 2026` 한 형식만 손으로 뜯는다. 못 읽으면 `undefined` → 감시는 pid 만 보고 계속한다(예전 규칙).
6. **`EPERM` 해석이 파일마다 달랐다.** `singleton.ts`·`parentWatch.ts` 는 "살아 있음"(D-40), `orphans.ts` 는 "죽음"
   이었다. 하나로 모으면서 **"살아 있음" 으로 통일**했다 — `reapOrphan` 은 이미지 이름이 엔진과 맞을 때만 죽이므로
   위험이 늘지 않는다(이름을 못 읽으면 건너뛴다). 윈도우 테스트는 가짜 ops 를 쓰므로 영향 없음.
7. **ConPTY 자원 해제는 윈도우 전용 처방이다.** 유닉스에서 그 코드를 타면 이미 죽은 프로세스에 `proc.kill()` 을
   부르는 꼴(ESRCH)이라 `host.isWindows` 로 막았다.
8. **공백 있는 경로는 이미 인용되고 있었다.** 설계가 "확인" 이라고 적은 자리(hook/statusline)는 실제로 안전했다 —
   대신 규칙을 테스트로 고정했다. 정작 공백이 처음 등장하는 곳은 **데이터 폴더**(`Application Support`)이고,
   `--settings <경로>`·`--mcp-config <경로>` 는 셸을 거치지 않는 argv 라 인용이 필요 없다(맥에서 확인 ⑤).
9. **`mv` 는 문자열만으로 "덮어쓰는지" 를 알 수 없다.** 피연산자가 둘 이상이면 위험으로 센다(사람이 한 번 더 보는 것이 싸다).

## 결정

- **D-48** 의 구현이다. 새 결정은 만들지 않았다. 다만 위 함정 ⑥(EPERM 통일)과 ⑦(ConPTY 게이트)은 옛 코드의 동작을
  **유닉스에서만** 바꾸는 판단이라 여기 적어 둔다. 맥 실기에서 다르게 나오면 그때 D-## 로 올린다.
- `isProcessAlive` 는 윈도우에서도 `tasklist` 가 아니라 `kill(pid,0)` 이다(노드가 `OpenProcess` 로 바꿔 준다) —
  설계 표에는 "tasklist" 로 적혀 있지만 **옛 코드가 이미 `kill(pid,0)`** 이었고, 원칙 3(윈도우 불변)이 설계 표보다 앞선다.
  `tasklist` 는 이미지 **이름**을 읽을 때만 쓴다.

## 맥에서 확인 (2단계, `docs/design/맥-지원.md` M1~M6 과 함께)

데몬 쪽에서 **맥에서만 알 수 있는 것들**. 명령은 `dev/daemon` 에서 실행한다.

| # | 확인 | 명령·방법 | 기대 | 어긋나면 |
|---|---|---|---|---|
| D1 | node-pty 네이티브 빌드 | `npm install` | 빌드 성공(`node_modules/node-pty/build/Release/pty.node`) | Xcode 명령줄 도구(`xcode-select --install`)·Python 확인 |
| D2 | 단위 테스트 수가 윈도우와 같다 | `npx tsc --noEmit && npm test` | 884건/877통과/7skip | 실패 건은 플랫폼 분기 버그 — 이 문서 표와 대조 |
| D3 | 데이터 폴더가 규칙대로 생긴다 | `npm start` 뒤 `ls -la ~/Library/Application\ Support/pixel-office/` | `daemon.json` · `pixel-office.db` · `sessions/` | 앱이 다른 폴더를 보면 데몬·앱의 `dataDir()` 규칙 불일치(D-48 ②) |
| D4 | `claude` 탐색 결과가 **실제 파일** | 기동 로그의 `[daemon] claude : …`, 그리고 `file $(그 경로)` · `head -1 $(그 경로)` | npm 전역 `bin/claude`, 1행이 `#!/usr/bin/env node` | 못 찾으면 `npm prefix -g` 출력을 적어 `PIXEL_NPM_PREFIX` 로 주고, 그 자리를 잘 알려진 목록에 추가 |
| D5 | **셰뱅 스크립트를 pty 로 띄울 수 있다**(이 프로젝트의 가장 큰 미지수) | `npm run cli -- --exec "dept create 맥테스트 <폴더> claude 부장" --wait-idle 부장` | 부장이 idle 까지 간다 | 안 되면 `PIXEL_CLAUDE_EXE` 로 `node <cli.js>` 를 직접 가리키는 길을 재 보고 결과를 D-## 로 |
| D6 | `codex` vendor 경로 | `PIXEL_CODEX_EXE` 없이 기동 → `[daemon] codex : …` | `@openai/codex-darwin-arm64/vendor/*/bin/codex` | 플랫폼 패키지 이름이 다르면 스캔 접두(`codex-`)를 확인 |
| D7 | 공백 있는 경로의 hook 이 실제로 돈다 | 한 턴 지시(`say 부장 …`) 뒤 `cat ~/Library/Application\ Support/pixel-office/sessions/*/claude-settings.json` 과 이벤트 표 | 명령이 `node "…/Application Support/…/hook.js" 7421 <Event>` 이고 이벤트가 들어온다 | 안 오면 `PIXEL_HOOK_LOG=/tmp/hook.jsonl` 로 원문 확인 |
| D8 | `ps -p <pid> -o comm=` 실제 출력 | `ps -p $(pgrep -n claude) -o comm=` | 경로 또는 이름 한 줄(우리는 basename 소문자로 본다) | 이름에 `claude` 가 안 들어가면 유령 정리가 건너뛴다(D-17) → 실제 문자열을 기록 |
| D9 | `LC_ALL=C ps -o lstart=` 형식 | `LC_ALL=C ps -p $$ -o lstart=` | `Mon Sep 29 10:11:12 2026` 꼴 | 다르면 `parseLstart` 정규식을 그 형식으로 넓힌다(부모 감시 pid 재사용 판정이 여기에 달려 있다) |
| D10 | 트리 종료가 실제로 자식까지 잡는다 | 일하는 중 `ps -axo pid=,ppid= \| grep <데몬 pid>` 로 자식 확인 → 데몬에 `kill -9 <pid>` → 앱 재시작(또는 `npm start`) → `ps aux \| grep -E "claude\|codex"` | 남는 프로세스 0 | 남으면 `killTree` 의 순서·권한 확인(자식이 `init` 에 재부모됐는지) |
| D11 | **`SIGHUP`**: 터미널을 닫으면 정리가 끝까지 돈다 | `npm start` 한 터미널 창을 그냥 닫기 → `ps aux \| grep -E "claude\|codex\|tsx"` · `tail ~/Library/Application\ Support/pixel-office/daemon.log` | 로그에 `SIGHUP — shutting down` + `bye`, 프로세스 0 | 로그가 끊기면 SIGHUP 뒤 살 시간이 없는 것 → `SIGHUP` 에서는 강제 종료 상한을 따로 둘지 판단 |
| D12 | 단일 데몬 가드 문구가 맥 명령으로 나온다 | 데몬 하나 띄운 채 `npm start` 한 번 더 | `kill <pid>` · `lsof -i :7421` 이 보이고 exit 3 | `taskkill`/`netstat` 이 보이면 안내 문구 분기 누락 |
| D13 | 부모 감시가 맥에서 돈다 | 앱으로 띄운 뒤 앱을 `kill -9` | 몇 초 안에 데몬·세션 0, 로그에 `부모 앱이 사라졌다` | pid 재사용 판정이 늘 실패하면 D9 형식 문제 |
| D14 | 사용량 확인이 셰뱅 실행 파일로도 된다 | 기동 로그의 `usage`/`probe` 줄, `연결 확인` 결과 | `connected` | `execFile` 이 ENOENT 면 D4 경로 문제 |
| D15 | 화면 패턴이 맥에서 같은가 | M3 에서 신뢰 다이얼로그·준비 문구, `/usage`·`/status`(M14) | 윈도우와 같은 판정 | 다르면 `PIXEL_SCREEN_DEBUG=1` 덤프로 `src/tui-maps/claude-2.1-darwin.json` 을 만든다(로더는 이미 그 이름을 먼저 찾는다) |
| D16 | pty 세션이 끝난 뒤 데몬이 매달리지 않는다 | 멤버 퇴근(`fire`) 또는 `/exit` 뒤 `npm test`·데몬 종료가 멈추지 않는지 | 정상 종료 | 유닉스 node-pty 가 fd 를 쥐면(우리는 ConPTY 처방을 끄고 있다) 그 사실을 기록하고 유닉스용 해제 경로를 만든다 |

결과는 `docs/worklog/T48-3-MacLive.md` 에 표로, 다르게 동작한 것은 04 에 D-## 로.

## 남은 것

- **맥 실기 전부**(위 D1~D16 · 설계 2단계 M1~M6). 이 PC 에서는 할 수 없다.
- `tui-maps/*-darwin.json` — 로더 규칙만 넣었고 파일은 맥 실측 뒤에.
- 앱 쪽(T48-2)·문서 마무리(T48-3)는 다른 태스크. **앱과 데몬이 지켜야 하는 계약은 딱 둘이다**:
  데이터 폴더 규칙(`PIXEL_DATA_DIR` → OS 별 기본, 위 표)과 환경변수 이름(`PIXEL_DATA_DIR`·`PIXEL_NPM_PREFIX`·`PIXEL_NODE`).
- 리눅스 실기는 하지 않는다(설계 범위 밖 — 분기는 유닉스 공통으로 들어가 있다).
