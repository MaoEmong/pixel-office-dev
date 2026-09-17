// 전역 단축키(T40-5, 패스 6): Ctrl+K 지시 바 · Ctrl+L 로그 · Ctrl+T 터미널 오버레이 · Ctrl+I 지시문 ·
// Ctrl+R 보고서 · Esc(오버레이 닫기 → 부장 선택).
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/command/command_bar.dart' show commandBarFocusProvider;
import 'package:pixel_office/command/shortcuts.dart';
import 'package:pixel_office/panel/panel_tabs.dart';
import 'package:pixel_office/panel/ui_prefs.dart';
import 'package:pixel_office/state/office_state.dart';
import 'package:pixel_office/state/selection.dart';
import 'package:pixel_office/topbar/selected_department.dart';

import 'fake_rpc_client.dart';

Future<ProviderContainer> pumpShortcuts(WidgetTester tester, FakeRpcClient fake) async {
  final key = GlobalKey();
  await tester.pumpWidget(ProviderScope(
    overrides: fake.overrides,
    child: MaterialApp(key: key, home: const Scaffold(body: AppShortcuts(child: SizedBox.expand()))),
  ));
  await tester.pump();
  final c = ProviderScope.containerOf(key.currentContext!);
  c.read(officeProvider); // 상태 층을 먼저 깨워 둔다(emitHello 를 놓치지 않게 — 프로바이더는 게으르다)
  return c;
}

Future<void> press(WidgetTester tester, LogicalKeyboardKey key, {bool ctrl = true}) async {
  if (ctrl) await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
  await tester.sendKeyEvent(key);
  if (ctrl) await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
  await tester.pump();
}

void main() {
  late FakeRpcClient fake;

  setUp(() => fake = FakeRpcClient());
  tearDown(() async => fake.close());

  testWidgets('Ctrl+L / Ctrl+I / Ctrl+R 은 패널 탭을 바꾼다', (tester) async {
    final c = await pumpShortcuts(tester, fake);
    expect(c.read(panelTabRequestProvider), isNull);

    await press(tester, LogicalKeyboardKey.keyL);
    expect(c.read(panelTabRequestProvider)?.tab, RightPanelTab.log);

    await press(tester, LogicalKeyboardKey.keyI);
    expect(c.read(panelTabRequestProvider)?.tab, RightPanelTab.instructions);

    await press(tester, LogicalKeyboardKey.keyR);
    expect(c.read(panelTabRequestProvider)?.tab, RightPanelTab.report);
  });

  testWidgets('Ctrl+K 는 지시 바 포커스를 요청한다(nonce 증가)', (tester) async {
    final c = await pumpShortcuts(tester, fake);
    final before = c.read(commandBarFocusProvider);
    await press(tester, LogicalKeyboardKey.keyK);
    expect(c.read(commandBarFocusProvider), before + 1);
    await press(tester, LogicalKeyboardKey.keyK);
    expect(c.read(commandBarFocusProvider), before + 2);
  });

  testWidgets('Ctrl+T 는 터미널 오버레이를 토글하고 Esc 가 먼저 그것을 닫는다', (tester) async {
    final c = await pumpShortcuts(tester, fake);
    fake.emitHello(
      departments: [fakeDepartment('d1', headId: 'mH')],
      members: [fakeMember('mH', rank: 'head', name: '부장'), fakeMember('m1', name: '하루')],
    );
    await tester.pump();
    await tester.pump();
    c.read(selectedDepartmentIdProvider.notifier).select('d1');
    c.read(selectedMemberIdProvider.notifier).select('m1');
    await tester.pump();

    await press(tester, LogicalKeyboardKey.keyT);
    expect(c.read(terminalOverlayProvider), isTrue);

    // Esc 는 오버레이부터 닫는다(선택은 그대로).
    await press(tester, LogicalKeyboardKey.escape, ctrl: false);
    expect(c.read(terminalOverlayProvider), isFalse);
    expect(c.read(selectedMemberIdProvider), 'm1');

    // 오버레이가 닫혀 있으면 Esc = 부장 선택으로 복귀.
    await press(tester, LogicalKeyboardKey.escape, ctrl: false);
    expect(c.read(selectedMemberIdProvider), 'mH');

    // 다시 Ctrl+T 는 켠다(토글).
    await press(tester, LogicalKeyboardKey.keyT);
    expect(c.read(terminalOverlayProvider), isTrue);
  });

  testWidgets('부장이 없으면 Esc 는 선택을 비운다', (tester) async {
    final c = await pumpShortcuts(tester, fake);
    fake.emitHello(departments: [fakeDepartment('d1')], members: [fakeMember('m1')]);
    await tester.pump();
    await tester.pump();
    c.read(selectedMemberIdProvider.notifier).select('m1');
    await tester.pump();
    await press(tester, LogicalKeyboardKey.escape, ctrl: false);
    expect(c.read(selectedMemberIdProvider), isNull);
  });

  testWidgets('T40c: 포커스가 빠져도(터미널 노드 dispose 등) 단축키가 계속 듣는다', (tester) async {
    final c = await pumpShortcuts(tester, fake);
    // 터미널 탭에 있다가 다른 탭으로 가면 터미널 FocusNode 가 사라지고 포커스가 풀린다 —
    // 그때 포커스가 AppShortcuts **밖**(라우트 스코프)으로 올라가면 단축키가 통째로 죽었다(실기에서 발견).
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump(); // 포커스 해제 프레임 — 여기서 _keepFocusInside 가 다음 프레임을 예약한다
    await tester.pump(); // 예약된 콜백이 스코프로 포커스를 되돌리는 프레임
    await tester.pump();

    await press(tester, LogicalKeyboardKey.keyL);
    expect(c.read(panelTabRequestProvider)?.tab, RightPanelTab.log, reason: '포커스가 풀려도 Ctrl+L 은 듣는다');

    await press(tester, LogicalKeyboardKey.keyR);
    expect(c.read(panelTabRequestProvider)?.tab, RightPanelTab.report);
  });

  test('단축키 힌트 줄에 6가지가 다 들어 있다', () {
    for (final s in ['Ctrl+K', 'Ctrl+L', 'Ctrl+T', 'Ctrl+I', 'Ctrl+R', 'Esc']) {
      expect(shortcutHintLine, contains(s));
    }
  });
}
