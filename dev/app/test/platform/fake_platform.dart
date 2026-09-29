// 플랫폼 주입용 가짜(T48-2 · D-48 원칙 4). 맥 분기는 이 PC(윈도우)에서 **이것으로만** 검증한다 —
// `ps`·`kill`·`tasklist` 는 부르지 않고 출력을 먹이고, 파일 시스템은 경로 집합으로 흉내 낸다.
import 'package:pixel_office/platform/platform.dart';

class FakePlatform implements AppPlatform {
  FakePlatform({
    required this.os,
    Map<String, String>? env,
    this.files = const {},
    this.dirs = const {},
    this.handler,
  }) : env = env ?? {};

  /// `'windows'` · `'macos'` · `'linux'`.
  final String os;

  @override
  final Map<String, String> env;

  /// 있다고 볼 파일 경로들.
  Set<String> files;

  /// 폴더 → 그 안의 이름들.
  Map<String, List<String>> dirs;

  /// 실행 결과를 정하는 함수(없으면 "빈 출력 + exit 1").
  ProcessRun Function(String executable, List<String> arguments)? handler;

  /// 불린 명령 전부(`['ps', '-axo', 'pid=,ppid=']` 꼴).
  final List<List<String>> calls = [];

  @override
  bool get isWindows => os == 'windows';
  @override
  bool get isMacOS => os == 'macos';
  @override
  bool get isLinux => os == 'linux';

  @override
  String? get home => isWindows ? env['USERPROFILE'] : env['HOME'];

  @override
  String get pathSeparator => isWindows ? r'\' : '/';

  @override
  bool fileExists(String path) => files.contains(path);

  @override
  List<String> listDirectory(String path) => dirs[path] ?? const [];

  @override
  ProcessRunner get runner => (executable, arguments) async {
        calls.add([executable, ...arguments]);
        return handler?.call(executable, arguments) ?? const ProcessRun(1);
      };
}

/// `kill`/`ps` 를 한 줄로 흉내 내는 가짜 유닉스 세계.
///
/// [alive] 에 든 pid 는 `kill -0` 이 0 을 돌려주고, [comm] 은 `ps -p <pid> -o comm=` 의 출력,
/// [tree] 는 `pid ppid` 목록(= `ps -axo pid=,ppid=`)이다. `kill -9` 는 [killed] 에 순서대로 쌓인다.
class FakeUnix {
  FakeUnix({this.alive = const {}, this.comm = const {}, this.tree = const {}, this.permissionDenied = const {}});

  final Set<int> alive;
  final Map<int, String> comm;

  /// pid → ppid.
  final Map<int, int> tree;

  /// `kill -0` 이 EPERM 으로 실패하는 pid(그래도 살아 있다).
  final Set<int> permissionDenied;

  final List<int> killed = [];

  ProcessRun call(String executable, List<String> arguments) {
    if (executable == 'kill' && arguments.length == 2) {
      final pid = int.parse(arguments[1]);
      if (arguments[0] == '-0') {
        if (permissionDenied.contains(pid)) return const ProcessRun(1, stderr: 'kill: Operation not permitted');
        return ProcessRun(alive.contains(pid) ? 0 : 1, stderr: alive.contains(pid) ? '' : 'No such process');
      }
      if (arguments[0] == '-9') {
        killed.add(pid);
        return const ProcessRun(0);
      }
    }
    if (executable == 'ps' && arguments.length == 4 && arguments[0] == '-p') {
      final pid = int.parse(arguments[1]);
      final name = comm[pid];
      return ProcessRun(name == null ? 1 : 0, stdout: name == null ? '' : '$name\n');
    }
    if (executable == 'ps' && arguments.first == '-axo') {
      final b = StringBuffer();
      tree.forEach((pid, ppid) => b.writeln(' ${pid.toString().padLeft(5)} ${ppid.toString().padLeft(5)}'));
      return ProcessRun(0, stdout: b.toString());
    }
    return const ProcessRun(1);
  }
}

/// 윈도우 `tasklist` 흉내 — pid → 이미지 이름.
ProcessRun fakeTasklist(Map<int, String> images, String executable, List<String> arguments) {
  if (executable == 'tasklist') {
    final m = RegExp(r'PID eq (\d+)').firstMatch(arguments.join(' '));
    final pid = m == null ? -1 : int.parse(m.group(1)!);
    final image = images[pid];
    if (image == null) return const ProcessRun(0, stdout: 'INFO: No tasks are running which match the specified criteria.');
    return ProcessRun(0, stdout: '"$image","$pid","Console","1","12,345 K"\n');
  }
  return const ProcessRun(0);
}
