# T53 — Codex 터미널 탭에서 스크롤이 안 되던 것 (U-07)

- 날짜: 2026-10-11
- 앞선 기록: `docs/05-실사용-문제.md` U-07(증상 · 추정 · 실제 원인), `docs/worklog/T52-UsageFixes.md`(U-03)
- 브랜치: `T53-codex-scroll`(`T52-usage-fixes` 위). 워크트리에서 작업 — 원본에서 데몬·앱이 돌고 있었다.
- 환경: macOS 26.6 / arm64 · **codex-cli 0.159.0** · claude 2.1.293 · xterm(Dart) 4.0.0
- 커밋: `3b6b106`

## 목표

T52 가 U-03(터미널 스크롤)을 Claude 로만 확인하고 Codex 는 "인라인 렌더라 원래 된다" 고 적었다. 사용자가 새 빌드에서
Codex 터미널이 안 넘어가는 것을 발견했다. 그 한 줄은 확인 없이 적은 것이었고 틀렸다 — 이번에는 추정으로 고르지 않는다.

## 어떻게 좁혔나

U-07 에 적어 둔 갈래 넷(Codex 가 휠을 안 받는다 · 모양이 다르다 · kitty 키보드 · 데몬이 먹는다)은 **전부 아니었다.**

| 단계 | 한 것 | 결과 |
|---|---|---|
| 1 | codex 를 pty 로 띄워 휠을 직접 넣음 | SGR · 옛 인코딩 · 버튼 68 · PgUp/PgDn · Shift+↑ 전부 넘어간다 → **Codex 는 멀쩡** |
| 2 | 진짜 데몬에 Codex 멤버를 띄워 `member.type` 으로 휠 | 넘어간다 → **데몬도 멀쩡** |
| 3 | 데몬을 내렸다 올려 resume 된 세션에서 다시 | 넘어간다 → **resume 도 무관** |
| 4 | codex 의 실제 화면(원시 출력 · serialize)을 앱 터미널 위젯에 흘려 넣고 휠 | `ESC[<64;x;yM` 이 나간다 → **모드 전달도 멀쩡** |
| 5 | 1~4 가 전부 (20,10) 에 대고 한 것임을 깨닫고 **위치를 바꿔 봄** | 아래 |

```
O 휠업 @ (열 20, 행 10)    LINE-50…70 → LINE-32…54
O 휠업 @ (열 100, 행 10)
x 휠업 @ (열 20, 행 1)
O 휠업 @ (열 20, 행 24)
x 휠업 @ (열 20, 행 25 ~ 30)     ← 입력창 · 상태줄
```

**Codex 는 포인터가 대화 영역 위에 있을 때만 휠로 대화를 넘긴다.** Claude 는 위치를 안 본다.

## 원인

xterm 패키지 4.0.0 `lib/src/ui/scroll_handler.dart`:

```dart
onPointerSignal: (event) { lastPointerPosition = event.position; },   // 창 전체 기준 좌표
…
final position = widget.getCellOffset(lastPointerPosition);           // 뷰 기준 좌표를 기대한다
```

- **마우스 휠**: 터미널 탭은 창의 오른쪽 아래에 있다 → 열은 맨 오른쪽, 행은 맨 아래로 잘린다 → Codex 에게는 입력창에 대고 굴린 휠.
- **트랙패드**: `onPointerSignal`·`onPointerDown` 만 위치를 적는데 트랙패드 두 손가락은 그 둘이 아니다 → 위치가 **한 번도 안 바뀌어 늘 (1,1)**. 그 행도 Codex 가 무시한다.

같은 처리기에 버그가 둘 있었다 — 휠 **번호**(68, U-03)와 휠 **위치**(U-07). Claude 는 번호에 걸리고 Codex 는 위치에 걸렸다.

## 한 것

- `dev/app/lib/panel/terminal_tab.dart`: `TerminalView` 를 `Listener` 로 감싸 포인터 위치(hover · down · move · signal · panZoomStart)를
  `renderTerminal.globalToLocal` → `getCellOffset` 으로 **뷰 기준 칸**으로 바꿔 `CachedTerminal.pointerCell` 에 적는다. 탭이 내려가면 지운다.
- `dev/app/lib/panel/terminal_cache.dart`: `StandardWheelMouseHandler` 가 패키지가 준 위치 대신 `pointerCell` 을 쓴다(모르면 예전대로).
  처리기를 터미널마다 만든다(`terminalMouseHandlerFor`).
- `dev/daemon/test/office/codexscroll.integration.test.ts`(opt-in): 진짜 codex 로 "바닥 행 · (1,1) 은 무시, 대화 영역은 넘어감" 을 못 박는다.
  CLI 가 바뀌어 이 동작이 달라지면 여기서 먼저 보인다.

## 검증

```
$ cd dev/app && flutter test && dart analyze lib test
+742 ~2: All other tests passed!      No issues found!

$ cd dev/daemon && npm test
ℹ tests 1196   ℹ pass 1185   ℹ fail 0   ℹ skipped 11

$ PIXEL_IT=1 PIXEL_IT_SANDBOX=… node --import tsx --test test/office/codexscroll.integration.test.ts
[IT] attach modes = ?1049h ?2004h ?1004h ?1003h ?1006h
[IT] 처음 = LINE-46…LINE-70
[IT] 휠업 @ 바닥 행(100,30) → LINE-50…LINE-70
[IT] 휠업 @ (1,1) → LINE-50…LINE-70
[IT] 휠업 @ 대화 영역(20,10) → LINE-26…LINE-48
[IT] 휠다운 @ 대화 영역 → LINE-50…LINE-70
✔ real codex: 휠은 대화 영역 위에서만 대화를 넘긴다 — 바닥 행에서는 무시
```

새 위젯 테스트를 **고치기 전 코드**로 돌리면 실패한다 — 휠은 `ESC[<64;36;10M`(기대 `5;3`), 트랙패드는 `ESC[<64;1;1M`(기대 `9;6`).

**실제 앱 창**: 사용자가 새 빌드에서 Codex 터미널이 넘어가는 것을 확인했다(2026-10-11).

## 발견한 함정

1. **"되는 자리" 에서만 시험하면 안 보인다.** 단계 1~4 를 전부 (20,10) 에 대고 했고 전부 통과했다. 실제 앱이 보내는 좌표로는 한 번도 안 해 본 것이다.
2. **화면이 "넘어갔는가" 를 첫 줄로 판단하면 틀린다.** Codex 는 다시 그릴 때 바닥줄 높이가 달라져 보이는 첫 줄이 바뀐다(LINE-44 → 50). 보이는 **마지막 줄**이 70 인가로 본다.
3. **엔진이 둘이면 둘 다 실기로.** T52 는 Claude 실기만 돌리고 Codex 칸에 단정을 적었다. 안 돌린 쪽에는 "확인 안 함" 만 적는다.

## 남은 것

- **U-06** Codex 멤버의 모델이 첫 일을 받은 뒤에야 뜬다 — 기록만 되어 있다.
- U-02(허가 방식)의 Codex 쪽 — `apply_patch` 판정은 단위 테스트뿐이고 실기 전이다.
- Codex 터미널에서 포인터가 입력창 위에 있으면 안 넘어간다 — Codex 의 동작이라 그대로 둔다.
