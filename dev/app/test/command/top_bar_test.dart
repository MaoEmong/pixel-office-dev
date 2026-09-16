// TopBar(T37 rev 3): 연결 칩(버전·pid)·개수, **부서 탭** → selectedDepartmentIdProvider,
// "부서 만들기" 다이얼로그(이름·cwd 검증 → department.create{name, cwd, headEngine, headName} → 부장 선택),
// 부서 삭제 메뉴 → department.delete, 비상 퇴근 확인(경고 문구) → member.clockOut, 직급 배지.
// 출근 버튼은 없다(D-32: 사용자는 팀장·팀원을 직접 출근시키지 않는다).
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/rpc/rpc_client.dart';
import 'package:pixel_office/state/office_state.dart';
import 'package:pixel_office/state/selection.dart';
import 'package:pixel_office/topbar/top_bar.dart';

import 'fake_rpc_client.dart';

/// 기본 테스트 화면(800px)은 상단 바가 넘치므로 데스크탑 크기로.
Future<void> pumpApp(WidgetTester tester, FakeRpcClient fake, {String? selectedMemberId}) async {
  tester.view.physicalSize = const Size(1400, 800);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(ProviderScope(
    overrides: fake.overrides,
    child: MaterialApp(home: Scaffold(body: Column(children: [TopBar(selectedMemberId: selectedMemberId), const Spacer()]))),
  ));
}

/// 스트림으로 밀어 넣은 뒤: 첫 pump 가 마이크로태스크(리스너 → setState)를, 둘째 pump 가 프레임을.
Future<void> pump2(WidgetTester tester) async {
  await tester.pump();
  await tester.pump();
}

ProviderContainer containerOf(WidgetTester tester) => ProviderScope.containerOf(tester.element(find.byType(TopBar)));

void main() {
  late FakeRpcClient fake;

  setUp(() => fake = FakeRpcClient());
  tearDown(() async => fake.close());

  testWidgets('연결 칩: 끊김 → 연결됨 v버전 · pid, 멤버·대기 개수', (tester) async {
    await pumpApp(tester, fake);
    expect(find.text('데몬 연결 안 됨'), findsOneWidget);
    expect(find.text('멤버 0 · 대기 0'), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byKey(const Key('topbar.createDepartment'))).onPressed, isNull);

    fake.setState(RpcConnectionState.connecting);
    await pump2(tester);
    expect(find.text('데몬 연결 중'), findsOneWidget);

    fake.emitHello(
      version: '1.2.3',
      pid: 777,
      departments: [fakeDepartment('d1')],
      teams: [fakeTeam('t1')],
      members: [fakeMember('m1', status: 'waiting_approval'), fakeMember('m2')],
      pending: [
        {'id': 'a1', 'memberId': 'm1', 'type': 'approval', 'payload': {'tool_name': 'Bash', 'tool_input': {}}, 'status': 'open', 'createdAt': 'c', 'answeredAt': null, 'answer': null},
      ],
    );
    await pump2(tester);
    expect(find.text('데몬 v1.2.3 · pid 777'), findsOneWidget);
    expect(find.text('멤버 2 · 대기 1'), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byKey(const Key('topbar.createDepartment'))).onPressed, isNotNull);
  });

  testWidgets('T37: 출근 버튼이 없다 — 사용자가 만드는 것은 부서뿐', (tester) async {
    await pumpApp(tester, fake);
    fake.emitHello(departments: [fakeDepartment('d1')]);
    await pump2(tester);
    expect(find.byKey(const Key('topbar.clockIn')), findsNothing);
    expect(find.text('출근'), findsNothing);
    expect(find.text('부서 만들기'), findsOneWidget);
  });

  testWidgets('부서 탭 클릭 → selectedDepartmentIdProvider; 기본은 첫 부서(activeDepartmentIdProvider)', (tester) async {
    await pumpApp(tester, fake);
    fake.emitHello(departments: [
      fakeDepartment('d1', name: 'alpha', createdAt: '1'),
      fakeDepartment('d2', name: 'beta', createdAt: '2'),
    ]);
    await pump2(tester);
    final c = containerOf(tester);
    expect(c.read(selectedDepartmentIdProvider), isNull);
    expect(c.read(activeDepartmentIdProvider), 'd1');

    await tester.tap(find.text('beta'));
    await tester.pump();
    expect(c.read(selectedDepartmentIdProvider), 'd2');
    expect(c.read(activeDepartmentIdProvider), 'd2');

    // 고른 부서가 사라지면 첫 부서로 폴백.
    fake.emitHello(departments: [fakeDepartment('d1', name: 'alpha', createdAt: '1')]);
    await pump2(tester);
    expect(c.read(selectedDepartmentIdProvider), 'd2');
    expect(c.read(activeDepartmentIdProvider), 'd1');
  });

  testWidgets('부서 만들기: 이름·cwd 비면 오류, 채우면 department.create{name,cwd,headEngine,headName} → 부장 선택', (tester) async {
    fake.responder = (m, p) => switch (m) {
          'department.create' => {
              'department': fakeDepartment('dNew', name: p['name'] as String, headId: 'mH'),
              'head': fakeMember('mH', name: (p['headName'] as String?) ?? '부장', rank: 'head', status: 'starting', departmentId: 'dNew'),
            },
          _ => <String, dynamic>{},
        };
    await pumpApp(tester, fake);
    fake.emitHello();
    await pump2(tester);
    expect(find.byKey(const Key('topbar.noDepartments')), findsOneWidget);

    await tester.tap(find.byKey(const Key('topbar.createDepartment')));
    await tester.pumpAndSettle();
    expect(find.byType(CreateDepartmentDialog), findsOneWidget);
    expect(find.byKey(const Key('createDepartment.headHint')), findsOneWidget);

    await tester.tap(find.byKey(const Key('createDepartment.submit')));
    await tester.pump();
    expect(find.text('부서 이름을 입력하세요'), findsOneWidget);
    expect(find.text('작업 폴더 경로를 입력하세요'), findsOneWidget);
    expect(fake.calls, isEmpty);

    await tester.enterText(find.byKey(const Key('createDepartment.name')), 'alpha');
    await tester.enterText(find.byKey(const Key('createDepartment.cwd')), r'D:\myproject\pixel-office');
    await tester.enterText(find.byKey(const Key('createDepartment.headName')), '반장');
    await tester.tap(find.descendant(of: find.byKey(const Key('createDepartment.headEngine')), matching: find.text('codex')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('createDepartment.submit')));
    await tester.pumpAndSettle();

    expect(fake.callList, [
      ['department.create', {'name': 'alpha', 'cwd': r'D:\myproject\pixel-office', 'headEngine': 'codex', 'headName': '반장'}],
    ]);
    final c = containerOf(tester);
    expect(c.read(selectedDepartmentIdProvider), 'dNew');
    // 새 부서에서 처음 고르는 멤버는 부장이다 — 지시는 부장에게만 간다.
    expect(c.read(selectedMemberIdProvider), 'mH');
    // 응답의 부서·부장은 스냅샷을 기다리지 않고 바로 상태에 들어간다(탭·지시 대상이 곧바로 잡힌다).
    expect(c.read(departmentsProvider).keys, ['dNew']);
    expect(c.read(liveHeadProvider('dNew'))?.id, 'mH'); // starting 은 아직 살아 있는 부장
    expect(find.byType(CreateDepartmentDialog), findsNothing);
  });

  testWidgets('부서 만들기: 부장 이름을 비우면 headName 을 안 보낸다(데몬 기본 "부장")', (tester) async {
    fake.responder = (m, p) => switch (m) {
          'department.create' => {
              'department': fakeDepartment('dNew', name: p['name'] as String, headId: 'mH'),
              'head': fakeMember('mH', name: kDefaultHeadName, rank: 'head', status: 'starting', departmentId: 'dNew'),
            },
          _ => <String, dynamic>{},
        };
    await pumpApp(tester, fake);
    fake.emitHello();
    await pump2(tester);

    await tester.tap(find.byKey(const Key('topbar.createDepartment')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('createDepartment.name')), 'alpha');
    await tester.enterText(find.byKey(const Key('createDepartment.cwd')), r'D:\myproject\pixel-office');
    await tester.tap(find.byKey(const Key('createDepartment.submit')));
    await tester.pumpAndSettle();

    expect(fake.callList, [
      ['department.create', {'name': 'alpha', 'cwd': r'D:\myproject\pixel-office', 'headEngine': 'claude'}],
    ]);
  });

  testWidgets('부서 만들기 RPC 오류는 다이얼로그 안에 표시되고 닫히지 않는다', (tester) async {
    fake.responder = (m, p) => throw const RpcException(RpcException.invalidParams, 'cwd 가 폴더가 아닙니다');
    await pumpApp(tester, fake);
    fake.emitHello();
    await pump2(tester);
    await tester.tap(find.byKey(const Key('topbar.createDepartment')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('createDepartment.name')), 'alpha');
    await tester.enterText(find.byKey(const Key('createDepartment.cwd')), r'D:\없는폴더');
    await tester.tap(find.byKey(const Key('createDepartment.submit')));
    await tester.pumpAndSettle();
    expect(find.byType(CreateDepartmentDialog), findsOneWidget);
    expect(find.text('cwd 가 폴더가 아닙니다 (-32602)'), findsOneWidget);
  });

  testWidgets('부서 메뉴 → 삭제 → 확인 → department.delete, 상태에서 그 부서 트리가 빠진다', (tester) async {
    await pumpApp(tester, fake);
    fake.emitHello(
      departments: [fakeDepartment('d1', name: 'alpha', headId: 'mH')],
      teams: [fakeTeam('t1', leaderId: 'mL')],
      members: [fakeMember('mH', rank: 'head'), fakeMember('mL', rank: 'lead', parentId: 'mH')],
    );
    await pump2(tester);

    await tester.tap(find.byKey(const Key('topbar.departmentMenu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('topbar.deleteDepartment')));
    await tester.pumpAndSettle();
    expect(find.textContaining('부서 "alpha" 을(를) 지울까요?'), findsOneWidget);

    await tester.tap(find.text('취소'));
    await tester.pumpAndSettle();
    expect(fake.calls, isEmpty);

    await tester.tap(find.byKey(const Key('topbar.departmentMenu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('topbar.deleteDepartment')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('deleteDepartment.confirm')));
    await tester.pumpAndSettle();

    expect(fake.callList, [['department.delete', {'departmentId': 'd1'}]]);
    final c = containerOf(tester);
    expect(c.read(departmentsProvider), isEmpty);
    expect(c.read(teamsProvider), isEmpty);
    expect(c.read(membersProvider), isEmpty);
  });

  testWidgets('직급 배지: 부장/팀장은 이름 옆에 배지, 팀원이면 없다', (tester) async {
    await pumpApp(tester, fake, selectedMemberId: 'mH');
    fake.emitHello(
      departments: [fakeDepartment('d1', headId: 'mH')],
      teams: [fakeTeam('t1', leaderId: 'mL')],
      members: [
        fakeMember('mH', name: '부장', rank: 'head'),
        fakeMember('mL', name: '반장', rank: 'lead', parentId: 'mH'),
        fakeMember('m1', name: '이음', parentId: 'mL'),
      ],
    );
    await pump2(tester);
    expect(find.byKey(const Key('topbar.rankBadge')), findsOneWidget);
    expect(find.text('부장'), findsWidgets);
    expect(find.text('부장 [claude]'), findsOneWidget);

    await pumpApp(tester, fake, selectedMemberId: 'mL');
    await pump2(tester);
    expect(find.byKey(const Key('topbar.rankBadge')), findsOneWidget);
    expect(find.text('팀장'), findsOneWidget);

    // 팀원을 고르면 배지가 사라진다.
    await pumpApp(tester, fake, selectedMemberId: 'm1');
    await pump2(tester);
    expect(find.byKey(const Key('topbar.rankBadge')), findsNothing);
    expect(find.text('이음 [claude]'), findsOneWidget);
  });

  testWidgets('비상 퇴근: 경고 문구가 있는 확인 → member.clockOut', (tester) async {
    await pumpApp(tester, fake, selectedMemberId: 'mH');
    fake.emitHello(
      departments: [fakeDepartment('d1', headId: 'mH')],
      members: [fakeMember('mH', name: '부장', rank: 'head')],
    );
    await pump2(tester);
    expect(find.text('부장 [claude]'), findsOneWidget);

    await tester.tap(find.byKey(const Key('topbar.clockOut')));
    await tester.pumpAndSettle();
    expect(find.textContaining('퇴근시킬까요'), findsOneWidget);
    expect(find.text(clockOutEmergencyWarning), findsOneWidget);
    await tester.tap(find.text('취소'));
    await tester.pumpAndSettle();
    expect(fake.calls, isEmpty);

    await tester.tap(find.byKey(const Key('topbar.clockOut')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('clockOut.confirm')));
    await tester.pumpAndSettle();
    expect(fake.callList, [['member.clockOut', {'memberId': 'mH'}]]);
  });

  testWidgets('퇴근 버튼은 이미 exited 인 멤버면 비활성', (tester) async {
    await pumpApp(tester, fake, selectedMemberId: 'm1');
    fake.emitHello(
      departments: [fakeDepartment('d1')],
      teams: [fakeTeam('t1')],
      members: [fakeMember('m1', status: 'exited')],
    );
    await pump2(tester);
    expect(tester.widget<IconButton>(find.byKey(const Key('topbar.clockOut'))).onPressed, isNull);
  });
}
