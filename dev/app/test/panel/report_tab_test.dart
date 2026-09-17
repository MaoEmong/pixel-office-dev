// 보고서 탭(T18): reporting + 직전 text → task 보고(지시문 포함), 남는 text → 보고(작업 없음), 최신 먼저,
// 지시문 출처(열린 task 전문 > thinking [TASK#] 절단본), parseTaskPrompt.
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/panel/report_tab.dart';
import 'package:pixel_office/state/office_state.dart';

import 'panel_harness.dart';

void main() {
  late PanelFakeDaemon daemon;

  setUp(() async => daemon = await startDaemon());
  tearDown(() => daemon.stop());

  test('parseTaskPrompt: [TASK#N from user]\\n<지시>', () {
    final p = parseTaskPrompt('[TASK#12 from user]\n테스트를 고쳐줘\n둘째 줄');
    expect(p, isNotNull);
    expect(p!.taskId, 12);
    expect(p.from, 'user');
    expect(p.instruction, '테스트를 고쳐줘\n둘째 줄');
    expect(parseTaskPrompt('[RESUMED] 데몬이 재시작됐다'), isNull);
    expect(parseTaskPrompt('[ANSWER q#3]\n예'), isNull);
    expect(parseTaskPrompt('[TASK#7 from m1(팀장)]\r\n리뷰')!.instruction, '리뷰');
  });

  testWidgets('reporting(ref.taskId) + 직전 text → task#N 카드(지시문·본문), 그 text 는 "작업 없음" 으로 중복되지 않는다', (tester) async {
    daemon.handlers['events.query'] = (_) => {
          'events': [
            ev(4, kind: 'text', detail: {'text': '터미널에서 직접 나눈 대화의 답'}),
            ev(20, kind: 'thinking', detail: {'text': '[TASK#7 from user]\n테스트를 고쳐줘'}),
            ev(21, kind: 'reading', detail: {'tool': 'Read', 'path': 'lib/a.dart'}),
            ev(22, kind: 'text', detail: {'text': '고쳤습니다.\n3개 테스트가 통과합니다.'}),
            ev(23, kind: 'idle', detail: {}),
            {...ev(24, kind: 'reporting', detail: {'summary': '고쳤습니다.\n3개 테스트가 통과합니다.'}), 'ref': {'taskId': 7}},
          ],
        };
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const ReportTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.byType(ReportCard).evaluate().length == 2, reason: 'two reports');
      final cards = tester.widgetList<ReportCard>(find.byType(ReportCard)).map((w) => w.report).toList();
      // 최신 먼저: task#7(seq 24) 그 다음 작업 없음(seq 4)
      expect(cards.map((r) => r.seq), [24, 4]);
      expect(cards[0].taskId, 7);
      expect(cards[0].instruction, '테스트를 고쳐줘');
      expect(cards[0].body, '고쳤습니다.\n3개 테스트가 통과합니다.');
      expect(cards[1].taskId, isNull);
      expect(find.textContaining('task#7 · done'), findsOneWidget); // 헤더 줄(T40-4 문서 흐름)
      expect(find.text('지시: 테스트를 고쳐줘'), findsOneWidget);
      expect(find.textContaining('3개 테스트가 통과합니다'), findsOneWidget);
      expect(find.textContaining('· 작업 없음'), findsOneWidget);
      expect(find.textContaining('터미널에서 직접 나눈'), findsOneWidget);

      // 라이브로 다음 턴이 끝나면 위에 쌓인다. resumed(본문 없는 text) 는 카드가 되지 않는다.
      daemon.emitEvent(ev(30, kind: 'text', detail: {'summary': 'resumed'}));
      daemon.emitEvent(ev(31, kind: 'thinking', detail: {'text': '[TASK#8 from user]\n문서도 고쳐줘'}));
      daemon.emitEvent(ev(32, kind: 'text', detail: {'text': '문서 갱신 완료'}));
      daemon.emitEvent({...ev(33, kind: 'reporting', detail: {'summary': '문서 갱신 완료'}), 'ref': {'taskId': 8}});
      // 카드 수(3)로 기다리면 안 된다 — text(32) 만 와도 "작업 없음" 카드로 3장이 되어,
      // reporting(33) 이 그 카드를 task#8 로 합치기 전에 조건이 참이 된다(간헐 실패 [32, 24, 4]).
      // 33 이 들어와야만 생기는 것(task#8 제목)으로 기다린다.
      await pumpUntil(tester, () => find.textContaining('task#8 · done').evaluate().isNotEmpty, reason: 'task#8 report');
      final seqs = tester.widgetList<ReportCard>(find.byType(ReportCard)).map((w) => w.report.seq).toList();
      expect(seqs, [33, 24, 4]);
      expect(find.textContaining('task#8 · done'), findsOneWidget);
      expect(find.text('지시: 문서도 고쳐줘'), findsOneWidget);
    });
  });

  testWidgets('지시문: 열린 task(스냅샷 전문)가 thinking 절단본보다 우선; reporting 에 text 가 없으면 summary 를 본문으로', (tester) async {
    final long = List.filled(60, '아주 긴 지시').join(' ');
    daemon.snapshotBody['tasks'] = [
      {
        'id': 9,
        'teamId': 't1',
        'fromMember': 'user',
        'toMember': 'm1',
        'instruction': long,
        'status': 'assigned',
        'reportText': null,
        'reportStatus': null,
        'createdAt': 'c',
        'updatedAt': 'u',
      },
    ];
    daemon.handlers['events.query'] = (_) => {
          'events': [
            ev(40, kind: 'thinking', detail: {'text': '[TASK#9 from user]\n${long.substring(0, 150)}'}),
          ],
        };
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const ReportTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => c.read(taskInstructionsProvider('m1')).containsKey(9), reason: 'instruction known');
      expect(c.read(taskInstructionsProvider('m1'))[9], long); // 전문
      expect(find.text('아직 보고 없음 — 부장이 보고하면 여기에'), findsOneWidget);

      // text 없이 reporting 만(예: 마지막 메시지가 없던 턴) → summary 가 본문
      daemon.emitEvent({...ev(41, kind: 'reporting', detail: {'summary': 'task#9 done'}), 'ref': {'taskId': 9}});
      await pumpUntil(tester, () => find.byType(ReportCard).evaluate().length == 1, reason: 'report');
      final r = tester.widget<ReportCard>(find.byType(ReportCard)).report;
      expect(r.taskId, 9);
      expect(r.body, isNull);
      expect(r.text, 'task#9 done');
      // reporting 이 오면 상태 층이 task 를 지우지만(openTasks) 지시문은 thinking 절단본으로 남는다
      await pumpUntil(tester, () => !c.read(openTasksProvider).containsKey(9));
      expect(c.read(memberReportsProvider('m1')).single.instruction, startsWith('아주 긴 지시'));
    });
  });
}
