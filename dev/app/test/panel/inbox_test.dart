// 전역 인박스(T40-4, D6·D10·패스 6): 선택 멤버와 무관 · 오래된 순 · 2장 펼침 + "+N" ·
// 만료 카드 · Alt+Y/Alt+N · 사무실 슬롯 클릭(inboxFocusProvider) 스크롤.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/panel/inbox.dart';
import 'package:pixel_office/panel/pending_card.dart';

import 'package:pixel_office/panel/right_panel.dart' hide PendingInbox, inboxHeaderLabel, inboxMoreLabel, inboxFocusProvider, inboxItemsProvider, inboxCountProvider, inboxExpandedCards, inboxEmptyLabel;
import 'package:pixel_office/state/office_state.dart';

import 'panel_harness.dart';

Map<String, dynamic> approvalJson(String id, {required String memberId, required String command, required String createdAt}) =>
    pendingJson(id, memberId: memberId, createdAt: createdAt, payload: {
      'tool_name': 'Bash',
      'tool_input': {'command': command},
    });

void main() {
  late PanelFakeDaemon daemon;

  setUp(() async {
    daemon = await startDaemon();
    daemon.handlers['approval.respond'] = (_) => {};
    daemon.handlers['question.respond'] = (_) => {};
  });
  tearDown(() => daemon.stop());

  testWidgets('선택 멤버와 무관하게 사용자 몫 pending 이 전부, 오래된 순으로 선다', (tester) async {
    daemon.snapshotBody['members'] = [
      memberJson('mH', name: '부장', rank: 'head'),
      memberJson('m1', name: '하루', parentId: 'mH'),
      memberJson('m2', name: '모시', parentId: 'mH'),
    ];
    daemon.snapshotBody['pending'] = [
      approvalJson('a2', memberId: 'm2', command: 'ls', createdAt: '2026-09-17T02:00:00.000Z'),
      approvalJson('a1', memberId: 'm1', command: 'pwd', createdAt: '2026-09-17T01:00:00.000Z'),
    ];
    await tester.runAsync(() async {
      // m1 을 골랐지만 m2 의 허가도 같은 인박스에 있다.
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.byType(PendingCard).evaluate().length == 2, reason: 'both cards');
      expect(
        tester.widgetList<PendingCard>(find.byType(PendingCard)).map((w) => w.pending.id),
        ['a1', 'a2'],
      );
      expect(find.text(inboxHeaderLabel(2)), findsOneWidget);
      expect(find.textContaining('하루 ·'), findsOneWidget);
      expect(find.textContaining('모시 ·'), findsOneWidget);
    });
  });

  testWidgets('`ask_parent` 는 인박스에서 빠지고 부장 아닌 멤버의 ask_user 도 빠진다', (tester) async {
    daemon.snapshotBody['pending'] = [
      pendingJson('p1', memberId: 'm1', type: 'question', createdAt: '2026-09-17T01:00:00.000Z', payload: {
        'source': 'ask_parent',
        'question': '지워도 됩니까?',
        'from': 'm1',
        'to': 'm2',
      }),
      pendingJson('u1', memberId: 'm2', type: 'question', createdAt: '2026-09-17T02:00:00.000Z', payload: {
        'source': 'ask_user',
        'question': '팀원이 사용자에게?',
      }),
    ];
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const SingleChildScrollView(child: PendingInbox()));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => c.read(openPendingProvider).length == 2, reason: 'pending loaded');
      await tester.pump();
      expect(find.byType(PendingCard), findsNothing);
      expect(find.text(inboxHeaderLabel(0)), findsOneWidget);
      expect(find.text(inboxEmptyLabel), findsOneWidget);
    });
  });

  testWidgets('2장까지 펼치고 3장째부터 "+N" — 누르면 펼쳐지고 접을 수 있다', (tester) async {
    daemon.snapshotBody['pending'] = [
      for (var i = 0; i < 5; i++)
        approvalJson('a$i', memberId: 'm1', command: 'echo $i', createdAt: '2026-09-17T0$i:00:00.000Z'),
    ];
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const SingleChildScrollView(child: PendingInbox()));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.byType(PendingCard).evaluate().isNotEmpty, reason: 'cards');
      expect(find.byType(PendingCard), findsNWidgets(inboxExpandedCards));
      expect(find.text(inboxHeaderLabel(5)), findsOneWidget); // 헤더 N 은 전체 수
      expect(find.text(inboxMoreLabel(3)), findsOneWidget);

      await tester.ensureVisible(find.byKey(const Key('inbox.more')));
      await tester.tap(find.byKey(const Key('inbox.more')));
      await tester.pump();
      expect(find.byType(PendingCard), findsNWidgets(5));
      expect(find.byKey(const Key('inbox.more')), findsNothing);

      await tester.ensureVisible(find.byKey(const Key('inbox.collapse')));
      await tester.tap(find.byKey(const Key('inbox.collapse')));
      await tester.pump();
      expect(find.byType(PendingCard), findsNWidgets(inboxExpandedCards));
    });
  });

  testWidgets('맨 위 카드에 Alt+Y = 허가 / Alt+N = 거부 (힌트 글자도 맨 위에만)', (tester) async {
    daemon.snapshotBody['pending'] = [
      approvalJson('a1', memberId: 'm1', command: 'pwd', createdAt: '2026-09-17T01:00:00.000Z'),
      approvalJson('a2', memberId: 'm1', command: 'ls', createdAt: '2026-09-17T02:00:00.000Z'),
    ];
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const SingleChildScrollView(child: PendingInbox()));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.byType(ApprovalCard).evaluate().length == 2, reason: 'cards');
      expect(find.text(approvalShortcutHint), findsOneWidget); // 맨 위 카드에만

      await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyY);
      await pumpUntil(tester, () => daemon.countOf('approval.respond') == 1, reason: 'alt+y allow');
      expect(daemon.paramsOf('approval.respond').single, {'pendingId': 'a1', 'behavior': 'allow'});

      // 맨 위가 a2 로 바뀌고 Alt+N 은 거부
      await pumpUntil(tester, () => find.byType(ApprovalCard).evaluate().length == 1, reason: 'a1 gone');
      await tester.sendKeyEvent(LogicalKeyboardKey.keyN);
      await pumpUntil(tester, () => daemon.countOf('approval.respond') == 2, reason: 'alt+n deny');
      expect(daemon.paramsOf('approval.respond').last, {'pendingId': 'a2', 'behavior': 'deny'});
      await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
    });
  });

  testWidgets('Alt 없이 누른 Y/N 은 아무 일도 하지 않는다', (tester) async {
    daemon.snapshotBody['pending'] = [approvalJson('a1', memberId: 'm1', command: 'pwd', createdAt: '2026-09-17T01:00:00.000Z')];
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const SingleChildScrollView(child: PendingInbox()));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.byType(ApprovalCard).evaluate().isNotEmpty, reason: 'card');
      await tester.sendKeyEvent(LogicalKeyboardKey.keyY);
      await tester.pump();
      expect(daemon.countOf('approval.respond'), 0);
    });
  });

  testWidgets('맨 위가 질문 카드면 Alt+Y 는 아무 일도 하지 않는다', (tester) async {
    daemon.snapshotBody['members'] = [memberJson('mH', name: '부장', rank: 'head')];
    daemon.snapshotBody['pending'] = [
      pendingJson('q1', memberId: 'mH', type: 'question', createdAt: '2026-09-17T01:00:00.000Z',
          payload: {'source': 'ask_user', 'question': '배포할까?'}),
    ];
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const SingleChildScrollView(child: PendingInbox()));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.byType(QuestionCard).evaluate().isNotEmpty, reason: 'question card');
      await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyY);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
      await tester.pump();
      expect(daemon.countOf('approval.respond'), 0);
      expect(find.text(approvalShortcutHint), findsNothing);
    });
  });

  testWidgets('만료된 요청은 회색 "만료 — 재지시" 카드로 같은 목록에, 시간순으로 섞인다', (tester) async {
    daemon.snapshotBody['pending'] = [
      approvalJson('a9', memberId: 'm1', command: 'pwd', createdAt: '2999-01-01T00:00:00.000Z'), // 항상 마지막
    ];
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const SingleChildScrollView(child: PendingInbox()));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.byType(ApprovalCard).evaluate().isNotEmpty, reason: 'approval');
      daemon.emitEvent({
        ...ev(40, kind: 'error', detail: {'summary': '재지시 필요: 허가 요청이 재시작으로 만료됨', 'pendingId': 'x1', 'pendingType': 'approval'}),
      });
      await pumpUntil(tester, () => find.byType(RedoCard).evaluate().isNotEmpty, reason: 'expired card');
      expect(find.text(redoExpiredTitle), findsOneWidget);
      expect(find.text(inboxHeaderLabel(2)), findsOneWidget);
      // 만료(지금) 가 2999년 허가보다 앞이다.
      final items = c.read(inboxItemsProvider(null));
      expect(items.map((i) => i.id), ['x1', 'a9']);
    });
  });

  testWidgets('inboxFocusProvider: 접힌 카드를 가리키면 펼쳐진다(사무실 내 책상 슬롯 클릭)', (tester) async {
    daemon.snapshotBody['pending'] = [
      for (var i = 0; i < 4; i++)
        approvalJson('a$i', memberId: 'm1', command: 'echo $i', createdAt: '2026-09-17T0$i:00:00.000Z'),
    ];
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.byType(PendingCard).evaluate().length == inboxExpandedCards, reason: 'collapsed');
      expect(find.byKey(const ValueKey('inbox-a3')), findsNothing);

      c.read(inboxFocusProvider.notifier).focus('a3');
      await tester.pump();
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('inbox-a3')), findsOneWidget);
      expect(find.byType(PendingCard), findsNWidgets(4));
    });
  });

  // T40d ② — 1280×720 실기에서 "+N" 줄과 `ask_parent` 안내 카드가 접힘선 아래로 밀렸다.
  group('인박스 블록은 패널 높이의 55% 안에서 스크롤한다', () {
    void fiveAndAskParent() {
      daemon.snapshotBody['members'] = [
        memberJson('mH', name: '부장', rank: 'head'),
        memberJson('m1', name: '하루', parentId: 'mH'),
      ];
      daemon.snapshotBody['pending'] = [
        for (var i = 0; i < 5; i++)
          approvalJson('a$i', memberId: 'm1', command: 'echo $i', createdAt: '2026-09-17T0$i:00:00.000Z'),
        pendingJson('ap1', memberId: 'm1', type: 'question', createdAt: '2026-09-17T09:00:00.000Z', payload: {
          'source': 'ask_parent',
          'question': '지워도 됩니까?',
          'from': 'm1',
          'to': 'mH',
        }),
      ];
    }

    for (final height in [720.0, 640.0]) {
      testWidgets('패널 높이 $height: 탭·"+N"·ask_parent 카드가 다 닿는다', (tester) async {
        fiveAndAskParent();
        await tester.runAsync(() async {
          final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'), size: Size(480, height));
          await pumpUntilConnected(tester, c);
          await pumpUntil(tester, () => find.byType(ApprovalCard).evaluate().length == inboxExpandedCards, reason: 'cards');
          await tester.pump();

          final panel = tester.getRect(find.byType(RightPanel));
          final block = tester.getRect(find.byKey(const Key('inbox')));
          // ① 블록은 패널 높이의 55% 를 넘지 않는다.
          expect(block.height <= height * inboxMaxHeightFraction + 0.5, isTrue, reason: '블록 ${block.height}');
          // ② 탭 줄은 언제나 패널 안에 보인다.
          final tabs = tester.getRect(find.byType(TabBar));
          expect(tabs.bottom <= panel.bottom + 0.5, isTrue, reason: '탭이 패널 밖: $tabs vs $panel');
          expect(tabs.top >= block.bottom - 0.5, isTrue, reason: '탭이 인박스에 덮였다');
          // ③ "+N" 접힌 줄은 스크롤 없이 보인다(블록 안 · 화면 안).
          final more = tester.getRect(find.byKey(const Key('inbox.more')));
          expect(more.bottom <= block.bottom + 0.5, isTrue, reason: '"+N" 이 블록 밖: $more');
          expect(more.bottom <= panel.bottom + 0.5, isTrue);
          // ④ ask_parent 안내 카드는 스크롤 영역 안에서 닿는다.
          expect(find.byType(AskParentCard), findsOneWidget);
          await tester.ensureVisible(find.byType(AskParentCard));
          await tester.pump();
          final ask = tester.getRect(find.byType(AskParentCard));
          expect(ask.top >= block.top - 0.5 && ask.bottom <= block.bottom + 0.5, isTrue, reason: '안내 카드 $ask / 블록 $block');
          // ⑤ 카드 영역은 실제로 스크롤되고, 스크롤해도 "+N" 줄은 제자리다(= 스크롤 밖에 고정).
          final scroll = tester.widget<SingleChildScrollView>(find.byKey(const Key('inbox.scroll')));
          final position = scroll.controller!.position;
          expect(position.maxScrollExtent > 0, isTrue, reason: '스크롤할 것이 없다');
          position.jumpTo(position.maxScrollExtent);
          await tester.pump();
          expect(tester.getRect(find.byKey(const Key('inbox.more'))), more, reason: '"+N" 이 스크롤을 따라 움직였다');
        });
      });
    }

    testWidgets('내용이 적으면 블록은 내용만큼만 — min(55%, 내용)', (tester) async {
      daemon.snapshotBody['pending'] = [
        approvalJson('a1', memberId: 'm1', command: 'pwd', createdAt: '2026-09-17T01:00:00.000Z'),
      ];
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'), size: const Size(480, 720));
        await pumpUntilConnected(tester, c);
        await pumpUntil(tester, () => find.byType(ApprovalCard).evaluate().length == 1, reason: 'card');
        await tester.pump();
        final block = tester.getRect(find.byKey(const Key('inbox')));
        expect(block.height < 720 * inboxMaxHeightFraction, isTrue, reason: '내용보다 크게 잡았다: ${block.height}');
        expect(find.byKey(const Key('inbox.more')), findsNothing);
      });
    });
  });

  testWidgets('답하면 인박스에서 사라지고 대기 수가 줄어든다', (tester) async {
    daemon.snapshotBody['pending'] = [approvalJson('a1', memberId: 'm1', command: 'pwd', createdAt: '2026-09-17T01:00:00.000Z')];
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const SingleChildScrollView(child: PendingInbox()));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.byType(ApprovalCard).evaluate().isNotEmpty, reason: 'card');
      expect(c.read(inboxCountProvider), 1);
      await tester.tap(find.byKey(const Key('approval.allow')));
      await pumpUntil(tester, () => find.byType(ApprovalCard).evaluate().isEmpty, reason: 'card gone');
      expect(c.read(inboxCountProvider), 0);
      expect(find.text(inboxHeaderLabel(0)), findsOneWidget);
    });
  });
}
