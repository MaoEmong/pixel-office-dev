// 데몬 감시자(T46-2 · D-47 · 수명주기 §1 · §4). 앱이 주인이다 — 데몬이 없으면 띄우고, 죽으면 다시 띄운다.
//
//   attaching ──(2초 안에 붙을 곳이 있다)──▶ running(붙음)
//       │
//       └──(없다)──▶ starting ──(readyTimeout 안에 뜬다)──▶ running(직접 띄움)
//                        └──(못 뜬다 · 스폰 실패)──▶ failed(startFailed)
//
//   running ──(자식 종료 · 소켓 끊김 + daemon.json pid 죽음)──▶ restarting
//       restarting: 즉시 → 2초 → 5초 → 10초, **최대 4회**
//           성공 ──▶ running / 4회 다 실패 ──▶ failed(startFailed)
//       1분 안에 3번 죽었다 ──▶ failed(crashLoop)  "데몬이 반복해서 종료됩니다"
//
//   stop() ──▶ stopped (앱 종료 경로가 부른다 — 이 뒤의 죽음은 재시작하지 않는다)
//
// 시계·대기·스폰·생존 확인을 전부 주입받는다. 그래서 이 파일은 `dart:io` 를 쓰지 않고 단위 테스트에서
// 가짜 시계로 재시작 일정(0·2·5·10초)과 1분 3회 규칙을 그대로 볼 수 있다.

import 'dart:async';

import 'daemon_process.dart';

enum SupervisorState {
  /// 이미 도는 데몬이 있는지 2초 동안 본다.
  attaching,

  /// 앱이 데몬을 띄우고 뜨기를 기다린다.
  starting,

  /// 붙을 수 있는 데몬이 있다(직접 띄웠거나 붙었거나).
  running,

  /// 죽었다 — 일정에 따라 다시 띄우는 중.
  restarting,

  /// 포기했다(실패 화면).
  failed,

  /// 앱이 끄는 중이거나 껐다.
  stopped,
}

/// 실패 화면의 두 문장 중 어느 쪽인가.
enum SupervisorFailure {
  /// `데몬을 시작하지 못했습니다` — 못 띄웠거나 떴는데 붙을 수 없다.
  startFailed,

  /// `데몬이 반복해서 종료됩니다` — 1분 안에 [DaemonSupervisor.crashLimit] 번 죽었다(원인을 덮지 않는다).
  crashLoop,
}

class SupervisorStatus {
  const SupervisorStatus({
    required this.state,
    this.failure,
    this.restartAttempt = 0,
    this.deaths = 0,
    this.spawned = false,
    this.pid,
    this.lastError,
  });

  final SupervisorState state;

  /// [SupervisorState.failed] 일 때만 채워진다.
  final SupervisorFailure? failure;

  /// 지금 몇 번째 재시작 시도인가(1부터, 아니면 0).
  final int restartAttempt;

  /// 최근 [DaemonSupervisor.crashWindow] 안에 센 죽음 수.
  final int deaths;

  /// 지금 붙어 있는 데몬을 **앱이 직접 띄웠는가**(false = 콘솔에서 띄운 것에 붙음).
  final bool spawned;

  /// 앱이 띄운 자식의 pid(안 띄웠으면 null).
  final int? pid;

  /// 마지막 실패 원인(사람이 읽는 문자열).
  final String? lastError;

  bool get isRunning => state == SupervisorState.running;
  bool get isFailed => state == SupervisorState.failed;

  /// 아직 처음 여는 중인가(오버레이 `사무실을 여는 중…`).
  bool get isOpening => state == SupervisorState.attaching || state == SupervisorState.starting;

  SupervisorStatus copyWith({
    SupervisorState? state,
    SupervisorFailure? failure,
    bool clearFailure = false,
    int? restartAttempt,
    int? deaths,
    bool? spawned,
    int? pid,
    bool clearPid = false,
    String? lastError,
    bool clearError = false,
  }) =>
      SupervisorStatus(
        state: state ?? this.state,
        failure: clearFailure ? null : (failure ?? this.failure),
        restartAttempt: restartAttempt ?? this.restartAttempt,
        deaths: deaths ?? this.deaths,
        spawned: spawned ?? this.spawned,
        pid: clearPid ? null : (pid ?? this.pid),
        lastError: clearError ? null : (lastError ?? this.lastError),
      );

  @override
  String toString() => 'SupervisorStatus(${state.name}${failure == null ? '' : '/${failure!.name}'}'
      '${restartAttempt > 0 ? ' 시도 $restartAttempt' : ''}${spawned ? ' spawned pid=$pid' : ''})';
}

/// 재시작 간격(수명주기 §4: 즉시 1회 → 2초 → 5초 → 10초, 최대 4회).
const List<Duration> defaultRestartDelays = [
  Duration.zero,
  Duration(seconds: 2),
  Duration(seconds: 5),
  Duration(seconds: 10),
];

class DaemonSupervisor {
  DaemonSupervisor({
    required this.spawn,
    required this.probe,
    Future<void> Function(Duration)? sleep,
    DateTime Function()? now,
    this.parentPid,
    this.attachTimeout = const Duration(seconds: 2),
    this.readyTimeout = const Duration(seconds: 8),
    this.pollInterval = const Duration(milliseconds: 250),
    this.restartDelays = defaultRestartDelays,
    this.crashWindow = const Duration(seconds: 60),
    this.crashLimit = 3,
  })  : _sleep = sleep ?? Future<void>.delayed,
        _now = now ?? DateTime.now;

  /// 데몬 한 번 띄우기.
  final DaemonSpawner spawn;

  /// 붙을 수 있는 데몬이 있는가(`daemon.json` + pid 생존 — [daemonReachable]).
  final Future<bool> Function() probe;

  final Future<void> Function(Duration) _sleep;
  final DateTime Function() _now;

  /// 데몬에 넘길 `PIXEL_PARENT_PID`. **null 이면 안 넘긴다** — 설정 "앱을 닫아도 계속 일하기"
  /// 또는 `PIXEL_KEEP_DAEMON=1` 일 때(수명주기 §2·§3: 부모 감시를 하지 않는다).
  final int? parentPid;

  /// 이미 도는 데몬을 찾아보는 시간(§1: 2초).
  final Duration attachTimeout;

  /// 띄운 데몬이 `daemon.json` 을 쓸 때까지 기다리는 시간(§1: 2 + 8 = 10초 안에 못 붙으면 실패 화면).
  final Duration readyTimeout;

  /// [probe] 를 다시 물어보는 주기.
  final Duration pollInterval;

  /// 재시작 간격표(길이 = 최대 재시작 횟수).
  final List<Duration> restartDelays;

  /// "1분 안에 [crashLimit] 번" 의 1분.
  final Duration crashWindow;

  /// 재시작을 포기하는 죽음 횟수.
  final int crashLimit;

  SupervisorStatus _status = const SupervisorStatus(state: SupervisorState.attaching);
  final _ctl = StreamController<SupervisorStatus>.broadcast();
  final List<DateTime> _deaths = [];

  DaemonProcess? _child;
  bool _stopped = false;
  bool _busy = false;

  /// **포기했다**(실패 화면을 띄웠다). [retry] 만 이것을 푼다.
  ///
  /// T46-3 실기 결함 ④: 이 깃발이 없으면 `데몬이 반복해서 종료됩니다` 가 화면에 뜨지 못한다.
  /// 죽음이 재시작 일정 **도중에** 오면(실기에서는 1.5초·11.9초 간격이었다) `_onDeath` 는 `_busy`
  /// 때문에 새 루프를 못 열고 죽음만 센다. 그러다 3번째에 [_fail] 이 `crashLoop` 로 바꿔 놓아도
  /// **앞선 `_restartLoop` 가 아직 돌고 있어서** 다음 칸에서 `restarting` 을 다시 emit 하고 데몬을
  /// 또 띄운다 — 실기에서 3번째 죽음 36초 뒤에 4번째 데몬이 떴다(원인을 덮지 않겠다는 §4 가 무의미해진다).
  bool _abandoned = false;

  SupervisorStatus get status => _status;
  Stream<SupervisorStatus> get statusStream => _ctl.stream;

  /// 앱이 직접 띄운 자식(없으면 null). 종료 흐름이 트리 kill 에 쓴다.
  DaemonProcess? get child => _child;

  /// 데몬에 넘길 추가 환경변수.
  Map<String, String> get spawnEnv => parentPid == null ? const {} : {'PIXEL_PARENT_PID': '$parentPid'};

  void _emit(SupervisorStatus s) {
    _status = s;
    if (!_ctl.isClosed) _ctl.add(s);
  }

  // ---- 기동 -----------------------------------------------------------------------------

  /// §1 의 기동 순서. 이미 돌고 있으면 두 번 부르지 않는다.
  Future<void> start() async {
    if (_busy || _stopped) return;
    _busy = true;
    try {
      _emit(const SupervisorStatus(state: SupervisorState.attaching));
      if (await _waitReachable(attachTimeout)) {
        _running(spawned: false, pid: null);
        return;
      }
      await _spawnOnce(attempt: 0);
    } finally {
      _busy = false;
    }
  }

  /// 실패 화면의 `다시 시도`. 죽음 기록까지 지우고 처음부터 다시 한다(사용자가 원인을 봤다는 뜻이다).
  Future<void> retry() async {
    if (_busy) return;
    _stopped = false;
    _abandoned = false;
    _deaths.clear();
    await start();
  }

  /// 한 번 띄우고 뜨기를 기다린다. 성공하면 running, 실패하면 false.
  Future<bool> _spawnOnce({required int attempt}) async {
    _emit(_status.copyWith(
      state: attempt == 0 ? SupervisorState.starting : SupervisorState.restarting,
      restartAttempt: attempt,
      clearFailure: true,
      clearError: true,
    ));
    final DaemonProcess proc;
    try {
      proc = await spawn(spawnEnv);
    } catch (e) {
      _emit(_status.copyWith(lastError: e.toString()));
      if (attempt == 0) _fail(SupervisorFailure.startFailed, e.toString());
      return false;
    }
    // 스폰하는 사이에 포기가 결정됐으면(다른 죽음이 crash-loop 을 확정) 그 자식을 두고 가지 않는다.
    if (_stopped || _abandoned) {
      await proc.killTree();
      return false;
    }
    // **붙기 전에 죽는 것도 지켜본다**(T46-3 실기 결함 ④). `_watchChild` 는 붙은 **뒤에야** 달리므로,
    // 띄우자마자 죽은 데몬은 예전에 죽음으로 세어지지 않았다 — 그런데 그게 바로 crash-loop 의 모양이다.
    int? earlyExitCode;
    unawaited(proc.exitCode.then((code) => earlyExitCode = code).catchError((Object _) => -1));
    if (await _waitReachable(readyTimeout)) {
      _child = proc;
      _watchChild(proc);
      _running(spawned: true, pid: proc.pid);
      return true;
    }
    // 못 붙었다. **치우기 전에** 판정한다 — `killTree()` 자체가 exitCode 를 채우므로 뒤에 보면 늘 "죽었다" 가 된다.
    final died = earlyExitCode != null;
    final code = earlyExitCode;
    await proc.killTree();
    final msg = died
        ? '띄운 데몬이 붙기 전에 종료됨 (code $code)'
        : '데몬이 떴지만 daemon.json 이 나타나지 않았습니다 (포트 충돌일 수 있습니다)';
    _emit(_status.copyWith(lastError: msg));
    if (attempt == 0) {
      _fail(SupervisorFailure.startFailed, msg);
      return false;
    }
    // 재시작 도중에 **또** 곧바로 죽었으면 그것도 죽음으로 센다 — 1분에 3번이면 여기서 포기한다.
    // (못 뜬 것(daemon.json 없음)은 죽음이 아니라 "시작 실패" 쪽이라 세지 않는다 — 문구가 다르다.)
    if (died) _countDeath(msg);
    return false;
  }

  void _running({required bool spawned, int? pid}) {
    _emit(_status.copyWith(
      state: SupervisorState.running,
      restartAttempt: 0,
      spawned: spawned,
      pid: pid,
      clearPid: pid == null,
      clearFailure: true,
    ));
  }

  void _fail(SupervisorFailure failure, String? error) {
    _child = null;
    _abandoned = true;
    _emit(_status.copyWith(
      state: SupervisorState.failed,
      failure: failure,
      spawned: false,
      clearPid: true,
      lastError: error,
    ));
  }

  /// [budget] 동안 [pollInterval] 마다 [probe] 를 묻는다. 한 번이라도 참이면 즉시 true.
  Future<bool> _waitReachable(Duration budget) async {
    final deadline = _now().add(budget);
    while (!_stopped && !_abandoned) {
      if (await probe()) return true;
      if (!_now().isBefore(deadline)) return false;
      await _sleep(pollInterval);
    }
    return false;
  }

  // ---- 죽음 감지 ------------------------------------------------------------------------

  void _watchChild(DaemonProcess proc) {
    unawaited(proc.exitCode.then((code) {
      if (_stopped || !identical(_child, proc)) return;
      _child = null;
      unawaited(_onDeath('데몬 프로세스가 종료됨 (code $code)'));
    }).catchError((Object _) {}));
  }

  /// 소켓이 끊겼다고 앱이 알려 준다(§4: 붙기만 한 데몬의 죽음은 이 길로만 알 수 있다).
  /// `daemon.json` 의 pid 가 아직 살아 있으면 **일시적 끊김**으로 보고 아무것도 하지 않는다.
  Future<void> socketClosed() async {
    if (_stopped || _status.state != SupervisorState.running) return;
    if (await probe()) return;
    if (_stopped || _status.state != SupervisorState.running) return;
    final dead = _child;
    _child = null;
    if (dead != null) unawaited(dead.killTree());
    await _onDeath('소켓이 끊기고 daemon.json 의 pid 가 살아 있지 않음');
  }

  Future<void> _onDeath(String reason) async {
    if (_stopped || _abandoned) return;
    if (_countDeath(reason)) return;
    await _restartLoop();
  }

  /// 죽음 하나를 세고 `crashWindow` 밖은 버린다. 1분 안에 [crashLimit] 번이면 **포기**하고 true.
  bool _countDeath(String reason) {
    final t = _now();
    _deaths.add(t);
    _deaths.removeWhere((d) => t.difference(d) > crashWindow);
    _emit(_status.copyWith(deaths: _deaths.length, lastError: reason, spawned: false, clearPid: true));
    if (_deaths.length >= crashLimit) {
      _fail(SupervisorFailure.crashLoop, reason);
      return true;
    }
    return false;
  }

  /// 즉시 → 2초 → 5초 → 10초, 최대 [restartDelays].length 회.
  Future<void> _restartLoop() async {
    if (_busy) return;
    _busy = true;
    try {
      for (var i = 0; i < restartDelays.length; i++) {
        // `_abandoned` 도 같이 본다 — 이 루프가 자는 동안 다른 죽음이 crash-loop 을 확정했을 수 있다.
        if (_stopped || _abandoned) return;
        _emit(_status.copyWith(state: SupervisorState.restarting, restartAttempt: i + 1));
        if (restartDelays[i] > Duration.zero) await _sleep(restartDelays[i]);
        if (_stopped || _abandoned) return;
        // 그 사이 누가(콘솔에서) 띄웠으면 새로 띄우지 않고 붙는다.
        if (await probe()) {
          _running(spawned: false, pid: null);
          return;
        }
        if (await _spawnOnce(attempt: i + 1)) return;
      }
      _fail(SupervisorFailure.startFailed, _status.lastError);
    } finally {
      _busy = false;
    }
  }

  // ---- 정지 -----------------------------------------------------------------------------

  /// 감시를 멈춘다(이 뒤의 죽음은 재시작하지 않는다). [killChild] 면 앱이 띄운 자식 트리도 끝낸다.
  Future<void> stop({bool killChild = false}) async {
    _stopped = true;
    final proc = _child;
    _child = null;
    _emit(_status.copyWith(state: SupervisorState.stopped, restartAttempt: 0, clearFailure: true));
    if (killChild && proc != null) await proc.killTree();
  }

  Future<void> dispose() async {
    _stopped = true;
    await _ctl.close();
  }
}
