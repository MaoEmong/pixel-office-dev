// 운영체제에 닿는 코드 한곳(T48-2 · D-48): 데이터 폴더 · node 탐색 · npm 이름 · 생존/이미지 이름/트리 종료.
//
// 맥 분기는 **플랫폼을 주입해서만** 검증한다(이 PC 는 윈도우다). `ps`·`kill`·`tasklist` 는 부르지 않는다 —
// 가짜 출력을 먹이고 **어떤 인자로 불렀는지**를 본다.
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/platform/platform.dart';

import 'fake_platform.dart';

void main() {
  group('데이터 폴더(데몬과 같은 규칙)', () {
    test('윈도우: %LOCALAPPDATA%\\pixel-office, 없으면 null', () {
      final win = FakePlatform(os: 'windows', env: {'LOCALAPPDATA': r'C:\Users\U\AppData\Local'});
      expect(dataDir(platform: win), r'C:\Users\U\AppData\Local\pixel-office');
      expect(dataFilePath('daemon.json', platform: win), r'C:\Users\U\AppData\Local\pixel-office\daemon.json');
      expect(dataDir(platform: FakePlatform(os: 'windows')), isNull);
      expect(dataDir(platform: FakePlatform(os: 'windows', env: {'LOCALAPPDATA': ''})), isNull);
    });

    test(r'맥: $HOME/Library/Application Support/pixel-office', () {
      final mac = FakePlatform(os: 'macos', env: {'HOME': '/Users/u'});
      expect(dataDir(platform: mac), '/Users/u/Library/Application Support/pixel-office');
      expect(dataFilePath('app.lock', platform: mac), '/Users/u/Library/Application Support/pixel-office/app.lock');
      expect(dataDir(platform: FakePlatform(os: 'macos')), isNull, reason: 'HOME 이 없으면 정할 수 없다');
    });

    test('리눅스: XDG_DATA_HOME 이 있으면 그것, 없으면 ~/.local/share', () {
      expect(
        dataDir(platform: FakePlatform(os: 'linux', env: {'HOME': '/home/u', 'XDG_DATA_HOME': '/home/u/.data'})),
        '/home/u/.data/pixel-office',
      );
      expect(dataDir(platform: FakePlatform(os: 'linux', env: {'HOME': '/home/u'})), '/home/u/.local/share/pixel-office');
    });

    test('PIXEL_DATA_DIR 이 모든 플랫폼에서 이긴다(데몬과 같은 이름)', () {
      expect(dataDirEnvVar, 'PIXEL_DATA_DIR');
      for (final os in ['windows', 'macos', 'linux']) {
        final p = FakePlatform(os: os, env: {
          'PIXEL_DATA_DIR': '/tmp/po',
          'LOCALAPPDATA': r'C:\L',
          'HOME': '/Users/u',
        });
        expect(dataDir(platform: p), '/tmp/po', reason: os);
      }
    });

    test('env 를 따로 넘기면 그것을 본다(플랫폼 규칙은 그대로)', () {
      final mac = FakePlatform(os: 'macos', env: {'HOME': '/Users/real'});
      expect(dataDir(platform: mac, env: {'HOME': '/Users/other'}), '/Users/other/Library/Application Support/pixel-office');
    });

    test('진단 문구에 쓰는 환경변수 이름은 플랫폼마다 다르다', () {
      expect(dataDirEnvName(platform: FakePlatform(os: 'windows')), 'LOCALAPPDATA');
      expect(dataDirEnvName(platform: FakePlatform(os: 'macos')), 'HOME');
      expect(dataDirEnvName(platform: FakePlatform(os: 'linux')), 'HOME');
    });
  });

  group('node 찾기(맥 GUI 앱은 터미널 PATH 를 못 물려받는다)', () {
    test('PIXEL_NODE 가 가장 세다 — 파일이 없어도 그대로 쓴다(틀리면 스폰 오류로 드러난다)', () {
      expect(nodeEnvVar, 'PIXEL_NODE');
      final mac = FakePlatform(
        os: 'macos',
        env: {'PIXEL_NODE': '/my/node', 'PATH': '/usr/bin', 'HOME': '/Users/u'},
        files: {'/usr/bin/node', '/opt/homebrew/bin/node'},
      );
      expect(findNode(platform: mac), '/my/node');
    });

    test('PATH → Homebrew → /usr/local → nvm → volta 순서', () {
      final path = FakePlatform(
        os: 'macos',
        env: {'PATH': '/usr/bin:/opt/pref/bin', 'HOME': '/Users/u'},
        files: {'/opt/pref/bin/node', '/opt/homebrew/bin/node'},
      );
      expect(findNode(platform: path), '/opt/pref/bin/node', reason: 'PATH 가 Homebrew 보다 앞');

      final brew = FakePlatform(
        os: 'macos',
        env: {'PATH': '/usr/bin:/bin', 'HOME': '/Users/u'},
        files: {'/opt/homebrew/bin/node', '/usr/local/bin/node'},
      );
      expect(findNode(platform: brew), '/opt/homebrew/bin/node');

      final local = FakePlatform(os: 'macos', env: {'PATH': '/usr/bin', 'HOME': '/Users/u'}, files: {'/usr/local/bin/node'});
      expect(findNode(platform: local), '/usr/local/bin/node');
    });

    test('nvm 은 **가장 새 버전**을 고른다', () {
      final nvm = FakePlatform(
        os: 'macos',
        env: {'PATH': '/usr/bin', 'HOME': '/Users/u'},
        files: {
          '/Users/u/.nvm/versions/node/v20.11.1/bin/node',
          '/Users/u/.nvm/versions/node/v22.9.0/bin/node',
          '/Users/u/.nvm/versions/node/v22.14.0/bin/node',
        },
        dirs: {
          '/Users/u/.nvm/versions/node': ['v20.11.1', 'v22.9.0', 'v22.14.0'],
        },
      );
      expect(findNode(platform: nvm), '/Users/u/.nvm/versions/node/v22.14.0/bin/node');
    });

    test('nvm 폴더는 있는데 bin/node 가 없으면 다음 후보로 간다(volta)', () {
      final volta = FakePlatform(
        os: 'macos',
        env: {'PATH': '/usr/bin', 'HOME': '/Users/u'},
        files: {'/Users/u/.volta/bin/node'},
        dirs: {
          '/Users/u/.nvm/versions/node': ['v22.14.0'],
        },
      );
      expect(findNode(platform: volta), '/Users/u/.volta/bin/node');
    });

    test('아무 데도 없으면 null — 실패 화면 문구는 하나다', () {
      final none = FakePlatform(os: 'macos', env: {'PATH': '/usr/bin:/bin', 'HOME': '/Users/u'});
      expect(findNode(platform: none), isNull);
      expect(findNode(platform: FakePlatform(os: 'macos')), isNull, reason: 'HOME 도 PATH 도 없다');
      expect(nodeNotFoundMessage, 'node 를 찾지 못했습니다 — Homebrew 로 설치하거나 PIXEL_NODE 로 경로를 지정하세요');
    });

    test('윈도우는 오늘 그대로 `node`(PATH 는 CreateProcess 가 찾는다)', () {
      expect(findNode(platform: FakePlatform(os: 'windows')), 'node');
      expect(findNode(platform: FakePlatform(os: 'windows', env: {'PIXEL_NODE': r'C:\node\node.exe'})), r'C:\node\node.exe');
    });

    test('버전 정렬은 숫자 조각으로 — 문자열 정렬이 아니다', () {
      final v = ['v9.0.0', 'v10.0.0', 'v22.9.0', 'v22.14.0']..sort(compareNodeVersionDesc);
      expect(v, ['v22.14.0', 'v22.9.0', 'v10.0.0', 'v9.0.0']);
    });

    test('리눅스도 같은 탐색을 쓴다(유닉스 공통)', () {
      final linux = FakePlatform(os: 'linux', env: {'PATH': '/usr/bin', 'HOME': '/home/u'}, files: {'/usr/bin/node'});
      expect(findNode(platform: linux), '/usr/bin/node');
    });
  });

  group('npm 실행 파일', () {
    test('윈도우는 npm.cmd, 맥·리눅스는 npm', () {
      expect(npmExecutable(platform: FakePlatform(os: 'windows')), 'npm.cmd');
      expect(npmExecutable(platform: FakePlatform(os: 'macos')), 'npm');
      expect(npmExecutable(platform: FakePlatform(os: 'linux')), 'npm');
    });
  });

  group('프로세스 생존(맥 kill -0)', () {
    test('살아 있으면 exit 0 · 없으면 거짓 — `kill -0 <pid>` 로 묻는다', () async {
      final unix = FakeUnix(alive: {4242});
      final mac = FakePlatform(os: 'macos', handler: unix.call);
      expect(await isProcessAlive(4242, platform: mac), isTrue);
      expect(await isProcessAlive(9999, platform: mac), isFalse);
      expect(mac.calls.first, ['kill', '-0', '4242']);
    });

    test('EPERM(남의 프로세스)도 살아 있음으로 본다', () async {
      final unix = FakeUnix(permissionDenied: {77});
      expect(await isProcessAlive(77, platform: FakePlatform(os: 'macos', handler: unix.call)), isTrue);
    });

    test('pid 0 이하는 묻지도 않는다', () async {
      final mac = FakePlatform(os: 'macos', handler: FakeUnix().call);
      expect(await isProcessAlive(0, platform: mac), isFalse);
      expect(await isProcessAlive(-1, platform: mac), isFalse);
      expect(mac.calls, isEmpty);
    });

    test('이미지 이름을 주면 `ps -p <pid> -o comm=` 로 확인한다(pid 재사용 가드)', () async {
      final unix = FakeUnix(alive: {31}, comm: {31: '/opt/homebrew/bin/node'});
      final mac = FakePlatform(os: 'macos', handler: unix.call);
      expect(await isProcessAlive(31, imageContains: 'node', platform: mac), isTrue);
      expect(await isProcessAlive(31, imageContains: 'pixel_office', platform: mac), isFalse);
      expect(mac.calls.first, ['ps', '-p', '31', '-o', 'comm=']);
    });

    test('이미지 이름은 basename 이다(`comm=` 이 경로로 나와도)', () async {
      final unix = FakeUnix(comm: {5: '/Users/u/.volta/bin/node'});
      expect(await processImageName(5, platform: FakePlatform(os: 'macos', handler: unix.call)), 'node');
      expect(await processImageName(6, platform: FakePlatform(os: 'macos', handler: unix.call)), isNull);
    });

    test('윈도우는 tasklist CSV 를 그대로 읽는다(동작 그대로)', () async {
      final win = FakePlatform(
        os: 'windows',
        handler: (exe, args) => fakeTasklist({1234: 'pixel_office.exe'}, exe, args),
      );
      expect(await isProcessAlive(1234, platform: win), isTrue);
      expect(await isProcessAlive(1234, imageContains: 'pixel_office.exe', platform: win), isTrue);
      expect(await isProcessAlive(1234, imageContains: 'node.exe', platform: win), isFalse);
      expect(await isProcessAlive(4321, platform: win), isFalse);
      expect(await processImageName(1234, platform: win), 'pixel_office.exe');
      expect(win.calls.first, ['tasklist', '/FI', 'PID eq 1234', '/NH', '/FO', 'CSV']);
    });
  });

  group('트리 종료', () {
    test('맥: ps 로 트리를 만들어 **자식부터** kill -9 한다(3대)', () async {
      // 100(데몬) → 200(자식) → 300·301(손자). 400 은 남의 프로세스다.
      final unix = FakeUnix(tree: {1: 0, 100: 1, 200: 100, 300: 200, 301: 200, 400: 1});
      final mac = FakePlatform(os: 'macos', handler: unix.call);
      await killTree(100, platform: mac);
      expect(unix.killed.first, anyOf(300, 301), reason: '가장 깊은 자손이 먼저');
      expect(unix.killed.last, 100, reason: '뿌리는 마지막 — 먼저 죽이면 자손이 init 에 입양돼 목록에서 사라진다');
      expect(unix.killed.toSet(), {100, 200, 300, 301});
      expect(unix.killed, isNot(contains(400)));
      expect(mac.calls.first, ['ps', '-axo', 'pid=,ppid=']);
    });

    test('맥: 자식이 없으면 자기만 죽인다 · pid 0 이하는 아무것도 안 한다', () async {
      final unix = FakeUnix(tree: {500: 1});
      final mac = FakePlatform(os: 'macos', handler: unix.call);
      await killTree(500, platform: mac);
      expect(unix.killed, [500]);
      await killTree(0, platform: mac);
      expect(unix.killed, [500]);
    });

    test('윈도우: taskkill /T /F 하나로 끝낸다(동작 그대로)', () async {
      final win = FakePlatform(os: 'windows', handler: (exe, args) => const ProcessRun(0));
      await killTree(777, platform: win);
      expect(win.calls, [
        ['taskkill', '/PID', '777', '/T', '/F']
      ]);
    });

    test('ps 출력 파싱: 숫자 두 개인 줄만 본다', () {
      const out = '''
    1     0
  100     1
  bad line
  200   100
''';
      expect(parseProcessParents(out), {1: 0, 100: 1, 200: 100});
    });

    test('트리 순서: 자기를 부모로 갖는 줄(pid 1)이 있어도 돌지 않는다', () {
      expect(processTreeOrder(1, {1: 1, 2: 1}), [2, 1]);
    });
  });

  group('단축키 조합키', () {
    test('테스트 기본 플랫폼(android)에서는 Ctrl — 윈도우와 같다', () {
      expect(isMetaShortcuts, isFalse);
      expect(shortcutModifierLabel, 'Ctrl');
    });

    test('맥으로 흉내 내면 Cmd', () {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      expect(isMetaShortcuts, isTrue);
      expect(shortcutModifierLabel, 'Cmd');
    });
  });

  // 여기만 **진짜** 운영체제를 본다. 윈도우에서도 맥에서도 돌아야 하므로(2단계에서 맥이 이 파일을 그대로 돌린다)
  // "윈도우다" 를 단정하지 않고 **한 플랫폼 안에서 앞뒤가 맞는지**만 본다.
  group('진짜 플랫폼(HostPlatform)', () {
    test('플랫폼 판정이 하나뿐이고 npm·node·구분자가 그것과 맞는다', () {
      const host = HostPlatform();
      final flags = [host.isWindows, host.isMacOS, host.isLinux].where((b) => b).length;
      expect(flags, lessThanOrEqualTo(1), reason: '윈도우이면서 맥일 수는 없다');
      expect(host.pathSeparator, host.isWindows ? r'\' : '/');
      expect(npmExecutable(platform: host), host.isWindows ? 'npm.cmd' : 'npm');
      if (host.isWindows) {
        expect(findNode(platform: host), 'node', reason: '윈도우는 PATH 에 맡긴다');
      }
      expect(currentPlatform.isWindows, host.isWindows, reason: '기본값은 진짜 플랫폼이다');
    });

    test('데이터 폴더는 이 플랫폼의 규칙을 따른다', () {
      const host = HostPlatform();
      // 이 컴퓨터에 `PIXEL_DATA_DIR` 이 있어도 결과가 흔들리지 않게 빼고 본다(그 규칙은 위에서 따로 본다).
      final env = Map<String, String>.from(host.env)..remove(dataDirEnvVar);
      final dir = dataDir(platform: host, env: env);
      if (dir == null) return; // LOCALAPPDATA·HOME 이 없는 환경(CI 등)에서는 정할 수 없다 — 그것도 규칙이다
      expect(dir, endsWith(dataFolderName));
      if (host.isMacOS) expect(dir, contains('/Library/Application Support/'));
      if (host.isWindows) expect(dir, contains(r'\'));
    });

    test('없는 실행 파일을 불러도 던지지 않는다(-1 로 돌아온다)', () async {
      const host = HostPlatform();
      final r = await host.runner('이런-실행파일은-없다', const []);
      expect(r.exitCode, isNot(0));
    });

    test('파일·폴더 확인은 실제 파일 시스템을 본다', () {
      const host = HostPlatform();
      expect(host.fileExists('pubspec.yaml'), isTrue);
      expect(host.fileExists('없는-파일.txt'), isFalse);
      expect(host.listDirectory('lib/platform'), contains('platform.dart'));
      expect(host.listDirectory('없는-폴더'), isEmpty);
    });
  });
}
