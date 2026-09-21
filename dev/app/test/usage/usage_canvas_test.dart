// T43-2 ⑥: 사무실 캔버스의 컨텍스트 경고 막대 — 모니터 아랫변 3px, **70% 이상일 때만**.
// 69 → 없음 / 70 → 주황 / 90 → 빨강 / 퇴근한 멤버 → 없음. 평소엔 아무것도 그리지 않는다(빼기 원칙).
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_layout.dart';
import 'package:pixel_office/office/office_painter.dart';
import 'package:pixel_office/office/office_scene.dart';
import 'package:pixel_office/usage/usage_format.dart';

import '../office/office_fixtures.dart';

const canvasSize = Size(1000, 700);

MemberUsage usage(String id, double percent) =>
    MemberUsage(memberId: id, context: ContextUsage(used: 1000, window: 2000, percent: percent));

/// 부장 + 팀장 하나. 팀장(m = 'mL')에게 [percent] 를 준다.
OfficeScene scene({double? percent, MemberStatus status = MemberStatus.working}) => OfficeScene.build(
      members: {
        'mH': head('mH', name: '부장', createdAt: '0'),
        'mL': lead('mL', name: '반장', teamId: 't0', parentId: 'mH', status: status, createdAt: '1'),
      },
      latestEvents: const {},
      pending: const {},
      teams: {'t0': team('t0', name: 't0', createdAt: '0')},
      usage: percent == null ? const {} : {'mL': usage('mL', percent)},
    );

void main() {
  group('장면(SceneMember.contextPercent)', () {
    test('사용량 맵의 컨텍스트 비율이 장면에 실린다', () {
      expect(scene(percent: 72).memberById('mL')!.contextPercent, 72);
      expect(scene().memberById('mL')!.contextPercent, isNull);
      expect(scene(percent: 72).memberById('mH')!.contextPercent, isNull, reason: '값이 없는 멤버는 null');
    });

    test('퇴근·오류로 나간 멤버의 마지막 값은 캔버스에 올리지 않는다', () {
      // 전원 퇴근한 팀은 책상이 아예 접힌다(패스 2 이슈 7) — 장면에 없거나, 있어도 값이 없다.
      expect(scene(percent: 95, status: MemberStatus.exited).memberById('mL')?.contextPercent, isNull);
      expect(scene(percent: 95, status: MemberStatus.error).memberById('mL')!.contextPercent, isNull);
    });

    test('컨텍스트가 바뀌면 장면도 달라진다(페인터 shouldRepaint 가 값 비교로 잡는다)', () {
      expect(scene(percent: 70), isNot(scene(percent: 71)));
      expect(scene(percent: 70), scene(percent: 70));
    });
  });

  group('경고 막대(설계 §앱 3)', () {
    test('69 → 안 그린다, 70 → 주황, 90 → 빨강', () {
      expect(_bars(scene(percent: 69)), isEmpty);
      expect(_bars(scene()), isEmpty, reason: '값이 아예 없으면 당연히 없다');
      expect(_bars(scene(percent: 70), color: usageWarnColor), hasLength(1));
      expect(_bars(scene(percent: 89), color: usageWarnColor), hasLength(1));
      expect(_bars(scene(percent: 90), color: usageDangerColor), hasLength(1));
      expect(_bars(scene(percent: 100), color: usageDangerColor), hasLength(1));
    });

    test('퇴근한 멤버는 책상이 남아 있어도 막대가 없다', () {
      // 팀장은 살아 있고 팀원만 퇴근 — 퇴근한 책상(의자만)은 그대로 남는다.
      OfficeScene withExited({required MemberStatus crew}) => OfficeScene.build(
            members: {
              'mH': head('mH', name: '부장', createdAt: '0'),
              'mL': lead('mL', name: '반장', teamId: 't0', parentId: 'mH', createdAt: '1'),
              'm1': member('m1', name: '이음', teamId: 't0', parentId: 'mL', status: crew, createdAt: '2'),
            },
            latestEvents: const {},
            pending: const {},
            teams: {'t0': team('t0', name: 't0', createdAt: '0')},
            usage: {'m1': usage('m1', 95)},
          );
      expect(_bars(withExited(crew: MemberStatus.working)), hasLength(1), reason: '일하는 중이면 막대가 있다');
      expect(withExited(crew: MemberStatus.exited).memberById('m1'), isNotNull, reason: '책상은 남는다');
      expect(_bars(withExited(crew: MemberStatus.exited)), isEmpty);
      expect(_bars(withExited(crew: MemberStatus.error)), isEmpty);
    });

    test('자리는 그 책상 모니터의 아랫변, 두께 3px', () {
      final s = scene(percent: 90);
      final layout = OfficeLayout(size: canvasSize, plan: s.plan);
      final monitor = layout.monitorRect(1); // 팀장 책상
      final bar = _bars(s, color: usageDangerColor).single;
      expect(bar.left, closeTo(monitor.left, 0.01));
      expect(bar.width, closeTo(monitor.width, 0.01));
      expect(bar.bottom, closeTo(monitor.bottom, 0.01));
      expect(bar.height, OfficeLayout.contextWarningThickness);
      expect(bar.height, 3);
    });

    test('색 규칙은 패널 막대와 같은 하나를 쓴다', () {
      expect(contextWarningColor(70), usageWarnColor);
      expect(contextWarningColor(90), usageDangerColor);
      expect(contextWarningColor(69.9), isNull);
    });
  });
}

// ---- 캔버스 대역(office_painter_test 와 같은 방식) ---------------------------------------

bool _same(Color a, Color b) => a.toARGB32() == b.toARGB32();

/// 경고 막대로 그려진 사각형들(색을 주면 그 색만).
List<Rect> _bars(OfficeScene s, {Color? color}) {
  final out = <Rect>[];
  final painter = OfficePainter(scene: s);
  final recorder = _Recorder((sym, a) {
    if (sym != #drawRect) return;
    final rect = a[0] as Rect;
    final paint = a[1] as Paint;
    if (rect.height != OfficeLayout.contextWarningThickness) return;
    if (color != null && !_same(paint.color, color)) return;
    // 바닥·모니터 같은 큰 사각형과 구분: 경고 막대는 두께 3px 짜리다.
    if (color == null && !_same(paint.color, usageWarnColor) && !_same(paint.color, usageDangerColor)) return;
    out.add(rect);
  });
  painter.paint(recorder, canvasSize);
  return out;
}

class _Recorder implements Canvas {
  _Recorder(this.hit);

  final void Function(Symbol, List<dynamic>) hit;

  @override
  void drawRect(Rect rect, Paint paint) => hit(#drawRect, [rect, paint]);

  @override
  void drawCircle(Offset c, double radius, Paint paint) {}

  @override
  void drawRRect(RRect rrect, Paint paint) {}

  @override
  void drawPath(Path path, Paint paint) {}

  @override
  void drawLine(Offset p1, Offset p2, Paint paint) {}

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
