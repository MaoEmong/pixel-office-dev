// 앱은 한 번에 하나(T46-2 · 수명주기 §1 마지막 줄).
//
// 창이 둘이면 한쪽을 닫을 때 **다른 쪽의 데몬이 죽는다** — §2 의 종료 규칙이 앱 하나를 전제하기 때문이다.
// 그래서 데이터 폴더의 `app.lock` 에 pid 를 적어 두고, 두 번째 실행은 그것을 보고 스스로 끝낸다.
//
// 잠금이 낡았는지(앱이 크래시해 파일만 남았는지)는 **pid 생존 + 이미지 이름**으로 본다. 이름까지 보는 것은
// pid 재사용 오판을 막기 위해서다(D-17 의 유령 정리와 같은 가드) — 죽은 앱의 pid 를 엉뚱한 프로세스가
// 물려받았다고 앱이 영영 안 켜지면 안 된다.

import 'dart:convert';
import 'dart:io';

import 'daemon_process.dart';
import '../platform/platform.dart' as plat;

/// 잠금 파일 이름(`<데이터 폴더>/app.lock`).
const String appLockName = 'app.lock';

/// 두 번째 실행이 보여 주는 문구(수명주기 §1).
const String alreadyRunningMessage = '픽셀 오피스가 이미 실행 중입니다';

/// 한 줄 설명 — 왜 하나만 켜는지.
const String alreadyRunningHint = '창이 둘이면 한쪽을 닫을 때 다른 쪽의 데몬까지 꺼집니다. 열려 있는 창을 쓰세요.';

/// pid 생존 확인 함수(테스트 주입용).
typedef PidAliveCheck = Future<bool> Function(int pid, {String? imageContains});

/// 이 프로세스의 pid. [AppLock] 안에서는 같은 이름의 필드에 가려 `dart:io` 의 `pid` 를 못 부른다.
int get selfPid => pid;

class AppLock {
  const AppLock({required this.path, required this.pid, required this.startedAt, required this.image});

  final String path;
  final int pid;
  final String startedAt;

  /// 잠금을 쥔 실행 파일 이름(`pixel_office.exe`). pid 재사용 가드에 쓴다.
  final String image;

  Map<String, dynamic> toJson() => {'pid': pid, 'startedAt': startedAt, 'image': image};

  static AppLock? _parse(String path, String text) {
    try {
      final j = jsonDecode(text);
      if (j is! Map) return null;
      final pid = (j['pid'] as num?)?.toInt();
      if (pid == null || pid <= 0) return null;
      return AppLock(
        path: path,
        pid: pid,
        startedAt: j['startedAt']?.toString() ?? '',
        image: j['image']?.toString() ?? '',
      );
    } catch (_) {
      return null;
    }
  }

  /// `<데이터 폴더>/app.lock`. 데이터 폴더를 정할 수 없으면 null(그땐 잠그지 않고 그냥 켠다).
  static String? defaultPath([Map<String, String>? env, plat.AppPlatform? platform]) =>
      plat.dataFilePath(appLockName, platform: platform, env: env);

  /// 지금 잠금을 쥔 쪽(파일이 없거나 깨졌으면 null).
  static Future<AppLock?> read({String? path}) async {
    final p = path ?? defaultPath();
    if (p == null) return null;
    try {
      final f = File(p);
      if (!await f.exists()) return null;
      return _parse(p, await f.readAsString());
    } catch (_) {
      return null;
    }
  }

  /// 잠금을 잡는다. **이미 살아 있는 앱이 쥐고 있으면 null** — 부른 쪽은 안내를 보이고 끝내야 한다.
  /// 죽은 pid 가 쥔 낡은 잠금은 빼앗는다.
  static Future<AppLock?> acquire({
    String? path,
    int? myPid,
    String? image,
    PidAliveCheck isAlive = isPidAlive,
    Map<String, String>? env,
  }) async {
    final p = path ?? defaultPath(env);
    // 데이터 폴더가 없는 환경에서는 잠그지 못한다 — 막는 것보다 켜지는 게 낫다.
    if (p == null) return const AppLock(path: '', pid: 0, startedAt: '', image: '');
    final me = myPid ?? selfPid;
    final img = image ?? _exeName();
    final existing = await read(path: p);
    if (existing != null && existing.pid != me) {
      // 이름을 적어 둔 잠금은 이름까지 맞아야 "살아 있다" 로 본다(pid 재사용 가드).
      final alive = await isAlive(existing.pid, imageContains: existing.image.isEmpty ? null : existing.image);
      if (alive) return null;
    }
    final lock = AppLock(path: p, pid: me, startedAt: DateTime.now().toIso8601String(), image: img);
    try {
      final f = File(p);
      await f.parent.create(recursive: true);
      await f.writeAsString(jsonEncode(lock.toJson()));
    } catch (_) {
      // 못 써도 켜는 것을 막지 않는다(잠금은 편의지 안전장치가 아니다).
    }
    return lock;
  }

  /// 내 잠금이면 지운다(정상 종료 경로).
  Future<void> release() async {
    if (path.isEmpty) return;
    try {
      final current = await AppLock.read(path: path);
      if (current == null || current.pid != pid) return;
      await File(path).delete();
    } catch (_) {
      // 남아 있어도 다음 기동이 낡은 잠금으로 보고 빼앗는다.
    }
  }

  static String _exeName() {
    try {
      return Platform.resolvedExecutable.split(RegExp(r'[\\/]')).last;
    } catch (_) {
      return '';
    }
  }

  @override
  String toString() => 'AppLock(pid=$pid image=$image at $path)';
}
