// 상태 13종 → 범례 7칸 매핑(D-42 3)과 패널 헤더 상태 점(T40-4).
//
// T40c: 매핑 사본(`panel/labels.dart` 의 `LegendCategory`/`legendCategory`)을 지우고
// 사무실 쪽 단일 소스(`office/office_scene.dart` 의 `legendSlotFor` + `office_painter.dart` 의 `legendColor`)로
// 합쳤다. 이 파일은 **패널이 그 단일 소스를 쓰는지**를 본다(매핑 자체의 전 분기는
// `test/office/office_legend_test.dart` 가 `legendSlotOf` 로 이미 덮는다).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_painter.dart' show legendColor;
import 'package:pixel_office/office/office_scene.dart' show LegendSlot, legendSlotFor;
import 'package:pixel_office/panel/right_panel.dart';

import 'panel_harness.dart';

void main() {
  late PanelFakeDaemon daemon;

  setUp(() async => daemon = await startDaemon());
  tearDown(() => daemon.stop());

  group('legendSlotFor — 7칸(패널이 쓰는 이름 있는 인자 형태)', () {
    test('퇴근·오류가 가장 먼저', () {
      expect(legendSlotFor(status: MemberStatus.exited), LegendSlot.exited);
      expect(legendSlotFor(status: MemberStatus.error), LegendSlot.error);
      expect(legendSlotFor(status: MemberStatus.exited, derived: DerivedStatus.waitingApproval), LegendSlot.exited);
    });

    test('내 차례(주황 ❗) = 허가 대기 · 사용자 질문', () {
      expect(legendSlotFor(status: MemberStatus.waitingApproval), LegendSlot.myTurn);
      expect(legendSlotFor(status: MemberStatus.idle, derived: DerivedStatus.waitingAnswer), LegendSlot.myTurn);
      expect(LegendSlot.myTurn.icon, '❗');
      expect(legendColor(LegendSlot.myTurn), const Color(0xFFFF9F43));
    });

    test('대기(노랑 ◷) = 상사 답 기다림 · 셸 락 · 출근 중', () {
      expect(legendSlotFor(status: MemberStatus.waitingAnswer, askingParent: true), LegendSlot.waiting);
      expect(legendSlotFor(status: MemberStatus.working, shellWaiting: true), LegendSlot.waiting);
      expect(legendSlotFor(status: MemberStatus.starting), LegendSlot.waiting);
      expect(LegendSlot.waiting.icon, '◷');
    });

    test('보고 대기는 초록 점선 링 + ✉, 한가는 초록 실선', () {
      expect(legendSlotFor(status: MemberStatus.idle, derived: DerivedStatus.waitingReports), LegendSlot.waitingReports);
      expect(LegendSlot.waitingReports.dashedRing, isTrue);
      expect(legendSlotFor(status: MemberStatus.idle, derived: DerivedStatus.free), LegendSlot.idle);
      expect(legendSlotFor(status: MemberStatus.idle), LegendSlot.idle);
      expect(LegendSlot.idle.dashedRing, isFalse);
      // 색이 같으므로(#7ED3A1) 점선 여부가 유일한 구분이다.
      expect(legendColor(LegendSlot.waitingReports), legendColor(LegendSlot.idle));
    });

    test('나머지는 작업', () {
      expect(legendSlotFor(status: MemberStatus.working), LegendSlot.working);
      expect(legendSlotFor(status: MemberStatus.working, derived: DerivedStatus.working), LegendSlot.working);
      expect(legendSlotFor(status: MemberStatus.idle, eventKind: OfficeEventKind.delegating), LegendSlot.working);
    });

    test('7칸이 전부, 라벨은 서로 다르고 색약 대응 아이콘이 4칸에 있다', () {
      expect(LegendSlot.values.length, 7);
      expect(LegendSlot.values.map((c) => c.label).toSet().length, 7);
      expect(LegendSlot.values.where((c) => c.icon.isNotEmpty).length, 4);
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
        legendColor(LegendSlot.myTurn),
      );

      // 보고 대기로 바뀌면 초록 점선(원 외곽선).
      daemon.push('member.status', {'memberId': 'm1', 'status': 'idle', 'derived': 'waiting_reports'});
      await pumpUntil(
        tester,
        () =>
            find.byKey(const Key('panel.statusDot')).evaluate().isNotEmpty &&
            tester.widget<Icon>(find.byKey(const Key('panel.statusDot'))).color ==
                legendColor(LegendSlot.waitingReports),
        reason: 'waiting_reports dot',
      );
      expect(tester.widget<Icon>(find.byKey(const Key('panel.statusDot'))).icon, Icons.circle_outlined);
    });
  });
}
