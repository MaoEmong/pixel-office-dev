import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/diagnostics/environment_dialog.dart';
import 'package:pixel_office/diagnostics/error_panel.dart';
import 'package:pixel_office/topbar/relocate_department_dialog.dart';
import '../command/fake_rpc_client.dart';

void main() {
  testWidgets(
    'resource save failure preserves selected limit and shows an error panel',
    (tester) async {
      final fake = FakeRpcClient();
      fake.responder = (method, params) {
        if (method == 'resources.set') throw Exception('설정 저장 실패');
        return {
          'maxLiveSessions': 16,
          'maxTeamsPerDepartment': 8,
          'allowedEngines': null,
          'engines': [],
        };
      };
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        await fake.close();
      });
      await tester.pumpWidget(
        ProviderScope(
          overrides: fake.overrides,
          child: const MaterialApp(home: Scaffold(body: EnvironmentDialog())),
        ),
      );
      await tester.pumpAndSettle();
      final field = find.byKey(const Key('environment.sessionLimit'));
      await tester.ensureVisible(field);
      await tester.tap(field);
      await tester.pumpAndSettle();
      await tester.tap(find.text('4개').last);
      await tester.pumpAndSettle();
      expect(tester.widget<DropdownButton<int>>(field).value, 16);
      expect(find.byType(ErrorPanel), findsOneWidget);
      expect(fake.calls.where((c) => c.$1 == 'resources.set').single.$2, {
        'maxLiveSessions': 4,
        'maxTeamsPerDepartment': 8,
      });
    },
  );
  testWidgets('folder reconnect reports failure without closing the form', (
    tester,
  ) async {
    final fake = FakeRpcClient();
    fake.responder = (_, _) => throw Exception('모든 멤버를 퇴근시키세요.');
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await fake.close();
    });
    await tester.pumpWidget(
      ProviderScope(
        overrides: fake.overrides,
        child: const MaterialApp(
          home: Scaffold(
            body: RelocateDepartmentDialog(departmentId: 'd', cwd: 'old'),
          ),
        ),
      ),
    );
    await tester.enterText(find.byKey(const Key('relocate.path')), 'moved');
    await tester.pump();
    await tester.tap(find.byKey(const Key('relocate.save')));
    await tester.pumpAndSettle();
    expect(find.byType(ErrorPanel), findsOneWidget);
    expect(fake.calls.single.$2, {'departmentId': 'd', 'cwd': 'moved'});
  });
}
