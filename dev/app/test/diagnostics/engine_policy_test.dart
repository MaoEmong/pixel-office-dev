import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/diagnostics/engine_policy.dart';
import 'package:pixel_office/model/models.dart';
import '../command/fake_rpc_client.dart';

void main() {
  test(
    'Claude only, Codex only, both and head-relative modes have distinct labels',
    () {
      expect(enginePolicyLabel([Engine.claude]), 'Claude Code만 사용');
      expect(enginePolicyLabel([Engine.codex]), 'Codex만 사용');
      expect(
        enginePolicyLabel([Engine.claude, Engine.codex]),
        'Claude Code + Codex 둘 다 사용',
      );
      expect(
        enginePolicyLabel(null, headEngine: Engine.claude),
        '부장과 같은 AI만 사용 · Claude Code',
      );
    },
  );
  testWidgets(
    'the visible policy updates after reconnect or a policy snapshot',
    (tester) async {
      var engines = ['claude'];
      final fake = FakeRpcClient(
        responder: (method, params) => {'allowedEngines': engines},
      );
      addTearDown(fake.close);
      await tester.pumpWidget(
        ProviderScope(
          overrides: fake.overrides,
          child: MaterialApp(
            home: Scaffold(body: EnginePolicyBanner(onEdit: () {})),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(fake.calls.where((c) => c.$1 == 'engines.get'), isEmpty);
      fake.emitHello();
      await tester.pumpAndSettle();
      expect(find.textContaining('사용 AI: Claude Code만 사용'), findsOneWidget);
      engines = ['codex'];
      fake.emitHello();
      await tester.pumpAndSettle();
      expect(find.textContaining('사용 AI: Codex만 사용'), findsOneWidget);
      engines = ['claude', 'codex'];
      fake.pushNotification('snapshot', {
        'seq': 1,
        'departments': [],
        'teams': [],
        'members': [],
        'pending': [],
        'tasks': [],
      });
      await tester.pumpAndSettle();
      expect(
        find.textContaining('사용 AI: Claude Code + Codex 둘 다 사용'),
        findsOneWidget,
      );
    },
  );
}
