// T40-2: 코드 상태 13종 → 범례 7칸 매핑(레이아웃-v2 패스 2 표, D-42 3)과 그에 딸린 글자 규칙.
// 이 매핑은 `legendSlotOf` **함수 하나**가 전부다 — 링 색·하단 범례·패널 상태 점이 같은 값을 쓴다.
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_scene.dart';

import 'office_fixtures.dart';

SceneMember sm({
  MemberStatus status = MemberStatus.idle,
  DerivedStatus? derived,
  int? queueIndex,
  int? askParentDeskIndex,
  bool shellWaiting = false,
  OfficeEventKind? eventKind,
  MemberRank rank = MemberRank.member,
}) =>
    SceneMember(
      id: 'm',
      name: '이음',
      engine: Engine.claude,
      status: status,
      deskIndex: 0,
      summary: '',
      isAlert: false,
      rank: rank,
      derived: derived,
      queueIndex: queueIndex,
      askParentDeskIndex: askParentDeskIndex,
      askParentVisitorIndex: askParentDeskIndex == null ? null : 0,
      isShellWaiting: shellWaiting,
      eventKind: eventKind,
    );

void main() {
  group('범례 7칸(패스 2 매핑표)', () {
    test('칸·색·아이콘이 표 그대로', () {
      expect(LegendSlot.values, hasLength(7));
      expect(LegendSlot.values.map((s) => s.label),
          ['작업', '한가', '보고 대기', '내 차례', '대기', '오류', '퇴근']);
      expect(LegendSlot.working.argb, 0xFF6C8EFF);
      expect(LegendSlot.idle.argb, 0xFF7ED3A1);
      expect(LegendSlot.waitingReports.argb, 0xFF7ED3A1);
      expect(LegendSlot.myTurn.argb, 0xFFFF9F43);
      expect(LegendSlot.waiting.argb, 0xFFFFC857);
      expect(LegendSlot.error.argb, 0xFFFF6B6B);
      expect(LegendSlot.exited.argb, 0xFF474D5E);
      expect(LegendSlot.waitingReports.icon, '✉');
      expect(LegendSlot.myTurn.icon, '❗');
      expect(LegendSlot.waiting.icon, '◷');
      expect(LegendSlot.error.icon, '⚠');
      expect(LegendSlot.working.icon, '');
    });

    test('색만으로 구분하지 않는다 — 보고 대기만 점선 링(한가와 같은 초록)', () {
      expect(LegendSlot.waitingReports.dashedRing, isTrue);
      expect(LegendSlot.values.where((s) => s.dashedRing), hasLength(1));
      expect(LegendSlot.waitingReports.argb, LegendSlot.idle.argb);
    });

    test('작업: working · delegating · reporting', () {
      expect(legendSlotOf(sm(status: MemberStatus.working)), LegendSlot.working);
      expect(legendSlotOf(sm(status: MemberStatus.working, derived: DerivedStatus.working)), LegendSlot.working);
      expect(legendSlotOf(sm(eventKind: OfficeEventKind.delegating)), LegendSlot.working);
      expect(legendSlotOf(sm(eventKind: OfficeEventKind.reporting)), LegendSlot.working);
    });

    test('한가: idle · free', () {
      expect(legendSlotOf(sm(status: MemberStatus.idle)), LegendSlot.idle);
      expect(legendSlotOf(sm(status: MemberStatus.idle, derived: DerivedStatus.free)), LegendSlot.idle);
    });

    test('보고 대기: 파생 waiting_reports (부하 보고를 기다림)', () {
      expect(legendSlotOf(sm(derived: DerivedStatus.waitingReports)), LegendSlot.waitingReports);
    });

    test('내 차례: waiting_approval · 부장 ask_user(파생 waiting_answer) · 내 책상 줄', () {
      expect(legendSlotOf(sm(status: MemberStatus.waitingApproval)), LegendSlot.myTurn);
      expect(legendSlotOf(sm(status: MemberStatus.waitingAnswer)), LegendSlot.myTurn);
      expect(legendSlotOf(sm(derived: DerivedStatus.waitingAnswer)), LegendSlot.myTurn);
      expect(legendSlotOf(sm(queueIndex: 0)), LegendSlot.myTurn);
    });

    test('대기: ask_parent 답 대기 · 셸 락 · 출근 중', () {
      expect(legendSlotOf(sm(askParentDeskIndex: 1, derived: DerivedStatus.waitingAnswer)), LegendSlot.waiting);
      expect(legendSlotOf(sm(status: MemberStatus.working, shellWaiting: true)), LegendSlot.waiting);
      expect(legendSlotOf(sm(status: MemberStatus.starting)), LegendSlot.waiting);
    });

    test('오류·퇴근이 무엇보다 먼저', () {
      expect(legendSlotOf(sm(status: MemberStatus.error, queueIndex: 0)), LegendSlot.error);
      expect(legendSlotOf(sm(status: MemberStatus.exited, derived: DerivedStatus.waitingReports)), LegendSlot.exited);
    });

    test('장면에서 만든 멤버도 같은 매핑을 쓴다(셸 락 · 보고 대기)', () {
      final scene = OfficeScene.build(
        members: {
          'mH': head('mH', name: '부장', createdAt: '0'),
          'mL': lead('mL', name: '반장', status: MemberStatus.working, parentId: 'mH', createdAt: '1'),
        },
        latestEvents: {
          'mL': event('mL', OfficeEventKind.running,
              detail: {'cmd': 'flutter test', 'waiting': 'shell-lock', 'summary': '셸 대기 중 (락: 작가)'}),
        },
        pending: const {},
        derived: const {'mH': DerivedStatus.waitingReports},
      );
      expect(scene.memberById('mL')!.isShellWaiting, isTrue);
      expect(scene.memberById('mL')!.legendSlot, LegendSlot.waiting);
      expect(scene.memberById('mH')!.legendSlot, LegendSlot.waitingReports);
    });
  });

  group('글자 빼기(패스 1 D7) · 모니터 2줄(패스 4)', () {
    test('숨기는 순서: 엔진 배지 → 직급 배지 글자 → 이름은 마지막까지', () {
      expect(showsEngineBadge(1.0), isTrue);
      expect(showsEngineBadge(0.79), isFalse);
      expect(showsRankLabel(0.79), isTrue, reason: '엔진이 먼저 빠진다');
      expect(showsRankLabel(0.69), isFalse);
      expect(rankBadgeAt(MemberRank.head, 1.0), '♛ 부장');
      expect(rankBadgeAt(MemberRank.head, 0.65), '♛', reason: '아이콘만');
      expect(rankBadgeAt(MemberRank.lead, 0.65), '★');
      expect(rankBadgeAt(MemberRank.member, 1.0), '');
    });

    test('모니터 둘째 줄은 scale 0.7 미만에서 숨긴다', () {
      expect(showsMonitorSecondLine(0.7), isTrue);
      expect(showsMonitorSecondLine(0.69), isFalse);
    });

    test('각 줄 22자, 첫 줄 = 명령/도구 · 둘째 줄 = 결과 요약', () {
      final e = event('m', OfficeEventKind.running, detail: {'cmd': 'x' * 40, 'summary': '테스트 12개 통과'});
      final scene = OfficeScene.build(
        members: {'m': member('m', name: '이음', status: MemberStatus.working)},
        latestEvents: {'m': e},
        pending: const {},
      );
      final m = scene.members.single;
      expect(m.monitorTop.runes.length, monitorMaxChars);
      expect(m.monitorTop.endsWith('…'), isTrue);
      expect(m.monitorBottom, '테스트 12개 통과');
    });

    test('첫 줄과 같은 내용이면 둘째 줄을 만들지 않는다(셸 락 대기 포함)', () {
      expect(monitorSecondLine(MemberStatus.working, event('m', OfficeEventKind.running, detail: {'cmd': 'ls'})), isNull);
      expect(
          monitorSecondLine(MemberStatus.working,
              event('m', OfficeEventKind.running, detail: {'cmd': 'ls', 'waiting': 'shell-lock', 'summary': '셸 대기 중'})),
          isNull);
      expect(monitorSecondLine(MemberStatus.exited, event('m', OfficeEventKind.text, detail: {'summary': '끝'})), isNull);
      expect(
          monitorSecondLine(MemberStatus.working, event('m', OfficeEventKind.editing, detail: {'path': 'a.dart'}),
              askingParent: true),
          isNull);
    });

    test('복구 이벤트 판정(`[RESUMED]` / text{summary:resumed})', () {
      expect(isResumeEvent(event('m', OfficeEventKind.text, detail: {'summary': 'resumed'})), isTrue);
      expect(isResumeEvent(event('m', OfficeEventKind.text, detail: {'text': '[RESUMED] 이어서 하세요'})), isTrue);
      expect(isResumeEvent(event('m', OfficeEventKind.text, detail: {'text': '끝났어요'})), isFalse);
      expect(isResumeEvent(event('m', OfficeEventKind.idle)), isFalse);
      expect(isResumeEvent(null), isFalse);
    });
  });
}
