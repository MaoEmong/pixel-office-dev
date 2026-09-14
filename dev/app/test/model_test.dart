// PROTOCOL.md / store/types.ts 의 예시 JSON 이 모델로 파싱되는지.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';

const teamJson = '''
{ "id": "t1", "name": "pixel", "cwd": "D:\\\\myproject\\\\pixel-office", "leaderId": null,
  "maxMembers": 5, "allowedEngines": ["claude", "codex"], "createdAt": "2026-09-14T16:31:15.520Z" }
''';

const memberJson = '''
{ "id": "m3", "teamId": "t1", "name": "철수", "rank": "member", "engine": "claude",
  "sessionId": "b2c1", "childPid": 1234, "cwd": "D:\\\\myproject\\\\pixel-office",
  "status": "waiting_approval", "hiredBy": "user", "memberToken": "abc",
  "instructionsPath": null, "createdAt": "2026-09-14T16:31:15.520Z", "updatedAt": "2026-09-14T16:40:00.000Z" }
''';

// 01-설계문서 §2 예시
const eventJson = '''
{ "seq": 812, "ts": "2026-09-14T16:40:00.000Z", "teamId": "t1", "memberId": "m3",
  "kind": "waiting_approval",
  "detail": { "tool": "Bash", "path": "app/...", "cmd": "flutter test", "summary": "테스트 실행" },
  "ref": { "approvalId": "a9", "questionId": null, "taskId": null } }
''';

const pendingJson = '''
{ "id": "a9", "memberId": "m3", "type": "approval",
  "payload": { "tool_name": "Bash", "tool_input": { "command": "flutter test" } },
  "status": "open", "createdAt": "2026-09-14T16:40:00.000Z", "answeredAt": null, "answer": null }
''';

const questionJson = '''
{ "id": "q1", "memberId": "m3", "type": "question",
  "payload": { "tool_input": { "questions": [ { "question": "어느 폴더?", "options": [ {"label": "app"}, {"label": "daemon"} ] } ] } },
  "status": "open", "createdAt": "2026-09-14T16:40:00.000Z", "answeredAt": null, "answer": null }
''';

const taskJson = '''
{ "id": 7, "teamId": "t1", "fromMember": "user", "toMember": "m3", "instruction": "테스트 돌려줘",
  "status": "assigned", "reportText": null, "reportStatus": null,
  "createdAt": "2026-09-14T16:39:00.000Z", "updatedAt": "2026-09-14T16:39:30.000Z" }
''';

Map<String, dynamic> j(String s) => jsonDecode(s) as Map<String, dynamic>;

void main() {
  test('Team.fromJson', () {
    final t = Team.fromJson(j(teamJson));
    expect(t.id, 't1');
    expect(t.leaderId, isNull);
    expect(t.maxMembers, 5);
    expect(t.allowedEngines, [Engine.claude, Engine.codex]);
    expect(t.cwd, r'D:\myproject\pixel-office');
  });

  test('Member.fromJson + status enum wire', () {
    final m = Member.fromJson(j(memberJson));
    expect(m.name, '철수');
    expect(m.status, MemberStatus.waitingApproval);
    expect(m.status.wire, 'waiting_approval');
    expect(m.status.isWaiting, isTrue);
    expect(m.engine, Engine.claude);
    expect(m.rank, MemberRank.member);
    expect(m.childPid, 1234);
    expect(m.instructionsPath, isNull);
    expect(m.copyWith(status: MemberStatus.exited).status.isGone, isTrue);
    for (final s in ['starting', 'idle', 'working', 'waiting_approval', 'waiting_answer', 'exited', 'error']) {
      expect(MemberStatus.parse(s).wire, s);
    }
    expect(() => MemberStatus.parse('sleeping'), throwsFormatException);
  });

  test('DerivedStatus: v1a 규칙 + waiting_reports', () {
    expect(DerivedStatus.fromStatus(MemberStatus.idle, hasAssignedTask: false), DerivedStatus.free);
    expect(DerivedStatus.fromStatus(MemberStatus.idle, hasAssignedTask: true), DerivedStatus.idle);
    expect(DerivedStatus.fromStatus(MemberStatus.working, hasAssignedTask: false), DerivedStatus.working);
    expect(DerivedStatus.parse('waiting_reports'), DerivedStatus.waitingReports);
  });

  test('OfficeEvent.fromJson (설계문서 §2 예시) + kind 11종', () {
    final e = OfficeEvent.fromJson(j(eventJson));
    expect(e.seq, 812);
    expect(e.kind, OfficeEventKind.waitingApproval);
    expect(e.kind.isAlert, isTrue);
    expect(e.detail.tool, 'Bash');
    expect(e.detail.cmd, 'flutter test');
    expect(e.detail.oneLine, '테스트 실행');
    expect(e.ref.approvalId, 'a9');
    expect(e.ref.questionId, isNull);
    expect(e.ref.pendingId, 'a9');
    const kinds = ['thinking', 'text', 'reading', 'editing', 'running', 'waiting_approval', 'asking', 'delegating', 'reporting', 'idle', 'error'];
    expect(OfficeEventKind.values.length, 11);
    for (final k in kinds) {
      expect(OfficeEventKind.parse(k).wire, k);
    }
    expect(() => OfficeEventKind.parse('dancing'), throwsFormatException);
    // detail/ref 생략·확장 키
    final e2 = OfficeEvent.fromJson({'seq': 1, 'ts': 't', 'teamId': 't1', 'memberId': 'm1', 'kind': 'error', 'detail': {'summary': 'process exited (code 1)', 'exitCode': 1}});
    expect(e2.detail.exitCode, 1);
    expect(e2.ref.pendingId, isNull);
    expect(e2.detail['exitCode'], 1);
  });

  test('Pending.fromJson + summary', () {
    final p = Pending.fromJson(j(pendingJson));
    expect(p.type, PendingType.approval);
    expect(p.status, PendingStatus.open);
    expect(p.summary, 'Bash flutter test');
    final q = Pending.fromJson(j(questionJson));
    expect(q.type, PendingType.question);
    expect(q.summary, '어느 폴더?');
  });

  test('Task.fromJson', () {
    final t = Task.fromJson(j(taskJson));
    expect(t.id, 7);
    expect(t.fromMember, userActor);
    expect(t.status, TaskStatus.assigned);
    expect(t.status.isOpen, isTrue);
    expect(t.reportStatus, isNull);
    final done = Task.fromJson({...j(taskJson), 'status': 'reported', 'reportStatus': 'done', 'reportText': 'ok'});
    expect(done.reportStatus, ReportStatus.done);
    expect(done.status.isOpen, isFalse);
  });

  test('Snapshot.fromJson (hello 결과의 snapshot)', () {
    final s = Snapshot.fromJson({
      'seq': 812,
      'teams': [j(teamJson)],
      'members': [j(memberJson)],
      'pending': [j(pendingJson)],
      'tasks': [j(taskJson)],
    });
    expect(s.seq, 812);
    expect(s.teams.single.name, 'pixel');
    expect(s.members.single.id, 'm3');
    expect(s.pending.single.id, 'a9');
    expect(s.tasks.single.id, 7);
    final empty = Snapshot.fromJson({'seq': 0});
    expect(empty.teams, isEmpty);
  });

  test('member.status / daemon.notice 알림', () {
    final n = MemberStatusNotice.fromJson({'memberId': 'm3', 'status': 'idle', 'derived': 'free', 'member': j(memberJson)});
    expect(n.status, MemberStatus.idle);
    expect(n.derived, DerivedStatus.free);
    expect(n.member?.name, '철수');
    final gone = MemberStatusNotice.fromJson({'memberId': 'm3', 'status': 'exited', 'derived': 'exited'});
    expect(gone.member, isNull);
    final d = DaemonNotice.fromJson({'level': 'warn', 'message': '복구: 1명 재개'});
    expect(d.level, NoticeLevel.warn);
    expect(d.message, contains('복구'));
  });
}
