// 상단 바 레이아웃 v2(T40-5): 부서 탭 폴더 아이콘 + 툴팁 cwd, "보고 N" 배지(클릭 = 부장 + 보고서 탭),
// "대기 N" 은 인박스와 같은 수(사용자 몫만).
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/panel/panel_tabs.dart';
import 'package:pixel_office/state/office_state.dart';
import 'package:pixel_office/state/selection.dart';
import 'package:pixel_office/topbar/top_bar.dart';

import 'fake_rpc_client.dart';

Future<ProviderContainer> pumpTopBar(WidgetTester tester, FakeRpcClient fake, {String? selected}) async {
  tester.view.physicalSize = const Size(1400, 800);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(ProviderScope(
    overrides: fake.overrides,
    child: MaterialApp(home: Scaffold(body: Column(children: [TopBar(selectedMemberId: selected), const Spacer()]))),
  ));
  await tester.pump();
  return ProviderScope.containerOf(tester.element(find.byType(TopBar)));
}

Map<String, dynamic> approvalRow(String id, String memberId) => {
      'id': id,
      'memberId': memberId,
      'type': 'approval',
      'payload': {'tool_name': 'Bash', 'tool_input': {}},
      'status': 'open',
      'createdAt': '2026-09-17T01:00:00.000Z',
      'answeredAt': null,
      'answer': null,
    };

Map<String, dynamic> askParentRow(String id, String memberId) => {
      'id': id,
      'memberId': memberId,
      'type': 'question',
      'payload': {'source': 'ask_parent', 'question': '?', 'from': memberId, 'to': 'mH'},
      'status': 'open',
      'createdAt': '2026-09-17T02:00:00.000Z',
      'answeredAt': null,
      'answer': null,
    };

void main() {
  late FakeRpcClient fake;

  setUp(() => fake = FakeRpcClient());
  tearDown(() async => fake.close());

  testWidgets('부서 탭은 폴더 아이콘 + 이름, 툴팁은 cwd', (tester) async {
    await pumpTopBar(tester, fake);
    fake.emitHello(departments: [
      fakeDepartment('d1', name: 'alpha', cwd: r'D:\proj\alpha'),
      fakeDepartment('d2', name: 'beta', cwd: r'D:\proj\beta', createdAt: 'd'),
    ]);
    await tester.pump();
    await tester.pump();
    expect(find.text('alpha'), findsOneWidget);
    expect(find.text('beta'), findsOneWidget);
    // 활성 탭은 채운 폴더, 나머지는 외곽선 폴더.
    expect(find.byIcon(Icons.folder), findsOneWidget);
    expect(find.byIcon(Icons.folder_outlined), findsOneWidget);
    expect(find.byTooltip(r'D:\proj\alpha'), findsOneWidget);
  });

  testWidgets('"대기 N" 은 사용자 몫만 센다 — ask_parent 는 빠진다', (tester) async {
    await pumpTopBar(tester, fake);
    fake.emitHello(
      departments: [fakeDepartment('d1', headId: 'mH')],
      members: [fakeMember('mH', rank: 'head', name: '부장'), fakeMember('m1', name: '하루')],
      pending: [approvalRow('a1', 'm1'), askParentRow('p1', 'm1')],
    );
    await tester.pump();
    await tester.pump();
    expect(find.text('멤버 2 · 대기 1'), findsOneWidget);
  });

  testWidgets('"보고 N" 배지: 부장 보고가 오면 뜨고, 누르면 부장 선택 + 보고서 탭', (tester) async {
    final c = await pumpTopBar(tester, fake);
    fake.emitHello(
      departments: [fakeDepartment('d1', headId: 'mH')],
      members: [fakeMember('mH', rank: 'head', name: '부장'), fakeMember('m1', name: '하루')],
    );
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('topbar.reports')), findsNothing);

    c.read(officeProvider.notifier).applyEvent(OfficeEvent.fromJson({
      'seq': 5,
      'ts': '2026-09-17T03:00:00.000Z',
      'departmentId': 'd1',
      'teamId': null,
      'memberId': 'mH',
      'kind': 'reporting',
      'detail': {'summary': '끝'},
      'ref': {'taskId': 1},
    }));
    await tester.pump();
    expect(find.byKey(const Key('topbar.reports')), findsOneWidget);
    expect(find.text('보고 1'), findsOneWidget);

    await tester.tap(find.byKey(const Key('topbar.reports')));
    await tester.pump();
    expect(c.read(selectedMemberIdProvider), 'mH');
    expect(c.read(panelTabRequestProvider)?.tab, RightPanelTab.report);
  });

  testWidgets('부하의 보고는 상단 바 "보고 N" 에 세지 않는다(사용자에게 오는 것은 부장 보고뿐)', (tester) async {
    final c = await pumpTopBar(tester, fake);
    fake.emitHello(
      departments: [fakeDepartment('d1', headId: 'mH')],
      members: [fakeMember('mH', rank: 'head', name: '부장'), fakeMember('m1', name: '하루')],
    );
    await tester.pump();
    await tester.pump();
    c.read(officeProvider.notifier).applyEvent(OfficeEvent.fromJson({
      'seq': 6,
      'ts': '2026-09-17T03:00:00.000Z',
      'departmentId': 'd1',
      'teamId': 't1',
      'memberId': 'm1',
      'kind': 'reporting',
      'detail': {'summary': '팀원 보고'},
      'ref': {'taskId': 2},
    }));
    await tester.pump();
    expect(find.byKey(const Key('topbar.reports')), findsNothing);
  });
}
