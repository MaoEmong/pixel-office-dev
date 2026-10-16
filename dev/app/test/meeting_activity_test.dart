import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_view.dart' show officeSceneProvider;
import 'package:pixel_office/state/office_state.dart';
import 'package:pixel_office/workflow/meeting_activity.dart';
import 'package:pixel_office/workflow/workflow_panel.dart';
import 'command/fake_rpc_client.dart';

Map<String, dynamic> meeting() => {
  'departmentId': 'd1',
  'phase': 'meeting',
  'brief': '사원 관리 프로그램의 구현 계획',
  'assignments': [],
  'messages': [],
  'meeting': {
    'round': 1,
    'state': 'collecting',
    'participants': ['l1', 'l2'],
    'contributions': [],
  },
};

void main() {
  testWidgets('질문 수신자가 상태와 말풍선에 표시되고 답변 후 함께 사라진다', (tester) async {
    final w = {...meeting(), 'phase': 'executing', 'assignments': [{'leadId': 'l1', 'status': 'assigned'}]};
    final fake = FakeRpcClient(responder: (_, _) => {'workflow': w});
    addTearDown(fake.close);
    final key = GlobalKey();
    await tester.pumpWidget(ProviderScope(overrides: fake.overrides,
        child: MaterialApp(key: key, home: const SizedBox.shrink())));
    final container = ProviderScope.containerOf(key.currentContext!);
    container.read(officeProvider);
    final members = [
      fakeMember('h', rank: 'head', name: '부장'),
      fakeMember('l1', rank: 'lead', name: '프론트팀장', parentId: 'h'),
      fakeMember('w', name: '디자이너', parentId: 'l1'),
    ];
    final questions = [
      {'id': 'q1', 'memberId': 'w', 'type': 'question', 'status': 'open', 'createdAt': 'c',
        'payload': {'source': 'ask_parent', 'to': 'l1', 'question': '디자인을 확정할까요?'}},
      {'id': 'q2', 'memberId': 'h', 'type': 'question', 'status': 'open', 'createdAt': 'c',
        'payload': {'source': 'ask_user', 'question': '배포할까요?'}},
    ];
    fake.emitHello(departments: [fakeDepartment('d1', headId: 'h')], members: members, pending: questions);
    await tester.pumpAndSettle();
    final labels = container.read(meetingActivityLabelsProvider('d1'));
    expect(labels['w'], '프론트팀장(팀장) 답변 대기');
    expect(labels['h'], '사용자 답변 대기');
    final scene = container.read(officeSceneProvider('d1'));
    expect(scene.memberById('w')!.summary, labels['w']);
    expect(scene.memberById('h')!.summary, labels['h']);
    expect(scene.memberById('w')!.isQueued, isFalse);
    expect(scene.queue.single.memberId, 'h');
    expect(scene.memberById('w')!.askParentDeskIndex, isNotNull);

    // 받는 사람이 생략된 옛 질문도 직속 상사의 이름을 표시한다.
    final legacy = Pending.fromJson({...questions.first, 'payload': {'source': 'ask_parent'}});
    expect(legacy.questionRecipientLabel(container.read(membersProvider)), '프론트팀장(팀장)');
    expect(legacy.questionRecipientLabel(const {}), '상사');

    fake.emitHello(departments: [fakeDepartment('d1', headId: 'h')], members: members);
    await tester.pumpAndSettle();
    expect(container.read(meetingActivityLabelsProvider('d1'))['w'], isNull);
    expect(container.read(officeSceneProvider('d1')).memberById('w')!.summary,
        isNot(contains('답변 대기')));
  });

  test(
    'an idle lead with queued planned work is shown as waiting for prerequisite work',
    () {
      final head = Member.fromJson(fakeMember('h', rank: 'head'));
      final backend = Member.fromJson(
        fakeMember('l1', rank: 'lead', status: 'idle'),
      );
      final docs = Member.fromJson(
        fakeMember('l2', rank: 'lead', status: 'working'),
      );
      final w = {
        ...meeting(),
        'phase': 'executing',
        'assignments': [
          {'leadId': 'l2', 'status': 'assigned'},
          {
            'leadId': 'l1',
            'status': 'queued',
            'dependsOn': ['l2'],
          },
        ],
      };
      expect(
        meetingMemberActivity(w, backend, DerivedStatus.free),
        '선행 업무 완료 대기',
      );
      expect(
        meetingMemberActivity(w, docs, DerivedStatus.working),
        '배정 업무 진행 중',
      );
      expect(
        meetingMemberActivity(w, head, DerivedStatus.waitingReports),
        '팀별 업무 진행 · 보고 대기',
      );
      expect(
        meetingMemberActivity(
          {...w, 'phase': 'blocked'},
          backend,
          DerivedStatus.free,
        ),
        '작업 중단 · 문제 확인 필요',
      );
    },
  );
  testWidgets(
    'recovering a blocked meeting reconnects failed participants before resuming, without replacing the meeting',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 720);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final w = {...meeting(), 'phase': 'blocked', 'problem': '모델 확인 필요'};
      final fake = FakeRpcClient(
        responder: (method, params) => {'workflow': w},
      );
      addTearDown(fake.close);
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
        members: [
          fakeMember('h', rank: 'head'),
          fakeMember('l1', rank: 'lead', status: 'exited'),
          fakeMember('l2', rank: 'lead', status: 'error'),
        ],
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('참석자 복구 후 회의 재개'));
      await tester.pumpAndSettle();
      final requests = fake.calls
          .where((c) => c.$1 == 'member.rehire' || c.$1 == 'workflow.resume')
          .toList();
      expect(requests.map((r) => r.$1), ['workflow.resume']);
      expect(requests.single.$2['departmentId'], 'd1');
      expect(fake.calls.any((c) => c.$1 == 'workflow.start'), false);
      expect(tester.takeException(), isNull);
    },
  );
  test(
    'meeting roles replace idle with pending, writing, submitted, review, decision, and blocked states',
    () {
      final lead = Member.fromJson(
        fakeMember('l1', rank: 'lead', status: 'idle'),
      );
      final head = Member.fromJson(fakeMember('h', rank: 'head'));
      final w = meeting();
      final m = w['meeting'] as Map;
      expect(meetingMemberActivity(w, lead, DerivedStatus.free), '1차 의견 제출 대기');
      expect(
        meetingMemberActivity(
          w,
          Member.fromJson(fakeMember('l1', rank: 'lead', status: 'working')),
          DerivedStatus.working,
        ),
        '1차 의견 작성 중',
      );
      expect(
        meetingMemberActivity(w, head, DerivedStatus.free),
        '1차 회의 진행 · 참석자 의견 대기',
      );
      m['contributions'] = [
        {'memberId': 'l1', 'round': 1, 'text': '계획'},
      ];
      expect(
        meetingMemberActivity(w, lead, DerivedStatus.free),
        '1차 의견 제출 완료 · 다음 차례 대기',
      );
      m['round'] = 2;
      m['state'] = 'reviewing';
      expect(meetingMemberActivity(w, lead, DerivedStatus.free), '2차 의견 제출 대기');
      m['state'] = 'deciding';
      expect(
        meetingMemberActivity(w, head, DerivedStatus.free),
        '의견 조율 · 회의 결정 중',
      );
      expect(
        meetingMemberActivity(w, lead, DerivedStatus.free),
        '의견 제출 완료 · 부장 결정 대기',
      );
      w['phase'] = 'blocked';
      expect(
        meetingMemberActivity(w, lead, DerivedStatus.free),
        '회의 중단 · 문제 확인 필요',
      );
      expect(
        meetingMemberActivity(
          w,
          Member.fromJson(fakeMember('l1', rank: 'lead', status: 'error')),
          DerivedStatus.error,
        ),
        isNull,
      );
      expect(meetingMemberActivity(null, lead, DerivedStatus.free), isNull);
    },
  );

  testWidgets(
    'meeting topic, live contributions, round counts and office desk labels update together',
    (tester) async {
      tester.view.physicalSize = const Size(1264, 713);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      var w = meeting();
      final fake = FakeRpcClient(
        responder: (method, params) => {'workflow': w},
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
        members: [
          fakeMember('h', rank: 'head'),
          fakeMember('l1', rank: 'lead', name: '백엔드팀장'),
          fakeMember('l2', rank: 'lead', name: '프론트팀장'),
        ],
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('회의 안건: 사원 관리 프로그램'), findsOneWidget);
      expect(find.textContaining('의견 0/2명'), findsOneWidget);
      expect(
        container
            .read(officeSceneProvider('d1'))
            .members
            .firstWhere((m) => m.id == 'l1')
            .summary,
        '1차 의견 제출 대기',
      );
      w = {
        ...w,
        'meeting': {
          ...w['meeting'] as Map,
          'contributions': [
            {'memberId': 'l1', 'round': 1, 'text': '데이터 구조를 먼저 정리하겠습니다.'},
          ],
        },
      };
      fake.pushNotification('workflow.changed', w);
      await tester.pumpAndSettle();
      expect(find.textContaining('의견 1/2명'), findsOneWidget);
      expect(find.textContaining('최근 발언 · 백엔드팀장: 데이터 구조'), findsOneWidget);
      expect(
        container
            .read(officeSceneProvider('d1'))
            .members
            .firstWhere((m) => m.id == 'l1')
            .summary,
        '1차 의견 제출 완료 · 다음 차례 대기',
      );
      await tester.tap(find.text('부장과 대화 · 회의 보기'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('회의'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('meeting.progress')).hitTestable(),
        findsOneWidget,
      );
      expect(
        find.textContaining('데이터 구조를 먼저 정리하겠습니다.').hitTestable(),
        findsWidgets,
      );
      w = {...w, 'phase': 'blocked', 'problem': '프론트팀장의 모델 오류입니다.'};
      fake.pushNotification('workflow.changed', w);
      await tester.pumpAndSettle();
      expect(
        find.textContaining('회의 중단 · 프론트팀장의 모델 오류입니다.').hitTestable(),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );
}
