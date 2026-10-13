// 멤버별 xterm `Terminal` 캐시(T18, T13 남은 것 "탭을 오갈 때 스크롤백 리셋").
//
// `TabBarView` 는 보이지 않는 탭을 내리므로 TerminalTab 은 탭을 오갈 때마다 dispose/initState 된다. Terminal 을
// State 가 들고 있으면 그때마다 새 버퍼가 되어 스크롤백이 사라진다. 그래서 Terminal 을 여기(멤버 id → 항목)에 두고
// 탭은 attach/detach(데몬 쪽 구독)만 한다. 항목은 앱이 사는 동안 유지된다(멤버 수는 한 자리라 상한 없음).
//
//  terminalCacheProvider      TerminalCache — `of(memberId)` 가 없으면 만든다.
//  CachedTerminal             terminal + attached(데몬 attach 여부 — onResize 를 attach 된 뒤에만 보내기 위해 탭이 갱신).
//  onOutput(키 입력)  → member.type{memberId, data}   onResize → member.resize{memberId, cols, rows}(attached 일 때만)
//  결과가 필요 없는 호출이라 실패는 삼킨다(끊김 중 타이핑 등).

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:xterm/xterm.dart';

import '../rpc/rpc_client.dart';
import '../state/office_state.dart';

/// 스크롤백 줄 수.
const int terminalMaxLines = 5000;

/// PROTOCOL 이 허용하는 터미널 크기.
const int terminalMinCols = 20;
const int terminalMaxCols = 500;
const int terminalMinRows = 5;
const int terminalMaxRows = 300;

/// 뷰 크기 → 데몬에 보낼 cols/rows(레이아웃 전이면 xterm 기본값 80×24).
int terminalCols(Terminal t) => t.viewWidth.clamp(terminalMinCols, terminalMaxCols);
int terminalRows(Terminal t) => t.viewHeight.clamp(terminalMinRows, terminalMaxRows);

/// 휠 버튼의 **표준** 보고 번호(xterm ctlseqs: 64 위 · 65 아래 · 66 왼쪽 · 67 오른쪽).
int wheelButtonCode(TerminalMouseButton b) => switch (b) {
      TerminalMouseButton.wheelUp => 64,
      TerminalMouseButton.wheelDown => 65,
      TerminalMouseButton.wheelLeft => 66,
      TerminalMouseButton.wheelRight => 67,
      _ => b.id,
    };

/// 휠 보고를 **표준 번호**로 고쳐 보낸다(U-03).
///
/// xterm 패키지 4.0.0 은 휠을 `64 + 4`(68)·`64 + 5`(69)로 보고한다. 마우스 프로토콜에서 4 는 **Shift 수정자
/// 비트**라 받는 쪽에는 "Shift+휠" 로 보인다. Claude 의 전체 화면 렌더러(`tui: fullscreen` — alt 버퍼라 스크롤백이
/// 없고 **휠을 직접 받아** 자기 대화를 넘긴다)는 그걸 무시한다 — 실측: 64 는 스크롤되고 68 은 인코딩과 무관하게
/// 안 된다. 그래서 터미널 탭에서 위로 넘겨 볼 방법이 없었다.
///
/// **위치도 고친다**(U-07). 같은 패키지의 스크롤 처리기는 휠 위치를 `event.position`(**창 전체 기준** 좌표)으로
/// 칸을 계산한다 — 터미널 탭은 창의 오른쪽 아래에 있으니 열은 맨 오른쪽, 행은 맨 아래로 잘린다. Claude 는 휠의
/// 위치를 안 봐서 드러나지 않았지만 **Codex 는 포인터가 대화 영역 위에 있을 때만 넘긴다**(실측: 입력창·바닥줄 행에
/// 대고 굴리면 무시) — 그래서 Codex 터미널만 스크롤이 안 됐다. [pointerCell] 이 진짜 칸을 주면 그걸 쓴다.
///
/// 휠만 가로챈다. 클릭·이동은 null 을 돌려 뒤의 기본 처리기로 넘긴다.
class StandardWheelMouseHandler implements TerminalMouseHandler {
  const StandardWheelMouseHandler({this.pointerCell});

  /// 지금 포인터가 올라가 있는 칸(터미널 뷰 기준). 모르면 null → 패키지가 준 위치를 그대로 쓴다.
  final CellOffset? Function()? pointerCell;

  @override
  String? call(TerminalMouseEvent event) {
    if (!event.button.isWheel) return null;
    // 앱(CLI)이 마우스를 달라고 하지 않았으면 보고하지 않는다 — 그때는 뷰가 스크롤백을 넘기거나 화살표로 흉내 낸다.
    final mode = event.state.mouseMode;
    if (mode == MouseMode.none || mode == MouseMode.clickOnly) return null;
    // 휠에는 "뗌" 이 없다.
    if (event.buttonState == TerminalMouseButtonState.up) return null;
    final code = wheelButtonCode(event.button);
    final at = pointerCell?.call() ?? event.position;
    final x = at.x + 1, y = at.y + 1; // 보고는 1 부터
    switch (event.state.mouseReportMode) {
      case MouseReportMode.sgr:
        return '\x1b[<$code;$x;${y}M';
      case MouseReportMode.urxvt:
        return '\x1b[${32 + code};$x;${y}M';
      case MouseReportMode.normal:
      case MouseReportMode.utf:
        // 한 바이트에 싣는 옛 인코딩 — 좌표 상한을 넘으면 0 을 보낸다(패키지와 같은 규칙).
        final limit = event.state.mouseReportMode == MouseReportMode.normal ? 223 : 2015;
        String coord(int v) => v > limit ? '\x00' : String.fromCharCode(32 + v);
        return '\x1b[M${String.fromCharCode(32 + code)}${coord(x)}${coord(y)}';
    }
  }
}

/// 터미널 탭의 마우스 처리기: 휠은 표준 번호 + 진짜 위치로, 나머지는 패키지 기본 그대로.
TerminalMouseHandler terminalMouseHandlerFor(CellOffset? Function()? pointerCell) => CascadeMouseHandler([
      StandardWheelMouseHandler(pointerCell: pointerCell),
      const ClickMouseHandler(),
      const UpDownMouseHandler(),
    ]);

/// 위치를 모르는 기본 처리기(테스트·단독 사용).
final TerminalMouseHandler terminalMouseHandler = terminalMouseHandlerFor(null);

class CachedTerminal {
  CachedTerminal(this.memberId, this.terminal);

  final String memberId;
  final Terminal terminal;

  /// 데몬에 attach 된 상태인지(TerminalTab 이 갱신). resize 는 attach 뒤에만 의미가 있다.
  bool attached = false;

  /// 지금 포인터가 올라가 있는 칸(터미널 뷰 기준, 0 부터). TerminalTab 이 포인터 이벤트마다 갱신한다 — 휠 보고의
  /// 위치로 쓴다(U-07). 탭이 안 떠 있거나 포인터가 한 번도 안 올라왔으면 null.
  CellOffset? pointerCell;

  /// 데몬이 아는 크기(attach 파라미터 · 마지막 resize). null 이면 아직 아무것도 안 알렸다.
  ///
  /// **왜 기억하나(T40d ⑤)**: `onResize` 는 크기가 *바뀔 때* 한 번만 온다. attach 응답이 오기 전에
  /// 뷰가 커지면 그 한 번을 "아직 attach 전"이라고 흘려보내게 되고, 같은 크기로는 다시 오지 않아
  /// 데몬은 옛 크기를 영영 믿는다. attach 가 끝난 뒤 이 값과 지금 뷰 크기를 맞춰 보면 그 틈을 메운다.
  int? sentCols;
  int? sentRows;
}

class TerminalCache {
  TerminalCache(this._client);

  final RpcClient _client;
  final Map<String, CachedTerminal> _entries = {};

  int get length => _entries.length;

  bool contains(String memberId) => _entries.containsKey(memberId);

  /// 그 멤버의 Terminal(없으면 새로 만든다 — 같은 멤버는 항상 같은 인스턴스).
  CachedTerminal of(String memberId) => _entries.putIfAbsent(memberId, () => _create(memberId));

  /// 캐시에서 버린다(테스트·멤버 삭제 시).
  void remove(String memberId) => _entries.remove(memberId);

  CachedTerminal _create(String memberId) {
    late final CachedTerminal entry;
    entry = CachedTerminal(memberId, Terminal(maxLines: terminalMaxLines, mouseHandler: terminalMouseHandlerFor(() => entry.pointerCell)));
    entry.terminal.onOutput = (data) => _send('member.type', {'memberId': memberId, 'data': data});
    // 크기 이벤트도 attach와 같은 허용 범위로 자른다.
    // xterm calls onResize before updating viewWidth/viewHeight. Use event dimensions.
    entry.terminal.onResize = (cols, rows, _, _) => syncSize(entry, newCols: cols, newRows: rows);
    return entry;
  }

  /// 뷰 크기가 데몬이 아는 크기와 다르면 `member.resize`. attach 전에는 보내지 않는다(그때는
  /// attach 파라미터가 크기를 알린다) — 대신 [markAttached] 가 붙자마자 같은 검사를 한 번 더 한다.
  void syncSize(CachedTerminal entry, {int? newCols, int? newRows}) {
    if (!entry.attached) return;
    final cols = (newCols ?? entry.terminal.viewWidth).clamp(terminalMinCols, terminalMaxCols);
    final rows = (newRows ?? entry.terminal.viewHeight).clamp(terminalMinRows, terminalMaxRows);
    if (cols == entry.sentCols && rows == entry.sentRows) return;
    entry.sentCols = cols;
    entry.sentRows = rows;
    _send('member.resize', {'memberId': entry.memberId, 'cols': cols, 'rows': rows});
  }

  /// attach 응답이 왔다 — 데몬에 알린 크기를 적어 두고, 그 사이 뷰가 바뀌었으면 곧바로 resize.
  void markAttached(CachedTerminal entry, {required int cols, required int rows}) {
    entry.attached = true;
    entry.sentCols = cols;
    entry.sentRows = rows;
    syncSize(entry);
  }

  /// detach·연결 끊김 — 데몬이 아는 크기도 잊는다(다시 붙을 때 새로 알린다).
  void markDetached(CachedTerminal entry) {
    entry.attached = false;
    entry.sentCols = null;
    entry.sentRows = null;
  }

  void _send(String method, Map<String, dynamic> params) {
    unawaited(_client.call(method, params).then((_) {}, onError: (Object _) {}));
  }
}

final terminalCacheProvider = Provider<TerminalCache>((ref) => TerminalCache(ref.watch(rpcClientProvider)));
