// 데몬 상태 pill 3상태(T40-5, 레이아웃 v2 §3 패스 2 D10):
//
//   초록  ● 데몬 v1.0 · pid 1234
//   노랑  ◌ 연결 중 · 3초        (1Hz 점멸)
//   빨강  ● 끊김 · 재시도 2회
//
// 끊김 오버레이(disconnected_overlay.dart)가 같은 문구를 쓴다 — 한 줄만 보고도 어디가 막혔는지 알게.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../office/office_painter.dart' show legendColor;
import '../office/office_scene.dart' show LegendSlot;
import '../rpc/rpc_client.dart';
import '../state/office_state.dart';

/// pill 색 3종(범례와 같은 팔레트).
const Color daemonOkColor = Color(0xFF7ED3A1);
const Color daemonBusyColor = Color(0xFFFFC857);
const Color daemonDownColor = Color(0xFFFF6B6B);

/// 점멸 주기(1Hz = 0.5초마다 뒤집는다).
const Duration daemonBlinkHalfPeriod = Duration(milliseconds: 500);

/// pill·오버레이가 같이 쓰는 문구.
String daemonPillLabel(
  RpcConnectionState connection, {
  String? version,
  int? pid,
  int attempts = 0,
  int seconds = 0,
}) =>
    switch (connection) {
      RpcConnectionState.connected => '데몬 v${version ?? '?'}${pid != null ? ' · pid $pid' : ''}',
      RpcConnectionState.connecting => '연결 중 · $seconds초',
      RpcConnectionState.disconnected => '끊김 · 재시도 $attempts회',
    };

Color daemonPillColor(RpcConnectionState connection) => switch (connection) {
      RpcConnectionState.connected => daemonOkColor,
      RpcConnectionState.connecting => daemonBusyColor,
      RpcConnectionState.disconnected => daemonDownColor,
    };

class DaemonPill extends ConsumerStatefulWidget {
  const DaemonPill({super.key});

  @override
  ConsumerState<DaemonPill> createState() => _DaemonPillState();
}

class _DaemonPillState extends ConsumerState<DaemonPill> {
  Timer? _tick;

  /// `연결 중` 에 들어간 시각(초 세기).
  DateTime? _connectingSince;

  /// 점멸 위상(노랑일 때만 쓴다).
  bool _on = true;

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  void _sync(RpcConnectionState state) {
    if (state == RpcConnectionState.connecting) {
      _connectingSince ??= DateTime.now();
      _tick ??= Timer.periodic(daemonBlinkHalfPeriod, (_) {
        if (mounted) setState(() => _on = !_on);
      });
    } else {
      _connectingSince = null;
      _tick?.cancel();
      _tick = null;
      _on = true;
    }
  }

  int get _seconds {
    final since = _connectingSince;
    return since == null ? 0 : DateTime.now().difference(since).inSeconds;
  }

  @override
  Widget build(BuildContext context) {
    final connection = ref.watch(connectionStateProvider);
    _sync(connection);
    final label = daemonPillLabel(
      connection,
      version: ref.watch(daemonVersionProvider),
      pid: ref.watch(daemonPidProvider),
      attempts: ref.watch(reconnectAttemptsProvider),
      seconds: _seconds,
    );
    final color = daemonPillColor(connection);
    final connecting = connection == RpcConnectionState.connecting;
    return Container(
      key: const Key('topbar.daemon'),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.5)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          AnimatedOpacity(
            key: const Key('topbar.daemon.dot'),
            opacity: connecting && !_on ? 0.25 : 1,
            duration: daemonBlinkHalfPeriod,
            child: Icon(connecting ? Icons.circle_outlined : Icons.circle, size: 8, color: color),
          ),
          const SizedBox(width: 6),
          Text(label, key: const Key('topbar.daemon.label'), style: const TextStyle(fontSize: 12)),
        ],
      ),
    );
  }
}

/// 상단 바 "보고 N" 배지(이슈 9) — 누르면 부장을 고르고 보고서 탭을 연다.
class ReportCountBadge extends StatelessWidget {
  const ReportCountBadge({super.key, required this.count, required this.onTap});

  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => InkWell(
        key: const Key('topbar.reports'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            color: legendColor(LegendSlot.idle).withValues(alpha: 0.18),
          ),
          child: Text(
            '보고 $count',
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: legendColor(LegendSlot.idle)),
          ),
        ),
      );
}
