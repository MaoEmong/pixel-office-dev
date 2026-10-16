import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/state/office_state.dart';
import 'package:pixel_office/workflow/workflow_panel.dart';
import 'command/fake_rpc_client.dart';

void main() {
  testWidgets(
    'the conversation dialog sends follow-ups during meetings, work and errors',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 720);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      var workflow = <String, dynamic>{
        'departmentId': 'd1',
        'phase': 'meeting',
        'brief': '기존 계획',
        'messages': [],
        'assignments': [],
      };
      final fake = FakeRpcClient(responder: (_, _) => {'workflow': workflow});
      addTearDown(fake.close);
      await tester.pumpWidget(
        ProviderScope(
          overrides: fake.overrides,
          child: const MaterialApp(
            home: Scaffold(body: WorkflowDialog(departmentId: 'd1')),
          ),
        ),
      );
      fake.emitHello(
        departments: [fakeDepartment('d1', headId: 'h')],
        members: [fakeMember('h', rank: 'head', status: 'idle')],
      );
      await tester.pumpAndSettle();
      for (final phase in ['meeting', 'executing', 'blocked', 'review']) {
        workflow = {...workflow, 'phase': phase};
        fake.pushNotification('workflow.changed', workflow);
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField), '$phase 질문과 변경 지시');
        await tester.tap(find.text('대화 보내기'));
        await tester.pumpAndSettle();
        expect(
          fake.calls.where((c) => c.$1 == 'workflow.discuss').last.$2['text'],
          '$phase 질문과 변경 지시',
        );
        expect(
          tester.widget<TextField>(find.byType(TextField)).controller!.text,
          isEmpty,
        );
      }
      expect(fake.calls.where((c) => c.$1 == 'workflow.start'), isEmpty);
    },
  );

  testWidgets(
    'deleted participants are resolved by the server instead of blocking recovery in the UI',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 720);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final workflow = <String, dynamic>{
        'departmentId': 'd1',
        'phase': 'blocked',
        'messages': [],
        'assignments': [],
        'meeting': {
          'participants': ['left', 'deleted'],
          'participantNames': {'left': '퇴근팀장', 'deleted': '삭제팀장'},
          'contributions': [],
        },
      };
      final fake = FakeRpcClient(responder: (_, _) => {'workflow': workflow});
      addTearDown(fake.close);
      await tester.pumpWidget(
        ProviderScope(
          overrides: fake.overrides,
          child: const MaterialApp(
            home: Scaffold(body: WorkflowDialog(departmentId: 'd1')),
          ),
        ),
      );
      fake.emitHello(
        departments: [fakeDepartment('d1', headId: 'h')],
        members: [
          fakeMember('h', rank: 'head', status: 'idle'),
          fakeMember('left', name: '퇴근팀장', rank: 'lead', status: 'exited'),
        ],
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('참석자 복구 후 회의 재개'));
      await tester.pumpAndSettle();
      expect(
        fake.calls.where(
          (c) => c.$1 == 'member.rehire' || c.$1 == 'workflow.resume',
        ),
        hasLength(1),
      );
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isTrue);
    },
  );

  testWidgets(
    'discussion and explicit Start use different RPCs; review is completed explicitly',
    (tester) async {
      final fake = FakeRpcClient();
      addTearDown(fake.close);
      tester.view.physicalSize = const Size(1280, 720);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      Map<String, dynamic>? workflow;
      fake.responder = (method, params) {
        if (method == 'workflow.discuss') {
          workflow = {
            'departmentId': 'd1',
            'phase': 'clarifying',
            'brief': params['text'],
            'messages': [],
            'assignments': [],
          };
        }
        if (method == 'workflow.start') {
          workflow = {...workflow!, 'phase': 'meeting'};
        }
        if (method == 'workflow.complete') {
          workflow = {...workflow!, 'phase': 'completed'};
        }
        return {'workflow': workflow};
      };
      final key = GlobalKey();
      await tester.pumpWidget(
        ProviderScope(
          overrides: fake.overrides,
          child: MaterialApp(
            key: key,
            home: const Scaffold(body: WorkflowDialog(departmentId: 'd1')),
          ),
        ),
      );
      final container = ProviderScope.containerOf(key.currentContext!);
      container.read(officeProvider);
      fake.emitHello(
        departments: [fakeDepartment('d1', headId: 'h')],
        members: [fakeMember('h', rank: 'head', status: 'idle')],
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), '목표와 완료 기준');
      await tester.tap(find.text('대화 보내기'));
      await tester.pumpAndSettle();
      expect(
        fake.calls.where((c) => c.$1 == 'workflow.discuss').single.$2['text'],
        '목표와 완료 기준',
      );
      expect(fake.calls.where((c) => c.$1 == 'workflow.start'), isEmpty);
      await tester.tap(find.text('지금 바로 시작'));
      await tester.pumpAndSettle();
      expect(fake.calls.where((c) => c.$1 == 'workflow.start'), hasLength(1));
      expect(find.byType(TextField), findsOneWidget);
      workflow = {
        ...workflow!,
        'phase': 'review',
        'result': '전체 업무 완료',
        'meeting': {
          'participants': ['gone'],
          'participantNames': {'gone': '퇴근팀장'},
          'contributions': [],
        },
      };
      fake.pushNotification('workflow.changed', workflow!);
      await tester.pumpAndSettle();
      await tester.tap(find.text('작업 계획'));
      await tester.pumpAndSettle();
      expect(find.text('전체 업무 완료'), findsOneWidget);
      await tester.tap(find.text('회의'));
      await tester.pumpAndSettle();
      expect(find.text('참석자: 퇴근팀장'), findsOneWidget);
      await tester.tap(find.text('사용자가 직접 완료 처리'));
      await tester.pumpAndSettle();
      expect(
        fake.calls.where((c) => c.$1 == 'workflow.complete'),
        hasLength(1),
      );
      expect(find.text('전체 작업 완료'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  test('phase labels distinguish collecting, reviewing and decision', () {
    expect(
      workflowPhaseLabel({
        'phase': 'meeting',
        'meeting': {'state': 'collecting'},
      }),
      '회의 · 1차 의견',
    );
    expect(
      workflowPhaseLabel({
        'phase': 'meeting',
        'meeting': {'state': 'reviewing'},
      }),
      '회의 · 상호 검토',
    );
    expect(
      workflowPhaseLabel({
        'phase': 'meeting',
        'meeting': {'state': 'deciding'},
      }),
      '회의 · 부장 결정',
    );
  });
}
