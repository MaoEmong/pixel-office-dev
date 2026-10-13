import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../state/office_state.dart';
import '../topbar/selected_department.dart';

typedef WorkflowData = Map<String, dynamic>;

final workflowProvider = StreamProvider.autoDispose
    .family<WorkflowData?, String>((ref, departmentId) async* {
      final rpc = ref.watch(rpcClientProvider);
      final controller = StreamController<WorkflowData?>();
      Future<void> load() async {
        try {
          final result = await rpc.call('workflow.get', {
            'departmentId': departmentId,
          });
          if (!controller.isClosed) {
            controller.add(
              result['workflow'] == null
                  ? null
                  : Map<String, dynamic>.from(result['workflow'] as Map),
            );
          }
        } catch (e, s) {
          if (!controller.isClosed) controller.addError(e, s);
        }
      }

      final notifications = rpc.notifications.listen((n) {
        if (n.method == 'workflow.changed' &&
            n.params['departmentId'] == departmentId &&
            !controller.isClosed) {
          controller.add(Map<String, dynamic>.from(n.params));
        }
      });
      final reconnect = rpc.hellos.listen((_) => unawaited(load()));
      ref.onDispose(() {
        unawaited(notifications.cancel());
        unawaited(reconnect.cancel());
        unawaited(controller.close());
      });
      unawaited(load());
      yield* controller.stream;
    });

String workflowPhaseLabel(WorkflowData? data) {
  if (data == null) return '작업 구체화부터 시작';
  if (data['phase'] == 'meeting') {
    final meeting = data['meeting'] as Map?;
    return switch (meeting?['state']) {
      'collecting' => '회의 · 1차 의견',
      'reviewing' => '회의 · 상호 검토',
      'deciding' => '회의 · 부장 결정',
      _ => '회의 준비',
    };
  }
  return const {
        'clarifying': '목표 구체화',
        'executing': '계획에 따라 실행 중',
        'review': '최종 보고 · 검수 대기',
        'completed': '검수 완료',
        'blocked': '확인이 필요한 문제',
        'cancelled': '작업 취소',
      }[data['phase']] ??
      '작업 상태 확인';
}

class WorkflowBar extends ConsumerWidget {
  const WorkflowBar({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final id = ref.watch(activeDepartmentIdProvider);
    if (id == null) return const SizedBox.shrink();
    final state = ref.watch(workflowProvider(id));
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: Theme.of(context).dividerColor)),
      ),
      child: Row(
        children: [
          const Icon(Icons.groups_outlined, size: 18),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              state.when(
                data: workflowPhaseLabel,
                loading: () => '작업 흐름 불러오는 중',
                error: (_, _) => '작업 흐름 연결 대기',
              ),
            ),
          ),
          TextButton.icon(
            icon: const Icon(Icons.forum_outlined, size: 18),
            label: const Text('부장과 대화 · 회의 보기'),
            onPressed: () => showDialog<void>(
              context: context,
              builder: (_) => WorkflowDialog(departmentId: id),
            ),
          ),
        ],
      ),
    );
  }
}

class WorkflowDialog extends ConsumerStatefulWidget {
  const WorkflowDialog({super.key, required this.departmentId});
  final String departmentId;
  @override
  ConsumerState<WorkflowDialog> createState() => _WorkflowDialogState();
}

class _WorkflowDialogState extends ConsumerState<WorkflowDialog> {
  final _text = TextEditingController();
  bool _busy = false;
  String? _error;
  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> run(
    String method, [
    Map<String, dynamic> extra = const {},
  ]) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(rpcClientProvider).call(method, {
        'departmentId': widget.departmentId,
        ...extra,
      });
      if (method == 'workflow.discuss') _text.clear();
      ref.invalidate(workflowProvider(widget.departmentId));
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  List<Map> rows(dynamic value) =>
      value is List ? value.whereType<Map>().toList() : [];
  Widget section(String title, Widget child) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 6),
        child,
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(workflowProvider(widget.departmentId));
    final w = async.asData?.value;
    final phase = w?['phase'];
    final canDiscuss =
        w == null || ['clarifying', 'completed', 'cancelled'].contains(phase);
    final members = ref.watch(membersProvider);
    final meeting = w?['meeting'] as Map?;
    String name(dynamic id) =>
        members[id]?.name ??
        (meeting?['participantNames'] as Map?)?[id]?.toString() ??
        id.toString();
    final assignments = rows(w?['assignments']);
    final hasHead = ref.watch(liveHeadProvider(widget.departmentId)) != null;
    return Dialog(
      child: SizedBox(
        width: 900,
        height: 600,
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Expanded(
                    child: Text(
                      '대화 · 회의 · 작업',
                      style: TextStyle(
                        fontSize: 21,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: '닫기',
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
              Text(
                workflowPhaseLabel(w),
                style: TextStyle(color: Theme.of(context).colorScheme.primary),
              ),
              const SizedBox(height: 8),
              const Text(
                '부장과 목표·완료 기준을 정리한 뒤 작업 시작을 누르세요. 회의 계획이 확정된 뒤 구현을 진행합니다.',
              ),
              const Divider(),
              Expanded(
                child: SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (async.hasError)
                        section('연결 오류', Text('${async.error}')),
                      if (w?['problem'] != null)
                        section(
                          '확인할 문제',
                          SelectableText(
                            w!['problem'].toString(),
                            style: TextStyle(
                              color: Theme.of(context).colorScheme.error,
                            ),
                          ),
                        ),
                      if (w != null && w['brief'].toString().isNotEmpty)
                        section(
                          '공유 작업안',
                          SelectableText(w['brief'].toString()),
                        ),
                      section(
                        '부장과 대화',
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            if (rows(w?['messages']).isEmpty)
                              const Text('아직 대화가 없습니다. 아래에서 만들고 싶은 작업을 설명하세요.'),
                            for (final m in rows(w?['messages']))
                              Padding(
                                padding: const EdgeInsets.only(bottom: 10),
                                child: SelectableText(
                                  '${m['role'] == 'user' ? '사용자' : '부장'}: ${m['text']}',
                                ),
                              ),
                          ],
                        ),
                      ),
                      if (meeting != null)
                        section(
                          '회의록 · 의견 교환',
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '참석자: ${(meeting['participants'] as List).map(name).join(', ')}',
                              ),
                              const SizedBox(height: 8),
                              for (final c in rows(meeting['contributions']))
                                Padding(
                                  padding: const EdgeInsets.only(bottom: 10),
                                  child: SelectableText(
                                    '${c['round']}차 · ${name(c['memberId'])}: ${c['text']}',
                                  ),
                                ),
                              if (meeting['minutes'] != null)
                                SelectableText('부장 결정: ${meeting['minutes']}'),
                            ],
                          ),
                        ),
                      if (assignments.isNotEmpty)
                        section(
                          '팀별 실행 계획',
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              for (final a in assignments)
                                Padding(
                                  padding: const EdgeInsets.only(bottom: 12),
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        '${name(a['leadId'])} · ${const {'queued': '선행 업무 대기', 'assigned': '업무 배정됨', 'done': '완료', 'blocked': '문제 확인'}[a['status']] ?? '대기'}',
                                        style: const TextStyle(
                                          fontWeight: FontWeight.bold,
                                        ),
                                      ),
                                      SelectableText(a['task'].toString()),
                                      Text(
                                        '완료 기준: ${(a['acceptance'] as List).join(' / ')}',
                                      ),
                                      if ((a['dependsOn'] as List? ?? [])
                                          .isNotEmpty)
                                        Text(
                                          '선행 담당: ${(a['dependsOn'] as List).map(name).join(', ')}',
                                        ),
                                    ],
                                  ),
                                ),
                            ],
                          ),
                        ),
                      if (w?['result'] != null)
                        section(
                          '최종 보고 · 검수',
                          SelectableText(w!['result'].toString()),
                        ),
                    ],
                  ),
                ),
              ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    _error!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              if (canDiscuss)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: TextField(
                    controller: _text,
                    minLines: 1,
                    maxLines: 3,
                    enabled: !_busy && hasHead,
                    decoration: const InputDecoration(
                      labelText: '부장에게 이야기하기',
                      hintText: '목표, 범위, 제약, 완료 기준을 설명해 주세요.',
                      border: OutlineInputBorder(),
                    ),
                  ),
                ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 4,
                children: [
                  if (canDiscuss)
                    FilledButton(
                      onPressed: _busy || !hasHead
                          ? null
                          : () {
                              if (_text.text.trim().isNotEmpty) {
                                unawaited(
                                  run('workflow.discuss', {
                                    'text': _text.text.trim(),
                                  }),
                                );
                              }
                            },
                      child: const Text('대화 보내기'),
                    ),
                  if (phase == 'clarifying')
                    FilledButton.icon(
                      onPressed: _busy || !hasHead
                          ? null
                          : () => run('workflow.start'),
                      icon: const Icon(Icons.play_arrow),
                      label: const Text('작업 시작 · 회의 소집'),
                    ),
                  if (meeting != null &&
                      assignments.isEmpty &&
                      ['meeting', 'blocked'].contains(phase))
                    OutlinedButton(
                      onPressed: _busy || !hasHead
                          ? null
                          : () => run('workflow.resume'),
                      child: const Text('회의 재개'),
                    ),
                  if (phase == 'review')
                    FilledButton(
                      onPressed: _busy ? null : () => run('workflow.complete'),
                      child: const Text('검수 완료'),
                    ),
                  if (w != null && !['completed', 'cancelled'].contains(phase))
                    TextButton(
                      onPressed: _busy ? null : () => run('workflow.cancel'),
                      child: const Text('작업 취소'),
                    ),
                  if (_busy)
                    const SizedBox(
                      width: 24,
                      height: 24,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
