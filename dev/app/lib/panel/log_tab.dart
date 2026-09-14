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
            color: backfill.error != null ? Colors.red.withValues(alpha: 0.15) : Colors.white10,
            child: Text(
              backfill.error != null ? '과거 이벤트 조회 실패: ${backfill.error}' : '과거 이벤트 불러오는 중…',
              style: const TextStyle(fontSize: 11, color: Colors.white70),
            ),
          ),
        Expanded(
          child: events.isEmpty
              ? const Center(child: Text('아직 이벤트 없음', style: TextStyle(color: Colors.white38)))
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

  @override
  Widget build(BuildContext context) {
    final detail = eventDetailLine(event);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            formatClock(event.ts),
            style: const TextStyle(fontSize: 11, color: Colors.white38, fontFamily: panelMonoFamily, fontFamilyFallback: panelMonoFallback),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 58,
            child: Text(
              eventKindLabel(event.kind),
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: eventKindColor(event.kind)),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              detail,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12, color: Colors.white70, fontFamily: panelMonoFamily, fontFamilyFallback: panelMonoFallback),
            ),
          ),
        ],
      ),
    );
  }
}
