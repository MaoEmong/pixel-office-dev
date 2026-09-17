// 사무실 CustomPainter(D-09 · 레이아웃 v2 T40-2 · 스프라이트 T33). 평면 도형 + TextPainter + 픽셀 아틀라스.
// 곡률은 전부 4px 하나, 그림자·글로우·그라데이션 없음(패스 4 리트머스 7).
//
// 그리는 것(스크롤 영역): 바닥 격자, **팀 카펫**(6색 토큰 순환 + 제목 태그), **부장 금색 카펫 + 왕관**,
//   책상(이름·직급/엔진 배지·모니터 2줄·오류 테두리 빨강·복구 점선·퇴근 의자), 캐릭터(링 + 스프라이트), 말풍선.
// 그리는 것(바닥 고정 바): 내 책상(헤더 "내 책상 · 대기 N" + 슬롯 4칸 + "+N" 배지), **범례 7칸**.
// 문과 스크롤바는 뷰포트 좌표로 고정.
//
// 색·문구 토큰의 출처는 docs/design/레이아웃-v2.md §4(패스 4 구체성) — [OfficeColors] 가 코드 쪽 단일 소스다.
// 상태 → 색·아이콘 매핑은 **office_scene.dart 의 [legendSlotOf] 하나**만 쓴다(링·범례·패널 공용, D-42 3).
//
// T33: 캐릭터·소품은 **스프라이트**다([sprites] = 32×32 아틀라스 8벌). 포즈는 office_sprites.dart 의
//   [spritePoseOf](범례 칸 + 이벤트 + 방문 여부), 걷는 중이면 [walk] 의 프레임, 타이핑은 [typeFrame].
//   **[sprites] 가 null 이면 예전 원**으로 그린다 — 에셋을 읽는 첫 프레임과 미리보기·테스트 경로.
//   왕관·별·의자·범례 아이콘도 아틀라스에서 온다(범례 아이콘은 흰 실루엣을 범례 색으로 물들인다).
//
// T16: 캐릭터 위치는 [placements] 로 밖(OfficeMotion)에서 받을 수 있다(null 이면 레이아웃의 즉시 배치).
//   [bob] 은 작업 중 흔들림(id → dy), [bubbleOverrides] 는 보고 방문 등 말풍선 덮어쓰기(항상 alert 스타일).

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../model/models.dart';
import 'office_layout.dart';
import 'office_scene.dart';
import 'office_sprites.dart';

/// 직급 표시 색(부장 금색 · 팀장 은색 · 팀원 없음).
Color rankMarkColor(MemberRank rank) => switch (rank) {
      MemberRank.head => OfficeColors.headMark,
      MemberRank.lead => OfficeColors.leadMark,
      MemberRank.member => OfficeColors.deskLabel,
    };

/// 범례 칸의 색(= 캐릭터 링 색). 매핑은 [legendSlotOf] 하나뿐이다.
Color legendColor(LegendSlot slot) => Color(slot.argb);

/// 어두운 팔레트(main.dart 의 사무실 바탕 0xFF1B1F2A 와 맞춤).
/// 문서 쪽 단일 소스: docs/design/레이아웃-v2.md §4 토큰 표(패스 5 이슈 12).
abstract final class OfficeColors {
  static const floor = Color(0xFF1B1F2A);
  static const floorGrid = Color(0xFF222736);
  static const deskFill = Color(0xFF2A3042);
  static const deskBorder = Color(0xFF4A5268);
  static const deskLabel = Color(0xFFAAB2C8);
  static const badgeClaude = Color(0xFFE0956E);
  static const badgeCodex = Color(0xFF8FB4FF);

  /// 부장 표시(왕관 · 금색 카펫 · 캐릭터 금색 링).
  static const headMark = Color(0xFFFFD166);

  /// 팀장 표시(책상 "★ 팀장" 배지 + 캐릭터 은색 링).
  static const leadMark = Color(0xFFBFC7DA);

  /// 팀 카펫 6색 토큰 — **팀 생성 순서로 순환**(패스 4 구체성 · 패스 7 등록부).
  static const carpets = <Color>[
    Color(0xFF2F4A3A),
    Color(0xFF2F3D5A),
    Color(0xFF4A3A2F),
    Color(0xFF432F4A),
    Color(0xFF2F4A4A),
    Color(0xFF4A2F38),
  ];

  /// 팀 클러스터(테두리는 카펫 위 옅은 선).
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

  /// "내 차례"(주황, 신규 — 패스 2 매핑표): 사용자가 답해야 하는 상태.
  static const charMyTurn = Color(0xFFFF9F43);
  static const charStarting = Color(0xFF8A93A8);
  static const charGone = Color(0xFF474D5E);
  static const charGoneText = Color(0xFF8A93A8);

  /// 오류 포즈(T30): 비정상 종료한 멤버의 붉은 링 + **책상 테두리**(패스 2).
  static const charError = Color(0xFFFF6B6B);
  static const charText = Color(0xFFFFFFFF);
  static const charOutline = Color(0xFF10141D);
  static const selectedRing = Color(0xFFFFFFFF);
  static const bubbleFill = Color(0xFFF3F4F8);
  static const bubbleBorder = Color(0xFF9AA3B8);
  static const bubbleText = Color(0xFF1B1F2A);
  static const bubbleAlertBorder = Color(0xFFFFB020);

  /// 의자(퇴근한 책상에 남는 것).
  static const chair = Color(0xFF3A4054);

  /// 스크롤바(패스 6: 6px 팔레트 색).
  static const scrollbar = Color(0xFF4A5268);
}

/// 모든 모서리 곡률(패스 4: 4px 단일).
const double officeRadius = 4;

/// 캔버스 서체 — 라벨·말풍선·모니터 전부 **Galmuri11**(한글 픽셀 서체, OFL. 패스 4 구체성 · D-43 4).
/// system-ui 를 표시 서체로 쓰지 않는다.
const String officeFontFamily = 'Galmuri11';

/// Galmuri11 에 없는 글자를 대신 낼 순서. **번들 서체를 먼저** 둔다 — T40 편차 ⑤ 에서 시스템 폴백이
/// `♛`·`📨`·`⏳` 를 두부로 냈기 때문. `♛` 는 D2Coding 에만 있다(office_scene.dart 의 기호 표).
const List<String> officeFontFallback = ['D2Coding', 'Pretendard', 'Malgun Gothic'];

/// 픽셀 서체는 **정수 크기**에서만 또렷하다 — 캔버스 글자 크기는 반올림해서 쓴다(하한 1px).
double officeFontPx(double base, double fontScale) => math.max(1, (base * fontScale).roundToDouble());

/// 멤버가 하나도 없을 때 사무실 가운데 문구(T37 → T40-6 에서 부서 0 은 버튼으로 바뀐다).
const String emptyOfficeHint = '"부서 만들기" 로 부장을 임명하세요';

/// 자리를 비운 책상의 모니터 문구.
const String awayMonitorText = '(자리 비움)';

class OfficePainter extends CustomPainter {
  OfficePainter({
    required this.scene,
    this.selectedMemberId,
    this.hoveredMemberId,
    this.textDirection = TextDirection.ltr,
    this.fontFamily = officeFontFamily,
    this.fontFamilyFallback = officeFontFallback,
    this.placements,
    this.bob = const {},
    this.bubbleOverrides = const {},
    this.scrollOffset = 0,
    this.resumedIds = const {},
    this.showEmptyHint = true,
    this.sprites,
    this.walk = const {},
    this.visitingIds = const {},
    this.typeFrame = 0,
  });

  final OfficeScene scene;
  final String? selectedMemberId;

  /// 마우스가 올라간 멤버 — 작업 말풍선은 선택·호버일 때만 보인다(패스 4: 말풍선 밭 방지).
  final String? hoveredMemberId;
  final TextDirection textDirection;

  /// 캐릭터 위치(장면 순서). null 이면 `OfficeLayout.placements(scene)`(즉시 배치).
  final List<CharacterPlacement>? placements;

  /// 멤버 id → 세로 흔들림(px). 원만 흔들리고 말풍선·시맨틱은 그대로.
  final Map<String, double> bob;

  /// 멤버 id → 말풍선 텍스트 덮어쓰기(alert 스타일). 보고 방문 중 "▤ 보고", 복구 직후 "↻ 복구됨".
  final Map<String, String> bubbleOverrides;

  /// 스크롤 영역이 내려간 거리(px). 바(내 책상·범례)·문은 영향받지 않는다.
  final double scrollOffset;

  /// 복구 표시(책상 점선) 중인 멤버.
  final Set<String> resumedIds;

  /// 빈 사무실 문구를 그릴지(부서 0 일 때는 위젯이 큰 버튼을 얹으므로 끈다 — T40-6).
  final bool showEmptyHint;

  /// 캔버스 글꼴(기본 [officeFontFamily] = Galmuri11). null 로 주면 시스템 기본으로 되돌린다.
  final String? fontFamily;
  final List<String>? fontFamilyFallback;

  /// 스프라이트 아틀라스(T33). **null 이면 예전 원**으로 그린다 — 에셋을 읽는 첫 프레임과
  /// 아틀라스를 안 넘긴 테스트·미리보기가 그 경로다.
  final SpriteSheet? sprites;

  /// 걷는 중인 멤버의 프레임·방향(`OfficeMotion.walkAt`). 없으면 포즈를 쓴다.
  final Map<String, SpriteWalk> walk;

  /// 지금 내 책상에 보고하러 와 있는 멤버(`OfficeMotion.visits`) — report 포즈.
  final Set<String> visitingIds;

  /// 타이핑 2프레임 중 지금 프레임(0·1). 0.5초마다 바뀐다(`typeFrameAt`).
  final int typeFrame;

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

  /// **바닥 고정 바**에 그리는 캐릭터인가 — 내 책상 슬롯에 선 대기자와 보고 방문 중인 멤버.
  bool _inBar(OfficeLayout layout, SceneMember m) => layout.drawsInBar(m) || bubbleOverrides.containsKey(m.id);

  @override
  void paint(Canvas canvas, Size size) {
    final layout = layoutFor(size);
    final placed = _placementsFor(layout);
    lastLayout = layout;
    lastPlacements = placed;
    final dy = layout.clampScroll(scrollOffset);

    _paintFloor(canvas, size, layout);

    // ---- 스크롤 영역(콘텐츠 좌표) ----
    canvas.save();
    canvas.clipRect(layout.viewportRect);
    canvas.translate(0, -dy);
    _paintClusters(canvas, layout);
    if (scene.plan.hasHead) _paintHeadAnchor(canvas, layout);
    for (var i = 0; i < scene.members.length; i++) {
      _paintDesk(canvas, layout, scene.members[i], away: _isAway(layout, scene.members[i], placed[i]));
    }
    for (var i = 0; i < scene.members.length; i++) {
      if (_inBar(layout, scene.members[i])) continue;
      _paintCharacter(canvas, layout, scene.members[i], placed[i]);
    }
    for (var i = 0; i < scene.members.length; i++) {
      if (_inBar(layout, scene.members[i])) continue;
      _paintBubble(canvas, layout, scene.members[i], placed[i]);
    }
    _paintVisitorOverflow(canvas, layout);
    canvas.restore();

    // ---- 고정(뷰포트 좌표) ----
    _paintDoor(canvas, layout);
    _paintScrollbar(canvas, layout, dy);
    if (scene.isEmpty && showEmptyHint) {
      _text(canvas, emptyOfficeHint, layout.emptyHintCenter,
          style: TextStyle(color: OfficeColors.hint, fontSize: officeFontPx(15, layout.fontScale)), anchor: Alignment.center);
    }
    _paintMyDesk(canvas, layout);
    _paintLegend(canvas, layout);
    for (var i = 0; i < scene.members.length; i++) {
      if (!_inBar(layout, scene.members[i])) continue;
      _paintCharacter(canvas, layout, scene.members[i], placed[i]);
    }
    for (var i = 0; i < scene.members.length; i++) {
      if (!_inBar(layout, scene.members[i])) continue;
      _paintBubble(canvas, layout, scene.members[i], placed[i]);
    }
  }

  // ---- 바닥 · 문 · 스크롤바 -----------------------------------------------------------

  void _paintFloor(Canvas canvas, Size size, OfficeLayout layout) {
    canvas.drawRect(Offset.zero & size, Paint()..color = OfficeColors.floor);
    final grid = Paint()
      ..color = OfficeColors.floorGrid
      ..strokeWidth = 1;
    final step = 40.0 * layout.scale;
    for (var x = step; x < size.width; x += step) {
      canvas.drawLine(Offset(x, 0), Offset(x, layout.viewportHeight), grid);
    }
    for (var y = step; y < layout.viewportHeight; y += step) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), grid);
    }
  }

  void _paintDoor(Canvas canvas, OfficeLayout layout) {
    canvas.drawRect(layout.doorRect, Paint()..color = OfficeColors.door);
    _text(canvas, '문', layout.doorLabelPos,
        style: TextStyle(color: OfficeColors.deskLabel, fontSize: officeFontPx(11, layout.fontScale)), anchor: Alignment.centerLeft);
  }

  void _paintScrollbar(Canvas canvas, OfficeLayout layout, double dy) {
    if (!layout.isScrollable) return;
    const w = 6.0;
    final track = layout.viewportHeight;
    final thumbH = math.max(24.0, track * track / layout.contentHeight);
    final top = (track - thumbH) * (dy / layout.maxScroll);
    canvas.drawRRect(
      RRect.fromRectAndRadius(Rect.fromLTWH(layout.size.width - w - 2, top, w, thumbH), const Radius.circular(officeRadius)),
      Paint()..color = OfficeColors.scrollbar,
    );
  }

  // ---- 팀 카펫 · 부장 앵커 ----------------------------------------------------------

  Color carpetColor(int i) => OfficeColors.carpets[i % OfficeColors.carpets.length];

  /// 제목 태그 색 = 카펫 색을 40% 밝힌 값(패스 4).
  static Color lighten(Color c, double amount) => Color.lerp(c, const Color(0xFFFFFFFF), amount)!;

  /// 팀마다 색 카펫 + 왼쪽 위에 -8px 걸친 제목 태그. 부장 책상은 클러스터 밖(맨 윗줄)이다.
  void _paintClusters(Canvas canvas, OfficeLayout layout) {
    final s = layout.scale;
    for (final c in layout.clusters) {
      final rr = RRect.fromRectAndRadius(c.rect, const Radius.circular(officeRadius));
      final color = carpetColor(c.colorIndex);
      if (c.isPlaceholder) {
        // 아직 팀이 없다 — 점선 자리(T40-6).
        _dashedRRect(canvas, rr, OfficeColors.clusterBorder, 1);
      } else {
        canvas.drawRRect(rr, Paint()..color = color);
        canvas.drawRRect(
            rr,
            Paint()
              ..color = lighten(color, 0.15)
              ..style = PaintingStyle.stroke
              ..strokeWidth = 1);
      }
      final title = c.title;
      if (title == null) continue;
      if (c.isPlaceholder) {
        _text(canvas, title, c.rect.center,
            style: TextStyle(color: OfficeColors.clusterTitle, fontSize: officeFontPx(12, layout.fontScale)),
            anchor: Alignment.center,
            maxWidth: c.rect.width - 12 * s);
        continue;
      }
      // 제목 태그: 상자 왼쪽 위에 -8px 걸침, 12px 굵게.
      final tagColor = lighten(color, 0.4);
      final style = TextStyle(color: OfficeColors.floor, fontSize: officeFontPx(12, layout.fontScale), fontWeight: FontWeight.bold);
      final tp = _layoutText(title, style, maxWidth: c.rect.width);
      final tag = Rect.fromLTWH(c.rect.left - 8 * s, c.rect.top - 8 * s, tp.width + 10 * s, tp.height + 4 * s);
      canvas.drawRRect(RRect.fromRectAndRadius(tag, const Radius.circular(officeRadius)), Paint()..color = tagColor);
      tp.paint(canvas, Offset(tag.left + 5 * s, tag.top + 2 * s));
      // "퇴근 N" 배지(10분 넘게 퇴근한 책상을 접었다 — 클릭하면 펼친다).
      if (c.exitedFolded > 0) {
        final badgeStyle = TextStyle(color: OfficeColors.charGoneText, fontSize: officeFontPx(10, layout.fontScale));
        final bp = _layoutText('퇴근 ${c.exitedFolded}', badgeStyle);
        final br = Rect.fromLTWH(tag.right + 6 * s, tag.top, bp.width + 10 * s, tag.height);
        canvas.drawRRect(
            RRect.fromRectAndRadius(br, const Radius.circular(officeRadius)),
            Paint()
              ..color = OfficeColors.charGone
              ..style = PaintingStyle.fill);
        bp.paint(canvas, Offset(br.left + 5 * s, br.top + 2 * s));
      }
    }
  }

  /// 부장 앵커(패스 1 D5): 책상 사방 +20px 금색 카펫(알파 0.12) + 책상 위 16px 왕관.
  /// 왕관은 T33 에서 **스프라이트**가 됐다 — 아틀라스가 없으면 예전 도형으로 그린다.
  void _paintHeadAnchor(Canvas canvas, OfficeLayout layout) {
    final desk = layout.deskRect(0);
    canvas.drawRRect(
      RRect.fromRectAndRadius(layout.headCarpetRect(0), const Radius.circular(officeRadius)),
      Paint()..color = OfficeColors.headMark.withValues(alpha: 0.12),
    );
    if (sprites != null) {
      final r = spritePropRect(
        SpriteProp.crown,
        Offset(desk.center.dx, desk.top - 16 * layout.scale - SpriteProp.crown.inCell.height * layout.spriteScale / 2),
        layout.spriteScale,
      );
      _drawProp(canvas, SpriteProp.crown, r);
      return;
    }
    final w = 16.0 * layout.scale;
    final h = 11.0 * layout.scale;
    final cx = desk.center.dx;
    final bottom = desk.top - 16 * layout.scale;
    final crown = Path()
      ..moveTo(cx - w / 2, bottom)
      ..lineTo(cx - w / 2, bottom - h)
      ..lineTo(cx - w / 4, bottom - h * 0.45)
      ..lineTo(cx, bottom - h * 1.15)
      ..lineTo(cx + w / 4, bottom - h * 0.45)
      ..lineTo(cx + w / 2, bottom - h)
      ..lineTo(cx + w / 2, bottom)
      ..close();
    canvas.drawPath(crown, Paint()..color = OfficeColors.headMark);
  }

  // ---- 책상 --------------------------------------------------------------------

  void _paintDesk(Canvas canvas, OfficeLayout layout, SceneMember m, {bool? away}) {
    final isAway = away ?? m.isQueued;
    final d = layout.deskRect(m.deskIndex);
    final fs = layout.fontScale;
    final s = layout.scale;
    final exited = m.status == MemberStatus.exited;
    final rr = RRect.fromRectAndRadius(d, const Radius.circular(officeRadius));
    canvas.drawRRect(rr, Paint()..color = exited ? OfficeColors.charGone.withValues(alpha: 0.35) : OfficeColors.deskFill);
    if (m.isError) {
      // 오류: 책상 테두리 빨강(패스 2 매핑표).
      canvas.drawRRect(
          rr,
          Paint()
            ..color = OfficeColors.charError
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2);
    } else if (resumedIds.contains(m.id)) {
      // 복구 직후 3초: 점선 테두리(패스 2 D10).
      _dashedRRect(canvas, rr, OfficeColors.headMark, 1.5);
    } else {
      canvas.drawRRect(
          rr,
          Paint()
            ..color = OfficeColors.deskBorder
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1);
    }

    // 퇴근한 책상은 **의자만** 남긴다(캐릭터는 안 그린다 — [_paintCharacter]).
    // 의자도 T33 에서 스프라이트가 됐다. 자리는 캐릭터가 앉던 곳([OfficeLayout.seatCenter])이다.
    if (exited) {
      if (sprites != null) {
        _drawProp(canvas, SpriteProp.chair,
            spritePropRect(SpriteProp.chair, layout.seatCenter(m.deskIndex), layout.spriteScale));
      } else {
        final cw = 18 * s, ch = 12 * s;
        final chair = Rect.fromCenter(center: Offset(d.center.dx, d.bottom + ch * 0.6), width: cw, height: ch);
        canvas.drawRRect(
            RRect.fromRectAndRadius(chair, const Radius.circular(officeRadius)), Paint()..color = OfficeColors.chair);
      }
    }

    // 라벨 = **이름(굵게)** + 직급 배지 + 엔진 배지(패스 1 D7). 좁아지면 엔진 → 직급 글자 → 이름 순으로 줄인다.
    final pad = 4 * s;
    var labelRight = d.right - pad;
    if (showsEngineBadge(layout.scale)) {
      final badgeStyle = TextStyle(
        color: m.engine == Engine.claude ? OfficeColors.badgeClaude : OfficeColors.badgeCodex,
        fontSize: officeFontPx(9, fs),
        fontWeight: FontWeight.w600,
      );
      final badge = _layoutText(m.engineLabel, badgeStyle);
      final badgeRect = Rect.fromLTWH(d.right - pad - badge.width - 6, d.top + pad, badge.width + 6, badge.height + 2);
      canvas.drawRRect(
          RRect.fromRectAndRadius(badgeRect, const Radius.circular(officeRadius)),
          Paint()
            ..color = badgeStyle.color!
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1);
      badge.paint(canvas, Offset(badgeRect.left + 3, badgeRect.top + 1));
      labelRight = badgeRect.left;
    }

    // 직급 배지. **직급은 왕관/별로만 구분한다**(D-43 5) — T33 부터 `♛`·`★` 글자 대신 아틀라스 소품을
    // 그리고 글자는 "부장"/"팀장" 만 남긴다(좁아지면 소품만). 아틀라스가 없으면 예전 글자 배지 그대로.
    final rankProp = sprites == null ? null : rankPropFor(m.rank);
    final rankLabel = rankProp != null ? (showsRankLabel(layout.scale) ? m.rank.label : '') : rankBadgeAt(m.rank, layout.scale);
    if (rankProp != null || rankLabel.isNotEmpty) {
      final rankColor = rankMarkColor(m.rank);
      final rankStyle = TextStyle(color: rankColor, fontSize: officeFontPx(9, fs), fontWeight: FontWeight.w600);
      final rankText = rankLabel.isEmpty ? null : _layoutText(rankLabel, rankStyle);
      final iconH = rankProp == null ? 0.0 : officeFontPx(9, fs);
      final icon = rankProp == null ? Rect.zero : spritePropRectForHeight(rankProp, Offset.zero, iconH);
      final gap = rankProp != null && rankText != null ? 3.0 : 0.0;
      final innerW = icon.width + gap + (rankText?.width ?? 0);
      final innerH = math.max(icon.height, rankText?.height ?? 0);
      final rankRect = Rect.fromLTWH(labelRight - 4 * s - innerW - 6, d.top + pad, innerW + 6, innerH + 2);
      canvas.drawRRect(
          RRect.fromRectAndRadius(rankRect, const Radius.circular(officeRadius)),
          Paint()
            ..color = rankColor
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1);
      var ix = rankRect.left + 3;
      if (rankProp != null) {
        _drawProp(canvas, rankProp,
            spritePropRectForHeight(rankProp, Offset(ix + icon.width / 2, rankRect.center.dy), iconH));
        ix += icon.width + gap;
      }
      rankText?.paint(canvas, Offset(ix, rankRect.top + 1));
      labelRight = rankRect.left;
    }

    _text(canvas, m.deskLabel, Offset(d.left + 6 * s, d.top + pad),
        style: TextStyle(
          color: exited ? OfficeColors.charGoneText : OfficeColors.deskLabel,
          fontSize: officeFontPx(11, fs),
          fontWeight: FontWeight.bold,
        ),
        anchor: Alignment.topLeft,
        maxWidth: labelRight - d.left - 8 * s);

    // 모니터 2줄(위: 명령/도구, 아래: 결과 요약). 좁으면 둘째 줄을 숨긴다.
    final mon = layout.monitorRect(m.deskIndex);
    canvas.drawRect(mon, Paint()..color = OfficeColors.monitorFill);
    canvas.drawRect(
        mon,
        Paint()
          ..color = OfficeColors.monitorBorder
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1);
    final second = showsMonitorSecondLine(layout.scale) && !isAway ? m.monitorBottom : null;
    final dim = m.isGone || isAway || m.summary.startsWith('(');
    // 모니터도 캔버스 서체(Galmuri11)다 — 패스 4 "캔버스 라벨·말풍선·모니터 = Galmuri11".
    // 픽셀 서체는 자체가 고정폭에 가까워 옛 Consolas 지정은 뺐다.
    final monStyle = TextStyle(
      color: dim ? OfficeColors.monitorTextDim : OfficeColors.monitorText,
      fontSize: officeFontPx(9, fs),
    );
    final topText = isAway ? awayMonitorText : m.monitorTop;
    if (second == null) {
      _text(canvas, topText, Offset(mon.left + 4, mon.center.dy),
          style: monStyle, anchor: Alignment.centerLeft, maxWidth: mon.width - 8);
    } else {
      _text(canvas, topText, Offset(mon.left + 4, mon.top + mon.height * 0.28),
          style: monStyle, anchor: Alignment.centerLeft, maxWidth: mon.width - 8);
      _text(canvas, second, Offset(mon.left + 4, mon.top + mon.height * 0.72),
          style: monStyle.copyWith(color: OfficeColors.monitorTextDim), anchor: Alignment.centerLeft, maxWidth: mon.width - 8);
    }
  }

  // ---- 내 책상(바닥 고정 바) ----------------------------------------------------------

  void _paintMyDesk(Canvas canvas, OfficeLayout layout) {
    final r = layout.myDeskRect;
    final fs = layout.fontScale;
    final s = layout.scale;
    final rr = RRect.fromRectAndRadius(r, const Radius.circular(officeRadius));
    canvas.drawRRect(rr, Paint()..color = OfficeColors.myDeskFill);
    canvas.drawRRect(
        rr,
        Paint()
          ..color = OfficeColors.myDeskBorder
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2);
    _text(canvas, scene.myDeskHeader, Offset(r.left + 8 * s, r.top + 5 * s),
        style: TextStyle(color: OfficeColors.myDeskText, fontSize: officeFontPx(12, fs), fontWeight: FontWeight.bold),
        anchor: Alignment.topLeft,
        maxWidth: r.width - 16 * s);

    // 슬롯 4칸(오래된 것부터 왼쪽). 빈 슬롯은 점선 실루엣, 찬 슬롯의 캐릭터는 따로 그린다.
    for (var k = 0; k < OfficeLayout.myDeskSlots; k++) {
      final c = layout.slotCenter(k);
      if (scene.slotEntry(k) != null) continue;
      _dashedCircle(canvas, c, layout.slotRadius, OfficeColors.myDeskTextDim, 1);
    }
    // 5명째부터 "+N" 배지(맨 오른쪽 슬롯 위).
    if (scene.slotOverflow > 0) {
      final br = layout.overflowBadgeRect;
      canvas.drawRRect(
          RRect.fromRectAndRadius(br, const Radius.circular(officeRadius)), Paint()..color = OfficeColors.charMyTurn);
      _text(canvas, '+${scene.slotOverflow}', br.center,
          style: TextStyle(color: OfficeColors.floor, fontSize: officeFontPx(10, fs), fontWeight: FontWeight.bold),
          anchor: Alignment.center);
    }
  }

  // ---- 범례 7칸 -------------------------------------------------------------------

  /// 범례 아이콘 높이(글자 높이에 맞춘 정수 px).
  double legendIconHeight(double fontScale) => officeFontPx(10, fontScale);

  void _paintLegend(Canvas canvas, OfficeLayout layout) {
    final rect = layout.legendRect;
    final fs = layout.fontScale;
    final style = TextStyle(color: OfficeColors.hint, fontSize: officeFontPx(11, fs));
    var x = rect.left;
    final cy = rect.center.dy;
    const dot = 8.0;
    final iconH = legendIconHeight(fs);
    for (final slot in LegendSlot.values) {
      // 아이콘은 **아틀라스에 그린 것**을 범례 색으로 물들여 쓴다(T33) — `✉`·`◷` 글자는 서체에 기대야 해서
      // 캔버스에서는 쓰지 않는다(T40 편차 ⑤). 아틀라스가 없으면 예전처럼 글자로.
      final prop = sprites == null ? null : legendPropFor(slot);
      final label = prop != null || slot.icon.isEmpty ? slot.label : '${slot.icon} ${slot.label}';
      final tp = _layoutText(label, style);
      final icon = prop == null ? Rect.zero : spritePropRectForHeight(prop, Offset.zero, iconH);
      final iconW = prop == null ? 0.0 : icon.width + 4;
      final w = dot + 5 + iconW + tp.width + 14 * layout.scale;
      if (x + w > rect.right) break;
      final center = Offset(x + dot / 2, cy);
      if (slot.dashedRing) {
        _dashedCircle(canvas, center, dot / 2, legendColor(slot), 1.5);
      } else {
        canvas.drawCircle(center, dot / 2, Paint()..color = legendColor(slot));
      }
      var tx = x + dot + 5;
      if (prop != null) {
        _drawProp(canvas, prop, spritePropRectForHeight(prop, Offset(tx + icon.width / 2, cy), iconH),
            tint: legendColor(slot));
        tx += iconW;
      }
      tp.paint(canvas, Offset(tx, cy - tp.height / 2));
      x += w;
    }
  }

  // ---- 캐릭터 · 말풍선 -------------------------------------------------------------

  Color charColor(SceneMember m) => legendColor(m.legendSlot);

  /// 이 멤버가 지금 취할 포즈. 걷는 중이면 포즈 대신 걷기 프레임을 쓴다([_characterSrc]).
  SpritePose poseOf(SceneMember m) => spritePoseOf(m, visiting: visitingIds.contains(m.id));

  /// 상태·직급·선택 링의 한가운데.
  ///
  /// 원을 그리던 때는 링과 원이 같은 중심이라 딱 맞았다. 스프라이트는 **세로로 길고 머리가 좁아**
  /// 같은 자리에 두면 링이 머리 양옆으로 삐져나와 옷깃처럼 보인다(T33 실기 — 팀장 은색 링에서 발견).
  /// 그래서 스프라이트일 때는 링을 **발치**로 내린다 — 바닥에 놓인 상태 표시로 읽히고, 이웃 슬롯
  /// (간격 36px)과도 안 겹친다. 색·굵기·점선 여부는 그대로다.
  Offset ringCenter(OfficeLayout layout, Offset characterCenter) =>
      sprites == null ? characterCenter : characterCenter + Offset(0, spriteFeetDy(layout.spriteScale));

  /// 지금 그릴 아틀라스 칸 — 걷는 중이면 걷기 줄, 아니면 포즈 줄(타이핑은 2프레임).
  Rect _characterSrc(SceneMember m) {
    final w = walk[m.id];
    if (w != null) return spriteWalkSrc(w.frame, facingLeft: w.facingLeft);
    return spritePoseSrc(poseOf(m), frame: typeFrame);
  }

  /// 픽셀아트 전용 Paint — **보간 금지**(D-43 3). 확대해도 픽셀 경계가 살아 있어야 한다.
  Paint _spritePaint({Color? tint}) {
    final p = Paint()
      ..filterQuality = FilterQuality.none
      ..isAntiAlias = false;
    if (tint != null) p.colorFilter = ColorFilter.mode(tint, BlendMode.srcIn);
    return p;
  }

  /// 소품·아이콘 한 개. 아틀라스가 아직 없으면 아무것도 안 그린다(호출부가 도형으로 대신한다).
  void _drawProp(Canvas canvas, SpriteProp prop, Rect dst, {Color? tint}) {
    final sheet = sprites;
    if (sheet == null) return;
    canvas.drawImageRect(sheet.props, prop.src, dst, _spritePaint(tint: tint));
  }

  void _paintCharacter(Canvas canvas, OfficeLayout layout, SceneMember m, CharacterPlacement p) {
    // 퇴근한 책상에는 **의자만** 남는다(패스 2 매핑표 "퇴근") — 의자는 [_paintDesk] 가 그린다.
    if (m.status == MemberStatus.exited) return;
    final r = layout.charRadius;
    final c = p.center + Offset(0, bob[m.id] ?? 0);
    final ring = ringCenter(layout, c);
    final slot = m.legendSlot;
    if (m.isError) {
      canvas.drawCircle(
          ring,
          r + 2,
          Paint()
            ..color = OfficeColors.charError
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2.5);
    } else if (slot.dashedRing) {
      // 보고 대기: 초록 **점선** 링(색만으로 구분하지 않는다).
      _dashedCircle(canvas, ring, r + 2, legendColor(slot), 2);
    } else if (m.rank != MemberRank.member && !m.isGone) {
      // 직급 링(부장 금색 · 팀장 은색). 선택 링(흰색, r+4)보다 안쪽이라 둘 다 보인다.
      canvas.drawCircle(
          ring,
          r + 2,
          Paint()
            ..color = rankMarkColor(m.rank)
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2);
    }
    if (m.id == selectedMemberId) {
      canvas.drawCircle(
          ring,
          r + 4,
          Paint()
            ..color = OfficeColors.selectedRing
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2.5);
    }
    // 링 위에 **스프라이트**를 얹는다(T33). 아틀라스가 아직 안 올라온 첫 프레임과 아틀라스를 안 넘긴
    // 테스트·미리보기에서는 예전 원 + 머리글자로 그린다 — 사무실이 잠깐이라도 비지 않게.
    final sheet = sprites;
    if (sheet == null) {
      canvas.drawCircle(c, r, Paint()..color = charColor(m));
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
      return;
    }
    canvas.drawImageRect(
      sheet.imageFor(m.engine, m.name), // 셔츠 = 엔진색, 머리 = 이름 해시(D-43 5)
      _characterSrc(m),
      alignSpriteRect(layout.spriteCell(c)), // 32×32 × 정수 배율, 정수 자리
      _spritePaint(),
    );
  }

  /// 말풍선을 지금 보여 주는가(패스 4): alert(내 차례·대기·오류·보고 방문)는 항상, 작업 말풍선은 선택·호버일 때만.
  bool showsBubble(SceneMember m) {
    if (m.status == MemberStatus.exited) return false;
    if (bubbleOverrides.containsKey(m.id) || m.isAlert || m.isError) return true;
    return m.id == selectedMemberId || m.id == hoveredMemberId;
  }

  void _paintBubble(Canvas canvas, OfficeLayout layout, SceneMember m, CharacterPlacement p) {
    if (!showsBubble(m)) return;
    final override = bubbleOverrides[m.id];
    final alert = override != null || m.isAlert || m.isError;
    _bubble(canvas, layout, p.bubbleAnchor, override != null ? truncate(override, bubbleMaxChars) : m.bubbleText,
        alert: alert, error: m.isError);
  }

  /// 상사 책상 옆 3명째부터의 "+N" 말풍선(두 번째 자리 위 — 패스 2 이슈 5).
  void _paintVisitorOverflow(Canvas canvas, OfficeLayout layout) {
    final counts = <int, int>{};
    for (final m in scene.members) {
      final idx = m.askParentDeskIndex;
      if (idx != null) counts[idx] = (counts[idx] ?? 0) + 1;
    }
    for (final e in counts.entries) {
      if (e.value <= visitorMaxShown) continue;
      _bubble(canvas, layout, layout.visitorOverflowAnchor(e.key), '+${e.value - visitorMaxShown}', alert: true);
    }
  }

  void _bubble(Canvas canvas, OfficeLayout layout, Offset anchor, String text, {bool alert = false, bool error = false}) {
    final fs = layout.fontScale;
    final style = TextStyle(
      color: OfficeColors.bubbleText,
      fontSize: officeFontPx(11, fs),
      fontWeight: alert ? FontWeight.bold : FontWeight.normal,
    );
    // 최대 폭 180×scale, 2줄(패스 4).
    final tp = _layoutText(text, style, maxWidth: 180 * layout.scale, maxLines: 2);
    final padX = 6 * layout.scale, padY = 3 * layout.scale;
    final w = tp.width + padX * 2, h = tp.height + padY * 2;
    final tail = 6 * layout.scale;
    var left = anchor.dx - w / 2;
    left = left.clamp(2.0, math.max(2.0, layout.size.width - w - 2));
    final top = math.max(2.0, anchor.dy - tail - h);
    final rect = Rect.fromLTWH(left, top, w, h);
    final rr = RRect.fromRectAndRadius(rect, const Radius.circular(officeRadius));
    final tailPath = Path()
      ..moveTo(anchor.dx - tail, rect.bottom - 0.5)
      ..lineTo(anchor.dx, rect.bottom + tail)
      ..lineTo(anchor.dx + tail, rect.bottom - 0.5)
      ..close();
    final fill = Paint()..color = OfficeColors.bubbleFill;
    final border = Paint()
      ..color = error
          ? OfficeColors.charError
          : alert
              ? OfficeColors.bubbleAlertBorder
              : OfficeColors.bubbleBorder
      ..style = PaintingStyle.stroke
      ..strokeWidth = alert ? 2.5 : 1;
    canvas.drawRRect(rr, fill);
    canvas.drawPath(tailPath, fill);
    canvas.drawRRect(rr, border);
    canvas.drawPath(tailPath, border);
    canvas.drawLine(Offset(anchor.dx - tail + 1, rect.bottom), Offset(anchor.dx + tail - 1, rect.bottom), fill..strokeWidth = 2);
    tp.paint(canvas, Offset(rect.left + padX, rect.top + padY));
  }

  // ---- 점선 도형 --------------------------------------------------------------------

  void _dashedRRect(Canvas canvas, RRect rr, Color color, double stroke) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke;
    final path = Path()..addRRect(rr);
    _dashPath(canvas, path, paint, 6, 4);
  }

  void _dashedCircle(Canvas canvas, Offset center, double radius, Color color, double stroke) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke;
    final path = Path()..addOval(Rect.fromCircle(center: center, radius: radius));
    _dashPath(canvas, path, paint, math.max(3, radius * 0.7), math.max(2, radius * 0.5));
  }

  void _dashPath(Canvas canvas, Path path, Paint paint, double dash, double gap) {
    for (final metric in path.computeMetrics()) {
      var d = 0.0;
      while (d < metric.length) {
        canvas.drawPath(metric.extractPath(d, math.min(d + dash, metric.length)), paint);
        d += dash + gap;
      }
    }
  }

  // ---- 텍스트 -----------------------------------------------------------------------

  TextPainter _layoutText(String s, TextStyle style, {double? maxWidth, int maxLines = 1}) => TextPainter(
        text: TextSpan(
          text: s,
          style: style.copyWith(
            fontFamily: style.fontFamily ?? fontFamily,
            fontFamilyFallback: [...?style.fontFamilyFallback, ...?fontFamilyFallback],
          ),
        ),
        textDirection: textDirection,
        maxLines: maxLines,
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
        final placed = _placementsFor(layout);
        final dy = layout.clampScroll(scrollOffset);
        return [
          for (var i = 0; i < scene.members.length; i++)
            CustomPainterSemantics(
              // 자리를 비운 캐릭터(줄·보고·걷는 중)는 지금 위치의 원, 자리에 있으면 책상.
              rect: _isAway(layout, scene.members[i], placed[i])
                  ? Rect.fromCircle(center: placed[i].center, radius: layout.charRadius)
                  : layout.deskRect(scene.members[i].deskIndex).shift(Offset(0, -dy)),
              properties: SemanticsProperties(
                label: '${scene.members[i].deskTooltip} · ${scene.members[i].engineLabel}'
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
                  ? scene.myDeskHeader
                  : '${scene.myDeskHeader} · ${[for (var i = 0; i < scene.queue.length; i++) scene.queue[i].line(i)].join(' / ')}',
              textDirection: textDirection,
            ),
          ),
          CustomPainterSemantics(
            rect: layout.legendRect,
            properties: SemanticsProperties(
              label: '상태 범례 · ${LegendSlot.values.map((s) => s.label).join(' · ')}',
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
      shouldRebuildSemantics(oldDelegate) ||
      !_mapEq(oldDelegate.bob, bob) ||
      oldDelegate.hoveredMemberId != hoveredMemberId ||
      !_setEq(oldDelegate.resumedIds, resumedIds) ||
      // 스프라이트: 아틀라스가 도착한 프레임 · 걷기 프레임 · 타이핑 프레임 · 보고 방문(포즈)
      !identical(oldDelegate.sprites, sprites) ||
      oldDelegate.typeFrame != typeFrame ||
      !_mapEq(oldDelegate.walk, walk) ||
      !_setEq(oldDelegate.visitingIds, visitingIds);

  /// 흔들림(bob)·호버는 시맨틱에 영향 없음 — 장면·선택·위치·말풍선 덮어쓰기·스크롤만.
  @override
  bool shouldRebuildSemantics(OfficePainter oldDelegate) =>
      oldDelegate.scene != scene ||
      oldDelegate.selectedMemberId != selectedMemberId ||
      oldDelegate.scrollOffset != scrollOffset ||
      oldDelegate.showEmptyHint != showEmptyHint ||
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

  static bool _setEq<T>(Set<T> a, Set<T> b) => a.length == b.length && a.containsAll(b);
}
