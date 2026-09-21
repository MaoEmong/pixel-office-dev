// 창 닫기 가로채기 배선(T46-2 · 수명주기 §2). [LifecycleGate] 하나가
//   - `AppLifecycleListener.onExitRequested` 를 잡아 [AppExitCoordinator] 에 넘기고,
//   - 소켓이 끊기면 감시자에게 알려 준다(§4: 붙기만 한 데몬의 죽음은 이 길로만 안다).
//
// 바깥 의존(데몬 pid · pid 생존 · 트리 종료)은 전부 provider 라 위젯 테스트가 갈아끼운다.

import 'dart:async';
import 'dart:ui' show AppExitResponse;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../panel/ui_prefs.dart';
import '../rpc/daemon_info.dart';
import '../rpc/rpc_client.dart';
import '../state/office_state.dart';
import '../topbar/selected_department.dart' show activeDepartmentIdProvider;
import 'daemon_process.dart';
import 'daemon_supervisor.dart';
import 'exit_flow.dart';
import 'lifecycle_providers.dart';

/// 지금 도는 데몬의 pid(`daemon.json`). 없으면 null.
final daemonProcessPidProvider = Provider<Future<int?> Function()>(
  (_) => () async => (await DaemonInfo.read())?.pid,
);

/// pid 가 살아 있는가.
final pidAliveProvider = Provider<Future<bool> Function(int)>((_) => (pid) => isPidAlive(pid));

/// 프로세스 트리 강제 종료.
final killProcessTreeProvider = Provider<Future<void> Function(int)>((_) => killProcessTree);

/// 확인 다이얼로그 — [exitConfirmMessage] 문구 그대로. true = 닫기.
Future<bool> showExitConfirmDialog(BuildContext context, int working) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text(exitConfirmTitle),
      content: Text(exitConfirmMessage(working), key: const Key('exit.confirm.message')),
      actions: [
        TextButton(
          key: const Key('exit.confirm.cancel'),
          onPressed: () => Navigator.of(ctx).pop(false),
          child: const Text(exitConfirmCancelLabel),
        ),
        FilledButton(
          key: const Key('exit.confirm.close'),
          onPressed: () => Navigator.of(ctx).pop(true),
          child: const Text(exitConfirmCloseLabel),
        ),
      ],
    ),
  );
  return ok ?? false;
}

/// provider 들로 종료 흐름을 조립한다(위젯을 모르는 부분은 전부 [AppExitCoordinator] 안에 있다).
AppExitCoordinator buildExitCoordinator(
  WidgetRef ref, {
  required Future<bool> Function(int working) confirm,
}) {
  final supervisor = ref.read(daemonSupervisorProvider);
  return AppExitCoordinator(
    keepDaemon: () => ref.read(keepDaemonProvider),
    workingCount: () => ref.read(workingMemberCountProvider),
    confirm: confirm,
    daemonPid: ref.read(daemonProcessPidProvider),
    shutdownDaemon: () => ref.read(rpcClientProvider).call('daemon.shutdown'),
    // "계속 일하기" 로 닫을 때만 쓴다 — 데몬이 우리를 지켜보고 있으면 꺼 달라고 한다(T46-3).
    stopWatchingParent: () => ref.read(rpcClientProvider).call('daemon.stopWatchingParent'),
    isAlive: ref.read(pidAliveProvider),
    killTree: ref.read(killProcessTreeProvider),
    // 감시자를 먼저 멈춘다 — 안 그러면 정상 종료를 "죽었다" 로 보고 다시 띄운다.
    stopSupervisor: supervisor == null ? null : () => supervisor.stop(),
    onClosingChanged: (closing) => ref.read(exitClosingProvider.notifier).set(closing),
  );
}

class LifecycleGate extends ConsumerStatefulWidget {
  const LifecycleGate({super.key, required this.child, this.onExited});

  final Widget child;

  /// 종료가 확정된 뒤(테스트·`main()` 의 잠금 해제용).
  final Future<void> Function(ExitOutcome outcome)? onExited;

  @override
  ConsumerState<LifecycleGate> createState() => LifecycleGateState();
}

class LifecycleGateState extends ConsumerState<LifecycleGate> {
  AppLifecycleListener? _listener;

  /// 마지막 종료 시도의 결과(테스트가 본다).
  ExitOutcome? lastOutcome;

  @override
  void initState() {
    super.initState();
    _listener = AppLifecycleListener(onExitRequested: handleExitRequest);
  }

  @override
  void dispose() {
    _listener?.dispose();
    super.dispose();
  }

  /// 창 닫기 요청 하나. 테스트는 이것을 직접 부른다(진짜 창을 닫을 수 없으므로).
  Future<AppExitResponse> handleExitRequest() async {
    final coordinator = buildExitCoordinator(
      ref,
      confirm: (working) async => mounted ? showExitConfirmDialog(context, working) : true,
    );
    final outcome = await coordinator.onExitRequested();
    lastOutcome = outcome;
    if (outcome.exiting) await widget.onExited?.call(outcome);
    return outcome.response;
  }

  @override
  Widget build(BuildContext context) {
    // 설정을 **미리** 읽어 둔다 — 창을 닫는 순간에 처음 읽으면 파일을 기다릴 시간이 없어
    // 항상 기본값(꺼짐)으로 보인다.
    ref.watch(keepDaemonProvider);
    // 지금 보고 있는 부서를 클라이언트에 적어 둔다 — **다음 hello** 가 복구 순서 힌트로 싣는다(§5).
    // 되살리는 도중에 탭을 바꿔도 전용 RPC 는 없다(PROTOCOL 미정): 다음 재접속에 반영된다.
    ref.read(rpcClientProvider).activeDepartmentId = ref.watch(activeDepartmentIdProvider);
    // 감시자가 데몬을 띄우자마자 **재접속 backoff 를 깨운다**(T46-3 실기: 이것이 없으면 `daemon.json` 이 나온
    // 뒤에도 앱이 자기 backoff(최대 5초)를 다 기다린 다음에야 붙었다 — 실측 3.8초 → 8.0초, 4.2초가 순전히 대기였다).
    // 첫 기동과 §4 재시작 둘 다 이 길을 지난다.
    ref.listen<SupervisorStatus?>(supervisorStatusProvider, (prev, next) {
      if (next == null || next.state != SupervisorState.running) return;
      if (prev != null && prev.state == SupervisorState.running) return;
      ref.read(rpcClientProvider).retryNow();
    });
    // 끊김 → 감시자에게 알린다. 감시자는 daemon.json 의 pid 가 살아 있으면 무시한다(일시적 끊김).
    ref.listen<RpcConnectionState>(connectionStateProvider, (prev, next) {
      if (next != RpcConnectionState.disconnected) return;
      final supervisor = ref.read(daemonSupervisorProvider);
      if (supervisor == null) return;
      unawaited(supervisor.socketClosed());
    });
    return widget.child;
  }
}
