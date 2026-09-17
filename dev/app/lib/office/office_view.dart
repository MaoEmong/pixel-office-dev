// 사무실 뷰(T12 + T16 이동 애니메이션 + T40 레이아웃 v2). main.dart 의 OfficeArea 자리에 그대로 들어간다:
//   OfficeView(selectedMemberId: id, onSelectMember: (id) => ..., departmentId: null /* 전체 */)
// membersProvider / latestEvent 맵 / openPendingProvider 세 개만 watch 해 OfficeScene 을 만들고 OfficePainter 로 그린다.
// 탭 → OfficeLayout.hitTest(지금 위치 기준) → onSelectMember(멤버 id, 빈 곳이면 null).
//
// 레이아웃 v2(T40-1·3·6):
//   - **세로 스크롤**은 이 위젯이 들고 있다(휠·드래그 → `_scrollOffset`, 레이아웃이 `maxScroll` 로 잘라 준다).
//     내 책상·범례는 바닥 고정 바라 스크롤과 무관하고, 문도 스크롤 영역 왼쪽에 고정이다.
//   - 내 책상 **슬롯 클릭** = 그 멤버 선택 + [OfficeView.onSelectPending](패널 인박스 스크롤용, T40b 가 배선).
//   - 부서가 0 개면 캔버스 위에 큰 "부서 만들기" 버튼([OfficeView.onCreateDepartment] — 다이얼로그는 상단 바 몫).
//   - 클러스터 제목 줄 클릭 = 그 팀의 "퇴근 N" 접기 토글(앱 로컬 상태).
//   - 복구(`[RESUMED]`) 멤버는 3초 동안 책상 점선 + "↻ 복구됨" 말풍선.
//
// 이동(T16): 장면이 바뀌면 OfficeMotion.sync 가 멤버별 목표 자리를 정하고 트윈을 건다. Ticker 하나가
// 이동·흔들림이 있는 동안만 돌며 프레임마다 setState → 보간 위치로 다시 그린다. 전부 멈추면 Ticker 도 멈춘다
// (쉬는 동안 연속 repaint 없음). 보고 방문의 6초 만료는 Timer(멤버별) 로 알린다.
// 시계: Ticker elapsed 는 start 마다 0 부터라 `_clockBase + elapsed` 를 단조 시계로 쓴다(멈춘 동안은 시간이 서 있다 —
// 그때는 움직이는 것이 없으므로 무방).

import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../state/office_state.dart';
import 'office_layout.dart';
import 'office_motion.dart';
import 'office_painter.dart';
import 'office_scene.dart';
import 'office_sprites.dart';

export 'office_motion.dart' show MovementState, OfficeMotion, ReportVisit, reportVisitDuration, reportVisitBubble;
export 'office_scene.dart'
    show
        LegendSlot,
        OfficeScene,
        QueueEntry,
        SceneMember,
        createDepartmentLabel,
        emptyDepartmentHint,
        legendSlotOf,
        mySlotCount,
        noTeamPlaceholderHint,
        resumedBubble;

/// 스프라이트 아틀라스(T33). 앱에서 **한 번만** 읽어 엔진 2 × 머리색 4 = 8벌을 캐시한다.
/// 읽는 동안(그리고 위젯 테스트처럼 못 읽는 환경에서)은 value 가 null 이라 페인터가 원으로 그린다.
final spriteSheetProvider = FutureProvider<SpriteSheet>((ref) async {
  final sheet = await SpriteSheet.load();
  ref.onDispose(sheet.dispose);
  return sheet;
});

/// 멤버별 마지막 이벤트 맵. office_state 에는 멤버별 family(latestEventProvider)만 있어 여기서 맵 전체를 슬라이스한다.
final officeLatestEventsProvider = Provider<Map<String, OfficeEvent>>(
  (ref) => ref.watch(officeProvider.select((s) => s.latestEvent)),
);

/// 멤버별 파생 상태 맵(내 책상 줄·말풍선 판정에 쓴다 — `ask_user` 는 raw status 가 idle 이라 파생을 봐야 한다).
final officeDerivedProvider = Provider<Map<String, DerivedStatus>>(
  (ref) => ref.watch(officeProvider.select((s) => s.derived)),
);

/// 팀별 보고 건수(전원 퇴근 팀 제목 "보고 N건"). 이벤트 링버퍼의 `reporting` 을 센다 —
/// 스냅샷 `tasks` 는 열린 것만 오므로(끝난 보고가 없다) 쓸 수 없다.
final officeReportCountsProvider = Provider<Map<String, int>>((ref) {
  final out = <String, int>{};
  for (final e in ref.watch(officeProvider.select((s) => s.events))) {
    if (e.kind != OfficeEventKind.reporting || e.teamId.isEmpty) continue;
    out[e.teamId] = (out[e.teamId] ?? 0) + 1;
  }
  return out;
});

/// "퇴근 N" 배지를 펼쳐 둔 팀(앱 로컬 — 패스 2 이슈 7).
final expandedExitedTeamsProvider = NotifierProvider<ExpandedExitedTeams, Set<String>>(ExpandedExitedTeams.new);

class ExpandedExitedTeams extends Notifier<Set<String>> {
  @override
  Set<String> build() => const {};

  void toggle(String teamId) =>
      state = state.contains(teamId) ? ({...state}..remove(teamId)) : {...state, teamId};
}

/// 화면용 장면(**부서 id 별**, null = 전체). members / teams / latestEvent / pending / derived 중 하나라도
/// 바뀌면 다시 만든다(값 비교로 불필요한 repaint 는 페인터가 거른다).
final officeSceneProvider = Provider.family<OfficeScene, String?>(
  (ref, departmentId) => OfficeScene.build(
    members: ref.watch(membersProvider),
    latestEvents: ref.watch(officeLatestEventsProvider),
    pending: ref.watch(openPendingProvider),
    derived: ref.watch(officeDerivedProvider),
    teams: ref.watch(teamsProvider),
    departmentId: departmentId,
    now: DateTime.now(),
    expandedTeamIds: ref.watch(expandedExitedTeamsProvider),
    reportCounts: ref.watch(officeReportCountsProvider),
  ),
);

class OfficeView extends ConsumerStatefulWidget {
  const OfficeView({
    super.key,
    this.selectedMemberId,
    this.onSelectMember,
    this.onSelectPending,
    this.onCreateDepartment,
    this.departmentId,
  });

  /// 선택된 멤버(외곽 링). null 이면 없음.
  final String? selectedMemberId;

  /// 탭 결과: 캐릭터/책상이면 그 멤버 id, 빈 곳이면 null.
  final ValueChanged<String?>? onSelectMember;

  /// 내 책상 슬롯·"+N" 배지를 눌렀을 때의 pending id — 오른쪽 패널이 인박스에서 그 카드로 스크롤한다(D-42 2, T40b).
  final ValueChanged<String>? onSelectPending;

  /// 부서가 0 개일 때 가운데 "부서 만들기" 버튼(다이얼로그는 상단 바가 들고 있다 — T40b).
  final VoidCallback? onCreateDepartment;

  /// 보여줄 부서(= 상단 탭). null 이면 전체 멤버.
  final String? departmentId;

  @override
  ConsumerState<OfficeView> createState() => _OfficeViewState();
}

class _OfficeViewState extends ConsumerState<OfficeView> with SingleTickerProviderStateMixin {
  late final Ticker _ticker;
  final OfficeMotion _motion = OfficeMotion();

  /// 단조 시계 = [_clockBase] + 현재 Ticker elapsed.
  Duration _clockBase = Duration.zero;
  Duration _elapsed = Duration.zero;

  /// 보고 방문 만료 타이머(멤버 id → (그 방문의 seq, Timer)).
  final Map<String, (int, Timer)> _visitTimers = {};

  /// 복구 표시(3초) — 멤버 id → 이미 표시한 복구 이벤트 seq(타이머가 끝나도 남겨 둔다: 같은 이벤트로
  /// 다시 점선을 켜면 영원히 깜빡인다). 진행 중인 것만 [_resumeTimers]·[_resumedIds] 에 있다.
  final Map<String, int?> _resumeSeen = {};
  final Map<String, Timer> _resumeTimers = {};
  final Set<String> _resumedIds = {};

  /// 마지막으로 sync 한 캔버스 크기. 바뀌면 전부 즉시 재배치(크기 변경은 걷지 않는다).
  Size? _syncedSize;
  OfficeLayout? _layout;

  /// 스크롤 영역이 내려간 거리.
  double _scroll = 0;
  String? _hovered;

  Duration get _now => _clockBase + _elapsed;

  @override
  void initState() {
    super.initState();
    _ticker = createTicker(_onTick);
  }

  @override
  void dispose() {
    _ticker.dispose();
    for (final t in _visitTimers.values) {
      t.$2.cancel();
    }
    for (final t in _resumeTimers.values) {
      t.cancel();
    }
    _visitTimers.clear();
    _resumeTimers.clear();
    super.dispose();
  }

  void _onTick(Duration elapsed) {
    _elapsed = elapsed;
    _motion.advance(_now);
    if (!_motion.needsTicker(_now)) _stopTicker();
    setState(() {});
  }

  void _stopTicker() {
    _clockBase = _now;
    _elapsed = Duration.zero;
    _ticker.stop();
  }

  void _ensureTicker() {
    if (!_ticker.isActive && _motion.needsTicker(_now)) _ticker.start();
  }

  /// 장면·레이아웃을 이동 모델에 반영하고, 보고 방문·복구 타이머를 맞춘다(build 안에서 호출 — 같은 입력이면 무해).
  void _sync(OfficeScene scene, Size size) {
    if (_syncedSize != size) {
      _motion.reset();
      _syncedSize = size;
    }
    final layout = OfficeLayout(size: size, plan: scene.plan);
    _layout = layout;
    _scroll = layout.clampScroll(_scroll);

    _motion.sync(scene, layout, _now);
    _reconcileVisitTimers();
    _reconcileResumeMarks(scene);
    _ensureTicker();
  }

  void _reconcileVisitTimers() {
    final visits = {for (final v in _motion.visits) v.memberId: v.seq};
    for (final id in _visitTimers.keys.toList(growable: false)) {
      final seq = visits[id];
      if (seq == null || seq != _visitTimers[id]!.$1) {
        _visitTimers.remove(id)!.$2.cancel();
      }
    }
    for (final e in visits.entries) {
      if (_visitTimers.containsKey(e.key)) continue;
      _visitTimers[e.key] = (e.value, Timer(reportVisitDuration, () => _onVisitTimeout(e.key)));
    }
  }

  /// 복구(`[RESUMED]`) 멤버는 3초 동안 점선 책상 + "↻ 복구됨" 말풍선(패스 2 D10).
  void _reconcileResumeMarks(OfficeScene scene) {
    for (final m in scene.members) {
      if (!m.isResumed) continue;
      if (_resumeSeen.containsKey(m.id) && _resumeSeen[m.id] == m.eventSeq) continue; // 이미 보여 준 복구
      _resumeTimers.remove(m.id)?.cancel();
      _resumeSeen[m.id] = m.eventSeq;
      _resumedIds.add(m.id);
      _resumeTimers[m.id] = Timer(resumedMarkDuration, () => _onResumeTimeout(m.id));
    }
    final ids = {for (final m in scene.members) m.id};
    _resumeSeen.removeWhere((id, _) => !ids.contains(id));
    for (final id in _resumeTimers.keys.toList(growable: false)) {
      if (!ids.contains(id)) {
        _resumeTimers.remove(id)!.cancel();
        _resumedIds.remove(id);
      }
    }
  }

  void _onResumeTimeout(String memberId) {
    _resumeTimers.remove(memberId);
    if (!mounted) return;
    setState(() => _resumedIds.remove(memberId));
  }

  void _onVisitTimeout(String memberId) {
    _visitTimers.remove(memberId);
    if (!mounted) return;
    setState(() {
      _motion.endVisit(memberId, _now);
      _ensureTicker();
    });
  }

  void _scrollBy(double dy, OfficeLayout layout) {
    final next = layout.clampScroll(_scroll + dy);
    if (next != _scroll) setState(() => _scroll = next);
  }

  void _onTap(Offset local, OfficeScene scene, OfficeLayout layout) {
    // 1. 내 책상 슬롯·"+N" 배지 → 그 멤버 선택 + 인박스 카드로.
    final slot = layout.slotAt(local);
    if (slot != null) {
      // 빈 슬롯(점선 실루엣)은 아무 일도 하지 않는다 — 선택을 지우지도 않는다.
      final entry = scene.slotEntry(slot);
      if (entry != null) {
        widget.onSelectMember?.call(entry.memberId);
        widget.onSelectPending?.call(entry.pendingId);
      }
      return;
    }
    // 2. 클러스터 제목 줄 → "퇴근 N" 접기 토글.
    final teamId = layout.clusterTitleAt(local, _scroll);
    if (teamId != null) {
      ref.read(expandedExitedTeamsProvider.notifier).toggle(teamId);
      return;
    }
    widget.onSelectMember?.call(layout.hitTest(local, scene, _motion.placementsAt(_now), _scroll));
  }

  void _onHover(Offset local, OfficeScene scene, OfficeLayout layout) {
    final id = layout.hitTest(local, scene, _motion.placementsAt(_now), _scroll);
    if (id != _hovered) setState(() => _hovered = id);
  }

  @override
  Widget build(BuildContext context) {
    final scene = ref.watch(officeSceneProvider(widget.departmentId));
    // 부서 0 개(= 아직 아무도 없는 사무실)일 때만 큰 "부서 만들기" 버튼을 얹는다(T40-6).
    final noDepartment = ref.watch(departmentsProvider).isEmpty && scene.isEmpty;
    // 아직 못 읽었으면 null — 페인터가 원으로 그리다가 도착하면 스프라이트로 바뀐다(T33).
    final sprites = ref.watch(spriteSheetProvider).value;
    final textDirection = Directionality.maybeOf(context) ?? TextDirection.ltr;
    return LayoutBuilder(
      builder: (context, constraints) {
        final size = Size(
          constraints.hasBoundedWidth ? constraints.maxWidth : 900,
          constraints.hasBoundedHeight ? constraints.maxHeight : 600,
        );
        _sync(scene, size);
        final layout = _layout!;
        final now = _now;
        final painter = OfficePainter(
          scene: scene,
          selectedMemberId: widget.selectedMemberId,
          hoveredMemberId: _hovered,
          textDirection: textDirection,
          placements: _motion.placementsAt(now),
          bob: _motion.bobAt(now),
          bubbleOverrides: {
            for (final id in _resumedIds) id: resumedBubble,
            ..._motion.bubbleOverrides,
          },
          scrollOffset: _scroll,
          resumedIds: _resumedIds,
          showEmptyHint: !noDepartment,
          sprites: sprites,
          walk: _motion.walkAt(now),
          visitingIds: {for (final v in _motion.visits) v.memberId},
          typeFrame: typeFrameAt(now),
        );
        return Listener(
          onPointerSignal: (e) {
            if (e is PointerScrollEvent) _scrollBy(e.scrollDelta.dy, layout);
          },
          child: MouseRegion(
            onHover: (e) => _onHover(e.localPosition, scene, layout),
            onExit: (_) {
              if (_hovered != null) setState(() => _hovered = null);
            },
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTapUp: (d) => _onTap(d.localPosition, scene, layout),
              onVerticalDragUpdate: layout.isScrollable ? (d) => _scrollBy(-d.delta.dy, layout) : null,
              child: ClipRect(
                child: Stack(
                  children: [
                    CustomPaint(size: size, painter: painter, willChange: _ticker.isActive),
                    if (noDepartment) _EmptyDepartmentOverlay(onCreate: widget.onCreateDepartment, height: layout.viewportHeight),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// 부서 0 개: 빈 바닥 + 문 위에 큰 "부서 만들기" 버튼 + 한 줄(패스 2 이슈 7 · 패스 3 스토리보드 3).
class _EmptyDepartmentOverlay extends StatelessWidget {
  const _EmptyDepartmentOverlay({required this.onCreate, required this.height});

  final VoidCallback? onCreate;
  final double height;

  @override
  Widget build(BuildContext context) => Positioned(
        left: 0,
        right: 0,
        top: 0,
        height: height,
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              FilledButton(
                key: const Key('office.createDepartment'),
                onPressed: onCreate,
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 16),
                  textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
                child: const Text(createDepartmentLabel),
              ),
              const SizedBox(height: 10),
              const Text(emptyDepartmentHint, style: TextStyle(color: OfficeColors.hint, fontSize: 12)),
            ],
          ),
        ),
      );
}
