// T46-2 · 수명주기 §5: `suspended`(잠시 닫힘) 상태.
//   회색(범례 "퇴근" 칸) + 모니터 `(잠시 닫힘)` · 자리에 사람 없음 · **재고용 배너 없음** ·
//   맡은 task 를 중단하지 않는다(퇴근/오류와 구분).
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_scene.dart';
import 'package:pixel_office/office/office_sprites.dart';
import 'package:pixel_office/panel/labels.dart';
import 'package:pixel_office/panel/member_gone_banner.dart';
import 'package:pixel_office/state/office_state.dart';

import 'office_fixtures.dart';
import 'office_harness.dart';

void main() {
  group('모델', () {
    test('와이어 `suspended` 를 읽고 쓴다', () {
      expect(MemberStatus.parse('suspended'), MemberStatus.suspended);
      expect(MemberStatus.suspended.wire, 'suspended');
      expect(DerivedStatus.parse('suspended'), DerivedStatus.suspended);
    });

    test('isGone 이 아니다 — 퇴근·오류와 구분(재고용 대상이 아니다)', () {
      expect(MemberStatus.suspended.isGone, isFalse);
      expect(MemberStatus.suspended.isWaiting, isFalse);
      expect(MemberStatus.exited.isGone, isTrue);
      expect(MemberStatus.error.isGone, isTrue);
    });

    test('isSeatEmpty 는 퇴근 · 잠시 닫힘 둘 다 — 오류는 아니다(캐릭터가 붉은 링으로 남는다)', () {
      expect(MemberStatus.suspended.isSeatEmpty, isTrue);
      expect(MemberStatus.exited.isSeatEmpty, isTrue);
      expect(MemberStatus.error.isSeatEmpty, isFalse);
      expect(MemberStatus.idle.isSeatEmpty, isFalse);
    });

    test('스냅샷 멤버 행의 status/derived 로 파싱된다', () {
      final m = Member.fromJson({
        'id': 'm1',
        'departmentId': 'd1',
        'teamId': 't1',
        'parentId': null,
        'name': '이음',
        'rank': 'member',
        'engine': 'claude',
        'sessionId': 's',
        'childPid': null,
        'cwd': 'D:/x',
        'status': 'suspended',
        'hiredBy': 'user',
        'memberToken': 'mt',
        'instructionsPath': null,
        'createdAt': 'c',
        'updatedAt': 'u',
        'derived': 'suspended',
      });
      expect(m.status, MemberStatus.suspended);
      expect(m.derived, DerivedStatus.suspended);
    });

    test('DerivedStatus.fromStatus 가 suspended 에서 안 터진다', () {
      expect(
        DerivedStatus.fromStatus(MemberStatus.suspended, hasAssignedTask: true),
        DerivedStatus.suspended,
      );
    });
  });

  group('범례 · 문구', () {
    test('범례는 회색 "퇴근" 칸', () {
      expect(legendSlotFor(status: MemberStatus.suspended), LegendSlot.exited);
      expect(LegendSlot.exited.label, '퇴근');
    });

    test('모니터는 `(잠시 닫힘)` — 이벤트가 있어도 이것이 앞선다', () {
      expect(suspendedSummary, '(잠시 닫힘)');
      expect(summarize(MemberStatus.suspended, null), suspendedSummary);
      final ev = event('m1', OfficeEventKind.editing, detail: {'path': 'a.dart'});
      expect(summarize(MemberStatus.suspended, ev), suspendedSummary);
    });

    test('말풍선 alert 가 아니다(답할 것이 없다)', () {
      expect(isAlertFor(MemberStatus.suspended, null), isFalse);
    });

    test('패널 라벨은 "잠시 닫힘", 색은 퇴근과 같은 회색', () {
      expect(memberStatusLabel(MemberStatus.suspended), '잠시 닫힘');
      expect(suspendedStatusLabel, '잠시 닫힘');
      expect(memberStatusColor(MemberStatus.suspended), memberStatusColor(MemberStatus.exited));
      expect(derivedStatusLabel(DerivedStatus.suspended), '잠시 닫힘');
    });

    test('포즈는 gone(의자만) — 오류 포즈가 아니다', () {
      expect(spritePoseFor(slot: legendSlotFor(status: MemberStatus.suspended)), SpritePose.gone);
    });
  });

  group('사무실 캔버스', () {
    testWidgets('의자만 남기고 모니터에 `(잠시 닫힘)` 을 쓴다', (tester) async {
      final notifier = FakeOfficeNotifier(OfficeState(
        departments: {'d1': department('d1')},
        teams: {'t1': team('t1')},
        members: {
          'mH': head('mH', name: '부장'),
          'm1': member('m1', name: '이음', status: MemberStatus.suspended, parentId: 'mH'),
        },
      ));
      await pumpHarness(tester, notifier, departmentId: 'd1');
      final painter = painterOf(tester);
      final m = painter.scene.members.firstWhere((s) => s.id == 'm1');
      expect(m.legendSlot, LegendSlot.exited);
      expect(m.summary, suspendedSummary);
      expect(m.isSeatEmpty, isTrue);
      expect(painter.showsBubble(m), isFalse);
    });

    testWidgets('"전원 퇴근" 상자로 접지 않는다 — 잠시 닫힘은 퇴근이 아니다', (tester) async {
      final notifier = FakeOfficeNotifier(OfficeState(
        departments: {'d1': department('d1')},
        teams: {'t1': team('t1')},
        members: {
          'mH': head('mH', name: '부장'),
          'm1': member('m1', status: MemberStatus.suspended, parentId: 'mH'),
        },
      ));
      await pumpHarness(tester, notifier, departmentId: 'd1');
      final plan = painterOf(tester).scene.plan;
      final cluster = plan.clusters.firstWhere((c) => c.teamId == 't1');
      expect(cluster.allExited, isFalse);
      expect(cluster.deskCount, 1);
    });
  });

  group('패널', () {
    testWidgets('재고용 배너를 띄우지 않는다(오류가 아니다)', (tester) async {
      final m = member('m1', status: MemberStatus.suspended);
      await tester.pumpWidget(ProviderScope(
        child: MaterialApp(home: Scaffold(body: MemberGoneBanner(member: m))),
      ));
      expect(find.byKey(const Key('panel.goneBanner')), findsNothing);
    });

    testWidgets('퇴근이면 배너가 뜬다(대조군)', (tester) async {
      final m = member('m1', status: MemberStatus.exited);
      await tester.pumpWidget(ProviderScope(
        child: MaterialApp(home: Scaffold(body: MemberGoneBanner(member: m))),
      ));
      expect(find.byKey(const Key('panel.goneBanner')), findsOneWidget);
    });
  });
}
