// 지시문 탭(T26): member.instructions.get 으로 열고, 편집하면 저장이 열리고,
// 저장 → member.instructions.set, 저장하고 지금 재시작 → 확인 뒤 set + member.restart,
// 되돌리기, 직급별 기본 템플릿, RightPanel 세 번째 탭 자리.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/panel/right_panel.dart';

import 'panel_harness.dart';

const _editor = Key('panel.instructions.editor');
const _save = Key('panel.instructions.save');
const _saveRestart = Key('panel.instructions.saveRestart');
const _revert = Key('panel.instructions.revert');
const _template = Key('panel.instructions.template');

String _text(WidgetTester tester) => tester.widget<TextField>(find.byKey(_editor)).controller!.text;

bool _enabled(WidgetTester tester, Key key) => tester.widget<ButtonStyleButton>(find.byKey(key)).onPressed != null;

void main() {
  late PanelFakeDaemon daemon;

  setUp(() async {
    daemon = await startDaemon();
    daemon.handlers['member.instructions.set'] = (_) => {};
    daemon.handlers['member.restart'] = (p) => {'member': memberJson(p['memberId'] as String, status: 'starting')};
  });
  tearDown(() => daemon.stop());

  testWidgets('탭을 열면 member.instructions.get → 편집기에 마크다운, 저장은 닫혀 있다', (tester) async {
    daemon.handlers['member.instructions.get'] = (_) => {'markdown': '# 하루 지시문\n한국어로만 답한다.'};
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const InstructionsTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => _text(tester).contains('한국어로만'), reason: 'instructions.get');
      expect(daemon.paramsOf('member.instructions.get'), [
        {'memberId': 'm1'},
      ]);
      expect(find.textContaining('세션 시작·재개·/clear 때마다'), findsOneWidget);
      expect(find.textContaining('CLAUDE.md/AGENTS.md는 건드리지 않습니다'), findsOneWidget);
      // 불러오기만 한 상태 = 저장할 것 없음
      expect(_enabled(tester, _save), isFalse);
      expect(_enabled(tester, _revert), isFalse);
      expect(find.byKey(_template), findsNothing); // 내용이 있으면 템플릿 버튼 없음
    });
  });

  testWidgets('편집하면 저장이 열리고 → member.instructions.set{memberId, markdown}, 되돌리기는 원래대로', (tester) async {
    daemon.handlers['member.instructions.get'] = (_) => {'markdown': '원래 지시문'};
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const InstructionsTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => _text(tester) == '원래 지시문', reason: 'loaded');

      await tester.enterText(find.byKey(_editor), '원래 지시문\n말투는 반말.');
      await tester.pump();
      expect(_enabled(tester, _save), isTrue);
      expect(find.byKey(const Key('panel.instructions.dirty')), findsOneWidget);

      // 되돌리기 → 저장 다시 닫힘
      await tester.tap(find.byKey(_revert));
      await tester.pump();
      expect(_text(tester), '원래 지시문');
      expect(_enabled(tester, _save), isFalse);

      // 다시 편집하고 저장
      await tester.enterText(find.byKey(_editor), '원래 지시문\n말투는 반말.');
      await tester.pump();
      await tester.tap(find.byKey(_save));
      await pumpUntil(tester, () => daemon.countOf('member.instructions.set') == 1, reason: 'set');
      expect(daemon.paramsOf('member.instructions.set').single, {'memberId': 'm1', 'markdown': '원래 지시문\n말투는 반말.'});
      await pumpUntil(tester, () => find.textContaining('다음 세션부터 반영').evaluate().isNotEmpty, reason: 'saved hint');
      expect(daemon.countOf('member.restart'), 0);
      expect(_enabled(tester, _save), isFalse); // 저장했으니 다시 닫힌다
    });
  });

  testWidgets('저장하고 지금 재시작: 확인 다이얼로그 취소 → 아무것도 안 하고, 확인 → set 다음 member.restart', (tester) async {
    daemon.handlers['member.instructions.get'] = (_) => {'markdown': 'A'};
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const InstructionsTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => _text(tester) == 'A', reason: 'loaded');
      await tester.enterText(find.byKey(_editor), 'B');
      await tester.pump();

      // 취소 (편집기에 포커스가 있어 커서가 깜빡이므로 pumpAndSettle 대신 시간을 재서 편다)
      await tester.tap(find.byKey(_saveRestart));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.textContaining('진행 중인 작업이 있으면 중단됩니다'), findsOneWidget);
      await tester.tap(find.byKey(const Key('panel.instructions.restartCancel')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(daemon.countOf('member.instructions.set'), 0);
      expect(daemon.countOf('member.restart'), 0);

      // 확인
      await tester.tap(find.byKey(_saveRestart));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.tap(find.byKey(const Key('panel.instructions.restartConfirm')));
      await pumpUntil(tester, () => daemon.countOf('member.restart') == 1, reason: 'restart');
      expect(daemon.paramsOf('member.instructions.set').single, {'memberId': 'm1', 'markdown': 'B'});
      expect(daemon.paramsOf('member.restart').single, {'memberId': 'm1'});
      // 순서: set 이 먼저다
      final methods = daemon.requests.map((r) => r.$1).where((m) => m.startsWith('member.')).toList();
      expect(methods.indexOf('member.instructions.set'), lessThan(methods.indexOf('member.restart')));
      await pumpUntil(tester, () => find.textContaining('재시작했어요').evaluate().isNotEmpty, reason: 'restarted hint');
    });
  });

  testWidgets('비어 있으면 기본 템플릿 넣기 — 팀원은 팀원 템플릿', (tester) async {
    daemon.handlers['member.instructions.get'] = (_) => {'markdown': ''};
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const InstructionsTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.byKey(_template).evaluate().isNotEmpty, reason: 'template button');
      await tester.tap(find.byKey(_template));
      await tester.pump();
      expect(_text(tester), memberInstructionTemplate);
      expect(_text(tester), startsWith('# 팀원 지시문'));
      expect(_text(tester), contains('report(taskId, summary, status: done|blocked)'));
      // T29: 데몬 팀원 템플릿과 같은 도구 이름 줄 (T26b "남은 것")
      expect(
        _text(tester),
        contains('도구 이름: mcp__team__report, mcp__team__ask_user (도구 목록에 없으면 ToolSearch로 찾는다).'),
      );
      expect(find.byKey(_template), findsNothing); // 내용이 생기면 버튼도 사라진다
      expect(_enabled(tester, _save), isTrue); // 넣은 것도 저장 대상
    });
  });

  testWidgets('팀장은 팀장 템플릿(rank: leader)', (tester) async {
    daemon.snapshotBody['members'] = [memberJson('m1', name: '하루', rank: 'leader')];
    daemon.handlers['member.instructions.get'] = (_) => {'markdown': ''};
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const InstructionsTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.byKey(_template).evaluate().isNotEmpty, reason: 'template button');
      await tester.tap(find.byKey(_template));
      await tester.pump();
      expect(_text(tester), leaderInstructionTemplate);
      expect(_text(tester), startsWith('# 팀장 지시문'));
      expect(_text(tester), contains('mcp__team__hire'));
    });
  });

  testWidgets('RightPanel 세 번째 탭이 지시문 — 탭을 열어야 get 을 부르고, 초안은 탭을 오가도 남는다', (tester) async {
    daemon.handlers['member.instructions.get'] = (_) => {'markdown': '원본'};
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const RightPanel(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      expect(daemon.countOf('member.instructions.get'), 0); // 로그 탭에서는 안 부른다

      // 탭 애니메이션 + 불러오는 동안의 진행 표시(무한 애니메이션) 때문에 pumpAndSettle 은 쓰지 않는다.
      await tester.tap(find.text('지시문'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      await pumpUntil(tester, () => _text(tester) == '원본', reason: 'get on show');
      expect(daemon.countOf('member.instructions.get'), 1);

      await tester.enterText(find.byKey(_editor), '원본 + 초안');
      await tester.pump();
      // 편집기에 포커스가 있으면 커서 깜빡임 때문에 pumpAndSettle 이 끝나지 않는다 — 탭 애니메이션만큼 편다.
      await tester.tap(find.text('로그'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.byKey(_editor), findsNothing);

      await tester.tap(find.text('지시문'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(_text(tester), '원본 + 초안'); // 초안 유지
      expect(daemon.countOf('member.instructions.get'), 1); // 이미 불러왔으면 다시 안 부른다
      expect(_enabled(tester, _save), isTrue);
    });
  });

  testWidgets('get 이 실패하면 사유 + 다시 시도', (tester) async {
    var fail = true;
    daemon.handlers['member.instructions.get'] = (_) {
      if (fail) throw const FakeRpcError(-32002, 'no such member');
      return {'markdown': '되찾음'};
    };
    await tester.runAsync(() async {
      final c = await pumpPanel(tester, daemon, const InstructionsTab(memberId: 'm1'));
      await pumpUntilConnected(tester, c);
      await pumpUntil(tester, () => find.byKey(const Key('panel.instructions.error')).evaluate().isNotEmpty, reason: 'error');
      expect(find.textContaining('불러오지 못했어요'), findsOneWidget);
      expect(_enabled(tester, _saveRestart), isFalse); // 못 불러왔으면 저장도 막는다
      fail = false;
      await tester.tap(find.byKey(const Key('panel.instructions.retry')));
      await pumpUntil(tester, () => _text(tester) == '되찾음', reason: 'retry');
      expect(find.byKey(const Key('panel.instructions.error')), findsNothing);
    });
  });
}
