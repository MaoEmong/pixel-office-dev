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
import '../office/office_painter.dart' show legendColor;
import '../office/office_scene.dart' show LegendSlot, legendSlotFor;
import '../state/office_state.dart';
import 'inbox.dart';
import 'instructions_tab.dart';
import 'labels.dart';
import 'log_tab.dart';
import 'member_gone_banner.dart';
import 'panel_splitter.dart';
import 'panel_tabs.dart';
import 'pending_card.dart';
import 'report_tab.dart';
import 'terminal_tab.dart';
import 'ui_prefs.dart';

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
export 'approval_summary.dart';
export 'inbox.dart'
    show
        PendingInbox,
        InboxItem,
        InboxPendingItem,
        InboxExpiredItem,
        inboxItemsProvider,
        inboxCountProvider,
        inboxFocusProvider,
        inboxHeaderLabel,
        inboxMoreLabel,
        inboxExpandedCards,
        inboxEmptyLabel;
export 'labels.dart'
    show
        eventKindLabel,
        memberStatusLabel,
        derivedStatusLabel,
        panelFocusRing,
        panelFocusRingWidth,
        panelScrollbarThickness,
        panelScrollbarThumb,
        panelDangerTint,
        panelDangerColor;
export 'log_tab.dart' show LogTab, LogRow;
export 'member_gone_banner.dart' show MemberGoneBanner, RecoveryHint, memberFailureEventsProvider, recoveryExpiredCountProvider;
export 'member_log.dart' show memberLogProvider, memberBackfillProvider, latestTextEventProvider, MemberBackfill;
export 'panel_splitter.dart';
export 'panel_tabs.dart' show RightPanelTab, PanelTabRequest, panelTabRequestProvider;
export 'pending_card.dart'
    show PendingCards, PendingCard, ApprovalCard, QuestionCard, AskParentCard, askParentCardTitle, askParentOverrideLabel, userInboxPendings;
export 'redo_card.dart'
    show RedoCards, RedoCard, redoNeededProvider, globalRedoNeededProvider, redoInstructionProvider, describeRedoSummary, redoExpiredTitle;
export 'report_tab.dart'
    show
        ReportTab,
        ReportCard,
        MemberReport,
        memberReportsProvider,
        taskInstructionsProvider,
        parseTaskPrompt,
        reportHeaderLine,
        reportReadProvider,
        reportUnreadProvider;
export 'terminal_cache.dart' show terminalCacheProvider, TerminalCache, CachedTerminal;
export 'terminal_tab.dart' show TerminalTab, describeAttachError;
export 'ui_prefs.dart';

/// 헤더 아래 카드 영역의 최대 높이(넘치면 카드 영역 안에서 스크롤).
const double pendingCardsMaxHeight = 320;

/// 멤버를 안 골랐을 때의 안내(인박스는 그대로 보인다 — 패스 2 상태표).
const String panelNoSelectionHint = '캐릭터를 선택하세요';

class RightPanel extends ConsumerWidget {
  const RightPanel({super.key, required this.memberId, this.initialTab = RightPanelTab.log});

  /// 선택된 멤버. null 이면 인박스 + 안내 문구.
  final String? memberId;
  final RightPanelTab initialTab;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final id = memberId;
    final surface = Theme.of(context).colorScheme.surfaceContainerLow;
    // 인박스는 선택 멤버와 무관하다(D6) — 멤버를 안 골라도 헤더 자리 아래에 그대로 선다.
    if (id == null) {
      return Container(
        color: surface,
        child: const Column(
          children: [
            // 인박스가 제 높이 안에서 스크롤한다(T40d ②).
            Flexible(child: PendingInbox()),
            Expanded(
              child: Center(child: Text(panelNoSelectionHint, style: TextStyle(color: Colors.white38, fontSize: 14))),
            ),
          ],
        ),
      );
    }
    final member = ref.watch(memberProvider(id));
    return Container(
      color: surface,
      child: DefaultTabController(
        length: RightPanelTab.values.length,
        initialIndex: initialTab.index,
        child: _TabRequestListener(
          child: LayoutBuilder(
            builder: (context, box) => Column(
            children: [
              if (member == null)
                _UnknownMemberHeader(memberId: id)
              else ...[
                PanelHeader(member: member),
                MemberGoneBanner(member: member),
              ],
              // 전역 인박스(헤더 바로 아래, 선택 멤버와 무관 — D6) + 이 멤버의 안내 카드.
              // `backfillMemberId` 는 목록에 영향을 주지 않고 **만료 흔적**만 그 멤버의 백필에서 더 긁어온다.
              // 블록 높이는 `min(패널 높이 × inboxMaxHeightFraction, 내용)` 이고, 카드는 그 안에서
              // 스크롤한다. 헤더와 "+N" 줄은 스크롤 밖에 고정이라 접힘선 아래로 밀리지 않는다(T40d ②).
              ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: box.hasBoundedHeight ? box.maxHeight * inboxMaxHeightFraction : pendingCardsMaxHeight,
                ),
                child: PendingInbox(
                  backfillMemberId: id,
                  belowCards: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      RecoveryHint(memberId: id),
                      // 이 멤버 패널에만 남는 카드 = `ask_parent` 안내("대신 답하기"). 인박스 카드 뒤 · 탭 위.
                      PendingCards(memberId: id),
                    ],
                  ),
                ),
              ),
              _PanelTabBar(memberId: id),
              Expanded(
                child: TabBarView(
                  children: [
                    LogTab(memberId: id),
                    // 오버레이(Ctrl+T)가 열려 있으면 여기서는 붙이지 않는다 — attach 는 한 곳만(panel_splitter.dart).
                    ref.watch(terminalOverlayProvider)
                        ? const Center(
                            child: Padding(
                              padding: EdgeInsets.all(16),
                              child: Text(
                                terminalMovedToOverlay,
                                key: Key('panel.terminalMoved'),
                                textAlign: TextAlign.center,
                                style: TextStyle(fontSize: 12, color: Colors.white38),
                              ),
                            ),
                          )
                        : TerminalTab(memberId: id),
                    InstructionsTab(memberId: id),
                    ReportTab(memberId: id),
                  ],
                ),
              ),
            ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 탭 줄 — 보고서 탭에는 **미확인 배지**(마지막으로 연 뒤 도착한 보고 수, 앱 로컬). 탭을 열면 지워진다(이슈 9).
class _PanelTabBar extends ConsumerStatefulWidget {
  const _PanelTabBar({required this.memberId});

  final String memberId;

  @override
  ConsumerState<_PanelTabBar> createState() => _PanelTabBarState();
}

class _PanelTabBarState extends ConsumerState<_PanelTabBar> {
  TabController? _controller;

  /// dispose 에서 쓰려고 미리 잡아 둔다(`ref` 는 언마운트 뒤에 쓸 수 없다).
  PanelWidthNotifier? _panelWidth;

  void _onTab() {
    final c = _controller;
    if (c == null || c.indexIsChanging) return;
    if (c.index == RightPanelTab.report.index) {
      ref.read(reportReadProvider.notifier).markRead(widget.memberId);
    }
    // 터미널 탭이 열려 있는 동안 패널이 660 으로 벌어진다(패스 6).
    ref.read(panelWidthProvider.notifier).setTerminalActive(c.index == RightPanelTab.terminal.index);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _panelWidth = ref.read(panelWidthProvider.notifier);
    final c = DefaultTabController.of(context);
    if (identical(c, _controller)) return;
    _controller?.removeListener(_onTab);
    _controller = c..addListener(_onTab);
    // 보고서·터미널 탭이 이미 열린 채로 들어왔으면(initialTab, 멤버 교체) 바로 반영.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (c.index == RightPanelTab.report.index) ref.read(reportReadProvider.notifier).markRead(widget.memberId);
      ref.read(panelWidthProvider.notifier).setTerminalActive(c.index == RightPanelTab.terminal.index);
    });
  }

  @override
  void didUpdateWidget(covariant _PanelTabBar old) {
    super.didUpdateWidget(old);
    if (old.memberId != widget.memberId) _onTab();
  }

  @override
  void dispose() {
    _controller?.removeListener(_onTab);
    // 패널이 사라지면 터미널 자동 확장도 푼다(창을 닫았다 열어도 폭이 660 에 붙어 있지 않게).
    _panelWidth?.setTerminalActive(false);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final unread = ref.watch(reportUnreadProvider(widget.memberId));
    return TabBar(
      tabs: [
        const Tab(text: '로그'),
        const Tab(text: '터미널'),
        const Tab(text: '지시문'),
        Tab(
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('보고서'),
              if (unread > 0) ...[
                const SizedBox(width: 5),
                Container(
                  key: const Key('panel.reportBadge'),
                  padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                  decoration: BoxDecoration(color: legendColor(LegendSlot.idle), borderRadius: BorderRadius.circular(8)),
                  child: Text(
                    '$unread',
                    style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Colors.black87),
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
      labelStyle: const TextStyle(fontSize: 13),
      labelPadding: const EdgeInsets.symmetric(horizontal: 8),
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
    // 상태 점은 범례 7칸 매핑을 쓴다(D-42 3) — 사무실 링 색·하단 범례와 같은 색.
    // `ask_parent` 로 상사 답을 기다리는 중이면 "내 차례" 가 아니라 "대기" 다.
    final askingParent = ref.watch(openPendingProvider).values.any((p) => p.isAskParent && p.memberId == member.id);
    final legend = legendSlotFor(status: member.status, derived: derived, askingParent: askingParent);
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
              Tooltip(
                message: '${legend.label}${legend.icon.isEmpty ? '' : ' ${legend.icon}'}',
                child: Icon(
                  legend.dashedRing ? Icons.circle_outlined : Icons.circle,
                  key: const Key('panel.statusDot'),
                  size: 9,
                  color: legendColor(legend),
                ),
              ),
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
