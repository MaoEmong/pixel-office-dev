// TopBar: 연결 칩(버전·pid)·개수, 팀 탭 → selectedTeamIdProvider, 출근 다이얼로그(이름 검증 → clockIn{engine}),
// 팀 없을 때 인라인 팀 만들기 → team.create → clockIn, 퇴근 확인 → member.clockOut.
// T24: 팀 만들기가 팀장을 자동 출근시킨다(팀장 이름 필드, 팀원 이름은 선택, 생성 후 팀장 선택) + 팀장 배지.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/rpc/rpc_client.dart';
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
    expect(tester.widget<FilledButton>(find.byKey(const Key('topbar.clockIn'))).onPressed, isNull);

    fake.setState(RpcConnectionState.connecting);
    await pump2(tester);
    expect(find.text('데몬 연결 중'), findsOneWidget);

    fake.emitHello(
      version: '1.2.3',
      pid: 777,
      teams: [fakeTeam('t1')],
      members: [fakeMember('m1', status: 'waiting_approval'), fakeMember('m2')],
      pending: [
        {'id': 'a1', 'memberId': 'm1', 'type': 'approval', 'payload': {'tool_name': 'Bash', 'tool_input': {}}, 'status': 'open', 'createdAt': 'c', 'answeredAt': null, 'answer': null},
      ],
    );
    await pump2(tester);
    expect(find.text('데몬 v1.2.3 · pid 777'), findsOneWidget);
    expect(find.text('멤버 2 · 대기 1'), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byKey(const Key('topbar.clockIn'))).onPressed, isNotNull);
  });

  testWidgets('팀 탭 클릭 → selectedTeamIdProvider; 기본은 첫 팀(activeTeamIdProvider)', (tester) async {
    await pumpApp(tester, fake);
    fake.emitHello(teams: [fakeTeam('t1', name: 'pixel'), fakeTeam('t2', name: 'haru')]);
    await pump2(tester);
    final c = containerOf(tester);
    expect(c.read(selectedTeamIdProvider), isNull);
    expect(c.read(activeTeamIdProvider), 't1');

    await tester.tap(find.text('haru'));
    await tester.pump();
    expect(c.read(selectedTeamIdProvider), 't2');
    expect(c.read(activeTeamIdProvider), 't2');

    // 고른 팀이 사라지면 첫 팀으로 폴백.
    fake.emitHello(teams: [fakeTeam('t1', name: 'pixel')]);
    await pump2(tester);
    expect(c.read(selectedTeamIdProvider), 't2');
    expect(c.read(activeTeamIdProvider), 't1');
  });

  testWidgets('출근 다이얼로그: 이름 비면 오류, 이름+codex → member.clockIn{teamId, engine:codex, name, instructions}', (tester) async {
    fake.responder = (m, p) => m == 'member.clockIn' ? {'member': fakeMember('m9', name: p['name'] as String)} : <String, dynamic>{};
    await pumpApp(tester, fake);
    fake.emitHello(teams: [fakeTeam('t1', name: 'pixel'), fakeTeam('t2', name: 'haru')]);
    await pump2(tester);
    containerOf(tester).read(selectedTeamIdProvider.notifier).select('t2');
    await tester.pump();

    await tester.tap(find.byKey(const Key('topbar.clockIn')));
    await tester.pumpAndSettle();
    expect(find.byType(ClockInDialog), findsOneWidget);

    await tester.tap(find.byKey(const Key('clockIn.submit')));
    await tester.pump();
    expect(find.text('이름을 입력하세요'), findsOneWidget);
    expect(fake.calls, isEmpty);

    await tester.enterText(find.byKey(const Key('clockIn.name')), '이음');
    await tester.tap(find.descendant(of: find.byKey(const Key('clockIn.engine')), matching: find.text('codex')));
    await tester.pump();
    await tester.enterText(find.byKey(const Key('clockIn.instructions')), '테스트만 담당');
    await tester.tap(find.byKey(const Key('clockIn.submit')));
    await tester.pumpAndSettle();

    expect(fake.callList, [
      ['member.clockIn', {'teamId': 't2', 'engine': 'codex', 'name': '이음', 'instructions': '테스트만 담당'}],
    ]);
    expect(find.byType(ClockInDialog), findsNothing);
  });

  testWidgets('팀이 없으면 인라인 팀 만들기 → team.create(팀장 자동 출근) → member.clockIn(새 팀 id), 팀·팀장 선택됨', (tester) async {
    fake.responder = (m, p) => switch (m) {
          'team.create' => {
              'team': fakeTeam('tNew', name: p['name'] as String, leaderId: 'mL'),
              'leader': fakeMember('mL', teamId: 'tNew', name: (p['leaderName'] as String?) ?? '팀장', rank: 'leader', status: 'starting'),
            },
          'member.clockIn' => {'member': fakeMember('m9', teamId: 'tNew')},
          _ => <String, dynamic>{},
        };
    await pumpApp(tester, fake);
    fake.emitHello();
    await pump2(tester);
    expect(find.text('팀 없음'), findsOneWidget);

    await tester.tap(find.byKey(const Key('topbar.clockIn')));
    await tester.pumpAndSettle();
    expect(find.text('팀이 없습니다 — 먼저 팀을 만듭니다'), findsOneWidget);
    expect(find.byKey(const Key('clockIn.leaderHint')), findsOneWidget);
    expect(find.byKey(const Key('clockIn.team')), findsNothing);

    // 팀원 이름은 새 팀에서 선택 — 팀 이름·cwd 만 검증에 걸린다.
    await tester.tap(find.byKey(const Key('clockIn.submit')));
    await tester.pump();
    expect(find.text('이름을 입력하세요'), findsNothing);
    expect(find.text('팀 이름을 입력하세요'), findsOneWidget);
    expect(find.text('작업 폴더 경로를 입력하세요'), findsOneWidget);
    expect(fake.calls, isEmpty);

    await tester.enterText(find.byKey(const Key('clockIn.name')), '이음');
    await tester.enterText(find.byKey(const Key('clockIn.teamName')), 'pixel');
    await tester.enterText(find.byKey(const Key('clockIn.cwd')), r'D:\myproject\pixel-office');
    await tester.enterText(find.byKey(const Key('clockIn.leaderName')), '반장');
    await tester.tap(find.descendant(of: find.byKey(const Key('clockIn.leaderEngine')), matching: find.text('codex')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('clockIn.submit')));
    await tester.pumpAndSettle();

    expect(fake.callList, [
      ['team.create', {'name': 'pixel', 'cwd': r'D:\myproject\pixel-office', 'leaderEngine': 'codex', 'leaderName': '반장'}],
      ['member.clockIn', {'teamId': 'tNew', 'engine': 'claude', 'name': '이음'}],
    ]);
    expect(containerOf(tester).read(selectedTeamIdProvider), 'tNew');
    // 새 팀에서 처음 고르는 멤버는 팀장(T24) — 지시는 팀장에게만 간다.
    expect(containerOf(tester).read(selectedMemberIdProvider), 'mL');
    expect(find.byType(ClockInDialog), findsNothing);
  });

  testWidgets('팀 만들기: 팀원 이름을 비우면 team.create 만 — 팀장만 출근한 빈 사무실', (tester) async {
    fake.responder = (m, p) => switch (m) {
          'team.create' => {
              'team': fakeTeam('tNew', name: p['name'] as String, leaderId: 'mL'),
              'leader': fakeMember('mL', teamId: 'tNew', name: '팀장', rank: 'leader', status: 'starting'),
            },
          _ => <String, dynamic>{},
        };
    await pumpApp(tester, fake);
    fake.emitHello();
    await pump2(tester);

    await tester.tap(find.byKey(const Key('topbar.clockIn')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('clockIn.teamName')), 'pixel');
    await tester.enterText(find.byKey(const Key('clockIn.cwd')), r'D:\myproject\pixel-office');
    await tester.tap(find.byKey(const Key('clockIn.submit')));
    await tester.pumpAndSettle();

    // leaderName 을 비우면 보내지 않는다 — 데몬이 기본 이름 '팀장' 을 붙인다.
    expect(fake.callList, [
      ['team.create', {'name': 'pixel', 'cwd': r'D:\myproject\pixel-office', 'leaderEngine': 'claude'}],
    ]);
    expect(containerOf(tester).read(selectedMemberIdProvider), 'mL');
    expect(find.byType(ClockInDialog), findsNothing);
  });

  testWidgets('팀장 배지: 선택 멤버가 rank leader 면 이름 옆에 "팀장" 배지, 팀원이면 없다', (tester) async {
    await pumpApp(tester, fake, selectedMemberId: 'mL');
    fake.emitHello(
      teams: [fakeTeam('t1', leaderId: 'mL')],
      members: [fakeMember('mL', name: '반장', rank: 'leader'), fakeMember('m1', name: '이음')],
    );
    await pump2(tester);
    expect(find.byKey(const Key('topbar.leaderBadge')), findsOneWidget);
    expect(find.text('반장 [claude]'), findsOneWidget);

    // 팀원을 고르면 배지가 사라진다.
    await pumpApp(tester, fake, selectedMemberId: 'm1');
    await pump2(tester);
    expect(find.byKey(const Key('topbar.leaderBadge')), findsNothing);
    expect(find.text('이음 [claude]'), findsOneWidget);
  });

  testWidgets('출근 RPC 오류는 다이얼로그 안에 표시되고 닫히지 않는다', (tester) async {
    fake.responder = (m, p) => throw const RpcException(RpcException.badState, 'team full');
    await pumpApp(tester, fake);
    fake.emitHello(teams: [fakeTeam('t1')]);
    await pump2(tester);
    await tester.tap(find.byKey(const Key('topbar.clockIn')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('clockIn.name')), '이음');
    await tester.tap(find.byKey(const Key('clockIn.submit')));
    await tester.pumpAndSettle();
    expect(find.byType(ClockInDialog), findsOneWidget);
    expect(find.text('team full (-32003)'), findsOneWidget);
  });

  testWidgets('선택 멤버 이름 + 퇴근 버튼 → 확인 → member.clockOut', (tester) async {
    await pumpApp(tester, fake, selectedMemberId: 'm1');
    fake.emitHello(teams: [fakeTeam('t1')], members: [fakeMember('m1', name: '이음')]);
    await pump2(tester);
    expect(find.text('이음 [claude]'), findsOneWidget);

    await tester.tap(find.byKey(const Key('topbar.clockOut')));
    await tester.pumpAndSettle();
    expect(find.textContaining('퇴근시킬까요'), findsOneWidget);
    await tester.tap(find.text('취소'));
    await tester.pumpAndSettle();
    expect(fake.calls, isEmpty);

    await tester.tap(find.byKey(const Key('topbar.clockOut')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('clockOut.confirm')));
    await tester.pumpAndSettle();
    expect(fake.callList, [['member.clockOut', {'memberId': 'm1'}]]);
  });

  testWidgets('퇴근 버튼은 이미 exited 인 멤버면 비활성', (tester) async {
    await pumpApp(tester, fake, selectedMemberId: 'm1');
    fake.emitHello(teams: [fakeTeam('t1')], members: [fakeMember('m1', status: 'exited')]);
    await pump2(tester);
    expect(tester.widget<IconButton>(find.byKey(const Key('topbar.clockOut'))).onPressed, isNull);
  });
}
