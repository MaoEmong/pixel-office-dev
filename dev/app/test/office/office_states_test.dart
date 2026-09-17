// T40-6: 빈 상태·로딩 연출.
//   부서 0 → 가운데 "부서 만들기" 버튼 + 한 줄 / 부장만 → 점선 클러스터 자리 /
//   starting → 문에서 1.2초 걸어 들어오며 "(출근 중)" · 노란 링 / 복구 → 점선 3초 + "↻ 복구됨" /
//   퇴근 10분 뒤 "퇴근 N" 접기(클릭 토글) / 전원 퇴근 팀 → 제목만 남은 낮은 상자.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_layout.dart';
import 'package:pixel_office/office/office_painter.dart' show legendColor;
import 'package:pixel_office/office/office_scene.dart';
import 'package:pixel_office/office/office_view.dart';
import 'package:pixel_office/state/office_state.dart';

import 'office_fixtures.dart';
import 'office_harness.dart';

Member exitedMember(String id, {required String updatedAt, String name = '이음', String teamId = 't0', String createdAt = '2'}) =>
    Member(
      id: id,
      departmentId: 'd1',
      teamId: teamId,
      parentId: 'mL',
      name: name,
      rank: MemberRank.member,
      engine: Engine.claude,
      sessionId: null,
      childPid: null,
      cwd: 'D:/x',
      status: MemberStatus.exited,
      hiredBy: HiredBy.leader,
      memberToken: 'mt',
      instructionsPath: null,
      createdAt: createdAt,
      updatedAt: updatedAt,
    );

void main() {
  group('부서 0 · 부장만(T40-6)', () {
    testWidgets('부서가 없으면 가운데 "부서 만들기" 버튼 + 한 줄', (tester) async {
      var created = 0;
      await pumpHarness(tester, FakeOfficeNotifier(const OfficeState()), onCreateDepartment: () => created++);
      expect(find.byKey(const Key('office.createDepartment')), findsOne);
      expect(find.text(createDepartmentLabel), findsOne);
      expect(find.text(emptyDepartmentHint), findsOne);
      await tester.tap(find.byKey(const Key('office.createDepartment')));
      expect(created, 1);
      // 문·내 책상은 그대로 그려진다(빈 바닥 + 문).
      expect(painterOf(tester).scene.isEmpty, isTrue);
      expect(painterOf(tester).showEmptyHint, isFalse, reason: '버튼이 있으니 문구는 안 겹쳐 쓴다');
    });

    testWidgets('부서가 있으면 버튼을 얹지 않는다', (tester) async {
      final state = OfficeState(
        departments: {'d1': department('d1', name: 'alpha')},
        members: {'mH': head('mH', name: '부장', createdAt: '0')},
      );
      await pumpHarness(tester, FakeOfficeNotifier(state));
      expect(find.byKey(const Key('office.createDepartment')), findsNothing);
    });

    test('부장만 있으면 점선 클러스터 자리 하나 + 안내 문구', () {
      final scene = OfficeScene.build(
        members: {'mH': head('mH', name: '부장', createdAt: '0')},
        latestEvents: const {},
        pending: const {},
      );
      final c = scene.plan.clusters.single;
      expect(c.isPlaceholder, isTrue);
      expect(c.deskCount, 0);
      expect(c.title, noTeamPlaceholderHint);
      // 자리는 부장 카펫 아래.
      final l = OfficeLayout(size: const Size(1000, 700), plan: scene.plan);
      expect(l.clusters.single.rect.top, greaterThan(l.deskRect(0).bottom));
      expect(l.clusters.single.rect.width, lessThan(1000 * 0.6));
    });

    test('팀이 생기면 점선 자리가 사라진다', () {
      final scene = OfficeScene.build(
        members: {
          'mH': head('mH', name: '부장', createdAt: '0'),
          'mL': lead('mL', name: '반장', teamId: 't0', parentId: 'mH', createdAt: '1'),
        },
        latestEvents: const {},
        pending: const {},
        teams: {'t0': team('t0', name: 't0', createdAt: '0')},
      );
      expect(scene.plan.clusters.single.isPlaceholder, isFalse);
      expect(scene.plan.clusters.single.deskCount, 1);
    });
  });

  group('출근(starting) 연출', () {
    test('문 → 자리 걷기는 거리와 무관하게 1.2초', () {
      const t0 = Duration.zero;
      final layout = OfficeLayout(size: const Size(1000, 700), deskCount: 2);
      final motion = OfficeMotion();
      OfficeScene sceneOf(List<Member> ms) =>
          OfficeScene.build(members: {for (final m in ms) m.id: m}, latestEvents: const {}, pending: const {});
      motion.sync(sceneOf([member('m1', createdAt: '1')]), layout, t0);
      motion.sync(
          sceneOf([member('m1', createdAt: '1'), member('m2', status: MemberStatus.starting, createdAt: '2')]),
          layout,
          const Duration(milliseconds: 10));
      expect(arrivalWalkDuration, const Duration(milliseconds: 1200));
      expect(motion.movements['m2']!.durationMs, 1200);
      expect(motion.movements['m2']!.from.center, layout.doorSpawn);
    });

    testWidgets('출근 중 모니터는 "(출근 중)" · 링은 노랑(대기), 준비되면 초록(한가)', (tester) async {
      final notifier = FakeOfficeNotifier(OfficeState(members: {
        'mH': head('mH', name: '부장', status: MemberStatus.starting, createdAt: '0'),
      }));
      await pumpHarness(tester, notifier);
      var m = painterOf(tester).scene.members.single;
      expect(m.summary, '(출근 중)');
      expect(m.monitorTop, '(출근 중)');
      expect(m.legendSlot, LegendSlot.waiting);
      expect(legendColor(m.legendSlot), const Color(0xFFFFC857));

      notifier.set(OfficeState(members: {'mH': head('mH', name: '부장', createdAt: '0')}));
      await tester.pump();
      m = painterOf(tester).scene.members.single;
      expect(m.legendSlot, LegendSlot.idle);
      expect(legendColor(m.legendSlot), const Color(0xFF7ED3A1));
    });
  });

  group('복구(`[RESUMED]`) 3초', () {
    testWidgets('복구 이벤트 → 점선 책상 + "↻ 복구됨" 말풍선, 3초 뒤 사라진다', (tester) async {
      final base = OfficeState(members: {'mH': head('mH', name: '부장', createdAt: '0')});
      final notifier = FakeOfficeNotifier(base);
      await pumpHarness(tester, notifier);
      expect(painterOf(tester).resumedIds, isEmpty);

      notifier.set(OfficeState(
        members: base.members,
        latestEvent: {'mH': event('mH', OfficeEventKind.text, seq: 7, detail: {'summary': 'resumed'})},
      ));
      await tester.pump();
      var painter = painterOf(tester);
      expect(painter.scene.members.single.isResumed, isTrue);
      expect(painter.resumedIds, {'mH'});
      expect(painter.bubbleOverrides['mH'], resumedBubble);

      await tester.pump(const Duration(seconds: 2));
      expect(painterOf(tester).resumedIds, {'mH'});
      await tester.pump(const Duration(milliseconds: 1100));
      painter = painterOf(tester);
      expect(painter.resumedIds, isEmpty);
      expect(painter.bubbleOverrides.containsKey('mH'), isFalse);
      expect(resumedMarkDuration, const Duration(seconds: 3));
    });
  });

  group('퇴근 접기 · 전원 퇴근 팀', () {
    OfficeState office({required String exitedAt}) => OfficeState(
          departments: {'d1': department('d1')},
          members: {
            'mH': head('mH', name: '부장', createdAt: '0'),
            'mL': lead('mL', name: '반장', teamId: 't0', parentId: 'mH', createdAt: '1'),
            'm1': exitedMember('m1', updatedAt: exitedAt),
          },
          teams: {'t0': team('t0', name: 't0', createdAt: '0')},
        );

    test('10분이 지나야 접힌다(기준 시각 없으면 접지 않는다)', () {
      final now = DateTime.parse('2026-09-17T12:00:00Z');
      DeskCluster build({String? updatedAt, DateTime? at, Set<String> expanded = const {}}) => OfficeScene.build(
            members: office(exitedAt: updatedAt ?? '2026-09-17T11:59:00Z').members,
            latestEvents: const {},
            pending: const {},
            teams: office(exitedAt: '').teams,
            now: at,
            expandedTeamIds: expanded,
          ).plan.clusters.single;

      expect(build(at: null).exitedFolded, 0, reason: 'now 없으면 접지 않는다');
      expect(build(at: now).exitedFolded, 0, reason: '1분 전 퇴근은 그대로 의자 책상');
      expect(build(at: now).deskCount, 2);
      final folded = build(updatedAt: '2026-09-17T11:40:00Z', at: now);
      expect(folded.exitedFolded, 1);
      expect(folded.deskCount, 1, reason: '접힌 책상은 자리를 비운다');
      // 펼치면 다시 보인다(앱 로컬).
      final expanded = build(updatedAt: '2026-09-17T11:40:00Z', at: now, expanded: {'t0'});
      expect(expanded.exitedFolded, 0);
      expect(expanded.deskCount, 2);
      expect(exitFoldAfter, const Duration(minutes: 10));
    });

    testWidgets('클러스터 제목 클릭 = "퇴근 N" 펼치기 토글', (tester) async {
      await pumpHarness(tester, FakeOfficeNotifier(office(exitedAt: '2020-01-01T00:00:00Z')));
      var painter = painterOf(tester);
      expect(painter.scene.plan.clusters.single.exitedFolded, 1);
      expect(painter.scene.members.map((m) => m.id), ['mH', 'mL']);

      final layout = painter.lastLayout!;
      final origin = tester.getTopLeft(find.byType(OfficeView));
      final title = layout.clusters.single.rect.topLeft + Offset(10, layout.clusterTitleHeight / 2);
      await tester.tapAt(origin + title);
      await tester.pump();
      painter = painterOf(tester);
      expect(painter.scene.plan.clusters.single.exitedFolded, 0);
      expect(painter.scene.members.map((m) => m.id), ['mH', 'mL', 'm1']);

      await tester.tapAt(origin + title);
      await tester.pump();
      expect(painterOf(tester).scene.plan.clusters.single.exitedFolded, 1);
    });

    test('전원 퇴근 팀은 제목만 남은 낮은 상자 "팀 X · 전원 퇴근 · 보고 N건"', () {
      final scene = OfficeScene.build(
        members: {
          'mH': head('mH', name: '부장', createdAt: '0'),
          'mL': exitedMember('mL', updatedAt: '2026-09-17T11:00:00Z', name: '반장', createdAt: '1'),
          'm1': exitedMember('m1', updatedAt: '2026-09-17T11:00:00Z'),
        },
        latestEvents: const {},
        pending: const {},
        teams: {'t0': team('t0', name: 't0', createdAt: '0')},
        reportCounts: const {'t0': 3},
      );
      final c = scene.plan.clusters.single;
      expect(c.allExited, isTrue);
      expect(c.deskCount, 0);
      expect(c.title, '팀 t0 · 전원 퇴근 · 보고 3건');
      expect(scene.members.map((m) => m.id), ['mH'], reason: '전원 퇴근 팀은 책상을 남기지 않는다');

      final l = OfficeLayout(size: const Size(1000, 700), plan: scene.plan);
      expect(l.clusters.single.rect.height, closeTo(l.clusterTitleHeight + OfficeLayout.baseLowBoxPad * l.scale, 0.01));
      expect(l.clusters.single.allExited, isTrue);
    });

    testWidgets('보고 건수는 이벤트의 reporting 을 팀별로 센다', (tester) async {
      // 픽스처의 event() 는 teamId 't1' 로 온다 — 팀도 t1 로 맞춘다.
      final state = OfficeState(
        members: {
          'mH': head('mH', name: '부장', createdAt: '0'),
          'mL': exitedMember('mL', updatedAt: '2020-01-01T00:00:00Z', name: '반장', teamId: 't1', createdAt: '1'),
        },
        teams: {'t1': team('t1', name: 't1', createdAt: '0')},
        events: [
          event('mL', OfficeEventKind.reporting, seq: 1),
          event('mL', OfficeEventKind.reporting, seq: 2),
          event('mL', OfficeEventKind.idle, seq: 3),
        ],
      );
      await pumpHarness(tester, FakeOfficeNotifier(state));
      expect(painterOf(tester).scene.plan.clusters.single.title, '팀 t1 · 전원 퇴근 · 보고 2건');
    });
  });
}
