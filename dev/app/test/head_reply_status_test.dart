import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/rpc/rpc_client.dart';
import 'package:pixel_office/state/office_state.dart';
import 'package:pixel_office/workflow/workflow_panel.dart';
import 'command/fake_rpc_client.dart';

void main() {
  test(
    'only a final head message completes an answer; idle and connection loss do not',
    () {
      final pending = <String, dynamic>{
        'phase': 'clarifying',
        'messages': [
          {'role': 'user', 'text': '질문'},
        ],
      };
      final completed = {
        ...pending,
        'messages': [
          ...pending['messages'] as List,
          {'role': 'head', 'text': '최종 답변'},
        ],
      };
      expect(
        headReplyPhase(pending, connected: true, status: MemberStatus.idle),
        HeadReplyPhase.preparing,
      );
      expect(
        headReplyPhase(pending, connected: true, status: MemberStatus.working),
        HeadReplyPhase.working,
      );
      expect(
        headReplyPhase(completed, connected: true, status: MemberStatus.idle),
        HeadReplyPhase.complete,
      );
      expect(
        headReplyPhase(
          completed,
          connected: true,
          status: MemberStatus.working,
        ),
        HeadReplyPhase.working,
      );
      expect(
        headReplyPhase(completed, connected: false, status: MemberStatus.idle),
        HeadReplyPhase.disconnected,
      );
      expect(
        headReplyPhase(pending, connected: true, status: MemberStatus.error),
        HeadReplyPhase.interrupted,
      );
      expect(
        headReplyPhase(
          pending,
          connected: true,
          status: MemberStatus.suspended,
        ),
        HeadReplyPhase.interrupted,
      );
      expect(
        headReplyPhase(pending, connected: true),
        HeadReplyPhase.interrupted,
      );
      expect(
        headReplyPhase(
          pending,
          connected: true,
          status: MemberStatus.idle,
          derived: DerivedStatus.waitingApproval,
        ),
        HeadReplyPhase.approval,
      );
      expect(
        headReplyPhase(
          pending,
          connected: true,
          status: MemberStatus.idle,
          derived: DerivedStatus.waitingAnswer,
        ),
        HeadReplyPhase.question,
      );
      expect(
        headReplyPhase(
          {...pending, 'phase': 'meeting'},
          connected: true,
          status: MemberStatus.working,
        ),
        HeadReplyPhase.none,
      );
      expect(headReplyPhase(null, connected: true), HeadReplyPhase.none);
      for (final phase in ['meeting', 'executing', 'blocked', 'review']) {
        final followup = {
          ...pending,
          'phase': phase,
          'messages': [
            {'role': 'user', 'text': '진행 상황?', 'followup': true},
          ],
        };
        expect(
          headReplyPhase(followup, connected: true, status: MemberStatus.idle),
          HeadReplyPhase.preparing,
        );
        final reply = {
          ...followup,
          'messages': [
            ...followup['messages'] as List,
            {'role': 'head', 'text': '현재 상황', 'followup': true},
          ],
        };
        expect(
          headReplyPhase(reply, connected: true, status: MemberStatus.idle),
          HeadReplyPhase.complete,
        );
      }
    },
  );

  testWidgets(
    'reply progress stays visible outside the dialog, completes on the final reply, and resets for the next question',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 720);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      var workflow = <String, dynamic>{
        'departmentId': 'd1',
        'phase': 'clarifying',
        'brief': '작업 목표',
        'messages': [
          {'role': 'user', 'text': '첫 번째 질문'},
        ],
        'assignments': [],
      };
      final fake = FakeRpcClient(
        responder: (method, params) {
          if (method == 'workflow.discuss') {
            workflow = {
              ...workflow,
              'messages': [
                ...workflow['messages'] as List,
                {'role': 'user', 'text': params['text']},
              ],
            };
          }
          return {'workflow': workflow};
        },
      );
      addTearDown(fake.close);
      final key = GlobalKey();
      await tester.pumpWidget(
        ProviderScope(
          overrides: fake.overrides,
          child: MaterialApp(
            key: key,
            home: const Scaffold(body: WorkflowBar()),
          ),
        ),
      );
      final container = ProviderScope.containerOf(key.currentContext!);
      container.read(officeProvider);
      fake.emitHello(
        departments: [fakeDepartment('d1', headId: 'h')],
        members: [fakeMember('h', rank: 'head')],
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('headReply.preparing')).hitTestable(),
        findsOneWidget,
      );
      await tester.tap(find.text('부장과 대화 · 회의 보기'));
      await tester.pumpAndSettle();
      fake.pushNotification('member.status', {
        'memberId': 'h',
        'status': 'working',
        'derived': 'working',
      });
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('headReply.working')).hitTestable(),
        findsOneWidget,
      );
      fake.pushNotification('member.status', {
        'memberId': 'h',
        'status': 'idle',
        'derived': 'waiting_approval',
      });
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('headReply.approval')).hitTestable(),
        findsOneWidget,
      );
      fake.pushNotification('member.status', {
        'memberId': 'h',
        'status': 'working',
        'derived': 'working',
      });
      workflow = {
        ...workflow,
        'messages': [
          ...workflow['messages'] as List,
          {'role': 'head', 'text': '최종 답변입니다.'},
        ],
      };
      fake.pushNotification('workflow.changed', workflow);
      fake.pushNotification('member.status', {
        'memberId': 'h',
        'status': 'idle',
        'derived': 'free',
      });
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('headReply.complete')).hitTestable(),
        findsOneWidget,
      );
      expect(find.text('부장 · 답변 완료'), findsOneWidget);
      await tester.tap(find.byTooltip('닫기'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('headReply.complete')).hitTestable(),
        findsOneWidget,
      );
      await tester.tap(find.text('부장과 대화 · 회의 보기'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('headReply.complete')).hitTestable(),
        findsOneWidget,
        reason: 'reopening retains final-reply state',
      );
      await tester.enterText(find.byType(TextField), '다음 질문');
      await tester.tap(find.text('대화 보내기'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('headReply.preparing')).hitTestable(),
        findsOneWidget,
      );
      expect(find.byKey(const Key('headReply.complete')), findsNothing);
      fake.setState(RpcConnectionState.disconnected);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('headReply.disconnected')).hitTestable(),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );
}
