import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/diagnostics/error_panel.dart';

void main() {
  testWidgets(
    'error panel separates guidance and expandable diagnostics, and retries',
    (tester) async {
      var retries = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: SizedBox(
                width: 420,
                child: RecoveryPanelFrame(
                  child: ErrorPanel(
                    title: '저장할 수 없어요',
                    message: '폴더 권한을 확인하세요.',
                    details: 'EACCES test/path',
                    onRetry: () => retries++,
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      expect(find.byKey(const Key('recoveryPanel.surface')), findsOneWidget);
      expect(find.text('EACCES test/path'), findsNothing);
      await tester.tap(find.text('오류 상세'));
      await tester.pumpAndSettle();
      expect(find.text('EACCES test/path'), findsOneWidget);
      await tester.tap(find.text('다시 시도'));
      expect(retries, 1);
      expect(tester.takeException(), isNull);
    },
  );
}
