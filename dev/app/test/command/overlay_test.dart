// 끊김 오버레이(T40-5, D10 · 패스 4 하드리젝션 ②): pill 과 같은 문구 + 다음 재시도 진행 바 +
// 주 버튼 "데몬 시작" / 보조 "다시 연결" + 예외는 "자세히" 로 접힘.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/rpc/rpc_client.dart';
import 'package:pixel_office/topbar/disconnected_overlay.dart';

import 'fake_rpc_client.dart';

Future<void> pumpOverlay(WidgetTester tester, FakeRpcClient fake) async {
  await tester.pumpWidget(ProviderScope(
    overrides: fake.overrides,
    child: const MaterialApp(
      home: Scaffold(body: Stack(children: [DisconnectedOverlay()])),
    ),
  ));
  await tester.pump();
  await tester.pump();
}

void main() {
  late FakeRpcClient fake;

  setUp(() => fake = FakeRpcClient());
  tearDown(() async => fake.close());

  test('backoffForAttempt: 1→2→4→상한', () {
    const min = Duration(seconds: 1);
    const max = Duration(seconds: 5);
    expect(backoffForAttempt(0, min: min, max: max), min);
    expect(backoffForAttempt(1, min: min, max: max), const Duration(seconds: 1));
    expect(backoffForAttempt(2, min: min, max: max), const Duration(seconds: 2));
    expect(backoffForAttempt(3, min: min, max: max), const Duration(seconds: 4));
    expect(backoffForAttempt(4, min: min, max: max), max);
    expect(backoffForAttempt(99, min: min, max: max), max);
  });

  testWidgets('pill 과 같은 문구 + 진행 바 + 버튼 둘', (tester) async {
    await pumpOverlay(tester, fake);
    expect(find.text(disconnectedTitle), findsOneWidget);
    expect(find.text('끊김 · 재시도 0회'), findsOneWidget);
    expect(find.byKey(const Key('overlay.progress')), findsOneWidget);
    expect(find.text('데몬 시작'), findsOneWidget); // 주 버튼
    expect(find.byKey(const Key('overlay.retry')), findsOneWidget); // 보조

    fake.emitAttempt(3);
    await tester.pump();
    await tester.pump();
    expect(find.text('끊김 · 재시도 3회'), findsOneWidget);
    expect(find.textContaining('다음 재시도까지 4초'), findsOneWidget);

    await tester.tap(find.byKey(const Key('overlay.retry')));
    await tester.pump();
    expect(fake.retryNowCount, 1);
  });

  testWidgets('연결 중이면 진행 바가 불확정(value null)', (tester) async {
    await pumpOverlay(tester, fake);
    fake.setState(RpcConnectionState.connecting);
    await tester.pump();
    await tester.pump();
    expect(find.text('연결 중 · 0초'), findsOneWidget);
    expect(tester.widget<LinearProgressIndicator>(find.byKey(const Key('overlay.progress'))).value, isNull);
    expect(find.text('붙는 중…'), findsOneWidget);
  });

  testWidgets('예외 문자열은 기본으로 접혀 있고 "자세히" 로만 펼친다', (tester) async {
    await pumpOverlay(tester, fake);
    expect(find.byKey(const Key('overlay.details')), findsNothing); // 오류가 없으면 버튼도 없다

    fake.emitAttempt(1, error: 'SocketException: 연결이 거부되었습니다 (OS Error: ...)');
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('overlay.error')), findsNothing); // 사무실 전체에 뿌리지 않는다
    expect(find.textContaining('SocketException'), findsNothing);

    await tester.tap(find.byKey(const Key('overlay.details')));
    await tester.pump();
    expect(find.byKey(const Key('overlay.error')), findsOneWidget);
    expect(find.textContaining('SocketException'), findsOneWidget);

    await tester.tap(find.byKey(const Key('overlay.details')));
    await tester.pump();
    expect(find.byKey(const Key('overlay.error')), findsNothing);
  });
}
