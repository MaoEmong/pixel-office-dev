// 맥 인박스 단축키(T48-2 · D-48 ⑤): `Cmd+Shift+Y` 허가 / `Cmd+Shift+N` 거부.
// 맥에서 `Alt+Y` 는 특수문자 입력이고 `Cmd+N` 은 새 창이라 Cmd+Shift 를 쓴다. 윈도우 쪽은 inbox_test.dart.
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/panel/inbox.dart';
import 'package:pixel_office/panel/pending_card.dart';

import 'panel_harness.dart';

Map<String, dynamic> approvalJson(String id, {required String memberId, required String command, required String createdAt}) =>
    pendingJson(id, memberId: memberId, createdAt: createdAt, payload: {
      'tool_name': 'Bash',
      'tool_input': {'command': command},
    });

void main() {
  late PanelFakeDaemon daemon;

  setUp(() async {
    daemon = await startDaemon();
    daemon.handlers['approval.respond'] = (_) => {};
  });
  tearDown(() => daemon.stop());

  /// 맥인 척하고 [body] 를 돌린다. 되돌리기는 **본문 안에서** 해야 한다 — `testWidgets` 는 본문이 끝나는
  /// 자리에서 "디버그 변수를 건드린 채 끝났는지" 를 검사한다(tearDown 은 그 뒤다).
  Future<void> onMac(Future<void> Function() body) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    try {
      await body();
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  }

  testWidgets('Cmd+Shift+Y 허가 / Cmd+Shift+N 거부 · 힌트도 맥 문구', (tester) async {
    daemon.snapshotBody['pending'] = [
      approvalJson('a1', memberId: 'm1', command: 'pwd', createdAt: '2026-09-17T01:00:00.000Z'),
      approvalJson('a2', memberId: 'm1', command: 'ls', createdAt: '2026-09-17T02:00:00.000Z'),
    ];
    await onMac(() async {
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, const SingleChildScrollView(child: PendingInbox()));
        await pumpUntilConnected(tester, c);
        await pumpUntil(tester, () => find.byType(ApprovalCard).evaluate().length == 2, reason: 'cards');
        expect(find.text(macApprovalShortcutHint), findsOneWidget, reason: '맨 위 카드에 맥 문구');
        expect(find.text(approvalShortcutHint), findsNothing);

        await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
        await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.keyY);
        await pumpUntil(tester, () => daemon.countOf('approval.respond') == 1, reason: 'cmd+shift+y allow');
        expect(daemon.paramsOf('approval.respond').single, {'pendingId': 'a1', 'behavior': 'allow'});

        await pumpUntil(tester, () => find.byType(ApprovalCard).evaluate().length == 1, reason: 'a1 gone');
        await tester.sendKeyEvent(LogicalKeyboardKey.keyN);
        await pumpUntil(tester, () => daemon.countOf('approval.respond') == 2, reason: 'cmd+shift+n deny');
        expect(daemon.paramsOf('approval.respond').last, {'pendingId': 'a2', 'behavior': 'deny'});
        await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      });
    });
  });

  testWidgets('맥에서 Alt+Y · Shift 없는 Cmd+Y 는 아무 일도 하지 않는다', (tester) async {
    daemon.snapshotBody['pending'] = [
      approvalJson('a1', memberId: 'm1', command: 'pwd', createdAt: '2026-09-17T01:00:00.000Z'),
    ];
    await onMac(() async {
      await tester.runAsync(() async {
        final c = await pumpPanel(tester, daemon, const SingleChildScrollView(child: PendingInbox()));
        await pumpUntilConnected(tester, c);
        await pumpUntil(tester, () => find.byType(ApprovalCard).evaluate().isNotEmpty, reason: 'card');

        await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.keyY);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
        await tester.pump();

        await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.keyY);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
        await tester.pump();

        expect(daemon.countOf('approval.respond'), 0);
      });
    });
  });
}
