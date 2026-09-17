// 사무실 레이아웃(순수 기하). 위젯 없이 Offset/Rect/Size 만 쓴다 — 단위 테스트 대상.
//
// 레이아웃 v2(T40-1, docs/design/레이아웃-v2.md 패스 6 · D-42 4):
//   사무실은 **세로 스크롤 영역**(부장 카펫 + 팀 클러스터)과 **바닥 고정 바**(내 책상 120 + 범례 24, scale 1 기준)로
//   나뉜다. 문은 스크롤 영역 왼쪽에 고정(스크롤해도 안 움직인다).
//
//   ┌ 스크롤 영역(콘텐츠 좌표: y 는 콘텐츠 맨 위가 0) ──────────────────────────┐
//   │  문   ┌ 부장 책상(맨 윗줄 가운데, 금색 카펫은 페인터) ┐                      │
//   │       ┌ 팀 카펫 A: 제목 태그 + 책상 ┐  ┌ 팀 카펫 B ┐   ← 둘 다 들어가면 나란히  │
//   │       ┌ 팀 카펫 C … (넘치면 스크롤)                                        │
//   ├ 바닥 고정 바(뷰포트 좌표) ────────────────────────────────────────────┤
//   │  [내 책상 · 대기 N] 슬롯 ○ ○ ◌ ◌                                        │
//   │  범례: ●작업 ●한가 ◌보고대기 ●내 차례 ●대기 ●오류 ●퇴근                    │
//   └──────────────────────────────────────────────────────────────────┘
//
// **좌표계가 둘이다**:
//   - 콘텐츠 좌표: 책상(`deskRect`)·클러스터 상자(`clusters`)·자리(`seatCenter`)·방문 자리(`visitorSpot`).
//     화면에 그릴 때 `-scrollOffset` 만큼 옮긴다.
//   - 뷰포트 좌표: 문(`doorRect`)·바(`barRect`)·내 책상(`myDeskRect`)·슬롯(`slotCenter`)·범례(`legendRect`).
//   `scrollOffset` 이 0 이면 둘이 같다(대부분의 테스트·작은 부서).
//
// 배율: 폭만 본다(세로는 스크롤이 받는다). 하한 0.6 · 상한 1.5 — 폭 900 에서 1.0, 1440 이상부터 커져 2080 에서 1.5.
// 열 수: 폭 1600 이상이면 5열, 아니면 4열.
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

/// 클러스터 하나가 차지하는 상자(제목 줄 포함) — 페인터가 카펫·제목 태그를 그린다.
class ClusterBox {
  const ClusterBox({
    required this.rect,
    required this.title,
    required this.titleBaseline,
    this.colorIndex = 0,
    this.cluster,
  });

  final Rect rect;
  final String? title;

  /// 제목 텍스트의 왼쪽 위 점.
  final Offset titleBaseline;

  /// 카펫 색 토큰 번호(= 팀 생성 순서, 6색 순환 — 패스 4 구체성).
  final int colorIndex;

  /// 이 상자가 그리는 클러스터(전원 퇴근·퇴근 접기·점선 자리 판정용).
  final DeskCluster? cluster;

  bool get allExited => cluster?.allExited ?? false;
  bool get isPlaceholder => cluster?.isPlaceholder ?? false;
  int get exitedFolded => cluster?.exitedFolded ?? 0;
}

class OfficeLayout {
  OfficeLayout({required this.size, OfficeDeskPlan? plan, int? deskCount})
      : plan = plan ?? OfficeDeskPlan.flat(deskCount ?? 0) {
    scale = _scaleFor(size.width);
    _build();
  }

  /// 기본 열 수(패스 6 창 크기 표).
  static const int baseDesksPerRow = 4;

  /// 폭 [wideWidth] 이상에서의 열 수.
  static const int wideDesksPerRow = 5;
  static const double wideWidth = 1600;

  /// 이 너비면 배율 1.0.
  static const double fullWidth = 900;

  /// 배율 하한·상한(D-42 4).
  static const double minScale = 0.6;
  static const double maxScale = 1.5;

  /// 이 폭부터 1.0 을 넘어 커지기 시작해(1920 창) [upscaleTo] 에서 상한에 닿는다(2560 창).
  static const double upscaleFrom = 1440;
  static const double upscaleTo = 2080;

  // 기준(scale 1.0) 치수 — 와이어프레임 값.
  static const double baseDeskWidth = 160;
  static const double baseDeskHeight = 100;
  static const double baseCharRadius = 14;
  static const double baseMyDeskWidth = 260;
  static const double baseMyDeskHeight = 110;
  static const double baseTopPadding = 44; // 첫 줄 말풍선 자리
  static const double baseRowGap = 64; // 캐릭터 + 다음 줄 말풍선 자리
  static const double baseColumnGap = 24; // 책상 사이 가로 간격
  static const double baseSideMargin = 40;
  static const double baseBottomMargin = 16;
  static const double baseDoorHeight = 60;
  static const double doorWidth = 8;

  /// 부장 책상과 첫 클러스터 사이(금색 카펫 + 왕관 자리).
  static const double baseHeadGap = 24;

  /// 바닥 고정 바: 내 책상 칸 120 + 범례 줄 24(패스 6).
  static const double baseMyDeskBandHeight = 120;
  static const double baseLegendHeight = 24;

  /// 내 책상 대기 슬롯 수(D-42 3 · 패스 2 이슈 5).
  static const int myDeskSlots = mySlotCount;

  /// 스프라이트 셀(T33, D-43 2) — 지금은 원을 그리지만 앵커는 여기서 준다.
  static const double spriteCellPx = 32;

  /// 클러스터 제목 줄 높이(T37). 제목 글자 + **첫 줄 책상의 말풍선 자리**를 함께 낸다 —
  /// 좁게 잡으면 말풍선이 제목 위로 올라앉는다(실기에서 확인).
  static const double baseClusterTitleHeight = 42;

  /// 클러스터 상자 사이 간격.
  static const double baseClusterGap = 10;

  /// 클러스터 상자가 책상 격자보다 바깥으로 나가는 여백.
  static const double baseClusterInset = 16;

  /// 전원 퇴근 팀의 낮은 상자에서 제목 줄 아래 여백.
  static const double baseLowBoxPad = 12;

  final Size size;

  /// 책상 배치 계획(부장 자리 + 팀 클러스터). `deskCount` 만 준 경우 평면 격자.
  final OfficeDeskPlan plan;

  late final double scale;
  late final List<Rect> _desks;
  late final List<ClusterBox> clusters;

  /// 콘텐츠(스크롤 영역) 안쪽 높이 — 뷰포트보다 크면 스크롤한다.
  late final double contentHeight;

  int get deskCount => plan.deskCount;

  /// 이 폭에서의 열 수(폭 ≥ 1600 이면 5열).
  int get desksPerRow => size.width >= wideWidth ? wideDesksPerRow : baseDesksPerRow;

  /// 평면 배치일 때의 줄 수(T12 호환 — 클러스터 배치에서는 첫 클러스터 기준).
  int get rowCount => (plan.clusters.isEmpty ? 0 : (plan.clusters.first.deskCount + desksPerRow - 1) ~/ desksPerRow);

  double get deskWidth => baseDeskWidth * scale;
  double get deskHeight => baseDeskHeight * scale;
  double get charRadius => math.max(9, baseCharRadius * scale);
  double get topPadding => baseTopPadding * scale;
  double get rowPitch => deskHeight + baseRowGap * scale;
  double get sideMargin => baseSideMargin * scale;
  double get columnPitch => deskWidth + baseColumnGap * scale;
  double get clusterTitleHeight => baseClusterTitleHeight * scale;
  double get clusterInset => baseClusterInset * scale;

  /// 글꼴 크기용 배율(너무 작아지지 않게 하한, 확대는 그대로 따라간다).
  double get fontScale => scale.clamp(0.75, maxScale);

  /// 픽셀아트 배율 — 레이아웃 scale 과 분리된 **정수 배율**(D-43 3).
  int get spriteScale => scale >= 0.75 ? 2 : 1;

  /// 캐릭터 한 명의 32×32 스프라이트 셀(T33 이 여기에 `drawImageRect` 한다). 지금은 원 중심과 같은 자리.
  Rect spriteCell(Offset center) =>
      Rect.fromCenter(center: center, width: spriteCellPx * spriteScale, height: spriteCellPx * spriteScale);

  /// 책상 [index] 에 앉은 캐릭터의 스프라이트 셀.
  Rect spriteCellOf(int index) => spriteCell(seatCenter(index));

  // ---- 스크롤 영역 · 바닥 바 -------------------------------------------------------

  double get myDeskBandHeight => baseMyDeskBandHeight * scale;
  double get legendHeight => baseLegendHeight * scale;

  /// 바닥 고정 바 높이(내 책상 + 범례).
  double get barHeight => myDeskBandHeight + legendHeight;

  /// 스크롤 영역(= 사무실 바닥)의 높이.
  double get viewportHeight => math.max(0, size.height - barHeight);

  Rect get viewportRect => Rect.fromLTWH(0, 0, size.width, viewportHeight);
  Rect get barRect => Rect.fromLTWH(0, viewportHeight, size.width, math.min(barHeight, size.height));

  /// 스크롤 가능한 최대 거리(0 이면 스크롤 없음).
  double get maxScroll => math.max(0, contentHeight - viewportHeight);
  bool get isScrollable => maxScroll > 0;

  double clampScroll(double v) => v.isNaN ? 0 : v.clamp(0.0, maxScroll);

  /// 뷰포트 좌표 → 콘텐츠 좌표.
  Offset toContent(Offset viewportPoint, double scrollOffset) => viewportPoint + Offset(0, clampScroll(scrollOffset));

  static double _scaleFor(double w) {
    if (w >= upscaleFrom) {
      return (1 + (w - upscaleFrom) / (upscaleTo - upscaleFrom) * (maxScale - 1)).clamp(1.0, maxScale);
    }
    if (w >= fullWidth) return 1.0;
    return (w / fullWidth).clamp(minScale, 1.0);
  }

  // ---- 배치 계산 -------------------------------------------------------------------

  double _clusterWidth(DeskCluster c, double s) {
    final pitchX = baseDeskWidth * s + baseColumnGap * s;
    final inset = baseClusterInset * s;
    if (c.title == null) return desksPerRow * pitchX - baseColumnGap * s; // 평면 격자(T12 호환)
    final cols = c.isPlaceholder ? math.min(2, desksPerRow) : math.min(math.max(c.deskCount, 1), desksPerRow);
    return cols * pitchX - baseColumnGap * s + 2 * inset;
  }

  double _clusterHeight(DeskCluster c, double s) {
    final titleH = baseClusterTitleHeight * s;
    final pitchY = baseDeskHeight * s + baseRowGap * s;
    if (c.title == null) {
      final rows = c.deskCount == 0 ? 1 : (c.deskCount + desksPerRow - 1) ~/ desksPerRow;
      return rows * pitchY;
    }
    // 전원 퇴근 팀 = 제목 줄만 남긴 낮은 상자(패스 2 이슈 7).
    if (c.allExited || (c.deskCount == 0 && !c.isPlaceholder)) return titleH + baseLowBoxPad * s;
    final rows = c.deskCount == 0 ? 1 : (c.deskCount + desksPerRow - 1) ~/ desksPerRow;
    return titleH + rows * pitchY;
  }

  void _build() {
    final s = scale;
    final deskW = baseDeskWidth * s;
    final deskH = baseDeskHeight * s;
    final side = baseSideMargin * s;
    final pitchX = columnPitch;
    final pitchY = deskH + baseRowGap * s;
    final titleH = baseClusterTitleHeight * s;
    final inset = baseClusterInset * s;
    final gap = baseClusterGap * s;
    final cols = desksPerRow;

    final desks = <Rect>[];
    final boxes = <ClusterBox>[];
    var y = baseTopPadding * s;

    if (plan.hasHead) {
      desks.add(Rect.fromLTWH((size.width - deskW) / 2, y, deskW, deskH));
      y += pitchY + baseHeadGap * s;
    }

    // 왼쪽 정렬. 문 라벨("문")을 가리지 않는 선까지만 물러난다.
    final left0 = math.max(doorWidth + 26 * s, side);
    final widths = [for (final c in plan.clusters) _clusterWidth(c, s)];
    final heights = [for (final c in plan.clusters) _clusterHeight(c, s)];

    var i = 0;
    while (i < plan.clusters.length) {
      // 같은 줄에 두 클러스터가 들어가면 나란히(패스 6 규모).
      final pair = i + 1 < plan.clusters.length &&
          plan.clusters[i].title != null &&
          plan.clusters[i + 1].title != null &&
          left0 + widths[i] + gap + widths[i + 1] <= size.width - side;
      final count = pair ? 2 : 1;
      var x = left0;
      var rowH = 0.0;
      for (var k = i; k < i + count; k++) {
        final c = plan.clusters[k];
        final hasTitle = c.title != null;
        final boxLeft = hasTitle ? x : left0;
        final contentLeft = boxLeft + (hasTitle ? inset : 0);
        final contentTop = y + (hasTitle ? titleH : 0);
        for (var d = 0; d < c.deskCount; d++) {
          final row = d ~/ cols, col = d % cols;
          desks.add(Rect.fromLTWH(contentLeft + col * pitchX, contentTop + row * pitchY, deskW, deskH));
        }
        if (hasTitle) {
          boxes.add(ClusterBox(
            rect: Rect.fromLTWH(boxLeft, y, widths[k], heights[k]),
            title: c.title,
            titleBaseline: Offset(boxLeft + 6 * s, y + 3 * s),
            colorIndex: k,
            cluster: c,
          ));
        }
        x += widths[k] + gap;
        rowH = math.max(rowH, heights[k]);
      }
      y += rowH + gap;
      i += count;
    }

    _desks = List<Rect>.unmodifiable(desks);
    clusters = List<ClusterBox>.unmodifiable(boxes);
    contentHeight = math.max(viewportHeight, y + baseBottomMargin * s);
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

  /// 부장 책상 아래 금색 카펫(책상 Rect 사방 +20px — 패스 1 부장 앵커).
  Rect headCarpetRect(int index) => deskRect(index).inflate(20 * scale);

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

  /// 상사에게 질문하러 간 [k] 번째 캐릭터가 서는 자리 — 그 책상의 오른쪽 옆으로 `2r + 8px` 씩(패스 2 이슈 5).
  /// 다음 자리가 `size.width - r - 2` 를 넘으면 **왼쪽 옆으로 접는다**.
  Offset visitorSpot(int deskIndex, [int k = 0]) {
    final d = deskRect(deskIndex);
    final r = charRadius;
    final step = 2 * r + 8 * scale;
    final maxX = size.width - r - 2;
    final right = d.right + r * 1.6 + k * step;
    if (right <= maxX) return Offset(right, d.bottom + r * 0.3);
    final left = math.max(r + 2, d.left - r * 1.6 - k * step);
    return Offset(left, d.bottom + r * 0.3);
  }

  Offset visitorBubbleAnchor(int deskIndex, [int k = 0]) {
    final c = visitorSpot(deskIndex, k);
    return Offset(c.dx, c.dy - charRadius - 4 * scale);
  }

  /// 3명째부터의 "+N" 말풍선 자리(두 번째 방문 자리 위).
  Offset visitorOverflowAnchor(int deskIndex) => visitorBubbleAnchor(deskIndex, visitorMaxShown - 1);

  // ---- 바닥 바: 내 책상 · 슬롯 · 범례 ---------------------------------------------

  /// 내 책상(바닥 고정 바 안, 왼쪽 정렬 — 패스 1 그림).
  Rect get myDeskRect {
    final w = math.min(baseMyDeskWidth * scale, math.max(80.0, size.width - 2 * sideMargin));
    final h = math.min(baseMyDeskHeight * scale, myDeskBandHeight - 10 * scale);
    return Rect.fromLTWH(sideMargin, barRect.top + (myDeskBandHeight - h) / 2, w, h);
  }

  /// 범례 한 줄(내 책상 칸 아래, 높이 24 × scale).
  Rect get legendRect =>
      Rect.fromLTWH(sideMargin, barRect.top + myDeskBandHeight, size.width - 2 * sideMargin, legendHeight);

  double get slotRadius => charRadius;

  /// 슬롯 사이 간격(원 지름 + 8px).
  double get slotPitch => 2 * slotRadius + 8 * scale;

  /// 내 책상 대기 슬롯 [k] 의 가운데(오래된 것부터 왼쪽, 0..3).
  Offset slotCenter(int k) {
    final my = myDeskRect;
    final pad = 10 * scale;
    final top = my.top + my.height * 0.55;
    return Offset(my.left + pad + slotRadius + k * slotPitch, top);
  }

  /// 슬롯 클릭 목표(최소 24px — 패스 6 클릭 목표).
  Rect slotHitRect(int k) {
    final side = math.max(24.0, slotPitch);
    return Rect.fromCenter(center: slotCenter(k), width: side, height: side);
  }

  /// 5명째부터의 "+N" 배지 — 맨 오른쪽 슬롯 **위**.
  Rect get overflowBadgeRect {
    final c = slotCenter(myDeskSlots - 1);
    final w = math.max(24.0, 26 * scale), h = math.max(14.0, 14 * scale);
    return Rect.fromCenter(center: Offset(c.dx, c.dy - slotRadius - h * 0.7), width: w, height: h);
  }

  /// 내 책상 줄(= 슬롯)의 k 번째 자리. 슬롯을 넘는 순번은 맨 오른쪽 슬롯으로 본다(그 사람은 자기 책상에 남는다).
  Offset queueSlot(int k) => slotCenter(k.clamp(0, myDeskSlots - 1));

  /// 보고하러 온 캐릭터가 내 책상 앞에 서는 자리 — 슬롯을 차지하지 않게 내 책상 **오른쪽**에 선다(T16 방문).
  Offset reportSpot(int k) => Offset(
        math.min(myDeskRect.right + charRadius + 8 * scale + k * slotPitch, size.width - charRadius - 2),
        myDeskRect.center.dy,
      );

  /// 바(내 책상 칸)에 선 캐릭터의 말풍선 꼬리 끝 높이 — **내 책상 상자 위**로 올린다.
  ///
  /// T40 편차 ⑥: 슬롯 대기자의 말풍선이 "내 책상 · 대기 N" 헤더 글자를 덮었다. 원 기준으로도 겹쳤고
  /// 스프라이트(32×32 셀)는 원보다 커서 더 심하다. 바 안에서 위로 미는 대신 **상자 밖 위**로 빼면
  /// 바 높이(120)를 재배분하지 않고도 헤더·슬롯·말풍선이 서로 안 가린다.
  double get barBubbleY => myDeskRect.top - 2 * scale;

  Offset reportBubbleAnchor(int k) => Offset(reportSpot(k).dx, barBubbleY);

  /// 줄 선 캐릭터의 말풍선 꼬리 끝.
  Offset queueBubbleAnchor(int k) => Offset(queueSlot(k).dx, barBubbleY);

  /// (레거시) 홀수 번째 말풍선을 올리던 높이 — 슬롯 4칸 고정이라 더는 쓰지 않는다.
  double get queueBubbleTier => 30 * scale;

  // ---- 문 -------------------------------------------------------------------------

  /// 문은 **스크롤 영역 왼쪽에 고정**(뷰포트 좌표).
  Rect get doorRect {
    final h = baseDoorHeight * scale;
    return Rect.fromLTWH(0, viewportHeight / 2 - h / 2, doorWidth, h);
  }

  Offset get doorLabelPos => Offset(doorWidth + 6, viewportHeight / 2);

  /// 캐릭터가 입장·퇴장할 때 서는 점(문 바로 안쪽, T16 이동 애니메이션의 출발·도착점).
  Offset get doorSpawn => Offset(doorRect.right + charRadius + 2, doorRect.center.dy);

  /// 빈 상태 안내 문구 위치(스크롤 영역 가운데).
  Offset get emptyHintCenter => Offset(size.width / 2, viewportHeight / 2);

  // ---- 배치 · 히트 테스트 ------------------------------------------------------------

  /// 이 멤버가 **바닥 고정 바**(뷰포트 좌표)에 그려지는가 — 내 책상 슬롯에 선 대기자.
  bool drawsInBar(SceneMember m) => m.isQueued && m.queueIndex! < myDeskSlots;

  List<CharacterPlacement> placements(OfficeScene scene) => [
        for (final m in scene.members)
          if (drawsInBar(m))
            CharacterPlacement(memberId: m.id, center: queueSlot(m.queueIndex!), bubbleAnchor: queueBubbleAnchor(m.queueIndex!))
          else if (m.isAskingParent && m.showsAsVisitor)
            CharacterPlacement(
              memberId: m.id,
              center: visitorSpot(m.askParentDeskIndex!, m.askParentVisitorIndex ?? 0),
              bubbleAnchor: visitorBubbleAnchor(m.askParentDeskIndex!, m.askParentVisitorIndex ?? 0),
            )
          else
            CharacterPlacement(memberId: m.id, center: seatCenter(m.deskIndex), bubbleAnchor: seatBubbleAnchor(m.deskIndex)),
      ];

  /// 바닥 바에서 눌린 슬롯 번호(뷰포트 좌표). 슬롯 밖이면 null. "+N" 배지는 맨 오른쪽 슬롯으로 친다.
  int? slotAt(Offset viewportPoint) {
    if (overflowBadgeRect.contains(viewportPoint)) return myDeskSlots - 1;
    for (var k = 0; k < myDeskSlots; k++) {
      if (slotHitRect(k).contains(viewportPoint)) return k;
    }
    return null;
  }

  /// 점이 캐릭터(우선) 또는 책상 위에 있으면 그 멤버 id, 아니면 null.
  ///
  /// [p] 는 **뷰포트 좌표**다 — 바(내 책상 슬롯)는 그대로, 스크롤 영역은 [scrollOffset] 만큼 내려 콘텐츠 좌표로 본다.
  String? hitTest(Offset p, OfficeScene scene, [List<CharacterPlacement>? placed, double scrollOffset = 0]) {
    final ps = placed ?? placements(scene);
    // 클릭 목표는 최소 18px(패스 6) — 축소해도 캐릭터를 누를 수 있어야 한다.
    final r = math.max(18.0, charRadius + 4);
    // 1. 바(슬롯)에 그려진 대기자 — 뷰포트 좌표 그대로.
    for (var i = ps.length - 1; i >= 0; i--) {
      if (!drawsInBar(scene.members[i])) continue;
      if ((ps[i].center - p).distance <= r) return ps[i].memberId;
    }
    final k = slotAt(p);
    if (k != null) {
      final q = scene.queue;
      if (k < q.length) return q[k].memberId;
      if (k == myDeskSlots - 1 && q.length > myDeskSlots) return q[myDeskSlots - 1].memberId;
      return null;
    }
    if (p.dy >= viewportHeight) return null; // 바의 빈 곳
    // 2. 스크롤 영역 — 콘텐츠 좌표로.
    final c = toContent(p, scrollOffset);
    for (var i = ps.length - 1; i >= 0; i--) {
      if (drawsInBar(scene.members[i])) continue;
      if ((ps[i].center - c).distance <= r) return ps[i].memberId;
    }
    for (final m in scene.members) {
      if (deskRect(m.deskIndex).contains(c)) return m.id;
    }
    return null;
  }

  /// 클러스터 제목 줄("퇴근 N" 배지 포함)이 눌렸으면 그 팀 id.
  String? clusterTitleAt(Offset viewportPoint, double scrollOffset) {
    if (viewportPoint.dy >= viewportHeight) return null;
    final c = toContent(viewportPoint, scrollOffset);
    for (final box in clusters) {
      final teamId = box.cluster?.teamId;
      if (teamId == null) continue;
      final titleBand = Rect.fromLTWH(box.rect.left, box.rect.top, box.rect.width, clusterTitleHeight);
      if (titleBand.contains(c)) return teamId;
    }
    return null;
  }
}
