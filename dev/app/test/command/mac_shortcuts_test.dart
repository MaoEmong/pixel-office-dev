// 맥 단축키(T48-2 · D-48 ⑤): `Cmd+K/L/T/I/R`. 윈도우는 그대로 `Ctrl+…`(shortcuts_test.dart).
//
// 실기 없이 검증하는 방법: `debugDefaultTargetPlatformOverride` 로 Flutter 에게 "맥이다" 라고 말하고
// meta 키를 눌러 본다. 같은 위젯이 윈도우에서는 Ctrl 을, 맥에서는 Cmd 를 듣는지가 이 파일의 전부다.
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/command/command_bar.dart' show commandBarFocusProvider;
import 'package:pixel_office/command/shortcuts.dart';
import 'package:pixel_office/panel/panel_splitter.dart' show terminalMovedToOverlay;
import 'package:pixel_office/panel/panel_tabs.dart';
import 'package:pixel_office/panel/pending_card.dart' show approvalShortcutHint, macApprovalShortcutHint, platformApprovalShortcutHint;
import 'package:pixel_office/panel/ui_prefs.dart';
import 'package:pixel_office/state/office_state.dart';

import 'fake_rpc_client.dart';

Future<ProviderContainer> pumpShortcuts(WidgetTester tester, FakeRpcClient fake) async {
  final key = GlobalKey();
  await tester.pumpWidget(ProviderScope(
    overrides: fake.overrides,
    child: MaterialApp(key: key, home: const Scaffold(body: AppShortcuts(child: SizedBox.expand()))),
  ));
  await tester.pump();
  final c = ProviderScope.containerOf(key.currentContext!);
  c.read(officeProvider);
  return c;
}

/// 맥인 척하고 [body] 를 돌린다.
///
/// 되돌리기를 `tearDown` 에 맡길 수 없다: `testWidgets` 는 **본문이 끝나는 자리에서** "디버그 변수를
/// 건드린 채 끝났는지" 를 검사한다(`debugAssertAllFoundationVarsUnset`) — tearDown 은 그 뒤다.
Future<void> onMac(Future<void> Function() body) async {
  debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
  try {
    await body();
  } finally {
    debugDefaultTargetPlatformOverride = null;
  }
}

/// 조합키를 누른 채 [key] 를 한 번 — `meta` 가 참이면 Cmd, 아니면 Ctrl.
Future<void> press(WidgetTester tester, LogicalKeyboardKey key, {required bool meta}) async {
  final mod = meta ? LogicalKeyboardKey.metaLeft : LogicalKeyboardKey.controlLeft;
  await tester.sendKeyDownEvent(mod);
  await tester.sendKeyEvent(key);
  await tester.sendKeyUpEvent(mod);
  await tester.pump();
}

void main() {
  late FakeRpcClient fake;

  setUp(() => fake = FakeRpcClient());
  tearDown(() async => fake.close());

  group('맥(TargetPlatform.macOS)', () {
    testWidgets('Cmd+L / Cmd+I / Cmd+R 이 패널 탭을 바꾼다', (tester) async {
      await onMac(() async {
        final c = await pumpShortcuts(tester, fake);
        await press(tester, LogicalKeyboardKey.keyL, meta: true);
        expect(c.read(panelTabRequestProvider)?.tab, RightPanelTab.log);
        await press(tester, LogicalKeyboardKey.keyI, meta: true);
        expect(c.read(panelTabRequestProvider)?.tab, RightPanelTab.instructions);
        await press(tester, LogicalKeyboardKey.keyR, meta: true);
        expect(c.read(panelTabRequestProvider)?.tab, RightPanelTab.report);
      });
    });

    testWidgets('Cmd+K 는 지시 바 포커스 · Cmd+T 는 터미널 오버레이 토글', (tester) async {
      await onMac(() async {
        final c = await pumpShortcuts(tester, fake);
        final before = c.read(commandBarFocusProvider);
        await press(tester, LogicalKeyboardKey.keyK, meta: true);
        expect(c.read(commandBarFocusProvider), before + 1);

        expect(c.read(terminalOverlayProvider), isFalse);
        await press(tester, LogicalKeyboardKey.keyT, meta: true);
        expect(c.read(terminalOverlayProvider), isTrue);
        await press(tester, LogicalKeyboardKey.keyT, meta: true);
        expect(c.read(terminalOverlayProvider), isFalse);
      });
    });

    testWidgets('Esc 는 플랫폼과 무관하게 오버레이를 닫는다', (tester) async {
      await onMac(() async {
        final c = await pumpShortcuts(tester, fake);
        await press(tester, LogicalKeyboardKey.keyT, meta: true);
        expect(c.read(terminalOverlayProvider), isTrue);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
        expect(c.read(terminalOverlayProvider), isFalse);
      });
    });

    testWidgets('맥에서 Ctrl 조합은 듣지 않는다(터미널의 Ctrl+L 을 뺏지 않는다)', (tester) async {
      await onMac(() async {
        final c = await pumpShortcuts(tester, fake);
        await press(tester, LogicalKeyboardKey.keyL, meta: false);
        expect(c.read(panelTabRequestProvider), isNull);
      });
    });

    test('화면에 쓰는 문구도 Cmd 로 바뀐다', () async {
      await onMac(() async {
        for (final s in ['Cmd+K', 'Cmd+L', 'Cmd+T', 'Cmd+I', 'Cmd+R', 'Esc']) {
          expect(platformShortcutHintLine, contains(s));
        }
        expect(platformShortcutHintLine, macShortcutHintLine);
        expect(platformShortcutHintLine, isNot(contains('Ctrl')));
        expect(platformApprovalShortcutHint, macApprovalShortcutHint);
        expect(platformApprovalShortcutHint, 'Cmd+Shift+Y 허가 · Cmd+Shift+N 거부');
        expect(terminalMovedToOverlay, contains('Cmd+T'));
      });
    });
  });

  group('윈도우(기본)', () {
    testWidgets('Ctrl 조합은 그대로, meta 조합은 듣지 않는다', (tester) async {
      final c = await pumpShortcuts(tester, fake);
      await press(tester, LogicalKeyboardKey.keyL, meta: true);
      expect(c.read(panelTabRequestProvider), isNull, reason: '윈도우에서 Cmd 는 우리 것이 아니다');
      await press(tester, LogicalKeyboardKey.keyL, meta: false);
      expect(c.read(panelTabRequestProvider)?.tab, RightPanelTab.log);
    });

    test('문구는 Ctrl · Alt', () {
      expect(platformShortcutHintLine, shortcutHintLine);
      expect(platformShortcutHintLine, contains('Ctrl+K'));
      expect(platformApprovalShortcutHint, approvalShortcutHint);
      expect(terminalMovedToOverlay, contains('Ctrl+T'));
    });
  });
}
