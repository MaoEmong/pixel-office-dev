// T40-2: 페인터가 실제로 무엇을 그리는지 — 작은 Canvas 대역([_Recorder])으로 캔버스 호출을 받아 센다.
// 보는 것: 팀 카펫 6색 순환 + 제목 태그(-8px 걸침), 부장 금색 카펫 + 왕관, 오류 책상 테두리 빨강,
//   퇴근 책상(의자만, 캐릭터 원 없음), 캐릭터 원 색 = 범례 색, 범례 7칸, "+N" 배지, 스크롤바,
//   그리고 **곡률 4px 단일 · 그림자/글로우/그라데이션 0**(패스 4 리트머스 7).
// (색 비교는 `toARGB32()` 로 한다 — Paint.color 를 거치면 같은 색이라도 Color 끼리 == 가 아니다.)
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_layout.dart';
import 'package:pixel_office/office/office_painter.dart';
import 'package:pixel_office/office/office_scene.dart';

import 'office_fixtures.dart';

const canvasSize = Size(1000, 700);

/// 부장 + [teams] 개 팀(각 1명).
OfficeScene deptScene({int teams = 2, MemberStatus crewStatus = MemberStatus.working}) => OfficeScene.build(
      members: {
        'mH': head('mH', name: '부장', createdAt: '0'),
        for (var i = 0; i < teams; i++)
          'mL$i': lead('mL$i', name: '반장$i', teamId: 't$i', parentId: 'mH', status: crewStatus, createdAt: '${i + 1}'),
      },
      latestEvents: const {},
      pending: const {},
      teams: {for (var i = 0; i < teams; i++) 't$i': team('t$i', name: 't$i', createdAt: '$i')},
    );

/// 부장 + 팀 하나(팀장 살아 있음 + 팀원 [crewStatus]) — 팀이 살아 있어야 책상이 남는다.
OfficeScene teamScene({MemberStatus crewStatus = MemberStatus.idle}) => OfficeScene.build(
      members: {
        'mH': head('mH', name: '부장', createdAt: '0'),
        'mL': lead('mL', name: '반장', teamId: 't0', parentId: 'mH', status: MemberStatus.working, createdAt: '1'),
        'm1': member('m1', name: '이음', teamId: 't0', parentId: 'mL', status: crewStatus, createdAt: '2'),
      },
      latestEvents: const {},
      pending: const {},
      teams: {'t0': team('t0', name: 't0', createdAt: '0')},
    );

OfficePainter painter(OfficeScene scene, {String? selected, String? hovered, double scroll = 0, Set<String> resumed = const {}}) =>
    OfficePainter(scene: scene, selectedMemberId: selected, hoveredMemberId: hovered, scrollOffset: scroll, resumedIds: resumed);

void main() {
  group('팀 카펫 · 제목 태그(패스 4 구체성)', () {
    test('6색 토큰을 팀 생성 순서로 순환한다', () {
      final p = painter(deptScene(teams: 7));
      expect(OfficeColors.carpets, hasLength(6));
      expect(OfficeColors.carpets[0], const Color(0xFF2F4A3A));
      expect(OfficeColors.carpets[1], const Color(0xFF2F3D5A));
      expect(OfficeColors.carpets[2], const Color(0xFF4A3A2F));
      expect(OfficeColors.carpets[3], const Color(0xFF432F4A));
      expect(OfficeColors.carpets[4], const Color(0xFF2F4A4A));
      expect(OfficeColors.carpets[5], const Color(0xFF4A2F38));
      expect(p.carpetColor(0), OfficeColors.carpets[0]);
      expect(p.carpetColor(5), OfficeColors.carpets[5]);
      expect(p.carpetColor(6), OfficeColors.carpets[0], reason: '7번째 팀은 첫 색으로 돌아온다');
    });

    test('카펫을 팀마다 그 색으로 칠한다', () {
      final p = painter(deptScene(teams: 3));
      for (var i = 0; i < 3; i++) {
        expect(_rrects(p, OfficeColors.carpets[i]), 1, reason: 'team $i');
      }
      expect(_rrects(p, OfficeColors.carpets[3]), 0);
    });

    test('제목 태그는 카펫 색을 40% 밝힌 값, 상자 왼쪽 위에 -8px 걸친다', () {
      final scene = deptScene(teams: 1);
      final layout = OfficeLayout(size: canvasSize, plan: scene.plan);
      final box = layout.clusters.single.rect;
      final tagColor = OfficePainter.lighten(OfficeColors.carpets[0], 0.4);
      expect(tagColor, isNot(OfficeColors.carpets[0]));
      final tags = _collect(
          painter(scene),
          (s, a) => s == #drawRRect && _same((a[1] as Paint).color, tagColor),
          (s, a) => a[0] as RRect);
      expect(tags, hasLength(1));
      expect(tags.single.left, closeTo(box.left - 8 * layout.scale, 0.01));
      expect(tags.single.top, closeTo(box.top - 8 * layout.scale, 0.01));
      expect(tags.single.tlRadiusX, officeRadius);
    });

    test('팀이 없으면(부장만) 카펫 대신 점선 자리', () {
      final scene = OfficeScene.build(
        members: {'mH': head('mH', name: '부장', createdAt: '0')},
        latestEvents: const {},
        pending: const {},
      );
      expect(scene.plan.clusters.single.isPlaceholder, isTrue);
      expect(_rrects(painter(scene), OfficeColors.carpets[0]), 0, reason: '점선 자리라 카펫을 칠하지 않는다');
      expect(_paths(painter(scene), OfficeColors.clusterBorder), greaterThan(4), reason: '점선은 파선 조각 여럿');
    });

    test('"퇴근 N" 배지는 접힌 책상이 있을 때만', () {
      final now = DateTime.parse('2026-09-17T12:00:00Z');
      OfficeScene scene({required bool old}) => OfficeScene.build(
            members: {
              'mH': head('mH', name: '부장', createdAt: '0'),
              'mL': lead('mL', name: '반장', teamId: 't0', parentId: 'mH', createdAt: '1'),
              'm1': Member(
                id: 'm1',
                departmentId: 'd1',
                teamId: 't0',
                parentId: 'mL',
                name: '이음',
                rank: MemberRank.member,
                engine: Engine.claude,
                sessionId: null,
                childPid: null,
                cwd: 'D:/x',
                status: MemberStatus.exited,
                hiredBy: HiredBy.leader,
                memberToken: 'mt',
                instructionsPath: null,
                createdAt: '2',
                updatedAt: old ? '2026-09-17T11:00:00Z' : '2026-09-17T11:59:00Z',
              ),
            },
            latestEvents: const {},
            pending: const {},
            teams: {'t0': team('t0', name: 't0', createdAt: '0')},
            now: now,
          );
      expect(scene(old: false).plan.clusters.single.exitedFolded, 0);
      expect(scene(old: true).plan.clusters.single.exitedFolded, 1);
      expect(_rrects(painter(scene(old: true)), OfficeColors.charGone), 1);
      expect(_rrects(painter(scene(old: false)), OfficeColors.charGone), 0);
    });
  });

  group('부장 앵커 · 책상 상태(패스 1 D5 · 패스 2)', () {
    test('부장 책상 아래 금색 카펫(알파 0.12) + 왕관을 그린다', () {
      final scene = deptScene(teams: 1);
      final layout = OfficeLayout(size: canvasSize, plan: scene.plan);
      final carpet = layout.headCarpetRect(0);
      final gold = OfficeColors.headMark.withValues(alpha: 0.12);
      final rects = _collect(painter(scene), (s, a) => s == #drawRRect && _same((a[1] as Paint).color, gold),
          (s, a) => a[0] as RRect);
      expect(rects, hasLength(1));
      expect(rects.single.left, closeTo(carpet.left, 0.01));
      expect(rects.single.width, closeTo(carpet.width, 0.01));
      expect(rects.single.tlRadiusX, officeRadius);
      // 왕관(도형 — T33 에서 스프라이트로 바뀐다). 부장 책상 위 16px.
      expect(_paths(painter(scene), OfficeColors.headMark), 1);
    });

    test('오류 멤버는 책상 테두리가 빨강', () {
      final ok = deptScene(teams: 1);
      final bad = deptScene(teams: 1, crewStatus: MemberStatus.error);
      final layout = OfficeLayout(size: canvasSize, plan: bad.plan);
      final desk = layout.deskRect(1); // 팀장 책상
      bool red(Symbol s, List<dynamic> a) =>
          s == #drawRRect && _same((a[1] as Paint).color, OfficeColors.charError) && (a[1] as Paint).style == PaintingStyle.stroke;
      expect(_count(painter(ok), red), 0);
      final rects = _collect(painter(bad), red, (s, a) => a[0] as RRect);
      // 책상 테두리 + "⚠ 오류" 말풍선 테두리 둘 다 빨강. 그중 하나는 정확히 그 책상이다.
      expect(rects.where((r) => (r.left - desk.left).abs() < 0.01 && (r.width - desk.width).abs() < 0.01), hasLength(1));
    });

    test('퇴근 책상은 의자만 — 캐릭터 원을 그리지 않는다', () {
      final alive = teamScene();
      final gone = teamScene(crewStatus: MemberStatus.exited);
      expect(_circles(painter(alive), legendColor(LegendSlot.idle)), 2, reason: '부장 + 한가한 팀원');
      expect(_rrects(painter(alive), OfficeColors.chair), 0);
      expect(_circles(painter(gone), legendColor(LegendSlot.idle)), 1, reason: '퇴근한 팀원의 원이 사라진다');
      expect(_circles(painter(gone), legendColor(LegendSlot.exited)), 0, reason: '퇴근은 원 자체가 없다');
      expect(_rrects(painter(gone), OfficeColors.chair), 1, reason: '의자만 남는다');
    });

    test('복구 멤버는 책상 테두리가 점선(금색 파선 여러 조각)', () {
      final scene = deptScene(teams: 1);
      expect(_paths(painter(scene), OfficeColors.headMark), 1, reason: '왕관 하나');
      expect(_paths(painter(scene, resumed: {'mL0'}), OfficeColors.headMark), greaterThan(4));
    });
  });

  group('캐릭터 원 · 말풍선 정책', () {
    test('캐릭터 원 색 = 범례 색(작업 파랑 · 내 차례 주황 · 한가 초록)', () {
      expect(_circles(painter(deptScene(teams: 1)), legendColor(LegendSlot.working)), 1);
      expect(_circles(painter(deptScene(teams: 1, crewStatus: MemberStatus.idle)), legendColor(LegendSlot.idle)),
          greaterThanOrEqualTo(1));

      final waiting = OfficeScene.build(
        members: {'mH': head('mH', name: '부장', status: MemberStatus.waitingApproval, createdAt: '0')},
        latestEvents: const {},
        pending: {'a1': approval('a1', 'mH', 'rm -rf x')},
      );
      expect(waiting.members.single.legendSlot, LegendSlot.myTurn);
      expect(_circles(painter(waiting), legendColor(LegendSlot.myTurn)), 1);
    });

    test('작업 말풍선은 선택·호버일 때만, alert 는 항상, 퇴근은 절대', () {
      final scene = deptScene(teams: 1);
      final lead = scene.memberById('mL0')!;
      expect(lead.isAlert, isFalse);
      expect(painter(scene).showsBubble(lead), isFalse);
      expect(painter(scene, selected: 'mL0').showsBubble(lead), isTrue);
      expect(painter(scene, hovered: 'mL0').showsBubble(lead), isTrue);

      final alert = OfficeScene.build(
        members: {'mH': head('mH', name: '부장', status: MemberStatus.waitingApproval, createdAt: '0')},
        latestEvents: const {},
        pending: {'a1': approval('a1', 'mH', 'ls')},
      );
      expect(painter(alert).showsBubble(alert.members.single), isTrue);

      final exited = teamScene(crewStatus: MemberStatus.exited);
      expect(painter(exited, selected: 'm1').showsBubble(exited.memberById('m1')!), isFalse);
    });
  });

  group('바닥 고정 바 · 스크롤바', () {
    test('범례 7칸의 점을 그린다(점선 칸은 파선 path)', () {
      final p = painter(deptScene(teams: 1));
      for (final slot in LegendSlot.values) {
        if (slot.dashedRing) continue;
        expect(_legendDots(p, legendColor(slot)), 1, reason: slot.label);
      }
      expect(_paths(p, legendColor(LegendSlot.waitingReports)), greaterThan(1), reason: '보고 대기 = 점선 링');
      final layout = OfficeLayout(size: canvasSize, plan: p.scene.plan);
      expect(layout.legendRect.height, closeTo(24 * layout.scale, 0.01));
    });

    test('대기 5건 이상이면 "+N" 배지(주황), 4건 이하면 없다', () {
      OfficeScene waitScene(int n) => OfficeScene.build(
            members: {
              'mH': head('mH', name: '부장', status: MemberStatus.waitingApproval, createdAt: '0'),
              for (var i = 0; i < 3; i++)
                'm$i': member('m$i', name: '팀원$i', status: MemberStatus.waitingApproval, createdAt: '${i + 1}'),
            },
            latestEvents: const {},
            pending: {
              for (var i = 0; i < n; i++)
                'a$i': approval('a$i', i == 0 ? 'mH' : 'm${(i - 1) % 3}', 'cmd$i', createdAt: '2026-09-15T00:00:0${i}Z'),
            },
          );
      expect(waitScene(4).slotOverflow, 0);
      expect(_rrects(painter(waitScene(4)), OfficeColors.charMyTurn), 0);
      expect(waitScene(6).slotOverflow, 2);
      expect(_rrects(painter(waitScene(6)), OfficeColors.charMyTurn), 1);
    });

    test('빈 슬롯은 점선 실루엣 — 대기가 차면 점선이 줄어든다', () {
      OfficeScene waitScene(int n) => OfficeScene.build(
            members: {
              'mH': head('mH', name: '부장', status: MemberStatus.waitingApproval, createdAt: '0'),
              for (var i = 0; i < 3; i++)
                'm$i': member('m$i', name: '팀원$i', status: MemberStatus.waitingApproval, createdAt: '${i + 1}'),
            },
            latestEvents: const {},
            pending: {
              for (var i = 0; i < n; i++)
                'a$i': approval('a$i', i == 0 ? 'mH' : 'm${(i - 1) % 3}', 'cmd$i', createdAt: '2026-09-15T00:00:0${i}Z'),
            },
          );
      final empty = _paths(painter(waitScene(0)), OfficeColors.myDeskTextDim);
      final two = _paths(painter(waitScene(2)), OfficeColors.myDeskTextDim);
      expect(empty, greaterThan(0));
      expect(two, lessThan(empty), reason: '찬 슬롯에는 점선을 그리지 않는다');
    });

    test('스크롤이 필요할 때만 스크롤바를 그린다', () {
      final small = OfficeScene.build(
        members: {'mH': head('mH', name: '부장', createdAt: '0')},
        latestEvents: const {},
        pending: const {},
      );
      expect(_rrects(painter(small), OfficeColors.scrollbar), 0);

      final many = deptScene(teams: 8);
      expect(OfficeLayout(size: canvasSize, plan: many.plan).isScrollable, isTrue);
      expect(_rrects(painter(many), OfficeColors.scrollbar), 1);
    });
  });

  group('패스 4 리트머스: 곡률 4px 단일 · 그림자/글로우/그라데이션 0', () {
    test('모든 둥근 사각형의 곡률은 4', () {
      final bad = _collect(
        painter(deptScene(teams: 3, crewStatus: MemberStatus.error), selected: 'mL0'),
        (s, a) => s == #drawRRect && ((a[0] as RRect).tlRadiusX != officeRadius || (a[0] as RRect).brRadiusY != officeRadius),
        (s, a) => a[0] as RRect,
      );
      expect(bad, isEmpty);
    });

    test('그림자·블러·그라데이션을 쓰지 않는다', () {
      final p = painter(deptScene(teams: 2, crewStatus: MemberStatus.error), selected: 'mL0', hovered: 'mL1');
      expect(
          _count(
              p,
              (s, a) =>
                  s == #drawShadow ||
                  a.any((x) => x is Paint && (x.maskFilter != null || x.shader != null || x.imageFilter != null))),
          0);
    });
  });
}

// ---- 캔버스 호출 세기 -----------------------------------------------------------------

/// Paint 를 거친 색은 Color 끼리 == 가 아니라 32비트 값으로 비교한다.
bool _same(Color a, Color b) => a.toARGB32() == b.toARGB32();

int _count(OfficePainter p, bool Function(Symbol, List<dynamic>) test) {
  final recorder = _Recorder(test);
  p.paint(recorder, canvasSize);
  return recorder.hits;
}

List<T> _collect<T>(OfficePainter p, bool Function(Symbol, List<dynamic>) test, T Function(Symbol, List<dynamic>) pick) {
  final out = <T>[];
  final recorder = _Recorder((s, a) {
    if (!test(s, a)) return false;
    out.add(pick(s, a));
    return true;
  });
  p.paint(recorder, canvasSize);
  return out;
}

/// 캐릭터 원(반지름 9 이상 — 범례 점 8px 과 구분).
int _circles(OfficePainter p, Color color) => _count(
    p,
    (s, a) =>
        s == #drawCircle &&
        (a[1] as double) >= 9 &&
        _same((a[2] as Paint).color, color) &&
        (a[2] as Paint).style == PaintingStyle.fill);

/// 범례 점(반지름 4).
int _legendDots(OfficePainter p, Color color) => _count(
    p,
    (s, a) =>
        s == #drawCircle &&
        (a[1] as double) < 9 &&
        _same((a[2] as Paint).color, color) &&
        (a[2] as Paint).style == PaintingStyle.fill);

/// 채운 둥근 사각형(테두리 stroke 는 세지 않는다).
int _rrects(OfficePainter p, Color color) => _count(
    p, (s, a) => s == #drawRRect && _same((a[1] as Paint).color, color) && (a[1] as Paint).style == PaintingStyle.fill);

int _paths(OfficePainter p, Color color) => _count(p, (s, a) => s == #drawPath && _same((a[1] as Paint).color, color));

/// 필요한 호출만 받는 아주 작은 Canvas 대역(나머지는 무시).
class _Recorder implements Canvas {
  _Recorder(this.test);

  final bool Function(Symbol, List<dynamic>) test;
  int hits = 0;

  void _hit(Symbol s, List<dynamic> args) {
    if (test(s, args)) hits++;
  }

  @override
  void drawCircle(Offset c, double radius, Paint paint) => _hit(#drawCircle, [c, radius, paint]);

  @override
  void drawRRect(RRect rrect, Paint paint) => _hit(#drawRRect, [rrect, paint]);

  @override
  void drawPath(Path path, Paint paint) => _hit(#drawPath, [path, paint]);

  @override
  void drawRect(Rect rect, Paint paint) => _hit(#drawRect, [rect, paint]);

  @override
  void drawLine(Offset p1, Offset p2, Paint paint) => _hit(#drawLine, [p1, p2, paint]);

  @override
  void drawParagraph(ui.Paragraph paragraph, Offset offset) {}

  @override
  void save() {}

  @override
  void restore() {}

  @override
  void translate(double dx, double dy) {}

  @override
  void clipRect(Rect rect, {ui.ClipOp clipOp = ui.ClipOp.intersect, bool doAntiAlias = true}) {}

  @override
  noSuchMethod(Invocation invocation) => null;
}
