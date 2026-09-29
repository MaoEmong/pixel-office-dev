// T46-2 · 수명주기 §1: 데몬을 띄우는 쪽(명령 만들기 · daemon.log · pid 생존 · 트리 종료).
// `node` 가 PATH 에 있으면 **진짜로** 작은 자식 프로세스를 띄워 로그·환경변수·트리 kill 까지 본다
// (데몬 자체는 띄우지 않는다 — 여기 쓰는 스크립트는 전부 이 테스트가 만든 임시 파일이다).
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/lifecycle/daemon_process.dart';

bool get _hasNode {
  try {
    return Process.runSync(Platform.isWindows ? 'where' : 'which', ['node']).exitCode == 0;
  } catch (_) {
    return false;
  }
}

void main() {
  group('실행 명령(package.json scripts.start)', () {
    test('`tsx src/index.ts` → node --import tsx src/index.ts (npm·셸을 끼지 않는다)', () {
      expect(daemonCommandFor('tsx src/index.ts'), const DaemonCommand('node', ['--import', 'tsx', 'src/index.ts']));
    });

    test('`node dist/index.js` → 그대로', () {
      expect(daemonCommandFor('node dist/index.js'), const DaemonCommand('node', ['dist/index.js']));
    });

    test('모르는 모양이면 npm 으로 떨어진다 — 윈도우는 npm.cmd', () {
      // 어느 이름이 나오는지는 **플랫폼**이 정한다 — 호스트에 맡기면 맥에서 `npm` 이 나와 이 검사가 깨진다
      // (T48-3 M7). 두 갈래를 다 못 박는다.
      expect(daemonCommandFor('foo --bar', windows: true), const DaemonCommand('npm.cmd', ['start']));
      expect(daemonCommandFor(null, windows: true), const DaemonCommand('npm.cmd', ['start']));
      expect(daemonCommandFor('foo --bar', windows: false), const DaemonCommand('npm', ['start']));
      expect(daemonCommandFor('', windows: false), const DaemonCommand('npm', ['start']));
    });

    test('실제 저장소의 dev/daemon 은 tsx 한 줄이다', () async {
      final dir = Directory('${Directory.current.parent.path}${Platform.pathSeparator}daemon');
      expect(dir.existsSync(), isTrue, reason: 'flutter test 의 cwd 는 dev/app');
      final start = await readStartScript(dir);
      expect(start, 'tsx src/index.ts');
      expect(daemonCommandFor(start).executable, 'node');
    });

    test('package.json 이 없거나 깨졌으면 null', () async {
      final tmp = Directory.systemTemp.createTempSync('pixel-cmd-');
      addTearDown(() => tmp.deleteSync(recursive: true));
      expect(await readStartScript(tmp), isNull);
      File('${tmp.path}/package.json').writeAsStringSync('{ not json');
      expect(await readStartScript(tmp), isNull);
    });
  });

  group('daemon.log', () {
    late Directory tmp;
    setUp(() => tmp = Directory.systemTemp.createTempSync('pixel-log-'));
    tearDown(() => tmp.deleteSync(recursive: true));

    test('데이터 폴더 아래 daemon.log', () {
      expect(defaultDaemonLogPath({'PIXEL_DATA_DIR': r'C:\data'}), r'C:\data' '${Platform.pathSeparator}daemon.log');
      expect(defaultDaemonLogPath(const {}), isNull);
    });

    test('1MB 를 넘으면 뒤쪽만 남기고 잘린 첫 줄은 버린다', () async {
      final f = File('${tmp.path}/daemon.log');
      final line = '${'x' * 99}\n';
      f.writeAsStringSync(line * 20000); // 2MB
      await trimLogFile(f, daemonLogMaxBytes);
      final len = await f.length();
      expect(len, lessThanOrEqualTo(daemonLogMaxBytes));
      expect(len, greaterThan(daemonLogMaxBytes - 200));
      expect(f.readAsStringSync().startsWith('x' * 99), isTrue, reason: '줄 가운데서 시작하지 않는다');
    });

    test('작으면 그대로 둔다 · 폴더가 없으면 만든다', () async {
      final f = File('${tmp.path}/sub/daemon.log');
      await trimLogFile(f, daemonLogMaxBytes);
      expect(Directory('${tmp.path}/sub').existsSync(), isTrue);
      f.writeAsStringSync('짧다\n');
      await trimLogFile(f, daemonLogMaxBytes);
      expect(f.readAsStringSync(), '짧다\n');
    });

    test('꼬리 8줄만 읽는다(빈 줄 제외)', () async {
      final f = File('${tmp.path}/daemon.log');
      f.writeAsStringSync([for (var i = 1; i <= 20; i++) '줄 $i', '', ''].join('\n'));
      final tail = await readLogTail(f.path);
      expect(tail, hasLength(daemonLogTailLines));
      expect(tail.first, '줄 13');
      expect(tail.last, '줄 20');
    });

    test('파일이 없거나 경로가 null 이면 빈 목록', () async {
      expect(await readLogTail(null), isEmpty);
      expect(await readLogTail('${tmp.path}/없다.log'), isEmpty);
    });
  });

  group('pid 생존 · 트리 종료', () {
    test('이 프로세스는 살아 있고, 있을 수 없는 pid 는 죽어 있다', () async {
      expect(await isPidAlive(pid), isTrue);
      expect(await isPidAlive(0), isFalse);
      expect(await isPidAlive(-1), isFalse);
      expect(await isPidAlive(0x7FFFFFF0), isFalse);
    });

    test('이미지 이름이 다르면 거짓(pid 재사용 가드)', () async {
      expect(await isPidAlive(pid, imageContains: '있을리없는이름'), isFalse);
    });

    test('없는 pid 를 죽이라 해도 던지지 않는다', () async {
      await killProcessTree(0);
      await killProcessTree(0x7FFFFFF0);
    });
  });

  group('진짜로 띄워 보기(node 필요)', () {
    late Directory tmp;
    setUp(() => tmp = Directory.systemTemp.createTempSync('pixel-spawn-'));
    tearDown(() {
      try {
        tmp.deleteSync(recursive: true);
      } catch (_) {
        // 자식이 아직 파일을 쥐고 있을 수 있다.
      }
    });

    test('stdout·stderr 가 daemon.log 로 가고 PIXEL_PARENT_PID 가 전달된다', () async {
      File('${tmp.path}/package.json').writeAsStringSync('{"scripts":{"start":"node hello.js"}}');
      File('${tmp.path}/hello.js').writeAsStringSync(
        "console.log('표준출력 parent=' + process.env.PIXEL_PARENT_PID);"
        "console.error('표준오류 한 줄');",
      );
      final log = '${tmp.path}/daemon.log';
      final proc = await spawnDaemon(daemonDir: tmp, extraEnv: {'PIXEL_PARENT_PID': '4242'}, logPath: log);
      expect(proc.pid, greaterThan(0));
      expect(await proc.exitCode, 0);
      final text = File(log).readAsStringSync();
      expect(text, contains('표준출력 parent=4242'));
      expect(text, contains('표준오류 한 줄'));
      expect(text, contains('앱이 데몬을 띄움'), reason: '언제 무엇을 띄웠는지 로그 머리에 남는다');
    }, skip: _hasNode ? false : 'node 없음');

    // T46-3 실기 결함 ③: 앱이 죽으면 파이프의 읽는 쪽이 사라져 데몬이 **그 자리에서 멈춘다**(윈도우).
    // 그래서 데몬이 로그를 직접 파일에 쓰도록 경로를 넘긴다 — 데몬은 stdout 을 안 쓰게 된다.
    test('PIXEL_DAEMON_LOG 로 로그 파일 경로를 넘긴다 (데몬이 직접 쓴다)', () async {
      File('${tmp.path}/package.json').writeAsStringSync('{"scripts":{"start":"node env.js"}}');
      File('${tmp.path}/env.js').writeAsStringSync(
        "console.log('로그경로=' + process.env.PIXEL_DAEMON_LOG);",
      );
      final log = '${tmp.path}/daemon.log';
      final proc = await spawnDaemon(daemonDir: tmp, logPath: log);
      expect(await proc.exitCode, 0);
      expect(File(log).readAsStringSync(), contains('로그경로=$log'));
    }, skip: _hasNode ? false : 'node 없음');

    test('killTree 가 자식 + 손자를 끝낸다', () async {
      File('${tmp.path}/package.json').writeAsStringSync('{"scripts":{"start":"node sleeper.js"}}');
      File('${tmp.path}/sleeper.js').writeAsStringSync(
        "const {spawn} = require('child_process');"
        "const kid = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {stdio:'ignore'});"
        "console.log('손자 ' + kid.pid);"
        "setTimeout(()=>{}, 60000);",
      );
      final log = '${tmp.path}/daemon.log';
      final proc = await spawnDaemon(daemonDir: tmp, logPath: log);
      // 손자 pid 가 로그에 찍힐 때까지.
      var grandchild = 0;
      for (var i = 0; i < 100 && grandchild == 0; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
        final m = RegExp(r'손자 (\d+)').firstMatch(File(log).readAsStringSync());
        if (m != null) grandchild = int.parse(m.group(1)!);
      }
      expect(grandchild, greaterThan(0), reason: '손자를 띄웠다');
      expect(await isPidAlive(proc.pid), isTrue);
      await proc.killTree();
      expect(await proc.exitCode, isNot(0));
      expect(await isPidAlive(proc.pid), isFalse);
      expect(await isPidAlive(grandchild), isFalse, reason: 'taskkill /T 가 손자까지 데려간다');
    }, skip: _hasNode && Platform.isWindows ? false : 'node 없음 또는 윈도우 아님', timeout: const Timeout(Duration(seconds: 60)));

    test('띄우지 못하면 DaemonSpawnException(앱이 죽지 않는다)', () async {
      await expectLater(
        spawnDaemon(daemonDir: Directory('${tmp.path}/없는폴더'), logPath: '${tmp.path}/daemon.log'),
        throwsA(isA<DaemonSpawnException>()),
      );
    });
  });
}
