// 상태 13종 → 범례 7칸 매핑(D-42 3)과 패널 헤더 상태 점(T40-4).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/panel/labels.dart';
import 'package:pixel_office/panel/right_panel.dart' hide LegendCategory, legendCategory;

import 'panel_harness.dart';

void main() {
  late PanelFakeDaemon daemon;

  setUp(() async => daemon = await startDaemon());
  tearDown(() => daemon.stop());

  group('legendCategory — 7칸', () {
    test('퇴근·오류가 가장 먼저', () {
      expect(legendCategory(MemberStatus.exited), LegendCategory.gone);
      expect(legendCategory(MemberStatus.error), LegendCategory.error);
      expect(legendCategory(MemberStatus.exited, derived: DerivedStatus.waitingApproval), LegendCategory.gone);
    });

    test('내 차례(주황 ❗) = 허가 대기 · 사용자 질문', () {
      expect(legendCategory(MemberStatus.waitingApproval), LegendCategory.myTurn);
      expect(legendCategory(MemberStatus.idle, derived: DerivedStatus.waitingAnswer), LegendCategory.myTurn);
      expect(LegendCategory.myTurn.icon, '❗');
      expect(LegendCategory.myTurn.color, const Color(0xFFFF9F43));
    });

    test('대기(노랑 ⏳) = 상사 답 기다림 · 셸 락 · 출근 중', () {
      expect(legendCategory(MemberStatus.waitingAnswer, askingParent: true), LegendCategory.waiting);
      expect(legendCategory(MemberStatus.working, shellLock: true), LegendCategory.waiting);
      expect(legendCategory(MemberStatus.starting), LegendCategory.waiting);
      expect(LegendCategory.waiting.icon, '⏳');
    });

    test('보고 대기는 초록 점선 링 + 📨, 한가는 초록 실선', () {
      expect(legendCategory(MemberStatus.idle, derived: DerivedStatus.waitingReports), LegendCategory.waitingReports);
      expect(LegendCategory.waitingReports.dashedRing, isTrue);
      expect(legendCategory(MemberStatus.idle, derived: DerivedStatus.free), LegendCategory.free);
      expect(legendCategory(MemberStatus.idle), LegendCategory.free);
      expect(LegendCategory.free.dashedRing, isFalse);
    });

    test('나머지는 작업', () {
      expect(legendCategory(MemberStatus.working), LegendCategory.working);
      expect(legendCategory(MemberStatus.working, derived: DerivedStatus.working), LegendCategory.working);
    });

    test('7칸이 전부, 색은 서로 다르고 색약 대응 아이콘이 4칸에 있다', () {
      expect(LegendCategory.values.length, 7);
      expect(LegendCategory.values.map((c) => c.label).toSet().length, 7);
      expect(LegendCategory.values.where((c) => c.icon != null).length, 4);
    });
  });

  testWidgets('패널 헤더 상태 점이 범례 색을 쓴다', (tester) async {
    daemon.snapshotBody['members'] = [memberJson('m1', status: 'waiting_approval', name: '하루')];
    final overrides = panelOverrides(daemon);
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'), overrides: overrides);
      await pumpUntilConnected(tester, c);
      await tester.pump();
      expect(
        tester.widget<Icon>(find.byKey(const Key('panel.statusDot'))).color,
        LegendCategory.myTurn.color,
      );

      // 보고 대기로 바뀌면 초록 점선(원 외곽선).
      daemon.push('member.status', {'memberId': 'm1', 'status': 'idle', 'derived': 'waiting_reports'});
      await pumpUntil(
        tester,
        () =>
            find.byKey(const Key('panel.statusDot')).evaluate().isNotEmpty &&
            tester.widget<Icon>(find.byKey(const Key('panel.statusDot'))).color == LegendCategory.waitingReports.color,
        reason: 'waiting_reports dot',
      );
      expect(tester.widget<Icon>(find.byKey(const Key('panel.statusDot'))).icon, Icons.circle_outlined);
    });
  });
}
