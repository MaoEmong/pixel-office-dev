// 보고서 탭 문서 흐름(T40-4, 패스 4 하드리젝션 ①) + 미확인 배지(이슈 9).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/panel/report_tab.dart';
import 'package:pixel_office/panel/right_panel.dart';

import 'panel_harness.dart';

void main() {
  late PanelFakeDaemon daemon;

  setUp(() async => daemon = await startDaemon());
  tearDown(() => daemon.stop());

  group('순수 함수', () {
    test('헤더 줄 `보고 · 이름 · HH:MM · task#N · status`', () {
      final line = reportHeaderLine(name: '부장', ts: '2026-09-16T23:08:00.000Z', taskId: 12, status: 'done');
      expect(line, startsWith('보고 · 부장 · '));
      expect(line, endsWith('· task#12 · done'));
      expect(reportHeaderLine(name: '하루', ts: '2026-09-16T23:08:00.000Z'), contains('· $reportNoTaskLabel'));
    });

    test('본문 쪼개기: 코드·경로 줄만 고정폭', () {
      final spans = splitReportBody('고쳤습니다.\n  final x = 1;\n다시 문단');
      expect(spans.length, 3);
      expect(spans[0].mono, isFalse);
      expect(spans[1].mono, isTrue); // 두 칸 들여쓰기 = 코드
      expect(spans[2].mono, isFalse);
      expect(isMonoLine(r'D:\proj\lib\main.dart'), isTrue);
      expect(isMonoLine(r'$ flutter test'), isTrue);
      expect(isMonoLine('평범한 문장입니다'), isFalse);
    });

    test('코드 펜스는 고정폭 덩어리로 묶인다', () {
      final spans = splitReportBody('설명\n```\na\nb\n```\n끝');
      expect(spans.map((s) => s.mono), [false, true, false]);
      expect(spans[1].text, 'a\nb');
    });

    test('날짜 라벨', () {
      expect(reportDateLabel('2026-09-16T23:08:00.000Z'), matches(r'^\d{4}-\d{2}-\d{2}$'));
      expect(reportDateLabel('망가짐'), '망가짐');
    });
  });

  testWidgets('문서 흐름: 헤더 줄 + 본문, 6줄 넘으면 "펼치기", 날짜 구분선', (tester) async {
    final body = List.generate(10, (i) => '줄 $i').join('\n');
    daemon.handlers['events.query'] = (_) => {
          'events': [
            ev(4, kind: 'text', detail: {'text': '어제 보고'}, ),
            ev(10, kind: 'text', detail: {'text': body}),
          ],
        };
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const ReportTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.byType(ReportCard).evaluate().length == 2, reason: 'reports');
      // 헤더 줄에 멤버 이름이 들어간다.
      expect(find.textContaining('보고 · 하루 ·'), findsNWidgets(2));
      // 6줄 클램프 + 펼치기
      expect(find.text(reportExpandLabel), findsOneWidget);
      expect(find.textContaining('줄 9'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('report-expand-10')));
      await tester.pump();
      expect(find.textContaining('줄 9'), findsOneWidget);
      expect(find.text('접기'), findsOneWidget);
      // 날짜 구분선(같은 날이면 하나)
      expect(find.textContaining(RegExp(r'^\d{4}-\d{2}-\d{2}$')), findsWidgets);
    });
  });

  testWidgets('`[TASK]` 지시는 틴트 블록으로, 왼쪽 세로선은 없다', (tester) async {
    daemon.handlers['events.query'] = (_) => {
          'events': [
            ev(20, kind: 'thinking', detail: {'text': '[TASK#7 from user]\n테스트를 고쳐줘'}),
            ev(22, kind: 'text', detail: {'text': '고쳤습니다.'}),
            {...ev(24, kind: 'reporting', detail: {'summary': '고쳤습니다.'}), 'ref': {'taskId': 7}},
          ],
        };
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const ReportTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.text('지시: 테스트를 고쳐줘').evaluate().isNotEmpty, reason: 'instruction block');
      final box = tester.widget<Container>(
        find.ancestor(of: find.text('지시: 테스트를 고쳐줘'), matching: find.byType(Container)).first,
      );
      final deco = box.decoration! as BoxDecoration;
      expect(deco.color, isNotNull); // 배경 틴트
      expect(deco.border, isNull); // 테두리·왼쪽 선 없음
    });
  });

  testWidgets('미확인 배지: 보고가 오면 탭 라벨에 수, 보고서 탭을 열면 지워진다', (tester) async {
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      expect(find.byKey(const Key('panel.reportBadge')), findsNothing);

      daemon.emitEvent({...ev(30, kind: 'reporting', detail: {'summary': '끝'}), 'ref': {'taskId': 1}});
      daemon.emitEvent({...ev(31, kind: 'reporting', detail: {'summary': '또 끝'}), 'ref': {'taskId': 2}});
      await pumpUntil(tester, () => c.read(reportUnreadProvider('m1')) == 2, reason: 'two unread');
      await tester.pump();
      expect(find.byKey(const Key('panel.reportBadge')), findsOneWidget);
      expect(find.text('2'), findsOneWidget);

      // 다른 멤버 보고는 이 멤버 배지를 올리지 않는다
      daemon.emitEvent({...ev(32, memberId: 'm2', kind: 'reporting', detail: {'summary': 'x'}), 'ref': {'taskId': 3}});
      await pumpUntil(tester, () => c.read(reportUnreadProvider('m2')) == 1);
      expect(c.read(reportUnreadProvider('m1')), 2);

      await tester.tap(find.text('보고서'));
      await tester.pumpAndSettle();
      await pumpUntil(tester, () => c.read(reportUnreadProvider('m1')) == 0, reason: 'read on open');
      expect(find.byKey(const Key('panel.reportBadge')), findsNothing);
    });
  });
}
