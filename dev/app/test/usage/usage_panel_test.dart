// T43-2 ⑤: 오른쪽 패널 헤더의 사용량 한 줄 — Claude(비용 있음) / Codex(비용 없음) / 값 없음,
// 막대 색 3단, 그리고 **패널 420px 에서도 한 줄 높이 그대로**(인박스·탭이 밀리지 않는다).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/panel/right_panel.dart';
import 'package:pixel_office/usage/usage_bar.dart';
import 'package:pixel_office/usage/usage_format.dart';

import '../panel/panel_harness.dart';

Map<String, dynamic> usageMemberJson(
  String id, {
  num percent = 37,
  int used = 74210,
  int window = 200000,
  int total = 358600,
  double? cost,
  String engine = 'claude',
}) =>
    {
      'memberId': id,
      'engine': engine,
      'context': {'used': used, 'window': window, 'percent': percent},
      'tokens': {'total': total},
      'costUsd': cost,
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
    };

/// 기본 스냅샷(m1 = Claude 하루, m2 = Codex 모시)에 usage 를 얹는다.
void withUsage(PanelFakeDaemon d, List<Map<String, dynamic>> members) {
  d.snapshotBody = {...d.snapshotBody, 'usage': {'engines': <Map<String, dynamic>>[], 'members': members}};
}

UsageBar bar(WidgetTester tester) => tester.widget<UsageBar>(find.byKey(const Key('panel.usage.bar')));

void main() {
  late PanelFakeDaemon daemon;

  setUp(() async => daemon = await startDaemon());
  tearDown(() => daemon.stop());

  testWidgets(r'Claude: 컨텍스트 막대 + 37% (74k / 200k) · 토큰 358k · $1.84', (tester) async {
    withUsage(daemon, [usageMemberJson('m1', cost: 1.84)]);
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await tester.pump();
      expect(find.byKey(const Key('panel.usage')), findsOneWidget);
      expect(find.text(usageLineLabel), findsOneWidget);
      expect(find.text('37% (74k / 200k)'), findsOneWidget);
      expect(find.text(r'· 토큰 358k · $1.84'), findsOneWidget);
      expect(bar(tester).color, usageCalmColor, reason: '37% 는 평소 색');
    });
  });

  testWidgets('Codex: 비용 자리가 없다', (tester) async {
    withUsage(daemon, [usageMemberJson('m2', percent: 12, used: 12000, window: 100000, total: 12000, engine: 'codex')]);
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm2'));
      await pumpUntilConnected(tester, c);
      await tester.pump();
      expect(find.text('12% (12k / 100k)'), findsOneWidget);
      expect(find.text('· 토큰 12k'), findsOneWidget);
      expect(find.textContaining(r'$'), findsNothing);
    });
  });

  testWidgets('값이 없으면 "사용량 — 첫 턴 뒤 표시"', (tester) async {
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await tester.pump();
      expect(find.byKey(const Key('panel.usage.empty')), findsOneWidget);
      expect(find.text(usageNoDataLine), findsOneWidget);
      expect(find.byKey(const Key('panel.usage.bar')), findsNothing);
    });
  });

  testWidgets('막대 색: 69 기본 · 70 주황 · 90 빨강', (tester) async {
    withUsage(daemon, [usageMemberJson('m1', percent: 69)]);
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await tester.pump();
      expect(bar(tester).color, usageCalmColor, reason: '69%');
      for (final (percent, color) in [(70, usageWarnColor), (90, usageDangerColor)]) {
        daemon.push('usage.member', usageMemberJson('m1', percent: percent));
        await pumpUntil(tester, () => bar(tester).percent == percent, reason: '$percent%');
        expect(bar(tester).color, color, reason: '$percent%');
      }
    });
  });

  testWidgets('usage.member 알림이 오면 줄이 바로 바뀐다', (tester) async {
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      expect(find.byKey(const Key('panel.usage.empty')), findsOneWidget);
      daemon.push('usage.member', usageMemberJson('m1', percent: 91, cost: 2.5));
      await pumpUntil(tester, () => find.byKey(const Key('panel.usage.bar')).evaluate().isNotEmpty, reason: 'usage line');
      expect(bar(tester).color, usageDangerColor);
      expect(find.text('91% (74k / 200k)'), findsOneWidget);
    });
  });

  // ---- U-05: 세션이 쓰는 모델 배지 -----------------------------------------------------------
  testWidgets('모델을 알면 엔진 배지 옆에 짧은 이름이 붙는다(툴팁은 전체), 모르면 배지가 없다', (tester) async {
    withUsage(daemon, [
      {...usageMemberJson('m1'), 'model': {'id': 'claude-opus-5[1m]', 'label': 'Opus 5 (1M context)'}},
    ]);
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await tester.pump();
      expect(find.text('claude'), findsOneWidget);
      expect(find.descendant(of: find.byKey(const Key('panel.model')), matching: find.text('Opus 5')), findsOneWidget);
      expect(find.byTooltip('모델 Opus 5 (1M context) · claude-opus-5[1m]'), findsOneWidget);
    });
  });

  testWidgets('모델을 아직 못 봤으면 배지를 그리지 않고, usage.member 알림이 오면 바로 뜬다 — 숫자가 없어도', (tester) async {
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm2'));
      await pumpUntilConnected(tester, c);
      expect(find.byKey(const Key('panel.model')), findsNothing);
      // Codex: 첫 hook 이 모델만 알려 준다(컨텍스트·토큰은 턴이 끝나야 온다).
      daemon.push('usage.member', {
        'memberId': 'm2',
        'engine': 'codex',
        'model': {'id': 'gpt-6-astra', 'label': 'gpt-6-astra'},
        'context': null,
        'tokens': null,
        'costUsd': null,
        'updatedAt': DateTime.now().toUtc().toIso8601String(),
      });
      await pumpUntil(tester, () => find.byKey(const Key('panel.model')).evaluate().isNotEmpty, reason: 'model badge');
      expect(find.text('gpt-6-astra'), findsOneWidget);
      expect(find.byKey(const Key('panel.usage.empty')), findsOneWidget, reason: '사용량 줄은 아직 "첫 턴 뒤 표시"');
      // 세션 중에 모델을 바꾸면(/model) 배지도 따라 바뀐다.
      daemon.push('usage.member', {
        'memberId': 'm2',
        'engine': 'codex',
        'model': {'id': 'gpt-6-sol', 'label': 'gpt-6-sol'},
        'updatedAt': DateTime.now().toUtc().toIso8601String(),
      });
      await pumpUntil(tester, () => find.text('gpt-6-sol').evaluate().isNotEmpty, reason: 'model changed');
      expect(find.text('gpt-6-astra'), findsNothing);
    });
  });

  testWidgets('패널 420px: 모델 이름이 아주 길어도 헤더가 넘치지 않는다', (tester) async {
    withUsage(daemon, [
      {...usageMemberJson('m1'), 'model': {'id': 'x', 'label': '아주-아주-긴-모델-이름-${'가' * 40}'}},
    ]);
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'), size: const Size(panelWidthMin, 700));
      await pumpUntilConnected(tester, c);
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(find.byKey(const Key('panel.model')), findsOneWidget);
      expect(tester.getSize(find.byType(PanelHeader)).width, lessThanOrEqualTo(panelWidthMin));
    });
  });

  testWidgets('패널 420px: 한 줄 높이 그대로 · 넘치지 않고 · 탭은 그대로', (tester) async {
    // 일부러 아주 긴 꼬리(토큰 1.2M + 비용 네 자리)를 준다 — 좁을 때 잘리는 쪽이 꼬리인지 본다.
    withUsage(daemon, [usageMemberJson('m1', percent: 88, total: 1234567, cost: 1234.56)]);
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'), size: const Size(panelWidthMin, 700));
      await pumpUntilConnected(tester, c);
      await tester.pump();
      final size = tester.getSize(find.byKey(const Key('panel.usage')));
      expect(size.height, usageLineHeight, reason: '줄이 두 줄로 늘어나면 인박스·탭이 밀린다');
      expect(size.width, lessThanOrEqualTo(panelWidthMin));
      expect(tester.takeException(), isNull);
      // 컨텍스트(제일 중요한 것)는 끝까지 남고 탭 줄도 그대로다.
      expect(find.text('88% (74k / 200k)'), findsOneWidget);
      expect(find.byType(TabBar), findsOneWidget);
    });
  });
}
