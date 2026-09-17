// T40-3: 내 책상(인박스 그림) · 다중 대기.
//   - 슬롯 4칸 고정, 오래된 것부터 왼쪽, 빈 슬롯은 점선 실루엣.
//   - 5명째부터는 자기 책상에 남고(주황 링) 맨 오른쪽 슬롯 위 "+N".
//   - 헤더 "내 책상 · 대기 N"(N = 전체 수).
//   - 같은 상사에게 동시에 질문하면 `visitorSpot(desk, k)` 로 겹치지 않게 서고, 3명째부터 "+N".
//   - 슬롯·배지 클릭 = 그 멤버 선택 + onSelectPending(pendingId).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_layout.dart';
import 'package:pixel_office/office/office_scene.dart';
import 'package:pixel_office/office/office_view.dart';
import 'package:pixel_office/state/office_state.dart';

import 'office_fixtures.dart';
import 'office_harness.dart';

/// 부장 + 팀원 [n] 명(전원 허가 대기 가능).
OfficeState waitingOffice(int approvals) => OfficeState(
      members: {
        'mH': head('mH', name: '부장', status: approvals > 0 ? MemberStatus.waitingApproval : MemberStatus.idle, createdAt: '0'),
        for (var i = 0; i < 5; i++)
          'm$i': member('m$i',
              name: '팀원$i',
              teamId: 't0',
              parentId: 'mH',
              status: i < approvals - 1 ? MemberStatus.waitingApproval : MemberStatus.idle,
              createdAt: '${i + 1}'),
      },
      teams: {'t0': team('t0', name: 't0', createdAt: '0')},
      pending: {
        for (var i = 0; i < approvals; i++)
          'a$i': approval('a$i', i == 0 ? 'mH' : 'm${i - 1}', 'cmd$i', createdAt: '2026-09-15T00:00:0${i}Z'),
      },
    );

/// 팀장 하나에게 [n] 명이 동시에 ask_parent.
OfficeState askParentOffice(int n) => OfficeState(
      members: {
        'mH': head('mH', name: '부장', createdAt: '0'),
        'mL': lead('mL', name: '반장', teamId: 't0', parentId: 'mH', createdAt: '1'),
        for (var i = 0; i < 4; i++)
          'm$i': member('m$i',
              name: '팀원$i',
              teamId: 't0',
              parentId: 'mL',
              status: i < n ? MemberStatus.waitingAnswer : MemberStatus.idle,
              createdAt: '${i + 2}'),
      },
      teams: {'t0': team('t0', name: 't0', createdAt: '0')},
      pending: {
        for (var i = 0; i < n; i++)
          'q$i': askParentQuestion('q$i', 'm$i', '질문$i', to: 'mL', createdAt: '2026-09-15T00:00:0${i}Z'),
      },
      derived: {for (var i = 0; i < n; i++) 'm$i': DerivedStatus.waitingAnswer},
    );

void main() {
  group('내 책상 슬롯 4칸(장면)', () {
    test('허가 6건 → 슬롯 4칸 + "+2", 헤더는 전체 수', () {
      final scene = OfficeScene.build(
        members: waitingOffice(6).members,
        latestEvents: const {},
        pending: waitingOffice(6).pending,
      );
      expect(scene.queue, hasLength(6));
      expect(scene.myDeskHeader, '내 책상 · 대기 6');
      expect(scene.slotOverflow, 2);
      // 오래된 것부터 왼쪽(pending createdAt 순).
      expect([for (var k = 0; k < mySlotCount; k++) scene.slotEntry(k)!.pendingId], ['a0', 'a1', 'a2', 'a3']);
      expect(scene.slotEntry(4), isNull, reason: '슬롯은 4칸뿐');
    });

    test('4건 이하면 "+N" 없음, 0건이면 "대기 없음"', () {
      OfficeScene build(int n) =>
          OfficeScene.build(members: waitingOffice(n).members, latestEvents: const {}, pending: waitingOffice(n).pending);
      expect(build(0).myDeskHeader, '내 책상 · 대기 없음');
      expect(build(0).slotOverflow, 0);
      expect(build(4).slotOverflow, 0);
      expect(build(4).myDeskHeader, '내 책상 · 대기 4');
      expect(build(5).slotOverflow, 1);
    });

    test('5명째부터는 슬롯이 없다(자기 책상에 남는다) — 링은 주황', () {
      final scene = OfficeScene.build(
        members: waitingOffice(6).members,
        latestEvents: const {},
        pending: waitingOffice(6).pending,
      );
      final queued = scene.members.where((m) => m.isQueued).toList()..sort((a, b) => a.queueIndex!.compareTo(b.queueIndex!));
      expect(queued, hasLength(6));
      expect(queued.take(4).every((m) => m.hasSlot), isTrue);
      expect(queued.skip(4).every((m) => m.hasSlot), isFalse);
      expect(queued.every((m) => m.legendSlot == LegendSlot.myTurn), isTrue);
    });

    test('슬롯을 못 받은 대기자는 배치가 자기 자리 그대로', () {
      final state = waitingOffice(6);
      final scene = OfficeScene.build(members: state.members, latestEvents: const {}, pending: state.pending);
      final l = OfficeLayout(size: const Size(1000, 700), plan: scene.plan);
      final placed = {for (final p in l.placements(scene)) p.memberId: p.center};
      final fifth = scene.members.firstWhere((m) => m.queueIndex == 4);
      final first = scene.members.firstWhere((m) => m.queueIndex == 0);
      expect(placed[first.id], l.slotCenter(0));
      expect(placed[fifth.id], l.seatCenter(fifth.deskIndex));
      expect(l.drawsInBar(fifth), isFalse);
    });
  });

  group('상사 책상 옆 다중 방문(T40-3)', () {
    test('동시에 2명이 ask_parent → 서로 겹치지 않는 자리', () {
      final state = askParentOffice(2);
      final scene = OfficeScene.build(members: state.members, latestEvents: const {}, pending: state.pending, derived: state.derived);
      final a = scene.memberById('m0')!, b = scene.memberById('m1')!;
      expect(a.askParentDeskIndex, b.askParentDeskIndex, reason: '같은 상사');
      expect(a.askParentVisitorIndex, 0);
      expect(b.askParentVisitorIndex, 1);

      final l = OfficeLayout(size: const Size(1200, 800), plan: scene.plan);
      final pa = l.visitorSpot(a.askParentDeskIndex!, 0);
      final pb = l.visitorSpot(b.askParentDeskIndex!, 1);
      expect((pa - pb).distance, greaterThanOrEqualTo(2 * l.charRadius), reason: '원이 겹치지 않는다');
      final placed = {for (final p in l.placements(scene)) p.memberId: p.center};
      expect(placed['m0'], pa);
      expect(placed['m1'], pb);
    });

    test('3명째부터는 자기 자리에 남고 "+N" 만(최대 2명 표시)', () {
      final state = askParentOffice(4);
      final scene = OfficeScene.build(members: state.members, latestEvents: const {}, pending: state.pending, derived: state.derived);
      expect(scene.visitorsAt(1), 4);
      expect(scene.memberById('m2')!.showsAsVisitor, isFalse);
      expect(scene.memberById('m1')!.showsAsVisitor, isTrue);
      final l = OfficeLayout(size: const Size(1200, 800), plan: scene.plan);
      final placed = {for (final p in l.placements(scene)) p.memberId: p.center};
      expect(placed['m2'], l.seatCenter(scene.memberById('m2')!.deskIndex));
      // "+N" 말풍선은 두 번째 자리 위.
      expect(l.visitorOverflowAnchor(1).dx, l.visitorBubbleAnchor(1, visitorMaxShown - 1).dx);
    });

    test('사용자 몫 pending 이 있으면 상사 방문보다 내 책상이 우선', () {
      final state = askParentOffice(1);
      final scene = OfficeScene.build(
        members: state.members,
        latestEvents: const {},
        pending: {...state.pending, 'a1': approval('a1', 'm0', 'rm -rf x')},
        derived: state.derived,
      );
      final m0 = scene.memberById('m0')!;
      expect(m0.isQueued, isTrue);
      expect(m0.askParentDeskIndex, isNull);
      expect(m0.askParentVisitorIndex, isNull);
    });
  });

  group('슬롯·배지 클릭(위젯)', () {
    testWidgets('슬롯 클릭 = 그 멤버 선택 + onSelectPending(pendingId)', (tester) async {
      final picks = <String?>[];
      final pendings = <String>[];
      await pumpHarness(tester, FakeOfficeNotifier(waitingOffice(3)),
          onSelect: picks.add, onSelectPending: pendings.add);
      final painter = painterOf(tester);
      final layout = painter.lastLayout!;
      final origin = tester.getTopLeft(find.byType(OfficeView));
      expect(painter.scene.queue.map((q) => q.pendingId), ['a0', 'a1', 'a2']);

      await tester.tapAt(origin + layout.slotCenter(1));
      expect(picks, ['m0'], reason: 'a1 은 m0 의 허가');
      expect(pendings, ['a1']);

      // 빈 슬롯은 아무 일도 없다.
      await tester.tapAt(origin + layout.slotCenter(3));
      expect(picks, ['m0']);
      expect(pendings, ['a1']);
    });

    testWidgets('"+N" 배지 클릭 = 마지막 대기 건으로(인박스 펼침 신호)', (tester) async {
      final picks = <String?>[];
      final pendings = <String>[];
      await pumpHarness(tester, FakeOfficeNotifier(waitingOffice(6)),
          onSelect: picks.add, onSelectPending: pendings.add);
      final painter = painterOf(tester);
      expect(painter.scene.slotOverflow, 2);
      final origin = tester.getTopLeft(find.byType(OfficeView));
      await tester.tapAt(origin + painter.lastLayout!.overflowBadgeRect.center);
      expect(pendings, ['a3'], reason: '배지는 맨 오른쪽 슬롯(4번째 카드) 자리다');
      expect(picks, ['m2']);
    });

    testWidgets('대기 6건: 슬롯 4명만 바에 서고 나머지는 책상에 남는다', (tester) async {
      await pumpHarness(tester, FakeOfficeNotifier(waitingOffice(6)));
      await settleMotion(tester);
      final painter = painterOf(tester);
      final layout = painter.lastLayout!;
      final placed = {for (final p in painter.lastPlacements) p.memberId: p.center};
      final inBar = painter.scene.members.where(layout.drawsInBar).toList();
      expect(inBar, hasLength(4));
      for (final m in inBar) {
        expect(placed[m.id], layout.slotCenter(m.queueIndex!));
      }
      final rest = painter.scene.members.where((m) => m.isQueued && !m.hasSlot);
      expect(rest, hasLength(2));
      for (final m in rest) {
        expect(placed[m.id], layout.seatCenter(m.deskIndex), reason: '${m.id} 는 자기 책상');
      }
    });

    testWidgets('내 책상 시맨틱에 "대기 N" 과 목록이 들어간다', (tester) async {
      final handle = tester.ensureSemantics();
      await pumpHarness(tester, FakeOfficeNotifier(waitingOffice(5)));
      expect(find.semantics.byLabel(RegExp(r'내 책상 · 대기 5 · 1\. 부장 — 허가: cmd0')), findsOne);
      handle.dispose();
    });
  });
}
