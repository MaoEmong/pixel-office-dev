// T46-2 · 수명주기 §1 · §2 · §4: 오버레이가 상태마다 하는 말.
//   사무실을 여는 중… / 데몬이 멈춰 다시 시작하는 중 · 세션을 복구합니다(+ 복구 2 / 5) /
//   데몬을 시작하지 못했습니다(+ daemon.log 8줄 + 다시 시도 + 데몬 시작) / 데몬이 반복해서 종료됩니다 /
//   정리하는 중… — 그리고 예외는 어느 화면에서든 "자세히" 로 접힌다.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/lifecycle/daemon_supervisor.dart';
import 'package:pixel_office/lifecycle/lifecycle_providers.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/rpc/rpc_client.dart';
import 'package:pixel_office/state/office_state.dart';
import 'package:pixel_office/topbar/disconnected_overlay.dart';

import '../command/fake_rpc_client.dart';
import '../office/office_harness.dart';

class _FakeStatus extends SupervisorStatusNotifier {
  _FakeStatus(this.initial);
  final SupervisorStatus? initial;

  @override
  SupervisorStatus? build() => initial;
}

class _FakeClosing extends ExitClosingNotifier {
  _FakeClosing(this.initial);
  final bool initial;

  @override
  bool build() => initial;
}

const _logLines = ['줄 1', '줄 2', '줄 3', '줄 4', '줄 5', '줄 6', '줄 7', '줄 8'];

void main() {
  late FakeRpcClient fake;
  setUp(() => fake = FakeRpcClient());
  tearDown(() async => fake.close());

  Future<void> pump(
    WidgetTester tester, {
    SupervisorStatus? status,
    OfficeState office = const OfficeState(),
    bool closing = false,
    List<String> log = _logLines,
  }) async {
    tester.view.physicalSize = const Size(900, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(ProviderScope(
      overrides: [
        ...fake.overrides,
        officeProvider.overrideWith(() => FakeOfficeNotifier(office)),
        supervisorStatusProvider.overrideWith(() => _FakeStatus(status)),
        exitClosingProvider.overrideWith(() => _FakeClosing(closing)),
        daemonLogTailProvider.overrideWithValue(() async => log),
      ],
      child: const MaterialApp(
        home: Scaffold(
          body: Stack(children: [DisconnectedOverlay(daemonJsonPath: r'C:\fake\daemon.json')]),
        ),
      ),
    ));
    await tester.pump();
    await tester.pump();
  }

  group('여는 중(§1)', () {
    for (final state in [SupervisorState.attaching, SupervisorState.starting]) {
      testWidgets('$state → `사무실을 여는 중…`', (tester) async {
        await pump(tester, status: SupervisorStatus(state: state));
        expect(find.text(overlayOpeningLabel), findsOneWidget);
        expect(find.text('사무실을 여는 중…'), findsOneWidget);
        // 여는 중에는 "데몬 시작" 버튼을 보여 주지 않는다(§1: 실패 화면에만).
        expect(find.byKey(const Key('daemon.start')), findsNothing);
      });
    }
  });

  group('다시 시작 · 복구(§4)', () {
    testWidgets('restarting → 한 문장 + 불확정 진행 바', (tester) async {
      await pump(tester, status: const SupervisorStatus(state: SupervisorState.restarting, restartAttempt: 2));
      expect(find.text(overlayRestartingLabel), findsOneWidget);
      expect(find.text('데몬이 멈춰 다시 시작하는 중 · 세션을 복구합니다'), findsOneWidget);
      expect(tester.widget<LinearProgressIndicator>(find.byKey(const Key('overlay.progress'))).value, isNull);
      expect(find.byKey(const Key('overlay.recovery')), findsNothing);
    });

    testWidgets('daemon.notice{recovering, total, done} → `복구 2 / 5` + 비율 진행 바', (tester) async {
      await pump(
        tester,
        status: const SupervisorStatus(state: SupervisorState.running),
        office: OfficeState(
          connection: RpcConnectionState.connected,
          recovery: DaemonNotice(
            level: NoticeLevel.info,
            message: '',
            receivedAt: DateTime.now(),
            kind: DaemonNoticeKind.recovering,
            total: 5,
            done: 2,
          ),
        ),
      );
      expect(find.text('복구 2 / 5'), findsOneWidget);
      expect(tester.widget<LinearProgressIndicator>(find.byKey(const Key('overlay.progress'))).value, closeTo(0.4, 0.001));
      expect(find.text(overlayRestartingLabel), findsOneWidget, reason: '붙어 있어도 복구 중이면 덮는다');
    });

    test('recoveryProgressLabel', () => expect(recoveryProgressLabel(2, 5), '복구 2 / 5'));
  });

  group('실패 화면(§1 · §4)', () {
    testWidgets('startFailed → 문장 + daemon.log 마지막 8줄 + 다시 시도 + 데몬 시작', (tester) async {
      await pump(
        tester,
        status: const SupervisorStatus(
          state: SupervisorState.failed,
          failure: SupervisorFailure.startFailed,
          lastError: 'Error: listen EADDRINUSE 7420',
        ),
      );
      await tester.pump(); // 로그 읽기(Future) → setState
      expect(find.text(overlayStartFailedTitle), findsOneWidget);
      expect(find.text('데몬을 시작하지 못했습니다'), findsOneWidget);
      final tail = tester.widget<Container>(find.byKey(const Key('overlay.logTail')));
      expect(tail, isNotNull);
      expect(find.textContaining('줄 8'), findsOneWidget);
      expect(find.textContaining('줄 1'), findsOneWidget);
      expect(find.byKey(const Key('overlay.retryStart')), findsOneWidget);
      expect(find.text(overlayRetryLabel), findsOneWidget);
      // 옛 "데몬 시작" 은 여기에만 남는다.
      expect(find.byKey(const Key('daemon.start')), findsOneWidget);
    });

    testWidgets('crashLoop → `데몬이 반복해서 종료됩니다`', (tester) async {
      await pump(
        tester,
        status: const SupervisorStatus(
          state: SupervisorState.failed,
          failure: SupervisorFailure.crashLoop,
          deaths: 3,
        ),
      );
      await tester.pump();
      expect(find.text(overlayCrashLoopTitle), findsOneWidget);
      expect(find.text('데몬이 반복해서 종료됩니다'), findsOneWidget);
      expect(find.text(overlayStartFailedTitle), findsNothing);
    });

    // T48-2 · D-48 ③: 맥·리눅스에서 node 를 못 찾았을 때. 고칠 방법이 문장 안에 있어야 한다.
    testWidgets('nodeNotFound → `node 를 찾지 못했습니다 — Homebrew … PIXEL_NODE …`', (tester) async {
      await pump(
        tester,
        status: const SupervisorStatus(
          state: SupervisorState.failed,
          failure: SupervisorFailure.nodeNotFound,
          lastError: overlayNodeNotFoundTitle,
        ),
      );
      await tester.pump();
      expect(find.byKey(const Key('overlay.nodeNotFound')), findsOneWidget);
      expect(
        find.text('node 를 찾지 못했습니다 — Homebrew 로 설치하거나 PIXEL_NODE 로 경로를 지정하세요'),
        findsOneWidget,
      );
      expect(find.text(overlayStartFailedTitle), findsNothing);
      expect(find.text(overlayCrashLoopTitle), findsNothing);
      // 로그 꼬리·다시 시도·데몬 시작은 다른 실패 화면과 같다.
      expect(find.byKey(const Key('overlay.logTail')), findsOneWidget);
      expect(find.byKey(const Key('overlay.retryStart')), findsOneWidget);
    });

    testWidgets('로그가 비어 있으면 그렇다고 말한다', (tester) async {
      await pump(
        tester,
        status: const SupervisorStatus(state: SupervisorState.failed, failure: SupervisorFailure.startFailed),
        log: const [],
      );
      await tester.pump();
      expect(find.text(overlayNoLogLabel), findsOneWidget);
    });

    testWidgets('예외는 "자세히" 로 접혀 있다(패스 4 하드리젝션 ②)', (tester) async {
      await pump(
        tester,
        status: const SupervisorStatus(
          state: SupervisorState.failed,
          failure: SupervisorFailure.startFailed,
          lastError: 'ProcessException: 스택 트레이스가 여기 다 있다',
        ),
      );
      await tester.pump();
      expect(find.textContaining('스택 트레이스'), findsNothing);
      await tester.tap(find.byKey(const Key('overlay.details')));
      await tester.pump();
      expect(find.byKey(const Key('overlay.error')), findsOneWidget);
      expect(find.textContaining('스택 트레이스'), findsOneWidget);
      expect(find.byKey(const Key('overlay.daemonPath')), findsOneWidget);
    });
  });

  group('정리하는 중(§2)', () {
    testWidgets('앱을 닫는 동안 `정리하는 중…` — 버튼 없음', (tester) async {
      await pump(tester, closing: true, status: const SupervisorStatus(state: SupervisorState.running));
      expect(find.text(exitClosingLabelText), findsOneWidget);
      expect(find.byKey(const Key('daemon.start')), findsNothing);
      expect(find.byKey(const Key('overlay.retryStart')), findsNothing);
    });
  });

  group('감시자가 없으면 T40-5 화면 그대로', () {
    testWidgets('`데몬에 연결되어 있지 않습니다` + 데몬 시작 + 다시 연결', (tester) async {
      await pump(tester, status: null);
      expect(find.text(disconnectedTitle), findsOneWidget);
      expect(find.byKey(const Key('overlay.retry')), findsOneWidget);
      expect(find.byKey(const Key('daemon.start')), findsOneWidget);
    });
  });

  group('오버레이를 덮는 조건', () {
    ProviderContainer containerWith({
      SupervisorStatus? status,
      OfficeState office = const OfficeState(),
    }) {
      final c = ProviderContainer(overrides: [
        ...fake.overrides,
        officeProvider.overrideWith(() => FakeOfficeNotifier(office)),
        supervisorStatusProvider.overrideWith(() => _FakeStatus(status)),
      ]);
      addTearDown(c.dispose);
      return c;
    }

    test('끊겨 있으면 덮는다', () {
      expect(containerWith().read(overlayVisibleProvider), isTrue);
    });

    test('붙어 있고 감시자가 running 이면 안 덮는다', () {
      final c = containerWith(
        status: const SupervisorStatus(state: SupervisorState.running),
        office: const OfficeState(connection: RpcConnectionState.connected),
      );
      expect(c.read(overlayVisibleProvider), isFalse);
    });

    test('붙어 있어도 restarting·failed 면 덮는다', () {
      for (final s in [
        const SupervisorStatus(state: SupervisorState.restarting),
        const SupervisorStatus(state: SupervisorState.failed, failure: SupervisorFailure.crashLoop),
      ]) {
        final c = containerWith(status: s, office: const OfficeState(connection: RpcConnectionState.connected));
        expect(c.read(overlayVisibleProvider), isTrue, reason: '$s');
      }
    });

    test('정리하는 중이면 덮는다', () {
      final c = containerWith(
        status: const SupervisorStatus(state: SupervisorState.running),
        office: const OfficeState(connection: RpcConnectionState.connected),
      );
      c.read(exitClosingProvider.notifier).set(true);
      expect(c.read(overlayVisibleProvider), isTrue);
    });
  });
}

/// `lifecycle/exit_flow.dart` 의 문구(오버레이가 그대로 쓴다).
const String exitClosingLabelText = '정리하는 중…';
