import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/diagnostics/environment_dialog.dart';
import '../command/fake_rpc_client.dart';

void main() {
  testWidgets(
    'repair instructions remain visible and recheck reads repaired authentication',
    (tester) async {
      final fake = FakeRpcClient();
      bool loggedIn = false;
      fake.responder = (method, params) => {
        'nodeVersion': '24.20.0',
        'engines': [
          {
            'engine': 'claude',
            'connected': loggedIn,
            'message': loggedIn
                ? '설치·로그인 확인됨'
                : 'Claude Code 로그인이 필요합니다. claude auth login',
          },
        ],
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
      expect(find.textContaining('claude auth login'), findsOneWidget);
      loggedIn = true;
      await tester.tap(find.text('다시 검사'));
      await tester.pumpAndSettle();
      expect(find.text('설치·로그인 확인됨'), findsOneWidget);
      expect(fake.calls.where((c) => c.$1 == 'environment.check').length, 2);
    },
  );
}
