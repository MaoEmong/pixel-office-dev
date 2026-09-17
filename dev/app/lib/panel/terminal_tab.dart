// 터미널 탭 — xterm `TerminalView` 에 그 멤버의 실제 CLI 화면을 붙인다.
//
//  Terminal 인스턴스는 `terminalCacheProvider`(멤버별, T18)가 들고 있다 — 탭을 오가도 같은 버퍼(스크롤백 유지).
//  탭이 보이면(initState → 첫 프레임 뒤)      member.attach{memberId, cols, rows} → screen 을 써넣고
//  연결될 때마다(connectionStateProvider)     다시 attach (재접속 규칙 3: term 은 replay 되지 않는다)
//  `term{memberId, data}` 알림                 → terminal.write(data)        (RpcClient.notifications 직접 구독)
//  terminal.onOutput / onResize                → member.type / member.resize (terminal_cache.dart 가 배선)
//  탭이 숨겨지거나(dispose) 멤버가 바뀌면     → member.detach{memberId}   (Terminal 은 캐시에 남는다)
//
// attach 실패(-32003: 이 데몬 세션에서 스폰된 적 없는 멤버 등)는 탭 위 배너로 보여 준다.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:xterm/xterm.dart';

import '../rpc/rpc_client.dart';
import '../state/office_state.dart';
import 'labels.dart';
import 'terminal_cache.dart';

export 'terminal_cache.dart' show terminalMaxLines;

class TerminalTab extends ConsumerStatefulWidget {
  const TerminalTab({super.key, required this.memberId, this.fontSize = 13, this.autofocus = true});

  final String memberId;
  final double fontSize;
  final bool autofocus;

  @override
  ConsumerState<TerminalTab> createState() => _TerminalTabState();
}

class _TerminalTabState extends ConsumerState<TerminalTab> {
  late CachedTerminal _entry;
  StreamSubscription<RpcNotification>? _termSub;
  ProviderSubscription<RpcConnectionState>? _connSub;

  bool _attaching = false;

  /// 배너 문구(attach 오류·연결 끊김). null 이면 배너 없음.
  String? _notice;

  /// 멤버 교체·dispose 뒤 도착한 늦은 attach 응답을 버리기 위한 세대 번호.
  int _generation = 0;

  /// dispose 에서 detach 를 보내야 하므로 initState 에서 잡아 둔다(unmount 뒤에는 ref 를 쓸 수 없다).
  late final RpcClient _client;
  late final TerminalCache _cache;

  @override
  void initState() {
    super.initState();
    _client = ref.read(rpcClientProvider);
    _cache = ref.read(terminalCacheProvider);
    _entry = _cache.of(widget.memberId);
    _cache.markDetached(_entry);
    _termSub = _client.notifications.listen(_onNotification);
    _connSub = ref.listenManual<RpcConnectionState>(connectionStateProvider, (prev, next) {
      if (next == RpcConnectionState.connected) {
        if (prev != RpcConnectionState.connected) _attach();
      } else {
        _cache.markDetached(_entry);
        if (mounted) setState(() => _notice = '데몬 연결 끊김 — 재접속되면 화면을 다시 받습니다');
      }
    });
    // 첫 프레임 뒤: TerminalView 가 레이아웃되어 viewWidth/viewHeight 가 실제 크기다.
    WidgetsBinding.instance.addPostFrameCallback((_) => _attach());
  }

  @override
  void didUpdateWidget(covariant TerminalTab old) {
    super.didUpdateWidget(old);
    if (old.memberId != widget.memberId) {
      _cache.markDetached(_entry);
      _detach(old.memberId);
      _generation++;
      _attaching = false;
      _notice = null;
      _entry = _cache.of(widget.memberId);
      WidgetsBinding.instance.addPostFrameCallback((_) => _attach());
    }
  }

  @override
  void dispose() {
    _generation++;
    _termSub?.cancel();
    _connSub?.close();
    _cache.markDetached(_entry);
    _detach(widget.memberId);
    super.dispose();
  }

  /// 결과가 필요 없는 호출. 실패는 조용히 삼킨다(끊김 중 등).
  void _send(String method, Map<String, dynamic> params) {
    unawaited(_client.call(method, params).then((_) {}, onError: (Object _) {}));
  }

  void _detach(String memberId) => _send('member.detach', {'memberId': memberId});

  Future<void> _attach() async {
    if (!mounted || _attaching) return;
    if (ref.read(connectionStateProvider) != RpcConnectionState.connected) {
      setState(() => _notice = '데몬 연결 안 됨');
      return;
    }
    final memberId = widget.memberId;
    final gen = _generation;
    final entry = _entry;
    final terminal = entry.terminal;
    _attaching = true;
    setState(() => _notice = null);
    try {
      // 레이아웃 전이면 xterm 기본값(80x24). PROTOCOL 허용 범위(cols 20~500, rows 5~300) 안으로.
      final cols = terminalCols(terminal);
      final rows = terminalRows(terminal);
      final r = await _client.call('member.attach', {'memberId': memberId, 'cols': cols, 'rows': rows});
      if (!mounted || gen != _generation) {
        // 그 사이 멤버가 바뀌었거나 탭이 닫혔다 — 데몬 쪽 attach 를 되돌린다.
        _detach(memberId);
        return;
      }
      // 재attach 면 이전 화면이 남아 있으므로 뷰포트를 비우고(스크롤백은 유지) 현재 화면을 쓴다.
      terminal.write('\x1b[H\x1b[2J');
      terminal.write((r['screen'] as String?) ?? '');
      // 응답을 기다리는 사이에 뷰가 넓어졌으면(패널 폭 480 → 660) 여기서 곧바로 resize 가 나간다 —
      // `onResize` 는 그 사이 "아직 attach 전"이라 흘려보냈고 같은 크기로는 다시 오지 않는다(T40d ⑤).
      _cache.markAttached(entry, cols: cols, rows: rows);
      setState(() => _notice = null);
    } on RpcException catch (e) {
      if (!mounted || gen != _generation) return;
      _cache.markDetached(entry);
      setState(() => _notice = describeAttachError(e));
    } finally {
      if (gen == _generation) _attaching = false;
    }
  }

  void _onNotification(RpcNotification n) {
    if (n.method != 'term' || n.params['memberId'] != widget.memberId) return;
    final data = n.params['data'];
    if (data is String && data.isNotEmpty) _entry.terminal.write(data);
  }

  @override
  Widget build(BuildContext context) {
    final status = ref.watch(memberStatusProvider(widget.memberId));
    final gone = status?.isGone ?? false;
    final banner = _notice ?? (gone ? '${memberStatusLabel(status!)}한 멤버 — 마지막 화면' : null);
    // 배너는 터미널 위에 띄운다(Stack). Column 에 넣으면 배너가 생기고 사라질 때마다 터미널 rows 가 바뀌어
    // attach 시점의 크기와 실제 크기가 어긋난다(연결 전 배너 → 연결 후 attach → 배너 제거 → resize).
    return Stack(
      fit: StackFit.expand,
      children: [
        ColoredBox(
          color: Colors.black,
          child: TerminalView(
            _entry.terminal,
            textStyle: TerminalStyle(fontSize: widget.fontSize, fontFamily: panelMonoFamily, fontFamilyFallback: panelMonoFallback),
            autofocus: widget.autofocus,
            padding: const EdgeInsets.all(4),
          ),
        ),
        if (banner != null)
          Positioned(
            left: 0,
            right: 0,
            top: 0,
            child: Material(
              color: _notice != null ? const Color(0xE6512020) : const Color(0xCC303030),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                child: Row(
                  children: [
                    Icon(_notice != null ? Icons.error_outline : Icons.info_outline, size: 14, color: Colors.white70),
                    const SizedBox(width: 6),
                    Expanded(child: Text(banner, style: const TextStyle(fontSize: 12, color: Colors.white70))),
                    if (_notice != null && !_attaching)
                      TextButton(
                        onPressed: _attach,
                        style: TextButton.styleFrom(
                          visualDensity: VisualDensity.compact,
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                        ),
                        child: const Text('다시 붙이기', style: TextStyle(fontSize: 12)),
                      ),
                  ],
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// attach 오류 → 배너 문구.
String describeAttachError(RpcException e) => switch (e.code) {
      RpcException.badState => '이 데몬 세션에서 스폰되지 않은 멤버라 터미널을 붙일 수 없습니다 (재출근/재고용 필요)',
      RpcException.notFound => '멤버를 찾을 수 없습니다',
      RpcException.invalidParams => '터미널 크기가 허용 범위(20~500 × 5~300) 밖입니다: ${e.message}',
      RpcException.closed => '데몬 연결 안 됨',
      RpcException.timeout => '데몬 응답 없음(타임아웃)',
      _ => 'attach 실패: ${e.message}',
    };
