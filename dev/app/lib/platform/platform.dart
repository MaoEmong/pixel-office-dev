// 운영체제에 닿는 코드는 **이 파일 하나**에 모인다(T48-2 · D-48 원칙 2). 나머지 코드는 여기 함수만 부른다.
//
// 왜 한곳이냐: 맥 지원을 넣기 전까지 `Platform.isWindows` 가 앱 7곳에 흩어져 있었다. 흩어진 분기는
// 맥에서 하나씩 터지고, 터지는 자리를 이 PC(윈도우)에서는 볼 수가 없다. 한곳에 모으면 **플랫폼을 주입해**
// 단위 테스트로 맥 분기를 고정할 수 있다 — 이 파일의 모든 함수는 [AppPlatform] 을 받는다.
//
// | 항목 | 윈도우 | 맥 | 리눅스 |
// |---|---|---|---|
// | 데이터 폴더 | `%LOCALAPPDATA%\pixel-office` | `$HOME/Library/Application Support/pixel-office` | `$XDG_DATA_HOME/pixel-office` 또는 `~/.local/share/pixel-office` |
// | `node` | `node`(PATH 에 맡긴다 — 오늘 그대로) | 절대 경로 탐색([findNode]) | 같음 |
// | npm | `npm.cmd` | `npm` | `npm` |
// | 생존 확인 | `tasklist /FI "PID eq N"` | `kill -0 <pid>` | 같음 |
// | 이미지 이름 | `tasklist` CSV 첫 칸 | `ps -p <pid> -o comm=` 의 basename | 같음 |
// | 트리 종료 | `taskkill /PID <pid> /T /F` | `ps -axo pid=,ppid=` 로 트리 → 아래부터 `kill -9` | 같음 |
// | 단축키 조합키 | Ctrl | Cmd([isMetaShortcuts]) | Ctrl |
//
// `PIXEL_DATA_DIR`(데이터 폴더)·`PIXEL_NODE`(node 경로)는 **데몬과 같은 이름·같은 규칙**이다
// (`dev/daemon/src/platform.ts`). 앱과 데몬이 다른 폴더를 보면 daemon.json 을 못 찾는다(T41 사고).

import 'dart:io' as io;

import 'package:flutter/foundation.dart' show TargetPlatform, defaultTargetPlatform;

/// 데이터 폴더를 통째로 바꾸는 환경변수(데몬과 공용).
const String dataDirEnvVar = 'PIXEL_DATA_DIR';

/// `node` 실행 파일 경로를 직접 지정하는 환경변수(데몬과 공용) — 맥 GUI 앱이 node 를 못 찾을 때의 탈출구.
const String nodeEnvVar = 'PIXEL_NODE';

/// 데이터 폴더 이름(모든 플랫폼 공통).
const String dataFolderName = 'pixel-office';

// ---- 프로세스 실행 ----------------------------------------------------------------------

/// [ProcessRunner] 한 번의 결과(dart:io [io.ProcessResult] 의 테스트용 축약).
class ProcessRun {
  const ProcessRun(this.exitCode, {this.stdout = '', this.stderr = ''});

  final int exitCode;
  final String stdout;
  final String stderr;

  @override
  String toString() => 'ProcessRun($exitCode, out=${stdout.trim()})';
}

/// `ps`·`kill`·`tasklist`·`taskkill` 을 부르는 통로. 테스트는 가짜 출력을 먹인다.
typedef ProcessRunner = Future<ProcessRun> Function(String executable, List<String> arguments);

// ---- 플랫폼 -----------------------------------------------------------------------------

/// 운영체제에 물어봐야 아는 것들. 진짜 구현은 [HostPlatform], 테스트는 가짜를 만든다.
abstract class AppPlatform {
  bool get isWindows;
  bool get isMacOS;
  bool get isLinux;

  /// 환경변수(윈도우에서도 대소문자를 구분하지 않는 원본을 그대로 쓴다).
  Map<String, String> get env;

  /// 홈 폴더(`HOME` · 윈도우 `USERPROFILE`). 없으면 null.
  String? get home;

  String get pathSeparator;

  /// 파일이 있는가. **실행 권한은 보지 않는다** — 못 띄우면 스폰 오류로 드러나는 게 낫다(조용히 넘기지 않는다).
  bool fileExists(String path);

  /// 폴더 안의 이름들(경로가 아니라 이름만). 폴더가 없으면 빈 목록.
  List<String> listDirectory(String path);

  ProcessRunner get runner;
}

/// dart:io 로 답하는 진짜 플랫폼.
class HostPlatform implements AppPlatform {
  const HostPlatform();

  @override
  bool get isWindows => io.Platform.isWindows;

  @override
  bool get isMacOS => io.Platform.isMacOS;

  @override
  bool get isLinux => io.Platform.isLinux;

  @override
  Map<String, String> get env => io.Platform.environment;

  @override
  String? get home {
    final e = io.Platform.environment;
    final h = io.Platform.isWindows ? e['USERPROFILE'] : e['HOME'];
    return h == null || h.isEmpty ? null : h;
  }

  @override
  String get pathSeparator => io.Platform.pathSeparator;

  @override
  bool fileExists(String path) {
    try {
      return io.File(path).existsSync();
    } catch (_) {
      return false;
    }
  }

  @override
  List<String> listDirectory(String path) {
    try {
      return io.Directory(path)
          .listSync(followLinks: false)
          .map((e) => e.path.split(RegExp(r'[\\/]')).last)
          .toList(growable: false);
    } catch (_) {
      return const [];
    }
  }

  @override
  ProcessRunner get runner => _hostRun;
}

Future<ProcessRun> _hostRun(String executable, List<String> arguments) async {
  try {
    final r = await io.Process.run(executable, arguments);
    return ProcessRun(
      r.exitCode,
      stdout: r.stdout is String ? r.stdout as String : '',
      stderr: r.stderr is String ? r.stderr as String : '',
    );
  } on io.ProcessException catch (e) {
    // 실행 파일 자체가 없다(`ps` 가 없는 환경) — "모르겠다" 를 실패로 돌려준다.
    return ProcessRun(-1, stderr: e.message);
  }
}

/// 지금 쓰는 플랫폼. **테스트만** 갈아끼운다(`setUp`/`addTearDown` 으로 되돌릴 것).
AppPlatform currentPlatform = const HostPlatform();

/// 단축키 조합키가 Cmd 인가(맥) — 나머지 플랫폼은 Ctrl.
///
/// 여기만 [defaultTargetPlatform] 을 쓴다: 키보드는 **Flutter 가 보는 플랫폼**이 기준이고, 위젯 테스트가
/// `debugDefaultTargetPlatformOverride` 로 맥을 흉내 낼 수 있어야 한다(`flutter test` 의 기본값은 android
/// 라 윈도우와 같은 Ctrl 조합이 된다 — 기존 테스트가 그대로 통과하는 이유다).
bool get isMetaShortcuts => defaultTargetPlatform == TargetPlatform.macOS;

/// 화면에 쓰는 조합키 이름 — `Cmd` 또는 `Ctrl`. 글로 쓴 키와 실제 키가 어긋나면 안 된다.
String get shortcutModifierLabel => isMetaShortcuts ? 'Cmd' : 'Ctrl';

// ---- 데이터 폴더 ------------------------------------------------------------------------

/// 앱·데몬이 함께 쓰는 데이터 폴더. 정할 수 없으면 null(`LOCALAPPDATA`·`HOME` 이 없는 환경).
///
/// 규칙은 데몬(`dev/daemon/src/platform.ts`)과 **한 글자도 다르지 않아야** 한다:
/// `PIXEL_DATA_DIR` → 윈도우 `%LOCALAPPDATA%\pixel-office` / 맥 `$HOME/Library/Application Support/pixel-office`
/// / 리눅스 `$XDG_DATA_HOME/pixel-office` 또는 `$HOME/.local/share/pixel-office`.
String? dataDir({AppPlatform? platform, Map<String, String>? env}) {
  final p = platform ?? currentPlatform;
  final e = env ?? p.env;
  final override = e[dataDirEnvVar];
  if (override != null && override.isNotEmpty) return override;
  if (p.isWindows) {
    final local = e['LOCALAPPDATA'];
    if (local == null || local.isEmpty) return null;
    return '$local${p.pathSeparator}$dataFolderName';
  }
  final home = e['HOME'];
  if (p.isMacOS) {
    if (home == null || home.isEmpty) return null;
    return '$home/Library/Application Support/$dataFolderName';
  }
  final xdg = e['XDG_DATA_HOME'];
  if (xdg != null && xdg.isNotEmpty) return '$xdg/$dataFolderName';
  if (home == null || home.isEmpty) return null;
  return '$home/.local/share/$dataFolderName';
}

/// 데이터 폴더 안의 파일 경로(`daemon.json`·`app.lock`·`app-ui.json`·`daemon.log`). 폴더를 못 정하면 null.
String? dataFilePath(String name, {AppPlatform? platform, Map<String, String>? env}) {
  final p = platform ?? currentPlatform;
  final dir = dataDir(platform: p, env: env);
  return dir == null ? null : '$dir${p.pathSeparator}$name';
}

/// 데이터 폴더를 정하는 데 쓰는 환경변수 이름(진단 문구용) — 윈도우 `LOCALAPPDATA`, 그 밖에는 `HOME`.
String dataDirEnvName({AppPlatform? platform}) => (platform ?? currentPlatform).isWindows ? 'LOCALAPPDATA' : 'HOME';

// ---- 실행 파일 --------------------------------------------------------------------------

/// npm 실행 파일 — 윈도우는 `npm.cmd`(PATH 의 `npm` 은 셸 스크립트라 CreateProcess 가 못 띄운다), 유닉스는 `npm`.
String npmExecutable({AppPlatform? platform}) => (platform ?? currentPlatform).isWindows ? 'npm.cmd' : 'npm';

/// PATH 에서 [name] 을 찾을 때 쓰는 구분자.
String _pathListSeparator(AppPlatform p) => p.isWindows ? ';' : ':';

/// `node` 실행 파일. 못 찾으면 **null** — 부른 쪽이 실패 화면으로 알린다([nodeNotFoundMessage]).
///
/// 맥 GUI 앱(Finder 에서 더블클릭)은 **터미널의 PATH 를 물려받지 않는다**(launchd 의 최소 PATH:
/// `/usr/bin:/bin:/usr/sbin:/sbin`). Homebrew·nvm·volta 로 넣은 node 는 거기 없다 → 절대 경로로 찾는다.
/// 순서: `PIXEL_NODE` → PATH → `/opt/homebrew/bin` → `/usr/local/bin` → `~/.nvm/versions/node/*`(최신) → `~/.volta/bin`.
///
/// 윈도우는 **오늘 그대로** `'node'` 를 돌려준다(CreateProcess 가 PATH 에서 `node.exe` 를 찾는다).
String? findNode({AppPlatform? platform}) {
  final p = platform ?? currentPlatform;
  // 사용자가 지정했으면 그대로 쓴다 — 틀렸으면 스폰 오류로 드러나는 게 조용히 다른 node 를 쓰는 것보다 낫다.
  final explicit = p.env[nodeEnvVar];
  if (explicit != null && explicit.isNotEmpty) return explicit;
  if (p.isWindows) return 'node';

  for (final dir in (p.env['PATH'] ?? '').split(_pathListSeparator(p))) {
    if (dir.isEmpty) continue;
    final candidate = '${dir.endsWith('/') ? dir.substring(0, dir.length - 1) : dir}/node';
    if (p.fileExists(candidate)) return candidate;
  }
  for (final candidate in const ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    if (p.fileExists(candidate)) return candidate;
  }
  final home = p.home;
  if (home == null || home.isEmpty) return null;
  final nvmRoot = '$home/.nvm/versions/node';
  final versions = p.listDirectory(nvmRoot).toList()..sort(compareNodeVersionDesc);
  for (final v in versions) {
    final candidate = '$nvmRoot/$v/bin/node';
    if (p.fileExists(candidate)) return candidate;
  }
  final volta = '$home/.volta/bin/node';
  if (p.fileExists(volta)) return volta;
  return null;
}

/// node 를 못 찾았을 때 실패 화면에 그대로 나가는 문장(D-48 ③).
const String nodeNotFoundMessage = 'node 를 찾지 못했습니다 — Homebrew 로 설치하거나 PIXEL_NODE 로 경로를 지정하세요';

/// nvm 버전 폴더 이름 비교 — **내림차순**(`v22.14.0` 이 `v22.9.1` 보다 앞). 숫자 조각만 본다.
int compareNodeVersionDesc(String a, String b) {
  List<int> parts(String s) => s
      .replaceFirst(RegExp('^v'), '')
      .split(RegExp(r'[.\-+]'))
      .map((x) => int.tryParse(x) ?? -1)
      .toList(growable: false);
  final pa = parts(a);
  final pb = parts(b);
  for (var i = 0; i < (pa.length > pb.length ? pa.length : pb.length); i++) {
    final x = i < pa.length ? pa[i] : -1;
    final y = i < pb.length ? pb[i] : -1;
    if (x != y) return y.compareTo(x);
  }
  return b.compareTo(a);
}

// ---- 프로세스 생존 · 이미지 이름 · 트리 종료 ----------------------------------------------

/// pid 가 살아 있는가. [imageContains] 를 주면 **이미지 이름까지** 맞아야 참이다(pid 재사용 오판 방지, D-17).
///
/// 윈도우 `tasklist /FI "PID eq N" /NH /FO CSV`(실측 ~95ms, 콘솔 창 없음) · 유닉스 `kill -0 <pid>`
/// (exit 0 = 살아 있음, `Operation not permitted` = 남의 프로세스지만 **살아 있다**).
Future<bool> isProcessAlive(int pid, {String? imageContains, AppPlatform? platform}) async {
  if (pid <= 0) return false;
  final p = platform ?? currentPlatform;
  try {
    if (p.isWindows) {
      final r = await p.runner('tasklist', ['/FI', 'PID eq $pid', '/NH', '/FO', 'CSV']);
      final out = r.stdout.trim();
      // 살아 있으면 `"image.exe","1234",...`, 없으면 `INFO: No tasks are running ...`.
      if (!out.startsWith('"')) return false;
      if (!out.contains('"$pid"')) return false;
      if (imageContains == null) return true;
      return out.toLowerCase().contains(imageContains.toLowerCase());
    }
    if (imageContains != null) {
      final name = await processImageName(pid, platform: p);
      if (name == null || name.isEmpty) return false;
      return name.toLowerCase().contains(imageContains.toLowerCase());
    }
    final r = await p.runner('kill', ['-0', '$pid']);
    if (r.exitCode == 0) return true;
    // EPERM: 남의 프로세스다 — 그래도 **살아 있다**(데몬 쪽 규칙과 같다).
    return r.stderr.toLowerCase().contains('not permitted');
  } catch (_) {
    return false;
  }
}

/// pid 의 실행 파일 이름(`pixel_office.exe` · `node`). 죽었거나 못 물어봤으면 null.
Future<String?> processImageName(int pid, {AppPlatform? platform}) async {
  if (pid <= 0) return null;
  final p = platform ?? currentPlatform;
  try {
    if (p.isWindows) {
      final r = await p.runner('tasklist', ['/FI', 'PID eq $pid', '/NH', '/FO', 'CSV']);
      final out = r.stdout.trim();
      if (!out.startsWith('"')) return null;
      final end = out.indexOf('"', 1);
      return end <= 1 ? null : out.substring(1, end);
    }
    final r = await p.runner('ps', ['-p', '$pid', '-o', 'comm=']);
    final out = r.stdout.trim();
    if (out.isEmpty) return null;
    // `comm=` 은 경로로 나올 수 있다(`/opt/homebrew/bin/node`) → 마지막 조각.
    return out.split('\n').first.trim().split('/').last;
  } catch (_) {
    return null;
  }
}

/// 프로세스 **트리** 강제 종료. 윈도우 `taskkill /PID <pid> /T /F`(손자까지) ·
/// 유닉스는 `ps -axo pid=,ppid=` 로 트리를 만들어 **아래(자식)부터** `kill -9`.
///
/// 맥 `ps` 에는 `--ppid` 가 없다 — 전체 목록을 한 번 읽어 부모-자식을 우리가 잇는다.
/// 아래부터 죽이는 이유: 부모를 먼저 죽이면 자식이 init(pid 1)에 입양돼 목록에서 사라진다.
Future<void> killTree(int pid, {AppPlatform? platform}) async {
  if (pid <= 0) return;
  final p = platform ?? currentPlatform;
  try {
    if (p.isWindows) {
      await p.runner('taskkill', ['/PID', '$pid', '/T', '/F']);
      return;
    }
    final r = await p.runner('ps', ['-axo', 'pid=,ppid=']);
    final order = processTreeOrder(pid, parseProcessParents(r.stdout));
    for (final target in order) {
      await p.runner('kill', ['-9', '$target']);
    }
  } catch (_) {
    // 이미 죽었으면 할 일이 없다.
  }
}

/// `ps -axo pid=,ppid=` 출력 → `{pid: ppid}`. 숫자 두 개가 아닌 줄은 버린다.
Map<int, int> parseProcessParents(String psOutput) {
  final out = <int, int>{};
  for (final line in psOutput.split('\n')) {
    final m = RegExp(r'^\s*(\d+)\s+(\d+)\s*$').firstMatch(line);
    if (m == null) continue;
    out[int.parse(m.group(1)!)] = int.parse(m.group(2)!);
  }
  return out;
}

/// [root] 의 트리를 **죽일 순서**로(자식이 먼저, 뿌리가 마지막). 자기 자신을 부모로 갖는 줄은 무시한다.
List<int> processTreeOrder(int root, Map<int, int> parents) {
  final children = <int, List<int>>{};
  parents.forEach((child, parent) {
    if (child == parent) return;
    (children[parent] ??= []).add(child);
  });
  final levels = <int>[root];
  final seen = <int>{root};
  for (var i = 0; i < levels.length; i++) {
    for (final c in children[levels[i]] ?? const <int>[]) {
      if (seen.add(c)) levels.add(c);
    }
  }
  return levels.reversed.toList(growable: false);
}
