// 오른쪽 패널(T13) — 선택된 멤버의 헤더 + 탭(로그 · 터미널 · 변경 파일 · 보고서).
//
//  RightPanel(memberId: null)  → "캐릭터를 선택하세요"
//  RightPanel(memberId: 'm_…') → PanelHeader(이름 · 엔진 · 상태 · 팀 cwd · 출근 후 경과) + TabBar
//     로그      LogTab       (lib/panel/log_tab.dart)      memberLogProvider — 백필 ∪ 라이브
//     터미널    TerminalTab  (lib/panel/terminal_tab.dart) xterm + member.attach/term/type/resize/detach
//     변경 파일 자리(추후)
//     보고서    자리 — 지금은 마지막 `text` 이벤트 본문(latestTextEventProvider)
//
// 탭 위치(DefaultTabController)는 멤버가 바뀌어도 유지된다. TabBarView 는 보이지 않는 탭을 내리므로
// 터미널 탭은 숨겨지면 detach, 다시 보이면 attach 한다.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../state/office_state.dart';
import 'labels.dart';
import 'log_tab.dart';
import 'member_log.dart';
import 'terminal_tab.dart';

export 'labels.dart' show eventKindLabel, memberStatusLabel, derivedStatusLabel;
export 'log_tab.dart' show LogTab, LogRow;
export 'member_log.dart' show memberLogProvider, memberBackfillProvider, latestTextEventProvider, MemberBackfill;
export 'terminal_tab.dart' show TerminalTab, describeAttachError;

/// 탭 순서(테스트·외부에서 인덱스로 고를 때).
enum RightPanelTab { log, terminal, files, report }

class RightPanel extends ConsumerWidget {
  const RightPanel({super.key, required this.memberId, this.initialTab = RightPanelTab.log});

  /// 선택된 멤버. null 이면 안내 문구만.
  final String? memberId;
  final RightPanelTab initialTab;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final id = memberId;
    final surface = Theme.of(context).colorScheme.surfaceContainerLow;
    if (id == null) {
      return Container(
        color: surface,
        alignment: Alignment.center,
        child: const Text('캐릭터를 선택하세요', style: TextStyle(color: Colors.white38, fontSize: 14)),
      );
    }
    final member = ref.watch(memberProvider(id));
    return Container(
      color: surface,
      child: DefaultTabController(
        length: RightPanelTab.values.length,
        initialIndex: initialTab.index,
        child: Column(
          children: [
            if (member == null)
              _UnknownMemberHeader(memberId: id)
            else
              PanelHeader(member: member),
            const TabBar(
              tabs: [Tab(text: '로그'), Tab(text: '터미널'), Tab(text: '변경 파일'), Tab(text: '보고서')],
              labelStyle: TextStyle(fontSize: 13),
              labelPadding: EdgeInsets.symmetric(horizontal: 8),
            ),
            Expanded(
              child: TabBarView(
                children: [
                  LogTab(memberId: id),
                  TerminalTab(memberId: id),
                  const _PlaceholderTab('변경 파일 (추후)'),
                  ReportTab(memberId: id),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 헤더: `이름 · 엔진 · 상태 · 팀 cwd · 출근 후 경과`.
class PanelHeader extends ConsumerWidget {
  const PanelHeader({super.key, required this.member});

  final Member member;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final team = ref.watch(teamsProvider)[member.teamId];
    final derived = ref.watch(derivedStatusProvider(member.id));
    final statusLabel = derived != null && derived.wire != member.status.wire
        ? derivedStatusLabel(derived)
        : memberStatusLabel(member.status);
    final hired = DateTime.tryParse(member.createdAt);
    final cwd = team?.cwd ?? member.cwd;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
      color: Theme.of(context).colorScheme.surfaceContainerHigh,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(member.name, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold)),
              const SizedBox(width: 8),
              _Badge(member.engine.name),
              const SizedBox(width: 8),
              Icon(Icons.circle, size: 9, color: memberStatusColor(member.status)),
              const SizedBox(width: 4),
              Text(statusLabel, style: const TextStyle(fontSize: 12, color: Colors.white70)),
              const Spacer(),
              if (hired != null) ElapsedSince(since: hired),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '${team?.name ?? member.teamId} · $cwd',
            style: const TextStyle(fontSize: 11, color: Colors.white54, fontFamily: panelMonoFamily, fontFamilyFallback: panelMonoFallback),
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}

class _UnknownMemberHeader extends StatelessWidget {
  const _UnknownMemberHeader({required this.memberId});
  final String memberId;

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
        color: Theme.of(context).colorScheme.surfaceContainerHigh,
        child: Text('멤버 정보 없음 · $memberId', style: const TextStyle(fontSize: 13, color: Colors.white54)),
      );
}

class _Badge extends StatelessWidget {
  const _Badge(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
        decoration: BoxDecoration(
          border: Border.all(color: Colors.white24),
          borderRadius: BorderRadius.circular(4),
        ),
        child: Text(text, style: const TextStyle(fontSize: 11, color: Colors.white70)),
      );
}

/// "출근 N분" — 30초마다 갱신.
class ElapsedSince extends StatefulWidget {
  const ElapsedSince({super.key, required this.since, this.prefix = '출근 '});

  final DateTime since;
  final String prefix;

  @override
  State<ElapsedSince> createState() => _ElapsedSinceState();
}

class _ElapsedSinceState extends State<ElapsedSince> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Text(
        '${widget.prefix}${formatElapsed(DateTime.now().difference(widget.since))}',
        style: const TextStyle(fontSize: 11, color: Colors.white54),
      );
}

class _PlaceholderTab extends StatelessWidget {
  const _PlaceholderTab(this.label);
  final String label;

  @override
  Widget build(BuildContext context) => Center(child: Text(label, style: const TextStyle(color: Colors.white38)));
}

/// 보고서 탭 자리(v1a): 마지막 `text` 이벤트(턴 종료 시 마지막 assistant 메시지) 본문. T18 에서 교체.
class ReportTab extends ConsumerWidget {
  const ReportTab({super.key, required this.memberId});

  final String memberId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ev = ref.watch(latestTextEventProvider(memberId));
    if (ev == null) {
      return const Center(child: Text('아직 응답 없음', style: TextStyle(color: Colors.white38)));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          child: Text('마지막 응답 · ${formatClockSeconds(ev.ts)} · #${ev.seq}', style: const TextStyle(fontSize: 11, color: Colors.white38)),
        ),
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
            child: SelectableText(
              ev.detail.text ?? '',
              style: const TextStyle(fontSize: 12.5, height: 1.4, color: Colors.white70, fontFamily: panelMonoFamily, fontFamilyFallback: panelMonoFallback),
            ),
          ),
        ),
      ],
    );
  }
}
