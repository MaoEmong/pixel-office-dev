// 사무실 레이아웃(순수 기하). 위젯 없이 Offset/Rect/Size 만 쓴다 — 단위 테스트 대상.
//
// 배치(T37, 01 §직무 체계 rev 3 "사무실 배치"):
//   ┌ 문(왼쪽 가장자리, 세로 중앙)   ┌────────── 부장 책상(맨 윗줄 가운데) ──────────┐
//   │                                 ┌ 팀 클러스터: 제목 줄 + 팀장·팀원 책상(한 줄 4개)
//   │                                 ┌ 팀 클러스터 …
//   │            내 책상(아래 가운데)  줄 서는 자리 = 내 책상 위쪽에 왼쪽부터 오른쪽으로
//   캐릭터 = 책상 아래쪽 가장자리에 걸친 원, 말풍선 = 책상 위.
// 너비 900 미만이면 [scale] 로 축소, 클러스터가 많아 내 책상과 겹치면 세로도 맞춰 축소.
//
// 책상 번호(deskIndex)는 [OfficeDeskPlan] 순서 그대로다 — 부장 0, 그다음 클러스터 순.
// 계획 없이 `deskCount` 만 주면 T12 때와 같은 평면 격자(제목 없는 클러스터 하나)다.

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

/// 클러스터 하나가 차지하는 상자(제목 줄 포함) — 페인터가 테두리·제목을 그린다.
class ClusterBox {
  const ClusterBox({required this.rect, required this.title, required this.titleBaseline});

  final Rect rect;
  final String? title;

  /// 제목 텍스트의 왼쪽 위 점.
  final Offset titleBaseline;
}

class OfficeLayout {
  OfficeLayout({required this.size, OfficeDeskPlan? plan, int? deskCount})
      : plan = plan ?? OfficeDeskPlan.flat(deskCount ?? 0) {
    _computeScale();
    _build();
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

  /// 클러스터 제목 줄 높이(T37). 제목 글자(약 14px) + **첫 줄 책상의 말풍선 자리**를 함께 낸다 —
  /// 좁게 잡으면 말풍선이 제목 위로 올라앉는다(실기에서 확인).
  static const double baseClusterTitleHeight = 42;

  /// 클러스터 상자 사이 간격.
  static const double baseClusterGap = 10;

  /// 클러스터 상자가 책상 격자보다 바깥으로 나가는 여백.
  static const double baseClusterInset = 16;

  final Size size;

  /// 책상 배치 계획(부장 자리 + 팀 클러스터). `deskCount` 만 준 경우 평면 격자.
  final OfficeDeskPlan plan;

  late final double scale;
  late final List<Rect> _desks;
  late final List<ClusterBox> clusters;

  int get deskCount => plan.deskCount;

  /// 평면 배치일 때의 줄 수(T12 호환 — 클러스터 배치에서는 첫 클러스터 기준).
  int get rowCount => (plan.clusters.isEmpty ? 0 : (plan.clusters.first.deskCount + desksPerRow - 1) ~/ desksPerRow);

  double get deskWidth => baseDeskWidth * scale;
  double get deskHeight => baseDeskHeight * scale;
  double get charRadius => math.max(9, baseCharRadius * scale);
  double get topPadding => baseTopPadding * scale;
  double get rowPitch => deskHeight + baseRowGap * scale;
  double get sideMargin => baseSideMargin * scale;
  double get columnPitch => (size.width - 2 * sideMargin) / desksPerRow;
  double get clusterTitleHeight => baseClusterTitleHeight * scale;

  /// 글꼴 크기용 배율(너무 작아지지 않게 하한).
  double get fontScale => scale.clamp(0.75, 1.0);

  void _computeScale() {
    var s = size.width >= fullWidth ? 1.0 : (size.width / fullWidth).clamp(0.45, 1.0);
    // 세로 여유: 마지막 클러스터 바닥 + 줄 서는 자리 + 내 책상이 높이 안에 들어가야 한다.
    final needed = _bottomAt(s) + _queueBandAt(s) + baseMyDeskHeight * s + baseBottomMargin;
    if (needed > size.height && needed > 0) {
      s = (s * size.height / needed).clamp(0.45, s);
    }
    scale = s;
  }

  /// 책상 영역의 바닥 y(주어진 배율에서).
  double _bottomAt(double s) => _layoutAt(s).$3;

  double _queueBandAt(double s) => (baseCharRadius * 2 + 40) * s;

  /// 배율 [s] 에서 (책상 사각형, 클러스터 상자, 바닥 y) 를 계산한다.
  (List<Rect>, List<ClusterBox>, double) _layoutAt(double s) {
    final deskW = baseDeskWidth * s;
    final deskH = baseDeskHeight * s;
    final side = baseSideMargin * s;
    final pitchY = deskH + baseRowGap * s;
    final colPitch = (size.width - 2 * side) / desksPerRow;
    final titleH = baseClusterTitleHeight * s;
    final inset = baseClusterInset * s;

    final desks = <Rect>[];
    final boxes = <ClusterBox>[];
    var y = baseTopPadding * s;

    if (plan.hasHead) {
      desks.add(Rect.fromLTWH((size.width - deskW) / 2, y, deskW, deskH));
      y += pitchY;
    }
    for (final c in plan.clusters) {
      final hasTitle = c.title != null;
      final boxTop = y;
      final contentTop = y + (hasTitle ? titleH : 0);
      for (var i = 0; i < c.deskCount; i++) {
        final row = i ~/ desksPerRow;
        final col = i % desksPerRow;
        desks.add(Rect.fromLTWH(
          side + col * colPitch + (colPitch - deskW) / 2,
          contentTop + row * pitchY,
          deskW,
          deskH,
        ));
      }
      final rows = c.deskCount == 0 ? 1 : (c.deskCount + desksPerRow - 1) ~/ desksPerRow;
      final boxBottom = contentTop + rows * pitchY;
      if (hasTitle) {
        // 왼쪽은 문 라벨("문")을 가리지 않는 선까지만 물러난다.
        final boxLeft = math.max(doorWidth + 26 * s, side - inset);
        boxes.add(ClusterBox(
          rect: Rect.fromLTRB(boxLeft, boxTop, math.min(size.width - 2, size.width - side + inset), boxBottom),
          title: c.title,
          titleBaseline: Offset(boxLeft + 6 * s, boxTop + 3 * s),
        ));
        y = boxBottom + baseClusterGap * s;
      } else {
        y = boxBottom;
      }
    }
    return (desks, boxes, y);
  }

  void _build() {
    final (desks, boxes, _) = _layoutAt(scale);
    _desks = List<Rect>.unmodifiable(desks);
    clusters = List<ClusterBox>.unmodifiable(boxes);
  }

  // ---- 책상 -------------------------------------------------------------------

  Rect deskRect(int index) {
    if (index < 0 || index >= _desks.length) {
      // 장면과 계획이 한 프레임 어긋날 때(멤버가 막 늘었을 때) 화면 밖에 두는 대신 마지막 자리로.
      return _desks.isEmpty ? Rect.fromLTWH(sideMargin, topPadding, deskWidth, deskHeight) : _desks.last;
    }
    return _desks[index];
  }

  List<Rect> get deskRects => _desks;

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

  // ---- 상사 책상 앞(ask_parent 방문) ---------------------------------------------

  /// 상사에게 질문하러 간 캐릭터가 서는 자리 — 그 책상의 오른쪽 옆(화면 밖으로는 안 나간다).
  Offset visitorSpot(int deskIndex) {
    final d = deskRect(deskIndex);
    final x = math.min(d.right + charRadius * 1.6, size.width - charRadius - 2);
    return Offset(x, d.bottom + charRadius * 0.3);
  }

  Offset visitorBubbleAnchor(int deskIndex) {
    final c = visitorSpot(deskIndex);
    return Offset(c.dx, c.dy - charRadius - 4 * scale);
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
          if (m.isQueued)
            CharacterPlacement(memberId: m.id, center: queueSlot(m.queueIndex!), bubbleAnchor: queueBubbleAnchor(m.queueIndex!))
          else if (m.isAskingParent)
            CharacterPlacement(
              memberId: m.id,
              center: visitorSpot(m.askParentDeskIndex!),
              bubbleAnchor: visitorBubbleAnchor(m.askParentDeskIndex!),
            )
          else
            CharacterPlacement(memberId: m.id, center: seatCenter(m.deskIndex), bubbleAnchor: seatBubbleAnchor(m.deskIndex)),
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
