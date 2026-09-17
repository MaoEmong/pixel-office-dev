// OfficeLayout: 레이아웃 v2 기하(T40-1) — 배율·열 수·스크롤 영역/바닥 고정 바·클러스터 상자·슬롯·방문 자리·히트 테스트.
// 위젯 없이 기하만 본다. 창 크기는 패스 6 표(사무실 폭 620/800/1440/2080)를 그대로 쓴다.
import 'dart:math' as math;
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_layout.dart';
import 'package:pixel_office/office/office_scene.dart';

import 'office_fixtures.dart';

const wide = Size(1000, 700);

/// 패스 6 창 크기 표의 사무실 폭.
const widths = [620.0, 800.0, 1440.0, 2080.0];

OfficeScene sceneOf(List<Member> members, {Map<String, Pending> pending = const {}}) =>
    OfficeScene.build(members: {for (final m in members) m.id: m}, latestEvents: const {}, pending: pending);

/// 부장 1 + [teams] 개 팀 × [per] 명.
OfficeDeskPlan planOf(int teams, {int per = 4}) => OfficeDeskPlan(hasHead: true, clusters: [
      for (var i = 0; i < teams; i++) DeskCluster(teamId: 't$i', title: '팀 t$i · $per명', deskCount: per),
    ]);

void main() {
  group('배율(패스 6 창 크기 · D-42 4)', () {
    test('폭 620/800/1440/2080 → 0.6 이상 · 약 0.89 · 1.0 · 1.5', () {
      double s(double w) => OfficeLayout(size: Size(w, 800), deskCount: 4).scale;
      expect(s(620), greaterThanOrEqualTo(OfficeLayout.minScale));
      expect(s(620), lessThan(1));
      expect(s(800), closeTo(0.889, 0.01));
      expect(s(1440), 1.0);
      expect(s(2080), OfficeLayout.maxScale);
    });

    test('하한 0.6 · 상한 1.5 를 넘지 않는다', () {
      expect(OfficeLayout(size: const Size(200, 400), deskCount: 4).scale, OfficeLayout.minScale);
      expect(OfficeLayout(size: const Size(4000, 1400), deskCount: 4).scale, OfficeLayout.maxScale);
      expect(OfficeLayout(size: const Size(900, 700), deskCount: 4).scale, 1.0);
      expect(OfficeLayout(size: const Size(1200, 700), deskCount: 4).scale, 1.0);
    });

    test('세로가 모자라도 배율은 안 줄인다 — 넘치면 스크롤(패스 6)', () {
      final l = OfficeLayout(size: const Size(1000, 420), plan: planOf(4));
      expect(l.scale, 1.0);
      expect(l.isScrollable, isTrue);
    });

    test('폭 1600 이상이면 5열, 미만이면 4열', () {
      expect(OfficeLayout(size: const Size(1599, 800), deskCount: 5).desksPerRow, 4);
      expect(OfficeLayout(size: const Size(1600, 800), deskCount: 5).desksPerRow, OfficeLayout.wideDesksPerRow);
      // 5열 창에서는 5명 팀이 한 줄에 들어간다.
      final l = OfficeLayout(size: const Size(1700, 900), plan: OfficeDeskPlan(hasHead: true, clusters: const [
        DeskCluster(teamId: 't0', title: '팀 t0 · 5명', deskCount: 5),
      ]));
      expect(l.deskRect(1).top, l.deskRect(5).top);
    });

    test('스프라이트 배율은 정수 2단(D-43 3), 셀은 32×32 배수', () {
      final big = OfficeLayout(size: wide, deskCount: 2);
      final small = OfficeLayout(size: const Size(620, 700), deskCount: 2);
      expect(big.spriteScale, 2);
      expect(small.scale, lessThan(0.75));
      expect(small.spriteScale, 1);
      expect(big.spriteCell(const Offset(100, 100)).size, const Size(64, 64));
      expect(big.spriteCellOf(0).center, big.seatCenter(0));
      expect(small.spriteCell(Offset.zero).size, const Size(32, 32));
    });
  });

  group('스크롤 영역 · 바닥 고정 바(T40-1)', () {
    test('바 높이 = (120 + 24) × scale, 스크롤 영역은 그 위 전부', () {
      final l = OfficeLayout(size: wide, deskCount: 4);
      expect(l.barHeight, (OfficeLayout.baseMyDeskBandHeight + OfficeLayout.baseLegendHeight) * l.scale);
      expect(l.viewportHeight, wide.height - l.barHeight);
      expect(l.barRect.top, l.viewportHeight);
      expect(l.viewportRect.overlaps(l.barRect), isFalse);
    });

    test('내 책상·범례는 바 안, 스크롤 영역과 절대 겹치지 않는다', () {
      for (final w in widths) {
        final l = OfficeLayout(size: Size(w, 800), plan: planOf(4));
        expect(l.myDeskRect.top, greaterThanOrEqualTo(l.viewportHeight), reason: 'w=$w');
        expect(l.myDeskRect.bottom, lessThanOrEqualTo(l.legendRect.top + 0.01));
        expect(l.legendRect.height, closeTo(OfficeLayout.baseLegendHeight * l.scale, 0.01));
        expect(l.legendRect.bottom, closeTo(800, 0.01));
        expect(l.myDeskRect.left, closeTo(l.sideMargin, 0.01), reason: '왼쪽 정렬');
      }
    });

    test('문은 스크롤 영역 왼쪽에 고정(바 위쪽 세로 중앙)', () {
      final l = OfficeLayout(size: wide, deskCount: 0);
      expect(l.doorRect.left, 0);
      expect(l.doorRect.width, OfficeLayout.doorWidth);
      expect(l.doorRect.center.dy, l.viewportHeight / 2);
      expect(l.doorRect.bottom, lessThan(l.barRect.top));
      expect(l.doorLabelPos.dx, greaterThan(l.doorRect.right));
    });

    test('작은 부서는 스크롤 없음, 팀이 많으면 스크롤 높이 = 콘텐츠 - 뷰포트', () {
      final one = OfficeLayout(size: wide, plan: planOf(1));
      expect(one.maxScroll, 0);
      expect(one.isScrollable, isFalse);
      expect(one.contentHeight, one.viewportHeight);

      final many = OfficeLayout(size: wide, plan: planOf(8));
      expect(many.isScrollable, isTrue);
      expect(many.maxScroll, many.contentHeight - many.viewportHeight);
      // 마지막 책상이 콘텐츠 안에 들어간다.
      expect(many.deskRect(many.deskCount - 1).bottom, lessThanOrEqualTo(many.contentHeight));
      expect(many.clampScroll(-10), 0);
      expect(many.clampScroll(99999), many.maxScroll);
      expect(many.toContent(const Offset(10, 20), 100), const Offset(10, 120));
    });
  });

  group('클러스터 상자(T40-1: 폭 = min(인원,열) · 왼쪽 정렬 · 한 줄 나란히)', () {
    test('1명 팀 상자는 4명 팀보다 좁고, 전폭이 아니다', () {
      final plan = OfficeDeskPlan(hasHead: true, clusters: const [
        DeskCluster(teamId: 'a', title: '팀 a · 1명', deskCount: 1),
        DeskCluster(teamId: 'b', title: '팀 b · 4명', deskCount: 4),
      ]);
      final l = OfficeLayout(size: const Size(1200, 900), plan: plan);
      final a = l.clusters[0].rect, b = l.clusters[1].rect;
      expect(a.width, lessThan(b.width));
      expect(a.width, closeTo(l.deskWidth + 2 * l.clusterInset, 0.01));
      expect(b.width, closeTo(4 * l.columnPitch - OfficeLayout.baseColumnGap * l.scale + 2 * l.clusterInset, 0.01));
      expect(a.width, lessThan(1200 * 0.6), reason: '1명 팀이 전폭 빈 상자가 되지 않는다');
    });

    test('둘 다 들어가면 같은 줄에 나란히, 안 들어가면 다음 줄', () {
      final small = OfficeDeskPlan(hasHead: true, clusters: const [
        DeskCluster(teamId: 'a', title: '팀 a · 2명', deskCount: 2),
        DeskCluster(teamId: 'b', title: '팀 b · 2명', deskCount: 2),
      ]);
      final l = OfficeLayout(size: const Size(1440, 900), plan: small);
      expect(l.clusters[0].rect.top, l.clusters[1].rect.top, reason: '한 줄에 나란히');
      expect(l.clusters[1].rect.left, greaterThan(l.clusters[0].rect.right));
      expect(l.clusters[1].rect.right, lessThanOrEqualTo(1440 - l.sideMargin + 0.01));

      final big = OfficeDeskPlan(hasHead: true, clusters: const [
        DeskCluster(teamId: 'a', title: '팀 a · 4명', deskCount: 4),
        DeskCluster(teamId: 'b', title: '팀 b · 4명', deskCount: 4),
      ]);
      final narrow = OfficeLayout(size: const Size(800, 900), plan: big);
      expect(narrow.clusters[1].rect.top, greaterThanOrEqualTo(narrow.clusters[0].rect.bottom));
      expect(narrow.clusters[0].rect.left, narrow.clusters[1].rect.left, reason: '둘 다 왼쪽 정렬');
    });

    test('책상은 자기 상자 안, 상자는 서로 겹치지 않는다', () {
      final l = OfficeLayout(size: const Size(1440, 700), plan: planOf(4, per: 3));
      for (var c = 0; c < 4; c++) {
        final box = l.clusters[c].rect;
        for (var d = 0; d < 3; d++) {
          final desk = l.deskRect(1 + c * 3 + d);
          expect(box.contains(desk.topLeft), isTrue, reason: 'cluster $c desk $d');
          expect(desk.right, lessThanOrEqualTo(box.right + 0.01));
        }
      }
      for (var i = 0; i < l.clusters.length; i++) {
        for (var j = i + 1; j < l.clusters.length; j++) {
          expect(l.clusters[i].rect.overlaps(l.clusters[j].rect.deflate(0.5)), isFalse, reason: '$i/$j');
        }
      }
    });

    test('카펫 색 번호는 팀 생성 순서(6색 순환은 페인터가 한다)', () {
      final l = OfficeLayout(size: const Size(1000, 700), plan: planOf(3, per: 1));
      expect(l.clusters.map((c) => c.colorIndex), [0, 1, 2]);
      expect(l.clusters.first.cluster?.teamId, 't0');
    });
  });

  group('겹침 0 · 스크롤 높이 (1/4/8팀 × 폭 620/800/1440/2080)', () {
    for (final teams in [1, 4, 8]) {
      for (final w in widths) {
        test('$teams팀 × 폭 $w: 책상끼리·내 책상과 겹치지 않고 콘텐츠 안에 들어간다', () {
          final l = OfficeLayout(size: Size(w, 720), plan: planOf(teams));
          final rects = l.deskRects;
          expect(rects, hasLength(1 + teams * 4));
          for (var i = 0; i < rects.length; i++) {
            expect(rects[i].left, greaterThanOrEqualTo(0), reason: 'desk $i');
            expect(rects[i].right, lessThanOrEqualTo(w + 0.01), reason: 'desk $i');
            expect(rects[i].bottom, lessThanOrEqualTo(l.contentHeight), reason: 'desk $i 가 콘텐츠 밖');
            for (var j = i + 1; j < rects.length; j++) {
              expect(rects[i].overlaps(rects[j]), isFalse, reason: 'desk $i/$j');
            }
          }
          // 내 책상·범례(바닥 바)는 스크롤 영역 밖이라 **어떤 책상과도 겹칠 수 없다**.
          expect(l.myDeskRect.top, greaterThanOrEqualTo(l.viewportHeight));
          expect(l.legendRect.bottom, closeTo(720, 0.01));
          // 스크롤 높이: 콘텐츠가 뷰포트보다 크면 그만큼만 스크롤된다.
          expect(l.contentHeight, greaterThanOrEqualTo(l.viewportHeight));
          expect(l.maxScroll, l.contentHeight - l.viewportHeight);
        });
      }
    }

    test('팀이 늘면 콘텐츠 높이도 는다(축소가 아니라 스크롤)', () {
      final a = OfficeLayout(size: wide, plan: planOf(1));
      final b = OfficeLayout(size: wide, plan: planOf(4));
      final c = OfficeLayout(size: wide, plan: planOf(8));
      expect(a.scale, b.scale);
      expect(b.scale, c.scale);
      expect(b.contentHeight, greaterThan(a.contentHeight));
      expect(c.contentHeight, greaterThan(b.contentHeight));
    });
  });

  group('내 책상 슬롯 4칸(T40-3)', () {
    test('슬롯은 오래된 것부터 왼쪽, 간격 2r + 8, 내 책상 안', () {
      final l = OfficeLayout(size: wide, deskCount: 3);
      expect(OfficeLayout.myDeskSlots, 4);
      final s0 = l.slotCenter(0), s1 = l.slotCenter(1), s3 = l.slotCenter(3);
      expect(s0.dy, s1.dy);
      expect(s1.dx - s0.dx, closeTo(2 * l.charRadius + 8 * l.scale, 0.01));
      expect(s0.dx - l.slotRadius, greaterThanOrEqualTo(l.myDeskRect.left));
      expect(s3.dx + l.slotRadius, lessThanOrEqualTo(l.myDeskRect.right));
      expect(s0.dy, greaterThan(l.myDeskRect.top));
      expect(s0.dy, lessThan(l.myDeskRect.bottom));
      // 클릭 목표 최소 24px(패스 6).
      expect(l.slotHitRect(0).width, greaterThanOrEqualTo(24));
      expect(l.slotHitRect(0).height, greaterThanOrEqualTo(24));
    });

    test('"+N" 배지는 맨 오른쪽 슬롯 위, 눌리면 그 슬롯으로 친다', () {
      final l = OfficeLayout(size: wide, deskCount: 3);
      final badge = l.overflowBadgeRect;
      expect(badge.center.dx, closeTo(l.slotCenter(3).dx, 0.01));
      expect(badge.center.dy, lessThan(l.slotCenter(3).dy));
      expect(l.slotAt(badge.center), 3);
      expect(l.slotAt(l.slotCenter(2)), 2);
      expect(l.slotAt(l.myDeskRect.topRight + const Offset(-2, 2)), isNull);
      expect(l.slotAt(const Offset(5, 5)), isNull);
    });

    test('queueSlot 은 슬롯과 같은 자리, 4칸을 넘으면 마지막 칸으로 본다', () {
      final l = OfficeLayout(size: wide, deskCount: 6);
      expect(l.queueSlot(0), l.slotCenter(0));
      expect(l.queueSlot(3), l.slotCenter(3));
      expect(l.queueSlot(7), l.slotCenter(3));
      expect(l.queueBubbleAnchor(0).dy, lessThan(l.slotCenter(0).dy));
    });

    test('보고 방문 자리는 내 책상 오른쪽(슬롯을 차지하지 않는다)', () {
      final l = OfficeLayout(size: wide, deskCount: 3);
      expect(l.reportSpot(0).dx, greaterThan(l.myDeskRect.right));
      expect(l.reportSpot(1).dx, greaterThan(l.reportSpot(0).dx));
      expect(l.reportSpot(0).dx, lessThanOrEqualTo(wide.width - l.charRadius));
      expect(l.reportBubbleAnchor(0).dy, lessThan(l.reportSpot(0).dy));
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

    test('자리 멤버는 책상 자리, 대기자는 내 책상 슬롯(pending 순)', () {
      final l = OfficeLayout(size: wide, deskCount: 3);
      final p = l.placements(scene);
      expect(p.map((x) => x.memberId), ['m1', 'm2', 'm3']);
      expect(p[0].center, l.seatCenter(0));
      expect(p[2].center, l.slotCenter(0)); // 이음(q1) 먼저
      expect(p[1].center, l.slotCenter(1));
      expect(p[0].bubbleAnchor, l.seatBubbleAnchor(0));
      expect(p[2].bubbleAnchor, l.queueBubbleAnchor(0));
      expect(l.drawsInBar(scene.memberById('m3')!), isTrue);
      expect(l.drawsInBar(scene.memberById('m1')!), isFalse);
    });

    test('캐릭터 → 슬롯 → 책상 → 빈 곳 순으로 판정', () {
      final l = OfficeLayout(size: wide, deskCount: 3);
      expect(l.hitTest(l.seatCenter(0), scene), 'm1');
      expect(l.hitTest(l.seatCenter(0) + Offset(l.charRadius + 2, 0), scene), 'm1'); // 여유 4px
      expect(l.hitTest(l.slotCenter(0), scene), 'm3');
      expect(l.hitTest(l.slotCenter(1), scene), 'm2');
      expect(l.hitTest(l.slotCenter(2), scene), isNull, reason: '빈 슬롯');
      expect(l.hitTest(l.deskRect(1).topLeft + const Offset(5, 5), scene), 'm2'); // 비어 있는 책상도 그 멤버
      expect(l.hitTest(l.monitorRect(2).center, scene), 'm3');
      expect(l.hitTest(const Offset(2, 2), scene), isNull);
      expect(l.hitTest(l.doorRect.center, scene), isNull);
    });

    test('스크롤하면 책상 히트 테스트도 그만큼 내려간다(바는 그대로)', () {
      final plan = planOf(8);
      final l = OfficeLayout(size: const Size(1000, 600), plan: plan);
      final s = OfficeScene(
        members: [
          for (var i = 0; i < plan.deskCount; i++)
            SceneMember(id: 'x$i', name: 'n$i', engine: Engine.claude, status: MemberStatus.idle, deskIndex: i, summary: '', isAlert: false),
        ],
        queue: const [],
        plan: plan,
      );
      expect(l.isScrollable, isTrue);
      final desk = l.deskRect(1);
      final scroll = math.min(120.0, l.maxScroll);
      expect(desk.center.dy, lessThan(l.viewportHeight), reason: '스크롤 전에는 화면 안');
      // 스크롤 전: 화면 좌표 = 콘텐츠 좌표.
      expect(l.hitTest(desk.center, s), 'x1');
      // 스크롤 후: 같은 책상이 위로 올라가므로 화면에서는 scroll 만큼 위를 눌러야 한다.
      expect(l.hitTest(desk.center - Offset(0, scroll), s, null, scroll), 'x1');
      expect(l.hitTest(desk.center, s, null, scroll), isNot('x1'));
      // 바(내 책상) 영역은 스크롤과 무관하다.
      expect(l.hitTest(l.barRect.center, s, null, scroll), isNull);
    });

    test('빈 장면: 배치 없음, 어디를 눌러도 null', () {
      final l = OfficeLayout(size: wide, deskCount: 0);
      expect(l.placements(OfficeScene.empty), isEmpty);
      expect(l.hitTest(l.emptyHintCenter, OfficeScene.empty), isNull);
      expect(l.emptyHintCenter.dy, lessThan(l.barRect.top));
    });
  });

  // ---- T37: 부장 책상 + 팀 클러스터 ---------------------------------------------------

  group('클러스터 배치(T37)', () {
    /// 부장 1 + 팀 t1(팀장 + 팀원 2) + 팀 t2(팀장 1).
    OfficeScene deptScene() => OfficeScene.build(
          members: {
            'mH': head('mH', name: '부장', createdAt: '0'),
            'mL': lead('mL', name: '반장', parentId: 'mH', createdAt: '1'),
            'm1': member('m1', name: '이음', parentId: 'mL', createdAt: '2'),
            'm2': member('m2', name: '하루', parentId: 'mL', createdAt: '3'),
            'mL2': lead('mL2', name: '작가', teamId: 't2', parentId: 'mH', createdAt: '4'),
          },
          latestEvents: const {},
          pending: const {},
          teams: {'t1': team('t1', name: 't1', createdAt: '1'), 't2': team('t2', name: 't2', createdAt: '2')},
        );

    test('책상 순서 = 부장 → 팀별(팀장 먼저) → 미배정', () {
      final scene = deptScene();
      expect(scene.members.map((m) => m.id), ['mH', 'mL', 'm1', 'm2', 'mL2']);
      expect(scene.members.map((m) => m.deskIndex), [0, 1, 2, 3, 4]);
      expect(scene.plan.hasHead, isTrue);
      expect(scene.plan.clusters.map((c) => c.teamId), ['t1', 't2']);
      expect(scene.plan.clusters.map((c) => c.deskCount), [3, 1]);
      expect(scene.plan.clusters.first.title, '팀 t1 · 3명');
      expect(scene.plan.startOf(1), 4); // t2 의 첫 책상
    });

    test('부장 책상은 맨 윗줄 가운데 + 금색 카펫 자리, 팀 클러스터는 그 아래', () {
      final l = OfficeLayout(size: wide, plan: deptScene().plan);
      final headDesk = l.deskRect(0);
      expect(headDesk.center.dx, closeTo(wide.width / 2, 0.01));
      expect(headDesk.top, l.topPadding);
      expect(l.headCarpetRect(0), headDesk.inflate(20 * l.scale));
      // 클러스터 상자 2개(팀마다 하나), 부장 책상보다 아래.
      expect(l.clusters.length, 2);
      expect(l.clusters.first.rect.top, greaterThan(headDesk.bottom));
      expect(l.clusters.first.title, contains('t1'));
      for (final i in [1, 2, 3]) {
        expect(l.clusters.first.rect.contains(l.deskRect(i).topLeft), isTrue, reason: 'desk $i in t1 box');
      }
      expect(l.clusters[1].rect.contains(l.deskRect(4).topLeft), isTrue);
      for (var i = 0; i < l.deskCount; i++) {
        expect(l.deskRect(i).right, lessThanOrEqualTo(wide.width));
      }
    });

    test('팀 없는 멤버는 "미배정" 클러스터로 (정상 트리에는 없다)', () {
      final scene = OfficeScene.build(
        members: {
          'mH': head('mH', createdAt: '0'),
          'mX': member('mX', name: '떠돌이', teamId: null, createdAt: '1'),
        },
        latestEvents: const {},
        pending: const {},
      );
      expect(scene.plan.clusters.single.teamId, isNull);
      expect(scene.plan.clusters.single.title, '$unassignedClusterTitle · 1명');
      expect(scene.members.map((m) => m.id), ['mH', 'mX']);
    });

    test('클러스터가 많으면 세로로 스크롤한다(더 이상 축소하지 않는다)', () {
      final l = OfficeLayout(size: wide, plan: planOf(4));
      expect(l.scale, 1.0);
      expect(l.deskCount, 17);
      expect(l.isScrollable, isTrue);
      expect(l.contentHeight, greaterThan(l.deskRect(16).bottom));
    });

    test('계획 없이 deskCount 만 주면 T12 평면 격자와 같다(회귀)', () {
      final flat = OfficeLayout(size: wide, deskCount: 6);
      final viaPlan = OfficeLayout(size: wide, plan: OfficeDeskPlan.flat(6));
      expect(flat.deskRects, viaPlan.deskRects);
      expect(flat.clusters, isEmpty); // 제목 없는 클러스터는 상자를 그리지 않는다
      expect(flat.rowCount, 2);
      final r = flat.deskRects;
      expect(r.sublist(0, 4).map((d) => d.top).toSet().length, 1);
      expect(r[4].top, greaterThan(r[3].bottom));
      expect(r[4].left, r[0].left);
      for (var i = 1; i < 4; i++) {
        expect(r[i].left, greaterThan(r[i - 1].right));
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

    test('ask_parent 방문 자리: k 번째는 2r+8 씩 오른쪽, 넘치면 왼쪽으로 접는다', () {
      final l = OfficeLayout(size: wide, plan: deptScene().plan);
      final s0 = l.visitorSpot(1), s1 = l.visitorSpot(1, 1);
      expect(s0.dx, greaterThan(l.deskRect(1).right));
      expect(s1.dx - s0.dx, closeTo(2 * l.charRadius + 8 * l.scale, 0.01));
      expect(s0.dy, closeTo(l.seatCenter(1).dy, 0.01));
      expect(l.visitorBubbleAnchor(1).dy, lessThan(s0.dy));
      expect(l.visitorSpot(1, 0), isNot(l.visitorSpot(1, 1)));

      // 오른쪽 끝 책상: 다음 자리가 `width - r - 2` 를 넘으면 왼쪽 옆으로 접고, 늘 화면 안에 머문다.
      final right = OfficeLayout(size: const Size(700, 700), plan: OfficeDeskPlan.flat(4));
      final last = right.deskCount - 1;
      final d = right.deskRect(last);
      final step = 2 * right.charRadius + 8 * right.scale;
      final maxX = 700 - right.charRadius - 2;
      var fold = 0;
      while (d.right + right.charRadius * 1.6 + fold * step <= maxX) {
        fold++;
      }
      for (var k = 0; k <= fold + 1; k++) {
        final p = right.visitorSpot(last, k);
        expect(p.dx, lessThanOrEqualTo(maxX + 0.01), reason: 'k=$k');
        expect(p.dx, greaterThanOrEqualTo(right.charRadius + 2 - 0.01), reason: 'k=$k');
      }
      expect(right.visitorSpot(last, fold).dx, lessThan(d.left), reason: '자리가 없으면 왼쪽으로 접는다');
    });
  });
}
