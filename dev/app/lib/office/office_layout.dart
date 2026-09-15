// 사무실 레이아웃(순수 기하). 위젯 없이 Offset/Rect/Size 만 쓴다 — 단위 테스트 대상.
//
// 배치(docs/design/office-sketch.html):
//   ┌ 문(왼쪽 가장자리, 세로 중앙)   책상 격자(위, 한 줄 4개, 필요한 만큼 줄 추가)
//   │                                  캐릭터 = 책상 아래쪽 가장자리에 걸친 원, 말풍선 = 책상 위
//   │            내 책상(아래 가운데)  줄 서는 자리 = 내 책상 위쪽에 왼쪽부터 오른쪽으로
// 너비 900 미만이면 [scale] 로 축소, 줄이 많아 내 책상과 겹치면 세로도 맞춰 축소.

import 'dart:math' as math;
import 'dart:ui';

import 'office_scene.dart';

/// 캐릭터 한 명의 최종 위치.
class CharacterPlacement {
  const CharacterPlacement({required this.memberId, required this.center, required this.bubbleAnchor});

  final String memberId;

  /// 원 중심.
  final Offset center;

  /// 말풍선 아랫변 가운데(꼬리 끝)가 놓일 점.
  final Offset bubbleAnchor;

  @override
  bool operator ==(Object other) =>
      other is CharacterPlacement && other.memberId == memberId && other.center == center && other.bubbleAnchor == bubbleAnchor;

  @override
  int get hashCode => Object.hash(memberId, center, bubbleAnchor);

  @override
  String toString() => 'Placement($memberId $center)';
}

class OfficeLayout {
  OfficeLayout({required this.size, required this.deskCount}) {
    _computeScale();
  }

  static const int desksPerRow = 4;

  /// 이 너비 이상이면 원래 크기(1.0).
  static const double fullWidth = 900;

  // 기준(scale 1.0) 치수 — 와이어프레임 값.
  static const double baseDeskWidth = 160;
  static const double baseDeskHeight = 100;
  static const double baseCharRadius = 14;
  static const double baseMyDeskWidth = 260;
  static const double baseMyDeskHeight = 110;
  static const double baseTopPadding = 44; // 첫 줄 말풍선 자리
  static const double baseRowGap = 64; // 캐릭터 + 다음 줄 말풍선 자리
  static const double baseSideMargin = 40;
  static const double baseBottomMargin = 16;
  static const double baseDoorHeight = 60;
  static const double doorWidth = 8;

  final Size size;
  final int deskCount;

  late final double scale;

  int get rowCount => (deskCount + desksPerRow - 1) ~/ desksPerRow;

  double get deskWidth => baseDeskWidth * scale;
  double get deskHeight => baseDeskHeight * scale;
  double get charRadius => math.max(9, baseCharRadius * scale);
  double get topPadding => baseTopPadding * scale;
  double get rowPitch => deskHeight + baseRowGap * scale;
  double get sideMargin => baseSideMargin * scale;
  double get columnPitch => (size.width - 2 * sideMargin) / desksPerRow;

  /// 글꼴 크기용 배율(너무 작아지지 않게 하한).
  double get fontScale => scale.clamp(0.75, 1.0);

  void _computeScale() {
    var s = size.width >= fullWidth ? 1.0 : (size.width / fullWidth).clamp(0.45, 1.0);
    // 세로 여유: 격자 바닥 + 줄 서는 자리 + 내 책상이 높이 안에 들어가야 한다.
    final needed = _gridBottomAt(s) + _queueBandAt(s) + baseMyDeskHeight * s + baseBottomMargin;
    if (needed > size.height && needed > 0) {
      s = (s * size.height / needed).clamp(0.45, s);
    }
    scale = s;
  }

  double _gridBottomAt(double s) {
    if (deskCount == 0) return baseTopPadding * s;
    return baseTopPadding * s + rowCount * (baseDeskHeight + baseRowGap) * s;
  }

  double _queueBandAt(double s) => (baseCharRadius * 2 + 40) * s;

  // ---- 책상 -------------------------------------------------------------------

  Rect deskRect(int index) {
    final row = index ~/ desksPerRow;
    final col = index % desksPerRow;
    final left = sideMargin + col * columnPitch + (columnPitch - deskWidth) / 2;
    final top = topPadding + row * rowPitch;
    return Rect.fromLTWH(left, top, deskWidth, deskHeight);
  }

  List<Rect> get deskRects => [for (var i = 0; i < deskCount; i++) deskRect(i)];

  /// 책상 안 모니터.
  Rect monitorRect(int index) {
    final d = deskRect(index);
    return Rect.fromLTWH(d.left + 0.12 * d.width, d.top + 0.30 * d.height, 0.76 * d.width, 0.42 * d.height);
  }

  /// 캐릭터가 자리에 앉을 때의 원 중심 — 책상 아래 가장자리에 걸친다.
  Offset seatCenter(int index) {
    final d = deskRect(index);
    return Offset(d.center.dx, d.bottom + charRadius * 0.3);
  }

  /// 자리에 앉은 캐릭터의 말풍선 꼬리 끝 — 책상 위.
  Offset seatBubbleAnchor(int index) {
    final d = deskRect(index);
    return Offset(d.center.dx, d.top - 4 * scale);
  }

  // ---- 내 책상 · 줄 -----------------------------------------------------------------

  Rect get myDeskRect {
    final w = math.min(baseMyDeskWidth * scale, size.width - 2 * sideMargin);
    final h = baseMyDeskHeight * scale;
    return Rect.fromLTWH((size.width - w) / 2, size.height - baseBottomMargin - h, w, h);
  }

  /// 내 책상 줄의 k 번째 자리(왼쪽부터).
  Offset queueSlot(int k) {
    final my = myDeskRect;
    final r = charRadius;
    final pitch = r * 2 + 20 * scale;
    return Offset(my.left + r + k * pitch, my.top - r - 12 * scale);
  }

  /// 줄 서는 캐릭터의 말풍선 꼬리 끝. 줄 간격이 말풍선보다 좁으므로 홀수 번째는 한 단 위로 올려 겹치지 않게 한다.
  Offset queueBubbleAnchor(int k) {
    final c = queueSlot(k);
    return Offset(c.dx, c.dy - charRadius - 4 * scale - (k.isOdd ? queueBubbleTier : 0));
  }

  /// 홀수 번째 줄 말풍선을 올리는 높이(말풍선 높이 + 꼬리 + 여유).
  double get queueBubbleTier => 30 * scale;

  // ---- 문 -------------------------------------------------------------------------

  Rect get doorRect {
    final h = baseDoorHeight * scale;
    return Rect.fromLTWH(0, size.height / 2 - h / 2, doorWidth, h);
  }

  Offset get doorLabelPos => Offset(doorWidth + 6, size.height / 2);

  /// 캐릭터가 입장·퇴장할 때 서는 점(문 바로 안쪽, T16 이동 애니메이션의 출발·도착점).
  Offset get doorSpawn => Offset(doorRect.right + charRadius + 2, doorRect.center.dy);

  /// 빈 상태 안내 문구 위치(격자 영역 가운데).
  Offset get emptyHintCenter => Offset(size.width / 2, (topPadding + myDeskRect.top) / 2);

  // ---- 배치 · 히트 테스트 ------------------------------------------------------------

  List<CharacterPlacement> placements(OfficeScene scene) => [
        for (final m in scene.members)
          m.isQueued
              ? CharacterPlacement(memberId: m.id, center: queueSlot(m.queueIndex!), bubbleAnchor: queueBubbleAnchor(m.queueIndex!))
              : CharacterPlacement(memberId: m.id, center: seatCenter(m.deskIndex), bubbleAnchor: seatBubbleAnchor(m.deskIndex)),
      ];

  /// 점이 캐릭터(우선) 또는 책상 위에 있으면 그 멤버 id, 아니면 null.
  String? hitTest(Offset p, OfficeScene scene, [List<CharacterPlacement>? placed]) {
    final ps = placed ?? placements(scene);
    final r = charRadius + 4;
    for (var i = ps.length - 1; i >= 0; i--) {
      if ((ps[i].center - p).distance <= r) return ps[i].memberId;
    }
    for (final m in scene.members) {
      if (deskRect(m.deskIndex).contains(p)) return m.id;
    }
    return null;
  }
}
