// T46-2 · 수명주기 §1 · §4: 데몬 감시자 상태 기계.
//   붙기(2초) / 직접 띄우기 / 스폰 실패 / 죽음 → 즉시·2·5·10초 재시작(최대 4회) /
//   1분 안에 3번 → crash-loop / 이미 도는 데몬 / 계속 일하기(PIXEL_PARENT_PID 안 넘김) / 종료.
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/lifecycle/daemon_process.dart';
import 'package:pixel_office/lifecycle/daemon_supervisor.dart';

import 'fake_supervisor_world.dart';

void main() {
  group('기동(§1)', () {
    test('이미 도는 데몬이 있으면 새로 띄우지 않고 붙는다', () async {
      final w = FakeSupervisorWorld(reachable: true);
      final s = w.supervisor();
      await s.start();
      expect(s.status.state, SupervisorState.running);
      expect(s.status.spawned, isFalse, reason: '앱이 띄운 것이 아니다');
      expect(s.status.pid, isNull);
      expect(w.spawnCount, 0);
      expect(w.slept, isEmpty, reason: '첫 probe 에서 바로 붙으면 기다릴 일이 없다');
    });

    test('2초 동안 못 붙으면 직접 띄운다 — attach 대기는 정확히 2초', () async {
      final w = FakeSupervisorWorld();
      final s = w.supervisor();
      await s.start();
      expect(s.status.state, SupervisorState.running);
      expect(s.status.spawned, isTrue);
      expect(s.status.pid, w.spawned.single.pid);
      expect(w.spawnCount, 1);
      // 250ms × 8 = 2초를 기다린 뒤에야 띄웠다.
      expect(w.slept.take(8), everyElement(const Duration(milliseconds: 250)));
      expect(w.spawnTimes.single.difference(DateTime.utc(2026, 9, 21, 10)), const Duration(seconds: 2));
    });

    test('앱 pid 를 PIXEL_PARENT_PID 로 넘긴다', () async {
      final w = FakeSupervisorWorld();
      final s = w.supervisor(parentPid: 777);
      await s.start();
      expect(w.spawnEnvs.single, {'PIXEL_PARENT_PID': '777'});
    });

    test('"앱을 닫아도 계속 일하기" 면 PIXEL_PARENT_PID 를 안 넘긴다(§2·§3)', () async {
      final w = FakeSupervisorWorld();
      final s = w.supervisor();
      expect(s.spawnEnv, isEmpty);
      await s.start();
      expect(w.spawnEnvs.single, isEmpty);
    });

    test('스폰이 실패하면 failed(startFailed) + 원인', () async {
      final w = FakeSupervisorWorld(spawnThrows: const DaemonSpawnException('node 를 찾을 수 없습니다'));
      final s = w.supervisor();
      await s.start();
      expect(s.status.state, SupervisorState.failed);
      expect(s.status.failure, SupervisorFailure.startFailed);
      expect(s.status.lastError, contains('node 를 찾을 수 없습니다'));
    });

    test('떴는데 daemon.json 이 안 나타나면 8초 뒤 실패 + 남은 프로세스를 치운다', () async {
      final w = FakeSupervisorWorld(spawnBecomesReachable: false);
      final s = w.supervisor();
      await s.start();
      expect(s.status.state, SupervisorState.failed);
      expect(s.status.failure, SupervisorFailure.startFailed);
      expect(s.status.lastError, contains('daemon.json'));
      expect(w.spawned.single.killed, isTrue, reason: '고아를 남기지 않는다');
    });

    test('상태 스트림: attaching → starting → running', () async {
      final w = FakeSupervisorWorld();
      final s = w.supervisor();
      final seen = <SupervisorState>[];
      s.statusStream.listen((st) => seen.add(st.state));
      await s.start();
      await until(() => seen.contains(SupervisorState.running));
      expect(seen, containsAllInOrder([SupervisorState.attaching, SupervisorState.starting, SupervisorState.running]));
    });
  });

  group('죽음과 재시작(§4)', () {
    test('자식이 죽으면 즉시 한 번 다시 띄운다', () async {
      final w = FakeSupervisorWorld();
      final s = w.supervisor();
      await s.start();
      final first = w.spawned.single;
      final beforeDeath = w.now;
      first.die();
      await until(() => w.spawnCount == 2);
      expect(s.status.state, SupervisorState.running);
      expect(w.spawnTimes.last, beforeDeath, reason: '즉시 1회 — 기다리지 않는다');
      expect(w.restartWaits, isEmpty);
    });

    test('재시작이 계속 실패하면 즉시·2초·5초·10초 4회 뒤 실패 화면', () async {
      final w = FakeSupervisorWorld();
      final s = w.supervisor();
      await s.start();
      final first = w.spawned.single;
      // 이제부터 띄워도 안 뜬다.
      w.spawnBecomesReachable = false;
      first.die();
      await until(() => s.status.state == SupervisorState.failed, why: '4회 뒤 실패');
      expect(w.spawnCount, 5, reason: '처음 1 + 재시작 4');
      expect(w.restartWaits, [
        const Duration(seconds: 2),
        const Duration(seconds: 5),
        const Duration(seconds: 10),
      ]);
      expect(s.status.failure, SupervisorFailure.startFailed);
    });

    test('1분 안에 3번 죽으면 재시작을 멈춘다(crash-loop)', () async {
      final w = FakeSupervisorWorld();
      final s = w.supervisor();
      await s.start();
      w.spawned.last.die(); // 1
      await until(() => w.spawnCount == 2);
      w.spawned.last.die(); // 2
      await until(() => w.spawnCount == 3);
      w.spawned.last.die(); // 3
      await until(() => s.status.state == SupervisorState.failed);
      expect(s.status.failure, SupervisorFailure.crashLoop);
      expect(w.spawnCount, 3, reason: '세 번째 죽음 뒤에는 다시 띄우지 않는다');
      expect(s.status.deaths, 3);
    });

    // T46-3 실기 결함 ④. 실기에서 데몬을 1분 안에 세 번 죽였는데 `데몬이 반복해서 종료됩니다` 가
    // 끝내 안 떴고, 세 번째 죽음 36초 뒤에 **네 번째 데몬이 떴다.** 까닭: 죽인 순간이 늘 "막 띄워서
    // 아직 못 붙은" 때였는데 `_watchChild` 는 **붙은 뒤에야** 달리므로 그 죽음이 세어지지 않았다 —
    // 그런데 "띄우자마자 죽는다" 야말로 crash-loop 의 본모습이다.
    test('띄우자마자(붙기 전에) 죽는 데몬도 죽음으로 세어 crash-loop 으로 간다', () async {
      final w = FakeSupervisorWorld();
      final s = w.supervisor();
      await s.start();
      expect(w.spawnCount, 1);
      // 이제부터 띄우는 족족 붙기 전에 죽는다.
      w.onSpawned = (p) {
        p.die(9);
        w.reachable = false;
      };
      w.spawned.first.die(); // 죽음 1
      await until(() => s.status.state == SupervisorState.failed);
      expect(s.status.failure, SupervisorFailure.crashLoop);
      expect(s.status.deaths, 3, reason: '붙기 전에 죽은 둘도 죽음이다');
      expect(s.status.lastError, contains('붙기 전에 종료'));
      final n = w.spawnCount;
      // 포기한 뒤에는 남아 있던 재시작 일정이 **뒤늦게라도** 다시 띄우지 않는다.
      for (var i = 0; i < 50; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(w.spawnCount, n);
      expect(s.status.state, SupervisorState.failed);
    });

    test('포기한 뒤에도 `다시 시도` 는 처음부터 다시 한다', () async {
      final w = FakeSupervisorWorld();
      final s = w.supervisor();
      await s.start();
      w.onSpawned = (p) {
        p.die(9);
        w.reachable = false;
      };
      w.spawned.first.die();
      await until(() => s.status.failure == SupervisorFailure.crashLoop);
      // 원인을 고쳤다(이제 정상으로 뜬다).
      w.onSpawned = null;
      await s.retry();
      expect(s.status.state, SupervisorState.running);
      expect(s.status.failure, isNull);
      expect(s.status.deaths, 0, reason: '죽음 기록까지 지우고 처음부터');
    });

    test('죽음 사이가 1분보다 멀면 crash-loop 이 아니다', () async {
      final w = FakeSupervisorWorld();
      final s = w.supervisor();
      await s.start();
      for (var i = 0; i < 3; i++) {
        final n = w.spawnCount;
        w.spawned.last.die();
        await until(() => w.spawnCount == n + 1);
        w.now = w.now.add(const Duration(minutes: 2)); // 시간이 흘렀다
      }
      expect(s.status.state, SupervisorState.running);
      expect(w.spawnCount, 4);
    });

    test('재시작을 기다리는 사이 누가 데몬을 띄웠으면 새로 안 띄우고 붙는다', () async {
      final w = FakeSupervisorWorld();
      final s = w.supervisor();
      await s.start();
      // 이제부터 앱이 띄우는 것은 전부 실패한다. 두 번째 시도 때 사용자가 콘솔에서 데몬을 띄운다.
      w.spawnThrows = const DaemonSpawnException('실패');
      w.onSpawnAttempt = (world) {
        if (world.spawnEnvs.length == 3) world.reachable = true;
      };
      w.spawned.single.die();
      await until(() => s.status.state == SupervisorState.running && w.spawnEnvs.length == 3);
      expect(s.status.spawned, isFalse, reason: '콘솔에서 띄운 데몬에 붙었다');
      expect(w.spawnEnvs, hasLength(3), reason: '처음 1 + 실패한 재시작 2 — 그 뒤로는 안 띄운다');
      expect(w.restartWaits, [const Duration(seconds: 2), const Duration(seconds: 5)]);
    });

    test('`다시 시도` 는 죽음 기록을 지우고 처음부터 다시 한다', () async {
      final w = FakeSupervisorWorld(spawnThrows: const DaemonSpawnException('실패'));
      final s = w.supervisor();
      await s.start();
      expect(s.status.state, SupervisorState.failed);
      w.spawnThrows = null;
      await s.retry();
      expect(s.status.state, SupervisorState.running);
      expect(s.status.deaths, 0);
      expect(s.status.failure, isNull);
    });
  });

  group('소켓 끊김으로 죽음 알아채기(§4)', () {
    test('daemon.json 의 pid 가 살아 있으면 일시적 끊김 — 아무것도 안 한다', () async {
      final w = FakeSupervisorWorld(reachable: true);
      final s = w.supervisor();
      await s.start();
      await s.socketClosed();
      expect(s.status.state, SupervisorState.running);
      expect(w.spawnCount, 0);
    });

    test('pid 가 죽어 있으면 죽음으로 보고 다시 띄운다(붙기만 한 데몬)', () async {
      final w = FakeSupervisorWorld(reachable: true);
      final s = w.supervisor();
      await s.start();
      expect(s.status.spawned, isFalse);
      w.reachable = false;
      await s.socketClosed();
      await until(() => s.status.state == SupervisorState.running && w.spawnCount == 1);
      expect(s.status.spawned, isTrue);
    });

    test('running 이 아니면 무시한다', () async {
      final w = FakeSupervisorWorld(spawnThrows: const DaemonSpawnException('실패'));
      final s = w.supervisor();
      await s.start();
      await s.socketClosed();
      expect(s.status.state, SupervisorState.failed);
      expect(w.spawnCount, 0);
    });
  });

  group('정지(§2 종료 경로)', () {
    test('stop 뒤에 자식이 죽어도 다시 띄우지 않는다', () async {
      final w = FakeSupervisorWorld();
      final s = w.supervisor();
      await s.start();
      final child = w.spawned.single;
      await s.stop();
      expect(s.status.state, SupervisorState.stopped);
      child.die();
      await until(() => child.killed || true);
      expect(w.spawnCount, 1);
    });

    test('stop(killChild: true) 는 앱이 띄운 트리를 끝낸다', () async {
      final w = FakeSupervisorWorld();
      final s = w.supervisor();
      await s.start();
      final child = w.spawned.single;
      await s.stop(killChild: true);
      expect(child.killed, isTrue);
    });

    test('붙기만 했으면 stop(killChild: true) 가 죽일 자식이 없다', () async {
      final w = FakeSupervisorWorld(reachable: true);
      final s = w.supervisor();
      await s.start();
      expect(s.child, isNull);
      await s.stop(killChild: true);
      expect(w.spawnCount, 0);
    });
  });
}
