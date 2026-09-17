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

class CachedTerminal {
  CachedTerminal(this.memberId, this.terminal);

  final String memberId;
  final Terminal terminal;

  /// 데몬에 attach 된 상태인지(TerminalTab 이 갱신). resize 는 attach 뒤에만 의미가 있다.
  bool attached = false;

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
    final entry = CachedTerminal(memberId, Terminal(maxLines: terminalMaxLines));
    entry.terminal.onOutput = (data) => _send('member.type', {'memberId': memberId, 'data': data});
    // 크기는 이벤트 인자가 아니라 터미널에서 다시 읽는다 — attach 와 같은 clamp 를 태우려고.
    entry.terminal.onResize = (_, _, _, _) => syncSize(entry);
    return entry;
  }

  /// 뷰 크기가 데몬이 아는 크기와 다르면 `member.resize`. attach 전에는 보내지 않는다(그때는
  /// attach 파라미터가 크기를 알린다) — 대신 [markAttached] 가 붙자마자 같은 검사를 한 번 더 한다.
  void syncSize(CachedTerminal entry) {
    if (!entry.attached) return;
    final cols = terminalCols(entry.terminal);
    final rows = terminalRows(entry.terminal);
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
