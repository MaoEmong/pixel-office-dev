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

class CachedTerminal {
  CachedTerminal(this.memberId, this.terminal);

  final String memberId;
  final Terminal terminal;

  /// 데몬에 attach 된 상태인지(TerminalTab 이 갱신). resize 는 attach 뒤에만 의미가 있다.
  bool attached = false;
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
    entry.terminal.onResize = (w, h, _, _) {
      if (entry.attached) _send('member.resize', {'memberId': memberId, 'cols': w, 'rows': h});
    };
    return entry;
  }

  void _send(String method, Map<String, dynamic> params) {
    unawaited(_client.call(method, params).then((_) {}, onError: (Object _) {}));
  }
}

final terminalCacheProvider = Provider<TerminalCache>((ref) => TerminalCache(ref.watch(rpcClientProvider)));
