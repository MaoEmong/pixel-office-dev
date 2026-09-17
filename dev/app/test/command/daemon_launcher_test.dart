// daemon_launcher: 위로 올라가며 dev/daemon/package.json 찾기, 못 찾으면 DaemonLaunchException;
// DaemonStartButton 은 launcher 호출 후 retryNow(즉시 + 2초 + 4초), 실패 메시지 표시.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/topbar/daemon_launcher.dart';

import 'fake_rpc_client.dart';

void main() {
  late Directory tmp;

  setUp(() => tmp = Directory.systemTemp.createTempSync('pixel-launcher-'));
  tearDown(() => tmp.deleteSync(recursive: true));

  test('findDaemonDir: 깊은 하위 폴더에서 저장소 루트의 dev/daemon 을 찾는다', () async {
    final daemon = Directory('${tmp.path}/repo/dev/daemon')..createSync(recursive: true);
    File('${daemon.path}/package.json').writeAsStringSync('{}');
    final deep = Directory('${tmp.path}/repo/dev/app/build/windows/x64/runner/Release')..createSync(recursive: true);

    final found = await findDaemonDir(startPaths: [deep.path]);
    expect(found, isNotNull);
    expect(Directory(found!.path).resolveSymbolicLinksSync(), daemon.resolveSymbolicLinksSync());
  });

  test('findDaemonDir: 없으면 null, launchDaemon 은 DaemonLaunchException', () async {
    final lonely = Directory('${tmp.path}/nowhere/deeper')..createSync(recursive: true);
    expect(await findDaemonDir(startPaths: [lonely.path]), isNull);
    await expectLater(launchDaemon(startPaths: [lonely.path]), throwsA(isA<DaemonLaunchException>()));
  });

  test('실제 저장소: dev/app 에서 dev/daemon 을 찾는다', () async {
    // flutter test 의 cwd 는 dev/app.
    final found = await findDaemonDir(startPaths: [Directory.current.path]);
    expect(found, isNotNull);
    expect(File('${found!.path}/package.json').existsSync(), isTrue);
  });

  testWidgets('DaemonStartButton: launcher 호출 → retryNow 즉시·2초·4초, 안내 문구', (tester) async {
    final fake = FakeRpcClient();
    addTearDown(fake.close);
    var launched = 0;
    await tester.pumpWidget(ProviderScope(
      overrides: fake.overrides,
      child: MaterialApp(home: Scaffold(body: DaemonStartButton(launcher: () async => launched++))),
    ));
    await tester.tap(find.byKey(const Key('daemon.start')));
    await tester.pump();
    expect(launched, 1);
    expect(fake.retryNowCount, 1);
    expect(find.text('데몬 시작 중… (npm start)'), findsOneWidget);
    await tester.pump(const Duration(seconds: 2));
    expect(fake.retryNowCount, 2);
    await tester.pump(const Duration(seconds: 2));
    expect(fake.retryNowCount, 3);
  });

  testWidgets('T41: 6초 안에 daemon.json 이 안 생기면 "데몬이 뜨지 않았습니다"', (tester) async {
    final fake = FakeRpcClient();
    addTearDown(fake.close);
    await tester.pumpWidget(ProviderScope(
      overrides: fake.overrides,
      child: MaterialApp(
        home: Scaffold(
          body: DaemonStartButton(launcher: () async {}, checkDaemonJson: () async => false),
        ),
      ),
    ));
    await tester.tap(find.byKey(const Key('daemon.start')));
    await tester.pump();
    expect(find.text('데몬 시작 중… (npm start)'), findsOneWidget);

    await tester.pump(daemonStartTimeout);
    await tester.pump(); // 확인(Future) → setState
    expect(find.text(daemonNotStartedMessage), findsOneWidget);
    expect(find.textContaining('7420~7422'), findsOneWidget);
  });

  testWidgets('T41: daemon.json 이 생겼으면 실패 문구를 안 띄운다', (tester) async {
    final fake = FakeRpcClient();
    addTearDown(fake.close);
    await tester.pumpWidget(ProviderScope(
      overrides: fake.overrides,
      child: MaterialApp(
        home: Scaffold(
          body: DaemonStartButton(launcher: () async {}, checkDaemonJson: () async => true),
        ),
      ),
    ));
    await tester.tap(find.byKey(const Key('daemon.start')));
    await tester.pump(daemonStartTimeout);
    await tester.pump();
    expect(find.text(daemonNotStartedMessage), findsNothing);
    expect(find.text('데몬 시작 중… (npm start)'), findsOneWidget);
  });

  testWidgets('DaemonStartButton: 실패하면 오류 문구, retryNow 안 부름', (tester) async {
    final fake = FakeRpcClient();
    addTearDown(fake.close);
    await tester.pumpWidget(ProviderScope(
      overrides: fake.overrides,
      child: MaterialApp(home: Scaffold(body: DaemonStartButton(launcher: () async => throw const DaemonLaunchException('폴더 없음')))),
    ));
    await tester.tap(find.byKey(const Key('daemon.start')));
    await tester.pump();
    expect(find.text('폴더 없음'), findsOneWidget);
    expect(fake.retryNowCount, 0);
  });
}
