// 터미널 탭: attach(cols/rows) → 화면 기록, term 알림 → 버퍼, onOutput → member.type, dispose → detach,
// -32003 → 배너, 재접속 → 재attach, 멤버 교체 → detach(old)+attach(new).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/panel/right_panel.dart';
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
}
