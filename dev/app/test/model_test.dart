// PROTOCOL.md / store/types.ts 의 예시 JSON 이 모델로 파싱되는지.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';

const departmentJson = '''
{ "id": "d1", "name": "alpha", "cwd": "D:\\\\myproject\\\\pixel-office", "headId": "mH",
  "createdAt": "2026-09-16T10:00:00.000Z" }
''';

const teamJson = '''
{ "id": "t1", "departmentId": "d1", "name": "pixel", "cwd": "D:\\\\myproject\\\\pixel-office", "leaderId": null,
  "maxMembers": 5, "allowedEngines": ["claude", "codex"], "createdAt": "2026-09-14T16:31:15.520Z" }
''';

const memberJson = '''
{ "id": "m3", "departmentId": "d1", "teamId": "t1", "parentId": "mL", "name": "철수", "rank": "member", "engine": "claude",
  "sessionId": "b2c1", "childPid": 1234, "cwd": "D:\\\\myproject\\\\pixel-office",
  "status": "waiting_approval", "hiredBy": "user", "memberToken": "abc",
  "instructionsPath": null, "createdAt": "2026-09-14T16:31:15.520Z", "updatedAt": "2026-09-14T16:40:00.000Z" }
''';

/// 부장 행 — 팀에 속하지 않는다(`teamId`/`parentId` null, D-33).
const headJson = '''
{ "id": "mH", "departmentId": "d1", "teamId": null, "parentId": null, "name": "부장", "rank": "head", "engine": "claude",
  "sessionId": null, "childPid": 20680, "cwd": "D:\\\\myproject\\\\pixel-office",
  "status": "idle", "hiredBy": "user", "memberToken": "abc",
  "instructionsPath": null, "createdAt": "2026-09-16T10:00:01.000Z", "updatedAt": "2026-09-16T10:00:02.000Z" }
''';

// 01-설계문서 §2 예시
const eventJson = '''
{ "seq": 812, "ts": "2026-09-14T16:40:00.000Z", "departmentId": "d1", "teamId": "t1", "memberId": "m3",
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

/// TeamTools `ask_user`(T17, D-19) — 부장만 쓴다.
const askUserJson = '''
{ "id": "q2", "memberId": "mH", "type": "question",
  "payload": { "source": "ask_user", "question": "배포할까요?", "options": ["네", "아니오"] },
  "status": "open", "createdAt": "2026-09-16T10:05:00.000Z", "answeredAt": null, "answer": null }
''';

/// TeamTools `ask_parent`(T35) — 상사에게 가는 질문. 사용자 카드가 아니다(T37).
const askParentJson = '''
{ "id": "q3", "memberId": "m3", "type": "question",
  "payload": { "source": "ask_parent", "question": "이 폴더 지워도 됩니까?", "options": ["네", "아니오"],
               "from": "m3", "to": "mL" },
  "status": "open", "createdAt": "2026-09-16T10:06:00.000Z", "answeredAt": null, "answer": null }
''';

const taskJson = '''
{ "id": 7, "departmentId": "d1", "fromMember": "user", "toMember": "m3", "instruction": "테스트 돌려줘",
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

  // ---- T37 rev 3: 부서 · 트리 · 직급 -------------------------------------------------

  test('Department.fromJson + 스냅샷 departments[]', () {
    final d = Department.fromJson(j(departmentJson));
    expect(d.id, 'd1');
    expect(d.name, 'alpha');
    expect(d.cwd, r'D:\myproject\pixel-office');
    expect(d.headId, 'mH');
    final s = Snapshot.fromJson({'seq': 3, 'departments': [j(departmentJson)]});
    expect(s.departments.single.id, 'd1');
    // 옛 데몬(부서 없는 스냅샷)도 죽지 않는다.
    expect(Snapshot.fromJson({'seq': 0}).departments, isEmpty);
  });

  test('MemberRank: head|lead|member 와 레거시 leader→lead, 라벨·배지', () {
    expect(MemberRank.parse('head'), MemberRank.head);
    expect(MemberRank.parse('lead'), MemberRank.lead);
    expect(MemberRank.parse('member'), MemberRank.member);
    // rev 2 의 'leader' 를 만나도(옛 데몬·옛 기록) 팀장으로 읽는다.
    expect(MemberRank.parse('leader'), MemberRank.lead);
    expect(() => MemberRank.parse('boss'), throwsFormatException);
    expect(MemberRank.head.label, '부장');
    expect(MemberRank.lead.label, '팀장');
    expect(MemberRank.member.label, '팀원');
    // 사용자와 직접 말하는 직급은 부장뿐(D-32).
    expect(MemberRank.head.talksToUser, isTrue);
    expect(MemberRank.lead.talksToUser, isFalse);
    expect(MemberRank.member.talksToUser, isFalse);
  });

  test('Member: departmentId · parentId · nullable teamId (부장은 팀 없음)', () {
    final m = Member.fromJson(j(memberJson));
    expect(m.departmentId, 'd1');
    expect(m.teamId, 't1');
    expect(m.parentId, 'mL');
    expect(m.rank, MemberRank.member);

    final h = Member.fromJson(j(headJson));
    expect(h.rank, MemberRank.head);
    expect(h.teamId, isNull); // 부서 직속(D-33)
    expect(h.parentId, isNull);
    expect(h.copyWith(status: MemberStatus.exited).parentId, isNull);

    // 옛 데몬(부서·트리 칼럼 없는 행)도 파싱된다.
    final legacy = Member.fromJson({...j(memberJson)}..removeWhere((k, _) => k == 'departmentId' || k == 'parentId'));
    expect(legacy.departmentId, '');
    expect(legacy.parentId, isNull);
  });

  test('Team.departmentId / Task.departmentId(옛 teamId 도 읽는다)', () {
    expect(Team.fromJson(j(teamJson)).departmentId, 'd1');
    expect(Task.fromJson(j(taskJson)).departmentId, 'd1');
    // T34 이전 형태(tasks.teamId)도 죽지 않는다.
    final old = Task.fromJson({...j(taskJson)}..['teamId'] = 't1'
      ..remove('departmentId'));
    expect(old.departmentId, 't1');
  });

  test('OfficeEvent.departmentId · detail.waiting · MCP 팀 도구 판정', () {
    final e = OfficeEvent.fromJson(j(eventJson));
    expect(e.departmentId, 'd1');
    expect(e.teamId, 't1');
    // T29 결함 ③: 셸 락 대기는 `running{waiting:'shell-lock', summary, cmd}` 로 온다.
    final wait = OfficeEvent.fromJson({
      'seq': 2,
      'ts': 't',
      'departmentId': 'd1',
      'teamId': 't1',
      'memberId': 'm3',
      'kind': 'running',
      'detail': {'summary': '셸 대기 중 (락: 작가)', 'waiting': 'shell-lock', 'holder': 'm9', 'cmd': 'flutter test'},
    });
    expect(wait.detail.waiting, 'shell-lock');
    expect(wait.detail.holder, 'm9');
    // T29 결함 ④: MCP 팀 도구 호출.
    final tool = OfficeEvent.fromJson({
      'seq': 3, 'ts': 't', 'departmentId': 'd1', 'teamId': 't1', 'memberId': 'm3',
      'kind': 'running', 'detail': {'tool': 'mcp__team__dismiss'},
    });
    expect(tool.detail.isTeamTool, isTrue);
    expect(e.detail.isTeamTool, isFalse);
    // 팀 없는 부장의 이벤트는 teamId 가 '' 다.
    final headEvent = OfficeEvent.fromJson({'seq': 4, 'ts': 't', 'departmentId': 'd1', 'teamId': '', 'memberId': 'mH', 'kind': 'idle'});
    expect(headEvent.teamId, '');
  });

  test('Pending.goesToUser: 허가는 전부 · ask_user 는 부장만 · ask_parent 는 아무에게도', () {
    final approval = Pending.fromJson(j(pendingJson));
    for (final rank in MemberRank.values) {
      expect(approval.goesToUser(rank: rank), isTrue, reason: '셸 허가는 직급 무관 사용자 몫(D-32 3)');
    }
    final askUser = Pending.fromJson(j(askUserJson));
    expect(askUser.isAskUser, isTrue);
    expect(askUser.goesToUser(rank: MemberRank.head), isTrue);
    expect(askUser.goesToUser(rank: MemberRank.lead), isFalse);
    expect(askUser.goesToUser(rank: MemberRank.member), isFalse);

    final askParent = Pending.fromJson(j(askParentJson));
    expect(askParent.isAskParent, isTrue);
    expect(askParent.isAskUser, isFalse);
    expect(askParent.askParentTo, 'mL');
    expect(askParent.askParentFrom, 'm3');
    expect(askParent.summary, '이 폴더 지워도 됩니까?');
    for (final rank in MemberRank.values) {
      expect(askParent.goesToUser(rank: rank), isFalse);
    }
    // TUI AskUserQuestion 은 턴을 붙잡으므로 직급과 무관하게 사용자가 풀어야 한다.
    final tui = Pending.fromJson(j(questionJson));
    expect(tui.goesToUser(rank: MemberRank.member), isTrue);
  });

  test('DerivedStatus: v1a 규칙 + waiting_reports', () {
    expect(DerivedStatus.fromStatus(MemberStatus.idle, hasAssignedTask: false), DerivedStatus.free);
    expect(DerivedStatus.fromStatus(MemberStatus.idle, hasAssignedTask: true), DerivedStatus.idle);
    expect(DerivedStatus.fromStatus(MemberStatus.working, hasAssignedTask: false), DerivedStatus.working);
    expect(DerivedStatus.parse('waiting_reports'), DerivedStatus.waitingReports);
    // T24b: `waiting_reports`(팀장이 위임하고 보고를 기다리는 중) 는 사용자 응답 대기가 아니다 — 줄에 세우지 않는다.
    expect(DerivedStatus.waitingReports.wire, 'waiting_reports');
    expect(DerivedStatus.waitingReports.isWaiting, isFalse);
    // 스냅샷에는 derived 가 없다 — v1a 규칙만으로는 waiting_reports 가 나오지 않는다(데몬 알림으로만 온다).
    expect(DerivedStatus.fromStatus(MemberStatus.idle, hasAssignedTask: true), isNot(DerivedStatus.waitingReports));
    expect(
      MemberStatusNotice.fromJson({'memberId': 'mL', 'status': 'idle', 'derived': 'waiting_reports'}).derived,
      DerivedStatus.waitingReports,
    );
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
