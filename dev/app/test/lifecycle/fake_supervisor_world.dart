// DaemonSupervisor 단위 테스트용 가짜 세계: 시계·대기·스폰·생존 확인을 전부 손으로 돌린다.
// 실제 시간이 흐르지 않으므로 재시작 일정(즉시·2·5·10초)과 "1분 안에 3번" 규칙을 눈으로 볼 수 있다.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/lifecycle/daemon_process.dart';
import 'package:pixel_office/lifecycle/daemon_supervisor.dart';

/// 가짜 자식 프로세스.
class FakeDaemonProcess implements DaemonProcess {
  FakeDaemonProcess(this.pid, this._world);

  @override
  final int pid;

  final FakeSupervisorWorld _world;
  final Completer<int> _exit = Completer<int>();
  bool killed = false;

  @override
  Future<int> get exitCode => _exit.future;

  @override
  Future<void> killTree() async {
    killed = true;
    _world.reachable = false;
    if (!_exit.isCompleted) _exit.complete(-1);
  }

  /// 데몬이 갑자기 죽었다.
  void die([int code = 1]) {
    _world.reachable = false;
    if (!_exit.isCompleted) _exit.complete(code);
  }
}

class FakeSupervisorWorld {
  FakeSupervisorWorld({this.reachable = false, this.spawnBecomesReachable = true, this.spawnThrows});

  /// 지금 붙을 수 있는 데몬이 있는가(= daemon.json + pid 생존).
  bool reachable;

  /// 스폰한 데몬이 곧바로 붙을 수 있게 되는가(false 면 "떴는데 daemon.json 이 안 생김").
  bool spawnBecomesReachable;

  /// 스폰이 던질 예외(있으면).
  Object? spawnThrows;

  /// 스폰 시도 때마다(성공·실패 전에) 불린다 — 테스트가 그 순간 세상을 바꿀 수 있게.
  void Function(FakeSupervisorWorld world)? onSpawnAttempt;

  /// 자식이 만들어진 **직후**(감시자에게 돌려주기 전에) 불린다. "띄우자마자 죽는 데몬" 을 만들 때 쓴다(T46-3).
  void Function(FakeDaemonProcess proc)? onSpawned;

  DateTime now = DateTime.utc(2026, 9, 21, 10);
  final List<Duration> slept = [];
  final List<Map<String, String>> spawnEnvs = [];
  final List<FakeDaemonProcess> spawned = [];
  final List<DateTime> spawnTimes = [];
  int probes = 0;
  int _nextPid = 4000;

  int get spawnCount => spawned.length;

  /// 1초 이상 잔 것만(폴링 주기를 걸러 낸 재시작 일정).
  List<Duration> get restartWaits => slept.where((d) => d >= const Duration(seconds: 1)).toList();

  Future<void> sleep(Duration d) async {
    slept.add(d);
    now = now.add(d);
    await Future<void>.delayed(Duration.zero);
  }

  Future<bool> probe() async {
    probes++;
    return reachable;
  }

  Future<DaemonProcess> spawn(Map<String, String> env) async {
    spawnEnvs.add(env);
    spawnTimes.add(now);
    onSpawnAttempt?.call(this);
    final t = spawnThrows;
    if (t != null) throw t;
    final p = FakeDaemonProcess(_nextPid++, this);
    spawned.add(p);
    if (spawnBecomesReachable) reachable = true;
    onSpawned?.call(p);
    return p;
  }

  DaemonSupervisor supervisor({
    int? parentPid,
    Duration attachTimeout = const Duration(seconds: 2),
    Duration readyTimeout = const Duration(seconds: 8),
    List<Duration> restartDelays = defaultRestartDelays,
  }) =>
      DaemonSupervisor(
        spawn: spawn,
        probe: probe,
        sleep: sleep,
        now: () => now,
        parentPid: parentPid,
        attachTimeout: attachTimeout,
        readyTimeout: readyTimeout,
        restartDelays: restartDelays,
      );
}

/// [cond] 가 참이 될 때까지 마이크로태스크를 돌린다(가짜 대기는 실제 시간을 안 쓴다).
Future<void> until(bool Function() cond, {int maxTicks = 20000, String why = ''}) async {
  for (var i = 0; i < maxTicks; i++) {
    if (cond()) return;
    await Future<void>.delayed(Duration.zero);
  }
  fail('조건이 되지 않았다${why.isEmpty ? '' : ': $why'}');
}
