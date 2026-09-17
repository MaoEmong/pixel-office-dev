// 재지시 필요 카드(T18): error{pendingId} → 카드, 뒤의 idle/text 로 사라짐, resumed(본문 없는 text) 는 안 지움,
// 터미널에서 답하기 → 터미널 탭, 다시 지시 → 클립보드 + 스낵바, describeRedoSummary.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/panel/inbox.dart';
import 'package:pixel_office/panel/right_panel.dart' hide PendingInbox, inboxHeaderLabel;
import 'package:pixel_office/state/office_state.dart';
import 'package:xterm/xterm.dart';

import 'panel_harness.dart';

void main() {
  late PanelFakeDaemon daemon;

  setUp(() async => daemon = await startDaemon());
  tearDown(() => daemon.stop());

  test('describeRedoSummary', () {
    expect(describeRedoSummary('hook hold timed out; answer in terminal', pendingType: 'approval'), contains('허가 요청 보류가 시간 초과'));
    expect(describeRedoSummary('hook connection closed before answer', pendingType: 'question'), contains('질문 보류가 답하기 전에 끊겼어요'));
    expect(describeRedoSummary('재지시 필요: 허가 요청이 재시작으로 만료됨', pendingType: 'approval'), startsWith('재지시 필요: 허가 요청이 재시작으로 만료됨'));
    expect(describeRedoSummary('something else'), 'something else');
    expect(describeRedoSummary(null), contains('답 없이 닫혔어요'));
  });

  testWidgets('error{pendingId} → 카드(한 pendingId 에 하나), 그 멤버의 idle 이 오면 사라진다; resumed 는 지우지 않는다', (tester) async {
    daemon.handlers['events.query'] = (_) => {
          'events': [
            ev(20, kind: 'thinking', detail: {'text': '[TASK#5 from user]\n빌드 고쳐줘'}),
            {...ev(21, kind: 'waiting_approval', detail: {'tool': 'Bash', 'cmd': 'flutter build'}), 'ref': {'approvalId': 'a1'}},
            {
              ...ev(22, kind: 'error', detail: {'summary': '재지시 필요: 허가 요청이 재시작으로 만료됨', 'pendingId': 'a1', 'pendingType': 'approval'}),
              'ref': {'approvalId': 'a1'},
            },
            ev(23, kind: 'text', detail: {'summary': 'resumed'}), // 본문 없는 text — 카드를 지우면 안 된다
          ],
        };
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RedoCards(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.byType(RedoCard).evaluate().length == 1, reason: 'card from backfill');
      expect(find.text('⚠ 재지시 필요'), findsOneWidget);
      expect(find.textContaining('재시작으로 만료됨'), findsOneWidget);
      expect(find.text('터미널에서 답하기'), findsOneWidget);
      expect(find.text('다시 지시'), findsOneWidget);

      // 같은 pendingId 가 또 와도(백필 ∪ 라이브) 카드는 하나
      daemon.emitEvent({
        ...ev(24, kind: 'error', detail: {'summary': 'hook hold timed out; answer in terminal', 'pendingId': 'a1', 'pendingType': 'approval'}),
      });
      // 다른 멤버 것은 안 보임
      daemon.emitEvent({...ev(25, memberId: 'm2', kind: 'error', detail: {'summary': 'hook hold timed out; answer in terminal', 'pendingId': 'z9'})});
      await pumpUntil(tester, () => find.textContaining('시간 초과').evaluate().isNotEmpty, reason: 'summary updated');
      expect(find.byType(RedoCard), findsOneWidget);

      // 두 번째 pending → 카드 둘
      daemon.emitEvent({...ev(26, kind: 'error', detail: {'summary': 'hook connection closed before answer', 'pendingId': 'q7', 'pendingType': 'question'})});
      await pumpUntil(tester, () => find.byType(RedoCard).evaluate().length == 2, reason: 'two cards');

      // 멤버가 턴을 끝내면(idle) 전부 사라진다
      daemon.emitEvent(ev(27, kind: 'idle', detail: {}));
      await pumpUntil(tester, () => find.byType(RedoCard).evaluate().isEmpty, reason: 'gone after idle');
    });
  });

  testWidgets('T40-4: 만료 카드는 전역 인박스 안에 회색 "만료 — 재지시" 로 들어온다', (tester) async {
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const PendingInbox());
      await pumpUntilConnected(tester, c);
      expect(find.byType(RedoCard), findsNothing);
      daemon.emitEvent({
        ...ev(30, kind: 'error', detail: {'summary': '재지시 필요: 허가 요청이 재시작으로 만료됨', 'pendingId': 'a1', 'pendingType': 'approval'}),
      });
      await pumpUntil(tester, () => find.byType(RedoCard).evaluate().isNotEmpty, reason: 'expired card in inbox');
      expect(find.text(redoExpiredTitle), findsOneWidget);
      expect(find.text('⚠ 재지시 필요'), findsNothing); // 인박스 안에서는 회색 만료 카드
      expect(find.text(inboxHeaderLabel(1)), findsOneWidget); // 대기 수에 같이 센다
      // 같은 멤버가 새 턴을 끝내면 사라진다.
      daemon.emitEvent(ev(31, kind: 'idle', detail: {}));
      await pumpUntil(tester, () => find.byType(RedoCard).evaluate().isEmpty, reason: 'gone after idle');
    });
  });

  testWidgets('RightPanel 안에서: 터미널에서 답하기 → 터미널 탭으로; 다시 지시 → 원래 지시문 클립보드 + 스낵바', (tester) async {
    String? copied;
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String?;
      return null;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(SystemChannels.platform, null));
    daemon.handlers['events.query'] = (_) => {
          'events': [
            ev(20, kind: 'thinking', detail: {'text': '[TASK#5 from user]\n빌드 고쳐줘'}),
            {...ev(22, kind: 'error', detail: {'summary': 'hook hold timed out; answer in terminal', 'pendingId': 'a1', 'pendingType': 'approval'})},
          ],
        };
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      // T40-4: 만료 흔적은 전역 인박스가 들고 있다(선택 멤버의 백필까지 합쳐서).
      await pumpUntil(tester, () => find.byType(RedoCard).evaluate().isNotEmpty, reason: 'card');
      // 카드는 헤더 아래 · 탭 위
      expect(tester.getBottomLeft(find.byType(RedoCard)).dy, lessThanOrEqualTo(tester.getTopLeft(find.byType(TabBar)).dy + 1));
      expect(find.byType(TerminalView), findsNothing);

      await tester.tap(find.text('터미널에서 답하기'));
      await tester.pumpAndSettle();
      expect(c.read(panelTabRequestProvider)?.tab, RightPanelTab.terminal);
      await pumpUntil(tester, () => find.byType(TerminalView).evaluate().isNotEmpty, reason: 'terminal tab shown');
      await pumpUntil(tester, () => daemon.countOf('member.attach') == 1, reason: 'attached');

      await tester.tap(find.text('다시 지시'));
      await pumpUntil(tester, () => copied != null, reason: 'clipboard');
      expect(copied, '빌드 고쳐줘');
      await pumpUntil(tester, () => find.text('지시문을 복사했어요 — 지시 바에 붙여넣기').evaluate().isNotEmpty, reason: 'snackbar');

      // 열린 task 가 있으면 그 전문이 우선
      c.read(officeProvider.notifier).upsertTask(const Task(
        id: 6,
        departmentId: 'd1',
        fromMember: 'user',
        toMember: 'm1',
        instruction: '최신 열린 지시',
        status: TaskStatus.queued,
        reportText: null,
        reportStatus: null,
        createdAt: 'c',
        updatedAt: 'u',
      ));
      expect(c.read(redoInstructionProvider('m1')), '최신 열린 지시');
    });
  });
}
