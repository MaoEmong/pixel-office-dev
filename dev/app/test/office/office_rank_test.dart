// T24b → T37: 사무실 캔버스의 **직급 표시**(부장 "♛ 부장" 금색 · 팀장 "★ 팀장" 은색 배지 + 캐릭터 링)와
// 파생 `waiting_reports` 문구. 그림은 `paints` 매처(TestRecordingCanvas)로 본다 — 페인터에 Canvas 를 직접 넘길 수 있다.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_layout.dart';
import 'package:pixel_office/office/office_painter.dart';
import 'package:pixel_office/office/office_scene.dart';

import 'office_fixtures.dart';

const size = Size(1000, 700);

/// Paint 의 색이 [c] 인가. 기록된 Paint 의 색은 float32 를 거쳐 와서 `==` 로는 안 맞는다 — ARGB 정수로 비교한다.
bool _isColor(Object? paint, Color c) => paint is Paint && paint.color.toARGB32() == c.toARGB32();

bool Function(Symbol, List<dynamic>) ringOf(Color c) =>
    (method, args) => method == #drawCircle && args.length >= 3 && _isColor(args[2], c);

bool Function(Symbol, List<dynamic>) badgeOf(Color c) =>
    (method, args) => method == #drawRRect && args.length >= 2 && _isColor(args[1], c);

final headRing = ringOf(OfficeColors.headMark);
final headBadge = badgeOf(OfficeColors.headMark);
final leadRing = ringOf(OfficeColors.leadMark);
final leadBadge = badgeOf(OfficeColors.leadMark);

/// 부장 1 + 팀장 1 + 팀원 1 의 한 부서.
OfficeScene sceneOf({
  MemberRank leadRank = MemberRank.lead,
  DerivedStatus? leadDerived,
  MemberStatus leadStatus = MemberStatus.idle,
  bool withHead = true,
}) =>
    OfficeScene.build(
      members: {
        if (withHead) 'mH': head('mH', name: '부장', createdAt: '0'),
        'mL': member('mL', name: '반장', rank: leadRank, status: leadStatus, parentId: 'mH', createdAt: '1'),
        'm1': member('m1', name: '이음', parentId: 'mL', createdAt: '2'),
      },
      latestEvents: {'mL': event('mL', OfficeEventKind.idle), 'm1': event('m1', OfficeEventKind.thinking)},
      pending: const {},
      derived: leadDerived == null ? const {} : {'mL': leadDerived},
      teams: {'t1': team('t1', name: 't1')},
    );

void main() {
  test('직급 배지 라벨: 부장 ♛ · 팀장 ★ · 팀원 없음', () {
    expect(rankBadgeLabel(MemberRank.head), '♛ 부장');
    expect(rankBadgeLabel(MemberRank.lead), '★ 팀장');
    expect(rankBadgeLabel(MemberRank.member), '');
  });

  testWidgets('부장 책상에는 금색 배지·링, 팀장 책상에는 은색 배지·링이 붙는다', (tester) async {
    final scene = sceneOf();
    expect(scene.memberById('mH')!.isHead, isTrue);
    expect(scene.memberById('mL')!.isLead, isTrue);
    expect(scene.memberById('m1')!.rank, MemberRank.member);

    final painter = OfficePainter(scene: scene);
    // 책상(배지 사각형)이 먼저, 캐릭터(링)가 나중에 그려진다 — 순서대로 나와야 한다.
    expect(
      (Canvas canvas) => painter.paint(canvas, size),
      paints
        ..something(headBadge)
        ..something(leadBadge)
        ..something(headRing)
        ..something(leadRing),
    );
  });

  testWidgets('팀원만 있는 사무실에는 직급 표시가 없다', (tester) async {
    final painter = OfficePainter(scene: sceneOf(leadRank: MemberRank.member, withHead: false));
    expect((Canvas canvas) => painter.paint(canvas, size), isNot(paints..something(headRing)));
    expect((Canvas canvas) => painter.paint(canvas, size), isNot(paints..something(leadRing)));
    expect((Canvas canvas) => painter.paint(canvas, size), isNot(paints..something(leadBadge)));
  });

  testWidgets('퇴근한 팀장은 은색 링 없이 회색 원으로만 (책상 배지는 남는다)', (tester) async {
    final painter = OfficePainter(scene: sceneOf(leadStatus: MemberStatus.exited));
    expect((Canvas canvas) => painter.paint(canvas, size), isNot(paints..something(leadRing)));
    expect((Canvas canvas) => painter.paint(canvas, size), paints..something(leadBadge));
  });

  testWidgets('시맨틱 라벨에 직급이 들어가고, 히트 테스트는 그대로다', (tester) async {
    final scene = sceneOf();
    final painter = OfficePainter(scene: scene);
    final nodes = painter.semanticsBuilder(size);
    expect(nodes.first.properties.label, '책상 1 · 부장 · Claude · 부장 · (대기)');
    expect(nodes[1].properties.label, '책상 2 · 반장 · Claude · 팀장 · (대기)');
    expect(nodes[2].properties.label, isNot(contains('팀장')));

    // 표시가 붙어도 캐릭터 원·책상 클릭 판정은 T12 그대로(반경 charRadius + 4).
    final layout = OfficeLayout(size: size, plan: scene.plan);
    expect(layout.hitTest(layout.seatCenter(0), scene), 'mH');
    expect(layout.hitTest(layout.seatCenter(0) + Offset(layout.charRadius + 3, 0), scene), 'mH');
    expect(layout.hitTest(layout.deskRect(2).center, scene), 'm1');
    expect(layout.hitTest(Offset.zero, scene), isNull);
  });

  test('파생 waiting_reports → 모니터·말풍선 "📨 보고 대기"(마지막 이벤트 idle 보다 앞선다)', () {
    expect(summarize(MemberStatus.idle, event('mL', OfficeEventKind.idle), derived: DerivedStatus.waitingReports),
        waitingReportsSummary);
    final m = sceneOf(leadDerived: DerivedStatus.waitingReports).memberById('mL')!;
    expect(m.summary, '✉ 보고 대기');
    expect(m.bubbleText, '✉ 보고 대기');
    // 사용자 응답 대기가 아니므로 내 책상 줄에 서지 않고 alert 말풍선도 아니다.
    expect(m.isQueued, isFalse);
    expect(m.isAlert, isFalse);
  });
}
