// OfficeMotion / MovementState 순수 단위 테스트(위젯·Ticker 없이 now 를 직접 준다).
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_layout.dart';
import 'package:pixel_office/office/office_motion.dart';
import 'package:pixel_office/office/office_scene.dart';

import 'office_fixtures.dart';

const wide = Size(1000, 700);
const t0 = Duration.zero;
Duration ms(int v) => Duration(milliseconds: v);

OfficeScene sceneOf(List<Member> members, {Map<String, Pending> pending = const {}, Map<String, OfficeEvent> events = const {}}) =>
    OfficeScene.build(members: {for (final m in members) m.id: m}, latestEvents: events, pending: pending);

CharacterPlacement place(String id, Offset c) => CharacterPlacement(memberId: id, center: c, bubbleAnchor: c - const Offset(0, 20));

void main() {
  group('MovementState', () {
    test('걷기: 거리/220px·s, 최소 250ms, 양끝 위치, ease-in-out', () {
      final w = MovementState.walk(from: place('a', Offset.zero), to: place('a', const Offset(440, 0)), now: t0);
      expect(w.durationMs, 2000);
      expect(w.at(t0).center, Offset.zero);
      expect(w.at(ms(1000)).center.dx, closeTo(220, 0.001)); // 가운데는 정확히 절반
      expect(w.at(ms(500)).center.dx, lessThan(110)); // 출발은 느리게
      expect(w.at(ms(1500)).center.dx, greaterThan(330)); // 도착도 느리게
      expect(w.at(ms(2000)).center, const Offset(440, 0));
      expect(w.at(ms(9000)).center, const Offset(440, 0)); // 끝나면 to 에 고정
      expect(w.isDone(ms(1999)), isFalse);
      expect(w.isDone(ms(2000)), isTrue);
      // 말풍선 꼬리도 같이 보간.
      expect(w.at(ms(1000)).bubbleAnchor, const Offset(220, -20));

      final short = MovementState.walk(from: place('a', Offset.zero), to: place('a', const Offset(10, 0)), now: ms(100));
      expect(short.durationMs, MovementState.minDurationMs);
      expect(short.isDone(ms(349)), isFalse);
      expect(short.isDone(ms(350)), isTrue);
    });

    test('instant 는 즉시 끝', () {
      final i = MovementState.instant(place('a', const Offset(5, 5)), ms(30));
      expect(i.isDone(ms(30)), isTrue);
      expect(i.at(t0).center, const Offset(5, 5));
    });

    test('easeInOut 은 0→0, 0.5→0.5, 1→1', () {
      expect(MovementState.easeInOut(0), 0);
      expect(MovementState.easeInOut(0.5), 0.5);
      expect(MovementState.easeInOut(1), 1);
    });
  });

  group('OfficeMotion.sync', () {
    final layout = OfficeLayout(size: wide, deskCount: 2);
    final idle2 = [member('m1', createdAt: '1'), member('m2', createdAt: '2')];

    test('첫 sync 는 즉시 배치, 같은 입력을 다시 줘도 이동 없음', () {
      final motion = OfficeMotion();
      motion.sync(sceneOf(idle2), layout, t0);
      expect(motion.movements.values.every((m) => m.isInstant), isTrue);
      expect(motion.placementsAt(t0).map((p) => p.center), [layout.seatCenter(0), layout.seatCenter(1)]);
      expect(motion.needsTicker(t0), isFalse);
      motion.sync(sceneOf(idle2), layout, ms(500));
      expect(motion.isMoving(ms(500)), isFalse);
    });

    test('pending 이 생기면 줄로 걷고, 닫히면 돌아온다', () {
      final motion = OfficeMotion();
      motion.sync(sceneOf(idle2), layout, t0);
      final queued = [member('m1', createdAt: '1'), member('m2', createdAt: '2', status: MemberStatus.waitingApproval)];
      motion.sync(sceneOf(queued, pending: {'a1': approval('a1', 'm2', 'ls')}), layout, ms(1000));
      final mv = motion.movements['m2']!;
      expect(mv.from.center, layout.seatCenter(1));
      expect(mv.to.center, layout.queueSlot(0));
      expect(mv.to.bubbleAnchor, layout.queueBubbleAnchor(0));
      expect(mv.startedAt, ms(1000));
      expect(motion.isMoving(ms(1000)), isTrue);
      final mid = motion.placementsAt(ms(1000 + mv.durationMs ~/ 2))[1].center;
      expect(mid.dy, greaterThan(layout.seatCenter(1).dy));
      expect(mid.dy, lessThan(layout.queueSlot(0).dy));
      final done = ms(1000 + mv.durationMs);
      expect(motion.placementsAt(done)[1].center, layout.queueSlot(0));
      expect(motion.isMoving(done), isFalse);
      expect(motion.placementsAt(done)[0].center, layout.seatCenter(0)); // m1 은 그대로

      motion.sync(sceneOf(idle2), layout, ms(9000));
      final back = motion.movements['m2']!;
      expect(back.from.center, layout.queueSlot(0));
      expect(back.to.center, layout.seatCenter(1));
    });

    test('걷는 도중 목표가 바뀌면 지금 위치에서 새 목표로', () {
      final motion = OfficeMotion();
      motion.sync(sceneOf(idle2), layout, t0);
      final queued = [member('m1', createdAt: '1'), member('m2', createdAt: '2', status: MemberStatus.waitingApproval)];
      motion.sync(sceneOf(queued, pending: {'a1': approval('a1', 'm2', 'ls')}), layout, t0);
      final first = motion.movements['m2']!;
      final half = ms(first.durationMs ~/ 2);
      final midPos = first.at(half).center;
      motion.sync(sceneOf(idle2), layout, half);
      final second = motion.movements['m2']!;
      expect(second.from.center, midPos);
      expect(second.to.center, layout.seatCenter(1));
      expect(second.startedAt, half);
    });

    test('starting 새 멤버는 문에서 입장, 그 외 새 멤버는 즉시 배치', () {
      final motion = OfficeMotion();
      motion.sync(sceneOf([member('m1', createdAt: '1')]), OfficeLayout(size: wide, deskCount: 1), t0);
      motion.sync(sceneOf([member('m1', createdAt: '1'), member('m2', createdAt: '2', status: MemberStatus.starting)]), layout, ms(10));
      final enter = motion.movements['m2']!;
      expect(enter.from.center, layout.doorSpawn);
      expect(enter.to.center, layout.seatCenter(1));
      expect(enter.isInstant, isFalse);

      final l3 = OfficeLayout(size: wide, deskCount: 3);
      motion.sync(sceneOf([member('m1', createdAt: '1'), member('m2', createdAt: '2'), member('m3', createdAt: '3')]), l3, ms(20));
      expect(motion.movements['m3']!.isInstant, isTrue); // 스냅샷 복원 등
      expect(motion.movements['m3']!.to.center, l3.seatCenter(2));
    });

    test('퇴근: 자리 → 문 → (advance 후) 회색으로 자리; 재출근은 문에서', () {
      final motion = OfficeMotion();
      motion.sync(sceneOf(idle2), layout, t0);
      final exited = [member('m1', createdAt: '1'), member('m2', createdAt: '2', status: MemberStatus.exited)];
      motion.sync(sceneOf(exited), layout, ms(100));
      final toDoor = motion.movements['m2']!;
      expect(toDoor.from.center, layout.seatCenter(1));
      expect(toDoor.to.center, layout.doorSpawn);
      final atDoor = ms(100 + toDoor.durationMs);
      expect(motion.isMoving(atDoor), isTrue); // 다음 구간이 남아 있으므로 계속
      motion.advance(atDoor);
      final back = motion.movements['m2']!;
      expect(back.from.center, layout.doorSpawn);
      expect(back.to.center, layout.seatCenter(1));
      expect(back.startedAt, atDoor);
      final home = ms(100 + toDoor.durationMs + back.durationMs);
      motion.advance(home);
      expect(motion.isMoving(home), isFalse);
      expect(motion.placementsAt(home)[1].center, layout.seatCenter(1));

      // 재출근(starting): 문에서 다시 들어온다.
      motion.sync(sceneOf([member('m1', createdAt: '1'), member('m2', createdAt: '2', status: MemberStatus.starting)]), layout, home);
      expect(motion.movements['m2']!.from.center, layout.doorSpawn);
      expect(motion.movements['m2']!.to.center, layout.seatCenter(1));
    });

    test('reporting 이벤트 → 내 책상 방문(줄 뒤 자리, ▤ 보고), idle/text 는 유지, 다른 이벤트·endVisit 은 복귀', () {
      final motion = OfficeMotion();
      motion.sync(sceneOf(idle2), layout, t0);
      final report = {'m1': event('m1', OfficeEventKind.reporting, seq: 5)};
      motion.sync(sceneOf(idle2, events: report), layout, ms(10));
      expect(motion.isVisiting('m1'), isTrue);
      expect(motion.visits.single.seq, 5);
      expect(motion.bubbleOverrides, {'m1': reportVisitBubble});
      // T40-3: 보고 방문은 슬롯을 차지하지 않고 내 책상 **오른쪽**에 선다.
      expect(motion.movements['m1']!.to.center, layout.reportSpot(0));

      // 같은 seq 를 다시 줘도 방문 하나.
      motion.sync(sceneOf(idle2, events: report), layout, ms(20));
      expect(motion.visits, hasLength(1));

      // 보고 뒤 idle 이 와도 방문 유지.
      motion.sync(sceneOf(idle2, events: {'m1': event('m1', OfficeEventKind.idle, seq: 6)}), layout, ms(30));
      expect(motion.isVisiting('m1'), isTrue);

      // 줄에 선 멤버가 있어도 방문 자리는 그대로(슬롯과 겹치지 않는다 — T40-3).
      final queued = [member('m1', createdAt: '1'), member('m2', createdAt: '2', status: MemberStatus.waitingAnswer)];
      motion.sync(sceneOf(queued, events: {'m1': event('m1', OfficeEventKind.idle, seq: 6)}, pending: {'q1': question('q1', 'm2', '?')}), layout, ms(40));
      expect(motion.movements['m2']!.to.center, layout.queueSlot(0));
      expect(motion.movements['m1']!.to.center, layout.reportSpot(0));

      // endVisit → 자리로.
      motion.endVisit('m1', ms(50));
      expect(motion.isVisiting('m1'), isFalse);
      expect(motion.bubbleOverrides, isEmpty);
      expect(motion.movements['m1']!.to.center, layout.seatCenter(0));

      // 새 reporting(seq 7) → 다시 방문, 그 뒤 running 이 오면 취소.
      motion.sync(sceneOf(idle2, events: {'m1': event('m1', OfficeEventKind.reporting, seq: 7)}), layout, ms(60));
      expect(motion.isVisiting('m1'), isTrue);
      motion.sync(sceneOf(idle2, events: {'m1': event('m1', OfficeEventKind.running, seq: 8, detail: {'cmd': 'ls'})}), layout, ms(70));
      expect(motion.isVisiting('m1'), isFalse);
      expect(motion.movements['m1']!.to.center, layout.seatCenter(0));
    });

    test('보고하러 온 멤버가 줄에 서거나 퇴근하면 방문 취소', () {
      final motion = OfficeMotion();
      motion.sync(sceneOf(idle2), layout, t0);
      motion.sync(sceneOf(idle2, events: {'m1': event('m1', OfficeEventKind.reporting, seq: 1)}), layout, ms(1));
      expect(motion.isVisiting('m1'), isTrue);
      final waiting = [member('m1', createdAt: '1', status: MemberStatus.waitingApproval), member('m2', createdAt: '2')];
      motion.sync(sceneOf(waiting, events: {'m1': event('m1', OfficeEventKind.reporting, seq: 1)}), layout, ms(2));
      expect(motion.isVisiting('m1'), isFalse);
      expect(motion.movements['m1']!.to.center, layout.queueSlot(0)); // 줄 자리(허가 대기)
    });

    test('bob: working 이고 서 있을 때만, 1Hz ±1.5px', () {
      final motion = OfficeMotion();
      final working = [member('m1', createdAt: '1', status: MemberStatus.working), member('m2', createdAt: '2')];
      motion.sync(sceneOf(working), layout, t0);
      expect(motion.hasBob, isTrue);
      expect(motion.needsTicker(t0), isTrue);
      expect(motion.bobAt(t0)['m1'], closeTo(0, 1e-9));
      expect(motion.bobAt(ms(250))['m1'], closeTo(bobAmplitude, 1e-9));
      expect(motion.bobAt(ms(750))['m1'], closeTo(-bobAmplitude, 1e-9));
      expect(motion.bobAt(ms(250)).containsKey('m2'), isFalse);
      // 걷는 중엔 흔들리지 않는다.
      final queued = [member('m1', createdAt: '1', status: MemberStatus.working), member('m2', createdAt: '2', status: MemberStatus.waitingAnswer)];
      motion.sync(sceneOf(queued, events: {'m1': event('m1', OfficeEventKind.reporting, seq: 1)}, pending: {'q1': question('q1', 'm2', '?')}), layout, ms(1000));
      expect(motion.bobAt(ms(1250)).containsKey('m1'), isFalse);
      expect(OfficeMotion().bobAt(t0), isEmpty);
    });

    test('장면에서 사라진 멤버는 잊고, reset 후엔 다시 즉시 배치', () {
      final motion = OfficeMotion();
      motion.sync(sceneOf(idle2), layout, t0);
      motion.sync(sceneOf([member('m1', createdAt: '1')]), OfficeLayout(size: wide, deskCount: 1), ms(1));
      expect(motion.movements.keys, ['m1']);
      final queued = [member('m1', createdAt: '1', status: MemberStatus.waitingApproval)];
      motion.reset();
      motion.sync(sceneOf(queued, pending: {'a': approval('a', 'm1', 'ls')}), OfficeLayout(size: wide, deskCount: 1), ms(2));
      expect(motion.movements['m1']!.isInstant, isTrue);
      expect(motion.placementsAt(ms(2)).single.center, OfficeLayout(size: wide, deskCount: 1).queueSlot(0));
    });
  });
}
