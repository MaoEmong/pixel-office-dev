// ApprovalCard / QuestionCard / PendingCards / PendingInbox (T15).
// 가짜 데몬에 실제 소켓으로 붙어 approval.respond / question.respond 파라미터를 확인한다.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/panel/approval_summary.dart' show fitApprovalHeadline;
import 'package:pixel_office/panel/inbox.dart';
import 'package:pixel_office/panel/labels.dart' show panelDangerTint;
import 'package:pixel_office/panel/pending_card.dart';
import 'package:pixel_office/panel/ui_prefs.dart' show panelWidthDefault, panelWidthMin;
import 'package:pixel_office/state/office_state.dart';

import 'panel_harness.dart';

Pending pendingOf(Map<String, dynamic> json) => Pending.fromJson(json);

final bashPending = pendingJson('a1', payload: {
  'tool_name': 'Bash',
  'tool_input': {'command': 'rm -rf build && flutter build apk', 'description': '클린 빌드가 필요해요'},
  'permission_suggestions': [],
});

final askPending = pendingJson('q1', type: 'question', payload: {
  'questions': [
    {
      'question': '점심 뭐 먹을까?',
      'header': '점심',
      'options': [
        {'label': '김밥', 'description': '빠르고 저렴'},
        {'label': '라면'},
      ],
      'multiSelect': false,
    },
  ],
  'tool_input': {'questions': []},
});

void main() {
  late PanelFakeDaemon daemon;

  setUp(() async {
    daemon = await startDaemon();
    daemon.handlers['approval.respond'] = (_) => {};
    daemon.handlers['question.respond'] = (_) => {};
  });
  tearDown(() => daemon.stop());

  group('ApprovalCard', () {
    testWidgets('Bash: 제목·명령·설명을 그리고 허가 → approval.respond{allow}', (tester) async {
      daemon.snapshotBody['pending'] = [bashPending];
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(bashPending)));
        await pumpUntilConnected(tester, c);
        await tester.pump();
        expect(find.text('❗ Bash · 삭제'), findsOneWidget); // T40-4: 도구 · 동사(대상 없음)
        expect(find.byKey(const Key('approval.dangerTag')), findsOneWidget); // rm -rf → 위험
        expect(find.text('rm -rf build && flutter build apk'), findsOneWidget);
        expect(find.text('클린 빌드가 필요해요'), findsOneWidget);
        expect(find.text('허가'), findsOneWidget);
        expect(find.text('거부'), findsOneWidget);
        expect(find.text('이번 세션 항상 허가'), findsOneWidget);
        expect(find.text('수정해서 허가'), findsOneWidget);

        await tester.tap(find.text('허가'));
        await tester.pump();
        expect(find.text('전송됨'), findsOneWidget);
        await pumpUntil(tester, () => daemon.countOf('approval.respond') == 1, reason: 'allow sent');
        final p = daemon.paramsOf('approval.respond').single;
        expect(p, {'pendingId': 'a1', 'behavior': 'allow'});
        // 보낸 뒤 버튼 잠금 + 상태 층에서 pending 제거
        final btn = tester.widget<FilledButton>(find.widgetWithText(FilledButton, '허가'));
        expect(btn.onPressed, isNull);
        await pumpUntil(tester, () => !c.read(openPendingProvider).containsKey('a1'), reason: 'pending removed locally');
      });
    });

    testWidgets('거부: 사유 입력란이 인라인으로 → approval.respond{deny, message}', (tester) async {
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(bashPending)));
        await pumpUntilConnected(tester, c);
        expect(find.byKey(const ValueKey('approval-deny-reason')), findsNothing);
        await tester.tap(find.text('거부'));
        await tester.pump();
        expect(find.byKey(const ValueKey('approval-deny-reason')), findsOneWidget);
        await tester.enterText(find.byKey(const ValueKey('approval-deny-reason')), '캐시 지우지 마');
        await tester.tap(find.text('거부 전송'));
        await pumpUntil(tester, () => daemon.countOf('approval.respond') == 1, reason: 'deny sent');
        expect(daemon.paramsOf('approval.respond').single, {'pendingId': 'a1', 'behavior': 'deny', 'message': '캐시 지우지 마'});
      });
    });

    testWidgets('이번 세션 항상 허가 → alwaysThisSession:true', (tester) async {
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(bashPending)));
        await pumpUntilConnected(tester, c);
        await tester.tap(find.text('이번 세션 항상 허가'));
        await pumpUntil(tester, () => daemon.countOf('approval.respond') == 1);
        expect(daemon.paramsOf('approval.respond').single, {'pendingId': 'a1', 'behavior': 'allow', 'alwaysThisSession': true});
      });
    });

    testWidgets('수정해서 허가: 명령 박스가 편집 가능 → updatedInput{…tool_input, command: 수정본}', (tester) async {
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(bashPending)));
        await pumpUntilConnected(tester, c);
        await tester.tap(find.text('수정해서 허가'));
        await tester.pump();
        final editor = find.byKey(const ValueKey('approval-command-editor'));
        expect(editor, findsOneWidget);
        expect(tester.widget<TextField>(editor).controller!.text, 'rm -rf build && flutter build apk');
        await tester.enterText(editor, 'flutter build apk');
        await tester.tap(find.text('수정한 명령으로 허가'));
        await pumpUntil(tester, () => daemon.countOf('approval.respond') == 1, reason: 'edited allow sent');
        expect(daemon.paramsOf('approval.respond').single, {
          'pendingId': 'a1',
          'behavior': 'allow',
          'updatedInput': {'command': 'flutter build apk', 'description': '클린 빌드가 필요해요'},
        });
        await pumpUntil(tester, () => !c.read(openPendingProvider).containsKey('a1'));
      });
    });

    testWidgets('키보드: 카드에 포커스 후 Enter = 허가, Esc = 포커스 해제', (tester) async {
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(bashPending)));
        await pumpUntilConnected(tester, c);
        // 카드 본문(제목)을 눌러 포커스
        await tester.tap(find.text('❗ Bash · 삭제'));
        await tester.pump();
        final node = tester.widget<Focus>(find.byWidgetPredicate((w) => w is Focus && w.focusNode?.debugLabel == 'approvalCard'));
        expect(node.focusNode!.hasPrimaryFocus, isTrue);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
        expect(node.focusNode!.hasFocus, isFalse);
        // 다시 포커스 → Enter
        await tester.tap(find.text('❗ Bash · 삭제'));
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await pumpUntil(tester, () => daemon.countOf('approval.respond') == 1, reason: 'enter → allow');
        expect(daemon.paramsOf('approval.respond').single['behavior'], 'allow');
      });
    });

    testWidgets('Edit: 파일 경로 + diff 미리보기(12줄 제한); 그 외 도구: JSON 접기', (tester) async {
      final editPending = pendingJson('e1', payload: {
        'tool_name': 'Edit',
        'tool_input': {
          'file_path': 'D:/proj/lib/main.dart',
          'old_string': 'a\nb',
          'new_string': List.generate(14, (i) => 'n$i').join('\n'),
        },
      });
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(editPending)));
        await pumpUntilConnected(tester, c);
        expect(find.text('❗ Edit · main.dart 수정'), findsOneWidget);
        expect(find.text('D:/proj/lib/main.dart'), findsOneWidget);
        expect(find.textContaining('- a\n- b\n+ n0'), findsOneWidget);
        expect(find.textContaining('+ n13'), findsNothing); // 12줄 넘는 부분은 잘림
        expect(find.text('… 4줄 더'), findsOneWidget);
        expect(find.text('수정해서 허가'), findsNothing); // 셸 도구가 아니면 없음

        final mcpPending = pendingJson('x1', payload: {
          'tool_name': 'mcp__notion__search',
          'tool_input': {for (var i = 0; i < 20; i++) 'k$i': i},
        });
        await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(mcpPending)));
        await tester.pump();
        expect(find.text('❗ mcp__notion__search · 실행'), findsOneWidget);
        expect(find.textContaining('"k19": 19'), findsNothing);
        await tester.tap(find.textContaining('줄 더 보기'));
        await tester.pump();
        expect(find.textContaining('"k19": 19'), findsOneWidget);
        expect(find.text('접기'), findsOneWidget);
      });
    });

    testWidgets('데몬 오류(-32000) → 실패 문구 + 버튼 다시 열림', (tester) async {
      daemon.handlers['approval.respond'] = (_) => throw const FakeRpcError(-32000, 'db locked');
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(bashPending)));
        await pumpUntilConnected(tester, c);
        await tester.tap(find.text('허가'));
        await pumpUntil(tester, () => find.textContaining('전송 실패: db locked').evaluate().isNotEmpty, reason: 'error shown');
        expect(find.text('전송됨'), findsNothing);
        expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, '허가')).onPressed, isNotNull);
      });
    });
  });

  group('T40-4 허가 카드 골격', () {
    testWidgets('명령은 3줄 클램프 + "전체 보기" 로 펼친다', (tester) async {
      final long = pendingJson('c1', payload: {
        'tool_name': 'Bash',
        'tool_input': {'command': List.generate(6, (i) => 'line$i').join('\n')},
      });
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(long)));
        await pumpUntilConnected(tester, c);
        final box = find.byKey(const Key('approval.command'));
        expect(tester.widget<SelectableText>(box).maxLines, approvalCommandLines);
        expect(find.text(approvalShowAllLabel), findsOneWidget);
        await tester.tap(find.byKey(const Key('approval.showAll')));
        await tester.pump();
        expect(tester.widget<SelectableText>(box).maxLines, isNull);
        expect(find.text('접기'), findsOneWidget);
      });
    });

    testWidgets('짧은 명령은 "전체 보기" 가 없다', (tester) async {
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(bashPending)));
        await pumpUntilConnected(tester, c);
        expect(find.byKey(const Key('approval.showAll')), findsNothing);
        expect(tester.widget<SelectableText>(find.byKey(const Key('approval.command'))).maxLines, isNull);
      });
    });

    testWidgets('메타: `요청 N분 전 · <만료 시각> 만료`, 만료되면 회색 카드', (tester) async {
      final fresh = pendingJson('m1', createdAt: DateTime.now().toUtc().subtract(const Duration(minutes: 2)).toIso8601String(),
          payload: {'tool_name': 'Bash', 'tool_input': {'command': 'ls'}});
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(fresh)));
        await pumpUntilConnected(tester, c);
        final meta = tester.widget<Text>(find.byKey(const Key('approval.meta'))).data!;
        expect(meta, startsWith('요청 2분 전 · '));
        expect(meta, endsWith(' 만료'));

        // 하루가 지난 요청 → 회색 "만료 — 재지시"
        final old = pendingJson('m2', createdAt: DateTime.now().toUtc().subtract(const Duration(hours: 25)).toIso8601String(),
            payload: {'tool_name': 'Bash', 'tool_input': {'command': 'ls'}});
        await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(old)));
        await tester.pump();
        expect(tester.widget<Text>(find.byKey(const Key('approval.meta'))).data, '$approvalExpiredLabel 필요');
        expect(find.textContaining(approvalExpiredLabel), findsWidgets);
      });
    });

    testWidgets('위험 패턴이면 첫 줄 배경 틴트 + 태그, 아니면 둘 다 없다', (tester) async {
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(bashPending)));
        await pumpUntilConnected(tester, c);
        expect(find.byKey(const Key('approval.dangerTag')), findsOneWidget);
        expect(tester.widget<Container>(find.byKey(const Key('approval.headline'))).color, panelDangerTint);

        final safe = pendingJson('s1', payload: {'tool_name': 'Bash', 'tool_input': {'command': 'flutter test'}});
        await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(safe)));
        await tester.pump();
        expect(find.byKey(const Key('approval.dangerTag')), findsNothing);
        expect(tester.widget<Container>(find.byKey(const Key('approval.headline'))).color, isNull);
        expect(find.text('❗ Bash · 실행'), findsOneWidget);
      });
    });

    // T40d ① — 480 에서 `… t40-a.txt 쓰 / 기` 처럼 낱말 중간에서 접히던 자리.
    testWidgets('첫 줄은 폭 420·480 에서도 한 줄 — 낱말 중간에서 접히지 않는다', (tester) async {
      final write = pendingJson('w1', payload: {
        'tool_name': 'Write',
        'tool_input': {'file_path': r'D:\proj\sandbox\t40-a.txt', 'content': 'x'},
      });
      await tester.runAsync(() async {
        for (final width in [panelWidthMin, panelWidthDefault]) {
          await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(write)), size: Size(width, 400));
          await tester.pump();
          final text = tester.widget<Text>(find.text('❗ Write · t40-a.txt 쓰기'));
          expect(text.maxLines, 1, reason: '폭 $width');
          final para = tester.renderObject<RenderBox>(
            find.descendant(of: find.byKey(const Key('approval.headline')), matching: find.byType(RichText)).first,
          );
          // 한 줄이면 13.5px 글자 두 줄(≈32px)보다 낮다.
          expect(para.size.height < 32, isTrue, reason: '첫 줄이 접혔다(폭 $width, 높이 ${para.size.height})');
          expect(find.byKey(const Key('approval.meta')), findsOneWidget); // 메타도 같은 줄에 그대로
        }
      });
    });

    testWidgets('대상이 길면 가운데 말줄임 — 동사는 살아 있다(420 최소 폭)', (tester) async {
      final long = pendingJson('w2', payload: {
        'tool_name': 'Write',
        'tool_input': {'file_path': r'D:\proj\docs\design\레이아웃-v2-아주-긴-파일-이름.md'},
      });
      await tester.runAsync(() async {
        await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(long)), size: const Size(panelWidthMin, 400));
        await tester.pump();
        final shown = fitApprovalHeadline('Write', {'file_path': r'D:\proj\docs\design\레이아웃-v2-아주-긴-파일-이름.md'},
            panelWidth: panelWidthMin);
        expect(shown, contains('…'));
        expect(shown, endsWith(' 쓰기'));
        expect(find.text(shown), findsOneWidget);

        // 420 에서 위험 태그 + 설명 + 명령 박스 + 버튼 줄이 다 있는 카드도 넘치지 않는다
        // (넘치면 RenderFlex overflow 로 이 테스트가 죽는다).
        await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(bashPending)), size: const Size(panelWidthMin, 400));
        await tester.pump();
        expect(find.byKey(const Key('approval.dangerTag')), findsOneWidget);
        expect(find.byKey(const Key('approval.meta')), findsOneWidget);
        expect(find.text('이번 세션 항상 허가'), findsOneWidget);
      });
    });

    testWidgets('주 버튼(허가·거부)은 높이 32, 보조는 작은 텍스트 버튼', (tester) async {
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(bashPending)));
        await pumpUntilConnected(tester, c);
        expect(tester.getSize(find.byKey(const Key('approval.allow'))).height, approvalPrimaryButtonHeight);
        expect(tester.getSize(find.byKey(const Key('approval.deny'))).height, approvalPrimaryButtonHeight);
        expect(find.widgetWithText(TextButton, '이번 세션 항상 허가'), findsOneWidget);
        expect(find.widgetWithText(TextButton, '수정해서 허가'), findsOneWidget);
      });
    });

    testWidgets('인박스 밖(그 멤버 패널)에서는 단축키 힌트가 없다', (tester) async {
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(bashPending)));
        await pumpUntilConnected(tester, c);
        expect(find.text(approvalShortcutHint), findsNothing);
        await pumpPanel(tester, daemon, ApprovalCard(pending: pendingOf(bashPending), shortcutHint: true));
        await tester.pump();
        expect(find.text(approvalShortcutHint), findsOneWidget);
      });
    });
  });

  group('QuestionCard', () {
    testWidgets('옵션 버튼을 누르면 question.respond{answers: {question: label}}', (tester) async {
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, QuestionCard(pending: pendingOf(askPending)));
        await pumpUntilConnected(tester, c);
        expect(find.text('❓ 질문'), findsOneWidget);
        expect(find.text('점심'), findsOneWidget);
        expect(find.text('점심 뭐 먹을까?'), findsOneWidget);
        expect(find.text('김밥'), findsOneWidget);
        expect(find.text('라면'), findsOneWidget);
        expect(find.byTooltip('빠르고 저렴'), findsOneWidget);
        expect(find.byKey(const ValueKey('question-free-0')), findsOneWidget);
        // 답이 없으면 확인은 잠김
        expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, '확인')).onPressed, isNull);

        await tester.tap(find.text('라면'));
        await tester.pump();
        expect(find.text('전송됨'), findsOneWidget);
        await pumpUntil(tester, () => daemon.countOf('question.respond') == 1, reason: 'answer sent');
        expect(daemon.paramsOf('question.respond').single, {
          'pendingId': 'q1',
          'answers': {'점심 뭐 먹을까?': '라면'},
        });
        expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, '김밥')).onPressed, isNull); // 옵션 = 주 버튼
      });
    });

    testWidgets('직접 입력 → 확인 → 자유 답', (tester) async {
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, QuestionCard(pending: pendingOf(askPending)));
        await pumpUntilConnected(tester, c);
        await tester.enterText(find.byKey(const ValueKey('question-free-0')), '샐러드');
        await tester.pump();
        await tester.tap(find.text('확인'));
        await pumpUntil(tester, () => daemon.countOf('question.respond') == 1);
        expect(daemon.paramsOf('question.respond').single['answers'], {'점심 뭐 먹을까?': '샐러드'});
      });
    });

    testWidgets('multiSelect: 체크박스 + 확인 → 라벨을 ", " 로 이음; 질문 여러 개면 전부 답해야 확인', (tester) async {
      final multi = pendingJson('q2', type: 'question', payload: {
        'questions': [
          {
            'question': '토핑은?',
            'options': [
              {'label': '치즈'},
              {'label': '계란'},
              {'label': '햄'},
            ],
            'multiSelect': true,
          },
          {
            'question': '음료는?',
            'options': [
              {'label': '콜라'},
              {'label': '물'},
            ],
          },
        ],
      });
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, QuestionCard(pending: pendingOf(multi)));
        await pumpUntilConnected(tester, c);
        expect(find.text('❓ 질문 2개'), findsOneWidget);
        expect(find.byType(Checkbox), findsNWidgets(3));
        await tester.tap(find.text('햄'));
        await tester.tap(find.text('치즈'));
        await tester.pump();
        // 두 번째 질문 미답 → 확인 잠김
        expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, '확인')).onPressed, isNull);
        await tester.tap(find.text('물'));
        await tester.pump();
        expect(daemon.countOf('question.respond'), 0); // 질문이 여럿이면 즉시 전송하지 않음
        await tester.tap(find.text('확인'));
        await pumpUntil(tester, () => daemon.countOf('question.respond') == 1);
        expect(daemon.paramsOf('question.respond').single['answers'], {'토핑은?': '치즈, 햄', '음료는?': '물'});
      });
    });

    testWidgets('M2 ask_user 형태 {question, options?} 도 질문 하나로', (tester) async {
      final ask = pendingJson('q3', type: 'question', payload: {
        'question': '배포할까?',
        'options': ['예', '아니오'],
      });
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, QuestionCard(pending: pendingOf(ask)));
        await pumpUntilConnected(tester, c);
        expect(find.text('배포할까?'), findsOneWidget);
        await tester.tap(find.text('아니오'));
        await pumpUntil(tester, () => daemon.countOf('question.respond') == 1);
        expect(daemon.paramsOf('question.respond').single['answers'], {'배포할까?': '아니오'});
      });
    });
  });

  group('PendingCards / PendingInbox', () {
    testWidgets('스냅샷 pending 이 카드로; 닫히면(member.status 로 waiting 해제) 카드가 사라진다', (tester) async {
      daemon.snapshotBody['pending'] = [bashPending, pendingJson('b2', memberId: 'm2', payload: {'tool_name': 'Write', 'tool_input': {'file_path': 'x.txt', 'content': 'hi'}})];
      await tester.runAsync(() async {
        // T40-4: 허가는 선택 멤버와 무관한 전역 인박스가 가진다(D6) — 두 멤버 것이 다 보인다.
        final c = await pumpPanel(tester, daemon, const PendingInbox());
        await pumpUntilConnected(tester, c);
        await pumpUntil(tester, () => find.byType(ApprovalCard).evaluate().length == 2, reason: 'cards from snapshot');
        expect(find.text('❗ Bash · 삭제'), findsOneWidget);
        expect(find.text('❗ Write · x.txt 쓰기'), findsOneWidget);
        daemon.push('member.status', {'memberId': 'm1', 'status': 'working', 'derived': 'working'});
        await pumpUntil(tester, () => find.byType(ApprovalCard).evaluate().length == 1, reason: 'm1 card gone');
        expect(find.text('❗ Bash · 삭제'), findsNothing);
      });
    });

    testWidgets('라이브 waiting_approval 이벤트로 카드가 뜨고 error{pendingId} 로 사라진다', (tester) async {
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, const PendingInbox());
        await pumpUntilConnected(tester, c);
        expect(find.byType(ApprovalCard), findsNothing);
        daemon.emitEvent({
          ...ev(11, kind: 'waiting_approval', detail: {'tool': 'Bash', 'cmd': 'git push', 'summary': '푸시'}),
          'ref': {'approvalId': 'a9'},
        });
        await pumpUntil(tester, () => find.text('git push').evaluate().isNotEmpty, reason: 'card from event');
        expect(find.text('푸시'), findsOneWidget);
        daemon.emitEvent({
          ...ev(12, kind: 'error', detail: {'summary': 'hook hold timed out', 'pendingId': 'a9', 'pendingType': 'approval'}),
          'ref': {'approvalId': 'a9'},
        });
        await pumpUntil(tester, () => find.byType(ApprovalCard).evaluate().isEmpty, reason: 'card gone on error');
      });
    });

    testWidgets('T19b: 라이브 ask_user asking 이벤트 → 질문 카드(옵션 포함), raw idle 여도 유지, 답하면 사라진다', (tester) async {
      await tester.runAsync(() async {
        // m2 는 팀원 — `ask_user` 는 부장 것만 사용자 몫이라(D-32) 인박스가 아니라 그 멤버 패널에 남는다.
        final c = await pumpPanel(tester, daemon, const PendingCards(memberId: 'm2'));
        await pumpUntilConnected(tester, c);
        expect(find.byType(QuestionCard), findsNothing);

        daemon.emitEvent({
          ...ev(11, memberId: 'm2', kind: 'asking', detail: {'tool': 'ask_user', 'summary': '점심은?', 'options': ['김밥', '라면']}),
          'ref': {'questionId': 'q_ask'},
        });
        await pumpUntil(tester, () => find.byType(QuestionCard).evaluate().isNotEmpty, reason: 'question card from ask_user event');
        expect(find.text('점심은?'), findsOneWidget);
        expect(find.text('김밥'), findsOneWidget);
        expect(find.text('라면'), findsOneWidget);

        // ask_user 는 턴을 붙잡지 않는다 — raw status 가 idle 로 돌아와도 카드는 남아 있어야 한다(T19 함정 1).
        daemon.push('member.status', {'memberId': 'm2', 'status': 'idle', 'derived': 'waiting_answer'});
        await pumpUntil(tester, () => c.read(derivedStatusProvider('m2')) == DerivedStatus.waitingAnswer);
        await tester.pump();
        expect(find.byType(QuestionCard), findsOneWidget);

        await tester.tap(find.text('김밥'));
        await pumpUntil(tester, () => daemon.countOf('question.respond') == 1);
        expect(daemon.paramsOf('question.respond').single['answers'], {'점심은?': '김밥'});
        await pumpUntil(tester, () => find.byType(QuestionCard).evaluate().isEmpty, reason: 'card gone after answer');

        // 데몬이 derived 갱신용 member.status 를 한 번 더 보내도 상태가 흔들리지 않는다.
        daemon.push('member.status', {'memberId': 'm2', 'status': 'idle', 'derived': 'free'});
        await pumpUntil(tester, () => c.read(derivedStatusProvider('m2')) == DerivedStatus.free);
        expect(c.read(openPendingProvider), isEmpty);
      });
    });

    testWidgets('PendingInbox: 전 멤버, 오래된 순, 멤버 이름 표시', (tester) async {
      daemon.snapshotBody['pending'] = [
        pendingJson('old', memberId: 'm1', createdAt: '2026-09-15T01:00:00.000Z', payload: {'tool_name': 'Bash', 'tool_input': {'command': 'ls'}}),
        pendingJson('new', memberId: 'm2', type: 'question', createdAt: '2026-09-15T02:00:00.000Z', payload: {'question': '어디로?'}),
      ];
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, const PendingInbox());
        await pumpUntilConnected(tester, c);
        await pumpUntil(tester, () => find.byType(PendingCard).evaluate().length == 2, reason: 'two cards');
        final cards = tester.widgetList<PendingCard>(find.byType(PendingCard)).toList();
        expect(cards.map((c) => c.pending.id), ['old', 'new']); // 오래된 순(D6)
        expect(find.textContaining('모시 ·'), findsOneWidget);
        expect(find.textContaining('하루 ·'), findsOneWidget);
      });
    });

    testWidgets('T37: PendingInbox 는 사용자 몫만 — ask_parent 는 빠진다', (tester) async {
      daemon.snapshotBody['pending'] = [
        pendingJson('a1', memberId: 'm1', createdAt: '2026-09-15T01:00:00.000Z', payload: {'tool_name': 'Bash', 'tool_input': {'command': 'ls'}}),
        pendingJson('p1', memberId: 'm2', type: 'question', createdAt: '2026-09-15T02:00:00.000Z',
            payload: {'source': 'ask_parent', 'question': '이 폴더 지워도 됩니까?', 'from': 'm2', 'to': 'm1'}),
      ];
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, const PendingInbox());
        await pumpUntilConnected(tester, c);
        await pumpUntil(tester, () => find.byType(PendingCard).evaluate().isNotEmpty, reason: 'approval card');
        final cards = tester.widgetList<PendingCard>(find.byType(PendingCard)).toList();
        expect(cards.map((c) => c.pending.id), ['a1']); // 허가만
        expect(find.byType(AskParentCard), findsNothing);
      });
    });
  });

  // ---- T37 ask_parent 안내 카드 -------------------------------------------------------

  group('AskParentCard', () {
    final askParentPending = pendingJson('p1', memberId: 'm2', type: 'question', payload: {
      'source': 'ask_parent',
      'question': '이 폴더 지워도 됩니까?',
      'options': ['네', '아니오'],
      'from': 'm2',
      'to': 'm1',
    });

    testWidgets('질문한 멤버 패널에 "팀장/부장에게 질문 중" 안내 카드(상사 이름·질문·보기)', (tester) async {
      daemon.snapshotBody['pending'] = [askParentPending];
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, const PendingCards(memberId: 'm2'));
        await pumpUntilConnected(tester, c);
        await pumpUntil(tester, () => find.byType(AskParentCard).evaluate().isNotEmpty, reason: 'ask_parent card');
        expect(find.textContaining(askParentCardTitle), findsOneWidget);
        // 상사(m1 하루) 이름과 직급, 질문 본문.
        expect(find.textContaining('하루(팀원) 에게: 이 폴더 지워도 됩니까?'), findsOneWidget);
        expect(find.textContaining('보기: 네 / 아니오'), findsOneWidget);
        // 답하기 UI 는 접혀 있다 — 사용자 몫이 아니기 때문.
        expect(find.byType(QuestionCard), findsNothing);
        expect(find.text(askParentOverrideLabel), findsOneWidget);
      });
    });

    testWidgets('"대신 답하기" → 질문 카드가 열리고 옵션을 누르면 question.respond', (tester) async {
      daemon.snapshotBody['pending'] = [askParentPending];
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, const PendingCards(memberId: 'm2'));
        await pumpUntilConnected(tester, c);
        await pumpUntil(tester, () => find.byType(AskParentCard).evaluate().isNotEmpty, reason: 'ask_parent card');

        await tester.tap(find.byKey(const Key('askParent.override')));
        await tester.pump();
        expect(find.byType(QuestionCard), findsOneWidget);

        await tester.tap(find.text('네'));
        await pumpUntil(tester, () => daemon.countOf('question.respond') == 1, reason: 'respond sent');
        expect(daemon.paramsOf('question.respond').single, {
          'pendingId': 'p1',
          'answers': {'이 폴더 지워도 됩니까?': '네'},
        });
      });
    });
  });
}
