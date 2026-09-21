// T46-2 · 수명주기 §2: 앱을 끄면 전부 같이 꺼진다.
//   아무도 안 일하면 안 묻는다 / 일하는 중이면 확인(취소·닫기) / daemon.shutdown → 8초 안에 사라지면 끝 /
//   넘으면 taskkill /T /F / "계속 일하기" 면 아무것도 안 한다.
import 'dart:ui' show AppExitResponse;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/lifecycle/exit_flow.dart';
import 'package:pixel_office/lifecycle/lifecycle_gate.dart';
import 'package:pixel_office/lifecycle/lifecycle_providers.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/panel/ui_prefs.dart';
import 'package:pixel_office/state/office_state.dart';

import '../office/office_fixtures.dart';
import '../office/office_harness.dart';

/// 가짜 데몬 프로세스 세계(pid 하나).
class _World {
  _World({this.pid = 5555, this.diesAfterShutdown = true});

  final int pid;

  /// `daemon.shutdown` 을 받으면 스스로 꺼지는가(false = 안 꺼져서 강제 종료해야 한다).
  bool diesAfterShutdown;

  bool alive = true;
  bool shutdownCalled = false;
  bool killed = false;
  Object? shutdownThrows;
  int supervisorStops = 0;
  final List<bool> closingFlags = [];
  DateTime now = DateTime.utc(2026, 9, 21, 12);
  final List<Duration> slept = [];

  Future<void> sleep(Duration d) async {
    slept.add(d);
    now = now.add(d);
  }

  Future<void> shutdown() async {
    shutdownCalled = true;
    final t = shutdownThrows;
    if (t != null) throw t;
    if (diesAfterShutdown) alive = false;
  }

  AppExitCoordinator coordinator({
    bool keepDaemon = false,
    int working = 0,
    Future<bool> Function(int)? confirm,
    int? daemonPid,
  }) =>
      AppExitCoordinator(
        keepDaemon: () => keepDaemon,
        workingCount: () => working,
        confirm: confirm ?? (_) async => true,
        daemonPid: () async => daemonPid ?? pid,
        shutdownDaemon: shutdown,
        isAlive: (p) async => p == pid && alive,
        killTree: (p) async {
          killed = true;
          alive = false;
        },
        stopSupervisor: () async => supervisorStops++,
        onClosingChanged: closingFlags.add,
        sleep: sleep,
        now: () => now,
      );
}

void main() {
  group('확인 다이얼로그(§2-1)', () {
    test('일하는 중인 캐릭터가 없으면 묻지 않는다', () async {
      final w = _World();
      var asked = 0;
      final out = await w
          .coordinator(
            working: 0,
            confirm: (_) async {
              asked++;
              return true;
            },
          )
          .onExitRequested();
      expect(asked, 0);
      expect(out.asked, isFalse);
      expect(out.exiting, isTrue);
    });

    test('일하는 중이면 묻고, 취소하면 아무것도 안 한다', () async {
      final w = _World();
      final out = await w.coordinator(working: 3, confirm: (_) async => false).onExitRequested();
      expect(out.response, AppExitResponse.cancel);
      expect(w.shutdownCalled, isFalse);
      expect(w.supervisorStops, 0);
      expect(w.closingFlags, isEmpty, reason: '"정리하는 중" 을 띄우지 않는다');
    });

    test('닫기를 고르면 정리하고 끝낸다', () async {
      final w = _World();
      late int askedWith;
      final out = await w
          .coordinator(
            working: 2,
            confirm: (n) async {
              askedWith = n;
              return true;
            },
          )
          .onExitRequested();
      expect(askedWith, 2);
      expect(out.exiting, isTrue);
      expect(w.shutdownCalled, isTrue);
    });

    test('문구는 수명주기 §2-1 그대로', () {
      expect(exitConfirmMessage(3), '일하는 중인 캐릭터가 3명 있습니다. 닫으면 전부 멈춥니다. (다음에 켜면 이어서 합니다)');
      expect(exitClosingLabel, '정리하는 중…');
    });
  });

  group('데몬 끄기(§2-2·3)', () {
    test('감시자를 먼저 멈춘 뒤 daemon.shutdown — 정상 종료를 죽음으로 오해하지 않게', () async {
      final w = _World();
      final out = await w.coordinator().onExitRequested();
      expect(w.supervisorStops, 1);
      expect(w.shutdownCalled, isTrue);
      expect(out.treeKilled, isFalse);
      expect(w.killed, isFalse);
      expect(w.closingFlags, [true, false]);
    });

    test('8초 안에 안 사라지면 프로세스 트리를 강제 종료한다', () async {
      final w = _World(diesAfterShutdown: false);
      final out = await w.coordinator().onExitRequested();
      expect(out.treeKilled, isTrue);
      expect(w.killed, isTrue);
      expect(out.waitedMs, greaterThanOrEqualTo(daemonShutdownTimeout.inMilliseconds));
      // 250ms 마다 물어보며 8초를 채웠다.
      expect(w.slept, hasLength(32));
      expect(w.slept, everyElement(const Duration(milliseconds: 250)));
    });

    test('daemon.shutdown 이 실패해도(이미 끊김) 프로세스는 치운다', () async {
      final w = _World(diesAfterShutdown: false)..shutdownThrows = StateError('not connected');
      final out = await w.coordinator().onExitRequested();
      expect(out.shutdownSent, isFalse);
      expect(out.error, contains('not connected'));
      expect(w.killed, isTrue);
      expect(out.exiting, isTrue);
    });

    test('데몬 pid 를 모르면(daemon.json 없음) 기다릴 것도 죽일 것도 없다', () async {
      final w = _World();
      final out = await w.coordinator(daemonPid: 0).onExitRequested();
      expect(out.treeKilled, isFalse);
      expect(w.slept, isEmpty);
      expect(out.exiting, isTrue);
    });

    test('앱이 안 띄운(콘솔에서 띄운) 데몬도 똑같이 끈다 — 규칙은 하나다', () async {
      final w = _World();
      final out = await w.coordinator().onExitRequested();
      expect(w.shutdownCalled, isTrue);
      expect(out.exiting, isTrue);
    });
  });

  group('앱을 닫아도 계속 일하기(§2 예외)', () {
    test('묻지도 끄지도 않는다', () async {
      final w = _World();
      var asked = 0;
      final out = await w
          .coordinator(
            keepDaemon: true,
            working: 5,
            confirm: (_) async {
              asked++;
              return true;
            },
          )
          .onExitRequested();
      expect(asked, 0);
      expect(w.shutdownCalled, isFalse);
      expect(w.supervisorStops, 0);
      expect(w.killed, isFalse);
      expect(out.keptDaemon, isTrue);
      expect(out.exiting, isTrue);
    });
  });

  group('일하는 중 세기', () {
    test('범례 "작업" 칸만 센다 — 한가·대기·출근 중은 안 센다', () {
      final s = OfficeState(
        members: {
          'a': member('a', status: MemberStatus.working),
          'b': member('b', status: MemberStatus.working),
          'c': member('c', status: MemberStatus.idle),
          'd': member('d', status: MemberStatus.starting),
          'e': member('e', status: MemberStatus.exited),
          'f': member('f', status: MemberStatus.waitingApproval),
          'g': member('g', status: MemberStatus.suspended),
        },
        derived: {'c': DerivedStatus.free},
      );
      expect(workingMemberCount(s), 2);
    });

    test('멤버가 없으면 0', () => expect(workingMemberCount(const OfficeState()), 0));
  });

  group('LifecycleGate(위젯 배선)', () {
    Future<LifecycleGateState> pumpGate(
      WidgetTester tester, {
      required OfficeState office,
      required _World world,
      bool keepDaemon = false,
    }) async {
      await tester.pumpWidget(ProviderScope(
        overrides: [
          officeProvider.overrideWith(() => FakeOfficeNotifier(office)),
          uiPrefsStoreProvider.overrideWithValue(MemoryUiPrefsStore({keepDaemonKey: keepDaemon})),
          keepDaemonEnvProvider.overrideWithValue(false),
          daemonProcessPidProvider.overrideWithValue(() async => world.pid),
          pidAliveProvider.overrideWithValue((p) async => world.alive),
          killProcessTreeProvider.overrideWithValue((p) async {
            world.killed = true;
            world.alive = false;
          }),
        ],
        child: const MaterialApp(home: LifecycleGate(child: Scaffold(body: Text('사무실')))),
      ));
      await tester.pumpAndSettle();
      return tester.state<LifecycleGateState>(find.byType(LifecycleGate));
    }

    testWidgets('일하는 중이면 확인 다이얼로그가 뜨고 취소하면 종료하지 않는다', (tester) async {
      final w = _World();
      final gate = await pumpGate(
        tester,
        world: w,
        office: OfficeState(members: {'a': member('a', status: MemberStatus.working)}),
      );
      final pending = gate.handleExitRequest();
      await tester.pumpAndSettle();
      expect(find.text(exitConfirmMessage(1)), findsOneWidget);
      await tester.tap(find.byKey(const Key('exit.confirm.cancel')));
      await tester.pumpAndSettle();
      expect(await pending, AppExitResponse.cancel);
      expect(w.killed, isFalse);
    });

    testWidgets('아무도 안 일하면 다이얼로그 없이 바로 종료 경로로 간다', (tester) async {
      // 데몬이 이미 꺼져 있다 — 기다릴 것이 없다(위젯 테스트는 실제 시간이 흐르지 않는다).
      final w = _World()..alive = false;
      final gate = await pumpGate(
        tester,
        world: w,
        office: OfficeState(members: {'a': member('a', status: MemberStatus.idle)}),
      );
      final pending = gate.handleExitRequest();
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('exit.confirm.message')), findsNothing);
      expect(await pending, AppExitResponse.exit);
    });

    testWidgets('"계속 일하기" 설정이 켜져 있으면 일하는 중이어도 안 묻고 안 끈다', (tester) async {
      final w = _World();
      final gate = await pumpGate(
        tester,
        world: w,
        keepDaemon: true,
        office: OfficeState(members: {'a': member('a', status: MemberStatus.working)}),
      );
      final pending = gate.handleExitRequest();
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('exit.confirm.message')), findsNothing);
      expect(await pending, AppExitResponse.exit);
      expect(gate.lastOutcome!.keptDaemon, isTrue);
      expect(w.killed, isFalse);
    });
  });
}
