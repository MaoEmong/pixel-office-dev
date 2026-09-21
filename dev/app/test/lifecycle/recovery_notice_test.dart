// T46-2 · 수명주기 §3 · §4 와이어: `daemon.notice{kind, total, done}`.
//   kind 를 읽고, 모르는 값은 plain 으로 떨어지고, 복구 진행은 상태로 들고 있다가 다 끝나거나
//   새 hello 가 오면 지운다. message 가 빈 알림은 토스트를 띄우지 않는다(오버레이가 말한다).
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/state/office_state.dart';
import 'package:pixel_office/topbar/notices.dart';

import '../command/fake_rpc_client.dart';

void main() {
  group('모델', () {
    test('kind·total·done 을 읽는다', () {
      final n = DaemonNotice.fromJson({'kind': 'recovering', 'total': 5, 'done': 2});
      expect(n.kind, DaemonNoticeKind.recovering);
      expect(n.total, 5);
      expect(n.done, 2);
      expect(n.hasProgress, isTrue);
      expect(n.level, NoticeLevel.info, reason: 'level 이 없으면 info');
      expect(n.message, '');
    });

    test('parent-gone 은 하이픈 와이어', () {
      expect(DaemonNotice.fromJson({'kind': 'parent-gone'}).kind, DaemonNoticeKind.parentGone);
      expect(DaemonNoticeKind.parentGone.wire, 'parent-gone');
    });

    test('모르는 kind·level 은 plain·info 로 떨어진다(알림 하나에 스트림이 끊기지 않게)', () {
      final n = DaemonNotice.fromJson({'kind': '아직없는것', 'level': '아직없는것', 'message': '음'});
      expect(n.kind, DaemonNoticeKind.plain);
      expect(n.level, NoticeLevel.info);
      expect(n.message, '음');
    });

    test('kind 가 없으면 지금까지의 알림 그대로', () {
      final n = DaemonNotice.fromJson({'level': 'warn', 'message': '복구: 1명 재개'});
      expect(n.kind, DaemonNoticeKind.plain);
      expect(n.level, NoticeLevel.warn);
      expect(n.hasProgress, isFalse);
    });
  });

  group('상태', () {
    late FakeRpcClient fake;
    late ProviderContainer container;

    setUp(() {
      fake = FakeRpcClient();
      container = ProviderContainer(overrides: fake.overrides);
      container.read(officeProvider); // 구독 시작
    });
    tearDown(() async {
      container.dispose();
      await fake.close();
    });

    test('recovering 알림이 오면 진행을 들고 있는다', () async {
      fake.pushNotification('daemon.notice', {'kind': 'recovering', 'total': 5, 'done': 2});
      await Future<void>.delayed(Duration.zero);
      final r = container.read(recoveryProgressProvider);
      expect(r, isNotNull);
      expect(r!.done, 2);
      expect(r.total, 5);
    });

    test('done 이 total 에 닿으면 표시를 내린다', () async {
      fake.pushNotification('daemon.notice', {'kind': 'recovering', 'total': 3, 'done': 1});
      await Future<void>.delayed(Duration.zero);
      expect(container.read(recoveryProgressProvider), isNotNull);
      fake.pushNotification('daemon.notice', {'kind': 'recovering', 'total': 3, 'done': 3});
      await Future<void>.delayed(Duration.zero);
      expect(container.read(recoveryProgressProvider), isNull);
    });

    test('새 hello(= 새 연결)가 지난 진행을 지운다', () async {
      fake.pushNotification('daemon.notice', {'kind': 'recovering', 'total': 5, 'done': 1});
      await Future<void>.delayed(Duration.zero);
      expect(container.read(recoveryProgressProvider), isNotNull);
      fake.emitHello();
      await Future<void>.delayed(Duration.zero);
      expect(container.read(recoveryProgressProvider), isNull);
    });

    test('보통 알림은 진행을 건드리지 않고 링버퍼에만 쌓인다', () async {
      fake.pushNotification('daemon.notice', {'kind': 'recovering', 'total': 5, 'done': 1});
      fake.pushNotification('daemon.notice', {'level': 'warn', 'message': '셸 락 강제 해제'});
      await Future<void>.delayed(Duration.zero);
      expect(container.read(recoveryProgressProvider), isNotNull);
      expect(container.read(noticesProvider), hasLength(2));
    });
  });

  group('토스트', () {
    testWidgets('message 가 빈 수명 주기 알림은 배너로 뜨지 않는다', (tester) async {
      final fake = FakeRpcClient();
      addTearDown(fake.close);
      await tester.pumpWidget(ProviderScope(
        overrides: fake.overrides,
        child: const MaterialApp(home: Scaffold(body: Stack(children: [NoticeBanner()]))),
      ));
      fake.pushNotification('daemon.notice', {'kind': 'recovering', 'total': 5, 'done': 1});
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const Key('notice.banner')), findsNothing);

      fake.pushNotification('daemon.notice', {'level': 'info', 'message': '할 말이 있다'});
      await tester.pump();
      await tester.pump();
      expect(find.text('할 말이 있다'), findsOneWidget);
    });
  });
}
