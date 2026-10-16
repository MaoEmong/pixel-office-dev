import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../state/office_state.dart';
import '../diagnostics/error_panel.dart';
import '../model/models.dart';
import '../rpc/rpc_client.dart';
import 'meeting_activity.dart';
import 'workflow_reading.dart';
import '../topbar/selected_department.dart';

final meetingActivityLabelsProvider =
    Provider.family<Map<String, String>, String>((ref, id) {
      final workflow = ref.watch(workflowProvider(id)).asData?.value;
      final derived = ref.watch(officeProvider.select((s) => s.derived));
      final members = ref.watch(membersProvider);
      final pending = ref.watch(openPendingProvider);
      final labels = <String, String>{};
      for (final member in members.values.where((m) => m.departmentId == id)) {
        if (member.status.isGone || member.status == MemberStatus.suspended) continue;
        final ownPending = pending.values.where((p) => p.memberId == member.id);
        final question = ownPending.where((p) => p.type == PendingType.question).firstOrNull;
        final label = question != null && !ownPending.any((p) => p.type == PendingType.approval)
            ? question.questionWaitingLabel(members)
            : meetingMemberActivity(workflow, member, derived[member.id]);
        if (label != null) labels[member.id] = label;
      }
      return labels;
    });

class MeetingProgress extends ConsumerWidget {
  const MeetingProgress({
    super.key,
    required this.departmentId,
    this.compact = false,
  });
  final String departmentId;
  final bool compact;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final workflow = ref.watch(workflowProvider(departmentId)).asData?.value;
    if (workflow == null ||
        !['meeting', 'blocked'].contains(workflow['phase'])) {
      return const SizedBox.shrink();
    }
    final meeting = workflow['meeting'] as Map?;
    final participants = (meeting?['participants'] as List? ?? [])
        .cast<String>();
    final contributions = (meeting?['contributions'] as List? ?? [])
        .whereType<Map>()
        .toList();
    final members = ref.watch(membersProvider);
    final labels = ref.watch(meetingActivityLabelsProvider(departmentId));
    String name(String id) =>
        members[id]?.name ??
        (meeting?['participantNames'] as Map?)?[id]?.toString() ??
        id;
    final round = meeting?['round'] ?? 1;
    final submitted = contributions.where((c) => c['round'] == round).length;
    final subject = (workflow['brief']?.toString() ?? '')
        .split('\n')
        .firstWhere((s) => s.trim().isNotEmpty, orElse: () => '작업 계획과 역할 논의');
    final progress = meeting == null
        ? '회의 준비 · 팀 구성 중'
        : meeting['state'] == 'deciding'
        ? '의견 수집 완료 · 부장이 계획을 확정하고 있어요'
        : '$round차 회의 · ${round == 2 ? '서로의 의견 검토' : '접근 방법과 역할 논의'} · 의견 $submitted/${participants.length}명';
    final latest = contributions.lastOrNull;
    return Semantics(
      liveRegion: true,
      child: Container(
        key: const Key('meeting.progress'),
        width: double.infinity,
        padding: EdgeInsets.symmetric(
          vertical: compact ? 3 : 8,
          horizontal: compact ? 0 : 10,
        ),
        decoration: compact
            ? null
            : BoxDecoration(
                color: Theme.of(
                  context,
                ).colorScheme.primary.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(8),
              ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '회의 안건: $subject',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            Text(
              workflow['phase'] == 'blocked'
                  ? '회의 중단 · ${workflow['problem'] ?? '참석자 상태를 확인해 주세요'}'
                  : progress,
              key: const Key('meeting.summary'),
              maxLines: compact ? 1 : 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: workflow['phase'] == 'blocked'
                    ? Theme.of(context).colorScheme.error
                    : Theme.of(context).colorScheme.primary,
                fontSize: 12,
              ),
            ),
            if (participants.isNotEmpty)
              Text(
                participants
                    .map(
                      (id) =>
                          '${name(id)}: ${members[id] == null
                              ? '참석자 연결 복구 필요'
                              : members[id]?.status.isGone == true
                              ? '세션 복구 필요'
                              : labels[id] ?? '의견 제출 대기'}',
                    )
                    .join(' / '),
                maxLines: compact ? 1 : 3,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12),
                key: const Key('meeting.participants'),
              ),
            Text(
              latest == null
                  ? '아직 제출된 의견이 없습니다.'
                  : '최근 발언 · ${name(latest['memberId'].toString())}: ${latest['text']}',
              maxLines: compact ? 1 : 3,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12),
              key: const Key('meeting.latest'),
            ),
          ],
        ),
      ),
    );
  }
}

typedef WorkflowData = Map<String, dynamic>;

final workflowProvider = StreamProvider.autoDispose
    .family<WorkflowData?, String>((ref, departmentId) async* {
      final rpc = ref.watch(rpcClientProvider);
      final controller = StreamController<WorkflowData?>();
      var revision = 0;
      var latestLoad = 0;
      Future<void> load() async {
        if (rpc.state != RpcConnectionState.connected) return;
        final requestedRevision = revision;
        final request = ++latestLoad;
        try {
          final result = await rpc.call('workflow.get', {
            'departmentId': departmentId,
          });
          if (!controller.isClosed &&
              requestedRevision == revision &&
              request == latestLoad) {
            controller.add(
              result['workflow'] == null
                  ? null
                  : Map<String, dynamic>.from(result['workflow'] as Map),
            );
          }
        } catch (e, s) {
          if (!controller.isClosed &&
              requestedRevision == revision &&
              request == latestLoad) {
            controller.addError(e, s);
          }
        }
      }

      final notifications = rpc.notifications.listen((n) {
        if (n.method == 'workflow.changed' &&
            n.params['departmentId'] == departmentId &&
            !controller.isClosed) {
          revision++;
          controller.add(Map<String, dynamic>.from(n.params));
        }
        // A turn-ending status also reconciles the conversation if its live
        // notification was missed during a refresh or a connection change.
        if (n.method == 'member.status' && n.params['status'] == 'idle') {
          final member = ref.read(membersProvider)[n.params['memberId']];
          if (member?.departmentId == departmentId &&
              member?.rank == MemberRank.head) {
            unawaited(load());
          }
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
  String? phase;
  if (data['phase'] == 'meeting') {
    final meeting = data['meeting'] as Map?;
    phase = switch (meeting?['state']) {
      'collecting' => '회의 · 1차 의견',
      'reviewing' => '회의 · 상호 검토',
      'deciding' => '회의 · 부장 결정',
      _ => '회의 준비',
    };
  }
  phase ??= const {
        'clarifying': '목표 구체화',
        'executing': '계획에 따라 실행 중',
        'review': '부장이 단계 결과 확인 중',
        'completed': '전체 작업 완료',
        'blocked': '확인이 필요한 문제',
        'cancelled': '작업 취소',
      }[data['phase']] ??
      '작업 상태 확인';
  return data['stage'] == null ? phase : '${data['stage']}단계 · ${data['stageTitle'] ?? '작업 진행'} · $phase';
}

class WorkflowBar extends ConsumerWidget {
  const WorkflowBar({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final id = ref.watch(activeDepartmentIdProvider);
    if (id == null) return const SizedBox.shrink();
    final state = ref.watch(workflowProvider(id));
    final stages = workflowRows(state.asData?.value?['stages']);
    ref.listen(workflowProvider(id), (previous, next) {
      if (previous?.asData == null) return;
      final before = workflowRows(previous!.asData?.value?['stages']);
      final after = workflowRows(next.asData?.value?['stages']);
      if (after.length <= before.length || !context.mounted) return;
      final last = after.last;
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(
        content: Text('${last['number']}단계 완료 · ${last['summary']}', maxLines: 2, overflow: TextOverflow.ellipsis),
        action: SnackBarAction(label: '단계 기록', onPressed: () => showDialog<void>(context: context,
            builder: (_) => WorkflowDialog(departmentId: id, initialTab: 3))),
      ));
    });
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
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  state.when(
                    data: workflowPhaseLabel,
                    loading: () => '작업 흐름 불러오는 중',
                    error: (_, _) => '작업 흐름 연결 대기',
                  ),
                ),
                HeadReplyStatus(departmentId: id),
                MeetingProgress(departmentId: id, compact: true),
                if (stages.isNotEmpty)
                  InkWell(
                    onTap: () => showDialog<void>(context: context,
                        builder: (_) => WorkflowDialog(departmentId: id, initialTab: 3)),
                    child: Text('최근 완료: ${stages.last['number']}단계 · ${stages.last['summary']} · 단계 기록 ${stages.length}건',
                        key: const Key('workflow.latestStage'), maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: const TextStyle(color: Color(0xFF9EDCC2), fontSize: 12)),
                  ),
              ],
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
  const WorkflowDialog({super.key, required this.departmentId, this.initialTab = 0});
  final String departmentId;
  final int initialTab;
  @override
  ConsumerState<WorkflowDialog> createState() => _WorkflowDialogState();
}

class _WorkflowDialogState extends ConsumerState<WorkflowDialog>
    with SingleTickerProviderStateMixin {
  final _text = TextEditingController();
  final _conversationScroll = ScrollController();
  late final _tabs = TabController(length: 4, initialIndex: widget.initialTab, vsync: this);
  bool _busy = false;
  String? _error;
  @override
  void dispose() {
    _text.dispose();
    _conversationScroll.dispose();
    _tabs.dispose();
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
      if (!mounted) return;
      if (method == 'workflow.discuss') {
        _text.clear();
        _tabs.animateTo(0);
        if (_conversationScroll.hasClients) _conversationScroll.jumpTo(0);
      }
      ref.invalidate(workflowProvider(widget.departmentId));
    } catch (e) {
      if (mounted) setState(() => _error = errorMessage(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  List<Map> rows(dynamic value) =>
      value is List ? value.whereType<Map>().toList() : [];

  Widget readingTab(String label, int count) => Tab(
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(label),
        const SizedBox(width: 7),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: .08),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Text('$count', style: const TextStyle(fontSize: 11)),
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(workflowProvider(widget.departmentId));
    final w = async.asData?.value;
    final phase = w?['phase'];
    final members = ref.watch(membersProvider);
    final meeting = w?['meeting'] as Map?;
    final participants = (meeting?['participants'] as List? ?? [])
        .cast<String>();
    final needsRecovery = participants.any(
      (id) =>
          members[id] == null ||
          members[id]!.status.isGone ||
          members[id]!.status == MemberStatus.suspended,
    );
    String name(dynamic id) =>
        members[id]?.name ??
        (meeting?['participantNames'] as Map?)?[id]?.toString() ??
        id.toString();
    final assignments = rows(w?['assignments']);
    final hasHead = ref.watch(liveHeadProvider(widget.departmentId)) != null;
    return Dialog(
      child: SizedBox(
        width: 1000,
        height: MediaQuery.sizeOf(context).height * .88,
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
              HeadReplyStatus(departmentId: widget.departmentId),
              if (async.hasError)
                const Text(
                  '작업 상태를 불러오지 못했어요. 연결 상태를 확인해 주세요.',
                  style: TextStyle(color: Colors.redAccent),
                ),
              if (phase == 'blocked' && w?['problem'] != null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(
                    w!['problem'].toString(),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                      height: 1.5,
                    ),
                  ),
                ),
              TabBar(
                controller: _tabs,
                tabs: [
                  readingTab('대화', rows(w?['messages']).length),
                  readingTab('회의', rows(meeting?['contributions']).length),
                  readingTab('작업 계획', assignments.length),
                  readingTab('단계 기록', rows(w?['stages']).length),
                ],
              ),
              Expanded(
                child: TabBarView(
                  controller: _tabs,
                  children: [
                    WorkflowConversation(
                      messages: rows(w?['messages']),
                      controller: _conversationScroll,
                    ),
                    WorkflowMeetingNotes(
                      meeting: meeting,
                      name: name,
                      progress: MeetingProgress(
                        departmentId: widget.departmentId,
                      ),
                    ),
                    WorkflowPlan(workflow: w, name: name),
                    WorkflowStageHistory(workflow: w),
                  ],
                ),
              ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: ErrorPanel(
                    title: '작업 요청을 완료하지 못했어요',
                    message: _error!,
                    compact: true,
                  ),
                ),
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: TextField(
                  controller: _text,
                  minLines: 1,
                  maxLines: 3,
                  enabled: !_busy && hasHead,
                  decoration: const InputDecoration(
                    labelText: '부장에게 이야기하기',
                    hintText: '질문이나 변경 지시를 보내세요. 부장이 응답 중이면 이어서 전달됩니다.',
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 4,
                children: [
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
                      label: const Text('지금 바로 시작'),
                    ),
                  if (meeting != null &&
                      assignments.isEmpty &&
                      ['meeting', 'blocked'].contains(phase))
                    OutlinedButton(
                      onPressed: _busy || !hasHead
                          ? null
                          : () => run('workflow.resume'),
                      child: Text(needsRecovery ? '참석자 복구 후 회의 재개' : '회의 재개'),
                    ),
                  if (phase == 'review')
                    FilledButton(
                      onPressed: _busy ? null : () => run('workflow.complete'),
                      child: const Text('사용자가 직접 완료 처리'),
                    ),
                  if (assignments.isNotEmpty &&
                      ['executing', 'blocked'].contains(phase))
                    OutlinedButton.icon(
                      onPressed: _busy || !hasHead
                          ? null
                          : () => run('workflow.resume'),
                      icon: const Icon(Icons.refresh),
                      label: const Text('업무 배정 재시도'),
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

enum HeadReplyPhase {
  none,
  preparing,
  working,
  approval,
  question,
  complete,
  interrupted,
  disconnected,
}

HeadReplyPhase headReplyPhase(
  WorkflowData? workflow, {
  required bool connected,
  MemberStatus? status,
  DerivedStatus? derived,
}) {
  final messages = (workflow?['messages'] as List? ?? [])
      .whereType<Map>()
      .toList();
  if (messages.isEmpty) return HeadReplyPhase.none;
  if (workflow?['phase'] != 'clarifying' && messages.last['followup'] != true) {
    return HeadReplyPhase.none;
  }
  if (!connected) return HeadReplyPhase.disconnected;
  if (status == null ||
      status == MemberStatus.error ||
      status == MemberStatus.exited ||
      status == MemberStatus.suspended) {
    return HeadReplyPhase.interrupted;
  }
  if (status == MemberStatus.waitingApproval ||
      derived == DerivedStatus.waitingApproval) {
    return HeadReplyPhase.approval;
  }
  if (status == MemberStatus.waitingAnswer ||
      derived == DerivedStatus.waitingAnswer) {
    return HeadReplyPhase.question;
  }
  if (status == MemberStatus.working) return HeadReplyPhase.working;
  if (status == MemberStatus.starting) return HeadReplyPhase.preparing;
  // A head message is recorded only when the CLI produces its final reply.
  if (messages.last['role'] == 'head') return HeadReplyPhase.complete;
  return HeadReplyPhase.preparing;
}

/// Visible both above the conversation and in the office while the dialog is shut.
class HeadReplyStatus extends ConsumerWidget {
  const HeadReplyStatus({super.key, required this.departmentId});
  final String departmentId;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final workflow = ref.watch(workflowProvider(departmentId));
    final headId = ref.watch(departmentsProvider)[departmentId]?.headId;
    final member = headId == null ? null : ref.watch(memberProvider(headId));
    final phase = headReplyPhase(
      workflow.asData?.value,
      connected:
          ref.watch(connectionStateProvider) == RpcConnectionState.connected &&
          !workflow.hasError,
      status: member?.status,
      derived: headId == null ? null : ref.watch(derivedStatusProvider(headId)),
    );
    if (phase == HeadReplyPhase.none) return const SizedBox.shrink();
    final label = switch (phase) {
      HeadReplyPhase.preparing => '부장이 답변을 준비하고 있어요',
      HeadReplyPhase.working => '부장이 답변 중이에요',
      HeadReplyPhase.approval => '답변을 이어가려면 승인이 필요해요 · 내 책상을 확인하세요',
      HeadReplyPhase.question => '부장이 확인을 기다리고 있어요 · 내 책상에서 답해 주세요',
      HeadReplyPhase.complete => '답변 완료 · 이어서 메시지를 보낼 수 있어요',
      HeadReplyPhase.interrupted => '답변이 중단됐어요 · 부장 상태를 확인해 주세요',
      HeadReplyPhase.disconnected => '연결이 끊겨 답변 상태를 확인할 수 없어요',
      HeadReplyPhase.none => '',
    };
    final completed = phase == HeadReplyPhase.complete;
    final waiting =
        phase == HeadReplyPhase.preparing || phase == HeadReplyPhase.working;
    final color = completed
        ? const Color(0xFF8EDBB3)
        : Theme.of(context).colorScheme.primary;
    return Semantics(
      liveRegion: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(
          children: [
            Icon(
              completed
                  ? Icons.check_circle
                  : waiting
                  ? Icons.hourglass_top
                  : Icons.info_outline,
              size: 18,
              color: color,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                label,
                key: Key('headReply.${phase.name}'),
                style: TextStyle(color: color, fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
