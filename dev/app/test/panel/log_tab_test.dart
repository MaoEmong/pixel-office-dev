// 로그 탭: 라이브 이벤트 행(한국어 kind 라벨·상세), events.query 백필(seq 중복 제거·오름차순), 재접속 시 재백필.
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/panel/log_tab.dart';
import 'package:pixel_office/panel/member_log.dart';
import 'package:pixel_office/state/office_state.dart';
import 'package:pixel_office/rpc/rpc_client.dart';

import 'panel_harness.dart';

void main() {
  late PanelFakeDaemon daemon;

  setUp(() async => daemon = await startDaemon());
  tearDown(() => daemon.stop());

  testWidgets('라이브 이벤트 3건 → 행 3개, 한국어 라벨과 상세(tool + path/cmd)', (tester) async {
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const LogTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      expect(find.text('아직 이벤트 없음'), findsOneWidget);

      daemon.emitEvent(ev(11, kind: 'reading', detail: {'tool': 'Read', 'path': 'lib/main.dart'}));
      daemon.emitEvent(ev(12, kind: 'running', detail: {'tool': 'Bash', 'cmd': 'flutter test', 'summary': '테스트 실행'}));
      daemon.emitEvent(ev(13, kind: 'waiting_approval', detail: {'tool': 'Bash', 'cmd': 'rm -rf build'}));
      daemon.emitEvent(ev(14, memberId: 'm2', kind: 'asking', detail: {'summary': '다른 멤버'})); // m2 → 안 보임
      await pumpUntil(tester, () => find.byType(LogRow).evaluate().length == 3, reason: '3 rows');

      expect(find.text('읽는 중'), findsOneWidget);
      expect(find.text('실행'), findsOneWidget);
      expect(find.text('허가 대기'), findsOneWidget);
      expect(find.text('질문'), findsNothing);
      expect(find.text('Read lib/main.dart'), findsOneWidget);
      expect(find.text('Bash flutter test — 테스트 실행'), findsOneWidget);
      expect(find.text('Bash rm -rf build'), findsOneWidget);
      // 시각 HH:MM (ts 00:00:11Z → 로컬 시각) — 행마다 하나
      final rows = tester.widgetList<LogRow>(find.byType(LogRow)).map((r) => r.event.seq).toList();
      expect(rows, [11, 12, 13]); // 최신이 아래
    });
  });

  testWidgets('백필: 탭이 뜨면 events.query{memberId, limit:200} → 과거와 라이브를 seq 로 합쳐 중복 없이 오름차순', (tester) async {
    daemon.handlers['events.query'] = (p) => {
          'events': [
            ev(3, kind: 'thinking', detail: {'text': '[TASK#1 from user] 시작'}),
            ev(5, kind: 'editing', detail: {'tool': 'Edit', 'path': 'a.dart'}),
            ev(11, kind: 'reading', detail: {'tool': 'Read', 'path': 'lib/main.dart'}), // 라이브와 겹침
          ],
        };
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const LogTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      daemon.emitEvent(ev(11, kind: 'reading', detail: {'tool': 'Read', 'path': 'lib/main.dart'}));
      daemon.emitEvent(ev(12, kind: 'idle', detail: {'summary': 'done'}));
      await pumpUntil(tester, () => find.byType(LogRow).evaluate().length == 4, reason: '4 rows (3,5,11,12)');

      final q = daemon.paramsOf('events.query');
      expect(q, isNotEmpty);
      expect(q.first['memberId'], 'm1');
      expect(q.first['limit'], logBackfillLimit);
      expect(q.first['limit'], 200);

      final seqs = tester.widgetList<LogRow>(find.byType(LogRow)).map((r) => r.event.seq).toList();
      expect(seqs, [3, 5, 11, 12]);
      expect(find.text('생각 중'), findsOneWidget);
      expect(find.text('편집'), findsOneWidget);
      expect(find.text('완료'), findsOneWidget);
      expect(c.read(memberLogProvider('m1')).map((e) => e.seq), [3, 5, 11, 12]);
      // 상태 층의 링에는 라이브만(백필은 표시 전용)
      expect(c.read(memberEventsProvider('m1')).map((e) => e.seq), [11, 12]);
    });
  });

  testWidgets('재접속하면 events.query 를 다시 부른다(D-21) — 끊긴 동안의 이벤트가 로그에 나타난다', (tester) async {
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const LogTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => daemon.countOf('events.query') == 1, reason: 'first backfill');

      // 끊김 → 그 사이 데몬에 이벤트 20 이 쌓임(스냅샷 seq 도 20) → 재접속
      daemon.snapshotSeq = 20;
      daemon.handlers['events.query'] = (_) => {
            'events': [ev(20, kind: 'reporting', detail: {'summary': '끝났습니다'})],
          };
      await daemon.closeAll();
      await pumpUntil(tester, () => c.read(connectionStateProvider) != RpcConnectionState.connected, reason: 'disconnected');
      await pumpUntil(tester, () => c.read(connectionStateProvider) == RpcConnectionState.connected, reason: 'reconnected');
      await pumpUntil(tester, () => daemon.countOf('events.query') == 2, reason: 'second backfill');
      await pumpUntil(tester, () => find.text('보고').evaluate().isNotEmpty, reason: 'reporting row');
      expect(find.text('끝났습니다'), findsOneWidget);
      expect(c.read(memberBackfillProvider('m1')).loadedCount, 2);
    });
  });

  testWidgets('events.query 실패 → 배너에 원인, 라이브 행은 그대로', (tester) async {
    daemon.handlers['events.query'] = (_) => throw const FakeRpcError(-32000, 'db locked');
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const LogTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      daemon.emitEvent(ev(11, kind: 'error', detail: {'summary': 'process exited (code 1)'}));
      await pumpUntil(tester, () => find.byType(LogRow).evaluate().length == 1);
      await pumpUntil(tester, () => c.read(memberBackfillProvider('m1')).error != null, reason: 'error');
      await tester.pump();
      expect(find.textContaining('과거 이벤트 조회 실패: db locked'), findsOneWidget);
      expect(find.text('오류'), findsOneWidget);
    });
  });
}
