// OfficeScene: 요약 문자열 규칙, 책상 순서(createdAt), 내 책상 줄 순서(pending 생성 순), 값 비교.
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_scene.dart';

import 'office_fixtures.dart';

void main() {
  group('summarize', () {
    test('이벤트 kind 별 모니터·말풍선 텍스트', () {
      const w = MemberStatus.working;
      expect(summarize(w, event('m', OfficeEventKind.reading, detail: {'tool': 'Read', 'path': 'lib/map/tiles.dart'})), '◫ tiles.dart');
      expect(summarize(w, event('m', OfficeEventKind.editing, detail: {'path': r'D:\proj\app\lib\main.dart'})), '✎ main.dart');
      expect(summarize(w, event('m', OfficeEventKind.running, detail: {'cmd': 'flutter test test/stt_test.dart'})), '▶ flutter test test/stt_test.dart');
      expect(summarize(w, event('m', OfficeEventKind.running, detail: {'cmd': 'x' * 60})), '▶ ${'x' * 39}…');
      expect(summarize(w, event('m', OfficeEventKind.running, detail: {'cmd': 'ls\ncd'})), '▶ ls');
      expect(summarize(w, event('m', OfficeEventKind.thinking)), '…');
      expect(summarize(w, event('m', OfficeEventKind.idle)), '(대기)');
      expect(summarize(w, event('m', OfficeEventKind.waitingApproval, detail: {'cmd': 'rm -rf x'})), '❗ 허가 대기');
      expect(summarize(w, event('m', OfficeEventKind.asking, detail: {'summary': '어느 폴더?'})), '❓ 질문');
      expect(summarize(w, event('m', OfficeEventKind.error, detail: {'summary': '재지시 필요'})), '⚠ 오류');
      expect(summarize(w, event('m', OfficeEventKind.text, detail: {'text': '끝났어요'})), '❝ 끝났어요');
      expect(summarize(w, event('m', OfficeEventKind.delegating)), '→ 위임');
      expect(summarize(w, event('m', OfficeEventKind.reporting)), '▤ 보고');
    });

    test('T29 결함 ③: running 이어도 detail.waiting 이 있으면 cmd 가 아니라 summary + ◷', () {
      // 데몬은 셸 락 대기를 `running{summary:"셸 대기 중 (락: 작가)", waiting:"shell-lock", cmd:"…"}` 로 보낸다.
      // cmd 를 우선하면 명령만 보여 "왜 안 도는지" 가 화면에 안 나왔다(T29).
      final waiting = event('m', OfficeEventKind.running, detail: {
        'summary': '셸 대기 중 (락: 작가)',
        'waiting': 'shell-lock',
        'holder': 'm9',
        'cmd': 'flutter test test/stt_test.dart',
      });
      expect(summarize(MemberStatus.working, waiting), '$waitingPrefix 셸 대기 중 (락: 작가)');
      expect(summarize(MemberStatus.working, waiting), isNot(contains('flutter test')));
      // 락을 잡고 실제로 도는 중이면 예전대로 명령을 보여 준다.
      final started = event('m', OfficeEventKind.running, detail: {'cmd': 'flutter test', 'summary': '테스트 실행'});
      expect(summarize(MemberStatus.working, started), '▶ flutter test');
      // 긴 요약은 잘린다.
      final long = event('m', OfficeEventKind.running, detail: {'summary': '셸 대기 중 ${'가' * 60}', 'waiting': 'shell-lock'});
      expect(summarize(MemberStatus.working, long).runes.length, lessThanOrEqualTo(cmdMaxChars + 2));
    });

    test('T37: ask_parent 로 상사 답을 기다리면 "❓ 상사에게 질문" 이 이벤트보다 앞선다', () {
      final idle = event('m', OfficeEventKind.idle);
      expect(summarize(MemberStatus.idle, idle, askingParent: true), askParentSummary);
      expect(isAlertFor(MemberStatus.idle, idle, askingParent: true), isTrue);
      // 퇴근·오류가 먼저다.
      expect(summarize(MemberStatus.exited, idle, askingParent: true), '(퇴근)');
    });

    test('path 없는 reading/editing 은 oneLine 으로', () {
      expect(summarize(MemberStatus.working, event('m', OfficeEventKind.reading, detail: {'tool': 'Grep', 'summary': 'MlKit'})), '◫ MlKit');
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
      // T19b: raw idle 이어도 파생이 waiting_answer 면 alert + "❓ 질문"(ask_user 는 턴을 붙잡지 않는다).
      expect(isAlertFor(MemberStatus.idle, event('m', OfficeEventKind.idle), derived: DerivedStatus.waitingAnswer), isTrue);
      expect(isAlertFor(MemberStatus.idle, event('m', OfficeEventKind.idle), derived: DerivedStatus.free), isFalse);
      expect(summarize(MemberStatus.idle, event('m', OfficeEventKind.idle), derived: DerivedStatus.waitingAnswer), '❓ 질문');
      expect(summarize(MemberStatus.exited, event('m', OfficeEventKind.idle), derived: DerivedStatus.waitingAnswer), '(퇴근)');
    });

    test('T28 파생 free: "(대기)" 자리에서만 "(한가함)" — 방금 한 일은 그대로 보여 준다', () {
      expect(summarize(MemberStatus.idle, event('m', OfficeEventKind.idle), derived: DerivedStatus.free), freeSummary);
      expect(summarize(MemberStatus.idle, null, derived: DerivedStatus.free), freeSummary);
      // 맡은 일이 남아 있으면(파생 idle) 그냥 "(대기)".
      expect(summarize(MemberStatus.idle, event('m', OfficeEventKind.idle), derived: DerivedStatus.idle), '(대기)');
      // 보고 직후처럼 마지막 이벤트가 말해 주는 게 있으면 그걸 남긴다.
      expect(summarize(MemberStatus.idle, event('m', OfficeEventKind.reporting), derived: DerivedStatus.free), '▤ 보고');
      expect(summarize(MemberStatus.idle, event('m', OfficeEventKind.idle), derived: DerivedStatus.waitingReports), waitingReportsSummary);
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
      // T40-2(D7): 책상 라벨은 이름만. 번호는 툴팁·시맨틱에만 남는다.
      expect(scene.members[0].deskLabel, '하루');
      expect(scene.members[1].deskLabel, '모시');
      expect(scene.members[0].deskTooltip, '책상 1 · 하루');
      expect(scene.members[1].deskTooltip, '책상 2 · 모시');
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

    test('열린 pending 이 있으면 raw status 와 무관하게 줄에 선다; pending 없이 waiting 인 멤버는 그 뒤에', () {
      final scene = OfficeScene.build(
        members: {
          'm1': member('m1', status: MemberStatus.working, createdAt: '1'),
          'm2': member('m2', status: MemberStatus.waitingApproval, createdAt: '2'),
          'm3': member('m3', status: MemberStatus.waitingAnswer, createdAt: '3'),
        },
        latestEvents: const {},
        pending: {
          'a3': approval('a3', 'm3', 'pwd', createdAt: '2026-09-15T00:00:01Z'),
          'a1': approval('a1', 'm1', 'ls', createdAt: '2026-09-15T00:00:02Z'),
        },
      );
      expect(scene.memberById('m3')!.queueIndex, 0); // pending 생성 순
      expect(scene.memberById('m1')!.queueIndex, 1); // working 이지만 열린 pending 이 있다
      expect(scene.memberById('m2')!.queueIndex, 2); // pending 없이 waiting → 뒤에
    });

    test('T19b: 부장의 ask_user 질문(raw idle · 파생 waiting_answer)도 내 책상 줄에 서고 말풍선은 "❓ 질문"', () {
      // 데몬은 `asking` 뒤 턴이 끝나면 raw status 를 idle 로 되돌리고 파생만 waiting_answer 로 둔다(T17).
      // T37: `ask_user` 는 부장 전용이다(D-32) — 질문자를 부장으로 둔다.
      final members = {
        'm1': head('m1', name: '모시', status: MemberStatus.idle, createdAt: '1'),
        'm2': member('m2', name: '하루', status: MemberStatus.idle, createdAt: '2'),
      };
      final latest = {'m1': event('m1', OfficeEventKind.idle, seq: 9)};
      final scene = OfficeScene.build(
        members: members,
        latestEvents: latest,
        pending: {'q1': askUserQuestion('q1', 'm1', '점심은?', options: ['김밥', '라면'])},
        derived: const {'m1': DerivedStatus.waitingAnswer, 'm2': DerivedStatus.free},
      );
      expect(scene.memberById('m1')!.queueIndex, 0);
      expect(scene.memberById('m1')!.isAlert, isTrue);
      expect(scene.memberById('m1')!.summary, '❓ 질문');
      expect(scene.memberById('m2')!.queueIndex, isNull);
      expect(scene.queue.single.line(0), '1. 모시 — 질문: 점심은?');

      // 답이 들어가면: pending 이 닫히고 파생이 free 로 → 자기 자리로 돌아간다.
      final after = OfficeScene.build(
        members: members,
        latestEvents: latest,
        pending: const {},
        derived: const {'m1': DerivedStatus.free, 'm2': DerivedStatus.free},
      );
      expect(after.memberById('m1')!.queueIndex, isNull);
      // T28: 파생이 free 면 "(대기)" 자리에 "(한가함)" — 턴도 끝났고 맡은 일도 없다는 뜻.
      expect(after.memberById('m1')!.summary, freeSummary);
      expect(after.queue, isEmpty);
    });

    test('T37: 내 책상 줄 = 허가(전원) + 부장 질문. ask_parent 는 상사 책상으로 간다', () {
      final members = {
        'mH': head('mH', name: '부장', createdAt: '0'),
        'mL': lead('mL', name: '반장', parentId: 'mH', createdAt: '1'),
        'm1': member('m1', name: '이음', parentId: 'mL', createdAt: '2'),
      };
      final scene = OfficeScene.build(
        members: members,
        latestEvents: const {},
        pending: {
          // 팀원의 셸 허가 — 직급과 무관하게 사용자에게 온다(D-32 3).
          'a1': approval('a1', 'm1', 'rm -rf build/', createdAt: '2026-09-16T00:00:01Z'),
          // 부장의 ask_user — 사용자 몫.
          'q1': askUserQuestion('q1', 'mH', '배포할까요?', createdAt: '2026-09-16T00:00:02Z'),
          // 팀장의 ask_parent(부장에게) — 사용자 몫이 아니다.
          'q2': askParentQuestion('q2', 'mL', '스펙 확인 부탁', to: 'mH', createdAt: '2026-09-16T00:00:03Z'),
        },
        derived: const {'mL': DerivedStatus.waitingAnswer, 'mH': DerivedStatus.waitingAnswer},
        teams: {'t1': team('t1', name: 't1')},
      );
      expect(scene.queue.map((q) => q.pendingId), ['a1', 'q1']);
      expect(scene.memberById('m1')!.queueIndex, 0);
      expect(scene.memberById('mH')!.queueIndex, 1);
      // 팀장은 파생이 waiting_answer 여도 사용자 줄에 서지 않고 부장 책상(책상 0) 옆으로 간다.
      expect(scene.memberById('mL')!.queueIndex, isNull);
      expect(scene.memberById('mL')!.askParentDeskIndex, 0);
      expect(scene.memberById('mL')!.summary, askParentSummary);
    });

    test('T37: 팀장의 ask_user 는 사용자 줄에 세우지 않는다(부장 전용 경로)', () {
      final scene = OfficeScene.build(
        members: {
          'mH': head('mH', name: '부장', createdAt: '0'),
          'mL': lead('mL', name: '반장', parentId: 'mH', createdAt: '1'),
        },
        latestEvents: const {},
        pending: {'q1': askUserQuestion('q1', 'mL', '이거 맞나요?')},
        derived: const {'mL': DerivedStatus.waitingAnswer},
      );
      expect(scene.queue, isEmpty);
      expect(scene.memberById('mL')!.queueIndex, isNull);
      // 반대로 TUI AskUserQuestion(턴을 붙잡는 질문)은 직급과 무관하게 사용자만 풀 수 있다 → 줄에 선다.
      final tui = OfficeScene.build(
        members: {'mL': lead('mL', name: '반장', createdAt: '1')},
        latestEvents: const {},
        pending: {'q9': question('q9', 'mL', '어느 폴더?')},
        derived: const {'mL': DerivedStatus.waitingAnswer},
      );
      expect(tui.queue.single.pendingId, 'q9');
    });

    test('departmentId 를 주면 그 부서 멤버·그 멤버의 pending 만, null 이면 전체', () {
      final members = {
        'a1': member('a1', name: '하루', status: MemberStatus.waitingApproval, createdAt: '1', departmentId: 'dA', teamId: 'tA'),
        'b1': member('b1', name: '모시', status: MemberStatus.waitingAnswer, createdAt: '2', departmentId: 'dB', teamId: 'tB'),
        'a2': member('a2', name: '이음', createdAt: '3', departmentId: 'dA', teamId: 'tA'),
      };
      final pending = {
        'p1': approval('p1', 'a1', 'ls', createdAt: '2026-09-15T00:00:01Z'),
        'p2': question('p2', 'b1', '?', createdAt: '2026-09-15T00:00:02Z'),
      };
      final all = OfficeScene.build(members: members, latestEvents: const {}, pending: pending);
      expect(all.members.map((m) => m.id), ['a1', 'a2', 'b1']); // 팀 클러스터 순(tA → tB)
      expect(all.queue.map((q) => q.pendingId), ['p1', 'p2']);

      final deptA = OfficeScene.build(members: members, latestEvents: const {}, pending: pending, departmentId: 'dA');
      expect(deptA.members.map((m) => m.id), ['a1', 'a2']);
      expect(deptA.members.map((m) => m.deskIndex), [0, 1]); // 책상 번호는 부서 안에서 다시 매김
      expect(deptA.queue.map((q) => q.pendingId), ['p1']);
      expect(deptA.memberById('a1')!.queueIndex, 0);

      final none = OfficeScene.build(members: members, latestEvents: const {}, pending: pending, departmentId: 'dZ');
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
