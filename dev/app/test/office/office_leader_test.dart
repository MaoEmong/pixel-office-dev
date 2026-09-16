// T24b: 사무실 캔버스의 팀장 표시(책상 "팀장" 배지 + 캐릭터 금색 링)와 파생 `waiting_reports` 문구.
// 그림은 `paints` 매처(TestRecordingCanvas)로 본다 — 페인터에 Canvas 를 직접 넘길 수 있다.
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

/// 금색 캐릭터 링(`drawCircle(center, radius, paint)`).
bool leaderRing(Symbol method, List<dynamic> args) =>
    method == #drawCircle && args.length >= 3 && _isColor(args[2], OfficeColors.leaderMark);

/// 금색 책상 배지(`drawRRect(rrect, paint)`).
bool leaderBadge(Symbol method, List<dynamic> args) =>
    method == #drawRRect && args.length >= 2 && _isColor(args[1], OfficeColors.leaderMark);

OfficeScene sceneOf({MemberRank leaderRank = MemberRank.leader, DerivedStatus? leaderDerived, MemberStatus leaderStatus = MemberStatus.idle}) =>
    OfficeScene.build(
      members: {
        'mL': member('mL', name: '반장', rank: leaderRank, status: leaderStatus, createdAt: '1'),
        'm1': member('m1', name: '이음', createdAt: '2'),
      },
      latestEvents: {'mL': event('mL', OfficeEventKind.idle), 'm1': event('m1', OfficeEventKind.thinking)},
      pending: const {},
      derived: leaderDerived == null ? const {} : {'mL': leaderDerived},
    );

void main() {
  testWidgets('팀장 책상에는 "팀장" 배지, 캐릭터에는 금색 링이 붙는다', (tester) async {
    final scene = sceneOf();
    expect(scene.memberById('mL')!.isLeader, isTrue);
    expect(scene.memberById('m1')!.isLeader, isFalse);

    final painter = OfficePainter(scene: scene);
    // 책상(배지 사각형)이 먼저, 캐릭터(링)가 나중에 그려진다 — 순서대로 둘 다 나와야 한다.
    expect(
      (Canvas canvas) => painter.paint(canvas, size),
      paints
        ..something(leaderBadge)
        ..something(leaderRing),
    );
  });

  testWidgets('팀원만 있는 사무실에는 팀장 표시가 없다', (tester) async {
    final painter = OfficePainter(scene: sceneOf(leaderRank: MemberRank.member));
    expect((Canvas canvas) => painter.paint(canvas, size), isNot(paints..something(leaderRing)));
    expect((Canvas canvas) => painter.paint(canvas, size), isNot(paints..something(leaderBadge)));
  });

  testWidgets('퇴근한 팀장은 금색 링 없이 회색 원으로만 (책상 배지는 남는다)', (tester) async {
    final painter = OfficePainter(scene: sceneOf(leaderStatus: MemberStatus.exited));
    expect((Canvas canvas) => painter.paint(canvas, size), isNot(paints..something(leaderRing)));
    expect((Canvas canvas) => painter.paint(canvas, size), paints..something(leaderBadge));
  });

  testWidgets('시맨틱 라벨에 팀장이 들어가고, 히트 테스트는 그대로다', (tester) async {
    final scene = sceneOf();
    final painter = OfficePainter(scene: scene);
    final nodes = painter.semanticsBuilder(size);
    expect(nodes.first.properties.label, '책상 1 · 반장 · Claude · 팀장 · (대기)');
    expect(nodes[1].properties.label, isNot(contains('팀장')));

    // 표시가 붙어도 캐릭터 원·책상 클릭 판정은 T12 그대로(반경 charRadius + 4).
    final layout = OfficeLayout(size: size, deskCount: scene.members.length);
    expect(layout.hitTest(layout.seatCenter(0), scene), 'mL');
    expect(layout.hitTest(layout.seatCenter(0) + Offset(layout.charRadius + 3, 0), scene), 'mL');
    expect(layout.hitTest(layout.deskRect(1).center, scene), 'm1');
    expect(layout.hitTest(Offset.zero, scene), isNull);
  });

  test('파생 waiting_reports → 모니터·말풍선 "📨 보고 대기"(마지막 이벤트 idle 보다 앞선다)', () {
    expect(summarize(MemberStatus.idle, event('mL', OfficeEventKind.idle), derived: DerivedStatus.waitingReports),
        waitingReportsSummary);
    final m = sceneOf(leaderDerived: DerivedStatus.waitingReports).memberById('mL')!;
    expect(m.summary, '📨 보고 대기');
    expect(m.bubbleText, '📨 보고 대기');
    // 사용자 응답 대기가 아니므로 내 책상 줄에 서지 않고 alert 말풍선도 아니다.
    expect(m.isQueued, isFalse);
    expect(m.isAlert, isFalse);
  });
}
