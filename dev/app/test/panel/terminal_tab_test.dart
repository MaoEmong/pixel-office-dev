// 터미널 탭: attach(cols/rows) → 화면 기록, term 알림 → 버퍼, onOutput → member.type, dispose → detach,
// -32003 → 배너, 재접속 → 재attach, 멤버 교체 → detach(old)+attach(new).
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/panel/right_panel.dart';
import 'package:pixel_office/panel/terminal_cache.dart';
import 'package:pixel_office/rpc/rpc_client.dart';
import 'package:pixel_office/state/office_state.dart';
import 'package:xterm/xterm.dart';

import 'panel_harness.dart';

Terminal terminalOf(WidgetTester tester) => tester.widget<TerminalView>(find.byType(TerminalView)).terminal;

String bufferText(WidgetTester tester) => terminalOf(tester).buffer.getText();

void main() {
  late PanelFakeDaemon daemon;

  setUp(() async => daemon = await startDaemon());
  tearDown(() => daemon.stop());

  testWidgets('탭이 뜨면 member.attach{memberId, cols, rows} → screen 이 버퍼에 쓰인다', (tester) async {
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const TerminalTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => daemon.countOf('member.attach') == 1, reason: 'attach');
      final p = daemon.paramsOf('member.attach').single;
      expect(p['memberId'], 'm1');
      expect(p['cols'], isA<int>());
      expect(p['rows'], isA<int>());
      expect(p['cols'], inInclusiveRange(20, 500));
      expect(p['rows'], inInclusiveRange(5, 300));
      // TerminalView 가 레이아웃한 실제 크기와 같다(기본 80x24 가 아니라)
      final t = terminalOf(tester);
      expect(p['cols'], t.viewWidth);
      expect(p['rows'], t.viewHeight);
      await pumpUntil(tester, () => bufferText(tester).contains('SCREEN:m1'), reason: 'screen written');
      expect(find.byType(TerminalView), findsOneWidget);
      expect(find.textContaining('붙일 수 없습니다'), findsNothing);
    });
  });

  testWidgets('term 알림(그 멤버만) → terminal.write; 한글·이모지 그대로', (tester) async {
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const TerminalTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => bufferText(tester).contains('SCREEN:m1'));
      daemon.push('term', {'memberId': 'm2', 'data': 'OTHER-MEMBER'});
      daemon.push('term', {'memberId': 'm1', 'data': '\r\n안녕하세요 🐣 hello\r\n'});
      await pumpUntil(tester, () => bufferText(tester).contains('안녕하세요 🐣 hello'), reason: 'term forwarded');
      expect(bufferText(tester), isNot(contains('OTHER-MEMBER')));
    });
  });

  testWidgets('terminal.onOutput(키 입력) → member.type{memberId, data}', (tester) async {
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const TerminalTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => bufferText(tester).contains('SCREEN:m1'));
      terminalOf(tester).textInput('ls -la');
      terminalOf(tester).keyInput(TerminalKey.enter);
      await pumpUntil(tester, () => daemon.countOf('member.type') == 2, reason: 'type x2');
      final typed = daemon.paramsOf('member.type');
      expect(typed[0], {'memberId': 'm1', 'data': 'ls -la'});
      expect(typed[1]['data'], '\r');
    });
  });

  testWidgets('dispose(탭 숨김) → member.detach', (tester) async {
    final overrides = panelOverrides(daemon);
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const TerminalTab(memberId: 'm1'), overrides: overrides);
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => bufferText(tester).contains('SCREEN:m1'));
      expect(daemon.countOf('member.detach'), 0);
      // 같은 ProviderScope(같은 overrides) 를 유지한 채 자식만 교체 → TerminalTab dispose
      await pumpPanel(tester, daemon, const SizedBox(), overrides: overrides);
      await pumpUntil(tester, () => daemon.countOf('member.detach') >= 1, reason: 'detach');
      expect(daemon.paramsOf('member.detach').first['memberId'], 'm1');
    });
  });

  testWidgets('attach -32003(이 데몬 세션에서 스폰 안 됨) → 배너 문구, 다시 붙이기 버튼', (tester) async {
    daemon.handlers['member.attach'] = (_) => throw const FakeRpcError(-32003, 'member not spawned in this daemon session');
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const TerminalTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.textContaining('스폰되지 않은 멤버').evaluate().isNotEmpty, reason: 'banner');
      expect(find.text('다시 붙이기'), findsOneWidget);
      expect(describeAttachError(const RpcException(-32003, 'x')), contains('재출근'));

      // 데몬이 회복(재고용 뒤) → 버튼으로 재시도
      daemon.handlers['member.attach'] = (p) => {'screen': 'BACK', 'cols': p['cols'], 'rows': p['rows']};
      await tester.tap(find.text('다시 붙이기'));
      await pumpUntil(tester, () => bufferText(tester).contains('BACK'), reason: 're-attach');
      expect(find.text('다시 붙이기'), findsNothing);
    });
  });

  testWidgets('재접속하면 attach 를 다시 부른다(term 은 replay 되지 않음)', (tester) async {
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const TerminalTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => daemon.countOf('member.attach') == 1);
      daemon.handlers['member.attach'] = (p) => {'screen': 'SCREEN-AGAIN', 'cols': p['cols'], 'rows': p['rows']};
      await daemon.closeAll();
      await pumpUntil(tester, () => c.read(connectionStateProvider) != RpcConnectionState.connected, reason: 'disconnected');
      await tester.pump();
      expect(find.textContaining('연결 끊김'), findsOneWidget);
      await pumpUntil(tester, () => daemon.countOf('member.attach') == 2, reason: 're-attach');
      await pumpUntil(tester, () => bufferText(tester).contains('SCREEN-AGAIN'), reason: 'new screen');
      expect(find.textContaining('연결 끊김'), findsNothing);
    });
  });

  testWidgets('멤버 교체 → detach(old) + attach(new), 새 버퍼', (tester) async {
    final overrides = panelOverrides(daemon);
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const TerminalTab(memberId: 'm1'), overrides: overrides);
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => bufferText(tester).contains('SCREEN:m1'));
      await pumpPanel(tester, daemon, const TerminalTab(memberId: 'm2'), overrides: overrides);
      await pumpUntil(tester, () => daemon.paramsOf('member.detach').any((p) => p['memberId'] == 'm1'), reason: 'detach m1');
      await pumpUntil(tester, () => daemon.paramsOf('member.attach').any((p) => p['memberId'] == 'm2'), reason: 'attach m2');
      await pumpUntil(tester, () => bufferText(tester).contains('SCREEN:m2'));
      expect(bufferText(tester), isNot(contains('SCREEN:m1')));
    });
  });

  testWidgets('T18: 탭을 오가도 같은 Terminal 인스턴스(terminalCacheProvider) — 스크롤백 유지, attach 는 다시', (tester) async {
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await tester.tap(find.text('터미널'));
      await tester.pumpAndSettle();
      await pumpUntil(tester, () => daemon.countOf('member.attach') == 1, reason: 'attach #1');
      await pumpUntil(tester, () => bufferText(tester).contains('SCREEN:m1'));
      final first = terminalOf(tester);
      expect(identical(first, c.read(terminalCacheProvider).of('m1').terminal), isTrue);
      // 뷰포트 높이보다 많이 써서 앞줄이 스크롤백으로 밀려나게 한다(재attach 의 \x1b[2J 는 뷰포트만 지운다).
      daemon.push('term', {'memberId': 'm1', 'data': [for (var i = 1; i <= 200; i++) '스크롤백 줄 $i'].join('\r\n')});
      await pumpUntil(tester, () => bufferText(tester).contains('스크롤백 줄 200'));
      expect(bufferText(tester), contains('스크롤백 줄 1\n'));

      await tester.tap(find.text('로그'));
      await tester.pumpAndSettle();
      await pumpUntil(tester, () => daemon.countOf('member.detach') == 1, reason: 'detach on hide');
      expect(find.byType(TerminalView), findsNothing);
      expect(c.read(terminalCacheProvider).of('m1').attached, isFalse);

      await tester.tap(find.text('터미널'));
      await tester.pumpAndSettle();
      await pumpUntil(tester, () => daemon.countOf('member.attach') == 2, reason: 'attach #2');
      expect(identical(terminalOf(tester), first), isTrue); // 같은 객체
      await pumpUntil(tester, () => c.read(terminalCacheProvider).of('m1').attached);
      expect(first.buffer.getText(), contains('스크롤백 줄 1\n')); // 스크롤백이 리셋되지 않았다
      expect(first.buffer.getText(), contains('SCREEN:m1')); // 현재 화면은 다시 받았다
      // 다른 멤버는 다른 인스턴스
      expect(identical(c.read(terminalCacheProvider).of('m2').terminal, first), isFalse);
    });
  });

  // ---- U-03: 터미널 탭에서 위로 넘겨 보기 ---------------------------------------------------------
  // Claude 의 전체 화면 렌더러는 alt 버퍼에서 돌아 스크롤백이 없다 — 대신 휠을 직접 받아 자기 대화를 넘긴다.
  // xterm 패키지는 휠을 버튼 68/69 로 보고하는데(= Shift+휠) Claude 는 그걸 무시한다(실측). 표준은 64/65 다.
  group('U-03 휠 보고', () {
    /// fullscreen claude 가 켜는 모드(실측 순서 그대로) + 화면 한 줄. 데몬 attach 의 `screen` 이 이렇게 온다.
    const fullscreen = '\x1b[?1049h\x1b[H화면\x1b[?1003h\x1b[?1006h';

    Future<void> wheel(WidgetTester tester, Offset delta) async {
      final center = tester.getCenter(find.byType(TerminalView));
      final mouse = TestPointer(1, PointerDeviceKind.mouse)..hover(center);
      await tester.sendEventToBinding(mouse.scroll(delta));
      await tester.pump(const Duration(milliseconds: 50));
    }

    testWidgets('전체 화면 CLI: 휠 위/아래 → 표준 번호 64/65 로 member.type (68/69 가 아니다)', (tester) async {
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, const TerminalTab(memberId: 'm1'));
        await pumpUntilConnected(tester, c);
        await pumpUntil(tester, () => bufferText(tester).contains('SCREEN:m1'));
        daemon.push('term', {'memberId': 'm1', 'data': fullscreen});
        await pumpUntil(tester, () => terminalOf(tester).isUsingAltBuffer, reason: 'alt buffer');
        expect(terminalOf(tester).mouseReportMode, MouseReportMode.sgr);

        await wheel(tester, const Offset(0, -60)); // 위로
        await pumpUntil(tester, () => daemon.countOf('member.type') > 0, reason: 'wheel up reported');
        final up = daemon.paramsOf('member.type').map((p) => p['data'] as String).toList();
        expect(up, everyElement(matches(RegExp(r'^\x1b\[<64;\d+;\d+M$'))), reason: '$up');

        final before = daemon.countOf('member.type');
        await wheel(tester, const Offset(0, 60)); // 아래로
        // More up events may still be in the socket when down is injected. Wait for the direction, not any request.
        await pumpUntil(tester, () => daemon.paramsOf('member.type').skip(before).any((p) => (p['data'] as String).startsWith('\x1b[<65;')), reason: 'wheel down reported');
        final down = daemon.paramsOf('member.type').skip(before).map((p) => p['data'] as String).where((s) => s.startsWith('\x1b[<65;')).toList();
        expect(daemon.paramsOf('member.type').map((p) => p['data']), everyElement(matches(RegExp(r'^\x1b\[<6[45];\d+;\d+M$'))));
        expect(down, everyElement(matches(RegExp(r'^\x1b\[<65;\d+;\d+M$'))), reason: '$down');
      });
    });

    test('인코딩별 모양 — SGR · urxvt · 옛 X10, 번호는 늘 64~67', () {
      String? report(TerminalMouseButton b, MouseMode mode, MouseReportMode enc, {TerminalMouseButtonState st = TerminalMouseButtonState.down, int x = 9, int y = 4}) {
        final t = Terminal(mouseHandler: terminalMouseHandler);
        t.setMouseMode(mode);
        t.setMouseReportMode(enc);
        String? out;
        t.onOutput = (d) => out = d;
        t.mouseInput(b, st, CellOffset(x, y));
        return out;
      }

      const any = MouseMode.upDownScrollMove;
      expect(report(TerminalMouseButton.wheelUp, any, MouseReportMode.sgr), '\x1b[<64;10;5M');
      expect(report(TerminalMouseButton.wheelDown, any, MouseReportMode.sgr), '\x1b[<65;10;5M');
      expect(report(TerminalMouseButton.wheelLeft, any, MouseReportMode.sgr), '\x1b[<66;10;5M');
      expect(report(TerminalMouseButton.wheelRight, any, MouseReportMode.sgr), '\x1b[<67;10;5M');
      expect(report(TerminalMouseButton.wheelUp, any, MouseReportMode.urxvt), '\x1b[96;10;5M');
      // 옛 인코딩: ESC [ M + (32+번호) + (32+열) + (32+행). 데몬이 ?1006h 를 못 전했을 때의 모양이다.
      expect(report(TerminalMouseButton.wheelUp, any, MouseReportMode.normal), '\x1b[M${String.fromCharCodes([32 + 64, 32 + 10, 32 + 5])}');
      expect(report(TerminalMouseButton.wheelDown, MouseMode.upDownScroll, MouseReportMode.normal), '\x1b[M${String.fromCharCodes([32 + 65, 32 + 10, 32 + 5])}');
      expect(report(TerminalMouseButton.wheelUp, any, MouseReportMode.normal, x: 300), '\x1b[M${String.fromCharCode(32 + 64)}\x00${String.fromCharCode(32 + 5)}', reason: '상한 223 을 넘는 열은 0');
      // CLI 가 마우스를 달라고 하지 않았으면 보고하지 않는다(뷰가 스크롤백을 넘기거나 화살표로 흉내 낸다).
      expect(report(TerminalMouseButton.wheelUp, MouseMode.none, MouseReportMode.sgr), isNull);
      expect(report(TerminalMouseButton.wheelUp, MouseMode.clickOnly, MouseReportMode.sgr), isNull);
      expect(report(TerminalMouseButton.wheelUp, any, MouseReportMode.sgr, st: TerminalMouseButtonState.up), isNull, reason: '휠에는 뗌이 없다');
      // 클릭은 건드리지 않는다 — 패키지 기본 처리 그대로.
      expect(report(TerminalMouseButton.left, any, MouseReportMode.sgr), '\x1b[<0;10;5M');
    });

    test('캐시가 만드는 Terminal 은 표준 번호로 보고하고, 탭이 적어 둔 포인터 칸을 위치로 쓴다', () {
      final c = ProviderContainer();
      addTearDown(c.dispose);
      final entry = c.read(terminalCacheProvider).of('m9');
      final t = entry.terminal;
      t.setMouseMode(MouseMode.upDownScrollMove);
      t.setMouseReportMode(MouseReportMode.sgr);
      String? out;
      t.onOutput = (d) => out = d;
      // 포인터 칸을 모르면 패키지가 준 위치 그대로.
      t.mouseInput(TerminalMouseButton.wheelUp, TerminalMouseButtonState.down, const CellOffset(70, 23));
      expect(out, '\x1b[<64;71;24M');
      // 탭이 진짜 칸을 적어 두면 그걸 쓴다(U-07) — 패키지가 준 (70, 23) 은 버린다.
      entry.pointerCell = const CellOffset(11, 4);
      t.mouseInput(TerminalMouseButton.wheelUp, TerminalMouseButtonState.down, const CellOffset(70, 23));
      expect(out, '\x1b[<64;12;5M');
      // 클릭은 위치를 바꾸지 않는다(패키지가 클릭에는 맞는 좌표를 준다).
      t.mouseInput(TerminalMouseButton.left, TerminalMouseButtonState.down, const CellOffset(3, 2));
      expect(out, '\x1b[<0;4;3M');
    });
  });

  // ---- U-07: 휠의 **위치** ------------------------------------------------------------------------
  // xterm 패키지의 스크롤 처리기는 휠 위치를 창 전체 기준 좌표로 칸을 계산한다. 터미널 탭은 창의 오른쪽 아래에 있어
  // 열은 맨 오른쪽, 행은 맨 아래로 잘려 나간다. Codex 는 포인터가 **대화 영역 위**에 있을 때만 대화를 넘긴다
  // (실측 codex 0.159: 입력창·바닥줄 행에 대고 굴린 휠은 무시) — 그래서 Codex 터미널만 스크롤이 안 됐다.
  group('U-07 휠 위치', () {
    const fullscreen = '\x1b[?1049h\x1b[H화면\x1b[?1003h\x1b[?1006h';

    testWidgets('창 안에서 밀려 있는 터미널: 휠 보고의 위치는 **터미널 기준 칸**이다(창 기준이 아니다)', (tester) async {
      // 터미널이 창의 (460, 100) 쯤에서 시작하게 한다 — 실제 앱의 오른쪽 패널과 같은 처지.
      tester.view.physicalSize = const Size(1400, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, const TerminalTab(memberId: 'm1'));
        await pumpUntilConnected(tester, c);
        await pumpUntil(tester, () => bufferText(tester).contains('SCREEN:m1'));
        daemon.push('term', {'memberId': 'm1', 'data': fullscreen});
        await pumpUntil(tester, () => terminalOf(tester).isUsingAltBuffer, reason: 'alt buffer');

        final view = tester.state<TerminalViewState>(find.byType(TerminalView));
        final origin = tester.getTopLeft(find.byType(TerminalView));
        expect(origin.dx, greaterThan(200), reason: '이 테스트는 터미널이 창 왼쪽 위에 붙어 있지 않아야 뜻이 있다');
        expect(origin.dy, greaterThan(50));

        // 터미널의 **위쪽**(대화 영역)에 포인터를 두고 굴린다.
        final at = origin + const Offset(60, 48);
        final want = view.renderTerminal.getCellOffset(view.renderTerminal.globalToLocal(at));
        final mouse = TestPointer(1, PointerDeviceKind.mouse)..hover(at);
        await tester.sendEventToBinding(mouse.scroll(const Offset(0, -60)));
        await tester.pump(const Duration(milliseconds: 50));
        await pumpUntil(tester, () => daemon.countOf('member.type') > 0, reason: 'wheel reported');
        final sent = daemon.paramsOf('member.type').map((p) => p['data'] as String).toList();
        expect(sent, everyElement('\x1b[<64;${want.x + 1};${want.y + 1}M'), reason: '$sent');
        // 그 칸은 화면 위쪽이다 — 예전에는 창 기준 좌표라 맨 아래 행·맨 오른쪽 열로 잘려 나갔다.
        final t = terminalOf(tester);
        expect(want.y, lessThan(5));
        expect(want.x, lessThan(12));
        expect(want.y, lessThan(t.viewHeight - 1));
        expect(want.x, lessThan(t.viewWidth - 1));
        // 캐시에도 그 칸이 적혀 있다.
        expect(c.read(terminalCacheProvider).of('m1').pointerCell, CellOffset(want.x, want.y));
      });
    });

    testWidgets('트랙패드 두 손가락도 같은 위치를 싣는다', (tester) async {
      tester.view.physicalSize = const Size(1400, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, const TerminalTab(memberId: 'm1'));
        await pumpUntilConnected(tester, c);
        await pumpUntil(tester, () => bufferText(tester).contains('SCREEN:m1'));
        daemon.push('term', {'memberId': 'm1', 'data': fullscreen});
        await pumpUntil(tester, () => terminalOf(tester).isUsingAltBuffer, reason: 'alt buffer');
        final view = tester.state<TerminalViewState>(find.byType(TerminalView));
        final at = tester.getTopLeft(find.byType(TerminalView)) + const Offset(120, 90);
        final want = view.renderTerminal.getCellOffset(view.renderTerminal.globalToLocal(at));

        final pad = TestPointer(2, PointerDeviceKind.trackpad);
        await tester.sendEventToBinding(pad.panZoomStart(at));
        for (var i = 1; i <= 5; i++) {
          await tester.sendEventToBinding(pad.panZoomUpdate(at, pan: Offset(0, 30.0 * i)));
          await tester.pump(const Duration(milliseconds: 16));
        }
        await tester.sendEventToBinding(pad.panZoomEnd());
        await tester.pump(const Duration(milliseconds: 300));
        await pumpUntil(tester, () => daemon.countOf('member.type') > 0, reason: 'trackpad reported');
        final sent = daemon.paramsOf('member.type').map((p) => p['data'] as String).toList();
        expect(sent, everyElement(matches(RegExp('^\x1b\\[<6[45];${want.x + 1};${want.y + 1}M\$'))), reason: '$sent');
      });
    });

    testWidgets('탭이 내려가면 포인터 칸을 잊는다', (tester) async {
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, const TerminalTab(memberId: 'm1'));
        await pumpUntilConnected(tester, c);
        await pumpUntil(tester, () => bufferText(tester).contains('SCREEN:m1'));
        final entry = c.read(terminalCacheProvider).of('m1');
        final mouse = TestPointer(1, PointerDeviceKind.mouse)..hover(tester.getCenter(find.byType(TerminalView)));
        await tester.sendEventToBinding(mouse.scroll(const Offset(0, -20)));
        await tester.pump();
        expect(entry.pointerCell, isNotNull);
        await pumpPanel(tester, daemon, const SizedBox.shrink());
        await tester.pump();
        expect(entry.pointerCell, isNull);
      });
    });
  });
}
