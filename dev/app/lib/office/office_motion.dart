// 이동 애니메이션 모델(T16, 순수 Dart). 위젯·Ticker 없이 "지금(now)" 을 인자로 받는다 — 단위 테스트 대상.
//
// 위치의 단일 소스는 멤버별 [MovementState]: 끝난 이동의 `to` 가 지금 서 있는 자리다.
// [OfficeMotion.sync] 는 장면(OfficeScene)·레이아웃에서 멤버별 목표 자리를 정하고, 목표가 바뀐 멤버에게
// 현재 위치 → 목표 로 걷는 트윈을 건다(ease-in-out, 220 px/s, 최소 250 ms).
//   자리 ↔ 내 책상 줄(허가·질문 pending), 줄 순서 변경, 책상 번호 변경 → 걷기
//   status starting 인 새 멤버 → 문에서 자리로 "입장"; exited/error 가 되면 자리 → 문 → (회색으로) 자리
//   마지막 이벤트가 reporting → 내 책상으로 걸어와 [reportVisitDuration] 동안 "▤ 보고" 말풍선, 그 뒤 돌아감
//     (시간 만료는 위젯의 Timer 가 [endVisit] 로 알린다; idle/text·**MCP 팀 도구 호출** 이외의 새 이벤트·
//      줄 서기·퇴근이면 즉시 취소 — [cancelsVisit], T29 결함 ④)
//   `ask_parent` 로 상사 답을 기다리는 멤버 → 직속 상사 책상 옆으로 걸어가 서 있는다(T37)
//   working 멤버는 자리에서 ±1.5 px, 1 Hz 로 흔들린다([bobAt]).

import 'dart:math' as math;
import 'dart:ui';

import '../model/models.dart';
import 'office_layout.dart';
import 'office_scene.dart';
import 'office_sprites.dart';

/// 보고하러 온 멤버가 내 책상 앞에 머무는 시간.
const Duration reportVisitDuration = Duration(seconds: 6);

/// 보고 방문 중 말풍선.
const String reportVisitBubble = '▤ 보고';

/// 작업 중 흔들림(px, Hz).
const double bobAmplitude = 1.5;
const double bobHz = 1;

/// 한 멤버의 이동 한 구간. 끝나면 `to` 에 서 있다.
class MovementState {
  const MovementState({required this.from, required this.to, required this.startedAt, required this.durationMs});

  /// 즉시 배치(이동 없음).
  factory MovementState.instant(CharacterPlacement at, Duration now) =>
      MovementState(from: at, to: at, startedAt: now, durationMs: 0);

  /// 걷기: 거리 / [speedPxPerSec], 최소 [minDurationMs].
  factory MovementState.walk({required CharacterPlacement from, required CharacterPlacement to, required Duration now}) {
    final dist = (to.center - from.center).distance;
    final ms = math.max(minDurationMs, (dist / speedPxPerSec * 1000).round());
    return MovementState(from: from, to: to, startedAt: now, durationMs: ms);
  }

  /// 시간을 못 박은 걷기 — 출근 연출은 거리와 무관하게 [arrivalWalkDuration](1.2초)다(패스 2 D10).
  factory MovementState.walkFor({
    required CharacterPlacement from,
    required CharacterPlacement to,
    required Duration now,
    required Duration duration,
  }) =>
      MovementState(from: from, to: to, startedAt: now, durationMs: duration.inMilliseconds);

  static const double speedPxPerSec = 220;
  static const int minDurationMs = 250;

  final CharacterPlacement from;
  final CharacterPlacement to;
  final Duration startedAt;
  final int durationMs;

  bool get isInstant => durationMs <= 0;

  /// 0..1 (시간 비율, easing 전).
  double progress(Duration now) {
    if (isInstant) return 1;
    final t = (now - startedAt).inMicroseconds / (durationMs * 1000);
    return t.clamp(0.0, 1.0);
  }

  bool isDone(Duration now) => progress(now) >= 1;

  /// 보간된 위치(원 중심·말풍선 꼬리 모두).
  CharacterPlacement at(Duration now) {
    final e = easeInOut(progress(now));
    return CharacterPlacement(
      memberId: to.memberId,
      center: Offset.lerp(from.center, to.center, e)!,
      bubbleAnchor: Offset.lerp(from.bubbleAnchor, to.bubbleAnchor, e)!,
    );
  }

  /// smoothstep — 양끝에서 느리고 가운데서 빠르다.
  static double easeInOut(double t) => t * t * (3 - 2 * t);

  @override
  String toString() => 'Movement(${to.memberId} ${from.center}→${to.center} ${durationMs}ms @$startedAt)';
}

/// 보고 방문(내 책상 앞에 머무는 중).
class ReportVisit {
  const ReportVisit({required this.memberId, required this.seq, required this.order});

  final String memberId;

  /// 방문을 일으킨 reporting 이벤트 seq. 같은 멤버의 새 reporting 이면 seq 가 바뀌고 타이머를 다시 잰다.
  final int seq;

  /// 도착 순서(줄 자리 배정용).
  final int order;
}

class _Track {
  _Track({required this.gone, required this.target});
  bool gone;
  CharacterPlacement target;
}

/// 멤버별 이동 상태 모음. 위젯이 장면이 바뀔 때 [sync], 프레임마다 [advance] 를 부르고 [placementsAt] 로 그린다.
class OfficeMotion {
  final Map<String, MovementState> _movements = {};

  /// 지금 구간이 끝나면 이어서 갈 곳(퇴근: 문 → 자리).
  final Map<String, CharacterPlacement> _nextLeg = {};
  final Map<String, _Track> _tracks = {};
  final Map<String, int> _lastReportSeq = {};
  final Map<String, ReportVisit> _visits = {};
  int _visitCounter = 0;
  bool _initialized = false;
  OfficeScene _scene = OfficeScene.empty;
  OfficeLayout? _layout;

  /// 방문 취소 대상이 아닌 이벤트(보고 뒤에 자연히 따라오는 것들).
  static const Set<OfficeEventKind> _visitKeepKinds = {OfficeEventKind.reporting, OfficeEventKind.idle, OfficeEventKind.text};

  /// 보고 방문을 취소해야 하는 새 이벤트인가.
  ///
  /// T29 결함 ④: 보고 직후의 `running{tool:'mcp__team__dismiss'}` 처럼 **MCP 팀 도구 호출**은 보고에 딸린
  /// 뒷정리이지 "다른 일을 시작했다" 가 아니다 — 6초 방문을 끊으면 보고하러 온 멤버가 내 책상에 오지도 못하고
  /// 사라진다. 도구 이름이 `mcp__team__` 로 시작하는 이벤트는 취소 사유에서 뺀다.
  static bool cancelsVisit(SceneMember m, ReportVisit visit) {
    final seq = m.eventSeq;
    if (seq == null || seq == visit.seq) return false;
    if (_visitKeepKinds.contains(m.eventKind)) return false;
    if ((m.eventTool ?? '').startsWith(teamToolPrefix)) return false;
    return true;
  }

  /// 멤버별 현재 이동(읽기 전용).
  Map<String, MovementState> get movements => Map.unmodifiable(_movements);

  /// 진행 중인 보고 방문(도착 순).
  List<ReportVisit> get visits => _visits.values.toList(growable: false)..sort((a, b) => a.order.compareTo(b.order));

  bool isVisiting(String memberId) => _visits.containsKey(memberId);

  /// 방문 중 멤버의 말풍선 덮어쓰기(페인터 용).
  Map<String, String> get bubbleOverrides => {for (final id in _visits.keys) id: reportVisitBubble};

  OfficeScene get scene => _scene;

  /// 전부 잊는다(캔버스 크기 변경 → 다음 sync 에서 즉시 배치).
  void reset() {
    _movements.clear();
    _nextLeg.clear();
    _tracks.clear();
    _initialized = false;
    // 방문·마지막 보고 seq 는 유지 — 크기가 바뀌었다고 보고를 다시 하진 않는다.
  }

  // ---- 동기화 ---------------------------------------------------------------------

  /// 장면·레이아웃을 받아 목표 자리를 다시 정하고 필요한 이동을 건다. 같은 입력이면 아무것도 바꾸지 않는다.
  void sync(OfficeScene scene, OfficeLayout layout, Duration now) {
    _scene = scene;
    _layout = layout;
    final ids = {for (final m in scene.members) m.id};

    // 1. 보고 방문 시작·취소.
    for (final m in scene.members) {
      final kind = m.eventKind;
      final seq = m.eventSeq;
      if (kind == OfficeEventKind.reporting && seq != null && _lastReportSeq[m.id] != seq) {
        _lastReportSeq[m.id] = seq;
        if (!m.isQueued && !m.isGone) {
          _visits[m.id] = ReportVisit(memberId: m.id, seq: seq, order: _visits[m.id]?.order ?? _visitCounter++);
        }
      }
      final v = _visits[m.id];
      if (v != null) {
        if (m.isQueued || m.isGone || cancelsVisit(m, v)) _visits.remove(m.id);
      }
    }
    _visits.removeWhere((id, _) => !ids.contains(id));
    _lastReportSeq.removeWhere((id, _) => !ids.contains(id));

    // 2. 목표 자리 → 이동.
    _retarget(now);

    _movements.removeWhere((id, _) => !ids.contains(id));
    _nextLeg.removeWhere((id, _) => !ids.contains(id));
    _tracks.removeWhere((id, _) => !ids.contains(id));
    _initialized = true;
  }

  /// 보고 방문 종료(위젯 타이머). 자리로 돌아가는 이동을 건다.
  void endVisit(String memberId, Duration now) {
    if (_visits.remove(memberId) == null) return;
    _retarget(now);
  }

  /// 끝난 구간에 다음 구간이 있으면 이어서 시작한다(프레임마다 호출).
  void advance(Duration now) {
    for (final id in _nextLeg.keys.toList(growable: false)) {
      final mv = _movements[id];
      if (mv == null) {
        _nextLeg.remove(id);
      } else if (mv.isDone(now)) {
        final next = _nextLeg.remove(id)!;
        _movements[id] = MovementState.walk(from: mv.to, to: next, now: now);
      }
    }
  }

  void _retarget(Duration now) {
    final layout = _layout;
    if (layout == null) return;
    final visitorRank = <String, int>{};
    for (final v in visits) {
      visitorRank[v.memberId] = visitorRank.length;
    }
    final door = layout.doorSpawn;

    for (final m in _scene.members) {
      final target = _targetFor(m, layout, visitorRank[m.id]);
      final track = _tracks[m.id];
      final current = _movements[m.id];
      if (track == null || current == null) {
        // 새 멤버: 출근 중(starting)이면 문에서 **1.2초** 동안 걸어 들어온다(패스 2 D10), 그 외(스냅샷 복원 등)는 즉시 배치.
        if (_initialized && m.status == MemberStatus.starting && !m.isGone) {
          _movements[m.id] = MovementState.walkFor(
              from: _doorPlacement(m.id, door, layout), to: target, now: now, duration: arrivalWalkDuration);
        } else {
          _movements[m.id] = MovementState.instant(target, now);
        }
        _nextLeg.remove(m.id);
      } else if (track.gone && !m.isGone) {
        // 재출근: 문에서 다시 들어온다(출근과 같은 1.2초).
        _nextLeg.remove(m.id);
        _movements[m.id] = MovementState.walkFor(
            from: _doorPlacement(m.id, door, layout), to: target, now: now, duration: arrivalWalkDuration);
      } else if (!track.gone && m.isGone) {
        // 퇴근: 문까지 걸어간 뒤 회색으로 자리에 돌아와 앉는다(T12 의 "회색 책상" 표현 유지).
        _movements[m.id] = MovementState.walk(from: current.at(now), to: _doorPlacement(m.id, door, layout), now: now);
        _nextLeg[m.id] = target;
      } else if (_nextLeg.containsKey(m.id)) {
        // 문으로 가는 중에 목표(책상 번호)가 바뀌면 돌아올 곳만 갱신.
        _nextLeg[m.id] = target;
      } else if (current.to != target) {
        _movements[m.id] = MovementState.walk(from: current.at(now), to: target, now: now);
      }
      _tracks[m.id] = _Track(gone: m.isGone, target: target);
    }
  }

  CharacterPlacement _targetFor(SceneMember m, OfficeLayout layout, int? visitorRank) {
    if (visitorRank != null) {
      // 보고 방문은 슬롯을 차지하지 않는다 — 내 책상 오른쪽에 선다(T40-3).
      return CharacterPlacement(
          memberId: m.id, center: layout.reportSpot(visitorRank), bubbleAnchor: layout.reportBubbleAnchor(visitorRank));
    }
    // 슬롯 4칸이 차면 5명째부터는 **자기 책상에 남는다**(주황 링 + "+N" 배지, D-42 3).
    if (m.hasSlot) {
      return CharacterPlacement(memberId: m.id, center: layout.queueSlot(m.queueIndex!), bubbleAnchor: layout.queueBubbleAnchor(m.queueIndex!));
    }
    // `ask_parent` 로 답을 기다리는 중 — 내 책상이 아니라 **직속 상사 책상 옆**으로 간다(T37, D-32).
    // 3명째부터는 자기 자리에 남고 "+N" 말풍선만 뜬다.
    if (m.showsAsVisitor) {
      final k = m.askParentVisitorIndex ?? 0;
      return CharacterPlacement(
        memberId: m.id,
        center: layout.visitorSpot(m.askParentDeskIndex!, k),
        bubbleAnchor: layout.visitorBubbleAnchor(m.askParentDeskIndex!, k),
      );
    }
    return CharacterPlacement(memberId: m.id, center: layout.seatCenter(m.deskIndex), bubbleAnchor: layout.seatBubbleAnchor(m.deskIndex));
  }

  CharacterPlacement _doorPlacement(String id, Offset door, OfficeLayout layout) =>
      CharacterPlacement(memberId: id, center: door, bubbleAnchor: Offset(door.dx, door.dy - layout.charRadius - 4 * layout.scale));

  // ---- 조회 -----------------------------------------------------------------------

  /// 장면 순서대로 지금 위치. 이동 정보가 없는 멤버(sync 전)는 레이아웃 기본 자리.
  List<CharacterPlacement> placementsAt(Duration now) {
    final layout = _layout;
    return [
      for (final m in _scene.members)
        _movements[m.id]?.at(now) ??
            (layout == null
                ? CharacterPlacement(memberId: m.id, center: Offset.zero, bubbleAnchor: Offset.zero)
                : layout.placements(OfficeScene(members: [m], queue: const [])).single),
    ];
  }

  /// **걷는 중**인 멤버의 스프라이트 프레임·방향(T33). 멈춰 있는 멤버는 목록에 없다.
  ///
  /// 프레임은 시간이 아니라 **지금까지 걸어온 거리**로 고른다([walkFrameFor]) — 짧게 옮기면 한두 프레임만
  /// 지나가고 길게 걸으면 발이 여러 번 구르는, 거리에 맞는 걸음이 된다. 방향은 출발→도착의 dx 부호이고
  /// 세로로만 움직이면(dx ≈ 0) 오른쪽을 본다.
  Map<String, SpriteWalk> walkAt(Duration now) {
    Map<String, SpriteWalk>? out;
    for (final m in _scene.members) {
      final mv = _movements[m.id];
      if (mv == null || mv.isInstant || mv.isDone(now)) continue;
      final travelled = (mv.at(now).center - mv.from.center).distance;
      final dx = mv.to.center.dx - mv.from.center.dx;
      (out ??= {})[m.id] = SpriteWalk(frame: walkFrameFor(travelled), facingLeft: dx < -0.5);
    }
    return out ?? const {};
  }

  /// 작업 중이고 서 있는 멤버의 흔들림(px). 없으면 빈 맵.
  Map<String, double> bobAt(Duration now) {
    Map<String, double>? out;
    for (final m in _scene.members) {
      if (m.status != MemberStatus.working) continue;
      final mv = _movements[m.id];
      if (mv != null && !mv.isDone(now)) continue;
      final t = now.inMicroseconds / Duration.microsecondsPerSecond;
      (out ??= {})[m.id] = bobAmplitude * math.sin(2 * math.pi * bobHz * t);
    }
    return out ?? const {};
  }

  /// 걷는 중인 멤버가 있는가.
  bool isMoving(Duration now) => _nextLeg.isNotEmpty || _movements.values.any((mv) => !mv.isDone(now));

  /// 흔들릴 멤버(working)가 있는가.
  bool get hasBob => _scene.members.any((m) => m.status == MemberStatus.working);

  /// 프레임을 계속 그려야 하는가(이동 중이거나 흔들림).
  bool needsTicker(Duration now) => isMoving(now) || hasBob;
}
