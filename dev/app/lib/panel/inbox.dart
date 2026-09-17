// 전역 인박스 "내 책상 · 대기 N"(T40-4, 레이아웃 v2 §3 패스 1 D6 · 패스 2 D10 · D-42 2).
//
// 오른쪽 패널 헤더 **바로 아래**, 선택 멤버와 **무관하게** 사용자 몫 pending 전부를 오래된 순으로 보여 준다
// (`Pending.goesToUser` — 허가 전부 + 부장 `ask_user` + TUI 질문). 사무실 내 책상의 슬롯·배지는 같은 목록의
// 그림이고(T40a), 카드에 답하면 양쪽에서 동시에 사라진다.
//
//  - 카드 **2장까지 펼치고** 3장째부터는 접힌 줄 `+N`(클릭하면 펼침).
//  - 복구로 만료된 허가(`error{pendingId}`)는 회색 **"만료 — 재지시"** 카드로 같은 목록 안에 들어온다(D10).
//  - 맨 위 카드에 `Alt+Y` 허가 / `Alt+N` 거부(Alt 조합 — 터미널 타이핑과 충돌하지 않게, 패스 6).
//  - `inboxFocusProvider` 에 pendingId 를 넣으면 그 카드로 스크롤한다(사무실 내 책상 슬롯 클릭 → main.dart 배선).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../office/office_painter.dart' show legendColor;
import '../office/office_scene.dart' show LegendSlot, myDeskHeaderLabel;
import '../rpc/rpc_client.dart';
import '../state/office_state.dart';
import 'labels.dart';
import 'pending_card.dart';
import 'redo_card.dart';

/// 펼쳐서 보여 주는 카드 수. 그 뒤는 "+N" 줄로 접는다(D6).
const int inboxExpandedCards = 2;

/// 인박스 + 안내 카드 영역이 패널 높이에서 차지할 수 있는 최대 비율(넘치면 그 안에서 스크롤).
const double inboxMaxHeightFraction = 0.55;

/// 인박스가 비었을 때.
const String inboxEmptyLabel = '대기 없음';

/// 인박스 헤더(N = 전체 대기 수, 접힌 것 포함). 문구는 사무실 내 책상과 **같은 함수**를 쓴다(T40c).
String inboxHeaderLabel(int count) => myDeskHeaderLabel(count);

/// "+N" 접힌 줄.
String inboxMoreLabel(int n) => '+$n';

// ---- 목록 --------------------------------------------------------------------------

/// 인박스 한 줄 — 열린 pending 이거나 만료된 요청(재지시)이다.
sealed class InboxItem {
  const InboxItem();

  /// 위젯 키·스크롤 대상 id(pending id).
  String get id;

  /// 정렬 기준(ISO 시각, 오래된 순).
  String get at;

  String get memberId;
}

class InboxPendingItem extends InboxItem {
  const InboxPendingItem(this.pending);

  final Pending pending;

  @override
  String get id => pending.id;
  @override
  String get at => pending.createdAt;
  @override
  String get memberId => pending.memberId;
}

class InboxExpiredItem extends InboxItem {
  const InboxExpiredItem(this.event);

  final OfficeEvent event;

  @override
  String get id => event.detail.pendingId ?? 'e${event.seq}';
  @override
  String get at => event.ts;
  @override
  String get memberId => event.memberId;
}

/// 인박스 목록(오래된 순) — 사용자 몫 pending + 만료된 요청.
///
/// 만료 흔적은 **전역 이벤트 링**에서 온다. 인자로 멤버 id 를 주면 그 멤버의 **백필**(`events.query`, 선택 멤버만
/// 불러온다)까지 합친다 — 앱을 켜자마자 패널을 열었을 때 "재시작으로 만료됨" 이 보이려면 그 길밖에 없다.
final inboxItemsProvider = Provider.family<List<InboxItem>, String?>((ref, backfillMemberId) {
  final pendings = userInboxPendings(ref.watch(openPendingProvider), ref.watch(membersProvider));
  final expired = <String, OfficeEvent>{
    for (final e in ref.watch(globalRedoNeededProvider)) e.detail.pendingId ?? 'e${e.seq}': e,
    if (backfillMemberId != null)
      for (final e in ref.watch(redoNeededProvider(backfillMemberId))) e.detail.pendingId ?? 'e${e.seq}': e,
  };
  final items = <InboxItem>[
    for (final p in pendings) InboxPendingItem(p),
    for (final e in expired.values) InboxExpiredItem(e),
  ]..sort((a, b) {
      final c = a.at.compareTo(b.at);
      return c != 0 ? c : a.id.compareTo(b.id);
    });
  return List<InboxItem>.unmodifiable(items);
});

/// 인박스 대기 수(사무실 내 책상 배지와 같은 수 — 백필 없이 전역만).
final inboxCountProvider = Provider<int>((ref) => ref.watch(inboxItemsProvider(null)).length);

// ---- 스크롤 요청 --------------------------------------------------------------------

class InboxFocusRequest {
  const InboxFocusRequest(this.pendingId, this.nonce);

  final String pendingId;

  /// 같은 카드를 두 번 눌러도 리스너가 불리도록.
  final int nonce;
}

class InboxFocusNotifier extends Notifier<InboxFocusRequest?> {
  int _nonce = 0;

  @override
  InboxFocusRequest? build() => null;

  /// 사무실 내 책상 슬롯 클릭 → 그 카드로 스크롤(+ 접혀 있으면 펼침).
  void focus(String pendingId) => state = InboxFocusRequest(pendingId, ++_nonce);
}

/// 사무실(T40a `OfficeView.onSelectPending`) → 인박스 스크롤.
final inboxFocusProvider = NotifierProvider<InboxFocusNotifier, InboxFocusRequest?>(InboxFocusNotifier.new);

// ---- 위젯 --------------------------------------------------------------------------

class PendingInbox extends ConsumerStatefulWidget {
  const PendingInbox({super.key, this.backfillMemberId, this.belowCards});

  /// 이 멤버의 백필(`events.query`)에 있는 만료 흔적까지 인박스에 넣는다(보통 선택 멤버).
  final String? backfillMemberId;

  /// 카드 **뒤**, 스크롤 영역 안에 같이 들어가는 것(선택 멤버의 복구 안내 · `ask_parent` 안내 카드).
  /// 인박스 블록 하나가 높이 상한을 가지므로 이것들도 같은 스크롤 영역에 있어야 탭을 밀어내지 않는다(T40d ②).
  final Widget? belowCards;

  @override
  ConsumerState<PendingInbox> createState() => _PendingInboxState();
}

class _PendingInboxState extends ConsumerState<PendingInbox> {
  final Map<String, GlobalKey> _itemKeys = {};
  final ScrollController _scroll = ScrollController();

  /// "+N" 을 눌러 전부 펼쳤는가.
  bool _showAll = false;

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_onKey);
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onKey);
    _scroll.dispose();
    super.dispose();
  }

  GlobalKey _keyOf(String id) => _itemKeys.putIfAbsent(id, GlobalKey.new);

  // ---- 단축키(Alt+Y / Alt+N) ------------------------------------------------------

  /// 맨 위 카드가 허가 요청이면 `Alt+Y` 허가 / `Alt+N` 거부. 그 밖의 키는 건드리지 않는다.
  bool _onKey(KeyEvent e) {
    if (e is! KeyDownEvent || !HardwareKeyboard.instance.isAltPressed) return false;
    final allow = e.logicalKey == LogicalKeyboardKey.keyY;
    final deny = e.logicalKey == LogicalKeyboardKey.keyN;
    if (!allow && !deny) return false;
    final top = _topApproval();
    if (top == null) return false;
    if (ref.read(connectionStateProvider) != RpcConnectionState.connected) return false;
    ref.read(officeProvider.notifier).respondApproval(top.id, allow: allow).catchError((Object _) {});
    return true;
  }

  Pending? _topApproval() {
    final items = ref.read(inboxItemsProvider(widget.backfillMemberId));
    if (items.isEmpty) return null;
    final first = items.first;
    if (first is! InboxPendingItem) return null;
    return first.pending.type == PendingType.approval ? first.pending : null;
  }

  // ---- 스크롤 요청 ----------------------------------------------------------------

  void _handleFocusRequest(InboxFocusRequest req) {
    final items = ref.read(inboxItemsProvider(widget.backfillMemberId));
    final index = items.indexWhere((i) => i.id == req.pendingId);
    if (index < 0) return;
    if (index >= inboxExpandedCards && !_showAll) setState(() => _showAll = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final ctx = _itemKeys[req.pendingId]?.currentContext;
      // 인박스를 감싼 스크롤 영역은 RightPanel 이 준다(없으면 스크롤할 것도 없다).
      if (ctx != null && Scrollable.maybeOf(ctx) != null) {
        Scrollable.ensureVisible(ctx, duration: const Duration(milliseconds: 180), alignment: 0.1);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<InboxFocusRequest?>(inboxFocusProvider, (prev, next) {
      if (next != null && next.nonce != prev?.nonce) _handleFocusRequest(next);
    });
    // 높이 상한이 있는지(= RightPanel 이 패널 높이의 55% 로 묶었는지)는 **Column 바깥**에서만 알 수 있다
    // — Column 은 자식에게 세로 무한 제약을 준다.
    return LayoutBuilder(builder: (context, box) => _block(context, bounded: box.hasBoundedHeight));
  }

  Widget _block(BuildContext context, {required bool bounded}) {
    final items = ref.watch(inboxItemsProvider(widget.backfillMemberId));
    final members = ref.watch(membersProvider);
    final shown = _showAll ? items.length : items.length.clamp(0, inboxExpandedCards);
    final hidden = items.length - shown;

    // 카드(+ 선택 멤버의 안내)는 스크롤 영역 안, 헤더와 "+N" 줄은 그 바깥에 **고정**된다(T40d ②).
    final cards = <Widget>[
      for (var i = 0; i < shown; i++)
        KeyedSubtree(
          key: _keyOf(items[i].id),
          child: _InboxRow(item: items[i], members: members, top: i == 0),
        ),
      ?widget.belowCards,
    ];
    return Container(
      key: const Key('inbox'),
      width: double.infinity,
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainer,
        border: const Border(bottom: BorderSide(color: Colors.white12)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 2),
            child: Row(
              children: [
                Icon(
                  Icons.inbox,
                  size: 14,
                  color: items.isEmpty ? Colors.white38 : legendColor(LegendSlot.myTurn),
                ),
                const SizedBox(width: 6),
                Text(
                  inboxHeaderLabel(items.length),
                  key: const Key('inbox.header'),
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.bold,
                    color: items.isEmpty ? Colors.white54 : legendColor(LegendSlot.myTurn),
                  ),
                ),
                const Spacer(),
                if (items.isEmpty)
                  const Text(inboxEmptyLabel, style: TextStyle(fontSize: 11.5, color: Colors.white38)),
              ],
            ),
          ),
          // 높이가 정해져 있으면(RightPanel 의 55% 상한) 카드만 **그 안에서** 스크롤하고,
          // 정해져 있지 않으면(감싸는 쪽이 스크롤을 준다) 그냥 쌓는다 — 스크롤 두 겹 방지.
          // `Flexible`(loose) 이라 블록 높이는 `min(상한, 내용)` 이 된다.
          if (cards.isNotEmpty)
            if (bounded)
              Flexible(
                child: Scrollbar(
                  controller: _scroll,
                  thumbVisibility: true,
                  thickness: panelScrollbarThickness,
                  child: SingleChildScrollView(
                    key: const Key('inbox.scroll'),
                    controller: _scroll,
                    primary: false,
                    child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: cards),
                  ),
                ),
              )
            else
              Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: cards),
          // "+N" 접힌 줄과 "접기" 는 스크롤 **밖**에 고정 — 접힘선 아래로 밀리지 않게(T40d ②).
          if (hidden > 0)
            InkWell(
              key: const Key('inbox.more'),
              onTap: () => setState(() => _showAll = true),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
                child: Row(
                  children: [
                    Text(
                      inboxMoreLabel(hidden),
                      style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.bold, color: Colors.white70),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        _collapsedSummary(items.sublist(shown), members),
                        style: const TextStyle(fontSize: 11.5, color: Colors.white38),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const Icon(Icons.expand_more, size: 16, color: Colors.white38),
                  ],
                ),
              ),
            ),
          if (_showAll && items.length > inboxExpandedCards)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                key: const Key('inbox.collapse'),
                onPressed: () => setState(() => _showAll = false),
                style: TextButton.styleFrom(
                  visualDensity: VisualDensity.compact,
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                ),
                child: const Text('접기', style: TextStyle(fontSize: 11.5, color: Colors.white54)),
              ),
            ),
        ],
      ),
    );
  }

  String _collapsedSummary(List<InboxItem> rest, Map<String, Member> members) => rest
      .map((i) => switch (i) {
            InboxPendingItem(:final pending) => members[pending.memberId]?.name ?? pending.memberId,
            InboxExpiredItem(:final event) => members[event.memberId]?.name ?? event.memberId,
          })
      .toSet()
      .join(' · ');
}

/// 카드 한 장 + 그 위에 누구 것인지(멤버 이름 · 시각).
class _InboxRow extends StatelessWidget {
  const _InboxRow({required this.item, required this.members, required this.top});

  final InboxItem item;
  final Map<String, Member> members;

  /// 맨 위 카드(단축키 힌트).
  final bool top;

  @override
  Widget build(BuildContext context) {
    final name = members[item.memberId]?.name ?? item.memberId;
    return Column(
      key: ValueKey('inbox-${item.id}'),
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 6, 12, 0),
          child: Text('$name · ${formatClock(item.at)}', style: const TextStyle(fontSize: 11, color: Colors.white54)),
        ),
        switch (item) {
          InboxPendingItem(:final pending) => PendingCard(pending: pending, shortcutHint: top),
          InboxExpiredItem(:final event) => RedoCard(event: event, expired: true),
        },
      ],
    );
  }
}
