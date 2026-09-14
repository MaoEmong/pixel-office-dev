// daemon.json 읽기. PROTOCOL: 데몬이 기동 시 `%LOCALAPPDATA%\pixel-office\daemon.json`
// (= `${PIXEL_DATA_DIR}/daemon.json`) 에 { wsPort, hookPort, token, pid, startedAt, version } 를 쓰고
// 정상 종료 시 지운다. token 은 기동마다 바뀌므로 재접속 시도마다 다시 읽는다.

import 'dart:convert';
import 'dart:io';

class DaemonInfo {
  const DaemonInfo({
    required this.wsPort,
    required this.hookPort,
    required this.token,
    required this.pid,
    required this.startedAt,
    required this.version,
  });

  final int wsPort;
  final int hookPort;
  final String token;
  final int pid;
  final String startedAt;
  final String version;

  /// 기본 WS 주소(PROTOCOL: `ws://127.0.0.1:<wsPort>`).
  Uri get wsUrl => Uri.parse('ws://127.0.0.1:$wsPort');

  factory DaemonInfo.fromJson(Map<String, dynamic> j) => DaemonInfo(
        wsPort: (j['wsPort'] as num).toInt(),
        hookPort: (j['hookPort'] as num).toInt(),
        token: j['token'] as String,
        pid: (j['pid'] as num).toInt(),
        startedAt: j['startedAt'] as String,
        version: j['version'] as String,
      );

  /// 데이터 폴더: `PIXEL_DATA_DIR` 이 있으면 그것, 아니면 `%LOCALAPPDATA%\pixel-office`.
  /// 둘 다 없으면(LOCALAPPDATA 가 없는 환경) null.
  static String? dataDir([Map<String, String>? env]) {
    final e = env ?? Platform.environment;
    final override = e['PIXEL_DATA_DIR'];
    if (override != null && override.isNotEmpty) return override;
    final local = e['LOCALAPPDATA'];
    if (local == null || local.isEmpty) return null;
    return '$local${Platform.pathSeparator}pixel-office';
  }

  static String? defaultPath([Map<String, String>? env]) {
    final dir = dataDir(env);
    return dir == null ? null : '$dir${Platform.pathSeparator}daemon.json';
  }

  /// 파일이 없거나(데몬 미기동) 깨져 있으면 null.
  static Future<DaemonInfo?> read({String? path}) async {
    final p = path ?? defaultPath();
    if (p == null) return null;
    final f = File(p);
    try {
      if (!await f.exists()) return null;
      final text = await f.readAsString();
      final j = jsonDecode(text);
      if (j is! Map) return null;
      return DaemonInfo.fromJson(Map<String, dynamic>.from(j));
    } on FormatException {
      return null;
    } on TypeError {
      return null;
    } on IOException {
      return null;
    }
  }
}
