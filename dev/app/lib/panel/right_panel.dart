// 오른쪽 패널(T13 · T15 · T18 · T26) — 선택된 멤버의 헤더 + 배너 + 카드 + 탭(로그 · 터미널 · 지시문 · 보고서).
//
//  RightPanel(memberId: null)  → "캐릭터를 선택하세요"
//  RightPanel(memberId: 'm_…') → PanelHeader(이름 · 엔진 · 상태 · 팀 cwd · 출근 후 경과)
//                                 + MemberGoneBanner(퇴근함 / 오류로 종료됨 + 재고용, T18 — status 가 exited/error 일 때만)
//                                 + RecoveryHint(데몬 재시작으로 만료된 요청 N건, T18)
//                                 + RedoCards(재지시 필요, T18) + PendingCards(열린 허가·질문 카드, T15) + TabBar
//     로그      LogTab       (lib/panel/log_tab.dart)      memberLogProvider — 백필 ∪ 라이브
//     터미널    TerminalTab  (lib/panel/terminal_tab.dart) xterm + member.attach/term/type/resize/detach, Terminal 은 terminalCacheProvider 에
//     지시문    InstructionsTab (lib/panel/instructions_tab.dart) member.instructions.get/set + member.restart,
//                                초안은 instructionsCacheProvider 에(탭을 오가도 유지)
//     보고서    ReportTab    (lib/panel/report_tab.dart)   reporting + 직전 text 로 되살린 task 보고, 최신 먼저
//
// 탭 위치(DefaultTabController)는 멤버가 바뀌어도 유지된다. TabBarView 는 보이지 않는 탭을 내리므로
// 터미널 탭은 숨겨지면 detach, 다시 보이면 attach 한다(Terminal 인스턴스는 캐시에 남아 스크롤백이 유지된다).
// `panelTabRequestProvider` 에 요청이 오면(재지시 카드 "터미널에서 답하기") 그 탭으로 animateTo.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../state/office_state.dart';
import 'instructions_tab.dart';
import 'labels.dart';
import 'log_tab.dart';
import 'member_gone_banner.dart';
import 'panel_tabs.dart';
import 'pending_card.dart';
import 'redo_card.dart';
import 'report_tab.dart';
import 'terminal_tab.dart';

export 'instructions_tab.dart'
    show
        InstructionsTab,
        InstructionsCache,
        InstructionsDraft,
        instructionsCacheProvider,
        instructionTemplate,
        instructionsHint,
        headInstructionTemplate,
        leaderInstructionTemplate,
        memberInstructionTemplate;
export 'labels.dart' show eventKindLabel, memberStatusLabel, derivedStatusLabel;
export 'log_tab.dart' show LogTab, LogRow;
export 'member_gone_banner.dart' show MemberGoneBanner, RecoveryHint, memberFailureEventsProvider, recoveryExpiredCountProvider;
export 'member_log.dart' show memberLogProvider, memberBackfillProvider, latestTextEventProvider, MemberBackfill;
export 'panel_tabs.dart' show RightPanelTab, PanelTabRequest, panelTabRequestProvider;
export 'pending_card.dart' show PendingCards, PendingInbox, PendingCard, ApprovalCard, QuestionCard, AskParentCard, askParentCardTitle, askParentOverrideLabel;
export 'redo_card.dart' show RedoCards, RedoCard, redoNeededProvider, redoInstructionProvider, describeRedoSummary;
export 'report_tab.dart' show ReportTab, ReportCard, MemberReport, memberReportsProvider, taskInstructionsProvider, parseTaskPrompt;
export 'terminal_cache.dart' show terminalCacheProvider, TerminalCache, CachedTerminal;
export 'terminal_tab.dart' show TerminalTab, describeAttachError;

/// 헤더 아래 카드 영역의 최대 높이(넘치면 카드 영역 안에서 스크롤).
const double pendingCardsMaxHeight = 320;

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
        child: _TabRequestListener(
          child: Column(
            children: [
              if (member == null)
                _UnknownMemberHeader(memberId: id)
              else ...[
                PanelHeader(member: member),
                MemberGoneBanner(member: member),
              ],
              RecoveryHint(memberId: id),
              // 재지시·허가·질문 카드(보통 0~1장). 길어지면 [pendingCardsMaxHeight] 까지만 차지하고 안에서 스크롤.
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: pendingCardsMaxHeight),
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [RedoCards(memberId: id), PendingCards(memberId: id)],
                  ),
                ),
              ),
              const TabBar(
                tabs: [Tab(text: '로그'), Tab(text: '터미널'), Tab(text: '지시문'), Tab(text: '보고서')],
                labelStyle: TextStyle(fontSize: 13),
                labelPadding: EdgeInsets.symmetric(horizontal: 8),
              ),
              Expanded(
                child: TabBarView(
                  children: [
                    LogTab(memberId: id),
                    TerminalTab(memberId: id),
                    InstructionsTab(memberId: id),
                    ReportTab(memberId: id),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// `panelTabRequestProvider` 요청 → DefaultTabController.animateTo. DefaultTabController 아래에 있어야 한다.
class _TabRequestListener extends ConsumerWidget {
  const _TabRequestListener({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen<PanelTabRequest?>(panelTabRequestProvider, (prev, next) {
      if (next == null || !context.mounted) return;
      DefaultTabController.of(context).animateTo(next.tab.index);
    });
    return child;
  }
}

/// 비-부장 멤버 패널에 붙는 안내 — 사용자 지시는 부장에게만 간다(D-32). 터미널 직접 타이핑은 그대로 된다.
const String panelNotInstructableHint = '지시는 부장에게 — 이 멤버는 상사가 일을 줍니다 (터미널 직접 입력은 가능)';

/// 트리 한 줄: `직급 · 상사: 이름(직급) · 직속 부하 N명`. 테스트·문서에서 참조.
String panelTreeLine({required MemberRank rank, required String? parentName, MemberRank? parentRank, required int childCount}) {
  final parent = parentName == null
      ? (rank == MemberRank.head ? '사용자' : '없음')
      : '$parentName(${(parentRank ?? MemberRank.member).label})';
  return '${rank.label} · 상사: $parent · 직속 부하 $childCount명';
}

/// 헤더: `이름 · 엔진 · 상태 · 직급/상사/부하 · 부서·팀 cwd · 출근 후 경과`.
class PanelHeader extends ConsumerWidget {
  const PanelHeader({super.key, required this.member});

  final Member member;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final team = member.teamId == null ? null : ref.watch(teamsProvider)[member.teamId];
    final department = ref.watch(departmentProvider(member.departmentId));
    final parent = ref.watch(parentProvider(member.id));
    final children = ref.watch(childrenProvider(member.id));
    final derived = ref.watch(derivedStatusProvider(member.id));
    final statusLabel = derived != null && derived.wire != member.status.wire
        ? derivedStatusLabel(derived)
        : memberStatusLabel(member.status);
    final hired = DateTime.tryParse(member.createdAt);
    final cwd = department?.cwd ?? team?.cwd ?? member.cwd;
    final scope = [
      if (department != null) department.name,
      if (team != null) '팀 ${team.name}',
    ].join(' · ');
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
            panelTreeLine(
              rank: member.rank,
              parentName: parent?.name,
              parentRank: parent?.rank,
              childCount: children.length,
            ),
            key: const Key('panel.treeLine'),
            style: const TextStyle(fontSize: 11.5, color: Colors.white70),
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 2),
          Text(
            '${scope.isEmpty ? member.departmentId : scope} · $cwd',
            style: const TextStyle(fontSize: 11, color: Colors.white54, fontFamily: panelMonoFamily, fontFamilyFallback: panelMonoFallback),
            overflow: TextOverflow.ellipsis,
          ),
          if (!member.rank.talksToUser) ...[
            const SizedBox(height: 4),
            Text(
              panelNotInstructableHint,
              key: const Key('panel.notInstructable'),
              style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.primary.withValues(alpha: 0.9)),
            ),
          ],
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
