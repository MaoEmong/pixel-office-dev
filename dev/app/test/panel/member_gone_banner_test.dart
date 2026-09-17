// 퇴근/오류 배너(T18): exited → "퇴근함" + 재고용 → member.rehire, status 가 돌아오면 배너 내려감;
// error → "⚠ 오류로 종료됨 (code N)" + resume failed 줄; -32003 사유; RecoveryHint(재시작 만료 N건).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/panel/inbox.dart' show inboxMoreLabel;
import 'package:pixel_office/panel/right_panel.dart' hide inboxMoreLabel;

import 'panel_harness.dart';

void main() {
  late PanelFakeDaemon daemon;

  setUp(() async => daemon = await startDaemon());
  tearDown(() => daemon.stop());

  testWidgets('exited 멤버: "퇴근함" + 재고용 → member.rehire{memberId}; member.status 로 살아나면 배너가 사라진다', (tester) async {
    daemon.snapshotBody['members'] = [memberJson('m1', status: 'exited', name: '하루')];
    daemon.handlers['member.rehire'] = (p) => {'member': memberJson(p['memberId'] as String, status: 'starting', name: '하루')};
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.byKey(const Key('panel.goneBanner')).evaluate().isNotEmpty, reason: 'banner');
      expect(find.text('퇴근함'), findsOneWidget);
      expect(find.text('재고용'), findsOneWidget);
      // 배너는 헤더 바로 아래
      expect(tester.getTopLeft(find.byKey(const Key('panel.goneBanner'))).dy, greaterThanOrEqualTo(tester.getBottomLeft(find.byType(PanelHeader)).dy - 1));

      await tester.tap(find.byKey(const Key('panel.rehire')));
      await pumpUntil(tester, () => daemon.countOf('member.rehire') == 1, reason: 'rehire sent');
      expect(daemon.paramsOf('member.rehire').single, {'memberId': 'm1'});

      daemon.push('member.status', {'memberId': 'm1', 'status': 'starting', 'derived': 'starting'});
      await pumpUntil(tester, () => find.byKey(const Key('panel.goneBanner')).evaluate().isEmpty, reason: 'banner gone');
      expect(find.text('출근 중'), findsOneWidget);
    });
  });

  testWidgets('error 멤버: "⚠ 오류로 종료됨 (code N)" + resume failed 줄; 재고용 -32003 → 사유', (tester) async {
    daemon.snapshotBody['members'] = [memberJson('m1', status: 'error', name: '하루')];
    daemon.handlers['events.query'] = (_) => {
          'events': [
            ev(3, kind: 'idle', detail: {}), // 이전 턴 경계 — 그 앞의 오류는 세지 않는다
            ev(4, kind: 'error', detail: {'summary': 'process exited (code 9)', 'exitCode': 9}),
            ev(5, kind: 'idle', detail: {}),
            ev(6, kind: 'error', detail: {'summary': 'resume failed; started fresh session', 'exitCode': 1, 'sessionId': 's1'}),
            ev(7, kind: 'error', detail: {'summary': 'process exited (code 1)', 'exitCode': 1}),
          ],
        };
    daemon.handlers['member.rehire'] = (_) => throw const FakeRpcError(-32003, 'member still running');
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.text('⚠ 오류로 종료됨 (code 1)').evaluate().isNotEmpty, reason: 'error banner with code');
      final banner = find.byKey(const Key('panel.goneBanner'));
      expect(find.descendant(of: banner, matching: find.text('resume failed; started fresh session')), findsOneWidget);
      expect(find.descendant(of: banner, matching: find.textContaining('code 9')), findsNothing);

      await tester.tap(find.byKey(const Key('panel.rehire')));
      await pumpUntil(tester, () => find.byKey(const Key('panel.rehire.error')).evaluate().isNotEmpty, reason: 'reason shown');
      expect(find.text('재고용 실패: member still running'), findsOneWidget);
      expect(find.byKey(const Key('panel.goneBanner')), findsOneWidget);
      // 다시 누를 수 있다
      expect(tester.widget<FilledButton>(find.byKey(const Key('panel.rehire'))).onPressed, isNotNull);
    });
  });

  testWidgets('살아 있는 멤버는 배너 없음; RecoveryHint: 재시작 만료 N건 → 턴이 끝나면 사라짐', (tester) async {
    daemon.handlers['events.query'] = (_) => {
          'events': [
            {...ev(11, kind: 'error', detail: {'summary': '재지시 필요: 허가 요청이 재시작으로 만료됨', 'pendingId': 'a1', 'pendingType': 'approval'})},
            {...ev(12, kind: 'error', detail: {'summary': '재지시 필요: 질문이 재시작으로 만료됨', 'pendingId': 'q2', 'pendingType': 'question'})},
            {...ev(13, kind: 'error', detail: {'summary': 'hook hold timed out; answer in terminal', 'pendingId': 'a3'})}, // 재시작 아님 — 안 셈
            ev(14, kind: 'text', detail: {'summary': 'resumed'}),
          ],
        };
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      expect(find.byKey(const Key('panel.goneBanner')), findsNothing);
      await pumpUntil(tester, () => find.text('데몬이 재시작됐어요 — 만료된 요청 2건').evaluate().isNotEmpty, reason: 'hint');
      // T40-4: 만료 카드는 인박스 안 — 2장까지 펼치고 나머지는 "+N" 으로 접힌다(D6).
      expect(find.byType(RedoCard), findsNWidgets(2));
      expect(find.text(inboxMoreLabel(1)), findsOneWidget);
      await tester.ensureVisible(find.byKey(const Key('inbox.more')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('inbox.more')));
      await tester.pump();
      expect(find.byType(RedoCard), findsNWidgets(3));
      daemon.emitEvent(ev(20, kind: 'text', detail: {'text': '점검 끝, 이어서 진행합니다'}));
      await pumpUntil(tester, () => find.byKey(const Key('panel.recoveryHint')).evaluate().isEmpty, reason: 'hint gone');
      expect(find.byType(RedoCard), findsNothing);
    });
  });
}
