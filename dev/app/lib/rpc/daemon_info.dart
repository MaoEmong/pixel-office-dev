// daemon.json 읽기. PROTOCOL: 데몬이 기동 시 `%LOCALAPPDATA%\pixel-office\daemon.json`
// (= `${PIXEL_DATA_DIR}/daemon.json`) 에 { wsPort, hookPort, token, pid, startedAt, version } 를 쓰고
// 정상 종료 시 지운다. token 은 기동마다 바뀌므로 재접속 시도마다 다시 읽는다.
//
// T41(실기 사고): 탐색기에서 띄운 앱이 `RpcException(-1: daemon.json 없음(데몬 미기동))` 만 보여 줬는데,
// 정작 파일은 **다른 환경(샌드박스)에서 띄운 프로세스의 %LOCALAPPDATA%** 에 있었다. 같은 이름의 폴더가
// 환경마다 다른 곳을 가리키면 "없다" 는 말은 아무 정보도 주지 못한다. → 오류에 **찾아본 경로와 환경변수
// 유무**를 싣는다([daemonJsonMissingMessage]).

import 'dart:convert';
import 'dart:io';

/// 끊김 오버레이의 "자세히" 에 붙는 한 줄(T41). 경로만 보여 주면 "왜 없지?" 에서 멈춘다.
const String daemonPathHint =
    "데몬을 아직 안 띄웠으면 '데몬 시작' — 다른 환경(샌드박스·다른 사용자)에서 띄운 데몬은 이 경로에 파일을 쓰지 않습니다";

/// 데이터 폴더를 정할 수조차 없을 때(둘 다 없는 환경).
const String daemonNoDataDir = 'PIXEL_DATA_DIR·LOCALAPPDATA 가 둘 다 없어 daemon.json 경로를 정할 수 없습니다';

/// daemon.json 을 못 읽었을 때 재접속 루프가 남기는 문구 — **찾아본 경로**와 환경변수 유무까지.
/// 예: `daemon.json 없음(데몬 미기동) — 찾은 곳: C:\...\pixel-office\daemon.json · PIXEL_DATA_DIR 없음 · LOCALAPPDATA 있음`
String daemonJsonMissingMessage([Map<String, String>? env]) {
  final e = env ?? Platform.environment;
  final path = DaemonInfo.defaultPath(e);
  if (path == null) return 'daemon.json 없음(데몬 미기동) — $daemonNoDataDir';
  String mark(String key) {
    final v = e[key];
    return '$key ${v == null || v.isEmpty ? '없음' : '있음'}';
  }

  return 'daemon.json 없음(데몬 미기동) — 찾은 곳: $path · ${mark('PIXEL_DATA_DIR')} · ${mark('LOCALAPPDATA')}';
}

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
