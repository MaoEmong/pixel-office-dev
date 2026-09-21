// 사무실을 덮는 오버레이(T40-5 → T46-2). 한 화면에 상태 하나만 말한다.
//
//   정리하는 중…                                     앱을 닫는 중(수명주기 §2-3)
//   사무실을 여는 중…                                감시자가 데몬을 찾거나 띄우는 중(§1)
//   데몬이 멈춰 다시 시작하는 중 · 세션을 복구합니다   죽어서 다시 띄우는 중(§4) + `복구 2 / 5`
//   데몬을 시작하지 못했습니다                        10초 안에 못 붙음(§1) + daemon.log 마지막 8줄
//   데몬이 반복해서 종료됩니다                        1분에 3번 죽음(§4) + 같은 로그
//   데몬에 연결되어 있지 않습니다                     감시자가 없는 경우(콘솔 실행·테스트) — T40-5 의 화면 그대로
//
// 공통 규칙(패스 4 하드리젝션 ②): **예외 문자열은 "자세히" 로 접힌다.** 사무실 전체에 스택 트레이스를
// 뿌리지 않는다. "자세히" 는 오류가 없어도 열리고 안에는 찾아본 daemon.json 경로와 한 줄 힌트가 늘 있다(T41).
//
// "데몬 시작"(보이는 콘솔 창을 띄우는 옛 버튼)은 **실패 화면에만** 남는다(§1). 감시자가 없는 화면에서는
// 그 버튼이 유일한 시작 방법이므로 예전처럼 그대로 둔다.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../lifecycle/daemon_supervisor.dart';
import '../lifecycle/exit_flow.dart' show exitClosingLabel;
import '../lifecycle/lifecycle_providers.dart';
import '../model/models.dart' show DaemonNotice;
import '../panel/labels.dart' show panelMonoFallback, panelMonoFamily;
import '../rpc/daemon_info.dart';
import '../rpc/rpc_client.dart';
import '../state/office_state.dart';
import 'daemon_launcher.dart';
import 'daemon_pill.dart';

/// 오버레이 제목(pill 문구 위에 놓이는 한 문장) — 감시자가 없을 때.
const String disconnectedTitle = '데몬에 연결되어 있지 않습니다';

/// 예외 접기 버튼.
const String disconnectedDetailsLabel = '자세히';

/// 감시자가 데몬을 찾거나 띄우는 동안(수명주기 §1).
const String overlayOpeningLabel = '사무실을 여는 중…';

/// 데몬이 죽어 다시 띄우는 동안(수명주기 §4).
const String overlayRestartingLabel = '데몬이 멈춰 다시 시작하는 중 · 세션을 복구합니다';

/// 10초 안에 못 붙었다(§1).
const String overlayStartFailedTitle = '데몬을 시작하지 못했습니다';

/// 1분 안에 3번 죽었다(§4) — 원인을 덮지 않는다.
const String overlayCrashLoopTitle = '데몬이 반복해서 종료됩니다';

/// 실패 화면의 주 버튼.
const String overlayRetryLabel = '다시 시도';

/// 실패 화면에서 로그를 아직 못 읽었을 때.
const String overlayNoLogLabel = 'daemon.log 가 아직 비어 있습니다';

/// 복구 진행 표시(`복구 2 / 5`).
String recoveryProgressLabel(int done, int total) => '복구 $done / $total';

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
  const DisconnectedOverlay({super.key, this.daemonJsonPath});

  /// "자세히" 에 보여 줄 daemon.json 경로. 기본은 이 프로세스가 실제로 보는 곳(`DaemonInfo.defaultPath()`).
  final String? daemonJsonPath;

  @override
  ConsumerState<DisconnectedOverlay> createState() => _DisconnectedOverlayState();
}

class _DisconnectedOverlayState extends ConsumerState<DisconnectedOverlay> {
  Timer? _tick;
  DateTime _since = DateTime.now();
  int _lastAttempts = -1;
  bool _details = false;

  /// 실패 화면의 `daemon.log` 마지막 8줄(아직 안 읽었으면 null).
  List<String>? _logTail;
  bool _logRequested = false;

  @override
  void initState() {
    super.initState();
    // 진행 바를 0.1초마다 움직인다(덮여 있는 동안만 도는 타이머 — 오버레이가 사라지면 같이 죽는다).
    _tick = Timer.periodic(const Duration(milliseconds: 100), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  /// 실패 화면에 들어갈 때 한 번만 읽는다. `다시 시도` 로 빠져나가면 다시 읽는다.
  void _syncLogTail({required bool failed}) {
    if (!failed) {
      _logRequested = false;
      _logTail = null;
      return;
    }
    if (_logRequested) return;
    _logRequested = true;
    unawaited(() async {
      final lines = await ref.read(daemonLogTailProvider)();
      if (mounted) setState(() => _logTail = lines);
    }());
  }

  @override
  Widget build(BuildContext context) {
    final closing = ref.watch(exitClosingProvider);
    final supervisor = ref.watch(supervisorStatusProvider);
    final recovery = ref.watch(recoveryProgressProvider);
    _syncLogTail(failed: supervisor?.isFailed ?? false);

    final Widget body;
    if (closing) {
      body = _simple(icon: Icons.cleaning_services_outlined, label: exitClosingLabel, key: 'overlay.closing');
    } else if (supervisor != null && supervisor.isFailed) {
      body = _failure(supervisor);
    } else if (supervisor != null && (supervisor.state == SupervisorState.restarting || recovery != null)) {
      body = _restarting(recovery);
    } else if (supervisor != null && supervisor.isOpening) {
      body = _simple(icon: Icons.meeting_room_outlined, label: overlayOpeningLabel, key: 'overlay.opening');
    } else {
      body = _classic();
    }

    return Positioned.fill(
      child: Container(
        color: Colors.grey.shade900.withValues(alpha: 0.82),
        alignment: Alignment.center,
        // 실패 화면은 로그 8줄 + 버튼 둘이라 세로로 길다 — 작은 창(패스 6 최소 1100×?)에서 잘리지 않게 스크롤.
        child: SizedBox(
          width: 460,
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: body,
          ),
        ),
      ),
    );
  }

  // ---- 화면 조각 -------------------------------------------------------------------------

  /// 한 줄 + 불확정 진행 바(여는 중 · 정리하는 중).
  Widget _simple({required IconData icon, required String label, required String key}) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 48, color: Colors.white54),
          const SizedBox(height: 12),
          Text(label, key: Key(key), style: const TextStyle(fontSize: 20, color: Colors.white)),
          const SizedBox(height: 14),
          const SizedBox(
            width: 260,
            child: LinearProgressIndicator(
              key: Key('overlay.progress'),
              minHeight: 4,
              backgroundColor: Colors.white12,
              color: daemonBusyColor,
            ),
          ),
          const SizedBox(height: 10),
          _detailsToggle(),
        ],
      );

  /// 죽어서 다시 띄우는 중 + 복구 진행(§4).
  Widget _restarting(DaemonNotice? recovery) {
    final total = recovery?.total;
    final done = recovery?.done ?? 0;
    final hasProgress = total != null && total > 0;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Icon(Icons.restart_alt, size: 48, color: daemonBusyColor),
        const SizedBox(height: 12),
        const Text(
          overlayRestartingLabel,
          key: Key('overlay.restarting'),
          style: TextStyle(fontSize: 17, color: Colors.white),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 14),
        SizedBox(
          width: 260,
          child: LinearProgressIndicator(
            key: const Key('overlay.progress'),
            value: hasProgress ? (done / total).clamp(0.0, 1.0) : null,
            minHeight: 4,
            backgroundColor: Colors.white12,
            color: daemonBusyColor,
          ),
        ),
        if (hasProgress) ...[
          const SizedBox(height: 6),
          Text(
            recoveryProgressLabel(done, total),
            key: const Key('overlay.recovery'),
            style: const TextStyle(color: Colors.white70, fontSize: 12),
          ),
        ],
        const SizedBox(height: 10),
        _detailsToggle(),
        if (_details) ..._detailLines(),
      ],
    );
  }

  /// 실패 화면(§1 · §4): 문장 + `daemon.log` 마지막 8줄 + `다시 시도` + `데몬 시작`.
  Widget _failure(SupervisorStatus status) {
    final crashLoop = status.failure == SupervisorFailure.crashLoop;
    final tail = _logTail;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(crashLoop ? Icons.report_gmailerrorred : Icons.power_off, size: 44, color: daemonDownColor),
        const SizedBox(height: 10),
        Text(
          crashLoop ? overlayCrashLoopTitle : overlayStartFailedTitle,
          key: Key(crashLoop ? 'overlay.crashLoop' : 'overlay.startFailed'),
          style: const TextStyle(fontSize: 19, color: Colors.white),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 10),
        // 마지막 8줄(수명주기 §1). 원인을 덮지 않는다 — 접지 않고 그대로 보여 준다.
        Container(
          key: const Key('overlay.logTail'),
          width: double.infinity,
          constraints: const BoxConstraints(maxHeight: 120),
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(color: Colors.black38, borderRadius: BorderRadius.circular(4)),
          child: SingleChildScrollView(
            child: SelectableText(
              tail == null || tail.isEmpty ? overlayNoLogLabel : tail.join('\n'),
              style: const TextStyle(
                fontSize: 11,
                color: Colors.white70,
                fontFamily: panelMonoFamily,
                fontFamilyFallback: panelMonoFallback,
              ),
            ),
          ),
        ),
        const SizedBox(height: 12),
        Wrap(
          alignment: WrapAlignment.center,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 12,
          runSpacing: 8,
          children: [
            FilledButton.icon(
              key: const Key('overlay.retryStart'),
              onPressed: () => unawaited(ref.read(daemonSupervisorProvider)?.retry() ?? Future<void>.value()),
              icon: const Icon(Icons.refresh),
              label: const Text(overlayRetryLabel),
            ),
            // 옛 "데몬 시작"(보이는 콘솔 창) — 눈으로 원인을 볼 마지막 수단이라 여기에만 남긴다.
            const DaemonStartButton(),
          ],
        ),
        const SizedBox(height: 6),
        _detailsToggle(),
        if (_details) ..._detailLines(),
      ],
    );
  }

  /// 감시자가 없을 때(콘솔 실행·위젯 테스트) — T40-5 의 화면 그대로.
  Widget _classic() {
    final connection = ref.watch(connectionStateProvider);
    final attempts = ref.watch(reconnectAttemptsProvider);
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

    return Column(
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
        const SizedBox(height: 8),
        _detailsToggle(),
        if (_details) ..._detailLines(),
      ],
    );
  }

  // ---- 공통: "자세히" ---------------------------------------------------------------------

  Widget _detailsToggle() => TextButton(
        key: const Key('overlay.details'),
        style: TextButton.styleFrom(
          visualDensity: VisualDensity.compact,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          foregroundColor: Colors.white38,
          textStyle: const TextStyle(fontSize: 12),
        ),
        onPressed: () => setState(() => _details = !_details),
        child: Text(_details ? '$disconnectedDetailsLabel 접기' : '$disconnectedDetailsLabel ▸'),
      );

  List<Widget> _detailLines() {
    final error = ref.watch(officeProvider.select((s) => s.lastError)) ??
        ref.watch(supervisorStatusProvider)?.lastError;
    return [
      if (error != null)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: SelectableText(
            error,
            key: const Key('overlay.error'),
            style: const TextStyle(color: Colors.white38, fontSize: 11),
            textAlign: TextAlign.center,
          ),
        ),
      Padding(
        padding: const EdgeInsets.only(top: 4),
        child: SelectableText(
          'daemon.json: ${widget.daemonJsonPath ?? DaemonInfo.defaultPath() ?? daemonNoDataDir}',
          key: const Key('overlay.daemonPath'),
          style: const TextStyle(color: Colors.white38, fontSize: 11),
          textAlign: TextAlign.center,
        ),
      ),
      const Padding(
        padding: EdgeInsets.only(top: 4),
        child: Text(
          daemonPathHint,
          key: Key('overlay.pathHint'),
          style: TextStyle(color: Colors.white30, fontSize: 11),
          textAlign: TextAlign.center,
        ),
      ),
    ];
  }
}
