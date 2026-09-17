// OfficeView 위젯 테스트 공용 하네스(T12 office_view_test 에서 분리, T16 movement_test 와 공유).
// officeProvider 를 데몬 없이 고정 상태를 돌려주는 Notifier 로 덮어쓴다.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_painter.dart';
import 'package:pixel_office/office/office_view.dart';
import 'package:pixel_office/state/office_state.dart';

import 'office_fixtures.dart';

/// 데몬에 붙지 않는 OfficeNotifier — build 가 주어진 상태를 그대로 돌려준다.
class FakeOfficeNotifier extends OfficeNotifier {
  FakeOfficeNotifier(this.initial);
  final OfficeState initial;

  @override
  OfficeState build() => initial;

  void set(OfficeState s) => state = s;
}

const canvasSize = Size(1000, 700);

/// 테스트 창(기본 800×600)을 캔버스보다 크게 잡고 OfficeView 를 띄운다.
Future<void> pumpHarness(
  WidgetTester tester,
  FakeOfficeNotifier notifier, {
  String? selected,
  ValueChanged<String?>? onSelect,
  ValueChanged<String>? onSelectPending,
  VoidCallback? onCreateDepartment,
  String? departmentId,
}) async {
  tester.view.physicalSize = const Size(1200, 800);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(ProviderScope(
    overrides: [officeProvider.overrideWith(() => notifier)],
    child: MaterialApp(
      home: Center(
        child: SizedBox(
          width: canvasSize.width,
          height: canvasSize.height,
          child: OfficeView(
            selectedMemberId: selected,
            onSelectMember: onSelect,
            onSelectPending: onSelectPending,
            onCreateDepartment: onCreateDepartment,
            departmentId: departmentId,
          ),
        ),
      ),
    ),
  ));
}

OfficePainter painterOf(WidgetTester tester) {
  final paints = tester.widgetList<CustomPaint>(find.byType(CustomPaint)).where((c) => c.painter is OfficePainter);
  expect(paints, hasLength(1));
  return paints.first.painter! as OfficePainter;
}

/// 진행 중인 이동을 끝까지 돌린다(3초 × 2 — 문까지 갔다 오는 퇴근 경로도 끝난다).
/// working 멤버가 있으면 흔들림 때문에 Ticker 가 계속 돌므로 pumpAndSettle 은 쓸 수 없다.
Future<void> settleMotion(WidgetTester tester) async {
  await tester.pump(const Duration(seconds: 3));
  await tester.pump(const Duration(seconds: 3));
}

/// 멤버 2명(하루 working · 모시 idle). [m2AsHead] 면 모시가 그 부서의 **부장**이다
/// (T37: `ask_user` 질문은 부장만 사용자에게 올린다 → 내 책상 줄 테스트는 부장으로 해야 한다).
/// 부장은 팀 밖(맨 윗줄)이라 책상 순서가 [모시, 하루] 가 된다.
OfficeState twoMembers({
  MemberStatus m2Status = MemberStatus.idle,
  Map<String, Pending> pending = const {},
  Map<String, DerivedStatus> derived = const {},
  Map<String, OfficeEvent> extraEvents = const {},
  bool m2AsHead = false,
}) =>
    OfficeState(
      members: {
        'm1': member('m1', name: '하루', status: MemberStatus.working, createdAt: '1'),
        'm2': member('m2',
            name: '모시',
            status: m2Status,
            engine: Engine.codex,
            createdAt: '2',
            rank: m2AsHead ? MemberRank.head : MemberRank.member),
      },
      latestEvent: {
        'm1': event('m1', OfficeEventKind.running, detail: {'tool': 'Bash', 'cmd': 'flutter test test/stt_test.dart'}),
        ...extraEvents,
      },
      derived: derived,
      pending: pending,
    );
