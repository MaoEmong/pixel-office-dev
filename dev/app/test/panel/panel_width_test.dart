// 패널 폭(420~720, 기본 480, 앱 로컬 저장) · 터미널 탭 660 자동 확장 · Ctrl+T 전체 폭 오버레이
// (T40-4, 레이아웃 v2 §3 패스 6).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/panel/right_panel.dart';
import 'package:xterm/xterm.dart';

import 'panel_harness.dart';

void main() {
  late PanelFakeDaemon daemon;

  setUp(() async => daemon = await startDaemon());
  tearDown(() => daemon.stop());

  group('PanelWidthState', () {
    test('기본 480, 하한 420 · 상한 720 으로 자른다', () {
      expect(panelWidthDefault, 480);
      expect(clampPanelWidth(100), panelWidthMin);
      expect(clampPanelWidth(9999), panelWidthMax);
      expect(clampPanelWidth(555), 555);
    });

    test('터미널 탭이 열리면 660, 닫으면 원래 폭 — 이미 더 넓으면 그대로', () {
      const narrow = PanelWidthState(preferred: 480);
      expect(narrow.width, 480);
      expect(narrow.copyWith(terminalActive: true).width, panelWidthTerminal);
      expect(narrow.copyWith(terminalActive: true).copyWith(terminalActive: false).width, 480);
      const wide = PanelWidthState(preferred: 700, terminalActive: true);
      expect(wide.width, 700);
    });
  });

  testWidgets('저장된 폭을 읽고, 드래그하면 저장한다', (tester) async {
    final store = MemoryUiPrefsStore({'panelWidth': 520});
    final container = ProviderContainer(overrides: [uiPrefsStoreProvider.overrideWithValue(store)]);
    addTearDown(container.dispose);
    await tester.runAsync(() async {
      expect(container.read(panelWidthProvider).width, panelWidthDefault); // 읽기 전
      await pumpUntil(tester, () => container.read(panelWidthProvider).preferred == 520, reason: 'loaded');

      container.read(panelWidthProvider.notifier).dragBy(-40); // 왼쪽으로 끌면 넓어진다
      expect(container.read(panelWidthProvider).preferred, 560);
      await container.read(panelWidthProvider.notifier).flush();
      expect(store.value['panelWidth'], 560);

      container.read(panelWidthProvider.notifier).setPreferred(10000);
      expect(container.read(panelWidthProvider).preferred, panelWidthMax);
    });
  });

  testWidgets('PanelSplitter: 손잡이를 끌면 패널 폭이 바뀐다', (tester) async {
    await tester.runAsync(() async {
      final c = await pumpPanel(
        tester,
        daemon,
        const PanelSplitter(office: ColoredBox(color: Colors.black), panel: ColoredBox(color: Colors.blue)),
        size: const Size(1280, 600),
      );
      await tester.pump();
      expect(tester.getSize(find.byKey(const Key('panel.box'))).width, panelWidthDefault);

      await tester.drag(find.byKey(const Key('panel.divider')), const Offset(-60, 0));
      await tester.pump();
      expect(tester.getSize(find.byKey(const Key('panel.box'))).width, 540);
      expect(c.read(panelWidthProvider).preferred, 540);

      // 하한 아래로는 더 못 줄인다(420).
      await tester.drag(find.byKey(const Key('panel.divider')), const Offset(400, 0));
      await tester.pump();
      expect(tester.getSize(find.byKey(const Key('panel.box'))).width, panelWidthMin);
    });
  });

  testWidgets('터미널 탭을 열면 660, 다른 탭으로 가면 돌아온다', (tester) async {
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      expect(c.read(panelWidthProvider).width, panelWidthDefault);

      await tester.tap(find.text('터미널'));
      await tester.pumpAndSettle();
      await pumpUntil(tester, () => c.read(panelWidthProvider).terminalActive, reason: 'terminal active');
      expect(c.read(panelWidthProvider).width, panelWidthTerminal);

      await tester.tap(find.text('로그'));
      await tester.pumpAndSettle();
      await pumpUntil(tester, () => !c.read(panelWidthProvider).terminalActive, reason: 'back');
      expect(c.read(panelWidthProvider).width, panelWidthDefault);
    });
  });

  testWidgets('Ctrl+T 오버레이: 사무실을 덮고 패널 터미널 탭은 비켜 준다, Esc 로 닫힘', (tester) async {
    await tester.runAsync(() async {
      final c = await pumpPanel(
        tester,
        daemon,
        const PanelSplitter(
          office: ColoredBox(color: Colors.black),
          panel: RightPanel(memberId: 'm1', initialTab: RightPanelTab.terminal),
          selectedMemberId: 'm1',
        ),
        size: const Size(1280, 700),
      );
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => daemon.countOf('member.attach') == 1, reason: 'panel terminal attached');
      expect(find.byType(TerminalOverlay), findsNothing);

      c.read(terminalOverlayProvider.notifier).toggle();
      await tester.pump();
      expect(find.byType(TerminalOverlay), findsOneWidget);
      expect(find.text(terminalOverlayTitle('하루')), findsOneWidget);
      // 패널 쪽 터미널은 비켜 준다 — attach 는 한 곳만.
      expect(find.byKey(const Key('panel.terminalMoved')), findsOneWidget);
      await pumpUntil(tester, () => find.byType(TerminalView).evaluate().length == 1, reason: 'one terminal view');
      await pumpUntil(tester, () => daemon.countOf('member.attach') == 2, reason: 'overlay attached');
      expect(daemon.countOf('member.detach') >= 1, isTrue);

      // 닫기 버튼
      await tester.tap(find.byKey(const Key('terminalOverlay.close')));
      await tester.pump();
      expect(find.byType(TerminalOverlay), findsNothing);
      expect(c.read(terminalOverlayProvider), isFalse);
    });
  });

  // T40d ⑤ — 전체 suite 4판 중 1판꼴로 깜빡이던 자리의 **진짜 원인**을 못으로 박는다.
  //
  // `daemon.countOf('member.attach') == 1` 은 **요청이 도착한** 순간 참이 된다. 그 뒤 응답이 돌아와야
  // `CachedTerminal.attached` 가 켜지는데, 그 사이에 폭이 바뀌면 `onResize` 가 "아직 attach 전"이라
  // 흘려보내진다. xterm 은 **같은 크기로는 onResize 를 다시 부르지 않으므로** 그 한 번을 놓치면
  // 데몬은 옛 크기를 영영 믿고, 테스트는 20초를 기다리다 죽었다(단독 실행은 응답이 빨라 거의 안 걸린다).
  // 이제 attach 응답이 오면 알린 크기와 지금 뷰 크기를 맞춰 보고 어긋나면 그 자리에서 resize 를 보낸다.
  testWidgets('attach 응답 전에 폭이 바뀌어도 member.resize 가 나간다(경합 회귀)', (tester) async {
    final gate = Completer<void>();
    daemon.handlers['member.attach'] = (p) async {
      await gate.future;
      return {'screen': 'SCREEN', 'cols': p['cols'], 'rows': p['rows']};
    };
    await tester.runAsync(() async {
      final c = await pumpPanel(
        tester,
        daemon,
        const RightPanel(memberId: 'm1', initialTab: RightPanelTab.terminal),
        size: const Size(480, 600),
      );
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => daemon.countOf('member.attach') == 1, reason: 'attach 요청 도착');
      expect(c.read(terminalCacheProvider).of('m1').attached, isFalse); // 응답은 아직

      // 응답을 붙잡아 둔 채로 폭이 660 으로 벌어진다 — 이때의 onResize 는 attach 전이라 버려진다.
      await pumpPanel(
        tester,
        daemon,
        const RightPanel(memberId: 'm1', initialTab: RightPanelTab.terminal),
        size: const Size(panelWidthTerminal, 600),
      );
      await tester.pump();
      expect(daemon.countOf('member.resize'), 0);

      gate.complete(); // 이제 attach 응답이 돌아온다
      await pumpUntil(tester, () => daemon.countOf('member.resize') == 1, reason: 'attach 뒤 크기 맞추기');
      final p = daemon.paramsOf('member.resize').single;
      expect(p['memberId'], 'm1');
      expect((p['cols']! as int) > (daemon.paramsOf('member.attach').single['cols']! as int), isTrue);
      // 크기가 그대로면 더 보내지 않는다.
      await tester.pump();
      expect(daemon.countOf('member.resize'), 1);
    });
  });

  testWidgets('터미널 크기가 바뀌면 member.resize 가 새 cols/rows 로 나간다', (tester) async {
    await tester.runAsync(() async {
      final c = await pumpPanel(
        tester,
        daemon,
        const RightPanel(memberId: 'm1', initialTab: RightPanelTab.terminal),
        size: const Size(480, 600),
      );
      await pumpUntilConnected(tester, c);
      // 요청이 아니라 **응답까지** 기다린다 — 요청만 보고 넘어가면 그 아래 재배치가 경합에 걸린다.
      await pumpUntil(tester, () => c.read(terminalCacheProvider).of('m1').attached, reason: 'attached');
      final before = daemon.countOf('member.resize');

      // 폭이 660 으로 벌어지는 상황을 그대로 — 더 넓은 상자로 다시 띄운다.
      await pumpPanel(
        tester,
        daemon,
        const RightPanel(memberId: 'm1', initialTab: RightPanelTab.terminal),
        size: const Size(panelWidthTerminal, 600),
      );
      await pumpUntil(tester, () => daemon.countOf('member.resize') > before, reason: 'resize sent');
      final p = daemon.paramsOf('member.resize').last;
      expect(p['memberId'], 'm1');
      expect(p['cols'], isA<int>());
      expect((p['cols']! as int) > 20, isTrue);
    });
  });
}
