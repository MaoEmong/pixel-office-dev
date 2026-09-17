// T16 이동 애니메이션 위젯 테스트. 가짜 시계(tester.pump(Duration))로 Ticker 를 돌려
// 페인터가 받은 배치(lastPlacements)·시맨틱·히트 테스트가 보간 위치를 따르는지, 다 멈추면 프레임 예약이 없는지 본다.
// 흔들림(working) 이 없도록 멤버는 idle 로 두어 Ticker 정지를 검증할 수 있게 한다.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_scene.dart' show askParentSummary;
import 'package:pixel_office/office/office_view.dart';
import 'package:pixel_office/state/office_state.dart';

import 'office_fixtures.dart';
import 'office_harness.dart';

OfficeState idlePair({MemberStatus m2Status = MemberStatus.idle, Map<String, Pending> pending = const {}, Map<String, OfficeEvent> events = const {}}) =>
    OfficeState(
      members: {
        'm1': member('m1', name: '하루', createdAt: '1'),
        'm2': member('m2', name: '모시', status: m2Status, engine: Engine.codex, createdAt: '2'),
      },
      latestEvent: events,
      pending: pending,
    );

void main() {
  testWidgets('pending 이 생기면 줄 자리로 시간에 따라 걸어가 도착하고, 닫히면 돌아온다; 멈추면 프레임 예약 없음', (tester) async {
    final notifier = FakeOfficeNotifier(idlePair());
    await pumpHarness(tester, notifier);
    var painter = painterOf(tester);
    final layout = painter.lastLayout!;
    final seat = layout.seatCenter(1), slot = layout.queueSlot(0);
    expect(painter.lastPlacements[1].center, seat);
    await tester.pump();
    expect(tester.binding.hasScheduledFrame, isFalse, reason: '정지 상태에선 Ticker 가 돌지 않는다');

    notifier.set(idlePair(m2Status: MemberStatus.waitingApproval, pending: {'a1': approval('a1', 'm2', 'rm -rf build/')}));
    await tester.pump();
    painter = painterOf(tester);
    expect(painter.scene.memberById('m2')!.queueIndex, 0);
    expect(painter.lastPlacements[1].center, seat, reason: '출발 프레임은 아직 자리');
    expect(tester.binding.hasScheduledFrame, isTrue, reason: '걷는 동안 Ticker 가 돈다');

    await tester.pump(const Duration(milliseconds: 600));
    painter = painterOf(tester);
    final mid = painter.lastPlacements[1].center;
    expect(mid.dy, greaterThan(seat.dy));
    expect(mid.dy, lessThan(slot.dy));
    expect(mid.dx, greaterThan(slot.dx));
    expect(mid.dx, lessThan(seat.dx));
    expect(painter.lastPlacements[0].center, layout.seatCenter(0), reason: 'm1 은 그대로');

    await tester.pump(const Duration(milliseconds: 600));
    final later = painterOf(tester).lastPlacements[1].center;
    expect(later.dy, greaterThan(mid.dy), reason: '시간이 갈수록 줄 자리에 가까워진다');

    await settleMotion(tester);
    painter = painterOf(tester);
    expect(painter.lastPlacements[1].center, slot);
    await tester.pump();
    expect(tester.binding.hasScheduledFrame, isFalse, reason: '도착 후 Ticker 정지');

    // pending 닫힘 → 자리로 복귀.
    notifier.set(idlePair());
    await tester.pump();
    expect(painterOf(tester).lastPlacements[1].center, slot);
    await tester.pump(const Duration(milliseconds: 600));
    final back = painterOf(tester).lastPlacements[1].center;
    expect(back.dy, lessThan(slot.dy));
    expect(back.dy, greaterThan(seat.dy));
    await settleMotion(tester);
    expect(painterOf(tester).lastPlacements[1].center, seat);
    await tester.pump();
    expect(tester.binding.hasScheduledFrame, isFalse);
  });

  testWidgets('시맨틱·히트 테스트는 보간 위치를 따른다', (tester) async {
    final handle = tester.ensureSemantics();
    final picks = <String?>[];
    final notifier = FakeOfficeNotifier(idlePair());
    await pumpHarness(tester, notifier, onSelect: picks.add);
    final layout = painterOf(tester).lastLayout!;
    final origin = tester.getTopLeft(find.byType(OfficeView));

    notifier.set(idlePair(m2Status: MemberStatus.waitingApproval, pending: {'a1': approval('a1', 'm2', 'ls')}));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 800));
    final painter = painterOf(tester);
    final mid = painter.lastPlacements[1].center;
    expect(mid, isNot(layout.seatCenter(1)));
    expect(mid, isNot(layout.queueSlot(0)));

    // 걷는 중인 캐릭터를 탭하면 그 멤버, 비운 자리(책상 아래 원 자리)를 탭하면 null.
    // T40-3: 내 책상 **슬롯**은 아직 도착 전이라도 그 대기 건의 멤버를 고른다(슬롯 = 인박스 그림).
    await tester.tapAt(origin + mid);
    await tester.tapAt(origin + layout.seatCenter(1) + Offset(0, layout.charRadius));
    await tester.tapAt(origin + layout.queueSlot(0));
    expect(picks, ['m2', null, 'm2']);

    // 시맨틱 사각형도 지금 위치의 원.
    final node = find.semantics.byLabel(RegExp(r'책상 2 · 모시 .* · 내 책상 줄')).evaluate().single;
    expect(node.rect.center.dx, closeTo(mid.dx, 0.01));
    expect(node.rect.center.dy, closeTo(mid.dy, 0.01));
    expect(node.rect.width, closeTo(layout.charRadius * 2, 0.01));

    await settleMotion(tester);
    picks.clear();
    await tester.tapAt(origin + layout.queueSlot(0));
    expect(picks, ['m2']);
    handle.dispose();
  });

  testWidgets('starting 새 멤버는 문에서 자리로 입장', (tester) async {
    final notifier = FakeOfficeNotifier(OfficeState(members: {'m1': member('m1', name: '하루', createdAt: '1')}));
    await pumpHarness(tester, notifier);
    notifier.set(OfficeState(members: {
      'm1': member('m1', name: '하루', createdAt: '1'),
      'm2': member('m2', name: '신입', status: MemberStatus.starting, createdAt: '2'),
    }));
    await tester.pump();
    var painter = painterOf(tester);
    final layout = painter.lastLayout!;
    expect(layout.deskCount, 2);
    expect(painter.lastPlacements[1].center, layout.doorSpawn);
    expect(painter.scene.members[1].summary, '(출근 중)');

    await tester.pump(const Duration(seconds: 1));
    final mid = painterOf(tester).lastPlacements[1].center;
    expect(mid.dx, greaterThan(layout.doorSpawn.dx));
    expect(mid.dx, lessThan(layout.seatCenter(1).dx));

    await settleMotion(tester);
    painter = painterOf(tester);
    expect(painter.lastPlacements[1].center, layout.seatCenter(1));
    await tester.pump();
    expect(tester.binding.hasScheduledFrame, isFalse);
  });

  testWidgets('reporting 이벤트 → 내 책상에 와서 "▤ 보고" 말풍선, 6초 뒤 자리로', (tester) async {
    final handle = tester.ensureSemantics();
    final notifier = FakeOfficeNotifier(idlePair());
    await pumpHarness(tester, notifier);
    final layout = painterOf(tester).lastLayout!;

    notifier.set(idlePair(events: {'m1': event('m1', OfficeEventKind.reporting, seq: 3)}));
    await tester.pump();
    var painter = painterOf(tester);
    expect(painter.bubbleOverrides, {'m1': reportVisitBubble});
    expect(painter.lastPlacements[0].center, layout.seatCenter(0));

    await tester.pump(const Duration(milliseconds: 2500)); // 자리 → 내 책상 앞(약 460px, 2.1초)
    painter = painterOf(tester);
    expect(painter.lastPlacements[0].center, layout.reportSpot(0));
    expect(painter.bubbleOverrides, {'m1': reportVisitBubble});
    expect(find.semantics.byLabel(RegExp(r'책상 1 · 하루 .* · ▤ 보고')), findsOne);
    await tester.pump();
    expect(tester.binding.hasScheduledFrame, isFalse, reason: '머무는 동안은 Ticker 정지(타이머만)');

    // 보고 뒤에 오는 idle 이벤트는 방문을 끊지 않는다.
    notifier.set(idlePair(events: {'m1': event('m1', OfficeEventKind.idle, seq: 4)}));
    await tester.pump();
    expect(painterOf(tester).bubbleOverrides, {'m1': reportVisitBubble});

    await tester.pump(const Duration(seconds: 4)); // 총 6.5초 → 타이머 만료 → 복귀 시작
    painter = painterOf(tester);
    expect(painter.bubbleOverrides, isEmpty);
    expect(find.semantics.byLabel(RegExp(r'▤ 보고')), findsNothing);
    await tester.pump(const Duration(milliseconds: 1000));
    final mid = painterOf(tester).lastPlacements[0].center;
    expect(mid.dy, lessThan(layout.reportSpot(0).dy));
    expect(mid.dy, greaterThan(layout.seatCenter(0).dy));
    await settleMotion(tester);
    expect(painterOf(tester).lastPlacements[0].center, layout.seatCenter(0));
    await tester.pump();
    expect(tester.binding.hasScheduledFrame, isFalse);
    handle.dispose();
  });

  testWidgets('보고하러 오는 도중 새 작업 이벤트가 오면 취소하고 자리로', (tester) async {
    final notifier = FakeOfficeNotifier(idlePair());
    await pumpHarness(tester, notifier);
    final layout = painterOf(tester).lastLayout!;
    notifier.set(idlePair(events: {'m1': event('m1', OfficeEventKind.reporting, seq: 3)}));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 800));
    final mid = painterOf(tester).lastPlacements[0].center;
    expect(mid, isNot(layout.seatCenter(0)));

    notifier.set(idlePair(events: {'m1': event('m1', OfficeEventKind.editing, seq: 4, detail: {'path': 'a.dart'})}));
    await tester.pump();
    expect(painterOf(tester).bubbleOverrides, isEmpty);
    await settleMotion(tester);
    expect(painterOf(tester).lastPlacements[0].center, layout.seatCenter(0));
    // 타이머가 남아 있어도(취소됨) 나중에 다시 움직이지 않는다.
    await tester.pump(const Duration(seconds: 7));
    expect(painterOf(tester).lastPlacements[0].center, layout.seatCenter(0));
    await tester.pump();
    expect(tester.binding.hasScheduledFrame, isFalse);
  });

  testWidgets('T29 결함 ④: 보고 직후 mcp__team__* 도구 호출은 방문을 취소하지 않는다', (tester) async {
    final notifier = FakeOfficeNotifier(idlePair());
    await pumpHarness(tester, notifier);
    final layout = painterOf(tester).lastLayout!;
    notifier.set(idlePair(events: {'m1': event('m1', OfficeEventKind.reporting, seq: 3)}));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 2500));
    expect(painterOf(tester).lastPlacements[0].center, layout.reportSpot(0));

    // 팀장이 보고한 뒤 곧바로 dismiss 를 부른다 — 보고에 딸린 뒷정리이지 새 작업이 아니다.
    notifier.set(idlePair(
      events: {'m1': event('m1', OfficeEventKind.running, seq: 4, detail: {'tool': 'mcp__team__dismiss'})},
    ));
    await tester.pump();
    expect(painterOf(tester).bubbleOverrides, {'m1': reportVisitBubble}, reason: 'MCP 팀 도구는 취소 사유가 아니다');
    expect(painterOf(tester).lastPlacements[0].center, layout.reportSpot(0));

    // 보통 도구(Bash)면 예전대로 취소된다.
    notifier.set(idlePair(
      events: {'m1': event('m1', OfficeEventKind.running, seq: 5, detail: {'tool': 'Bash', 'cmd': 'flutter test'})},
    ));
    await tester.pump();
    expect(painterOf(tester).bubbleOverrides, isEmpty);
    await settleMotion(tester);
    expect(painterOf(tester).lastPlacements[0].center, layout.seatCenter(0));
    await tester.pump(const Duration(seconds: 7));
    await tester.pump();
    expect(tester.binding.hasScheduledFrame, isFalse);
  });

  testWidgets('T37: ask_parent 질문자는 내 책상이 아니라 상사 책상 옆으로 걸어간다', (tester) async {
    // 부장(mH) · 팀장(mL) · 팀원(m1). 팀원이 팀장에게 ask_parent 로 물었다.
    OfficeState tree({Map<String, Pending> pending = const {}}) => OfficeState(
          members: {
            'mH': head('mH', name: '부장', createdAt: '0'),
            'mL': lead('mL', name: '반장', parentId: 'mH', createdAt: '1'),
            'm1': member('m1', name: '이음', parentId: 'mL', createdAt: '2'),
          },
          teams: {'t1': team('t1', name: 't1')},
          pending: pending,
          derived: pending.isEmpty ? const {} : const {'m1': DerivedStatus.waitingAnswer},
        );
    final notifier = FakeOfficeNotifier(tree());
    await pumpHarness(tester, notifier);
    final layout = painterOf(tester).lastLayout!;
    expect(painterOf(tester).lastPlacements[2].center, layout.seatCenter(2));

    notifier.set(tree(pending: {'q1': askParentQuestion('q1', 'm1', '이 폴더 지워도 됩니까?', to: 'mL')}));
    await tester.pump();
    var scene = painterOf(tester).scene;
    // 내 책상 줄에는 서지 않는다 — 사용자 몫이 아니다(D-32).
    expect(scene.queue, isEmpty);
    expect(scene.memberById('m1')!.queueIndex, isNull);
    expect(scene.memberById('m1')!.askParentDeskIndex, 1); // 팀장 책상
    expect(scene.memberById('m1')!.summary, askParentSummary);
    expect(scene.memberById('m1')!.isAlert, isTrue);

    await settleMotion(tester);
    expect(painterOf(tester).lastPlacements[2].center, layout.visitorSpot(1));

    // 답이 오면(pending 닫힘) 자기 자리로 돌아간다.
    notifier.set(tree());
    await tester.pump();
    await settleMotion(tester);
    expect(painterOf(tester).lastPlacements[2].center, layout.seatCenter(2));
  });

  testWidgets('퇴근: 문까지 갔다가 회색으로 자리에 돌아온다', (tester) async {
    final notifier = FakeOfficeNotifier(idlePair());
    await pumpHarness(tester, notifier);
    final layout = painterOf(tester).lastLayout!;
    final seat = layout.seatCenter(1);
    notifier.set(idlePair(m2Status: MemberStatus.exited));
    await tester.pump();
    expect(painterOf(tester).lastPlacements[1].center, seat);
    await tester.pump(const Duration(seconds: 1));
    final toward = painterOf(tester).lastPlacements[1].center;
    expect(toward.dx, lessThan(seat.dx));
    await tester.pump(const Duration(seconds: 2)); // 약 2.8초면 문 도착
    expect(painterOf(tester).lastPlacements[1].center.dx, closeTo(layout.doorSpawn.dx, 1));
    await tester.pump(const Duration(seconds: 1)); // 돌아오는 중
    final back = painterOf(tester).lastPlacements[1].center;
    expect(back.dx, greaterThan(layout.doorSpawn.dx));
    await settleMotion(tester);
    final painter = painterOf(tester);
    expect(painter.lastPlacements[1].center, seat);
    expect(painter.scene.members[1].isGone, isTrue);
    expect(painter.scene.members[1].summary, '(퇴근)');
    await tester.pump();
    expect(tester.binding.hasScheduledFrame, isFalse);
  });

  testWidgets('working 멤버가 있으면 흔들림 때문에 Ticker 가 계속 돈다', (tester) async {
    await pumpHarness(tester, FakeOfficeNotifier(twoMembers()));
    await tester.pump();
    expect(tester.binding.hasScheduledFrame, isTrue);
    await tester.pump(const Duration(milliseconds: 250));
    final painter = painterOf(tester);
    expect(painter.bob['m1'], isNotNull);
    expect(painter.bob['m1']!.abs(), greaterThan(0));
    expect(painter.bob.containsKey('m2'), isFalse);
    expect(painter.lastPlacements[0].center, painter.lastLayout!.seatCenter(0), reason: '흔들림은 배치(시맨틱)에는 안 들어간다');
  });

  testWidgets('캔버스 크기가 바뀌면 걷지 않고 새 자리에 즉시 선다', (tester) async {
    final notifier = FakeOfficeNotifier(idlePair(m2Status: MemberStatus.waitingAnswer, pending: {'q1': question('q1', 'm2', '?')}));
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    Widget app(Size size) => ProviderScope(
          overrides: [officeProvider.overrideWith(() => notifier)],
          child: MaterialApp(home: Center(child: SizedBox(width: size.width, height: size.height, child: const OfficeView()))),
        );
    await tester.pumpWidget(app(const Size(1000, 700)));
    expect(painterOf(tester).lastPlacements[1].center, painterOf(tester).lastLayout!.queueSlot(0));
    await tester.pumpWidget(app(const Size(600, 500)));
    final painter = painterOf(tester);
    expect(painter.lastLayout!.size, const Size(600, 500));
    expect(painter.lastPlacements[1].center, painter.lastLayout!.queueSlot(0));
    await tester.pump();
    expect(tester.binding.hasScheduledFrame, isFalse);
  });
}
