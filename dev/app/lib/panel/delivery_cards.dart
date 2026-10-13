import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../state/office_state.dart';
import '../diagnostics/error_panel.dart';
import 'panel_tabs.dart';

class DeliveryCards extends ConsumerStatefulWidget {
  const DeliveryCards({super.key, required this.memberId});
  final String memberId;
  @override
  ConsumerState<DeliveryCards> createState() => _DeliveryCardsState();
}

class _DeliveryCardsState extends ConsumerState<DeliveryCards> {
  bool busy = false;
  String? error;
  Future<void> retry(int id) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await ref.read(rpcClientProvider).call('task.retrySubmit', {
        'taskId': id,
      });
    } catch (e) {
      if (mounted) setState(() => error = errorMessage(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final tasks = ref
        .watch(openTasksProvider)
        .values
        .where(
          (t) =>
              t.toMember == widget.memberId &&
              ['failed', 'submitting'].contains(t.delivery),
        );
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final task in tasks)
          Padding(
            padding: const EdgeInsets.all(8),
            child: task.delivery == 'failed'
                ? ErrorPanel(
                    title: '작업 #${task.id} · 제출 확인 필요',
                    message:
                        'CLI가 지시를 받았는지 확인하지 못했어요. 재제출은 입력 상자에 있는 지시에 Enter만 보냅니다.',
                    compact: true,
                    onRetry: busy ? null : () => retry(task.id),
                    retryLabel: '지시 재제출',
                    actions: [
                      TextButton(
                        onPressed: () => ref
                            .read(panelTabRequestProvider.notifier)
                            .request(RightPanelTab.terminal),
                        child: const Text('터미널 확인'),
                      ),
                    ],
                  )
                : Text(
                    '작업 #${task.id} · CLI 제출 확인 중',
                    style: const TextStyle(color: Colors.amber),
                  ),
          ),
        if (error != null)
          ErrorPanel(title: '재제출하지 못했어요', message: error!, compact: true),
      ],
    );
  }
}
