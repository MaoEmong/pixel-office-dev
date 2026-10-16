import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/state/office_state.dart';
import 'package:pixel_office/workflow/workflow_panel.dart';
import 'command/fake_rpc_client.dart';

Map<String, dynamic> record(int number) => {
  'number': number,
  'title': number == 1 ? '기본 기능 구현' : '서비스 연결 검증',
  'summary': number == 1 ? '사원 조회와 등록 기능을 완성했습니다.' : '화면과 서버 연결을 확인했습니다.',
  'verification': ['자동 검사 통과', '실제 사용 흐름 확인'],
  'decision': 'continue',
  'nextStage': {'title': '남은 기능 확인', 'brief': '전체 완료 기준에 맞춰 남은 기능을 확인합니다.'},
  'at': '2026-10-16T01:20:00Z',
  'meeting': {'minutes': '팀장들이 역할과 완료 기준을 합의했습니다.'},
  'assignments': [{'leadName': '백엔드팀장', 'task': '사원 등록 구현', 'report': '등록과 오류 처리 검사를 통과했습니다.'}],
};

Map<String, dynamic> work(List<Map<String, dynamic>> stages) => {
  'id': 'w1', 'departmentId': 'd1', 'phase': 'executing', 'brief': '사원 관리 프로그램 완성',
  'stage': stages.length + 1, 'stageTitle': '남은 기능 확인', 'stages': stages,
  'messages': [], 'assignments': [],
};

void main() {
  setUpAll(() async {
    await (FontLoader('MaterialIcons')..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    await (FontLoader('Pretendard')
      ..addFont(rootBundle.load('assets/fonts/Pretendard-Regular.otf'))
      ..addFont(rootBundle.load('assets/fonts/Pretendard-Bold.otf'))).load();
  });

  testWidgets('stage history updates live, retains older results and preserves an unsent message', (tester) async {
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    var w = work([record(1)]);
    final fake = FakeRpcClient(responder: (_, _) => {'workflow': w});
    addTearDown(fake.close);
    final boundaryKey = GlobalKey();
    final scopeKey = GlobalKey();
    await tester.pumpWidget(ProviderScope(overrides: fake.overrides,
      child: MaterialApp(key: scopeKey, theme: ThemeData.dark().copyWith(textTheme: ThemeData.dark().textTheme.apply(fontFamily: 'Pretendard')),
        home: Scaffold(body: RepaintBoundary(key: boundaryKey,
          child: const WorkflowDialog(departmentId: 'd1', initialTab: 3))))));
    final c = ProviderScope.containerOf(scopeKey.currentContext!);
    c.read(officeProvider);
    fake.emitHello(departments: [fakeDepartment('d1', headId: 'h')], members: [fakeMember('h', rank: 'head')]);
    await tester.pumpAndSettle();
    expect(find.textContaining('사원 조회와 등록 기능을 완성', findRichText: true), findsOneWidget);
    await tester.enterText(find.byType(TextField), '진행 상황에 대한 추가 질문');
    w = work([record(1), record(2)]);
    fake.pushNotification('workflow.changed', w);
    await tester.pumpAndSettle();
    expect(find.textContaining('3단계 · 남은 기능 확인'), findsOneWidget);
    expect(find.text('2단계 · 서비스 연결 검증'), findsOneWidget);
    expect(find.textContaining('화면과 서버 연결을 확인', findRichText: true), findsOneWidget);
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, '진행 상황에 대한 추가 질문');
    final historyScroll = find.descendant(of: find.byKey(const PageStorageKey('workflow.stageHistory.scroll')),
        matching: find.byType(Scrollable)).first;
    await tester.scrollUntilVisible(find.text('1단계 · 기본 기능 구현'), 200, scrollable: historyScroll);
    await tester.tap(find.text('1단계 · 기본 기능 구현'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('1단계 · 기본 기능 구현'));
    await tester.tap(find.text('1단계 · 기본 기능 구현'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('1단계 · 기본 기능 구현'));
    await tester.pumpAndSettle();
    expect(find.textContaining('사원 조회와 등록 기능을 완성', findRichText: true), findsOneWidget);
    expect(find.text('백엔드팀장 · 담당 결과'), findsWidgets, reason: 'saved names survive changes to the current roster');
    expect(fake.calls.where((c) => c.$1 == 'workflow.start' || c.$1 == 'workflow.complete'), isEmpty);
    expect(tester.takeException(), isNull);

    const previewDir = String.fromEnvironment('STAGE_PREVIEW_DIR');
    if (previewDir.isNotEmpty) {
      tester.state<ScrollableState>(historyScroll).position.jumpTo(0);
      await tester.pumpAndSettle();
      await tester.runAsync(() async {
        final boundary = boundaryKey.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final shot = await boundary.toImage(pixelRatio: 1);
        final bytes = await shot.toByteData(format: ui.ImageByteFormat.png);
        await File('$previewDir/pixel-office-stage-history.png').writeAsBytes(bytes!.buffer.asUint8List());
        shot.dispose();
      });
    }
  });

  testWidgets('stage completion shows a summary and opens its saved history without a progression button', (tester) async {
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    var w = work([]);
    final fake = FakeRpcClient(responder: (_, _) => {'workflow': w});
    addTearDown(fake.close);
    final key = GlobalKey();
    await tester.pumpWidget(ProviderScope(overrides: fake.overrides,
        child: MaterialApp(key: key, home: const Scaffold(body: WorkflowBar()))));
    ProviderScope.containerOf(key.currentContext!).read(officeProvider);
    fake.emitHello(departments: [fakeDepartment('d1', headId: 'h')], members: [fakeMember('h', rank: 'head')]);
    await tester.pumpAndSettle();
    w = work([record(1)]);
    fake.pushNotification('workflow.changed', w);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('workflow.latestStage')), findsOneWidget);
    expect(find.textContaining('1단계 완료 · 사원 조회와 등록'), findsOneWidget);
    await tester.tap(find.text('단계 기록'));
    await tester.pumpAndSettle();
    expect(find.text('1단계 · 기본 기능 구현'), findsOneWidget);
    expect(find.descendant(of: find.byType(WorkflowDialog),
        matching: find.textContaining('사원 조회와 등록 기능을 완성', findRichText: true)), findsOneWidget);
    expect(fake.calls.where((c) => c.$1 == 'workflow.start' || c.$1 == 'workflow.complete'), isEmpty);
    expect(tester.takeException(), isNull);
  });
}
