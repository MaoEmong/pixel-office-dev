// CommandBar(T37 rev 3): 대상은 **부서의 살아 있는 부장 하나로 고정**. Enter 전송(instruct + 입력 비움),
// Shift+Enter 줄바꿈(전송 없음), 끊김·부장 없음 비활성, 중단 → member.interrupt, -32004 문구·대상 복구.
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

/// 연결 + 부서 d1(부장 mH 부장) · 팀 t1(팀장 mL 반장, 팀원 m1 이음) · 퇴근한 팀원 m2.
Future<void> connect(WidgetTester tester, FakeRpcClient fake, {String headStatus = 'idle'}) async {
  fake.emitHello(
    departments: [fakeDepartment('d1', name: 'alpha', headId: 'mH')],
    teams: [fakeTeam('t1', leaderId: 'mL')],
    members: [
      fakeMember('mH', name: '부장', rank: 'head', status: headStatus, createdAt: '0'),
      fakeMember('mL', name: '반장', rank: 'lead', parentId: 'mH', createdAt: '1'),
      fakeMember('m1', name: '이음', parentId: 'mL', createdAt: '2'),
      fakeMember('m2', name: '하루', status: 'exited', parentId: 'mL', createdAt: '3'),
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

  testWidgets('Enter → member.instruct(부장, 입력 텍스트) 후 입력 비움, 배지 표시', (tester) async {
    await tester.pumpWidget(app(fake));
    await connect(tester, fake);
    expect(tester.widget<TextField>(input).enabled, isTrue);
    expect(find.text(commandBarHint('부장')), findsOneWidget);

    await tester.enterText(input, '테스트 돌려줘');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();

    expect(fake.callList, [['member.instruct', {'memberId': 'mH', 'text': '테스트 돌려줘'}]]);
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
    expect(fake.callList, [['member.instruct', {'memberId': 'mH', 'text': '첫 줄\n둘째 줄'}]]);
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

  // ---- T37 부장 고정 게이트 -----------------------------------------------------------

  testWidgets('T37: 사무실에서 팀장·팀원을 골라도 지시는 부장에게 간다', (tester) async {
    await tester.pumpWidget(app(fake, selected: 'm1')); // 팀원을 골랐다
    await connect(tester, fake);
    expect(find.text(commandBarHint('부장')), findsOneWidget);

    await tester.enterText(input, '보고서 취합해줘');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(fake.callList, [['member.instruct', {'memberId': 'mH', 'text': '보고서 취합해줘'}]]);
    await tester.pump(commandBarBadgeDuration);

    // 선택을 팀장으로 바꿔도 대상은 그대로 부장.
    await tester.pumpWidget(app(fake, selected: 'mL'));
    await tester.pump();
    expect(find.text(commandBarHint('부장')), findsOneWidget);
  });

  testWidgets('T40-5: 드롭다운 대신 정적 칩 "♛ <부장>에게"', (tester) async {
    await tester.pumpWidget(app(fake, selected: null));
    await connect(tester, fake);

    expect(find.byType(DropdownButtonFormField<String>), findsNothing);
    expect(find.byType(TargetChip), findsOneWidget);
    expect(find.text(commandBarTargetChip('부장')), findsOneWidget);
    expect(find.text('♛ 부장에게'), findsOneWidget);
    expect(find.byTooltip('$commandBarHeadOnlyTooltip · claude'), findsOneWidget);
    // placeholder 는 예시 문장(D11)
    expect(find.text(commandBarHint('부장')), findsOneWidget);
    expect(find.textContaining(commandBarExample), findsOneWidget);
  });

  testWidgets('T37: 살아 있는 부장이 없으면 비활성 + 안내 힌트', (tester) async {
    await tester.pumpWidget(app(fake, selected: 'm1'));
    await connect(tester, fake, headStatus: 'exited');

    expect(tester.widget<TextField>(input).enabled, isFalse);
    expect(find.text(commandBarNoHeadHint), findsOneWidget);
    expect(tester.widget<IconButton>(sendBtn).onPressed, isNull);
    // 칩은 회색 "부장 없음"
    expect(find.text(commandBarNoHeadChip), findsOneWidget);
    expect(tester.widget<TargetChip>(find.byType(TargetChip)).member, isNull);

    await tester.enterText(input, '아무거나');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(fake.calls, isEmpty);
  });

  testWidgets('T37: -32004 는 데몬 문구를 그대로 띄우고 대상을 부장으로 되돌린다(force 안 씀)', (tester) async {
    // 앱이 아직 부장 복귀를 모르는 상태 — 로컬로는 부장이 exited 라 대상이 없다.
    fake.responder = (m, p) => throw const RpcException(
          RpcException.rankRule,
          '부장에게만 지시할 수 있습니다 (head: 부장)',
          {'headId': 'mH'},
        );
    await tester.pumpWidget(app(fake, selected: 'm1'));
    await connect(tester, fake);
    // 부장이 살아 있는 동안은 정상 경로 — 여기서는 데몬이 거절하는 상황을 만든다.
    await tester.enterText(input, '이거 해줘');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();

    // force 는 콘솔 전용 디버그 탈출구 — 앱은 다시 보내지 않는다.
    expect(fake.callList, [['member.instruct', {'memberId': 'mH', 'text': '이거 해줘'}]]);
    expect(find.byKey(const Key('commandBar.error')), findsOneWidget);
    expect(find.text('부장에게만 지시할 수 있습니다 (head: 부장)'), findsOneWidget);
    // data.headId 로 대상을 되돌린다(입력은 지우지 않는다 — 그대로 다시 보낼 수 있게).
    expect(tester.widget<TargetChip>(find.byType(TargetChip)).member?.id, 'mH');
    expect(tester.widget<TextField>(input).controller!.text, '이거 해줘');
  });

  testWidgets('중단 버튼 → member.interrupt(부장); RPC 오류는 빨간 글씨', (tester) async {
    fake.responder = (m, p) => throw const RpcException(RpcException.badState, 'double interrupt');
    await tester.pumpWidget(app(fake));
    await connect(tester, fake);
    await tester.tap(interruptBtn);
    await tester.pump();
    expect(fake.callList, [['member.interrupt', {'memberId': 'mH'}]]);
    expect(find.byKey(const Key('commandBar.error')), findsOneWidget);
    expect(find.text('double interrupt'), findsOneWidget);
  });
}
