// T46-2 · 수명주기 §2: 설정 "앱을 닫아도 계속 일하기"(app-ui.json, 기본 꺼짐) + PIXEL_KEEP_DAEMON=1.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/panel/ui_prefs.dart';
import 'package:pixel_office/topbar/top_bar.dart';

import '../command/fake_rpc_client.dart';

void main() {
  group('저장·읽기', () {
    test('기본은 꺼짐', () async {
      expect(await readKeepDaemon(MemoryUiPrefsStore()), isFalse);
    });

    test('app-ui.json 에 저장된 값을 읽는다', () async {
      expect(await readKeepDaemon(MemoryUiPrefsStore({keepDaemonKey: true})), isTrue);
    });

    test('PIXEL_KEEP_DAEMON=1 이면 설정과 무관하게 켜진 것', () async {
      expect(await readKeepDaemon(MemoryUiPrefsStore(), env: {keepDaemonEnvVar: '1'}), isTrue);
      expect(await readKeepDaemon(MemoryUiPrefsStore(), env: {keepDaemonEnvVar: '0'}), isFalse);
      expect(keepDaemonFromEnv({keepDaemonEnvVar: '1'}), isTrue);
      expect(keepDaemonFromEnv(const {}), isFalse);
    });

    test('토글하면 다른 값은 건드리지 않고 저장한다', () async {
      final store = MemoryUiPrefsStore({'panelWidth': 500});
      final container = ProviderContainer(overrides: [
        uiPrefsStoreProvider.overrideWithValue(store),
        keepDaemonEnvProvider.overrideWithValue(false),
      ]);
      addTearDown(container.dispose);
      expect(container.read(keepDaemonProvider), isFalse);
      await container.read(keepDaemonProvider.notifier).toggle();
      expect(container.read(keepDaemonProvider), isTrue);
      expect(store.value, {'panelWidth': 500, keepDaemonKey: true});
      await container.read(keepDaemonProvider.notifier).toggle();
      expect(store.value[keepDaemonKey], isFalse);
    });

    test('환경변수로 켜져 있으면 끌 수 없다', () async {
      final store = MemoryUiPrefsStore();
      final container = ProviderContainer(overrides: [
        uiPrefsStoreProvider.overrideWithValue(store),
        keepDaemonEnvProvider.overrideWithValue(true),
      ]);
      addTearDown(container.dispose);
      expect(container.read(keepDaemonProvider), isTrue);
      await container.read(keepDaemonProvider.notifier).set(false);
      expect(container.read(keepDaemonProvider), isTrue);
      expect(store.value, isEmpty, reason: '저장도 하지 않는다');
    });
  });

  group('상단 바 ⋮ 메뉴', () {
    Future<void> pumpTopBar(WidgetTester tester, {required MemoryUiPrefsStore store, bool env = false}) async {
      final fake = FakeRpcClient();
      addTearDown(fake.close);
      tester.view.physicalSize = const Size(1400, 300);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(ProviderScope(
        overrides: [
          ...fake.overrides,
          uiPrefsStoreProvider.overrideWithValue(store),
          keepDaemonEnvProvider.overrideWithValue(env),
        ],
        child: const MaterialApp(home: Scaffold(body: TopBar())),
      ));
      await tester.pumpAndSettle();
    }

    testWidgets('부서가 없어도 메뉴가 열리고 토글 + 설명 한 줄이 있다', (tester) async {
      final store = MemoryUiPrefsStore();
      await pumpTopBar(tester, store: store);
      await tester.tap(find.byKey(const Key('topbar.departmentMenu')));
      await tester.pumpAndSettle();
      expect(find.text(keepDaemonLabel), findsOneWidget);
      expect(find.byKey(const Key('topbar.keepDaemon.hint')), findsOneWidget);
      expect(find.textContaining('앱을 닫을 때 데몬과 AI 세션이 같이 꺼집니다'), findsOneWidget);
    });

    testWidgets('누르면 켜지고 app-ui.json 에 저장된다', (tester) async {
      final store = MemoryUiPrefsStore();
      await pumpTopBar(tester, store: store);
      await tester.tap(find.byKey(const Key('topbar.departmentMenu')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('topbar.keepDaemon')));
      await tester.pumpAndSettle();
      expect(store.value[keepDaemonKey], isTrue);
    });

    testWidgets('PIXEL_KEEP_DAEMON=1 이면 항목이 꺼져 있고 그 사실을 말한다', (tester) async {
      final store = MemoryUiPrefsStore();
      await pumpTopBar(tester, store: store, env: true);
      await tester.tap(find.byKey(const Key('topbar.departmentMenu')));
      await tester.pumpAndSettle();
      expect(find.textContaining('$keepDaemonEnvVar=1 로 켜져 있습니다'), findsOneWidget);
    });
  });
}
