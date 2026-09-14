// OfficeLayout: 책상 슬롯(한 줄 4개), 내 책상·문 위치, 줄 서는 자리, 축소, 히트 테스트. 위젯 없이 기하만.
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_layout.dart';
import 'package:pixel_office/office/office_scene.dart';

import 'office_fixtures.dart';

const wide = Size(1000, 700);

OfficeScene sceneOf(List<Member> members, {Map<String, Pending> pending = const {}}) =>
    OfficeScene.build(members: {for (final m in members) m.id: m}, latestEvents: const {}, pending: pending);

void main() {
  group('책상 슬롯', () {
    test('N 명 → 한 줄 4개, 5번째부터 다음 줄, 같은 열은 같은 left', () {
      final l = OfficeLayout(size: wide, deskCount: 6);
      expect(l.rowCount, 2);
      final r = l.deskRects;
      expect(r.length, 6);
      expect(r.sublist(0, 4).map((d) => d.top).toSet().length, 1);
      expect(r[4].top, greaterThan(r[3].bottom));
      expect(r[4].left, r[0].left);
      expect(r[5].left, r[1].left);
      for (var i = 1; i < 4; i++) {
        expect(r[i].left, greaterThan(r[i - 1].right));
      }
    });

    test('책상은 서로 겹치지 않고 화면 안에, 내 책상과도 겹치지 않는다', () {
      for (final n in [1, 4, 5, 8, 10]) {
        final l = OfficeLayout(size: wide, deskCount: n);
        final rects = l.deskRects;
        for (var i = 0; i < n; i++) {
          expect(rects[i].left, greaterThanOrEqualTo(0));
          expect(rects[i].right, lessThanOrEqualTo(wide.width));
          expect(rects[i].bottom, lessThan(l.myDeskRect.top), reason: 'n=$n desk $i overlaps my desk');
          for (var j = i + 1; j < n; j++) {
            expect(rects[i].overlaps(rects[j]), isFalse, reason: 'n=$n $i/$j');
          }
        }
      }
    });

    test('scale 1.0 이면 와이어프레임 치수(160×100), 모니터·자리·말풍선 위치', () {
      final l = OfficeLayout(size: wide, deskCount: 2);
      expect(l.scale, 1.0);
      expect(l.deskRect(0).size, const Size(160, 100));
      expect(l.charRadius, 14);
      final d = l.deskRect(0);
      expect(l.monitorRect(0).overlaps(d), isTrue);
      expect(d.contains(l.monitorRect(0).topLeft) && d.contains(l.monitorRect(0).bottomRight), isTrue);
      expect(l.seatCenter(0).dx, d.center.dx);
      expect(l.seatCenter(0).dy, greaterThan(d.bottom - l.charRadius));
      expect(l.seatBubbleAnchor(0).dy, lessThan(d.top));
    });
  });

  group('내 책상 · 문 · 줄', () {
    test('내 책상은 아래 가운데, 굵은 사각형 치수', () {
      final l = OfficeLayout(size: wide, deskCount: 3);
      final my = l.myDeskRect;
      expect(my.center.dx, wide.width / 2);
      expect(my.bottom, wide.height - OfficeLayout.baseBottomMargin);
      expect(my.size, const Size(260, 110));
    });

    test('문은 왼쪽 가장자리 세로 중앙', () {
      final l = OfficeLayout(size: wide, deskCount: 0);
      expect(l.doorRect.left, 0);
      expect(l.doorRect.width, OfficeLayout.doorWidth);
      expect(l.doorRect.center.dy, wide.height / 2);
      expect(l.doorLabelPos.dx, greaterThan(l.doorRect.right));
    });

    test('줄 서는 자리는 내 책상 위, 왼쪽부터 오른쪽으로 같은 높이', () {
      final l = OfficeLayout(size: wide, deskCount: 3);
      final q0 = l.queueSlot(0), q1 = l.queueSlot(1), q2 = l.queueSlot(2);
      expect(q0.dy, q1.dy);
      expect(q1.dx, greaterThan(q0.dx + 2 * l.charRadius));
      expect(q2.dx, greaterThan(q1.dx));
      expect(q0.dy + l.charRadius, lessThanOrEqualTo(l.myDeskRect.top));
      expect(q0.dx - l.charRadius, greaterThanOrEqualTo(l.myDeskRect.left));
      expect(l.queueBubbleAnchor(0).dy, lessThan(q0.dy - l.charRadius));
      // 홀수 번째 말풍선은 한 단 위(겹침 방지), 짝수끼리는 같은 높이.
      expect(l.queueBubbleAnchor(1).dy, l.queueBubbleAnchor(0).dy - l.queueBubbleTier);
      expect(l.queueBubbleAnchor(2).dy, l.queueBubbleAnchor(0).dy);
      expect(l.queueBubbleAnchor(1).dx, q1.dx);
    });
  });

  group('축소', () {
    test('너비 900 미만이면 책상이 작아지고, 900 이상이면 원 크기', () {
      final small = OfficeLayout(size: const Size(600, 700), deskCount: 4);
      expect(small.scale, lessThan(1));
      expect(small.deskRect(0).width, lessThan(160));
      expect(small.deskRects.every((r) => r.right <= 600), isTrue);
      expect(OfficeLayout(size: const Size(900, 700), deskCount: 4).scale, 1.0);
      expect(OfficeLayout(size: const Size(1400, 900), deskCount: 4).deskRect(0).width, 160);
    });

    test('줄이 많아 세로가 모자라면 세로에 맞춰 더 줄인다', () {
      final l = OfficeLayout(size: const Size(1000, 420), deskCount: 12);
      expect(l.scale, lessThan(1));
      expect(l.deskRect(11).bottom + l.charRadius, lessThan(l.queueSlot(0).dy - l.charRadius));
    });
  });

  group('배치 · 히트 테스트', () {
    final members = [
      member('m1', name: '하루', status: MemberStatus.working, createdAt: '1'),
      member('m2', name: '모시', status: MemberStatus.waitingApproval, createdAt: '2'),
      member('m3', name: '이음', status: MemberStatus.waitingAnswer, createdAt: '3'),
    ];
    final scene = sceneOf(members, pending: {
      'q1': question('q1', 'm3', '?', createdAt: '2026-09-15T00:00:01Z'),
      'a1': approval('a1', 'm2', 'ls', createdAt: '2026-09-15T00:00:02Z'),
    });

    test('자리 멤버는 책상 자리, waiting 멤버는 내 책상 줄(pending 순)', () {
      final l = OfficeLayout(size: wide, deskCount: 3);
      final p = l.placements(scene);
      expect(p.map((x) => x.memberId), ['m1', 'm2', 'm3']);
      expect(p[0].center, l.seatCenter(0));
      expect(p[2].center, l.queueSlot(0)); // 이음(q1) 먼저
      expect(p[1].center, l.queueSlot(1));
      expect(p[0].bubbleAnchor, l.seatBubbleAnchor(0));
      expect(p[2].bubbleAnchor, l.queueBubbleAnchor(0));
    });

    test('캐릭터 → 책상 → 빈 곳 순으로 판정', () {
      final l = OfficeLayout(size: wide, deskCount: 3);
      expect(l.hitTest(l.seatCenter(0), scene), 'm1');
      expect(l.hitTest(l.seatCenter(0) + Offset(l.charRadius + 2, 0), scene), 'm1'); // 여유 4px
      expect(l.hitTest(l.queueSlot(0), scene), 'm3');
      expect(l.hitTest(l.queueSlot(1), scene), 'm2');
      expect(l.hitTest(l.deskRect(1).topLeft + const Offset(5, 5), scene), 'm2'); // 비어 있는 책상도 그 멤버
      expect(l.hitTest(l.monitorRect(2).center, scene), 'm3');
      expect(l.hitTest(const Offset(2, 2), scene), isNull);
      expect(l.hitTest(l.myDeskRect.center, scene), isNull);
      expect(l.hitTest(l.doorRect.center, scene), isNull);
    });

    test('빈 장면: 배치 없음, 어디를 눌러도 null', () {
      final l = OfficeLayout(size: wide, deskCount: 0);
      expect(l.placements(OfficeScene.empty), isEmpty);
      expect(l.hitTest(l.emptyHintCenter, OfficeScene.empty), isNull);
      expect(l.emptyHintCenter.dy, lessThan(l.myDeskRect.top));
    });
  });
}
