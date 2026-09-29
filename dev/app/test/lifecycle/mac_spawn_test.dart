// 맥에서 데몬 띄우기(T48-2 · D-48 ③): `node --import tsx src/index.ts` 를 **절대 경로 node** 로,
// 못 찾으면 감시자가 `failed(nodeNotFound)` 로 가고 실패 화면에 한 문장이 뜬다. 폴백 "데몬 시작" 버튼도
// 같은 스포너를 쓴다(창을 띄우지 않는다).
//
// 진짜 맥 빌드는 이 PC 에서 못 한다 — 여기서는 플랫폼을 주입해 **명령과 실패 경로**만 고정한다.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/lifecycle/daemon_process.dart';
import 'package:pixel_office/lifecycle/daemon_supervisor.dart';
import 'package:pixel_office/platform/platform.dart' show nodeNotFoundMessage;
import 'package:pixel_office/topbar/daemon_launcher.dart';

import '../platform/fake_platform.dart';
import 'fake_supervisor_world.dart';

FakePlatform macWithNode() => FakePlatform(
      os: 'macos',
      env: {'PATH': '/usr/bin:/bin', 'HOME': '/Users/u'},
      files: {'/opt/homebrew/bin/node'},
    );

FakePlatform macWithoutNode() => FakePlatform(os: 'macos', env: {'PATH': '/usr/bin:/bin', 'HOME': '/Users/u'});

void main() {
  group('실행 명령 → 실제로 띄울 명령(resolveDaemonCommand)', () {
    test('맥: node 가 **절대 경로**로 바뀐다 — 인자는 그대로', () {
      final cmd = daemonCommandFor('tsx src/index.ts', platform: macWithNode());
      expect(cmd, const DaemonCommand('node', ['--import', 'tsx', 'src/index.ts']));
      final resolved = resolveDaemonCommand(cmd, platform: macWithNode());
      expect(resolved.executable, '/opt/homebrew/bin/node');
      expect(resolved.arguments, ['--import', 'tsx', 'src/index.ts']);
    });

    test('맥: node 를 못 찾으면 DaemonNodeNotFoundException(원인 node-not-found)', () {
      final cmd = daemonCommandFor('tsx src/index.ts', platform: macWithoutNode());
      expect(
        () => resolveDaemonCommand(cmd, platform: macWithoutNode()),
        throwsA(isA<DaemonNodeNotFoundException>()
            .having((e) => e.reason, '원인', nodeNotFoundReason)
            .having((e) => e.message, '문구', nodeNotFoundMessage)),
      );
      expect(nodeNotFoundReason, 'node-not-found');
    });

    test('맥: PIXEL_NODE 를 지정하면 그것으로 띄운다', () {
      final mac = FakePlatform(os: 'macos', env: {'PIXEL_NODE': '/Users/u/.volta/bin/node', 'HOME': '/Users/u'});
      final resolved = resolveDaemonCommand(daemonCommandFor('tsx src/index.ts', platform: mac), platform: mac);
      expect(resolved.executable, '/Users/u/.volta/bin/node');
    });

    test('맥: 모르는 start 스크립트는 npm(윈도우는 npm.cmd)', () {
      expect(daemonCommandFor('foo --bar', platform: macWithNode()), const DaemonCommand('npm', ['start']));
      expect(daemonCommandFor('foo --bar', platform: FakePlatform(os: 'windows')), const DaemonCommand('npm.cmd', ['start']));
      // npm 은 이름이 플랫폼마다 다르게 정리된다(같은 명령을 다른 플랫폼에서 해석해도 어긋나지 않게).
      expect(resolveDaemonCommand(const DaemonCommand('npm.cmd', ['start']), platform: macWithNode()).executable, 'npm');
      expect(
        resolveDaemonCommand(const DaemonCommand('npm', ['start']), platform: FakePlatform(os: 'windows')).executable,
        'npm.cmd',
      );
    });

    test('윈도우: 오늘 그대로 `node` — 절대 경로로 바꾸지 않고 던지지도 않는다', () {
      final win = FakePlatform(os: 'windows');
      final resolved = resolveDaemonCommand(daemonCommandFor('tsx src/index.ts', platform: win), platform: win);
      expect(resolved, const DaemonCommand('node', ['--import', 'tsx', 'src/index.ts']));
    });

    test('그 밖의 실행 파일은 건드리지 않는다', () {
      expect(
        resolveDaemonCommand(const DaemonCommand('deno', ['run']), platform: macWithNode()),
        const DaemonCommand('deno', ['run']),
      );
    });
  });

  group('spawnDaemon 이 맥에서 쓰는 경로', () {
    late Directory tmp;
    setUp(() {
      tmp = Directory.systemTemp.createTempSync('pixel-mac-spawn-');
      File('${tmp.path}/package.json').writeAsStringSync('{"scripts":{"start":"tsx src/index.ts"}}');
    });
    tearDown(() {
      try {
        tmp.deleteSync(recursive: true);
      } catch (_) {
        // 자식이 파일을 쥐고 있을 수 있다.
      }
    });

    test('node 를 못 찾으면 **스폰 전에** 던진다(로그도 남지 않는다)', () async {
      final log = '${tmp.path}/daemon.log';
      await expectLater(
        spawnDaemon(daemonDir: tmp, logPath: log, platform: macWithoutNode()),
        throwsA(isA<DaemonNodeNotFoundException>()),
      );
    });

    test('찾은 node 경로로 띄운다 — 오류 문구에 그 경로가 들어 있다(이 PC 엔 없는 경로다)', () async {
      final log = '${tmp.path}/daemon.log';
      await expectLater(
        spawnDaemon(daemonDir: tmp, logPath: log, platform: macWithNode()),
        throwsA(isA<DaemonSpawnException>().having((e) => e.message, '문구', contains('/opt/homebrew/bin/node'))),
      );
    });
  });

  group('감시자: node 를 못 찾으면 failed(nodeNotFound)', () {
    test('첫 시도에서 바로 실패 화면 — 재시작 일정을 돌지 않는다', () async {
      final world = FakeSupervisorWorld(spawnThrows: const DaemonNodeNotFoundException());
      final sup = world.supervisor();
      addTearDown(sup.dispose);
      await sup.start();
      expect(sup.status.state, SupervisorState.failed);
      expect(sup.status.failure, SupervisorFailure.nodeNotFound);
      expect(sup.status.lastError, nodeNotFoundMessage);
      expect(world.spawnCount, 0, reason: '자식은 안 생겼다');
      expect(world.restartWaits, isEmpty, reason: 'node 가 없으면 기다려도 안 생긴다');
    });

    test('그 밖의 스폰 실패는 지금처럼 startFailed', () async {
      final world = FakeSupervisorWorld(spawnThrows: const DaemonSpawnException('데몬 실행 실패(npm.cmd): 없음'));
      final sup = world.supervisor();
      addTearDown(sup.dispose);
      await sup.start();
      expect(sup.status.failure, SupervisorFailure.startFailed);
    });
  });

  group('폴백 "데몬 시작" 버튼', () {
    late Directory repo;
    setUp(() {
      repo = Directory.systemTemp.createTempSync('pixel-mac-launch-');
      Directory('${repo.path}/dev/daemon').createSync(recursive: true);
      File('${repo.path}/dev/daemon/package.json').writeAsStringSync('{"scripts":{"start":"tsx src/index.ts"}}');
    });
    tearDown(() => repo.deleteSync(recursive: true));

    test('맥: 콘솔 창(`cmd /c start`)이 아니라 **같은 스포너**로 띄운다', () async {
      final spawned = <String>[];
      await launchDaemon(
        startPaths: [repo.path],
        platform: macWithNode(),
        spawn: (dir) async => spawned.add(dir.path),
      );
      expect(spawned, hasLength(1));
      expect(spawned.single, endsWith('daemon'));
    });

    test('맥: 폴더를 못 찾으면 스포너를 부르지 않고 DaemonLaunchException', () async {
      // dev/daemon 이 **위로 올라가도** 없는 곳에서 시작해야 한다(repo 아래에서 시작하면 찾아 버린다).
      final lonely = Directory.systemTemp.createTempSync('pixel-mac-lonely-');
      addTearDown(() => lonely.deleteSync(recursive: true));
      var called = 0;
      await expectLater(
        launchDaemon(startPaths: [lonely.path], platform: macWithNode(), spawn: (_) async => called++),
        throwsA(isA<DaemonLaunchException>()),
      );
      expect(called, 0);
    });

    test('맥: node 가 없으면 그 예외가 그대로 올라온다(버튼 아래 문구가 된다)', () async {
      await expectLater(
        launchDaemon(
          startPaths: [repo.path],
          platform: macWithoutNode(),
          spawn: (dir) async => throw const DaemonNodeNotFoundException(),
        ),
        throwsA(isA<DaemonNodeNotFoundException>()),
      );
    });

    test('findDaemonDir 는 맥 경로 구분자(/)로도 찾는다', () async {
      final found = await findDaemonDir(startPaths: [repo.path], platform: macWithNode());
      expect(found, isNotNull);
      expect(found!.path.replaceAll(r'\', '/'), endsWith('dev/daemon'));
    });
  });
}
