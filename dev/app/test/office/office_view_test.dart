// OfficeView 위젯 테스트. officeProvider 를 데몬 없이 고정 상태를 돌려주는 Notifier 로 덮어쓴다.
// 그림 자체는 검사할 수 없으니 (a) CustomPaint 의 OfficePainter 가 받은 장면·배치, (b) 시맨틱 라벨, (c) 탭 콜백을 본다.
// 하네스(FakeOfficeNotifier / pumpHarness / painterOf / twoMembers)는 office_harness.dart — T16 movement_test 와 공유.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_layout.dart';
import 'package:pixel_office/office/office_painter.dart';
import 'package:pixel_office/office/office_view.dart';
import 'package:pixel_office/state/office_state.dart';

import 'office_fixtures.dart';
import 'office_harness.dart';

void main() {
  testWidgets('멤버 2명 → 책상 2개, 라벨·엔진 배지·모니터 요약(running)', (tester) async {
    await pumpHarness(tester, FakeOfficeNotifier(twoMembers()));
    final painter = painterOf(tester);
    expect(painter.scene.members, hasLength(2));
    expect(painter.scene.members[0].deskLabel, '책상 1 · 하루');
    expect(painter.scene.members[0].engineLabel, 'Claude');
    expect(painter.scene.members[0].summary, '▶ flutter test test/stt_test.dart');
    expect(painter.scene.members[1].deskLabel, '책상 2 · 모시');
    expect(painter.scene.members[1].engineLabel, 'Codex');
    expect(painter.scene.members[1].summary, '(대기)');
    expect(painter.scene.queue, isEmpty);
    // paint 가 실제로 돌았고 레이아웃이 캔버스 크기로 계산됐다.
    expect(painter.lastLayout?.size, canvasSize);
    expect(painter.lastLayout?.deskCount, 2);
    expect(painter.lastPlacements.map((p) => p.memberId), ['m1', 'm2']);
    expect(painter.lastPlacements[0].center, painter.lastLayout!.seatCenter(0));
  });

  testWidgets('시맨틱 라벨에 책상·요약·내 책상이 나온다', (tester) async {
    final handle = tester.ensureSemantics();
    await pumpHarness(tester, FakeOfficeNotifier(twoMembers()));
    expect(find.semantics.byLabel(RegExp(r'책상 1 · 하루 · Claude · ▶ flutter test')), findsOne);
    expect(find.semantics.byLabel(RegExp(r'책상 2 · 모시 · Codex · \(대기\)')), findsOne);
    expect(find.semantics.byLabel('내 책상 · 대기 없음'), findsOne);
    expect(find.semantics.byLabel('문'), findsOne);
    handle.dispose();
  });

  testWidgets('waiting_approval 멤버는 내 책상 줄로, 목록에 "허가: <cmd>"', (tester) async {
    final handle = tester.ensureSemantics();
    final notifier = FakeOfficeNotifier(twoMembers());
    await pumpHarness(tester, notifier);
    var painter = painterOf(tester);
    expect(painter.scene.memberById('m2')!.isQueued, isFalse);

    // 상태 갱신 → 장면 재계산 → 줄로 이동(T16: 걸어가므로 애니메이션을 끝까지 돌린 뒤 자리를 본다).
    notifier.set(twoMembers(
      m2Status: MemberStatus.waitingApproval,
      pending: {'a1': approval('a1', 'm2', 'rm -rf build/')},
    ));
    await tester.pump();
    await settleMotion(tester);
    painter = painterOf(tester);
    final m2 = painter.scene.memberById('m2')!;
    expect(m2.queueIndex, 0);
    expect(m2.summary, '❗ 허가 대기');
    expect(m2.isAlert, isTrue);
    expect(painter.scene.queue.single.line(0), '1. 모시 — 허가: rm -rf build/');
    final layout = painter.lastLayout!;
    expect(painter.lastPlacements[1].center, layout.queueSlot(0));
    expect(painter.lastPlacements[1].center.dy, greaterThan(layout.deskRect(1).bottom)); // 책상보다 아래(내 책상 쪽)
    expect(painter.lastPlacements[0].center, layout.seatCenter(0)); // m1 은 그대로
    expect(find.semantics.byLabel(RegExp(r'내 책상 · 1\. 모시 — 허가: rm -rf build/')), findsOne);
    expect(find.semantics.byLabel(RegExp(r'책상 2 · 모시 .* · 내 책상 줄')), findsOne);
    handle.dispose();
  });

  testWidgets('탭: 캐릭터·책상 → 멤버 id, 빈 곳 → null, 선택 멤버는 페인터에 전달', (tester) async {
    final picks = <String?>[];
    await pumpHarness(tester, FakeOfficeNotifier(twoMembers()), selected: 'm2', onSelect: picks.add);
    final painter = painterOf(tester);
    expect(painter.selectedMemberId, 'm2');
    final layout = painter.lastLayout!;
    final origin = tester.getTopLeft(find.byType(OfficeView));

    await tester.tapAt(origin + layout.seatCenter(0));
    await tester.tapAt(origin + layout.deskRect(1).center);
    await tester.tapAt(origin + layout.myDeskRect.center);
    await tester.tapAt(origin + const Offset(3, 3));
    expect(picks, ['m1', 'm2', null, null]);
  });

  testWidgets('빈 상태: 멤버 없음 → 책상·배치 없음, 내 책상·문만, 힌트 위치', (tester) async {
    final handle = tester.ensureSemantics();
    await pumpHarness(tester, FakeOfficeNotifier(const OfficeState()));
    final painter = painterOf(tester);
    expect(painter.scene.isEmpty, isTrue);
    expect(painter.lastPlacements, isEmpty);
    expect(painter.lastLayout!.deskCount, 0);
    expect(find.semantics.byLabel('내 책상 · 대기 없음'), findsOne);
    expect(find.semantics.byLabel('문'), findsOne);
    expect(find.semantics.byLabel(RegExp(r'^책상 \d')), findsNothing);
    handle.dispose();
  });

  testWidgets('너비 900 미만이면 축소된 레이아웃으로 그린다', (tester) async {
    await tester.pumpWidget(ProviderScope(
      overrides: [officeProvider.overrideWith(() => FakeOfficeNotifier(twoMembers()))],
      child: const MaterialApp(home: Center(child: SizedBox(width: 600, height: 500, child: OfficeView()))),
    ));
    final painter = painterOf(tester);
    expect(painter.lastLayout!.size, const Size(600, 500));
    expect(painter.lastLayout!.scale, lessThan(1));
    expect(painter.lastLayout!.deskRect(1).right, lessThanOrEqualTo(600));
  });

  testWidgets('teamId 를 주면 그 팀 멤버만 그린다, null 이면 전체', (tester) async {
    final state = OfficeState(
      members: {
        'm1': member('m1', name: '하루', createdAt: '1', teamId: 'tA'),
        'm2': member('m2', name: '모시', createdAt: '2', teamId: 'tB'),
        'm3': member('m3', name: '이음', createdAt: '3', teamId: 'tA'),
      },
    );
    Widget app(String? teamId) => ProviderScope(
          overrides: [officeProvider.overrideWith(() => FakeOfficeNotifier(state))],
          child: MaterialApp(home: Center(child: SizedBox(width: 1000, height: 700, child: OfficeView(teamId: teamId)))),
        );

    await tester.pumpWidget(app('tA'));
    var painter = painterOf(tester);
    expect(painter.scene.members.map((m) => m.id), ['m1', 'm3']);
    expect(painter.scene.members[1].deskLabel, '책상 2 · 이음');
    expect(painter.lastLayout!.deskCount, 2);

    await tester.pumpWidget(app(null));
    painter = painterOf(tester);
    expect(painter.scene.members.map((m) => m.id), ['m1', 'm2', 'm3']);
    expect(painter.lastLayout!.deskCount, 3);
  });

  test('shouldRepaint: 장면·선택이 같으면 false, 다르면 true', () {
    final s = twoMembers();
    OfficePainter p(OfficeState st, [String? sel]) => OfficePainter(
          scene: OfficeScene.build(members: st.members, latestEvents: st.latestEvent, pending: st.pending),
          selectedMemberId: sel,
        );
    expect(p(s).shouldRepaint(p(s)), isFalse);
    expect(p(s, 'm1').shouldRepaint(p(s)), isTrue);
    expect(p(twoMembers(m2Status: MemberStatus.exited)).shouldRepaint(p(s)), isTrue);
    // 레이아웃 크기 하나로 배치 확인용(순수 계산).
    expect(OfficeLayout(size: canvasSize, deskCount: 2).placements(p(s).scene), hasLength(2));
  });
}
