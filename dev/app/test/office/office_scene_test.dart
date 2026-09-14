// OfficeScene: 요약 문자열 규칙, 책상 순서(createdAt), 내 책상 줄 순서(pending 생성 순), 값 비교.
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_scene.dart';

import 'office_fixtures.dart';

void main() {
  group('summarize', () {
    test('이벤트 kind 별 모니터·말풍선 텍스트', () {
      const w = MemberStatus.working;
      expect(summarize(w, event('m', OfficeEventKind.reading, detail: {'tool': 'Read', 'path': 'lib/map/tiles.dart'})), '📖 tiles.dart');
      expect(summarize(w, event('m', OfficeEventKind.editing, detail: {'path': r'D:\proj\app\lib\main.dart'})), '✎ main.dart');
      expect(summarize(w, event('m', OfficeEventKind.running, detail: {'cmd': 'flutter test test/stt_test.dart'})), '▶ flutter test test/stt_test.dart');
      expect(summarize(w, event('m', OfficeEventKind.running, detail: {'cmd': 'x' * 60})), '▶ ${'x' * 39}…');
      expect(summarize(w, event('m', OfficeEventKind.running, detail: {'cmd': 'ls\ncd'})), '▶ ls');
      expect(summarize(w, event('m', OfficeEventKind.thinking)), '…');
      expect(summarize(w, event('m', OfficeEventKind.idle)), '(대기)');
      expect(summarize(w, event('m', OfficeEventKind.waitingApproval, detail: {'cmd': 'rm -rf x'})), '❗ 허가 대기');
      expect(summarize(w, event('m', OfficeEventKind.asking, detail: {'summary': '어느 폴더?'})), '❓ 질문');
      expect(summarize(w, event('m', OfficeEventKind.error, detail: {'summary': '재지시 필요'})), '⚠ 오류');
      expect(summarize(w, event('m', OfficeEventKind.text, detail: {'text': '끝났어요'})), '💬 끝났어요');
      expect(summarize(w, event('m', OfficeEventKind.delegating)), '→ 위임');
      expect(summarize(w, event('m', OfficeEventKind.reporting)), '📋 보고');
    });

    test('path 없는 reading/editing 은 oneLine 으로', () {
      expect(summarize(MemberStatus.working, event('m', OfficeEventKind.reading, detail: {'tool': 'Grep', 'summary': 'MlKit'})), '📖 MlKit');
    });

    test('exited / error 상태는 이벤트보다 우선', () {
      final running = event('m', OfficeEventKind.running, detail: {'cmd': 'ls'});
      expect(summarize(MemberStatus.exited, running), '(퇴근)');
      expect(summarize(MemberStatus.error, running), '⚠ 오류');
    });

    test('이벤트 없으면 status 로', () {
      expect(summarize(MemberStatus.idle, null), '(대기)');
      expect(summarize(MemberStatus.starting, null), '(출근 중)');
      expect(summarize(MemberStatus.working, null), '…');
      expect(summarize(MemberStatus.waitingApproval, null), '❗ 허가 대기');
      expect(summarize(MemberStatus.waitingAnswer, null), '❓ 질문');
    });

    test('alert: waiting 상태 또는 waiting_approval/asking/reporting 이벤트, gone 이면 아니오', () {
      expect(isAlertFor(MemberStatus.waitingApproval, null), isTrue);
      expect(isAlertFor(MemberStatus.working, event('m', OfficeEventKind.reporting)), isTrue);
      expect(isAlertFor(MemberStatus.working, event('m', OfficeEventKind.running)), isFalse);
      expect(isAlertFor(MemberStatus.exited, event('m', OfficeEventKind.asking)), isFalse);
    });

    test('basename / truncate', () {
      expect(basename('a/b/c.dart'), 'c.dart');
      expect(basename(r'C:\a\b\'), 'b');
      expect(basename('plain'), 'plain');
      expect(truncate('가나다라', 4), '가나다라');
      expect(truncate('가나다라마', 4), '가나다…');
    });
  });

  group('pendingLabel', () {
    test('허가: 명령, 질문: 첫 질문', () {
      expect(pendingLabel(approval('a1', 'm1', 'rm -rf build/')), '허가: rm -rf build/');
      expect(pendingLabel(question('q1', 'm1', '어느 폴더에 둘까요?')), '질문: 어느 폴더에 둘까요?');
      final noArg = Pending(id: 'a2', memberId: 'm1', type: PendingType.approval, payload: const {'tool_name': 'WebFetch'}, status: PendingStatus.open, createdAt: 'c', answeredAt: null, answer: null);
      expect(pendingLabel(noArg), '허가: WebFetch');
    });
  });

  group('OfficeScene.build', () {
    test('책상은 createdAt 순, 라벨·배지·말풍선 자르기', () {
      final scene = OfficeScene.build(
        members: {
          'b': member('b', name: '모시', createdAt: '2026-09-15T00:00:02Z', engine: Engine.codex),
          'a': member('a', name: '하루', createdAt: '2026-09-15T00:00:01Z'),
        },
        latestEvents: {'a': event('a', OfficeEventKind.text, detail: {'text': '가' * 40})},
        pending: const {},
      );
      expect(scene.members.map((m) => m.id), ['a', 'b']);
      expect(scene.members[0].deskLabel, '책상 1 · 하루');
      expect(scene.members[1].deskLabel, '책상 2 · 모시');
      expect(scene.members[1].engineLabel, 'Codex');
      expect(scene.members[0].initial, '하');
      expect(scene.members[0].bubbleText.runes.length, bubbleMaxChars);
      expect(scene.members[0].bubbleText.endsWith('…'), isTrue);
      expect(scene.members.every((m) => !m.isQueued), isTrue);
    });

    test('waiting 멤버는 pending 생성 순으로 줄을 선다, 목록도 같은 순서', () {
      final scene = OfficeScene.build(
        members: {
          'm1': member('m1', name: '하루', status: MemberStatus.waitingApproval, createdAt: '1'),
          'm2': member('m2', name: '모시', status: MemberStatus.working, createdAt: '2'),
          'm3': member('m3', name: '이음', status: MemberStatus.waitingAnswer, createdAt: '3'),
        },
        latestEvents: const {},
        pending: {
          'a1': approval('a1', 'm1', 'rm -rf build/', createdAt: '2026-09-15T00:00:09Z'),
          'q1': question('q1', 'm3', '어느 폴더?', createdAt: '2026-09-15T00:00:05Z'),
        },
      );
      expect(scene.memberById('m3')!.queueIndex, 0); // q1 이 먼저 생김
      expect(scene.memberById('m1')!.queueIndex, 1);
      expect(scene.memberById('m2')!.queueIndex, isNull);
      expect(scene.queue.map((q) => q.line(scene.queue.indexOf(q))), ['1. 이음 — 질문: 어느 폴더?', '2. 하루 — 허가: rm -rf build/']);
    });

    test('pending 없이 waiting 인 멤버도 줄에 선다(뒤에), pending 만 남은 working 멤버는 자리에', () {
      final scene = OfficeScene.build(
        members: {
          'm1': member('m1', status: MemberStatus.working, createdAt: '1'),
          'm2': member('m2', status: MemberStatus.waitingApproval, createdAt: '2'),
          'm3': member('m3', status: MemberStatus.waitingAnswer, createdAt: '3'),
        },
        latestEvents: const {},
        pending: {'a1': approval('a1', 'm1', 'ls'), 'a3': approval('a3', 'm3', 'pwd', createdAt: '2026-09-15T00:00:01Z')},
      );
      expect(scene.memberById('m1')!.queueIndex, isNull);
      expect(scene.memberById('m3')!.queueIndex, 0);
      expect(scene.memberById('m2')!.queueIndex, 1);
    });

    test('teamId 를 주면 그 팀 멤버·그 멤버의 pending 만, null 이면 전체', () {
      final members = {
        'a1': member('a1', name: '하루', status: MemberStatus.waitingApproval, createdAt: '1', teamId: 'tA'),
        'b1': member('b1', name: '모시', status: MemberStatus.waitingAnswer, createdAt: '2', teamId: 'tB'),
        'a2': member('a2', name: '이음', createdAt: '3', teamId: 'tA'),
      };
      final pending = {
        'p1': approval('p1', 'a1', 'ls', createdAt: '2026-09-15T00:00:01Z'),
        'p2': question('p2', 'b1', '?', createdAt: '2026-09-15T00:00:02Z'),
      };
      final all = OfficeScene.build(members: members, latestEvents: const {}, pending: pending);
      expect(all.members.map((m) => m.id), ['a1', 'b1', 'a2']);
      expect(all.queue.map((q) => q.pendingId), ['p1', 'p2']);

      final teamA = OfficeScene.build(members: members, latestEvents: const {}, pending: pending, teamId: 'tA');
      expect(teamA.members.map((m) => m.id), ['a1', 'a2']);
      expect(teamA.members.map((m) => m.deskIndex), [0, 1]); // 책상 번호는 팀 안에서 다시 매김
      expect(teamA.queue.map((q) => q.pendingId), ['p1']);
      expect(teamA.memberById('a1')!.queueIndex, 0);

      final none = OfficeScene.build(members: members, latestEvents: const {}, pending: pending, teamId: 'tZ');
      expect(none.isEmpty, isTrue);
      expect(none.queue, isEmpty);
    });

    test('값 비교: 같은 입력이면 같은 장면', () {
      OfficeScene make() => OfficeScene.build(
            members: {'m1': member('m1', status: MemberStatus.working)},
            latestEvents: {'m1': event('m1', OfficeEventKind.running, detail: {'cmd': 'ls'})},
            pending: const {},
          );
      expect(make(), make());
      expect(make().hashCode, make().hashCode);
      expect(make() == OfficeScene.empty, isFalse);
    });
  });
}
