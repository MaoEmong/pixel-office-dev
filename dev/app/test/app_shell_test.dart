// T40c: 두 절반(T40a 사무실 캔버스 · T40b 오른쪽 패널)의 **접점**을 `OfficeShell` 통째로 세워서 본다.
//   1. 내 책상 슬롯 클릭 → 그 멤버 선택 + 인박스가 그 카드로 스크롤(`inboxFocusProvider`) — D6.
//   2. 부서 0 개일 때 캔버스 가운데 "부서 만들기" 버튼 → 상단 바와 **같은** 다이얼로그 — 패스 2 이슈 7.
// 단위 테스트는 각 절반이 이미 덮는다(test/office/**, test/panel/**). 여기서 보는 것은 `main.dart` 의 배선뿐이다.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/main.dart';
import 'package:pixel_office/office/office_layout.dart';
import 'package:pixel_office/office/office_painter.dart' show OfficePainter;
import 'package:pixel_office/office/office_view.dart';
import 'package:pixel_office/panel/inbox.dart';
import 'package:pixel_office/panel/ui_prefs.dart';
import 'package:pixel_office/state/office_state.dart';
import 'package:pixel_office/state/selection.dart';
import 'package:pixel_office/topbar/top_bar.dart';

import 'command/fake_rpc_client.dart';

Future<ProviderContainer> pumpShell(WidgetTester tester, FakeRpcClient fake, {Size size = const Size(1280, 720)}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  final key = GlobalKey();
  await tester.pumpWidget(ProviderScope(
    // 패널 폭은 앱 로컬 파일에 저장된다 — 테스트는 메모리 저장소로(T40-4).
    overrides: [...fake.overrides, uiPrefsStoreProvider.overrideWithValue(MemoryUiPrefsStore())],
    child: MaterialApp(key: key, home: const OfficeShell()),
  ));
  await tester.pump();
  final c = ProviderScope.containerOf(key.currentContext!);
  c.read(officeProvider); // 프로바이더는 게으르다 — emitHello 전에 깨워 둔다(T40b 함정 7).
  return c;
}

Map<String, dynamic> approvalRow(String id, String memberId, {required String createdAt}) => {
      'id': id,
      'memberId': memberId,
      'type': 'approval',
      'payload': {
        'tool_name': 'Bash',
        'tool_input': {'command': 'echo $id'},
      },
      'status': 'open',
      'createdAt': createdAt,
      'answeredAt': null,
      'answer': null,
    };

void main() {
  late FakeRpcClient fake;

  setUp(() => fake = FakeRpcClient());
  tearDown(() async => fake.close());

  testWidgets('T40c 접점 1: 내 책상 슬롯 클릭 = 그 멤버 선택 + 인박스 그 카드로', (tester) async {
    final c = await pumpShell(tester, fake);
    fake.emitHello(
      departments: [fakeDepartment('d1', headId: 'mH')],
      teams: [fakeTeam('t1', leaderId: 'mL')],
      members: [
        fakeMember('mH', rank: 'head', name: '부장', status: 'waiting_approval', createdAt: 'a'),
        fakeMember('mL', rank: 'lead', name: '반장', parentId: 'mH', status: 'waiting_approval', createdAt: 'b'),
      ],
      pending: [
        approvalRow('p1', 'mH', createdAt: '2026-09-17T01:00:00.000Z'),
        approvalRow('p2', 'mL', createdAt: '2026-09-17T01:00:01.000Z'),
      ],
    );
    await tester.pump();
    await tester.pump();

    // 사무실이 그린 레이아웃에서 두 번째 슬롯(= 인박스 두 번째 카드 = mL 의 p2) 좌표를 얻는다.
    final painter = tester
        .widgetList<CustomPaint>(find.byType(CustomPaint))
        .map((c) => c.painter)
        .whereType<OfficePainter>()
        .single;
    final OfficeLayout? layout = painter.lastLayout;
    expect(layout, isNotNull, reason: '사무실이 한 번은 그려졌다');
    final origin = tester.getTopLeft(find.byType(OfficeView));

    await tester.tapAt(origin + layout!.slotCenter(1));
    await tester.pump();

    expect(c.read(selectedMemberIdProvider), 'mL', reason: '슬롯의 카드 주인이 선택된다');
    expect(c.read(inboxFocusProvider)?.pendingId, 'p2', reason: '인박스가 그 카드로 스크롤한다');
  });

  testWidgets('T40c 접점 2: 부서 0 개 → 캔버스 가운데 "부서 만들기" = 상단 바와 같은 다이얼로그', (tester) async {
    await pumpShell(tester, fake);
    fake.emitHello();
    await tester.pump();
    await tester.pump();

    expect(find.byType(CreateDepartmentDialog), findsNothing);
    expect(find.byType(DisconnectedOverlay), findsNothing, reason: '연결됐으면 오버레이가 버튼을 가리지 않는다');
    await tester.tap(find.byKey(const Key('office.createDepartment')));
    await tester.pumpAndSettle();
    expect(find.byType(CreateDepartmentDialog), findsOneWidget);
  });
}
