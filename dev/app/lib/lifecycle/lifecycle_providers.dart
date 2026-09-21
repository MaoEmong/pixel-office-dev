// 수명 주기 배선(T46-2). **기본값은 전부 "감시자 없음"** 이라 위젯 테스트와 콘솔 실행은 지금과 똑같이 돈다 —
// `main()` 만 진짜 감시자를 덮어쓴다(`daemonSupervisorProvider`).

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../office/office_scene.dart' show LegendSlot, legendSlotFor;
import '../rpc/rpc_client.dart' show RpcConnectionState;
import '../state/office_state.dart';
import 'daemon_process.dart';
import 'daemon_supervisor.dart';

/// 지금 도는 감시자(없으면 null = 데몬을 앱이 관리하지 않는 옛 동작).
final daemonSupervisorProvider = Provider<DaemonSupervisor?>((_) => null);

class SupervisorStatusNotifier extends Notifier<SupervisorStatus?> {
  @override
  SupervisorStatus? build() {
    final sup = ref.watch(daemonSupervisorProvider);
    if (sup == null) return null;
    final sub = sup.statusStream.listen((s) => state = s);
    ref.onDispose(sub.cancel);
    return sup.status;
  }
}

/// 감시자 상태(감시자가 없으면 null).
final supervisorStatusProvider =
    NotifierProvider<SupervisorStatusNotifier, SupervisorStatus?>(SupervisorStatusNotifier.new);

/// `daemon.log` 꼬리 8줄을 읽는 함수. 위젯 테스트는 이것을 덮어쓴다 —
/// fake-async 존에서 `dart:io` Future 는 끝나지 않는다(T41 함정과 같은 이유).
final daemonLogTailProvider = Provider<Future<List<String>> Function()>(
  (_) => () => readLogTail(defaultDaemonLogPath()),
);

class ExitClosingNotifier extends Notifier<bool> {
  @override
  bool build() => false;
  void set(bool v) => state = v;
}

/// 종료 정리 중인가(`정리하는 중…`).
final exitClosingProvider = NotifierProvider<ExitClosingNotifier, bool>(ExitClosingNotifier.new);

/// "일하는 중" 인 캐릭터 수 — 범례 **"작업" 칸**(`legendSlotFor`)이 기준이다. 화면에서 파란 링인 사람만
/// 센다: 한가·대기·출근 중까지 세면 창을 닫을 때마다 물어보게 된다.
int workingMemberCount(OfficeState s) {
  var n = 0;
  for (final m in s.members.values) {
    if (legendSlotFor(status: m.status, derived: s.derived[m.id]) == LegendSlot.working) n++;
  }
  return n;
}

/// 지금 일하는 중인 캐릭터 수.
final workingMemberCountProvider = Provider<int>((ref) => workingMemberCount(ref.watch(officeProvider)));

/// 오버레이(사무실을 덮는 화면)를 보여야 하는가.
///
/// 끊겼을 때만이 아니다 — **붙어 있어도** 감시자가 다시 띄우는 중이거나 세션 복구가 진행 중이면 덮는다
/// (수명주기 §4: `데몬이 멈춰 다시 시작하는 중 · 세션을 복구합니다`).
final overlayVisibleProvider = Provider<bool>((ref) {
  if (ref.watch(exitClosingProvider)) return true;
  if (ref.watch(connectionStateProvider) != RpcConnectionState.connected) return true;
  final st = ref.watch(supervisorStatusProvider);
  if (st != null && (st.state == SupervisorState.restarting || st.isFailed)) return true;
  return ref.watch(recoveryProgressProvider) != null;
});
