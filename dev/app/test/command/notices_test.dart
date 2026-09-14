// NoticeBanner: daemon.notice → 오른쪽 아래 배너, 5초 후 자동 숨김, 새 알림은 타이머 리셋, 닫기 버튼,
// 숨겨진 동안 아래 위젯 클릭을 막지 않음. NoticeToaster 는 child 위에 NoticeBanner 를 겹친다.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/topbar/notices.dart';

import 'fake_rpc_client.dart';

final banner = find.byKey(const Key('notice.banner'));

/// 스트림 → 리스너(setState) 는 첫 pump 의 마이크로태스크에서, 프레임은 둘째 pump 에서.
Future<void> pump2(WidgetTester tester) async {
  await tester.pump();
  await tester.pump();
}

void main() {
  late FakeRpcClient fake;

  setUp(() => fake = FakeRpcClient());
  tearDown(() async => fake.close());

  testWidgets('NoticeBanner(Stack 안): 알림 → 오른쪽 아래 배너, duration 뒤 사라짐; 새 알림은 타이머 리셋; 닫기 버튼', (tester) async {
    var taps = 0;
    await tester.pumpWidget(ProviderScope(
      overrides: fake.overrides,
      child: MaterialApp(
        home: Scaffold(
          body: Stack(
            children: [
              // 앱에서는 Column 이 Stack 크기를 정한다 — 여기선 사무실 자리를 expand 로.
              SizedBox.expand(child: GestureDetector(key: const Key('office'), onTap: () => taps++, child: const ColoredBox(color: Colors.black))),
              const NoticeBanner(),
            ],
          ),
        ),
      ),
    ));
    expect(banner, findsNothing);

    // 배너가 없을 때 아래 사무실 클릭이 통과한다.
    await tester.tapAt(tester.getBottomRight(find.byKey(const Key('office'))) - const Offset(20, 80));
    expect(taps, 1);

    fake.pushNotification('daemon.notice', {'level': 'warn', 'message': '복구: 1명 재개'});
    await pump2(tester);
    expect(find.text('복구: 1명 재개'), findsOneWidget);
    // 오른쪽 아래(margin 16/72) 에 붙는다.
    final screen = tester.getSize(find.byType(Scaffold));
    final rect = tester.getRect(banner);
    expect(rect.right, screen.width - 16);
    expect(rect.bottom, screen.height - 72);

    await tester.pump(const Duration(seconds: 3));
    fake.pushNotification('daemon.notice', {'level': 'info', 'message': '데몬 종료'});
    await pump2(tester);
    expect(find.text('데몬 종료'), findsOneWidget);
    expect(find.text('복구: 1명 재개'), findsNothing);

    await tester.pump(const Duration(seconds: 3));
    expect(find.text('데몬 종료'), findsOneWidget); // 리셋됐으므로 아직
    await tester.pump(const Duration(seconds: 2, milliseconds: 100));
    expect(banner, findsNothing);

    fake.pushNotification('daemon.notice', {'level': 'error', 'message': '오류'});
    await pump2(tester);
    await tester.tap(find.byKey(const Key('notice.close')));
    await tester.pump();
    expect(banner, findsNothing);
  });

  testWidgets('NoticeToaster 는 child 위에 NoticeBanner 를 겹친다', (tester) async {
    await tester.pumpWidget(ProviderScope(
      overrides: fake.overrides,
      child: const MaterialApp(home: NoticeToaster(duration: Duration(seconds: 1), child: Scaffold(body: Text('office')))),
    ));
    expect(find.text('office'), findsOneWidget);
    expect(find.byType(NoticeBanner), findsOneWidget);
    expect(banner, findsNothing);

    fake.pushNotification('daemon.notice', {'level': 'info', 'message': '자동 allow'});
    await pump2(tester);
    expect(find.text('자동 allow'), findsOneWidget);
    expect(find.text('office'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1, milliseconds: 100));
    expect(banner, findsNothing);
  });
}
