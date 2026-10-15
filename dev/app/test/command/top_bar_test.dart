// TopBar(T37 rev 3): 연결 칩(버전·pid)·개수, **부서 탭** → selectedDepartmentIdProvider,
// "부서 만들기" 다이얼로그(이름·cwd 검증 → department.create{name, cwd, headEngine, headName} → 부장 선택),
// 부서 삭제 메뉴 → department.delete, 비상 퇴근 확인(경고 문구) → member.clockOut, 직급 배지.
// 출근 버튼은 없다(D-32: 사용자는 팀장·팀원을 직접 출근시키지 않는다).
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/rpc/rpc_client.dart';
import 'package:pixel_office/state/office_state.dart';
import 'package:pixel_office/state/selection.dart';
import 'package:pixel_office/topbar/top_bar.dart';

import 'fake_rpc_client.dart';

/// 이 파일에서 "있는 폴더" 로 치는 경로(T41: 만들기는 폴더가 실제로 있을 때만 켜진다).
const String existingFolder = r'D:\myproject\pixel-office';

/// 기본 테스트 화면(800px)은 상단 바가 넘치므로 데스크탑 크기로.
/// 폴더 존재 확인은 [existingFolder] 만 true 인 가짜로 바꾼다 — 위젯 테스트에서 진짜 `dart:io` 를 부르면
/// fake-async 존에서 Future 가 끝나지 않는다(T41 함정).
Future<void> pumpApp(WidgetTester tester, FakeRpcClient fake, {String? selectedMemberId}) async {
  tester.view.physicalSize = const Size(1400, 800);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(ProviderScope(
    overrides: [
      ...fake.overrides,
      directoryExistsProvider.overrideWithValue((path) async => path == existingFolder),
    ],
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

  testWidgets('데몬 pill 3상태: 끊김 · 재시도 N회 → 연결 중 · N초 → 데몬 v버전 · pid; 멤버·대기 개수', (tester) async {
    await pumpApp(tester, fake);
    expect(find.text('끊김 · 재시도 0회'), findsOneWidget); // T40-5 D10
    expect(find.text('멤버 0 · 대기 0'), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byKey(const Key('topbar.createDepartment'))).onPressed, isNull);

    fake.setState(RpcConnectionState.connecting);
    await pump2(tester);
    expect(find.text('연결 중 · 0초'), findsOneWidget);
    // 노랑은 1Hz 로 점멸한다.
    expect(tester.widget<AnimatedOpacity>(find.byKey(const Key('topbar.daemon.dot'))).opacity, 1);
    await tester.pump(daemonBlinkHalfPeriod);
    expect(tester.widget<AnimatedOpacity>(find.byKey(const Key('topbar.daemon.dot'))).opacity, lessThan(1));
    await tester.pump(daemonBlinkHalfPeriod);
    expect(tester.widget<AnimatedOpacity>(find.byKey(const Key('topbar.daemon.dot'))).opacity, 1);

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

  testWidgets('부서 만들기: 폴더가 없으면 만들기가 꺼져 있고, 채우면 department.create{name,cwd,headEngine,headName} → 부장 선택', (tester) async {
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

    // 폴더를 아직 안 골랐으면 만들기는 꺼져 있다(눌러 보고 나서 오류를 보는 게 아니라 이유를 먼저 보여 준다).
    expect(tester.widget<FilledButton>(find.byKey(const Key('createDepartment.submit'))).onPressed, isNull);
    expect(find.text(createDepartmentPickFolderHint), findsOneWidget);
    expect(fake.calls, isEmpty);

    // 손으로 친 경로도 폴백으로 받는다 — 없는 폴더면 오류 문구 + 여전히 꺼짐.
    await tester.enterText(find.byKey(const Key('createDepartment.cwd')), r'D:\없는폴더');
    await tester.pumpAndSettle();
    expect(find.text(createDepartmentMissingFolder), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byKey(const Key('createDepartment.submit'))).onPressed, isNull);

    await tester.enterText(find.byKey(const Key('createDepartment.cwd')), existingFolder);
    await tester.pumpAndSettle();
    expect(find.text(createDepartmentMissingFolder), findsNothing);
    // 이름은 폴더 이름이 기본값으로 들어와 있다.
    expect(tester.widget<TextField>(find.byKey(const Key('createDepartment.name'))).controller?.text, 'pixel-office');

    await tester.enterText(find.byKey(const Key('createDepartment.name')), 'alpha');
    await tester.enterText(find.byKey(const Key('createDepartment.headName')), '반장');
    await tester.tap(find.descendant(of: find.byKey(const Key('createDepartment.headEngine')), matching: find.text('codex')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('createDepartment.submit')));
    await tester.pumpAndSettle();

    expect(fake.callList, [
      ['department.create', {'name': 'alpha', 'cwd': existingFolder, 'headEngine': 'codex', 'headName': '반장'}],
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
    await tester.enterText(find.byKey(const Key('createDepartment.cwd')), existingFolder);
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('createDepartment.name')), 'alpha');
    // 기본값 "부장" 을 지우면 headName 을 안 보낸다(데몬이 같은 기본값을 붙인다).
    await tester.enterText(find.byKey(const Key('createDepartment.headName')), '');
    await tester.tap(find.byKey(const Key('createDepartment.submit')));
    await tester.pumpAndSettle();

    expect(fake.callList, [
      ['department.create', {'name': 'alpha', 'cwd': existingFolder, 'headEngine': 'claude'}],
    ]);
  });

  testWidgets('부서 만들기 RPC 오류는 별도 팝업에 표시되고 생성 창은 유지된다', (tester) async {
    fake.responder = (m, p) => throw const RpcException(RpcException.invalidParams, 'cwd 가 폴더가 아닙니다');
    await pumpApp(tester, fake);
    fake.emitHello();
    await pump2(tester);
    await tester.tap(find.byKey(const Key('topbar.createDepartment')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('createDepartment.cwd')), existingFolder);
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('createDepartment.name')), 'alpha');
    await tester.tap(find.byKey(const Key('createDepartment.submit')));
    await tester.pumpAndSettle();
    expect(find.byType(CreateDepartmentDialog), findsOneWidget);
    expect(find.text('부서 생성 중 문제가 생겼어요').hitTestable(), findsOneWidget);
    expect(find.textContaining('cwd 가 폴더가 아닙니다').hitTestable(), findsOneWidget);
    await tester.tap(find.text('닫기'));
    await tester.pumpAndSettle();
    expect(find.byType(CreateDepartmentDialog), findsOneWidget);
  });

  // ---- U-02(D-51): 허가 방식 --------------------------------------------------------------------
  testWidgets('부서 만들기: 세부 설정은 접혀 있고 기본은 "전부 묻기" — 안 건드리면 approvalPolicy 를 안 보낸다', (tester) async {
    fake.responder = (m, p) => switch (m) {
          'department.create' => {
              'department': {...fakeDepartment('dNew', name: p['name'] as String, headId: 'mH'), 'approvalPolicy': p['approvalPolicy'] ?? 'ask'},
              'head': fakeMember('mH', rank: 'head', status: 'starting', departmentId: 'dNew'),
            },
          _ => <String, dynamic>{},
        };
    await pumpApp(tester, fake);
    fake.emitHello();
    await pump2(tester);
    await tester.tap(find.byKey(const Key('topbar.createDepartment')));
    await tester.pumpAndSettle();

    // 접혀 있어도 지금 값이 보인다.
    expect(find.byKey(const Key('createDepartment.approvalPolicy')), findsNothing);
    expect(find.text('허가 방식: 전부 묻기'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('createDepartment.cwd')), existingFolder);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('createDepartment.submit')));
    await tester.pumpAndSettle();
    expect(fake.callList.single[1], isNot(contains('approvalPolicy')), reason: '이 키를 모르는 옛 데몬과도 그대로 맞는다');
    expect(containerOf(tester).read(departmentsProvider)['dNew']!.approvalPolicy, ApprovalPolicy.ask);
  });

  testWidgets('부서 만들기: 세부 설정에서 고르면 approvalPolicy 가 실리고, trust 에는 한계가 같이 보인다', (tester) async {
    fake.responder = (m, p) => switch (m) {
          'department.create' => {
              'department': {...fakeDepartment('dNew', name: p['name'] as String, headId: 'mH'), 'approvalPolicy': p['approvalPolicy'] ?? 'ask'},
              'head': fakeMember('mH', rank: 'head', status: 'starting', departmentId: 'dNew'),
            },
          _ => <String, dynamic>{},
        };
    await pumpApp(tester, fake);
    fake.emitHello();
    await pump2(tester);
    await tester.tap(find.byKey(const Key('topbar.createDepartment')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('createDepartment.cwd')), existingFolder);
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('createDepartment.advanced')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('createDepartment.approvalPolicy')), findsOneWidget);
    for (final p in ApprovalPolicy.values) {
      expect(find.text(p.label), findsOneWidget);
      expect(find.text(p.hint), findsOneWidget, reason: '무엇이 묻지 않고 넘어가는지 칸마다 적는다');
    }
    expect(find.text(approvalAlwaysAsksHint), findsOneWidget);

    await tester.tap(find.byKey(const Key('approvalPolicy.trust')));
    await tester.pumpAndSettle();
    expect(find.text(approvalTrustCaveat), findsOneWidget, reason: 'trust 는 보안 경계가 아니라는 한 줄');
    expect(find.text('허가 방식: 위험한 것만 묻기'), findsOneWidget);

    await tester.tap(find.byKey(const Key('approvalPolicy.edits')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('createDepartment.submit')));
    await tester.pumpAndSettle();
    expect(fake.callList.single[1], containsPair('approvalPolicy', 'edits'));
    expect(containerOf(tester).read(departmentsProvider)['dNew']!.approvalPolicy, ApprovalPolicy.edits);
  });

  testWidgets('부서 메뉴 → 허가 방식: 지금 값이 메뉴에 보이고, 바꾸면 department.update → 상태 갱신', (tester) async {
    fake.responder = (m, p) => switch (m) {
          'department.update' => {
              'department': {...fakeDepartment('d1', name: 'alpha', headId: 'mH'), 'approvalPolicy': p['approvalPolicy']},
            },
          _ => <String, dynamic>{},
        };
    await pumpApp(tester, fake);
    fake.emitHello(departments: [fakeDepartment('d1', name: 'alpha', headId: 'mH')], members: [fakeMember('mH', rank: 'head')]);
    await pump2(tester);

    await tester.tap(find.byKey(const Key('topbar.departmentMenu')));
    await tester.pumpAndSettle();
    expect(find.text('허가 방식 — 전부 묻기'), findsOneWidget);
    await tester.tap(find.byKey(const Key('topbar.approvalPolicy')));
    await tester.pumpAndSettle();
    expect(find.text('허가 방식 — alpha'), findsOneWidget);

    // 같은 값이면 "바꾸기" 가 꺼져 있다. 취소하면 아무것도 안 나간다.
    expect(tester.widget<FilledButton>(find.byKey(const Key('approvalPolicy.save'))).onPressed, isNull);
    await tester.tap(find.byKey(const Key('approvalPolicy.trust')));
    await tester.pumpAndSettle();
    expect(find.text(approvalTrustCaveat), findsOneWidget);
    await tester.tap(find.text('취소'));
    await tester.pumpAndSettle();
    expect(fake.calls, isEmpty);

    await tester.tap(find.byKey(const Key('topbar.departmentMenu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('topbar.approvalPolicy')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('approvalPolicy.edits')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('approvalPolicy.save')));
    await tester.pumpAndSettle();
    expect(fake.callList, [['department.update', {'departmentId': 'd1', 'approvalPolicy': 'edits'}]]);
    expect(containerOf(tester).read(departmentsProvider)['d1']!.approvalPolicy, ApprovalPolicy.edits);

    // 메뉴에도 바뀐 값이 보인다.
    await tester.tap(find.byKey(const Key('topbar.departmentMenu')));
    await tester.pumpAndSettle();
    expect(find.text('허가 방식 — 폴더 안 편집은 자동'), findsOneWidget);
  });

  testWidgets('허가 방식: 부서가 없으면 메뉴 항목이 꺼져 있고, RPC 오류는 스낵바로 알린다', (tester) async {
    fake.responder = (m, p) => throw const RpcException(RpcException.invalidParams, 'approvalPolicy must be ask|edits|trust');
    await pumpApp(tester, fake);
    fake.emitHello();
    await pump2(tester);
    await tester.tap(find.byKey(const Key('topbar.departmentMenu')));
    await tester.pumpAndSettle();
    expect(tester.widget<PopupMenuItem<String>>(find.byKey(const Key('topbar.approvalPolicy'))).enabled, isFalse);
    await tester.tapAt(const Offset(5, 400)); // 메뉴 닫기
    await tester.pumpAndSettle();

    fake.emitHello(departments: [fakeDepartment('d1', name: 'alpha', headId: 'mH')], members: [fakeMember('mH', rank: 'head')]);
    await pump2(tester);
    await tester.tap(find.byKey(const Key('topbar.departmentMenu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('topbar.approvalPolicy')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('approvalPolicy.trust')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('approvalPolicy.save')));
    await tester.pumpAndSettle();
    expect(find.textContaining('허가 방식을 바꾸지 못했습니다'), findsOneWidget);
    expect(containerOf(tester).read(departmentsProvider)['d1']!.approvalPolicy, ApprovalPolicy.ask, reason: '실패하면 그대로');
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
