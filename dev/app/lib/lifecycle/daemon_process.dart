// 데몬 자식 프로세스(T46-2, 수명주기 §1). 앱이 데몬을 **직접** 띄운다 — 콘솔 창 없이.
//
// ## 콘솔 창이 안 뜨는 이유 (윈도우 실측, T46-2)
//
// 콘솔이 **없는** 부모(= Flutter GUI 앱)에서 콘솔 앱(node.exe)을 띄울 때 새 콘솔 창이 생기는지는
// `Process.start` 의 **모드**가 정한다. 실측(부모를 `ProcessStartMode.detached` 로 띄워 콘솔 없는 상태를
// 만든 뒤 자식에서 `GetConsoleWindow()`/`IsWindowVisible()` 을 읽었다):
//
// | 모드 | 자식의 콘솔 | 창 |
// |---|---|---|
// | 기본(파이프) | 없음(hwnd 0) | **안 뜬다** ✔ |
// | `detached` / `detachedWithStdio` | 없음(hwnd 0) | 안 뜬다 |
// | `inheritStdio` | 있음 | **보이는 창이 뜬다** ✘ |
//
// 그래서 **기본 모드**로 띄우고 stdout/stderr 파이프를 [daemonLogName] 에 이어 쓴다. 파이프를 읽어야
// 하는 이유는 로그 말고도 하나 더 있다 — 아무도 안 읽는 파이프는 64KB 에서 차서 데몬이 write 에 멈춘다.
//
// 옛 "데몬 시작" 버튼(`topbar/daemon_launcher.dart`)의 `cmd /c start "" npm start` 는 **일부러**
// 보이는 콘솔 창을 띄운다(실패 화면에서 원인을 눈으로 보는 용도). 자동 기동은 이 파일 쪽이다.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../rpc/daemon_info.dart';

/// 데몬 로그 파일 이름(`<데이터 폴더>/daemon.log`).
const String daemonLogName = 'daemon.log';

/// 데몬에게 "로그는 네가 직접 이 파일에 써라" 고 알려 주는 환경변수(T46-3 실기 결함 ③).
///
/// 앱이 죽으면 이 파이프의 **읽는 쪽이 사라지고**, 그 뒤 데몬이 한 줄만 찍어도 그 write 가 영영
/// 끝나지 않아 **데몬의 이벤트 루프가 그 자리에서 멈춘다**(윈도우 실측 — `dev/daemon/src/log.ts` 머리말).
/// 그러면 설계 §3(부모가 사라지면 스스로 정리)이 통째로 죽고 `claude.exe` 가 영원히 남는다.
/// 그래서 **데몬이 파일에 직접 쓰게** 하고, 앱이 읽는 파이프에는 아무것도 흐르지 않게 한다.
/// (그래도 파이프는 계속 읽는다 — node·tsx 의 네이티브 크래시는 console 을 거치지 않고 fd 로 나온다.)
const String daemonLogEnv = 'PIXEL_DAEMON_LOG';

/// 로그 보관 상한(수명주기 §1 "최근 1MB 만 유지"). 기동 때 이 크기로 잘라 내고 이어 쓴다.
const int daemonLogMaxBytes = 1024 * 1024;

/// 실패 화면에 보여 주는 로그 꼬리 줄 수(수명주기 §1).
const int daemonLogTailLines = 8;

/// 데몬 폴더를 못 찾았을 때.
class DaemonSpawnException implements Exception {
  const DaemonSpawnException(this.message);
  final String message;

  @override
  String toString() => message;
}

// ---- 실행 명령 -------------------------------------------------------------------------

/// 실제로 CreateProcess 에 넘길 실행 파일 + 인자.
class DaemonCommand {
  const DaemonCommand(this.executable, this.arguments);

  final String executable;
  final List<String> arguments;

  @override
  String toString() => '$executable ${arguments.join(' ')}';

  @override
  bool operator ==(Object other) =>
      other is DaemonCommand &&
      other.executable == executable &&
      other.arguments.length == arguments.length &&
      List.generate(arguments.length, (i) => arguments[i] == other.arguments[i]).every((b) => b);

  @override
  int get hashCode => Object.hash(executable, Object.hashAll(arguments));
}

/// `dev/daemon/package.json` 의 `scripts.start` 를 **npm 을 끼지 않고** 그대로 하는 명령으로 바꾼다.
///
/// 지금 저장소의 start 는 `tsx src/index.ts` 다. `tsx <파일>` 은 `node --import tsx <파일>` 과 같은 일을
/// 하고(같은 package.json 의 test 스크립트가 이미 `node --import tsx` 를 쓴다), 이렇게 띄우면
/// **프로세스가 하나**라 종료·트리 kill 이 단순하다(npm → node 2단이 아니다).
/// 모양이 다르면 npm 으로 떨어진다 — 윈도우에서는 `npm.cmd`(PATH 의 `npm` 은 셸 스크립트다).
DaemonCommand daemonCommandFor(String? startScript, {bool windows = true}) {
  final script = (startScript ?? '').trim();
  final parts = script.isEmpty ? const <String>[] : script.split(RegExp(r'\s+'));
  if (parts.isNotEmpty) {
    if (parts.first == 'node') return DaemonCommand('node', parts.sublist(1));
    if (parts.first == 'tsx') return DaemonCommand('node', ['--import', 'tsx', ...parts.sublist(1)]);
  }
  return DaemonCommand(windows ? 'npm.cmd' : 'npm', const ['start']);
}

/// `<daemonDir>/package.json` 에서 start 스크립트를 읽는다(없거나 깨졌으면 null).
Future<String?> readStartScript(Directory daemonDir) async {
  try {
    final f = File('${daemonDir.path}${Platform.pathSeparator}package.json');
    if (!await f.exists()) return null;
    final j = jsonDecode(await f.readAsString());
    if (j is! Map) return null;
    final scripts = j['scripts'];
    if (scripts is! Map) return null;
    final start = scripts['start'];
    return start is String ? start : null;
  } catch (_) {
    return null;
  }
}

// ---- 프로세스 추상 ----------------------------------------------------------------------

/// 감시자가 들고 있는 데몬 프로세스 하나. 테스트는 이 인터페이스를 가짜로 만든다.
abstract class DaemonProcess {
  int get pid;

  /// 종료 코드(살아 있는 동안 완료되지 않는다).
  Future<int> get exitCode;

  /// 프로세스 **트리**를 강제 종료한다(`taskkill /PID <pid> /T /F`).
  Future<void> killTree();
}

/// 데몬을 띄우는 함수. [extraEnv] 는 부모 환경에 **덧붙인다**(`PIXEL_PARENT_PID` 등).
typedef DaemonSpawner = Future<DaemonProcess> Function(Map<String, String> extraEnv);

/// dart:io [Process] 를 감싼 실제 데몬 프로세스.
class _RealDaemonProcess implements DaemonProcess {
  _RealDaemonProcess(this._proc, this._logSink, this._done);

  final Process _proc;
  final IOSink? _logSink;
  final Future<void> _done;

  @override
  int get pid => _proc.pid;

  @override
  Future<int> get exitCode => _proc.exitCode.whenComplete(() async {
        try {
          await _done;
          await _logSink?.flush();
          await _logSink?.close();
        } catch (_) {
          // 로그 닫기 실패로 종료 처리가 막히면 안 된다.
        }
      });

  @override
  Future<void> killTree() => killProcessTree(pid);
}

/// `dev/daemon` 을 찾아 [daemonCommandFor] 로 띄우고 stdout/stderr 를 `daemon.log` 에 이어 쓴다.
///
/// [daemonDir] 를 안 주면 호출자가 `findDaemonDir()` 로 찾아 넘겨야 한다(이 파일은 탐색을 하지 않는다 —
/// 탐색은 T14 의 `topbar/daemon_launcher.dart` 에 이미 있다).
Future<DaemonProcess> spawnDaemon({
  required Directory daemonDir,
  Map<String, String> extraEnv = const {},
  String? logPath,
}) async {
  final start = await readStartScript(daemonDir);
  final cmd = daemonCommandFor(start, windows: Platform.isWindows);
  final path = logPath ?? defaultDaemonLogPath();
  IOSink? sink;
  if (path != null) {
    try {
      await trimLogFile(File(path), daemonLogMaxBytes);
      sink = File(path).openWrite(mode: FileMode.append);
      sink.writeln('\n[app] --- ${DateTime.now().toIso8601String()} 앱이 데몬을 띄움: $cmd (cwd ${daemonDir.path}) ---');
    } catch (_) {
      sink = null; // 로그를 못 열어도 데몬은 띄운다.
    }
  }
  final env = {
    ...extraEnv,
    // 데몬이 자기 로그를 직접 파일에 쓴다(위 [daemonLogEnv] 주석 — 앱이 죽어도 데몬이 안 멈추고,
    // 앱이 죽은 **뒤의** 로그도 남는다). 로그 파일을 못 정했으면 안 넘긴다(데몬은 예전처럼 stdout).
    daemonLogEnv: ?path,
  };
  final Process proc;
  try {
    proc = await Process.start(
      cmd.executable,
      cmd.arguments,
      workingDirectory: daemonDir.path,
      environment: env,
      // 기본 모드(파이프) — 콘솔 창이 뜨지 않는 유일한 모드이면서 로그를 받을 수 있다(파일 머리 표 참고).
    );
  } on ProcessException catch (e) {
    await sink?.close();
    throw DaemonSpawnException('데몬 실행 실패(${cmd.executable}): ${e.message}');
  }
  final done = sink == null
      ? Future<void>.value()
      : Future.wait([
          proc.stdout.transform(const Utf8Decoder(allowMalformed: true)).forEach(sink.write),
          proc.stderr.transform(const Utf8Decoder(allowMalformed: true)).forEach(sink.write),
        ]).then((_) {});
  return _RealDaemonProcess(proc, sink, done);
}

// ---- 로그 -------------------------------------------------------------------------------

/// `<데이터 폴더>/daemon.log`. 데이터 폴더를 못 정하면 null.
String? defaultDaemonLogPath([Map<String, String>? env]) {
  final dir = DaemonInfo.dataDir(env);
  return dir == null ? null : '$dir${Platform.pathSeparator}$daemonLogName';
}

/// 파일이 [maxBytes] 보다 크면 **뒤쪽 [maxBytes] 만** 남긴다(잘린 첫 줄은 버린다). 폴더가 없으면 만든다.
Future<void> trimLogFile(File f, int maxBytes) async {
  try {
    await f.parent.create(recursive: true);
    if (!await f.exists()) return;
    final len = await f.length();
    if (len <= maxBytes) return;
    final raf = await f.open();
    try {
      await raf.setPosition(len - maxBytes);
      final bytes = await raf.read(maxBytes);
      final nl = bytes.indexOf(0x0a);
      await f.writeAsBytes(nl >= 0 && nl + 1 < bytes.length ? bytes.sublist(nl + 1) : bytes);
    } finally {
      await raf.close();
    }
  } catch (_) {
    // 자르기 실패로 기동을 막지 않는다.
  }
}

/// 로그 마지막 [lines] 줄(빈 줄 제외). 파일이 없으면 빈 목록.
Future<List<String>> readLogTail(String? path, {int lines = daemonLogTailLines}) async {
  if (path == null) return const [];
  try {
    final f = File(path);
    if (!await f.exists()) return const [];
    final len = await f.length();
    // 꼬리 몇 줄만 필요하다 — 통째로 읽지 않는다.
    const window = 64 * 1024;
    final raf = await f.open();
    List<int> bytes;
    try {
      if (len > window) await raf.setPosition(len - window);
      bytes = await raf.read(len > window ? window : len);
    } finally {
      await raf.close();
    }
    final text = const Utf8Decoder(allowMalformed: true).convert(bytes);
    final all = text.split('\n').map((l) => l.trimRight()).where((l) => l.isNotEmpty).toList();
    return all.length <= lines ? all : all.sublist(all.length - lines);
  } catch (_) {
    return const [];
  }
}

// ---- pid 생존 · 트리 종료 ---------------------------------------------------------------

/// pid 가 살아 있는가 — `tasklist /FI "PID eq N" /NH /FO CSV`(실측 ~95ms, 콘솔 창 없음).
/// [imageContains] 를 주면 **이미지 이름까지** 맞아야 참이다(pid 재사용 오판 방지, D-17 과 같은 가드).
Future<bool> isPidAlive(int pid, {String? imageContains}) async {
  if (pid <= 0) return false;
  try {
    if (!Platform.isWindows) {
      // 개발용 폴백 — 윈도우 앱이지만 단위 테스트가 다른 OS 에서 돌 수 있다.
      final r = await Process.run('ps', ['-p', '$pid', '-o', 'comm=']);
      final out = (r.stdout as String).trim();
      if (out.isEmpty) return false;
      return imageContains == null || out.toLowerCase().contains(imageContains.toLowerCase());
    }
    final r = await Process.run('tasklist', ['/FI', 'PID eq $pid', '/NH', '/FO', 'CSV']);
    final out = (r.stdout as String).trim();
    // 살아 있으면 `"image.exe","1234",...`, 없으면 `INFO: No tasks are running ...`.
    if (!out.startsWith('"')) return false;
    if (!out.contains('"$pid"')) return false;
    if (imageContains == null) return true;
    return out.toLowerCase().contains(imageContains.toLowerCase());
  } catch (_) {
    return false;
  }
}

/// 프로세스 트리 강제 종료(`taskkill /PID <pid> /T /F` — 실측 ~120ms, 손자까지 간다).
Future<void> killProcessTree(int pid) async {
  if (pid <= 0) return;
  try {
    if (Platform.isWindows) {
      await Process.run('taskkill', ['/PID', '$pid', '/T', '/F']);
    } else {
      Process.killPid(pid, ProcessSignal.sigkill);
    }
  } catch (_) {
    // 이미 죽었으면 할 일이 없다.
  }
}

/// 붙을 수 있는 데몬이 도는가 = `daemon.json` 이 있고 그 pid 가 살아 있다.
/// 파일만 있고 프로세스가 죽었으면(하드 킬 뒤 남은 파일) **거짓**이다 — 감시자가 죽음을 알아채는 기준이다.
Future<bool> daemonReachable({String? daemonJsonPath}) async {
  final info = await DaemonInfo.read(path: daemonJsonPath);
  if (info == null) return false;
  return isPidAlive(info.pid);
}
