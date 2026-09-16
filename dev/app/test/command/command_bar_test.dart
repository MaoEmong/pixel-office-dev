// CommandBar: Enter 전송(instruct + 입력 비움), Shift+Enter 줄바꿈(전송 없음), 끊김·대상 없음·퇴근 멤버 비활성, 중단 → member.interrupt.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/command/command_bar.dart';
import 'package:pixel_office/rpc/rpc_client.dart';
import 'package:pixel_office/state/office_state.dart';

import 'fake_rpc_client.dart';

Widget app(FakeRpcClient fake, {String? selected = 'm1'}) => ProviderScope(
      overrides: fake.overrides,
      child: MaterialApp(home: Scaffold(body: Column(children: [const Spacer(), CommandBar(selectedMemberId: selected)]))),
    );

final input = find.byKey(const Key('commandBar.input'));
final sendBtn = find.byKey(const Key('commandBar.send'));
final interruptBtn = find.byKey(const Key('commandBar.interrupt'));

/// 스트림으로 밀어 넣은 뒤: 첫 pump 가 마이크로태스크(리스너 → setState)를 돌리고, 둘째 pump 가 그 프레임을 그린다.
Future<void> pump2(WidgetTester tester) async {
  await tester.pump();
  await tester.pump();
}

/// 연결 + 멤버 2명(m1 idle, m2 exited) 스냅샷. 팀장은 없다(= 팀장이 나간 팀과 같은 구성).
Future<void> connect(WidgetTester tester, FakeRpcClient fake) async {
  fake.emitHello(
    teams: [fakeTeam('t1')],
    members: [fakeMember('m1', name: '이음'), fakeMember('m2', name: '하루', status: 'exited')],
  );
  await pump2(tester);
}

/// 연결 + 팀장이 있는 팀 t1(mL 반장 leader, m1 이음 member) + 팀장 없는 팀 t2(m9 나래).
Future<void> connectWithLeader(WidgetTester tester, FakeRpcClient fake, {String leaderStatus = 'idle'}) async {
  fake.emitHello(
    teams: [fakeTeam('t1', leaderId: 'mL'), fakeTeam('t2', name: 'other')],
    members: [
      fakeMember('mL', name: '반장', rank: 'leader', status: leaderStatus),
      fakeMember('m1', name: '이음'),
      fakeMember('m9', name: '나래', teamId: 't2'),
    ],
  );
  await pump2(tester);
}

void main() {
  late FakeRpcClient fake;

  setUp(() {
    fake = FakeRpcClient(responder: (m, p) => m == 'member.instruct' ? {'taskId': 7} : <String, dynamic>{});
  });

  tearDown(() async => fake.close());

  testWidgets('Enter → member.instruct(선택 멤버, 입력 텍스트) 후 입력 비움, 배지 표시', (tester) async {
    await tester.pumpWidget(app(fake));
    await connect(tester, fake);
    expect(tester.widget<TextField>(input).enabled, isTrue);
    expect(find.text(commandBarHint('이음')), findsOneWidget);
    expect(find.text('이음에게 지시 (Enter 전송, Shift+Enter 줄바꿈)'), findsOneWidget);

    await tester.enterText(input, '테스트 돌려줘');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();

    expect(fake.callList, [['member.instruct', {'memberId': 'm1', 'text': '테스트 돌려줘'}]]);
    expect(tester.widget<TextField>(input).controller!.text, '');
    expect(find.byKey(const Key('commandBar.badge')), findsOneWidget);
    expect(find.text('#7 전송됨'), findsOneWidget);
    // OfficeNotifier.instruct 가 로컬 queued task 를 넣는다.
    final container = ProviderScope.containerOf(tester.element(input));
    expect(container.read(openTasksProvider).keys, [7]);

    await tester.pump(commandBarBadgeDuration);
    expect(find.byKey(const Key('commandBar.badge')), findsNothing);
  });

  testWidgets('Shift+Enter → 줄바꿈 삽입, 전송 없음; 이후 Enter 로 여러 줄 그대로 전송', (tester) async {
    await tester.pumpWidget(app(fake));
    await connect(tester, fake);

    await tester.enterText(input, '첫 줄');
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.pump();

    expect(fake.calls, isEmpty);
    final controller = tester.widget<TextField>(input).controller!;
    expect(controller.text, '첫 줄\n');
    expect(controller.selection.baseOffset, 4);

    // 커서 위치에 이어서 타이핑한 셈 치고 컨트롤러에 둘째 줄을 붙인다.
    controller.value = TextEditingValue(text: '${controller.text}둘째 줄', selection: const TextSelection.collapsed(offset: 8));
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(fake.callList, [['member.instruct', {'memberId': 'm1', 'text': '첫 줄\n둘째 줄'}]]);
    await tester.pump(commandBarBadgeDuration);
  });

  testWidgets('빈 입력(공백만)은 Enter 로 보내지 않는다', (tester) async {
    await tester.pumpWidget(app(fake));
    await connect(tester, fake);
    await tester.enterText(input, '   ');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(fake.calls, isEmpty);
  });

  testWidgets('끊기면 입력·버튼 비활성, 다시 연결되면 활성', (tester) async {
    await tester.pumpWidget(app(fake));
    expect(tester.widget<TextField>(input).enabled, isFalse);
    expect(find.text('데몬 연결 안 됨'), findsOneWidget);
    expect(tester.widget<IconButton>(sendBtn).onPressed, isNull);
    expect(tester.widget<OutlinedButton>(interruptBtn).onPressed, isNull);

    await connect(tester, fake);
    expect(tester.widget<TextField>(input).enabled, isTrue);
    expect(tester.widget<IconButton>(sendBtn).onPressed, isNotNull);

    fake.setState(RpcConnectionState.disconnected);
    await pump2(tester);
    expect(tester.widget<TextField>(input).enabled, isFalse);
    await tester.enterText(input, 'x');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(fake.calls, isEmpty);
  });

  testWidgets('대상 없음 / 퇴근한 멤버는 비활성, 드롭다운에서 exited 항목은 비활성', (tester) async {
    await tester.pumpWidget(app(fake, selected: null));
    await connect(tester, fake);
    expect(tester.widget<TextField>(input).enabled, isFalse);
    expect(find.text('대상을 고르세요'), findsOneWidget);

    // 드롭다운 열기 → 하루(exited) 는 enabled=false 항목.
    await tester.tap(find.byKey(const Key('commandBar.target')));
    await tester.pumpAndSettle();
    final items = tester.widgetList<DropdownMenuItem<String>>(find.byType(DropdownMenuItem<String>)).toList();
    expect(items.map((i) => (i.value, i.enabled)), containsAll([('m1', true), ('m2', false)]));
    await tester.tap(find.text('이음 [claude]').last);
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(input).enabled, isTrue);
  });

  testWidgets('선택 멤버가 바뀌면 대상이 따라간다; 퇴근 멤버면 비활성', (tester) async {
    await tester.pumpWidget(app(fake, selected: 'm1'));
    await connect(tester, fake);
    expect(tester.widget<TextField>(input).enabled, isTrue);
    await tester.pumpWidget(app(fake, selected: 'm2'));
    await tester.pump();
    expect(tester.widget<TextField>(input).enabled, isFalse);
    expect(find.text('하루 은(는) 퇴근했습니다'), findsOneWidget);
  });

  // ---- T24b 팀장 게이트 ---------------------------------------------------------------

  testWidgets('T24b: 팀장이 있으면 팀원을 골라도 지시는 팀장에게 간다', (tester) async {
    await tester.pumpWidget(app(fake, selected: 'm1')); // 사무실에서 팀원을 골랐다
    await connectWithLeader(tester, fake);

    expect(find.text(commandBarHint('반장')), findsOneWidget);
    await tester.enterText(input, '보고서 취합해줘');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(fake.callList, [['member.instruct', {'memberId': 'mL', 'text': '보고서 취합해줘'}]]);
    await tester.pump(commandBarBadgeDuration);
  });

  testWidgets('T24b: 드롭다운에서 같은 팀 팀원은 비활성 + 툴팁, 팀장 없는 다른 팀은 그대로', (tester) async {
    await tester.pumpWidget(app(fake, selected: null));
    await connectWithLeader(tester, fake);

    await tester.tap(find.byKey(const Key('commandBar.target')));
    await tester.pumpAndSettle();
    final items = tester.widgetList<DropdownMenuItem<String>>(find.byType(DropdownMenuItem<String>)).toList();
    expect(items.map((i) => (i.value, i.enabled)), containsAll([('mL', true), ('m1', false), ('m9', true)]));
    expect(find.byTooltip(commandBarLeaderOnlyTooltip), findsWidgets);
    expect(find.text('반장 [claude] · 팀장'), findsWidgets);
  });

  testWidgets('T24b: 팀장이 퇴근하면 게이트가 열려 팀원에게 직접 지시된다', (tester) async {
    await tester.pumpWidget(app(fake, selected: 'm1'));
    await connectWithLeader(tester, fake);
    expect(find.text(commandBarHint('반장')), findsOneWidget);

    fake.pushNotification('member.status', {'memberId': 'mL', 'status': 'exited', 'derived': 'exited'});
    await pump2(tester);
    expect(find.text(commandBarHint('이음')), findsOneWidget);

    await tester.enterText(input, '직접 지시');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(fake.callList, [['member.instruct', {'memberId': 'm1', 'text': '직접 지시'}]]);
    await tester.pump(commandBarBadgeDuration);
  });

  testWidgets('T24b: -32004 는 데몬 문구를 그대로 띄우고 대상을 팀장으로 되돌린다(force 안 씀)', (tester) async {
    // 앱이 아직 팀장 복귀를 모르는 상태(로컬로는 mL 이 exited) — 그래서 팀원에게 지시가 나간다.
    fake.responder = (m, p) => throw const RpcException(
          RpcException.rankRule,
          '팀장에게만 지시할 수 있습니다 (leader: 반장)',
          {'leaderId': 'mL'},
        );
    await tester.pumpWidget(app(fake, selected: 'm1'));
    await connectWithLeader(tester, fake, leaderStatus: 'exited');
    expect(find.text(commandBarHint('이음')), findsOneWidget);

    await tester.enterText(input, '이거 해줘');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();

    // force 는 콘솔 전용 디버그 탈출구 — 앱은 다시 보내지 않는다.
    expect(fake.callList, [['member.instruct', {'memberId': 'm1', 'text': '이거 해줘'}]]);
    expect(find.byKey(const Key('commandBar.error')), findsOneWidget);
    expect(find.text('팀장에게만 지시할 수 있습니다 (leader: 반장)'), findsOneWidget);
    // data.leaderId 로 대상을 되돌린다(입력은 지우지 않는다 — 그대로 다시 보낼 수 있게).
    final dropdown = tester.widget<DropdownButtonFormField<String>>(find.byKey(const Key('commandBar.target')));
    expect(dropdown.initialValue, 'mL');
    expect(tester.widget<TextField>(input).controller!.text, '이거 해줘');
  });

  testWidgets('중단 버튼 → member.interrupt; RPC 오류는 빨간 글씨', (tester) async {
    fake.responder = (m, p) => throw const RpcException(RpcException.badState, 'double interrupt');
    await tester.pumpWidget(app(fake));
    await connect(tester, fake);
    await tester.tap(interruptBtn);
    await tester.pump();
    expect(fake.callList, [['member.interrupt', {'memberId': 'm1'}]]);
    expect(find.byKey(const Key('commandBar.error')), findsOneWidget);
    expect(find.text('double interrupt'), findsOneWidget);
  });
}
