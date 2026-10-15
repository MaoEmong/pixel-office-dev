import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../state/office_state.dart';

List<Map> workflowRows(dynamic value) =>
    value is List ? value.whereType<Map>().toList() : [];

String workflowMessageTime(dynamic value) {
  final date = DateTime.tryParse(value?.toString() ?? '')?.toLocal();
  if (date == null) return '';
  String two(int n) => n.toString().padLeft(2, '0');
  return '${date.month}/${date.day} ${two(date.hour)}:${two(date.minute)}';
}

class WorkflowText extends StatelessWidget {
  const WorkflowText(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final body = theme.textTheme.bodyMedium!.copyWith(
      fontSize: 14.5,
      height: 1.7,
      color: const Color(0xFFE3E6EF),
    );
    // SelectableText's internal scroll position shares the enclosing tile's
    // PageStorage entry. SelectionArea keeps selection without that scroll state.
    return SelectionArea(
      child: MarkdownBody(
        data: text,
        selectable: false,
        softLineBreak: true,
        // Conversation content is text: images do not fetch remote resources.
        imageBuilder: (uri, title, alt) =>
            Text(alt ?? title ?? uri.toString(), style: body),
        styleSheet: MarkdownStyleSheet.fromTheme(theme).copyWith(
          p: body,
          strong: body.copyWith(
            fontWeight: FontWeight.w700,
            color: Colors.white,
          ),
          h1: body.copyWith(fontSize: 22, fontWeight: FontWeight.w700),
          h2: body.copyWith(fontSize: 19, fontWeight: FontWeight.w700),
          h3: body.copyWith(fontSize: 16, fontWeight: FontWeight.w700),
          h1Padding: const EdgeInsets.only(top: 8, bottom: 12),
          h2Padding: const EdgeInsets.only(top: 8, bottom: 10),
          h3Padding: const EdgeInsets.only(top: 6, bottom: 8),
          blockSpacing: 12,
          listIndent: 24,
          listBullet: body,
          code: body.copyWith(
            fontFamily: 'D2Coding',
            fontSize: 13,
            backgroundColor: const Color(0xFF181D29),
          ),
          codeblockPadding: const EdgeInsets.all(14),
          codeblockDecoration: BoxDecoration(
            color: const Color(0xFF181D29),
            borderRadius: BorderRadius.circular(8),
          ),
          blockquoteDecoration: const BoxDecoration(
            color: Color(0xFF242D40),
            border: Border(
              left: BorderSide(color: Color(0xFF839DDB), width: 3),
            ),
          ),
          blockquotePadding: const EdgeInsets.all(12),
          tableHead: body.copyWith(fontWeight: FontWeight.w700),
          tableBody: body.copyWith(fontSize: 13.5),
          tableCellsPadding: const EdgeInsets.symmetric(
            horizontal: 12,
            vertical: 9,
          ),
          tableBorder: TableBorder.all(color: const Color(0xFF495064)),
        ),
      ),
    );
  }
}

class WorkflowEntryCard extends ConsumerWidget {
  const WorkflowEntryCard({
    super.key,
    required this.author,
    required this.text,
    this.time,
    this.user = false,
    this.label,
    this.accent,
    this.headingKey,
  });
  final String author, text;
  final dynamic time;
  final bool user;
  final String? label;
  final Color? accent;
  final Key? headingKey;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final color =
        accent ?? (user ? const Color(0xFFB7C9FF) : const Color(0xFF9EDCC2));
    final stamp = workflowMessageTime(time);
    return Container(
      key: headingKey,
      margin: EdgeInsets.only(
        left: user ? 32 : 0,
        right: user ? 0 : 16,
        bottom: 16,
      ),
      padding: const EdgeInsets.fromLTRB(18, 10, 18, 18),
      decoration: BoxDecoration(
        color: user ? const Color(0xFF28344B) : const Color(0xFF252A37),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: .3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                user ? Icons.person_outline : Icons.chat_bubble_outline,
                size: 17,
                color: color,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  label == null ? author : '$author · $label',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: color,
                  ),
                ),
              ),
              if (stamp.isNotEmpty)
                Text(
                  stamp,
                  style: const TextStyle(
                    fontSize: 12,
                    color: Color(0xFFADB5C9),
                  ),
                ),
              IconButton(
                tooltip: '메시지 복사',
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.copy_outlined, size: 16),
                onPressed: () async {
                  try {
                    await Clipboard.setData(ClipboardData(text: text));
                    if (context.mounted) {
                      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
                        const SnackBar(
                          content: Text('내용을 복사했습니다.'),
                          duration: Duration(seconds: 2),
                        ),
                      );
                    }
                  } catch (error) {
                    ref
                        .read(rpcClientProvider)
                        .reportFailure('clipboard.copy', error);
                  }
                },
              ),
            ],
          ),
          Divider(height: 18, color: color.withValues(alpha: .17)),
          WorkflowText(text),
        ],
      ),
    );
  }
}

class WorkflowConversation extends StatefulWidget {
  const WorkflowConversation({
    super.key,
    required this.messages,
    required this.controller,
  });
  final List<Map> messages;
  final ScrollController controller;
  @override
  State<WorkflowConversation> createState() => _WorkflowConversationState();
}

class _WorkflowConversationState extends State<WorkflowConversation> {
  final _latestHeading = GlobalKey();
  double _latestReadingOffset = 0;
  bool _hasNewMessages = false;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _showLatest());
  }

  @override
  void didUpdateWidget(covariant WorkflowConversation oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.messages.length != widget.messages.length) {
      // The start of a long newest reply is far from offset zero in a reverse
      // list. Follow that reading position, rather than mistaking it for history.
      if (!widget.controller.hasClients ||
          widget.controller.offset <= _latestReadingOffset + 24) {
        WidgetsBinding.instance.addPostFrameCallback((_) => _showLatest());
      } else {
        _hasNewMessages = true;
      }
    }
  }

  void _showLatest() {
    if (!mounted || !widget.controller.hasClients) return;
    if (_hasNewMessages) setState(() => _hasNewMessages = false);
    widget.controller.jumpTo(0);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final heading = _latestHeading.currentContext;
      if (mounted && heading != null) {
        Scrollable.ensureVisible(heading, alignment: 1);
        _latestReadingOffset = widget.controller.offset;
      }
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  @override
  Widget build(BuildContext context) {
    final messages = widget.messages;
    final controller = widget.controller;
    if (messages.isEmpty) {
      return const Center(
        child: Text(
          '아직 대화가 없습니다.\n아래에서 만들고 싶은 작업을 설명해 주세요.',
          textAlign: TextAlign.center,
          style: TextStyle(height: 1.8, color: Colors.white60),
        ),
      );
    }
    return Column(
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                _hasNewMessages ? '새 대화가 도착했어요.' : '최근 대화부터 확인할 수 있어요.',
                style: const TextStyle(fontSize: 12, color: Colors.white54),
              ),
            ),
            TextButton.icon(
              onPressed: _showLatest,
              icon: const Icon(Icons.arrow_downward, size: 15),
              label: Text(_hasNewMessages ? '새 대화 보기' : '최근 대화'),
            ),
          ],
        ),
        Expanded(
          child: Scrollbar(
            controller: controller,
            thumbVisibility: true,
            child: ListView.builder(
              key: const PageStorageKey('workflow.conversation'),
              controller: controller,
              reverse: true,
              padding: const EdgeInsets.only(top: 8, right: 10),
              itemCount: messages.length,
              itemBuilder: (context, index) {
                final original = messages.length - 1 - index;
                final message = messages[original];
                final user = message['role'] == 'user';
                return WorkflowEntryCard(
                  key: ValueKey('conversation.message.$original'),
                  headingKey: index == 0 ? _latestHeading : null,
                  author: user ? '사용자' : '부장',
                  text: message['text']?.toString() ?? '',
                  time: message['at'],
                  user: user,
                  label: user ? '요청' : '답변 완료',
                );
              },
            ),
          ),
        ),
      ],
    );
  }
}

class WorkflowMeetingNotes extends StatelessWidget {
  const WorkflowMeetingNotes({
    super.key,
    required this.meeting,
    required this.name,
    required this.progress,
  });
  final Map? meeting;
  final String Function(dynamic) name;
  final Widget progress;
  @override
  Widget build(BuildContext context) {
    if (meeting == null) {
      return const Center(
        child: Text(
          '회의가 시작되면 참석자별 의견과 회의록을 여기서 볼 수 있어요.',
          style: TextStyle(color: Colors.white60),
        ),
      );
    }
    final contributions = workflowRows(meeting!['contributions']);
    return ListView(
      key: const PageStorageKey('workflow.meeting'),
      padding: const EdgeInsets.only(top: 12, right: 10),
      children: [
        progress,
        const SizedBox(height: 12),
        Text(
          '참석자: ${(meeting!['participants'] as List? ?? []).map(name).join(', ')}',
          style: const TextStyle(
            fontSize: 13,
            color: Colors.white70,
            height: 1.7,
          ),
        ),
        const SizedBox(height: 16),
        if (meeting!['minutes'] != null)
          WorkflowEntryCard(
            author: '부장',
            label: '회의 결정',
            text: meeting!['minutes'].toString(),
            accent: const Color(0xFFB7C9FF),
          ),
        for (final round in [1, 2])
          if (contributions.any((c) => c['round'] == round))
            ExpansionTile(
              key: PageStorageKey('meeting.round.$round'),
              initiallyExpanded:
                  meeting!['round'] == round || meeting!['state'] == 'deciding',
              tilePadding: EdgeInsets.zero,
              title: Text(
                '$round차 회의 · ${round == 1 ? '접근 방법과 역할' : '의견 검토와 조율'}',
                style: const TextStyle(
                  fontWeight: FontWeight.w700,
                  fontSize: 15,
                ),
              ),
              subtitle: Text(
                '의견 ${contributions.where((c) => c['round'] == round).length}건',
                style: const TextStyle(fontSize: 12, color: Colors.white54),
              ),
              children: [
                for (final c in contributions.where((c) => c['round'] == round))
                  WorkflowEntryCard(
                    author: name(c['memberId']),
                    label: '$round차 의견',
                    time: c['at'],
                    text: c['text']?.toString() ?? '',
                  ),
              ],
            ),
        if (contributions.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 28),
            child: Text(
              '아직 제출된 의견이 없습니다.',
              style: TextStyle(color: Colors.white60),
            ),
          ),
      ],
    );
  }
}

class WorkflowPlan extends StatelessWidget {
  const WorkflowPlan({super.key, required this.workflow, required this.name});
  final Map? workflow;
  final String Function(dynamic) name;
  @override
  Widget build(BuildContext context) {
    final assignments = workflowRows(workflow?['assignments']);
    final brief = workflow?['brief']?.toString() ?? '';
    return ListView(
      key: const PageStorageKey('workflow.plan'),
      padding: const EdgeInsets.only(top: 12, right: 10),
      children: [
        if (workflow?['result'] != null)
          WorkflowEntryCard(
            author: '부장',
            label: '최종 보고 · 검수',
            text: workflow!['result'].toString(),
          ),
        if (brief.isNotEmpty)
          ExpansionTile(
            key: const PageStorageKey('workflow.plan.brief'),
            tilePadding: EdgeInsets.zero,
            initiallyExpanded: assignments.isEmpty,
            title: const Text(
              '공유 작업안',
              style: TextStyle(fontWeight: FontWeight.w700),
            ),
            children: [
              Padding(
                padding: const EdgeInsets.only(bottom: 20),
                child: WorkflowText(brief),
              ),
            ],
          ),
        if (assignments.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 24),
            child: Text(
              '회의에서 계획을 확정하면 팀별 담당 업무가 여기에 표시됩니다.',
              style: TextStyle(color: Colors.white60, height: 1.7),
            ),
          ),
        for (final a in assignments)
          WorkflowEntryCard(
            author: name(a['leadId']),
            label:
                const {
                  'queued': '선행 업무 대기',
                  'assigned': '업무 진행',
                  'done': '완료',
                  'blocked': '문제 확인',
                }[a['status']] ??
                '대기',
            text:
                '${a['task']}\n\n### 완료 기준\n${(a['acceptance'] as List? ?? []).map((s) => '- $s').join('\n')}${(a['dependsOn'] as List? ?? []).isEmpty ? '' : '\n\n**선행 담당:** ${(a['dependsOn'] as List).map(name).join(' / ')}'}',
            accent: a['status'] == 'done'
                ? const Color(0xFF9EDCC2)
                : const Color(0xFFB7C9FF),
          ),
      ],
    );
  }
}
