// OfficeView 위젯 테스트. officeProvider 를 데몬 없이 고정 상태를 돌려주는 Notifier 로 덮어쓴다.
// 그림 자체는 검사할 수 없으니 (a) CustomPaint 의 OfficePainter 가 받은 장면·배치, (b) 시맨틱 라벨, (c) 탭 콜백을 본다.
// 하네스(FakeOfficeNotifier / pumpHarness / painterOf / twoMembers)는 office_harness.dart — T16 movement_test 와 공유.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_layout.dart';
import 'package:pixel_office/office/office_painter.dart';
import 'package:pixel_office/office/office_view.dart';
import 'package:pixel_office/state/office_state.dart';

import 'office_fixtures.dart';
import 'office_harness.dart';

void main() {
  testWidgets('멤버 2명 → 책상 2개, 라벨·엔진 배지·모니터 요약(running)', (tester) async {
    await pumpHarness(tester, FakeOfficeNotifier(twoMembers()));
    final painter = painterOf(tester);
    expect(painter.scene.members, hasLength(2));
    expect(painter.scene.members[0].deskLabel, '하루'); // T40-2: 라벨은 이름만
    expect(painter.scene.members[0].engineLabel, 'Claude');
    expect(painter.scene.members[0].summary, '▶ flutter test test/stt_test.dart');
    expect(painter.scene.members[1].deskLabel, '모시');
    expect(painter.scene.members[1].engineLabel, 'Codex');
    expect(painter.scene.members[1].summary, '(대기)');
    expect(painter.scene.queue, isEmpty);
    // paint 가 실제로 돌았고 레이아웃이 캔버스 크기로 계산됐다.
    expect(painter.lastLayout?.size, canvasSize);
    expect(painter.lastLayout?.deskCount, 2);
    expect(painter.lastPlacements.map((p) => p.memberId), ['m1', 'm2']);
    expect(painter.lastPlacements[0].center, painter.lastLayout!.seatCenter(0));
  });

  testWidgets('시맨틱 라벨에 책상·요약·내 책상이 나온다', (tester) async {
    final handle = tester.ensureSemantics();
    await pumpHarness(tester, FakeOfficeNotifier(twoMembers()));
    expect(find.semantics.byLabel(RegExp(r'책상 1 · 하루 · Claude · ▶ flutter test')), findsOne);
    expect(find.semantics.byLabel(RegExp(r'책상 2 · 모시 · Codex · \(대기\)')), findsOne);
    expect(find.semantics.byLabel('내 책상 · 대기 없음'), findsOne);
    expect(find.semantics.byLabel('문'), findsOne);
    handle.dispose();
  });

  testWidgets('waiting_approval 멤버는 내 책상 줄로, 목록에 "허가: <cmd>"', (tester) async {
    final handle = tester.ensureSemantics();
    final notifier = FakeOfficeNotifier(twoMembers());
    await pumpHarness(tester, notifier);
    var painter = painterOf(tester);
    expect(painter.scene.memberById('m2')!.isQueued, isFalse);

    // 상태 갱신 → 장면 재계산 → 줄로 이동(T16: 걸어가므로 애니메이션을 끝까지 돌린 뒤 자리를 본다).
    notifier.set(twoMembers(
      m2Status: MemberStatus.waitingApproval,
      pending: {'a1': approval('a1', 'm2', 'rm -rf build/')},
    ));
    await tester.pump();
    await settleMotion(tester);
    painter = painterOf(tester);
    final m2 = painter.scene.memberById('m2')!;
    expect(m2.queueIndex, 0);
    expect(m2.summary, '❗ 허가 대기');
    expect(m2.isAlert, isTrue);
    expect(painter.scene.queue.single.line(0), '1. 모시 — 허가: rm -rf build/');
    final layout = painter.lastLayout!;
    expect(painter.lastPlacements[1].center, layout.queueSlot(0));
    expect(painter.lastPlacements[1].center.dy, greaterThan(layout.deskRect(1).bottom)); // 책상보다 아래(내 책상 쪽)
    expect(painter.lastPlacements[0].center, layout.seatCenter(0)); // m1 은 그대로
    expect(find.semantics.byLabel(RegExp(r'내 책상 · 대기 1 · 1\. 모시 — 허가: rm -rf build/')), findsOne);
    expect(find.semantics.byLabel(RegExp(r'책상 2 · 모시 .* · 내 책상 줄')), findsOne);
    handle.dispose();
  });

  testWidgets('T19b: 부장의 ask_user 질문(raw idle · 파생 waiting_answer)도 내 책상 줄로, 목록에 "질문: <본문>"', (tester) async {
    final handle = tester.ensureSemantics();
    // T37: `ask_user` 로 사용자에게 올릴 수 있는 것은 부장뿐이다(D-32) — 모시를 부장으로 둔다.
    final notifier = FakeOfficeNotifier(twoMembers(m2AsHead: true));
    await pumpHarness(tester, notifier);
    expect(painterOf(tester).scene.memberById('m2')!.isQueued, isFalse);

    // 데몬: asking → text → idle 로 턴이 끝난 상태. raw 는 idle, 파생만 waiting_answer, 질문 pending 은 열려 있다.
    notifier.set(twoMembers(
      m2AsHead: true,
      pending: {'q1': askUserQuestion('q1', 'm2', '점심은?', options: ['김밥', '라면'])},
      derived: const {'m1': DerivedStatus.working, 'm2': DerivedStatus.waitingAnswer},
      extraEvents: {'m2': event('m2', OfficeEventKind.idle, seq: 9)},
    ));
    await tester.pump();
    await settleMotion(tester);
    var painter = painterOf(tester);
    final m2 = painter.scene.memberById('m2')!;
    expect(m2.status, MemberStatus.idle); // raw 는 그대로 idle
    expect(m2.queueIndex, 0);
    expect(m2.summary, '❓ 질문');
    expect(m2.isAlert, isTrue);
    expect(painter.scene.queue.single.line(0), '1. 모시 — 질문: 점심은?');
    // 부장은 맨 윗줄(책상 0) 이라 장면 순서의 첫 자리다.
    expect(painter.lastPlacements[0].center, painter.lastLayout!.queueSlot(0));
    expect(find.semantics.byLabel(RegExp(r'내 책상 · 대기 1 · 1\. 모시 — 질문: 점심은\?')), findsOne);

    // 답한 뒤: pending 이 닫히고 파생이 free → 자기 자리로.
    notifier.set(twoMembers(
      m2AsHead: true,
      derived: const {'m1': DerivedStatus.working, 'm2': DerivedStatus.free},
      extraEvents: {'m2': event('m2', OfficeEventKind.text, seq: 10, detail: {'text': '김밥'})},
    ));
    await tester.pump();
    await settleMotion(tester);
    painter = painterOf(tester);
    expect(painter.scene.memberById('m2')!.isQueued, isFalse);
    expect(painter.scene.queue, isEmpty);
    expect(painter.lastPlacements[0].center, painter.lastLayout!.seatCenter(0));
    expect(find.semantics.byLabel('내 책상 · 대기 없음'), findsOne);
    handle.dispose();
  });

  testWidgets('탭: 캐릭터·책상 → 멤버 id, 빈 곳 → null, 선택 멤버는 페인터에 전달', (tester) async {
    final picks = <String?>[];
    await pumpHarness(tester, FakeOfficeNotifier(twoMembers()), selected: 'm2', onSelect: picks.add);
    final painter = painterOf(tester);
    expect(painter.selectedMemberId, 'm2');
    final layout = painter.lastLayout!;
    final origin = tester.getTopLeft(find.byType(OfficeView));

    await tester.tapAt(origin + layout.seatCenter(0));
    await tester.tapAt(origin + layout.deskRect(1).center);
    await tester.tapAt(origin + layout.myDeskRect.topLeft + const Offset(4, 4)); // 내 책상 헤더(슬롯 밖)
    await tester.tapAt(origin + const Offset(3, 3));
    expect(picks, ['m1', 'm2', null, null]);
    // T40-3: 빈 슬롯(점선 실루엣)은 선택을 바꾸지 않는다 — 콜백 자체가 없다.
    await tester.tapAt(origin + layout.slotCenter(0));
    expect(picks, ['m1', 'm2', null, null]);
  });

  testWidgets('빈 상태: 멤버 없음 → 책상·배치 없음, 내 책상·문만, 힌트 위치', (tester) async {
    final handle = tester.ensureSemantics();
    await pumpHarness(tester, FakeOfficeNotifier(const OfficeState()));
    final painter = painterOf(tester);
    expect(painter.scene.isEmpty, isTrue);
    expect(painter.lastPlacements, isEmpty);
    expect(painter.lastLayout!.deskCount, 0);
    expect(find.semantics.byLabel('내 책상 · 대기 없음'), findsOne);
    expect(find.semantics.byLabel('문'), findsOne);
    expect(find.semantics.byLabel(RegExp(r'^책상 \d')), findsNothing);
    handle.dispose();
  });

  testWidgets('너비 900 미만이면 축소된 레이아웃으로 그린다', (tester) async {
    await tester.pumpWidget(ProviderScope(
      overrides: [officeProvider.overrideWith(() => FakeOfficeNotifier(twoMembers()))],
      child: const MaterialApp(home: Center(child: SizedBox(width: 600, height: 500, child: OfficeView()))),
    ));
    final painter = painterOf(tester);
    expect(painter.lastLayout!.size, const Size(600, 500));
    expect(painter.lastLayout!.scale, lessThan(1));
    expect(painter.lastLayout!.deskRect(1).right, lessThanOrEqualTo(600));
  });

  testWidgets('departmentId 를 주면 그 부서 멤버만 그린다, null 이면 전체', (tester) async {
    final state = OfficeState(
      members: {
        'm1': member('m1', name: '하루', createdAt: '1', departmentId: 'dA', teamId: 'tA'),
        'm2': member('m2', name: '모시', createdAt: '2', departmentId: 'dB', teamId: 'tB'),
        'm3': member('m3', name: '이음', createdAt: '3', departmentId: 'dA', teamId: 'tA'),
      },
    );
    Widget app(String? departmentId) => ProviderScope(
          overrides: [officeProvider.overrideWith(() => FakeOfficeNotifier(state))],
          child: MaterialApp(
            home: Center(child: SizedBox(width: 1000, height: 700, child: OfficeView(departmentId: departmentId))),
          ),
        );

    await tester.pumpWidget(app('dA'));
    var painter = painterOf(tester);
    expect(painter.scene.members.map((m) => m.id), ['m1', 'm3']);
    expect(painter.scene.members[1].deskLabel, '이음');
    expect(painter.lastLayout!.deskCount, 2);

    await tester.pumpWidget(app(null));
    painter = painterOf(tester);
    // 전체(부서 필터 없음)에서는 팀 클러스터 순으로 묶인다 — tA(m1, m3) → tB(m2).
    expect(painter.scene.members.map((m) => m.id), ['m1', 'm3', 'm2']);
    expect(painter.lastLayout!.deskCount, 3);
  });

  // T30 ④: 비정상 종료 = "오류 포즈". 붉은 링은 그림이라 직접 검사할 수 없으니, 페인터가 그 분기를 타는 근거
  // (`isError`)와 말풍선 문구·클릭 가능 여부를 본다. 퇴근(exited)과 달라야 한다.
  testWidgets('오류 포즈: error 멤버는 "⚠ 오류" 말풍선을 띄우고 여전히 클릭된다 (퇴근은 말풍선 없음)', (tester) async {
    final picks = <String?>[];
    final notifier = FakeOfficeNotifier(twoMembers(m2Status: MemberStatus.error));
    await pumpHarness(tester, notifier, onSelect: picks.add);
    var painter = painterOf(tester);
    var m2 = painter.scene.memberById('m2')!;
    expect(m2.isError, isTrue);
    expect(m2.isGone, isTrue);
    expect(m2.summary, '⚠ 오류');
    expect(m2.bubbleText, '⚠ 오류');

    // 회색 캐릭터라도 히트 테스트에서 빠지지 않는다 — 눌러야 오른쪽 패널의 재고용 배너로 갈 수 있다.
    final layout = painter.lastLayout!;
    final origin = tester.getTopLeft(find.byType(OfficeView));
    await tester.tapAt(origin + layout.seatCenter(1));
    await tester.tapAt(origin + layout.deskRect(1).center);
    expect(picks, ['m2', 'm2']);

    // 퇴근은 오류가 아니다(말풍선을 그리지 않는 쪽).
    notifier.set(twoMembers(m2Status: MemberStatus.exited));
    await tester.pump();
    painter = painterOf(tester);
    m2 = painter.scene.memberById('m2')!;
    expect(m2.isError, isFalse);
    expect(m2.isGone, isTrue);
    expect(m2.summary, '(퇴근)');
  });

  test('shouldRepaint: 장면·선택이 같으면 false, 다르면 true', () {
    final s = twoMembers();
    OfficePainter p(OfficeState st, [String? sel]) => OfficePainter(
          scene: OfficeScene.build(members: st.members, latestEvents: st.latestEvent, pending: st.pending),
          selectedMemberId: sel,
        );
    expect(p(s).shouldRepaint(p(s)), isFalse);
    expect(p(s, 'm1').shouldRepaint(p(s)), isTrue);
    expect(p(twoMembers(m2Status: MemberStatus.exited)).shouldRepaint(p(s)), isTrue);
    // 레이아웃 크기 하나로 배치 확인용(순수 계산).
    expect(OfficeLayout(size: canvasSize, deskCount: 2).placements(p(s).scene), hasLength(2));
  });
}
