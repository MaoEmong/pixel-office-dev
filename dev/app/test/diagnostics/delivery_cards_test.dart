import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/panel/delivery_cards.dart';
import 'package:pixel_office/model/task.dart';
import 'package:pixel_office/state/office_state.dart';
import 'package:pixel_office/panel/panel_tabs.dart';
import '../command/fake_rpc_client.dart';

void main() {
  for (final popup in [false, true]) {
    testWidgets(
      'terminal action reveals terminal and closes only an expanded popup ($popup)',
      (tester) async {
        final rpc = FakeRpcClient();
        addTearDown(() async {
          await tester.pumpWidget(const SizedBox());
          await rpc.close();
        });
        final task = Task(
          id: 1,
          departmentId: 'd',
          fromMember: 'user',
          toMember: 'm',
          instruction: 'one',
          status: TaskStatus.assigned,
          reportText: null,
          reportStatus: null,
          createdAt: '',
          updatedAt: '',
          delivery: 'failed',
        );
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              ...rpc.overrides,
              openTasksProvider.overrideWith((ref) => {1: task}),
            ],
            child: MaterialApp(
              home: Scaffold(
                body: Builder(
                  builder: (context) => popup
                      ? TextButton(
                          onPressed: () => showDialog<void>(
                            context: context,
                            builder: (_) => const Dialog(
                              child: DeliveryCards(memberId: 'm'),
                            ),
                          ),
                          child: const Text('크게 보기'),
                        )
                      : const DeliveryCards(memberId: 'm'),
                ),
              ),
            ),
          ),
        );
        if (popup) {
          await tester.tap(find.text('크게 보기'));
          await tester.pumpAndSettle();
        }
        final container = ProviderScope.containerOf(
          tester.element(find.byType(DeliveryCards)),
        );
        await tester.tap(find.text('터미널 확인'));
        await tester.pumpAndSettle();
        expect(
          container.read(panelTabRequestProvider)?.tab,
          RightPanelTab.terminal,
        );
        expect(find.byType(Dialog), findsNothing);
        expect(find.byType(Scaffold), findsOneWidget);
        expect(
          find.byType(DeliveryCards),
          popup ? findsNothing : findsOneWidget,
        );
      },
    );
  }
  testWidgets(
    'failed delivery offers Enter retry and preserves an actionable failure',
    (tester) async {
      final rpc = FakeRpcClient();
      rpc.responder = (method, p) {
        throw Exception('입력 상자가 변경됐습니다. 터미널에서 확인하세요.');
      };
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        await rpc.close();
      });
      final task = Task(
        id: 1,
        departmentId: 'd',
        fromMember: 'user',
        toMember: 'm',
        instruction: 'one',
        status: TaskStatus.assigned,
        reportText: null,
        reportStatus: null,
        createdAt: '',
        updatedAt: '',
        delivery: 'failed',
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ...rpc.overrides,
            openTasksProvider.overrideWith((ref) => {1: task}),
          ],
          child: const MaterialApp(
            home: Scaffold(body: DeliveryCards(memberId: 'm')),
          ),
        ),
      );
      expect(find.text('작업 #1 · 제출 확인 필요'), findsOneWidget);
      await tester.tap(find.text('지시 재제출'));
      await tester.pumpAndSettle();
      expect(rpc.calls.single.$1, 'task.retrySubmit');
      expect(rpc.calls.single.$2, {'taskId': 1});
      expect(find.textContaining('입력 상자가 변경'), findsOneWidget);
    },
  );
}
