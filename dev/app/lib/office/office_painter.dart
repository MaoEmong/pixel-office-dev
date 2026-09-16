// 사무실 CustomPainter(D-09). 외부 에셋 없이 평면 도형 + TextPainter 로 그린다.
// 그리는 것: 바둑판 바닥, 문, **팀 클러스터 상자(제목 줄)**, 책상(라벨·직급/엔진 배지·모니터),
//   내 책상(제목·대기 목록), 캐릭터(원 + 이름 첫 글자), 말풍선.
// T24b/T37: 부장은 "♛ 부장", 팀장은 "★ 팀장" 배지(엔진 배지 왼쪽)와 캐릭터 링이 붙는다(부장 금색 [OfficeColors.headMark],
//   팀장 은색 [OfficeColors.leadMark]) — 그림만 바뀌고 히트 테스트 반경(OfficeLayout.charRadius + 4)은 그대로다.
// 기하는 전부 OfficeLayout, 텍스트는 전부 OfficeScene 에서 온다 — 여기엔 색·글꼴·그리기 순서만.
// T16: 캐릭터 위치는 [placements] 로 밖(OfficeMotion)에서 받을 수 있다(null 이면 레이아웃의 즉시 배치).
//   [bob] 은 작업 중 흔들림(id → dy), [bubbleOverrides] 는 보고 방문 등 말풍선 덮어쓰기(항상 alert 스타일).

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../model/models.dart';
import 'office_layout.dart';
import 'office_scene.dart';

/// 직급 표시 색(부장 금색 · 팀장 은색 · 팀원 없음).
Color rankMarkColor(MemberRank rank) => switch (rank) {
      MemberRank.head => OfficeColors.headMark,
      MemberRank.lead => OfficeColors.leadMark,
      MemberRank.member => OfficeColors.deskLabel,
    };

/// 어두운 팔레트(main.dart 의 사무실 바탕 0xFF1B1F2A 와 맞춤).
abstract final class OfficeColors {
  static const floor = Color(0xFF1B1F2A);
  static const floorGrid = Color(0xFF222736);
  static const deskFill = Color(0xFF2A3042);
  static const deskBorder = Color(0xFF4A5268);
  static const deskLabel = Color(0xFFAAB2C8);
  static const badgeClaude = Color(0xFFE0956E);
  static const badgeCodex = Color(0xFF8FB4FF);

  /// 부장 표시(책상 "♛ 부장" 배지 + 캐릭터 금색 링). T24b 의 `leaderMark` 를 직급별로 나눈 것(T37).
  static const headMark = Color(0xFFFFD166);

  /// 팀장 표시(책상 "★ 팀장" 배지 + 캐릭터 은색 링).
  static const leadMark = Color(0xFFBFC7DA);

  /// 팀 클러스터 상자.
  static const clusterBorder = Color(0xFF39415A);
  static const clusterTitle = Color(0xFF8A93A8);
  static const monitorFill = Color(0xFF10141D);
  static const monitorBorder = Color(0xFF3A4258);
  static const monitorText = Color(0xFF9BE7A1);
  static const monitorTextDim = Color(0xFF6B7385);
  static const myDeskFill = Color(0xFF2E2A3F);
  static const myDeskBorder = Color(0xFFC9B6FF);
  static const myDeskText = Color(0xFFEDE7FF);
  static const myDeskTextDim = Color(0xFF9A90B8);
  static const door = Color(0xFF8A93A8);
  static const hint = Color(0xFF8A93A8);
  static const charWorking = Color(0xFF6C8EFF);
  static const charIdle = Color(0xFF7ED3A1);
  static const charWaiting = Color(0xFFFFC857);
  static const charStarting = Color(0xFF8A93A8);
  static const charGone = Color(0xFF474D5E);
  static const charGoneText = Color(0xFF8A93A8);
  static const charText = Color(0xFFFFFFFF);
  static const charOutline = Color(0xFF10141D);
  static const selectedRing = Color(0xFFFFFFFF);
  static const bubbleFill = Color(0xFFF3F4F8);
  static const bubbleBorder = Color(0xFF9AA3B8);
  static const bubbleText = Color(0xFF1B1F2A);
  static const bubbleAlertBorder = Color(0xFFFFB020);
}

/// 멤버가 하나도 없을 때 사무실 가운데 문구(T37: 출근 버튼이 없어졌다 — 사용자는 부서를 만든다).
const String emptyOfficeHint = '"부서 만들기" 로 부장을 임명하세요';

class OfficePainter extends CustomPainter {
  OfficePainter({
    required this.scene,
    this.selectedMemberId,
    this.textDirection = TextDirection.ltr,
    this.fontFamily,
    this.fontFamilyFallback,
    this.placements,
    this.bob = const {},
    this.bubbleOverrides = const {},
  });

  final OfficeScene scene;
  final String? selectedMemberId;
  final TextDirection textDirection;

  /// 캐릭터 위치(장면 순서). null 이면 `OfficeLayout.placements(scene)`(즉시 배치).
  final List<CharacterPlacement>? placements;

  /// 멤버 id → 세로 흔들림(px). 원만 흔들리고 말풍선·시맨틱은 그대로.
  final Map<String, double> bob;

  /// 멤버 id → 말풍선 텍스트 덮어쓰기(alert 스타일). 보고 방문 중 "📄 보고".
  final Map<String, String> bubbleOverrides;

  /// 글꼴 지정(앱에서는 null = 시스템 기본. 테스트 렌더링에서 FontLoader 로 올린 글꼴을 쓸 때).
  final String? fontFamily;
  final List<String>? fontFamilyFallback;

  /// 마지막 paint 의 레이아웃(히트 테스트·테스트에서 참조).
  OfficeLayout? lastLayout;
  List<CharacterPlacement> lastPlacements = const [];

  OfficeLayout layoutFor(Size size) => OfficeLayout(size: size, plan: scene.plan);

  List<CharacterPlacement> _placementsFor(OfficeLayout layout) {
    final given = placements;
    return given != null && given.length == scene.members.length ? given : layout.placements(scene);
  }

  /// 자기 자리를 비웠는가(줄·보고 방문·걷는 중). 퇴근·오류는 자리 기준으로 보지 않는다.
  bool _isAway(OfficeLayout layout, SceneMember m, CharacterPlacement p) =>
      !m.isGone && (p.center - layout.seatCenter(m.deskIndex)).distance > 0.5;

  @override
  void paint(Canvas canvas, Size size) {
    final layout = layoutFor(size);
    final placements = _placementsFor(layout);
    lastLayout = layout;
    lastPlacements = placements;

    _paintFloor(canvas, size, layout);
    _paintDoor(canvas, layout);
    _paintClusters(canvas, layout);
    for (var i = 0; i < scene.members.length; i++) {
      _paintDesk(canvas, layout, scene.members[i], away: _isAway(layout, scene.members[i], placements[i]));
    }
    _paintMyDesk(canvas, layout);
    if (scene.isEmpty) {
      _text(canvas, emptyOfficeHint, layout.emptyHintCenter,
          style: TextStyle(color: OfficeColors.hint, fontSize: 15 * layout.fontScale), anchor: Alignment.center);
    }
    // 캐릭터는 책상·내 책상 위에, 말풍선은 맨 위에.
    for (var i = 0; i < scene.members.length; i++) {
      _paintCharacter(canvas, layout, scene.members[i], placements[i]);
    }
    for (var i = 0; i < scene.members.length; i++) {
      _paintBubble(canvas, layout, scene.members[i], placements[i]);
    }
  }

  // ---- 바닥 · 문 -----------------------------------------------------------------

  void _paintFloor(Canvas canvas, Size size, OfficeLayout layout) {
    canvas.drawRect(Offset.zero & size, Paint()..color = OfficeColors.floor);
    final grid = Paint()
      ..color = OfficeColors.floorGrid
      ..strokeWidth = 1;
    final step = 40.0 * layout.scale;
    for (var x = step; x < size.width; x += step) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), grid);
    }
    for (var y = step; y < size.height; y += step) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), grid);
    }
  }

  void _paintDoor(Canvas canvas, OfficeLayout layout) {
    canvas.drawRect(layout.doorRect, Paint()..color = OfficeColors.door);
    _text(canvas, '문', layout.doorLabelPos,
        style: TextStyle(color: OfficeColors.deskLabel, fontSize: 11 * layout.fontScale), anchor: Alignment.centerLeft);
  }

  // ---- 팀 클러스터 -----------------------------------------------------------------

  /// 팀마다 상자 + 제목 줄("팀 t1 · 2명"). 부장 책상은 클러스터 밖(맨 윗줄)이다.
  void _paintClusters(Canvas canvas, OfficeLayout layout) {
    for (final c in layout.clusters) {
      final rr = RRect.fromRectAndRadius(c.rect, Radius.circular(6 * layout.scale));
      canvas.drawRRect(
          rr,
          Paint()
            ..color = OfficeColors.clusterBorder
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1);
      final title = c.title;
      if (title != null) {
        _text(canvas, title, c.titleBaseline,
            style: TextStyle(color: OfficeColors.clusterTitle, fontSize: 11 * layout.fontScale, fontWeight: FontWeight.w600),
            anchor: Alignment.topLeft,
            maxWidth: c.rect.width - 12 * layout.scale);
      }
    }
  }

  // ---- 책상 --------------------------------------------------------------------

  void _paintDesk(Canvas canvas, OfficeLayout layout, SceneMember m, {bool? away}) {
    final isAway = away ?? m.isQueued;
    final d = layout.deskRect(m.deskIndex);
    final fs = layout.fontScale;
    final rr = RRect.fromRectAndRadius(d, Radius.circular(4 * layout.scale));
    canvas.drawRRect(rr, Paint()..color = OfficeColors.deskFill);
    canvas.drawRRect(
        rr,
        Paint()
          ..color = OfficeColors.deskBorder
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1);

    // 라벨 "책상 N · 이름" (왼쪽 위), 엔진 배지(오른쪽 위).
    final badgeStyle = TextStyle(
      color: m.engine.name == 'claude' ? OfficeColors.badgeClaude : OfficeColors.badgeCodex,
      fontSize: 9 * fs,
      fontWeight: FontWeight.w600,
    );
    final badge = _layoutText(m.engineLabel, badgeStyle);
    final pad = 4 * layout.scale;
    final badgeRect = Rect.fromLTWH(d.right - pad - badge.width - 6, d.top + pad, badge.width + 6, badge.height + 2);
    canvas.drawRRect(
        RRect.fromRectAndRadius(badgeRect, const Radius.circular(3)),
        Paint()
          ..color = badgeStyle.color!
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1);
    badge.paint(canvas, Offset(badgeRect.left + 3, badgeRect.top + 1));

    // 직급 배지(엔진 배지 왼쪽). 사용자 지시는 "♛ 부장" 책상으로만 간다(01 §직무 체계 rev 3).
    var labelRight = badgeRect.left;
    final rankLabel = rankBadgeLabel(m.rank);
    if (rankLabel.isNotEmpty) {
      final rankColor = rankMarkColor(m.rank);
      final rankStyle = TextStyle(color: rankColor, fontSize: 9 * fs, fontWeight: FontWeight.w600);
      final rankText = _layoutText(rankLabel, rankStyle);
      final rankRect = Rect.fromLTWH(
          badgeRect.left - 4 * layout.scale - rankText.width - 6, badgeRect.top, rankText.width + 6, badgeRect.height);
      canvas.drawRRect(
          RRect.fromRectAndRadius(rankRect, const Radius.circular(3)),
          Paint()
            ..color = rankColor
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1);
      rankText.paint(canvas, Offset(rankRect.left + 3, rankRect.top + 1));
      labelRight = rankRect.left;
    }

    _text(canvas, m.deskLabel, Offset(d.left + 6 * layout.scale, d.top + pad),
        style: TextStyle(color: OfficeColors.deskLabel, fontSize: 11 * fs),
        anchor: Alignment.topLeft,
        maxWidth: labelRight - d.left - 8 * layout.scale);

    // 모니터.
    final mon = layout.monitorRect(m.deskIndex);
    canvas.drawRect(mon, Paint()..color = OfficeColors.monitorFill);
    canvas.drawRect(
        mon,
        Paint()
          ..color = OfficeColors.monitorBorder
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1);
    final dim = m.isGone || isAway || m.summary.startsWith('(');
    _text(canvas, isAway ? '(자리 비움)' : m.summary, Offset(mon.left + 4, mon.center.dy),
        style: TextStyle(
          color: dim ? OfficeColors.monitorTextDim : OfficeColors.monitorText,
          fontSize: 10 * fs,
          fontFamily: 'Consolas',
          fontFamilyFallback: const ['Cascadia Mono', 'Malgun Gothic', 'monospace'],
        ),
        anchor: Alignment.centerLeft,
        maxWidth: mon.width - 8);
  }

  // ---- 내 책상 -------------------------------------------------------------------

  void _paintMyDesk(Canvas canvas, OfficeLayout layout) {
    final r = layout.myDeskRect;
    final fs = layout.fontScale;
    final rr = RRect.fromRectAndRadius(r, Radius.circular(6 * layout.scale));
    canvas.drawRRect(rr, Paint()..color = OfficeColors.myDeskFill);
    canvas.drawRRect(
        rr,
        Paint()
          ..color = OfficeColors.myDeskBorder
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2);
    final pad = 8 * layout.scale;
    _text(canvas, '내 책상', Offset(r.left + pad, r.top + 6 * layout.scale),
        style: TextStyle(color: OfficeColors.myDeskText, fontSize: 13 * fs, fontWeight: FontWeight.bold),
        anchor: Alignment.topLeft);
    final lineH = 15 * fs;
    var y = r.top + 6 * layout.scale + 13 * fs + 8 * layout.scale;
    final maxLines = ((r.bottom - pad - y) / lineH).floor();
    if (scene.queue.isEmpty) {
      _text(canvas, '(대기 없음)', Offset(r.left + pad, y),
          style: TextStyle(color: OfficeColors.myDeskTextDim, fontSize: 11 * fs), anchor: Alignment.topLeft);
      return;
    }
    final sep = Paint()
      ..color = OfficeColors.myDeskTextDim.withValues(alpha: 0.5)
      ..strokeWidth = 1;
    for (var i = 0; i < scene.queue.length && i < maxLines; i++) {
      if (i > 0) canvas.drawLine(Offset(r.left + pad, y - 2), Offset(r.right - pad, y - 2), sep);
      final more = i == maxLines - 1 && scene.queue.length > maxLines;
      final label = more ? '… 외 ${scene.queue.length - maxLines + 1}건' : scene.queue[i].line(i);
      _text(canvas, label, Offset(r.left + pad, y),
          style: TextStyle(color: OfficeColors.myDeskText, fontSize: 11 * fs),
          anchor: Alignment.topLeft,
          maxWidth: r.width - 2 * pad);
      y += lineH;
    }
  }

  // ---- 캐릭터 · 말풍선 -------------------------------------------------------------

  Color _charColor(SceneMember m) {
    if (m.isGone) return OfficeColors.charGone;
    if (m.status.isWaiting) return OfficeColors.charWaiting;
    return switch (m.status.name) {
      'working' => OfficeColors.charWorking,
      'idle' => OfficeColors.charIdle,
      'starting' => OfficeColors.charStarting,
      _ => OfficeColors.charStarting,
    };
  }

  void _paintCharacter(Canvas canvas, OfficeLayout layout, SceneMember m, CharacterPlacement p) {
    final r = layout.charRadius;
    final c = p.center + Offset(0, bob[m.id] ?? 0);
    // 직급 링(부장 금색 · 팀장 은색). 선택 링(흰색, r+4)보다 안쪽이라 둘 다 보인다.
    // 히트 테스트 반경(charRadius+4)은 그대로.
    if (m.rank != MemberRank.member && !m.isGone) {
      canvas.drawCircle(
          c,
          r + 2,
          Paint()
            ..color = rankMarkColor(m.rank)
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2);
    }
    if (m.id == selectedMemberId) {
      canvas.drawCircle(
          c,
          r + 4,
          Paint()
            ..color = OfficeColors.selectedRing
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2.5);
    }
    canvas.drawCircle(c, r, Paint()..color = _charColor(m));
    canvas.drawCircle(
        c,
        r,
        Paint()
          ..color = OfficeColors.charOutline
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.5);
    _text(canvas, m.initial, c,
        style: TextStyle(
          color: m.isGone ? OfficeColors.charGoneText : OfficeColors.charText,
          fontSize: r * 0.95,
          fontWeight: FontWeight.bold,
        ),
        anchor: Alignment.center);
  }

  void _paintBubble(Canvas canvas, OfficeLayout layout, SceneMember m, CharacterPlacement p) {
    if (m.isGone) return; // 퇴근·오류는 모니터·회색 원으로만
    final fs = layout.fontScale;
    final override = bubbleOverrides[m.id];
    final alert = override != null || m.isAlert;
    final style = TextStyle(
      color: OfficeColors.bubbleText,
      fontSize: 11 * fs,
      fontWeight: alert ? FontWeight.bold : FontWeight.normal,
    );
    final tp = _layoutText(override != null ? truncate(override, bubbleMaxChars) : m.bubbleText, style);
    final padX = 6 * layout.scale, padY = 3 * layout.scale;
    final w = tp.width + padX * 2, h = tp.height + padY * 2;
    final tail = 6 * layout.scale;
    // 화면 밖으로 안 나가게 가로만 밀어 넣는다.
    var left = p.bubbleAnchor.dx - w / 2;
    left = left.clamp(2.0, (layout.size.width - w - 2).clamp(2.0, double.infinity));
    final top = (p.bubbleAnchor.dy - tail - h).clamp(2.0, double.infinity);
    final rect = Rect.fromLTWH(left, top, w, h);
    final rr = RRect.fromRectAndRadius(rect, Radius.circular(4 * layout.scale));
    final tailPath = Path()
      ..moveTo(p.bubbleAnchor.dx - tail, rect.bottom - 0.5)
      ..lineTo(p.bubbleAnchor.dx, rect.bottom + tail)
      ..lineTo(p.bubbleAnchor.dx + tail, rect.bottom - 0.5)
      ..close();
    final fill = Paint()..color = OfficeColors.bubbleFill;
    final border = Paint()
      ..color = alert ? OfficeColors.bubbleAlertBorder : OfficeColors.bubbleBorder
      ..style = PaintingStyle.stroke
      ..strokeWidth = alert ? 2.5 : 1;
    canvas.drawRRect(rr, fill);
    canvas.drawPath(tailPath, fill);
    canvas.drawRRect(rr, border);
    canvas.drawPath(tailPath, border);
    // 꼬리와 몸통 사이 테두리 지우기.
    canvas.drawLine(Offset(p.bubbleAnchor.dx - tail + 1, rect.bottom), Offset(p.bubbleAnchor.dx + tail - 1, rect.bottom), fill..strokeWidth = 2);
    tp.paint(canvas, Offset(rect.left + padX, rect.top + padY));
  }

  // ---- 텍스트 -----------------------------------------------------------------------

  TextPainter _layoutText(String s, TextStyle style, {double? maxWidth}) => TextPainter(
        text: TextSpan(
          text: s,
          style: style.copyWith(
            fontFamily: style.fontFamily ?? fontFamily,
            fontFamilyFallback: [...?style.fontFamilyFallback, ...?fontFamilyFallback],
          ),
        ),
        textDirection: textDirection,
        maxLines: 1,
        ellipsis: '…',
      )..layout(maxWidth: maxWidth ?? double.infinity);

  void _text(Canvas canvas, String s, Offset at, {required TextStyle style, Alignment anchor = Alignment.topLeft, double? maxWidth}) {
    final tp = _layoutText(s, style, maxWidth: maxWidth != null && maxWidth > 0 ? maxWidth : null);
    final dx = at.dx - tp.width * (anchor.x + 1) / 2;
    final dy = at.dy - tp.height * (anchor.y + 1) / 2;
    tp.paint(canvas, Offset(dx, dy));
  }

  // ---- 접근성 · 재그리기 ----------------------------------------------------------------

  @override
  SemanticsBuilderCallback get semanticsBuilder => (Size size) {
        final layout = layoutFor(size);
        final placements = _placementsFor(layout);
        return [
          for (var i = 0; i < scene.members.length; i++)
            CustomPainterSemantics(
              // 자리를 비운 캐릭터(줄·보고·걷는 중)는 지금 위치의 원, 자리에 있으면 책상.
              rect: _isAway(layout, scene.members[i], placements[i])
                  ? Rect.fromCircle(center: placements[i].center, radius: layout.charRadius)
                  : layout.deskRect(scene.members[i].deskIndex),
              properties: SemanticsProperties(
                label: '${scene.members[i].deskLabel} · ${scene.members[i].engineLabel}'
                    '${rankBadgeLabel(scene.members[i].rank).isEmpty ? '' : ' · ${scene.members[i].rank.label}'}'
                    ' · ${scene.members[i].summary}'
                    '${scene.members[i].isQueued ? ' · 내 책상 줄' : bubbleOverrides.containsKey(scene.members[i].id) ? ' · ${bubbleOverrides[scene.members[i].id]}' : ''}',
                selected: scene.members[i].id == selectedMemberId,
                button: true,
                textDirection: textDirection,
              ),
            ),
          CustomPainterSemantics(
            rect: layout.myDeskRect,
            properties: SemanticsProperties(
              label: scene.queue.isEmpty
                  ? '내 책상 · 대기 없음'
                  : '내 책상 · ${[for (var i = 0; i < scene.queue.length; i++) scene.queue[i].line(i)].join(' / ')}',
              textDirection: textDirection,
            ),
          ),
          CustomPainterSemantics(
            rect: layout.doorRect.inflate(8),
            properties: SemanticsProperties(label: '문', textDirection: textDirection),
          ),
        ];
      };

  @override
  bool shouldRepaint(OfficePainter oldDelegate) =>
      shouldRebuildSemantics(oldDelegate) || !_mapEq(oldDelegate.bob, bob);

  /// 흔들림(bob)은 시맨틱에 영향 없음 — 장면·선택·위치·말풍선 덮어쓰기만.
  @override
  bool shouldRebuildSemantics(OfficePainter oldDelegate) =>
      oldDelegate.scene != scene ||
      oldDelegate.selectedMemberId != selectedMemberId ||
      !_listEq(oldDelegate.placements, placements) ||
      !_mapEq(oldDelegate.bubbleOverrides, bubbleOverrides);

  static bool _listEq<T>(List<T>? a, List<T>? b) {
    if (identical(a, b)) return true;
    if (a == null || b == null || a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  static bool _mapEq<K, V>(Map<K, V> a, Map<K, V> b) {
    if (identical(a, b)) return true;
    if (a.length != b.length) return false;
    for (final e in a.entries) {
      if (!b.containsKey(e.key) || b[e.key] != e.value) return false;
    }
    return true;
  }
}
