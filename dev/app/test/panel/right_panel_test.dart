// RightPanel: null → 안내, 헤더(이름·엔진·상태·직급/상사/부하·부서·팀 cwd·경과), 탭 4개(로그·터미널·지시문·보고서),
// 탭 전환으로 터미널 attach/detach, 보고서 자리(text 이벤트).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/panel/right_panel.dart';
import 'package:xterm/xterm.dart';

import 'panel_harness.dart';

void main() {
  late PanelFakeDaemon daemon;

  setUp(() async => daemon = await startDaemon());
  tearDown(() => daemon.stop());

  testWidgets('memberId null → "캐릭터를 선택하세요" + 인박스는 그대로', (tester) async {
    await tester.runAsync(() async {
      await pumpPanel(tester, daemon, const RightPanel(memberId: null));
      expect(find.text('캐릭터를 선택하세요'), findsOneWidget);
      expect(find.byType(TabBar), findsNothing);
      // T40-4 D6: 인박스는 선택 멤버와 무관하다 — 멤버를 안 골라도 헤더 자리에 선다.
      expect(find.byKey(const Key('inbox')), findsOneWidget);
      expect(find.text(inboxHeaderLabel(0)), findsOneWidget);
    });
  });

  testWidgets('헤더: 이름 · 엔진 · 상태(한국어) · 팀 cwd · 출근 후 경과; 탭 4개, 기본 로그 탭', (tester) async {
    final overrides = panelOverrides(daemon);
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'), overrides: overrides);
      await pumpUntilConnected(tester, c);
      await tester.pump();
      expect(find.text('하루'), findsOneWidget);
      expect(find.text('claude'), findsOneWidget);
      expect(find.text('작업 중'), findsOneWidget); // working
      expect(find.text('alpha · 팀 pixel · D:/proj/pixel'), findsOneWidget); // 부서 · 팀 · 부서 cwd
      // T37: 직급·상사·직속 부하 줄. 상사(mH) 행이 스냅샷에 없으면 "없음".
      expect(find.text(panelTreeLine(rank: MemberRank.member, parentName: null, childCount: 0)), findsOneWidget);
      expect(find.byKey(const Key('panel.notInstructable')), findsOneWidget); // 팀원 → "지시는 부장에게"
      expect(find.textContaining('출근 1시간 30분'), findsOneWidget); // createdAt = now-90m
      expect(find.text('로그'), findsOneWidget);
      expect(find.text('터미널'), findsOneWidget);
      expect(find.text('지시문'), findsOneWidget);
      expect(find.text('보고서'), findsOneWidget);
      expect(find.byType(LogTab), findsOneWidget);
      expect(find.byType(TerminalView), findsNothing); // 터미널 탭은 보일 때만 attach

      // 상태 변화가 헤더에 반영된다(idle + 배정 없음 → 한가함)
      daemon.push('member.status', {'memberId': 'm1', 'status': 'idle', 'derived': 'free'});
      await pumpUntil(tester, () => find.text('한가함').evaluate().isNotEmpty, reason: 'derived label');

      // 모르는 멤버 id → 헤더에 안내, 탭은 그대로
      await pumpPanel(tester, daemon, const RightPanel(memberId: 'ghost'), overrides: overrides);
      await tester.pump();
      expect(find.textContaining('멤버 정보 없음'), findsOneWidget);
    });
  });

  testWidgets('T37: 헤더의 직급·상사·직속 부하 — 부장은 상사가 "사용자", 지시 안내가 없다', (tester) async {
    daemon.snapshotBody['members'] = [
      memberJson('mH', name: '부장', rank: 'head'),
      memberJson('mL', name: '반장', rank: 'lead', parentId: 'mH'),
      memberJson('m1', name: '이음', parentId: 'mL'),
      memberJson('m2', name: '하루', parentId: 'mL'),
    ];
    final overrides = panelOverrides(daemon);
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'mH'), overrides: overrides);
      await pumpUntilConnected(tester, c);
      await tester.pump();
      // 부장: 상사는 사용자, 직속 부하는 팀장 1명. 지시를 받는 직급이라 안내 문구가 없다.
      expect(find.text(panelTreeLine(rank: MemberRank.head, parentName: null, childCount: 1)), findsOneWidget);
      expect(find.text('부장 · 상사: 사용자 · 직속 부하 1명'), findsOneWidget);
      expect(find.byKey(const Key('panel.notInstructable')), findsNothing);
      // 부장은 팀에 속하지 않는다 — 부서 이름 · 부서 cwd 만.
      expect(find.text('alpha · D:/proj/pixel'), findsOneWidget);

      // 팀장: 상사는 부장, 직속 부하 2명 + "지시는 부장에게" 안내.
      await pumpPanel(tester, daemon, const RightPanel(memberId: 'mL'), overrides: overrides);
      await tester.pump();
      expect(find.text('팀장 · 상사: 부장(부장) · 직속 부하 2명'), findsOneWidget);
      expect(find.byKey(const Key('panel.notInstructable')), findsOneWidget);
      expect(find.text(panelNotInstructableHint), findsOneWidget);
      // 안내가 있어도 터미널 탭은 그대로 쓸 수 있다(직접 타이핑 허용).
      expect(find.text('터미널'), findsOneWidget);

      // 팀원: 부하 0명.
      await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'), overrides: overrides);
      await tester.pump();
      expect(find.text('팀원 · 상사: 반장(팀장) · 직속 부하 0명'), findsOneWidget);
    });
  });

  testWidgets('터미널 탭으로 가면 attach, 로그 탭으로 돌아오면 detach', (tester) async {
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      expect(daemon.countOf('member.attach'), 0);
      await tester.tap(find.text('터미널'));
      await tester.pumpAndSettle(); // 탭 전환 애니메이션(pump() 만으로는 시간이 흐르지 않는다)
      await pumpUntil(tester, () => daemon.countOf('member.attach') == 1, reason: 'attach on tab shown');
      await pumpUntil(tester, () => find.byType(TerminalView).evaluate().isNotEmpty);
      await tester.tap(find.text('로그'));
      await tester.pumpAndSettle();
      await pumpUntil(tester, () => daemon.countOf('member.detach') == 1, reason: 'detach on tab hidden');
      await pumpUntil(tester, () => find.byType(TerminalView).evaluate().isEmpty);
    });
  });

  testWidgets('T40-4: 인박스는 선택 멤버와 무관 — 헤더 아래 · 탭 위, 답하면 사라짐', (tester) async {
    daemon.snapshotBody['pending'] = [
      pendingJson('a1', memberId: 'm1', payload: {'tool_name': 'Bash', 'tool_input': {'command': 'flutter test'}}),
      pendingJson('q2', memberId: 'm2', type: 'question', payload: {'question': '모시의 질문?'}),
    ];
    daemon.handlers['approval.respond'] = (_) => {};
    final overrides = panelOverrides(daemon);
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'), overrides: overrides);
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.byType(ApprovalCard).evaluate().isNotEmpty, reason: 'inbox card');
      expect(find.text('flutter test'), findsOneWidget);
      // m2 의 TUI 질문도 사용자 몫이라 같은 인박스에 있다(선택 멤버가 m1 이어도).
      expect(find.byType(QuestionCard), findsOneWidget);
      expect(find.text('모시의 질문?'), findsOneWidget);
      expect(find.text(inboxHeaderLabel(2)), findsOneWidget);
      // 인박스는 헤더 아래 · 탭 위
      expect(tester.getTopLeft(find.byKey(const Key('inbox'))).dy, greaterThan(tester.getBottomLeft(find.byType(PanelHeader)).dy - 1));
      expect(tester.getBottomLeft(find.byType(ApprovalCard)).dy, lessThanOrEqualTo(tester.getTopLeft(find.byType(TabBar)).dy + 1));

      // m2 로 바꿔도 같은 목록이 그대로(선택 무관).
      await pumpPanel(tester, daemon, const RightPanel(memberId: 'm2'), overrides: overrides);
      await tester.pump();
      expect(find.byType(QuestionCard), findsOneWidget);
      expect(find.byType(ApprovalCard), findsOneWidget);

      // 허가 → 그 카드만 사라진다
      await tester.tap(find.text('허가'));
      await pumpUntil(tester, () => daemon.countOf('approval.respond') == 1);
      await pumpUntil(tester, () => find.byType(ApprovalCard).evaluate().isEmpty, reason: 'card gone after allow');
      expect(find.text(inboxHeaderLabel(1)), findsOneWidget);
      expect(find.byType(TabBar), findsOneWidget);
    });
  });

  testWidgets('보고서 탭(T18): 백필 text 는 "보고(작업 없음)", 라이브 text 가 위에 쌓인다(최신 먼저)', (tester) async {
    daemon.handlers['events.query'] = (_) => {
          'events': [
            ev(4, kind: 'text', detail: {'text': '첫 번째 응답\n둘째 줄'}),
          ],
        };
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1', initialTab: RightPanelTab.report));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.textContaining('첫 번째 응답').evaluate().isNotEmpty, reason: 'backfilled text');
      expect(find.byType(ReportCard), findsOneWidget);
      daemon.emitEvent(ev(12, kind: 'text', detail: {'text': '최신 응답입니다'}));
      await pumpUntil(tester, () => find.textContaining('최신 응답입니다').evaluate().isNotEmpty, reason: 'live text');
      expect(find.textContaining('첫 번째 응답'), findsOneWidget); // 이전 보고도 남는다
      final cards = tester.widgetList<ReportCard>(find.byType(ReportCard)).map((c) => c.report.seq).toList();
      expect(cards, [12, 4]); // 최신 먼저
      // T40-4: 문서 흐름 — 카드 제목이 아니라 헤더 줄 `보고 · 이름 · HH:MM · 작업 없음`.
      expect(find.textContaining('보고 · 하루 ·'), findsNWidgets(2));
      expect(find.textContaining('· 작업 없음'), findsNWidgets(2));
    });
  });
}
