// 로그 탭 — 선택 멤버의 오피스 이벤트 목록(최신이 아래). 행: `HH:MM · kind 라벨 · 상세(고정폭)`.
// 데이터는 `memberLogProvider(id)`(백필 ∪ 라이브, D-21). 맨 아래를 보고 있을 때만 새 이벤트에 따라 내려간다.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import 'labels.dart';
import 'member_log.dart';

class LogTab extends ConsumerStatefulWidget {
  const LogTab({super.key, required this.memberId});

  final String memberId;

  @override
  ConsumerState<LogTab> createState() => _LogTabState();
}

class _LogTabState extends ConsumerState<LogTab> {
  final _scroll = ScrollController();
  bool _atBottom = true;
  int _renderedCount = -1;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
  }

  @override
  void didUpdateWidget(covariant LogTab old) {
    super.didUpdateWidget(old);
    if (old.memberId != widget.memberId) {
      _atBottom = true;
      _renderedCount = -1;
    }
  }

  @override
  void dispose() {
    _scroll.removeListener(_onScroll);
    _scroll.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_scroll.hasClients) return;
    final p = _scroll.position;
    final atBottom = p.pixels >= p.maxScrollExtent - 8;
    if (atBottom != _atBottom) _atBottom = atBottom;
  }

  void _scrollToBottomIfNeeded(int count) {
    if (count == _renderedCount) return;
    _renderedCount = count;
    if (!_atBottom) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  @override
  Widget build(BuildContext context) {
    final events = ref.watch(memberLogProvider(widget.memberId));
    final backfill = ref.watch(memberBackfillProvider(widget.memberId));
    _scrollToBottomIfNeeded(events.length);
    return Column(
      children: [
        if (backfill.loading || backfill.error != null)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            color: backfill.error != null
                ? Colors.red.withValues(alpha: 0.15)
                : Colors.white10,
            child: Text(
              backfill.error != null
                  ? '과거 이벤트 조회 실패: ${backfill.error}'
                  : '과거 이벤트 불러오는 중…',
              style: const TextStyle(fontSize: 11, color: Colors.white70),
            ),
          ),
        Expanded(
          child: events.isEmpty
              ? const Center(
                  child: Text(
                    '아직 이벤트 없음',
                    style: TextStyle(color: Colors.white38),
                  ),
                )
              : Scrollbar(
                  controller: _scroll,
                  child: ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    itemCount: events.length,
                    itemBuilder: (context, i) => LogRow(event: events[i]),
                  ),
                ),
        ),
      ],
    );
  }
}

/// 로그 한 행. 테스트에서 `find.byType(LogRow)` 로 센다.
class LogRow extends StatelessWidget {
  const LogRow({super.key, required this.event});

  final OfficeEvent event;

  String get _message {
    final summary = event.detail.summary ?? '';
    if (event.kind == OfficeEventKind.text && summary == 'resumed') {
      return '대화 기록을 유지한 채 AI 연결을 복구했어요.';
    }
    if (event.kind == OfficeEventKind.error &&
        summary == 'restart: parent gone') {
      return '당시 상사 AI 연결이 없어 다시 연결하지 못했어요. 현재 상태는 위 안내에서 확인해 주세요.';
    }
    if (event.kind == OfficeEventKind.error && summary.startsWith('재지시 필요')) {
      return '작업 연결을 다시 시작하면서 이전 질문·승인 요청이 닫혔던 기록이에요. 현재 요청 상태는 위 알림에서 확인해 주세요.';
    }
    return eventDetailLine(event);
  }

  void _openDetail(BuildContext context) {
    final original = [
      event.detail.tool,
      event.detail.path,
      event.detail.cmd,
      event.detail.summary,
      event.detail.text,
    ].whereType<String>().where((s) => s.isNotEmpty).toSet().join('\n\n');
    showDialog<void>(
      context: context,
      builder: (context) => Dialog(
        insetPadding: const EdgeInsets.all(24),
        child: SizedBox(
          width: 850,
          height: MediaQuery.sizeOf(context).height * 0.8,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 12, 12, 8),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        '${formatClock(event.ts)} · ${eventKindLabel(event.kind)} 기록',
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: '닫기',
                      onPressed: () => Navigator.of(context).pop(),
                      icon: const Icon(Icons.close),
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      SelectableText(
                        _message,
                        style: const TextStyle(fontSize: 15, height: 1.6),
                      ),
                      if (original.isNotEmpty && original != _message) ...[
                        const SizedBox(height: 20),
                        const Text(
                          '기록 원문',
                          style: TextStyle(fontSize: 13, color: Colors.white60),
                        ),
                        const SizedBox(height: 8),
                        SelectableText(
                          original,
                          key: const Key('log.detail.fullText'),
                          style: const TextStyle(fontSize: 14, height: 1.6),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final detail = _message;
    final auto = event.detail.auto;
    return InkWell(
      onTap: () => _openDetail(context),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: Colors.white12)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Text(
                  formatClock(event.ts),
                  style: const TextStyle(
                    fontSize: 11,
                    color: Colors.white38,
                    fontFamily: panelMonoFamily,
                    fontFamilyFallback: panelMonoFallback,
                  ),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  width: 58,
                  child: Text(
                    eventKindLabel(event.kind),
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: eventKindColor(event.kind),
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                // U-02: 묻지 않고 넘긴 것은 로그에서 한눈에 보여야 한다 — 무엇이 내 허락 없이 실행됐는지의 기록이다.
                if (auto != null) ...[
                  const SizedBox(width: 6),
                  Tooltip(
                    message: autoApprovedTooltip(auto),
                    child: Container(
                      key: const Key('log.autoApproved'),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 5,
                        vertical: 1,
                      ),
                      decoration: BoxDecoration(
                        border: Border.all(
                          color: Colors.amber.withValues(alpha: 0.6),
                        ),
                        borderRadius: BorderRadius.circular(3),
                      ),
                      child: Text(
                        autoApprovedTag,
                        style: TextStyle(
                          fontSize: 10.5,
                          color: Colors.amber.withValues(alpha: 0.9),
                        ),
                      ),
                    ),
                  ),
                ],
                const Spacer(),
                const Icon(Icons.open_in_full, size: 13, color: Colors.white54),
              ],
            ),
            const SizedBox(height: 5),
            Text(
              detail,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 13,
                height: 1.5,
                color: Color(0xFFE1E3EB),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
