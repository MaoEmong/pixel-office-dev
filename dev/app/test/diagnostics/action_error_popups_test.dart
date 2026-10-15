import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/diagnostics/action_error_popups.dart';
import 'package:pixel_office/diagnostics/error_panel.dart';
import 'package:pixel_office/panel/ui_prefs.dart';
import 'package:pixel_office/panel/panel_tabs.dart';
import 'package:pixel_office/state/selection.dart';
import 'package:pixel_office/rpc/rpc_client.dart';
import 'package:pixel_office/remote/device_dialog.dart';
import '../command/fake_rpc_client.dart';

Future<void> pumpHost(
  WidgetTester tester,
  FakeRpcClient fake, {
  Widget? child,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        ...fake.overrides,
        uiPrefsStoreProvider.overrideWithValue(MemoryUiPrefsStore()),
      ],
      child: MaterialApp(
        home: ActionErrorPopups(
          child: Scaffold(body: child ?? const Text('작업 화면')),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'authentication errors open a popup with a direct route to the affected terminal',
    (tester) async {
      final fake = FakeRpcClient();
      addTearDown(fake.close);
      await pumpHost(tester, fake);
      fake.emitHello(
        members: [fakeMember('m', name: '부장', rank: 'head')],
      );
      await tester.pumpAndSettle();
      fake.pushEvent({
        'seq': 1,
        'ts': '2026-10-16T01:00:00Z',
        'departmentId': 'd1',
        'teamId': '',
        'memberId': 'm',
        'kind': 'error',
        'detail': {'summary': '부장: 로그인이 만료되었습니다. 기존 요청은 보존됩니다.'},
        'ref': {},
      });
      await tester.pumpAndSettle();
      expect(find.textContaining('로그인이 만료되었습니다.'), findsOneWidget);
      await tester.tap(find.text('터미널 열기 · 로그인 복구'));
      await tester.pumpAndSettle();
      final container = ProviderScope.containerOf(
        tester.element(find.text('작업 화면')),
      );
      expect(container.read(selectedMemberIdProvider), 'm');
      expect(
        container.read(panelTabRequestProvider)?.tab,
        RightPanelTab.terminal,
      );
      expect(find.byType(ErrorPanel), findsNothing);
    },
  );
  testWidgets(
    'automatic recovery dismisses the resolved error popup and removes queued stale errors only',
    (tester) async {
      final fake = FakeRpcClient();
      addTearDown(fake.close);
      await pumpHost(tester, fake);
      fake.pushNotification('workflow.changed', {
        'departmentId': 'd1',
        'phase': 'blocked',
        'problem': '연결 끊김',
      });
      await tester.pumpAndSettle();
      expect(find.text('작업을 계속할 수 없어요').hitTestable(), findsOneWidget);
      fake.pushNotification('workflow.changed', {
        'departmentId': 'd1',
        'phase': 'meeting',
      });
      await tester.pumpAndSettle();
      expect(find.byType(ErrorPanel), findsNothing);
      fake.reportFailure(
        'member.instruct',
        const RpcException(-32003, '별도의 요청 실패'),
      );
      await tester.pumpAndSettle();
      fake.pushNotification('workflow.changed', {
        'departmentId': 'd1',
        'phase': 'blocked',
        'problem': '복구 예정 연결 오류',
      });
      await tester.pumpAndSettle();
      fake.pushNotification('workflow.changed', {
        'departmentId': 'd1',
        'phase': 'meeting',
      });
      await tester.pumpAndSettle();
      expect(
        find.text('지시를 보내지 못했어요').hitTestable(),
        findsOneWidget,
        reason: 'recovery must not dismiss an unrelated error or dialog',
      );
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
      expect(
        find.byType(ErrorPanel),
        findsNothing,
        reason:
            'a queued error resolved before display must not appear afterwards',
      );
    },
  );

  testWidgets(
    'restored blocked work opens a popup, remains in the banner and clears only on recovery',
    (tester) async {
      var workflow = <String, dynamic>{
        'departmentId': 'd1',
        'phase': 'blocked',
        'problem': '참석자 실행 실패',
      };
      final fake = FakeRpcClient(responder: (_, _) => {'workflow': workflow});
      addTearDown(fake.close);
      await pumpHost(
        tester,
        fake,
        child: const Column(children: [ActiveProblemsBanner(), Text('작업 화면')]),
      );
      fake.emitHello(
        departments: [fakeDepartment('d1')],
        workflows: [workflow],
      );
      await tester.pumpAndSettle();
      expect(find.text('작업을 계속할 수 없어요').hitTestable(), findsOneWidget);
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('activeProblems.banner')), findsOneWidget);
      fake.emitHello(
        departments: [fakeDepartment('d1')],
        workflows: [workflow],
      );
      await tester.pumpAndSettle();
      expect(
        find.byType(ErrorPanel),
        findsNothing,
        reason:
            'reconnection must not repeat an acknowledged unchanged failure',
      );
      await tester.tap(find.text('눌러서 원인 확인'));
      await tester.pumpAndSettle();
      expect(find.text('참석자 실행 실패').hitTestable(), findsOneWidget);
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
      workflow = {'departmentId': 'd1', 'phase': 'meeting'};
      fake.pushNotification('workflow.changed', workflow);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('activeProblems.banner')), findsNothing);
      workflow = {
        'departmentId': 'd1',
        'phase': 'blocked',
        'problem': '참석자 실행 실패',
      };
      fake.pushNotification('workflow.changed', workflow);
      await tester.pumpAndSettle();
      expect(
        find.byType(ErrorPanel),
        findsOneWidget,
        reason: 'a new failure after recovery is announced again',
      );
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'workflow.get also announces an existing problem when no new notification arrives',
    (tester) async {
      final fake = FakeRpcClient(
        responder: (_, _) => {
          'workflow': {
            'departmentId': 'd1',
            'phase': 'blocked',
            'problem': '이미 중단된 회의',
          },
        },
      );
      addTearDown(fake.close);
      await pumpHost(tester, fake);
      fake.emitHello(departments: [fakeDepartment('d1')]);
      await tester.pumpAndSettle();
      expect(find.text('이미 중단된 회의').hitTestable(), findsOneWidget);
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'restored member errors stay visible until that member leaves the error state',
    (tester) async {
      final fake = FakeRpcClient();
      addTearDown(fake.close);
      await pumpHost(
        tester,
        fake,
        child: const Column(children: [ActiveProblemsBanner(), Text('작업 화면')]),
      );
      fake.emitHello(
        members: [fakeMember('h', name: '부장', rank: 'head', status: 'error')],
      );
      await tester.pumpAndSettle();
      expect(find.text('AI를 실행하지 못했어요').hitTestable(), findsOneWidget);
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('activeProblems.banner')), findsOneWidget);
      fake.pushNotification('member.status', {
        'memberId': 'h',
        'status': 'starting',
        'derived': 'starting',
      });
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('activeProblems.banner')), findsNothing);
    },
  );

  for (final method in [
    'member.instruct',
    'clipboard.copy',
    'member.interrupt',
    'approval.respond',
    'question.respond',
    'member.instructions.set',
    'member.rehire',
    'remote.configure',
    'remote.pair.create',
    'remote.device.approve',
    'remote.device.revoke',
    'resources.set',
    'engines.set',
    'storage.backup',
    'department.delete',
    'department.update',
    'workflow.start',
    'workflow.resume',
    'workflow.complete',
    'task.retrySubmit',
    'member.type',
    'member.resize',
    'member.attach',
  ]) {
    testWidgets(
      '$method failure is a visible popup even if the caller ignores it',
      (tester) async {
        final fake = FakeRpcClient(
          responder: (_, _) =>
              throw const RpcException(-32003, '실행할 수 없어요. 로그인 상태를 확인하세요.'),
        );
        addTearDown(fake.close);
        await pumpHost(
          tester,
          fake,
          child: TextButton(
            onPressed: () =>
                fake.call(method).catchError((Object _) => <String, dynamic>{}),
            child: const Text('실행'),
          ),
        );
        await tester.tap(find.text('실행'));
        await tester.pumpAndSettle();
        expect(find.byType(ErrorPanel), findsOneWidget);
        expect(
          find.text(actionErrorTitle(method)!).hitTestable(),
          findsOneWidget,
        );
        expect(
          find.textContaining('로그인 상태를 확인하세요').hitTestable(),
          findsOneWidget,
        );
        await tester.tap(find.text('닫기'));
        await tester.pumpAndSettle();
        expect(find.byType(ErrorPanel), findsNothing);
        expect(find.text('실행').hitTestable(), findsOneWidget);
      },
    );
  }

  testWidgets(
    'background read failures stay quiet after acknowledgement until a successful refresh',
    (tester) async {
      final fake = FakeRpcClient();
      addTearDown(fake.close);
      await pumpHost(tester, fake);
      fake.reportFailure('remote.status', const RpcException(-1, 'offline'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
      fake.reportFailure('remote.status', const RpcException(-1, 'offline'));
      await tester.pumpAndSettle();
      expect(find.byType(ErrorPanel), findsNothing);
      fake.reportSuccess('remote.status');
      await tester.pump();
      fake.reportFailure('remote.status', const RpcException(-1, 'offline'));
      await tester.pumpAndSettle();
      expect(find.byType(ErrorPanel), findsOneWidget);
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'an unavailable remote service is announced once, and a failed manual restart is announced again',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 720);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final fake = FakeRpcClient(
        responder: (_, _) => {
          'available': false,
          'message': '접속 포트를 사용할 수 없어요.',
          'devices': [],
        },
      );
      addTearDown(fake.close);
      await pumpHost(tester, fake, child: const DeviceDialog());
      expect(find.text('기기 연결 상태를 불러오지 못했어요').hitTestable(), findsOneWidget);
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 4));
      await tester.pumpAndSettle();
      expect(find.text('기기 연결 상태를 불러오지 못했어요'), findsNothing);
      await tester.tap(find.text('원격 연결 다시 시작'));
      await tester.pumpAndSettle();
      expect(find.text('원격 연결을 다시 시작하지 못했어요').hitTestable(), findsOneWidget);
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'duplicate terminal failures are combined and different failures are shown one at a time',
    (tester) async {
      final fake = FakeRpcClient();
      addTearDown(fake.close);
      await pumpHost(tester, fake);
      for (var i = 0; i < 3; i++) {
        fake.reportFailure(
          'member.type',
          const RpcException(-32003, '첫 번째 문제'),
        );
      }
      fake.reportFailure(
        'storage.backup',
        const RpcException(-32003, '두 번째 문제'),
      );
      await tester.pumpAndSettle();
      expect(find.byType(ErrorPanel), findsOneWidget);
      expect(find.textContaining('첫 번째 문제'), findsOneWidget);
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
      expect(find.byType(ErrorPanel), findsOneWidget);
      expect(find.textContaining('두 번째 문제'), findsOneWidget);
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
      expect(find.byType(ErrorPanel), findsNothing);
      fake.reportFailure('member.type', const RpcException(-32003, '첫 번째 문제'));
      await tester.pumpAndSettle();
      expect(
        find.byType(ErrorPanel),
        findsOneWidget,
        reason: 'a later intentional retry still reports its failure',
      );
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
    },
  );

  testWidgets('errors appear above an existing dialog and preserve its input', (
    tester,
  ) async {
    final fake = FakeRpcClient();
    addTearDown(fake.close);
    await pumpHost(
      tester,
      fake,
      child: Builder(
        builder: (context) => TextButton(
          child: const Text('설정 열기'),
          onPressed: () => showDialog<void>(
            context: context,
            builder: (_) =>
                const AlertDialog(title: Text('설정'), content: TextField()),
          ),
        ),
      ),
    );
    await tester.tap(find.text('설정 열기'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '지켜야 하는 입력');
    fake.reportFailure(
      'remote.configure',
      const RpcException(-32003, '주소를 확인하세요'),
    );
    await tester.pumpAndSettle();
    expect(find.text('접속 주소를 저장하지 못했어요').hitTestable(), findsOneWidget);
    await tester.tap(find.text('닫기'));
    await tester.pumpAndSettle();
    expect(find.text('지켜야 하는 입력').hitTestable(), findsOneWidget);
  });

  testWidgets(
    'cleanup and separately handled department creation do not create duplicate popups',
    (tester) async {
      final fake = FakeRpcClient();
      addTearDown(fake.close);
      await pumpHost(tester, fake);
      for (final method in [
        'hello',
        'member.detach',
        'daemon.shutdown',
        'department.create',
      ]) {
        fake.reportFailure(method, const RpcException(-1, 'not connected'));
      }
      fake.reportFailure(
        'storage.get',
        const RpcException(-32601, 'optional method missing'),
      );
      await tester.pumpAndSettle();
      expect(find.byType(ErrorPanel), findsNothing);
      fake.reportFailure(
        'workflow.discuss',
        const RpcException(RpcException.timeout, 'timeout after 15000ms'),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('처리 결과를 확인').hitTestable(), findsOneWidget);
      expect(find.textContaining('timeout after'), findsNothing);
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'server errors, blocked workflows, and local settings failures are also announced',
    (tester) async {
      final fake = FakeRpcClient();
      addTearDown(fake.close);
      await pumpHost(tester, fake);
      fake.pushNotification('daemon.notice', {
        'level': 'error',
        'message': '기록을 저장할 수 없어요',
      });
      await tester.pumpAndSettle();
      expect(
        find.textContaining('기록을 저장할 수 없어요').hitTestable(),
        findsOneWidget,
      );
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
      fake.pushNotification('workflow.changed', {
        'departmentId': 'd1',
        'phase': 'blocked',
        'problem': '업무 배정 실패. 다시 시도하세요.',
      });
      await tester.pumpAndSettle();
      expect(find.text('작업을 계속할 수 없어요').hitTestable(), findsOneWidget);
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
      fake.pushNotification('workflow.changed', {
        'departmentId': 'd1',
        'phase': 'blocked',
        'problem': '업무 배정 실패. 다시 시도하세요.',
      });
      await tester.pumpAndSettle();
      expect(
        find.byType(ErrorPanel),
        findsNothing,
        reason:
            'unchanged background state should not repeatedly interrupt the user',
      );
      final context = tester.element(find.byType(ActionErrorPopups));
      ProviderScope.containerOf(
        context,
      ).read(prefsSaveFailureProvider.notifier).set('설정 파일 쓰기 실패');
      await tester.pumpAndSettle();
      expect(find.text('설정을 저장하지 못했어요').hitTestable(), findsOneWidget);
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
      ProviderScope.containerOf(
        context,
      ).read(prefsReadFailureProvider.notifier).set('설정 파일 손상');
      await tester.pumpAndSettle();
      expect(find.text('설정을 불러오지 못했어요').hitTestable(), findsOneWidget);
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
      fake.pushEvent({
        'seq': 1,
        'ts': '2026-10-16T00:00:00Z',
        'memberId': 'h',
        'teamId': '',
        'departmentId': 'd1',
        'kind': 'error',
        'detail': {'summary': 'AI 작업이 예기치 않게 종료됐어요'},
      });
      await tester.pumpAndSettle();
      expect(find.text('AI 작업 중 문제가 생겼어요').hitTestable(), findsOneWidget);
      await tester.tap(find.text('닫기'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    },
  );
}
