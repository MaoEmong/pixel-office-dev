// T43-2 ③④: 상단 바 엔진 칩 5종 + 좁은 창 축약 + 사용량 팝오버(표 정렬 · 행 클릭 · Esc/바깥 클릭).
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/state/selection.dart';
import 'package:pixel_office/topbar/top_bar.dart';
import 'package:pixel_office/usage/usage_format.dart';

import '../command/fake_rpc_client.dart';

/// 상단 바를 [width] 폭으로 띄운다(창 크기 = 상단 바 폭).
Future<ProviderContainer> pumpBar(WidgetTester tester, FakeRpcClient fake, {double width = 1920, String? selectedMemberId}) async {
  tester.view.physicalSize = Size(width, 800);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(ProviderScope(
    overrides: fake.overrides,
    child: MaterialApp(
      theme: ThemeData(brightness: Brightness.dark, useMaterial3: true),
      home: Scaffold(body: Column(children: [TopBar(selectedMemberId: selectedMemberId), const Spacer()])),
    ),
  ));
  await tester.pump();
  return ProviderScope.containerOf(tester.element(find.byType(TopBar)));
}

Map<String, dynamic> engineJson(
  String engine, {
  bool connected = true,
  String? reason,
  String? plan,
  num? weeklyUsed,
  String? weeklyResetsAt,
  num? sessionUsed,
  String? updatedAt,
  List<Map<String, dynamic>>? models,
  String? source,
}) =>
    {
      'engine': engine,
      'connected': connected,
      'reason': reason,
      'plan': plan,
      'weekly': weeklyUsed == null ? null : {'usedPercent': weeklyUsed, 'resetsAt': weeklyResetsAt},
      'session': sessionUsed == null ? null : {'usedPercent': sessionUsed},
      'models': models ?? const [],
      'updatedAt': updatedAt,
      'source': source,
    };

Map<String, dynamic> memberUsageJson(String id, {num? percent, int total = 1000, double? cost, String engine = 'claude'}) => {
      'memberId': id,
      'engine': engine,
      'context': percent == null ? null : {'used': 74210, 'window': 200000, 'percent': percent},
      'tokens': {'total': total},
      'costUsd': cost,
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
    };

/// 미래 시각(리셋) — 상대 표기가 "3일 뒤" 로 나오게.
String inDays(int d) => DateTime.now().toUtc().add(Duration(days: d, hours: 1)).toIso8601String();

Text chipText(WidgetTester tester, Engine engine) {
  final finder = find.descendant(of: find.byKey(EngineUsageChip.keyFor(engine)), matching: find.byType(Text));
  return tester.widget<Text>(finder.first);
}

void main() {
  late FakeRpcClient fake;

  setUp(() => fake = FakeRpcClient());
  tearDown(() async => fake.close());

  group('엔진 칩 5종(설계 §앱 1)', () {
    testWidgets('데몬이 아무 말도 안 했어도 칩은 두 개 — "첫 작업 후 표시"', (tester) async {
      await pumpBar(tester, fake);
      fake.emitHello();
      await tester.pumpAndSettle();
      expect(find.byKey(EngineUsageChip.keyFor(Engine.claude)), findsOneWidget);
      expect(find.byKey(EngineUsageChip.keyFor(Engine.codex)), findsOneWidget);
      expect(find.text('Claude · 첫 작업 후 표시'), findsOneWidget);
      expect(find.text('Codex · 첫 작업 후 표시'), findsOneWidget);
    });

    testWidgets('정상(주황) · 연결 안 됨(회색)', (tester) async {
      await pumpBar(tester, fake);
      fake.emitHello(usage: {
        'engines': [
          engineJson('claude', plan: 'max', weeklyUsed: 55, weeklyResetsAt: inDays(3)),
          engineJson('codex', connected: false, reason: 'not-installed'),
        ],
      });
      await tester.pumpAndSettle();
      expect(find.text('Claude 남음 45% · 3일 뒤'), findsOneWidget);
      expect(find.text('Codex 연결 안 됨'), findsOneWidget);
      expect(chipText(tester, Engine.claude).style!.color, usageWarnColor);
      expect(chipText(tester, Engine.codex).style!.color, usageOffColor);
    });

    testWidgets('빨강(<20% 남음)과 기본(>50% 남음)', (tester) async {
      await pumpBar(tester, fake);
      fake.emitHello(usage: {
        'engines': [engineJson('claude', weeklyUsed: 95), engineJson('codex', weeklyUsed: 10)],
      });
      await tester.pumpAndSettle();
      expect(chipText(tester, Engine.claude).style!.color, usageDangerColor);
      expect(chipText(tester, Engine.codex).style!.color, usageCalmColor);
      expect(find.text('Claude 남음 5%'), findsOneWidget);
      expect(find.text('Codex 남음 90%'), findsOneWidget);
    });

    testWidgets('오래된 값이면 꼬리에 "N분 전"', (tester) async {
      await pumpBar(tester, fake);
      fake.emitHello(usage: {
        'engines': [
          engineJson(
            'claude',
            weeklyUsed: 30,
            updatedAt: DateTime.now().toUtc().subtract(const Duration(minutes: 42)).toIso8601String(),
          ),
        ],
      });
      await tester.pumpAndSettle();
      expect(find.text('Claude 남음 70% · 42분 전'), findsOneWidget);
    });

    testWidgets('연결 안 됨 툴팁은 이유별로 다르다', (tester) async {
      await pumpBar(tester, fake);
      fake.emitHello(usage: {
        'engines': [
          engineJson('claude', connected: false, reason: 'logged-out'),
          engineJson('codex', connected: false, reason: 'not-installed'),
        ],
      });
      await tester.pumpAndSettle();
      expect(find.byTooltip('로그인이 필요합니다 — 터미널에서 claude 실행 후 로그인'), findsOneWidget);
      expect(find.byTooltip('codex 가 설치돼 있지 않습니다'), findsOneWidget);
    });

    testWidgets('usage.engine 알림이 오면 칩이 바로 바뀐다', (tester) async {
      await pumpBar(tester, fake);
      fake.emitHello(usage: {
        'engines': [engineJson('codex', weeklyUsed: 10)],
      });
      await tester.pumpAndSettle();
      expect(find.text('Codex 남음 90%'), findsOneWidget);
      fake.pushNotification('usage.engine', engineJson('codex', connected: false, reason: 'logged-out'));
      await tester.pumpAndSettle();
      await tester.pumpAndSettle();
      expect(find.text('Codex 연결 안 됨'), findsOneWidget);
    });
  });

  group('좁은 창(패스 6 최소 1100)', () {
    /// 상단 바를 최대한 빽빽하게 — 긴 선택 멤버 이름 + 부서 탭까지 넣고 넘치는지 본다(T43-4).
    Future<void> pumpCrowded(WidgetTester tester, double width) async {
      await pumpBar(tester, fake, width: width, selectedMemberId: 'mH');
      fake.emitHello(
        departments: [
          fakeDepartment('d1', name: '픽셀오피스', headId: 'mH'),
          fakeDepartment('d2', name: '결제 서버'),
          fakeDepartment('d3', name: '관리자 화면'),
        ],
        members: [fakeMember('mH', rank: 'head', name: '아주아주긴이름의부장님')],
        usage: {
          'engines': [
            engineJson('claude', weeklyUsed: 55, weeklyResetsAt: inDays(3)),
            engineJson('codex', connected: false, reason: 'logged-out'),
          ],
        },
      );
      await tester.pumpAndSettle();
    }

    testWidgets('1100 에서는 "Claude 45%" / "Codex 연결 안 됨" — 암호(C/X)가 아니다', (tester) async {
      await pumpCrowded(tester, 1100);
      expect(find.text('Claude 45%'), findsOneWidget);
      expect(find.text('Codex 연결 안 됨'), findsOneWidget);
      expect(find.text('Claude 남음 45% · 3일 뒤'), findsNothing);
      expect(find.text('C 45%'), findsNothing, reason: 'T43-4 이전의 암호 꼴로 돌아가지 않는다');
      expect(tester.takeException(), isNull, reason: '상단 바가 넘치지 않는다');
    });

    for (final width in [1100.0, 1280.0, 1400.0, 1920.0]) {
      testWidgets('$width: 칩 둘 + 긴 선택 멤버 이름 + 부서 탭 셋이 있어도 상단 바가 넘치지 않는다', (tester) async {
        await pumpCrowded(tester, width);
        expect(tester.takeException(), isNull);
        // 어느 폭에서든 두 엔진이 **읽을 수 있는 이름**으로 보인다.
        expect(find.textContaining('Claude'), findsWidgets);
        expect(find.textContaining('Codex'), findsWidgets);
      });
    }

    testWidgets('1920 에서는 긴 꼴 그대로', (tester) async {
      await pumpBar(tester, fake, width: 1920);
      fake.emitHello(usage: {
        'engines': [engineJson('claude', weeklyUsed: 55, weeklyResetsAt: inDays(3))],
      });
      await tester.pumpAndSettle();
      expect(find.text('Claude 남음 45% · 3일 뒤'), findsOneWidget);
      expect(find.text('Claude 45%'), findsNothing);
    });

    test('축약 경계 — 세 단계', () {
      expect(usageChipForm(1920), UsageChipForm.full);
      expect(usageChipForm(usageChipsCompactWidth), UsageChipForm.full);
      expect(usageChipForm(usageChipsCompactWidth - 1), UsageChipForm.compact);
      expect(usageChipForm(1400), UsageChipForm.compact, reason: '기본 창도 짧은 꼴 — 상단 바가 이미 빽빽하다');
      expect(usageChipForm(1280), UsageChipForm.compact);
      expect(usageChipForm(1100), UsageChipForm.compact, reason: '패스 6 최소 창에서도 이름은 지킨다');
      expect(usageChipForm(usageChipsMinimalWidth), UsageChipForm.compact);
      expect(usageChipForm(usageChipsMinimalWidth - 1), UsageChipForm.minimal, reason: '지원 범위 밖의 안전망');
      expect(usageChipsCompact(1280), isTrue);
      expect(usageChipsCompact(1920), isFalse);
    });
  });

  group('사용량 팝오버', () {
    Future<ProviderContainer> openPopover(WidgetTester tester, {Map<String, dynamic>? usage, List<Map<String, dynamic>>? members}) async {
      final c = await pumpBar(tester, fake);
      fake.emitHello(
        departments: [fakeDepartment('d1', headId: 'mH')],
        members: members ?? [fakeMember('mH', rank: 'head', name: '부장')],
        usage: usage,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(EngineUsageChip.keyFor(Engine.claude)));
      await tester.pumpAndSettle();
      return c;
    }

    testWidgets('칩을 누르면 열리고 엔진 두 구역 + 주간·5시간 막대가 보인다', (tester) async {
      await openPopover(tester, usage: {
        'engines': [
          engineJson('claude', plan: 'max', weeklyUsed: 55, weeklyResetsAt: inDays(3), sessionUsed: 12),
          engineJson('codex', weeklyUsed: 20),
        ],
      });
      expect(find.byKey(const Key('usage.popover')), findsOneWidget);
      expect(find.byKey(const Key('usage.engine.claude')), findsOneWidget);
      expect(find.byKey(const Key('usage.engine.codex')), findsOneWidget);
      expect(find.byKey(const Key('usage.window.claude.weekly')), findsOneWidget);
      expect(find.byKey(const Key('usage.window.claude.session')), findsOneWidget);
      expect(find.text('요금제 max'), findsOneWidget);
      expect(find.text('남음 45%'), findsOneWidget);
      // 5시간 한도가 없는 엔진은 그 줄을 아예 안 만든다.
      expect(find.byKey(const Key('usage.window.codex.session')), findsNothing);
    });

    testWidgets('T43-4: 주간 막대 아래에 모델별 막대가 한 줄씩 — 라벨은 CLI 가 준 그대로', (tester) async {
      await openPopover(tester, usage: {
        'engines': [
          engineJson('claude', plan: 'max', weeklyUsed: 55, weeklyResetsAt: inDays(3), source: 'probe', models: [
            {'label': 'Fable', 'usedPercent': 55, 'resetsAt': inDays(3)},
            {'label': 'Nebula 9 preview', 'usedPercent': 90},
          ]),
          engineJson('codex', weeklyUsed: 20),
        ],
      });
      expect(find.byKey(const Key('usage.window.claude.weekly')), findsOneWidget);
      expect(find.byKey(const Key('usage.window.claude.model.Fable')), findsOneWidget);
      expect(find.byKey(const Key('usage.window.claude.model.Nebula 9 preview')), findsOneWidget);
      expect(find.text('Fable'), findsOneWidget);
      expect(find.text('Nebula 9 preview'), findsOneWidget);
      // 색은 주간 막대와 같은 규칙 — 10% 남은 모델은 빨강 문구가 따로 뜬다.
      expect(find.text('남음 10%'), findsOneWidget);
      // Codex 에는 모델 줄이 없다.
      expect(find.byKey(const Key('usage.window.codex.model.Fable')), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('T43-4: 모델별 값이 없으면 줄을 아예 만들지 않는다 · 칩에는 아무것도 안 붙는다', (tester) async {
      await openPopover(tester, usage: {
        'engines': [engineJson('claude', weeklyUsed: 55, weeklyResetsAt: inDays(3), source: 'turn')],
      });
      expect(find.byKey(const Key('usage.window.claude.weekly')), findsOneWidget);
      expect(find.byWidgetPredicate((w) => w is Row && (w.key?.toString().contains('.model.') ?? false)), findsNothing);
      // 칩 문구는 모델·출처와 무관하다(칩에는 주간 하나만).
      expect(find.text('Claude 남음 45% · 3일 뒤'), findsOneWidget);
    });

    testWidgets('리셋은 절대 + 상대 둘 다', (tester) async {
      await openPopover(tester, usage: {
        'engines': [engineJson('claude', weeklyUsed: 55, weeklyResetsAt: inDays(3))],
      });
      expect(find.textContaining('(3일 뒤)'), findsOneWidget);
    });

    testWidgets('연결 안 된 엔진은 막대 대신 "연결 안 됨"', (tester) async {
      await openPopover(tester, usage: {
        'engines': [
          engineJson('claude', weeklyUsed: 10),
          engineJson('codex', connected: false, reason: 'logged-out'),
        ],
      });
      expect(find.byKey(const Key('usage.engine.codex.off')), findsOneWidget);
      expect(find.byKey(const Key('usage.window.codex.weekly')), findsNothing);
    });

    testWidgets('표는 컨텍스트 큰 순, 값 없는 사람은 뒤 · Codex 비용은 —', (tester) async {
      await openPopover(
        tester,
        members: [
          fakeMember('mH', rank: 'head', name: '부장', createdAt: 'a'),
          fakeMember('m1', name: '하루', createdAt: 'b'),
          fakeMember('m2', name: '모시', engine: 'codex', createdAt: 'c'),
        ],
        usage: {
          'engines': [engineJson('claude', weeklyUsed: 10)],
          'members': [
            memberUsageJson('mH', percent: 20, total: 1000, cost: 0.5),
            memberUsageJson('m1', percent: 88, total: 358600, cost: 1.84),
            memberUsageJson('m2', percent: 44, total: 12000, engine: 'codex'),
          ],
        },
      );
      final rows = tester.widgetList<InkWell>(find.byWidgetPredicate(
        (w) => w is InkWell && w.key is ValueKey<String> && (w.key! as ValueKey<String>).value.startsWith('usage.row.'),
      ));
      expect(rows.map((r) => (r.key! as ValueKey<String>).value),
          ['usage.row.m1', 'usage.row.m2', 'usage.row.mH']);
      expect(find.text('88%'), findsOneWidget);
      expect(find.text('358k'), findsOneWidget);
      expect(find.text(r'$1.84'), findsOneWidget);
      expect(find.text('—'), findsOneWidget, reason: 'Codex 는 비용 자리가 —');
    });

    testWidgets('기록이 없으면 빈 상태 문구', (tester) async {
      await openPopover(tester, usage: {
        'engines': [engineJson('claude', weeklyUsed: 10)],
      });
      expect(find.byKey(const Key('usage.table.empty')), findsOneWidget);
      expect(find.text(usageTableEmptyLabel), findsOneWidget);
    });

    testWidgets('행 클릭 = 그 캐릭터 선택 + 팝오버 닫힘', (tester) async {
      final c = await openPopover(
        tester,
        members: [fakeMember('mH', rank: 'head', name: '부장'), fakeMember('m1', name: '하루')],
        usage: {
          'members': [memberUsageJson('m1', percent: 30)],
        },
      );
      expect(c.read(selectedMemberIdProvider), isNull);
      await tester.tap(find.byKey(const Key('usage.row.m1')));
      await tester.pumpAndSettle();
      expect(c.read(selectedMemberIdProvider), 'm1');
      expect(find.byKey(const Key('usage.popover')), findsNothing);
    });

    testWidgets('Esc 로 닫힌다', (tester) async {
      await openPopover(tester, usage: {
        'engines': [engineJson('claude', weeklyUsed: 10)],
      });
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('usage.popover')), findsNothing);
    });

    testWidgets('바깥을 누르면 닫힌다', (tester) async {
      await openPopover(tester, usage: {
        'engines': [engineJson('claude', weeklyUsed: 10)],
      });
      await tester.tapAt(const Offset(50, 700));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('usage.popover')), findsNothing);
    });

    testWidgets('닫기 버튼도 있다(키보드로 닿는 자리)', (tester) async {
      await openPopover(tester, usage: {
        'engines': [engineJson('claude', weeklyUsed: 10)],
      });
      await tester.tap(find.byKey(const Key('usage.popover.close')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('usage.popover')), findsNothing);
    });
  });
}
