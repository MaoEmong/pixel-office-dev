import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/remote/device_dialog.dart';
import 'package:pixel_office/panel/ui_prefs.dart';
import '../command/fake_rpc_client.dart';

void main() {
  testWidgets('remote failure explains local availability and retries', (
    tester,
  ) async {
    final fake = FakeRpcClient();
    bool available = false;
    fake.responder = (method, params) {
      if (method == 'remote.retry') available = true;
      return {'available': available, 'message': '포트 충돌', 'devices': []};
    };
    tester.view.physicalSize = const Size(1100, 850);
    tester.view.devicePixelRatio = 1;
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await fake.close();
      tester.view.reset();
    });
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          ...fake.overrides,
          uiPrefsStoreProvider.overrideWithValue(MemoryUiPrefsStore()),
        ],
        child: const MaterialApp(home: Scaffold(body: DeviceDialog())),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('포트 충돌'), findsOneWidget);
    expect(find.text('원격 연결 사용 불가'), findsOneWidget);
    expect(find.text('로컬 작업은 계속 사용할 수 있습니다.'), findsOneWidget);
    await tester.tap(find.text('원격 연결 다시 시작'));
    await tester.pumpAndSettle();
    expect(find.text('포트 충돌'), findsNothing);
    expect(fake.calls.where((c) => c.$1 == 'remote.retry').length, 1);
  });
  testWidgets(
    'PC device management approves and revokes only the selected device',
    (tester) async {
      final fake = FakeRpcClient();
      final devices = <Map<String, dynamic>>[
        {
          'id': 'phone',
          'name': '테스트 휴대폰',
          'fingerprint': 'abcdef1234',
          'status': 'pending',
        },
      ];
      fake.responder = (method, params) {
        if (method == 'remote.device.approve') {
          devices.single['status'] = 'approved';
        }
        if (method == 'remote.device.revoke') {
          devices.single['status'] = 'revoked';
        }
        return {
          'localUrl': 'http://127.0.0.1:7423',
          'publicUrl': 'http://127.0.0.1:7423',
          'devices': devices.map((d) => Map<String, dynamic>.from(d)).toList(),
        };
      };
      tester.view.physicalSize = const Size(1100, 850);
      tester.view.devicePixelRatio = 1;
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        await fake.close();
        tester.view.reset();
      });
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            ...fake.overrides,
            uiPrefsStoreProvider.overrideWithValue(MemoryUiPrefsStore()),
            keepDaemonEnvProvider.overrideWithValue(false),
          ],
          child: const MaterialApp(home: Scaffold(body: DeviceDialog())),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('테스트 휴대폰'), findsOneWidget);
      expect(find.textContaining('지문: abcdef1234'), findsOneWidget);
      await tester.ensureVisible(find.text('기기 승인'));
      await tester.tap(find.text('기기 승인'));
      await tester.pumpAndSettle();
      expect(
        fake.calls.where((c) => c.$1 == 'remote.device.approve').single.$2,
        {'deviceId': 'phone'},
      );
      await tester.ensureVisible(find.text('연결 해제'));
      await tester.tap(find.text('연결 해제'));
      await tester.pumpAndSettle();
      expect(
        fake.calls.where((c) => c.$1 == 'remote.device.revoke').single.$2,
        {'deviceId': 'phone'},
      );
      expect(find.text('테스트 휴대폰'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}
