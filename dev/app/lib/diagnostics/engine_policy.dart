import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../model/models.dart';
import '../state/office_state.dart';
import '../rpc/rpc_client.dart' show RpcConnectionState;
import '../topbar/selected_department.dart';

final enginePolicyProvider = StreamProvider.autoDispose<List<Engine>?>((
  ref,
) async* {
  final client = ref.watch(rpcClientProvider);
  final controller = StreamController<List<Engine>?>();
  var revision = 0;
  Future<void> load() async {
    if (client.state != RpcConnectionState.connected) return;
    final ticket = ++revision;
    try {
      final value = await client.call('engines.get');
      final engines = (value['allowedEngines'] as List?)
          ?.map((e) => Engine.values.firstWhere((engine) => engine.wire == e))
          .toList();
      if (!controller.isClosed && ticket == revision) controller.add(engines);
    } catch (error, stack) {
      if (!controller.isClosed && ticket == revision) {
        controller.addError(error, stack);
      }
    }
  }

  final notifications = client.notifications.listen((n) {
    if (n.method == 'snapshot') unawaited(load());
  });
  final reconnect = client.hellos.listen((_) => (unawaited(load())));
  ref.onDispose(() {
    unawaited(notifications.cancel());
    unawaited(reconnect.cancel());
    unawaited(controller.close());
  });
  unawaited(load());
  yield* controller.stream;
});

String enginePolicyLabel(List<Engine>? engines, {Engine? headEngine}) {
  if (engines == null) {
    return '부장과 같은 AI만 사용${headEngine == null ? '' : ' · ${headEngine == Engine.claude ? 'Claude Code' : 'Codex'}'}';
  }
  if (engines.length == 2) return 'Claude Code + Codex 둘 다 사용';
  return engines.first == Engine.claude ? 'Claude Code만 사용' : 'Codex만 사용';
}

class EnginePolicyBanner extends ConsumerWidget {
  const EnginePolicyBanner({super.key, required this.onEdit});
  final VoidCallback onEdit;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final policy = ref.watch(enginePolicyProvider);
    final id = ref.watch(activeDepartmentIdProvider);
    final head = id == null ? null : ref.watch(liveHeadProvider(id));
    final engines = policy.asData?.value;
    final allowed =
        engines ?? (head == null ? const <Engine>[] : [head.engine]);
    final mismatch = ref
        .watch(membersProvider)
        .values
        .where(
          (m) =>
              !m.status.isGone &&
              m.status != MemberStatus.suspended &&
              (engines != null || m.departmentId == id) &&
              !allowed.contains(m.engine),
        )
        .length;
    return Container(
      key: const Key('enginePolicy.banner'),
      color: Theme.of(context).colorScheme.primary.withValues(alpha: 0.07),
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Row(
        children: [
          const Icon(Icons.tune, size: 16),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              policy.isLoading
                  ? '사용 AI 설정 확인 중…'
                  : policy.hasError
                  ? '사용 AI 설정을 확인하지 못했어요'
                  : '사용 AI: ${enginePolicyLabel(engines, headEngine: head?.engine)}${mismatch == 0 ? '' : ' · 설정과 다른 기존 AI $mismatch명은 새 작업을 시작할 수 없어요'}',
              style: const TextStyle(fontSize: 12),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          TextButton(onPressed: onEdit, child: const Text('AI 설정 변경')),
        ],
      ),
    );
  }
}
