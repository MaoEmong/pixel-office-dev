import 'dart:io';
import 'dart:async';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/workflow/workflow_panel.dart';
import 'package:pixel_office/workflow/workflow_reading.dart';
import 'command/fake_rpc_client.dart';

const reply = '''## 진행 상황

**회의는 정상적으로 진행 중입니다.** 팀별 의견을 모아 다음 순서를 정했습니다.

| 담당 | 현재 상태 |
| --- | --- |
| 백엔드팀 | 선행 업무 대기 |
| 문서QA팀 | 요구사항 정리 중 |

### 다음 작업
1. 요구사항과 완료 기준을 정리합니다.
2. 백엔드와 프론트 작업을 이어갑니다.

> 기존 대화와 회의 기록은 유지합니다.

```text
문서 정리 → 백엔드 → 프론트 → 최종 확인
```
''';

Map<String, dynamic> fixture() => {
  'departmentId': 'd1',
  'phase': 'executing',
  'brief': '사원 관리 프로그램을 만듭니다.\n\n## 목표\n직원 정보와 근태를 관리합니다.',
  'messages': [
    {
      'role': 'user',
      'text': '사원 관리 프로그램의 작업 범위를 정리해 줘.',
      'at': '2026-10-16T01:20:00',
    },
    {
      'role': 'head',
      'text': '직원 정보, 근태, 권한 관리부터 진행하겠습니다.',
      'at': '2026-10-16T01:21:00',
    },
    {
      'role': 'user',
      'text': '현재 어디까지 진행됐는지 알려줘.',
      'at': '2026-10-16T01:28:00',
      'followup': true,
    },
    {
      'role': 'head',
      'text': reply,
      'at': '2026-10-16T01:29:00',
      'followup': true,
    },
  ],
  'meeting': {
    'round': 2,
    'state': 'deciding',
    'participants': ['l1', 'l2'],
    'participantNames': {'l1': '백엔드팀장', 'l2': '문서QA팀장'},
    'minutes': '## 확정된 진행 순서\n문서 정리 후 개발을 시작합니다.',
    'contributions': [
      {
        'memberId': 'l1',
        'round': 1,
        'text': '## 데이터 구조\n직원과 근태 기록을 분리하겠습니다.',
        'at': '2026-10-16T01:23:00',
      },
      {
        'memberId': 'l2',
        'round': 1,
        'text': '완료 기준과 사용 시나리오부터 정리하겠습니다.',
        'at': '2026-10-16T01:23:30',
      },
      {
        'memberId': 'l1',
        'round': 2,
        'text': '문서 정리 결과를 기준으로 기능을 구현하겠습니다.',
        'at': '2026-10-16T01:24:00',
      },
    ],
  },
  'assignments': [
    {
      'leadId': 'l2',
      'task': '## 요구사항 정리\n주요 화면과 사용자 흐름을 문서화합니다.',
      'acceptance': ['직원 관리 시나리오 작성', '완료 기준 합의'],
      'status': 'assigned',
    },
    {
      'leadId': 'l1',
      'task': '직원 관리 기능을 구현합니다.',
      'acceptance': ['직원 등록·수정 가능'],
      'dependsOn': ['l2'],
      'status': 'queued',
    },
  ],
};

final previewBoundary = GlobalKey();
Future<void> preview(WidgetTester tester, String name) async {
  const directory = String.fromEnvironment('WORKFLOW_PREVIEW_DIR');
  if (directory.isEmpty) return;
  await tester.runAsync(() async {
    final boundary =
        previewBoundary.currentContext!.findRenderObject()!
            as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 1);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await File(
      '$directory/$name.png',
    ).writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

Future<void> mount(
  WidgetTester tester,
  FakeRpcClient fake, {
  Size size = const Size(1280, 720),
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: fake.overrides,
      child: RepaintBoundary(
        key: previewBoundary,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: ThemeData.dark(useMaterial3: true).copyWith(
            textTheme: ThemeData.dark().textTheme.apply(
              fontFamily: 'Pretendard',
            ),
          ),
          home: const Scaffold(body: WorkflowDialog(departmentId: 'd1')),
        ),
      ),
    ),
  );
  fake.emitHello(
    departments: [fakeDepartment('d1', headId: 'h')],
    members: [
      fakeMember('h', rank: 'head'),
      fakeMember('l1', name: '백엔드팀장', rank: 'lead'),
      fakeMember('l2', name: '문서QA팀장', rank: 'lead', status: 'working'),
    ],
  );
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(() async {
    final icons = FontLoader('MaterialIcons')
      ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
    await icons.load();
    final font = FontLoader('Pretendard')
      ..addFont(rootBundle.load('assets/fonts/Pretendard-Regular.otf'))
      ..addFont(rootBundle.load('assets/fonts/Pretendard-Bold.otf'));
    await font.load();
  });
  testWidgets(
    'dialog remains subscribed after sending multiple messages and starting a meeting',
    (tester) async {
      var w = <String, dynamic>{
        ...fixture(),
        'phase': 'clarifying',
        'messages': <Map<String, dynamic>>[],
      };
      final fake = FakeRpcClient(
        responder: (method, params) {
          if (method == 'workflow.discuss') {
            w = {
              ...w,
              'messages': [
                ...w['messages'] as List,
                {'role': 'user', 'text': params['text']},
              ],
            };
          }
          if (method == 'workflow.start') w = {...w, 'phase': 'meeting'};
          return {'workflow': w};
        },
      );
      addTearDown(fake.close);
      await mount(tester, fake);
      for (var i = 1; i <= 2; i++) {
        await tester.enterText(find.byType(TextField), '질문 $i');
        await tester.tap(find.text('대화 보내기'));
        await tester.pumpAndSettle();
        w = {
          ...w,
          'messages': [
            ...w['messages'] as List,
            {'role': 'head', 'text': '새 답변 $i'},
          ],
        };
        fake.pushNotification('workflow.changed', w);
        await tester.pumpAndSettle();
        expect(
          find.text('새 답변 $i', findRichText: true).hitTestable(),
          findsWidgets,
        );
      }
      await tester.tap(find.text('지금 바로 시작'));
      await tester.pumpAndSettle();
      w = {...w, 'phase': 'executing'};
      fake.pushNotification('workflow.changed', w);
      await tester.pumpAndSettle();
      expect(find.text('계획에 따라 실행 중'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'a new reply is visible without reopening after reading a long latest reply',
    (tester) async {
      var w = fixture();
      final fake = FakeRpcClient(responder: (_, _) => {'workflow': w});
      addTearDown(fake.close);
      await mount(tester, fake);
      expect(
        find.text('진행 상황', findRichText: true).hitTestable(),
        findsWidgets,
      );
      w = {
        ...w,
        'messages': [
          ...w['messages'] as List,
          {'role': 'head', 'text': '갱신된 답변의 시작', 'followup': true},
        ],
      };
      fake.pushNotification('workflow.changed', w);
      await tester.pumpAndSettle();
      expect(
        find.text('갱신된 답변의 시작', findRichText: true).hitTestable(),
        findsWidgets,
      );
    },
  );

  testWidgets(
    'reading history preserves its position and offers the newly arrived reply',
    (tester) async {
      var w = fixture();
      final fake = FakeRpcClient(responder: (_, _) => {'workflow': w});
      addTearDown(fake.close);
      await mount(tester, fake);
      final scroll = tester
          .widget<WorkflowConversation>(find.byType(WorkflowConversation))
          .controller;
      expect(scroll.position.maxScrollExtent, greaterThan(scroll.offset + 24));
      scroll.jumpTo(scroll.position.maxScrollExtent);
      await tester.pumpAndSettle();
      final oldOffset = scroll.offset;
      w = {
        ...w,
        'messages': [
          ...w['messages'] as List,
          {'role': 'head', 'text': '이동해서 확인할 새 답변'},
        ],
      };
      fake.pushNotification('workflow.changed', w);
      await tester.pumpAndSettle();
      expect(scroll.offset, closeTo(oldOffset, 1));
      expect(find.text('새 대화가 도착했어요.'), findsOneWidget);
      await tester.tap(find.text('새 대화 보기'));
      await tester.pumpAndSettle();
      expect(
        find.text('이동해서 확인할 새 답변', findRichText: true).hitTestable(),
        findsWidgets,
      );
      expect(find.text('새 대화가 도착했어요.'), findsNothing);
    },
  );

  testWidgets('an older fetch cannot overwrite a newer live conversation', (
    tester,
  ) async {
    var w = fixture();
    final delayed = Completer<Map<String, dynamic>>();
    var delay = false;
    final fake = FakeRpcClient(
      responder: (method, _) =>
          method == 'workflow.get' && delay ? delayed.future : {'workflow': w},
    );
    addTearDown(fake.close);
    await mount(tester, fake);
    final container = ProviderScope.containerOf(
      tester.element(find.byType(WorkflowDialog)),
    );
    delay = true;
    container.invalidate(workflowProvider('d1'));
    await tester.pump();
    await tester.pump();
    final old = w;
    w = {
      ...w,
      'phase': 'meeting',
      'messages': [
        ...w['messages'] as List,
        {'role': 'head', 'text': '가장 최근 답변'},
      ],
    };
    fake.pushNotification('workflow.changed', w);
    await tester.pumpAndSettle();
    expect(
      container.read(workflowProvider('d1')).asData?.value?['phase'],
      'meeting',
    );
    delayed.complete({'workflow': old});
    await tester.pumpAndSettle();
    await preview(tester, 'T72-live-race');
    expect(
      container.read(workflowProvider('d1')).asData?.value?['phase'],
      'meeting',
    );
    expect(find.text('가장 최근 답변', findRichText: true), findsWidgets);
  });

  testWidgets(
    'reply completion reconciles a missed update without closing the dialog or clearing a draft',
    (tester) async {
      var w = fixture();
      final fake = FakeRpcClient(responder: (_, _) => {'workflow': w});
      addTearDown(fake.close);
      await mount(tester, fake);
      await tester.enterText(find.byType(TextField), '아직 작성 중인 질문');
      w = {
        ...w,
        'messages': [
          ...w['messages'] as List,
          {'role': 'head', 'text': '완료 후 확인한 최신 답변'},
        ],
      };
      fake.pushNotification('member.status', {
        'memberId': 'h',
        'status': 'idle',
        'derived': 'free',
        'ts': '2026-10-16T01:30:00Z',
      });
      await tester.pumpAndSettle();
      expect(
        find.text('완료 후 확인한 최신 답변', findRichText: true).hitTestable(),
        findsWidgets,
      );
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        '아직 작성 중인 질문',
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'long replies open at their author and start, render formatting, and copy the entire original',
    (tester) async {
      final w = fixture();
      final fake = FakeRpcClient(responder: (_, _) => {'workflow': w});
      addTearDown(fake.close);
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await mount(tester, fake);
      expect(find.text('부장 · 답변 완료').hitTestable(), findsOneWidget);
      expect(
        find.text('진행 상황', findRichText: true).hitTestable(),
        findsWidgets,
      );
      expect(find.byType(Table), findsWidgets);
      expect(find.text('**회의는 정상적으로 진행 중입니다.**'), findsNothing);
      await preview(tester, 'T69-conversation');
      final card = find.byKey(const ValueKey('conversation.message.3'));
      final selection = tester
          .state<SelectionAreaState>(
            find.descendant(of: card, matching: find.byType(SelectionArea)),
          )
          .selectableRegion;
      selection.selectAll(SelectionChangedCause.keyboard);
      selection.contextMenuButtonItems
          .firstWhere((item) => item.type == ContextMenuButtonType.copy)
          .onPressed!();
      await tester.pumpAndSettle();
      expect(copied, contains('진행 상황'));
      expect(copied, contains('회의는 정상적으로 진행 중입니다.'));
      expect(copied, isNot(contains('**회의는')));
      await tester.tap(
        find.descendant(of: card, matching: find.byTooltip('메시지 복사')),
      );
      await tester.pumpAndSettle();
      expect(copied, reply);
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'tabs separate meeting rounds and work while preserving an unsent question across refreshes',
    (tester) async {
      var w = fixture();
      final fake = FakeRpcClient(responder: (_, _) => {'workflow': w});
      addTearDown(fake.close);
      await mount(tester, fake);
      await tester.enterText(find.byType(TextField), '이 질문은 아직 보내지 않았어요');
      await tester.tap(find.text('회의'));
      await tester.pumpAndSettle();
      expect(find.text('부장 · 회의 결정'), findsOneWidget);
      expect(find.text('1차 회의 · 접근 방법과 역할'), findsOneWidget);
      await preview(tester, 'T69-meeting');
      await tester.scrollUntilVisible(
        find.text('2차 회의 · 의견 검토와 조율'),
        250,
        scrollable: find
            .descendant(
              of: find.byKey(const PageStorageKey('workflow.meeting')),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.pumpAndSettle();
      expect(find.text('2차 회의 · 의견 검토와 조율'), findsOneWidget);
      await tester.tap(find.text('작업 계획'));
      await tester.pumpAndSettle();
      expect(find.text('문서QA팀장 · 업무 진행'), findsOneWidget);
      await preview(tester, 'T69-plan');
      w = {
        ...w,
        'messages': [
          ...w['messages'] as List,
          {'role': 'head', 'text': '새로운 진행 상황입니다.', 'followup': true},
        ],
      };
      fake.pushNotification('workflow.changed', w);
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        '이 질문은 아직 보내지 않았어요',
      );
      await tester.tap(find.text('대화'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('최근 대화'));
      await tester.pumpAndSettle();
      expect(
        find.text('새로운 진행 상황입니다.', findRichText: true).hitTestable(),
        findsWidgets,
      );
      expect(fake.calls.where((c) => c.$1 == 'workflow.discuss'), isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('long tables and code remain usable in a smaller dialog', (
    tester,
  ) async {
    final w = fixture();
    final fake = FakeRpcClient(responder: (_, _) => {'workflow': w});
    addTearDown(fake.close);
    await mount(tester, fake, size: const Size(680, 560));
    expect(find.byType(TextField).hitTestable(), findsOneWidget);
    await tester.tap(find.text('회의'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('작업 계획'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('work and meeting text survives repeated folding and reopening', (
    tester,
  ) async {
    final w = fixture();
    final fake = FakeRpcClient(responder: (_, _) => {'workflow': w});
    addTearDown(fake.close);
    await mount(tester, fake);
    await tester.tap(find.text('작업 계획'));
    await tester.pumpAndSettle();
    for (var i = 0; i < 3; i++) {
      await tester.tap(find.text('공유 작업안'));
      await tester.pump(const Duration(milliseconds: 80));
      expect(tester.takeException(), isNull);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.text('직원 정보와 근태를 관리합니다.', findRichText: true), findsWidgets);
      await tester.tap(find.text('공유 작업안'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.text('요구사항 정리', findRichText: true), findsWidgets);
    }
    await preview(tester, 'T70-plan-reopened');
    await tester.enterText(find.byType(TextField), '아직 보내지 않은 질문');
    fake.pushNotification('workflow.changed', {
      ...w,
      'brief': '${w['brief']}\n\n갱신된 작업안',
    });
    await tester.pumpAndSettle();
    await tester.tap(find.text('회의'));
    await tester.pumpAndSettle();
    for (var i = 0; i < 3; i++) {
      await tester.tap(find.text('1차 회의 · 접근 방법과 역할'));
      await tester.pump(const Duration(milliseconds: 80));
      expect(tester.takeException(), isNull);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.tap(find.text('1차 회의 · 접근 방법과 역할'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.text('데이터 구조', findRichText: true), findsWidgets);
    }
    await preview(tester, 'T70-meeting-reopened');
    await tester.tap(find.text('대화'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('작업 계획'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text('요구사항 정리', findRichText: true), findsWidgets);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '아직 보내지 않은 질문',
    );
    await tester.tap(find.text('공유 작업안'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text('갱신된 작업안', findRichText: true), findsWidgets);
  });
}
