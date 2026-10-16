// 전역 인박스(T40-4, D6·D10·패스 6): 선택 멤버와 무관 · 오래된 순 · 2장 펼침 + "+N" ·
// 만료 카드 · Alt+Y/Alt+N · 사무실 슬롯 클릭(inboxFocusProvider) 스크롤.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/panel/inbox.dart';
import 'package:pixel_office/panel/pending_card.dart';

import 'package:pixel_office/panel/right_panel.dart'
    hide
        PendingInbox,
        inboxHeaderLabel,
        inboxMoreLabel,
        inboxFocusProvider,
        inboxItemsProvider,
        inboxCountProvider,
        inboxExpandedCards,
        inboxEmptyLabel;
import 'package:pixel_office/state/office_state.dart';

import 'panel_harness.dart';

Map<String, dynamic> approvalJson(
  String id, {
  required String memberId,
  required String command,
  required String createdAt,
}) => pendingJson(
  id,
  memberId: memberId,
  createdAt: createdAt,
  payload: {
    'tool_name': 'Bash',
    'tool_input': {'command': command},
  },
);

void main() {
  late PanelFakeDaemon daemon;

  setUp(() async {
    daemon = await startDaemon();
    daemon.handlers['approval.respond'] = (_) => {};
    daemon.handlers['question.respond'] = (_) => {};
  });
  tearDown(() => daemon.stop());

  testWidgets(
    'restored questions remove stale expiry cards without closing the real question',
    (tester) async {
      await tester.runAsync(() async {
        final c = await pumpPanel(
          tester,
          daemon,
          const RightPanel(memberId: 'm1'),
        );
        await pumpUntilConnected(tester, c);
        daemon.emitEvent(
          ev(
            11,
            kind: 'error',
            detail: {
              'summary': '재지시 필요: 질문이 재시작으로 만료됨',
              'pendingId': 'q1',
              'pendingType': 'question',
            },
          ),
        );
        await pumpUntil(tester, () => c.read(inboxCountProvider) == 1);
        daemon.snapshotBody['pending'] = [
          pendingJson(
            'q1',
            type: 'question',
            payload: {
              'source': 'ask_parent',
              'question': '팀장님 확인 부탁드립니다.',
              'to': 'm2',
            },
          ),
        ];
        daemon.push('snapshot', {...daemon.snapshotBody, 'seq': 11});
        await pumpUntil(
          tester,
          () => c.read(openPendingProvider).containsKey('q1'),
        );
        expect(c.read(inboxCountProvider), 0);
        expect(c.read(globalRedoNeededProvider), isEmpty);
        expect(c.read(redoNeededProvider('m1')), isEmpty);
        expect(find.byType(RedoCard), findsNothing);
        expect(find.byType(RecoveryHint), findsNothing);
        expect(c.read(openPendingProvider)['q1']?.isAskParent, isTrue);
        daemon.snapshotBody['pending'] = [];
        daemon.push('snapshot', {...daemon.snapshotBody, 'seq': 11});
        await pumpUntil(tester, () => c.read(openPendingProvider).isEmpty);
        expect(
          c.read(inboxCountProvider),
          0,
          reason:
              'answering a restored request must not bring its old expiry back',
        );
        daemon.emitEvent(
          ev(
            12,
            kind: 'error',
            detail: {
              'summary': 'hook hold timed out',
              'pendingId': 'other',
              'pendingType': 'approval',
            },
          ),
        );
        await pumpUntil(tester, () => c.read(inboxCountProvider) == 1);
        expect(
          c.read(globalRedoNeededProvider).single.detail.pendingId,
          'other',
        );
        daemon.emitEvent(
          ev(
            13,
            kind: 'error',
            detail: {
              'summary': 'hook hold timed out',
              'pendingId': 'q1',
              'pendingType': 'question',
            },
          ),
        );
        await pumpUntil(tester, () => c.read(inboxCountProvider) == 2);
      });
    },
  );

  testWidgets(
    'short panel keeps records readable and opens the complete AI question in a large live dialog',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.binding.setSurfaceSize(const Size(1280, 720));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final loader = FontLoader('Pretendard')
        ..addFont(rootBundle.load('assets/fonts/Pretendard-Regular.otf'))
        ..addFont(rootBundle.load('assets/fonts/Pretendard-Bold.otf'));
      await loader.load();
      await (FontLoader(
        'MaterialIcons',
      )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
      const question =
          '변경된 화면 설명을 문서에 반영했습니다. 프론트팀장님이 내용을 확인해 주세요. 사용자에게 답변을 요청하는 질문이 아닙니다.\n마지막 줄까지 읽을 수 있어야 합니다.';
      daemon.snapshotBody['members'] = [
        memberJson('m1', name: 'UIUX디자이너', parentId: 'm2'),
        memberJson('m2', name: '프론트팀장', rank: 'lead'),
      ];
      daemon.snapshotBody['pending'] = [
        pendingJson(
          'q1',
          type: 'question',
          payload: {'source': 'ask_parent', 'question': question, 'to': 'm2'},
        ),
      ];
      daemon.handlers['events.query'] = (_) => {
        'events': [
          ev(
            1,
            kind: 'error',
            detail: {
              'summary': '재지시 필요: 질문이 재시작으로 만료됨',
              'pendingId': 'q1',
              'pendingType': 'question',
            },
          ),
          ev(2, kind: 'error', detail: {'summary': 'restart: parent gone'}),
          ev(3, kind: 'text', detail: {'summary': 'resumed'}),
        ],
      };
      await tester.runAsync(() async {
        final c = await pumpPanel(
          tester,
          daemon,
          Theme(
            data: ThemeData.dark().copyWith(
              textTheme: ThemeData.dark().textTheme.apply(
                fontFamily: 'Pretendard',
              ),
            ),
            child: const RightPanel(memberId: 'm1'),
          ),
          size: const Size(480, 488),
        );
        await pumpUntilConnected(tester, c);
        await pumpUntil(
          tester,
          () => c.read(memberLogProvider('m1')).length == 3,
        );
        await tester.pumpAndSettle();
        expect(
          tester.getSize(find.byKey(const Key('panel.readingArea'))).height,
          greaterThanOrEqualTo(220),
        );
        expect(find.textContaining('사용자 답변 불필요'), findsOneWidget);
        expect(find.byType(RedoCard), findsNothing);
        expect(find.text('resumed'), findsNothing);
        await tester.tap(find.byKey(const Key('panel.attention.open')));
        await tester.pumpAndSettle();
        final dialog = find.byKey(const Key('panel.attention.dialog'));
        expect(tester.getSize(dialog).width, greaterThan(800));
        expect(find.text('지금 사용자가 답변해야 할 요청은 없어요.'), findsOneWidget);
        expect(find.text('UIUX디자이너 → 프론트팀장(팀장)').hitTestable(), findsOneWidget);
        expect(find.text(question).hitTestable(), findsOneWidget);
        expect(tester.takeException(), isNull);
        const previewDir = String.fromEnvironment('PANEL_PREVIEW_DIR');
        if (previewDir.isNotEmpty) {
          final boundary =
              tester.binding.renderViews.first.debugLayer! as OffsetLayer;
          final shot = await boundary.toImage(
            const Rect.fromLTWH(0, 0, 1280, 720),
          );
          final bytes = await shot.toByteData(format: ui.ImageByteFormat.png);
          await File(
            '$previewDir/pixel-office-question-reader.png',
          ).writeAsBytes(bytes!.buffer.asUint8List());
          shot.dispose();
        }
        daemon.snapshotBody['pending'] = [];
        daemon.push('snapshot', {...daemon.snapshotBody, 'seq': 10});
        await pumpUntil(tester, () => c.read(openPendingProvider).isEmpty);
        await tester.pumpAndSettle();
        expect(
          find.descendant(of: dialog, matching: find.byType(AskParentCard)),
          findsNothing,
        );
        await tester.tap(
          find.descendant(of: dialog, matching: find.byTooltip('닫기')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.textContaining('대화 기록을 유지한 채 AI 연결을 복구했어요.'));
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('log.detail.fullText')), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    },
  );

  testWidgets('선택 멤버와 무관하게 사용자 몫 pending 이 전부, 오래된 순으로 선다', (tester) async {
    daemon.snapshotBody['members'] = [
      memberJson('mH', name: '부장', rank: 'head'),
      memberJson('m1', name: '하루', parentId: 'mH'),
      memberJson('m2', name: '모시', parentId: 'mH'),
    ];
    daemon.snapshotBody['pending'] = [
      approvalJson(
        'a2',
        memberId: 'm2',
        command: 'ls',
        createdAt: '2026-09-17T02:00:00.000Z',
      ),
      approvalJson(
        'a1',
        memberId: 'm1',
        command: 'pwd',
        createdAt: '2026-09-17T01:00:00.000Z',
      ),
    ];
    await tester.runAsync(() async {
      // m1 을 골랐지만 m2 의 허가도 같은 인박스에 있다.
      final c = await pumpPanel(
        tester,
        daemon,
        const RightPanel(memberId: 'm1'),
      );
      await pumpUntilConnected(tester, c);
      await pumpUntil(
        tester,
        () => find.byType(PendingCard).evaluate().length == 2,
        reason: 'both cards',
      );
      expect(
        tester
            .widgetList<PendingCard>(find.byType(PendingCard))
            .map((w) => w.pending.id),
        ['a1', 'a2'],
      );
      expect(find.text(inboxHeaderLabel(2)), findsOneWidget);
      expect(find.textContaining('하루 ·'), findsOneWidget);
      expect(find.textContaining('모시 ·'), findsOneWidget);
    });
  });

  testWidgets('`ask_parent` 는 인박스에서 빠지고 부장 아닌 멤버의 ask_user 도 빠진다', (
    tester,
  ) async {
    daemon.snapshotBody['pending'] = [
      pendingJson(
        'p1',
        memberId: 'm1',
        type: 'question',
        createdAt: '2026-09-17T01:00:00.000Z',
        payload: {
          'source': 'ask_parent',
          'question': '지워도 됩니까?',
          'from': 'm1',
          'to': 'm2',
        },
      ),
      pendingJson(
        'u1',
        memberId: 'm2',
        type: 'question',
        createdAt: '2026-09-17T02:00:00.000Z',
        payload: {'source': 'ask_user', 'question': '팀원이 사용자에게?'},
      ),
    ];
    await tester.runAsync(() async {
      final c = await pumpPanel(
        tester,
        daemon,
        const SingleChildScrollView(child: PendingInbox()),
      );
      await pumpUntilConnected(tester, c);
      await pumpUntil(
        tester,
        () => c.read(openPendingProvider).length == 2,
        reason: 'pending loaded',
      );
      await tester.pump();
      expect(find.byType(PendingCard), findsNothing);
      expect(find.text(inboxHeaderLabel(0)), findsOneWidget);
      expect(find.text(inboxEmptyLabel), findsOneWidget);
    });
  });

  testWidgets('2장까지 펼치고 3장째부터 "+N" — 누르면 펼쳐지고 접을 수 있다', (tester) async {
    daemon.snapshotBody['pending'] = [
      for (var i = 0; i < 5; i++)
        approvalJson(
          'a$i',
          memberId: 'm1',
          command: 'echo $i',
          createdAt: '2026-09-17T0$i:00:00.000Z',
        ),
    ];
    await tester.runAsync(() async {
      final c = await pumpPanel(
        tester,
        daemon,
        const SingleChildScrollView(child: PendingInbox()),
      );
      await pumpUntilConnected(tester, c);
      await pumpUntil(
        tester,
        () => find.byType(PendingCard).evaluate().isNotEmpty,
        reason: 'cards',
      );
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
      approvalJson(
        'a1',
        memberId: 'm1',
        command: 'pwd',
        createdAt: '2026-09-17T01:00:00.000Z',
      ),
      approvalJson(
        'a2',
        memberId: 'm1',
        command: 'ls',
        createdAt: '2026-09-17T02:00:00.000Z',
      ),
    ];
    await tester.runAsync(() async {
      final c = await pumpPanel(
        tester,
        daemon,
        const SingleChildScrollView(child: PendingInbox()),
      );
      await pumpUntilConnected(tester, c);
      await pumpUntil(
        tester,
        () => find.byType(ApprovalCard).evaluate().length == 2,
        reason: 'cards',
      );
      expect(find.text(approvalShortcutHint), findsOneWidget); // 맨 위 카드에만

      await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyY);
      await pumpUntil(
        tester,
        () => daemon.countOf('approval.respond') == 1,
        reason: 'alt+y allow',
      );
      expect(daemon.paramsOf('approval.respond').single, {
        'pendingId': 'a1',
        'behavior': 'allow',
      });

      // 맨 위가 a2 로 바뀌고 Alt+N 은 거부
      await pumpUntil(
        tester,
        () => find.byType(ApprovalCard).evaluate().length == 1,
        reason: 'a1 gone',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.keyN);
      await pumpUntil(
        tester,
        () => daemon.countOf('approval.respond') == 2,
        reason: 'alt+n deny',
      );
      expect(daemon.paramsOf('approval.respond').last, {
        'pendingId': 'a2',
        'behavior': 'deny',
      });
      await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
    });
  });

  testWidgets('Alt 없이 누른 Y/N 은 아무 일도 하지 않는다', (tester) async {
    daemon.snapshotBody['pending'] = [
      approvalJson(
        'a1',
        memberId: 'm1',
        command: 'pwd',
        createdAt: '2026-09-17T01:00:00.000Z',
      ),
    ];
    await tester.runAsync(() async {
      final c = await pumpPanel(
        tester,
        daemon,
        const SingleChildScrollView(child: PendingInbox()),
      );
      await pumpUntilConnected(tester, c);
      await pumpUntil(
        tester,
        () => find.byType(ApprovalCard).evaluate().isNotEmpty,
        reason: 'card',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.keyY);
      await tester.pump();
      expect(daemon.countOf('approval.respond'), 0);
    });
  });

  testWidgets('맨 위가 질문 카드면 Alt+Y 는 아무 일도 하지 않는다', (tester) async {
    daemon.snapshotBody['members'] = [
      memberJson('mH', name: '부장', rank: 'head'),
    ];
    daemon.snapshotBody['pending'] = [
      pendingJson(
        'q1',
        memberId: 'mH',
        type: 'question',
        createdAt: '2026-09-17T01:00:00.000Z',
        payload: {'source': 'ask_user', 'question': '배포할까?'},
      ),
    ];
    await tester.runAsync(() async {
      final c = await pumpPanel(
        tester,
        daemon,
        const SingleChildScrollView(child: PendingInbox()),
      );
      await pumpUntilConnected(tester, c);
      await pumpUntil(
        tester,
        () => find.byType(QuestionCard).evaluate().isNotEmpty,
        reason: 'question card',
      );
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
      approvalJson(
        'a9',
        memberId: 'm1',
        command: 'pwd',
        createdAt: '2999-01-01T00:00:00.000Z',
      ), // 항상 마지막
    ];
    await tester.runAsync(() async {
      final c = await pumpPanel(
        tester,
        daemon,
        const SingleChildScrollView(child: PendingInbox()),
      );
      await pumpUntilConnected(tester, c);
      await pumpUntil(
        tester,
        () => find.byType(ApprovalCard).evaluate().isNotEmpty,
        reason: 'approval',
      );
      daemon.emitEvent({
        ...ev(
          40,
          kind: 'error',
          detail: {
            'summary': '재지시 필요: 허가 요청이 재시작으로 만료됨',
            'pendingId': 'x1',
            'pendingType': 'approval',
          },
        ),
      });
      await pumpUntil(
        tester,
        () => find.byType(RedoCard).evaluate().isNotEmpty,
        reason: 'expired card',
      );
      expect(find.text(redoExpiredTitle), findsOneWidget);
      expect(find.text(inboxHeaderLabel(2)), findsOneWidget);
      // 만료(지금) 가 2999년 허가보다 앞이다.
      final items = c.read(inboxItemsProvider(null));
      expect(items.map((i) => i.id), ['x1', 'a9']);
    });
  });

  testWidgets('inboxFocusProvider: 접힌 카드를 가리키면 펼쳐진다(사무실 내 책상 슬롯 클릭)', (
    tester,
  ) async {
    daemon.snapshotBody['pending'] = [
      for (var i = 0; i < 4; i++)
        approvalJson(
          'a$i',
          memberId: 'm1',
          command: 'echo $i',
          createdAt: '2026-09-17T0$i:00:00.000Z',
        ),
    ];
    await tester.runAsync(() async {
      final c = await pumpPanel(
        tester,
        daemon,
        const RightPanel(memberId: 'm1'),
      );
      await pumpUntilConnected(tester, c);
      await pumpUntil(
        tester,
        () => find.byType(PendingCard).evaluate().length == inboxExpandedCards,
        reason: 'collapsed',
      );
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
          approvalJson(
            'a$i',
            memberId: 'm1',
            command: 'echo $i',
            createdAt: '2026-09-17T0$i:00:00.000Z',
          ),
        pendingJson(
          'ap1',
          memberId: 'm1',
          type: 'question',
          createdAt: '2026-09-17T09:00:00.000Z',
          payload: {
            'source': 'ask_parent',
            'question': '지워도 됩니까?',
            'from': 'm1',
            'to': 'mH',
          },
        ),
      ];
    }

    for (final height in [720.0, 640.0]) {
      testWidgets('패널 높이 $height: 탭·"+N"·ask_parent 카드가 다 닿는다', (tester) async {
        fiveAndAskParent();
        await tester.runAsync(() async {
          final c = await pumpPanel(
            tester,
            daemon,
            const RightPanel(memberId: 'm1'),
            size: Size(480, height),
          );
          await pumpUntilConnected(tester, c);
          await pumpUntil(
            tester,
            () =>
                find.byType(ApprovalCard).evaluate().length ==
                inboxExpandedCards,
            reason: 'cards',
          );
          await tester.pump();

          final panel = tester.getRect(find.byType(RightPanel));
          final block = tester.getRect(find.byKey(const Key('inbox')));
          // ① 블록은 패널 높이의 55% 를 넘지 않는다.
          expect(
            block.height <= height * inboxMaxHeightFraction + 0.5,
            isTrue,
            reason: '블록 ${block.height}',
          );
          // ② 탭 줄은 언제나 패널 안에 보인다.
          final tabs = tester.getRect(find.byType(TabBar));
          expect(
            tabs.bottom <= panel.bottom + 0.5,
            isTrue,
            reason: '탭이 패널 밖: $tabs vs $panel',
          );
          expect(tabs.top >= block.bottom - 0.5, isTrue, reason: '탭이 인박스에 덮였다');
          // ③ "+N" 접힌 줄은 스크롤 없이 보인다(블록 안 · 화면 안).
          final more = tester.getRect(find.byKey(const Key('inbox.more')));
          expect(
            more.bottom <= block.bottom + 0.5,
            isTrue,
            reason: '"+N" 이 블록 밖: $more',
          );
          expect(more.bottom <= panel.bottom + 0.5, isTrue);
          // ④ ask_parent 안내 카드는 스크롤 영역 안에서 닿는다.
          expect(find.byType(AskParentCard), findsOneWidget);
          await tester.ensureVisible(find.byType(AskParentCard));
          await tester.pump();
          final ask = tester.getRect(find.byType(AskParentCard));
          expect(ask.overlaps(block), isTrue, reason: '안내 카드까지 스크롤할 수 있어야 한다');
          // ⑤ 카드 영역은 실제로 스크롤되고, 스크롤해도 "+N" 줄은 제자리다(= 스크롤 밖에 고정).
          final scroll = tester.widget<SingleChildScrollView>(
            find.byKey(const Key('inbox.scroll')),
          );
          final position = scroll.controller!.position;
          expect(position.maxScrollExtent > 0, isTrue, reason: '스크롤할 것이 없다');
          position.jumpTo(position.maxScrollExtent);
          await tester.pump();
          expect(
            tester.getRect(find.byKey(const Key('inbox.more'))),
            more,
            reason: '"+N" 이 스크롤을 따라 움직였다',
          );
          await tester.tap(find.byKey(const Key('panel.attention.open')));
          await tester.pumpAndSettle();
          final dialog = find.byKey(const Key('panel.attention.dialog'));
          final parentQuestion = find.descendant(
            of: dialog,
            matching: find.byType(AskParentCard),
          );
          await tester.ensureVisible(parentQuestion);
          await tester.pumpAndSettle();
          expect(
            find
                .descendant(of: dialog, matching: find.text('지워도 됩니까?'))
                .hitTestable(),
            findsOneWidget,
          );
          await tester.tap(
            find.descendant(of: dialog, matching: find.byTooltip('닫기')),
          );
          await tester.pumpAndSettle();
        });
      });
    }

    testWidgets('내용이 적으면 블록은 내용만큼만 — min(55%, 내용)', (tester) async {
      daemon.snapshotBody['pending'] = [
        approvalJson(
          'a1',
          memberId: 'm1',
          command: 'pwd',
          createdAt: '2026-09-17T01:00:00.000Z',
        ),
      ];
      await tester.runAsync(() async {
        final c = await pumpPanel(
          tester,
          daemon,
          const RightPanel(memberId: 'm1'),
          size: const Size(480, 720),
        );
        await pumpUntilConnected(tester, c);
        await pumpUntil(
          tester,
          () => find.byType(ApprovalCard).evaluate().length == 1,
          reason: 'card',
        );
        await tester.pump();
        final block = tester.getRect(find.byKey(const Key('inbox')));
        expect(
          block.height < 720 * inboxMaxHeightFraction,
          isTrue,
          reason: '내용보다 크게 잡았다: ${block.height}',
        );
        expect(find.byKey(const Key('inbox.more')), findsNothing);
      });
    });
  });

  testWidgets('답하면 인박스에서 사라지고 대기 수가 줄어든다', (tester) async {
    daemon.snapshotBody['pending'] = [
      approvalJson(
        'a1',
        memberId: 'm1',
        command: 'pwd',
        createdAt: '2026-09-17T01:00:00.000Z',
      ),
    ];
    await tester.runAsync(() async {
      final c = await pumpPanel(
        tester,
        daemon,
        const SingleChildScrollView(child: PendingInbox()),
      );
      await pumpUntilConnected(tester, c);
      await pumpUntil(
        tester,
        () => find.byType(ApprovalCard).evaluate().isNotEmpty,
        reason: 'card',
      );
      expect(c.read(inboxCountProvider), 1);
      await tester.tap(find.byKey(const Key('approval.allow')));
      await pumpUntil(
        tester,
        () => find.byType(ApprovalCard).evaluate().isEmpty,
        reason: 'card gone',
      );
      expect(c.read(inboxCountProvider), 0);
      expect(find.text(inboxHeaderLabel(0)), findsOneWidget);
    });
  });
}
