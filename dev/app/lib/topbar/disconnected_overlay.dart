// 데몬 끊김 오버레이(T40-5, 레이아웃 v2 §3 패스 2 D10 · 패스 3 스토리보드 1단계 · 패스 4 하드리젝션 ②).
//
//   [pill 과 같은 한 줄]  끊김 · 재시도 2회 / 연결 중 · 3초
//   [다음 재시도까지의 진행 바]  (RpcClient 의 backoff 주기 1→2→4→5초)
//   [데몬 시작]  [다시 연결]        ← 주 버튼 하나 + 보조 하나
//   자세히 ▸  (예외 문자열은 접힘 — 사무실 전체에 스택 트레이스를 뿌리지 않는다)

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../rpc/rpc_client.dart';
import '../state/office_state.dart';
import 'daemon_launcher.dart';
import 'daemon_pill.dart';

/// 오버레이 제목(pill 문구 위에 놓이는 한 문장).
const String disconnectedTitle = '데몬에 연결되어 있지 않습니다';

/// 예외 접기 버튼.
const String disconnectedDetailsLabel = '자세히';

/// 시도 [attempts] 회 실패 뒤 다음 재시도까지의 대기(RpcClient `_loop` 와 같은 규칙: min×2^(n-1), max 상한).
Duration backoffForAttempt(int attempts, {required Duration min, required Duration max}) {
  if (attempts <= 1) return min;
  var d = min;
  for (var i = 1; i < attempts; i++) {
    d *= 2;
    if (d >= max) return max;
  }
  return d;
}

class DisconnectedOverlay extends ConsumerStatefulWidget {
  const DisconnectedOverlay({super.key});

  @override
  ConsumerState<DisconnectedOverlay> createState() => _DisconnectedOverlayState();
}

class _DisconnectedOverlayState extends ConsumerState<DisconnectedOverlay> {
  Timer? _tick;
  DateTime _since = DateTime.now();
  int _lastAttempts = -1;
  bool _details = false;

  @override
  void initState() {
    super.initState();
    // 진행 바를 0.1초마다 움직인다(끊긴 동안만 도는 타이머 — 오버레이가 사라지면 같이 죽는다).
    _tick = Timer.periodic(const Duration(milliseconds: 100), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final connection = ref.watch(connectionStateProvider);
    final attempts = ref.watch(reconnectAttemptsProvider);
    final error = ref.watch(officeProvider.select((s) => s.lastError));
    final client = ref.watch(rpcClientProvider);
    if (attempts != _lastAttempts) {
      _lastAttempts = attempts;
      _since = DateTime.now();
    }
    final wait = backoffForAttempt(attempts, min: client.minBackoff, max: client.maxBackoff);
    final elapsed = DateTime.now().difference(_since);
    final progress = connection == RpcConnectionState.connecting
        ? null // 붙는 중에는 불확정
        : (elapsed.inMilliseconds / wait.inMilliseconds).clamp(0.0, 1.0);

    return Positioned.fill(
      child: Container(
        color: Colors.grey.shade900.withValues(alpha: 0.82),
        alignment: Alignment.center,
        child: SizedBox(
          width: 360,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.power_off, size: 48, color: Colors.white54),
              const SizedBox(height: 12),
              const Text(disconnectedTitle, style: TextStyle(fontSize: 20, color: Colors.white)),
              const SizedBox(height: 8),
              // pill 과 **같은 문구** — 화면 두 곳이 다른 말을 하지 않게.
              Text(
                daemonPillLabel(connection, attempts: attempts),
                key: const Key('overlay.status'),
                style: TextStyle(color: daemonPillColor(connection), fontSize: 13),
              ),
              const SizedBox(height: 10),
              ClipRRect(
                borderRadius: BorderRadius.circular(2),
                child: LinearProgressIndicator(
                  key: const Key('overlay.progress'),
                  value: progress,
                  minHeight: 4,
                  backgroundColor: Colors.white12,
                  color: daemonPillColor(connection),
                ),
              ),
              const SizedBox(height: 4),
              Text(
                connection == RpcConnectionState.connecting ? '붙는 중…' : '다음 재시도까지 ${wait.inSeconds}초',
                style: const TextStyle(color: Colors.white38, fontSize: 11),
              ),
              const SizedBox(height: 16),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const DaemonStartButton(), // 주 버튼
                  const SizedBox(width: 12),
                  OutlinedButton(
                    key: const Key('overlay.retry'),
                    onPressed: client.retryNow,
                    child: const Text('다시 연결'),
                  ),
                ],
              ),
              if (error != null) ...[
                const SizedBox(height: 8),
                TextButton(
                  key: const Key('overlay.details'),
                  style: TextButton.styleFrom(
                    visualDensity: VisualDensity.compact,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    foregroundColor: Colors.white38,
                    textStyle: const TextStyle(fontSize: 12),
                  ),
                  onPressed: () => setState(() => _details = !_details),
                  child: Text(_details ? '$disconnectedDetailsLabel 접기' : '$disconnectedDetailsLabel ▸'),
                ),
                if (_details)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: SelectableText(
                      error,
                      key: const Key('overlay.error'),
                      style: const TextStyle(color: Colors.white38, fontSize: 11),
                      textAlign: TextAlign.center,
                    ),
                  ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
