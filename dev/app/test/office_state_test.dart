// 상태 층: 가짜 데몬에 붙어 스냅샷 → 맵, member.status → 상태/행 삽입, event → 링버퍼/말풍선/pending 파생.
import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/rpc/rpc_client.dart';
import 'package:pixel_office/state/office_state.dart';

import 'fake_daemon.dart';

Map<String, dynamic> member(String id,
        {String status = 'idle', String name = '', String rank = 'member', String? parentId, String? teamId = 't1', String createdAt = 'c'}) =>
    {
      'id': id, 'departmentId': 'd1', 'teamId': rank == 'head' ? null : teamId, 'parentId': parentId,
      'name': name.isEmpty ? id : name, 'rank': rank, 'engine': 'claude',
      'sessionId': null, 'childPid': null, 'cwd': 'D:/x', 'status': status, 'hiredBy': 'user',
      'memberToken': 'mt', 'instructionsPath': null, 'createdAt': createdAt, 'updatedAt': 'u',
    };

Future<void> until(ProviderContainer c, bool Function(OfficeState) test, {Duration timeout = const Duration(seconds: 5)}) async {
  if (test(c.read(officeProvider))) return;
  final done = Completer<void>();
  final sub = c.listen<OfficeState>(officeProvider, (_, s) {
    if (test(s) && !done.isCompleted) done.complete();
  });
  try {
    await done.future.timeout(timeout);
  } finally {
    sub.close();
  }
}

void main() {
  late FakeDaemon daemon;
  late ProviderContainer container;

  setUp(() async {
    daemon = FakeDaemon();
    await daemon.start();
    daemon.snapshotBody = {
      'departments': [
        {'id': 'd1', 'name': 'alpha', 'cwd': 'D:/x', 'headId': 'mH', 'createdAt': 'c'},
      ],
      'teams': [
        {'id': 't1', 'departmentId': 'd1', 'name': 'pixel', 'cwd': 'D:/x', 'leaderId': null, 'maxMembers': 5, 'allowedEngines': ['claude'], 'createdAt': 'c'},
      ],
      'members': [member('m1', status: 'working'), member('m2', status: 'idle')],
      'pending': [
        {'id': 'a1', 'memberId': 'm1', 'type': 'approval', 'payload': {'tool_name': 'Bash', 'tool_input': {'command': 'ls'}}, 'status': 'open', 'createdAt': 'c', 'answeredAt': null, 'answer': null},
      ],
      'tasks': [
        {'id': 1, 'departmentId': 'd1', 'fromMember': 'user', 'toMember': 'm1', 'instruction': 'go', 'status': 'assigned', 'reportText': null, 'reportStatus': null, 'createdAt': 'c', 'updatedAt': 'u'},
      ],
    };
    daemon.snapshotSeq = 10;
    container = ProviderContainer(overrides: [
      rpcClientProvider.overrideWith((ref) {
        final c = RpcClient(minBackoff: const Duration(milliseconds: 20), maxBackoff: const Duration(milliseconds: 50));
        ref.onDispose(c.close);
        return c;
      }),
      daemonConnectorProvider.overrideWithValue(DaemonConnector(urlProvider: () => daemon.url, tokenProvider: () => 'tok')),
    ]);
  });

  tearDown(() async {
    container.dispose();
    await daemon.stop();
  });

  test('스냅샷 적용: teams/members/pending/tasks 맵, derived, 연결 상태·데몬 버전', () async {
    await until(container, (s) => s.isConnected && s.members.isNotEmpty);
    final s = container.read(officeProvider);
    expect(container.read(connectionStateProvider), RpcConnectionState.connected);
    expect(container.read(daemonVersionProvider), '9.9.9');
    expect(container.read(teamsProvider).keys, ['t1']);
    expect(container.read(membersProvider).keys, ['m1', 'm2']);
    expect(container.read(memberStatusProvider('m1')), MemberStatus.working);
    expect(container.read(derivedStatusProvider('m2')), DerivedStatus.free); // idle + 배정 없음
    expect(container.read(derivedStatusProvider('m1')), DerivedStatus.working);
    expect(container.read(openPendingProvider).keys, ['a1']);
    expect(container.read(openTasksProvider).keys, [1]);
    expect(container.read(lastSeqProvider), 10);
    expect(s.membersOf('t1').length, 2);
  });

  // ---- T37 rev 3: 부서 · 트리 프로바이더 -------------------------------------------

  test('T37: 스냅샷 departments[] → departmentsProvider · teamsOfDepartmentProvider', () async {
    daemon.snapshotBody = {
      ...daemon.snapshotBody,
      'departments': [
        {'id': 'd1', 'name': 'alpha', 'cwd': 'D:/x', 'headId': 'mH', 'createdAt': '1'},
        {'id': 'd2', 'name': 'beta', 'cwd': 'D:/y', 'headId': null, 'createdAt': '2'},
      ],
      'teams': [
        {'id': 't1', 'departmentId': 'd1', 'name': 'pixel', 'cwd': 'D:/x', 'leaderId': 'mL', 'maxMembers': 5, 'allowedEngines': ['claude'], 'createdAt': '1'},
        {'id': 't2', 'departmentId': 'd2', 'name': 'other', 'cwd': 'D:/y', 'leaderId': null, 'maxMembers': 5, 'allowedEngines': ['claude'], 'createdAt': '2'},
      ],
    };
    await until(container, (s) => s.isConnected && s.departments.isNotEmpty);
    expect(container.read(departmentsProvider).keys, ['d1', 'd2']);
    expect(container.read(departmentProvider('d1'))?.cwd, 'D:/x');
    expect(container.read(teamsOfDepartmentProvider('d1')).map((t) => t.id), ['t1']);
    expect(container.read(teamsOfDepartmentProvider('d2')).map((t) => t.id), ['t2']);
    expect(container.read(teamsOfDepartmentProvider(null)), isEmpty);
  });

  test('T37: liveHead/liveLead 는 행의 rank·status 로 판정한다(headId 가 아니라)', () async {
    daemon.snapshotBody = {
      ...daemon.snapshotBody,
      'members': [
        member('mH0', rank: 'head', status: 'exited', createdAt: '0'), // 나간 부장 — headId 는 아직 이쪽일 수 있다
        member('mH', rank: 'head', name: '부장', createdAt: '1'),
        member('mL', rank: 'lead', name: '반장', parentId: 'mH', createdAt: '2'),
        member('m1', name: '이음', parentId: 'mL', createdAt: '3'),
      ],
    };
    await until(container, (s) => s.isConnected && s.members.length == 4);
    expect(container.read(liveHeadProvider('d1'))?.id, 'mH');
    expect(container.read(liveLeadProvider('t1'))?.id, 'mL');
    expect(container.read(liveHeadProvider('없는부서')), isNull);
    expect(container.read(membersOfDepartmentProvider('d1')).length, 4);

    // 부장이 나가면 살아 있는 부장이 없다 → 지시 바가 비활성되는 상태.
    daemon.push('member.status', {'memberId': 'mH', 'status': 'exited', 'derived': 'exited'});
    await until(container, (s) => s.members['mH']!.status == MemberStatus.exited);
    expect(container.read(liveHeadProvider('d1')), isNull);
  });

  test('T37: childrenProvider / parentProvider 로 트리를 읽는다', () async {
    daemon.snapshotBody = {
      ...daemon.snapshotBody,
      'members': [
        member('mH', rank: 'head', name: '부장', createdAt: '1'),
        member('mL', rank: 'lead', name: '반장', parentId: 'mH', createdAt: '2'),
        member('m1', name: '이음', parentId: 'mL', createdAt: '3'),
        member('m2', name: '하루', parentId: 'mL', createdAt: '4'),
      ],
    };
    await until(container, (s) => s.isConnected && s.members.length == 4);
    expect(container.read(childrenProvider('mH')).map((m) => m.id), ['mL']);
    expect(container.read(childrenProvider('mL')).map((m) => m.id), ['m1', 'm2']); // createdAt 순
    expect(container.read(childrenProvider('m1')), isEmpty);
    expect(container.read(parentProvider('m1'))?.name, '반장');
    expect(container.read(parentProvider('mH')), isNull); // 부장의 상사는 사용자
  });

  test('T37: department.create → 부서·부장이 응답 즉시 상태에 들어가고, delete 는 하위 트리를 지운다', () async {
    await until(container, (s) => s.isConnected && s.members.isNotEmpty);
    daemon.handlers['department.create'] = (p) => {
          'department': {'id': 'dNew', 'name': p['name'], 'cwd': p['cwd'], 'headId': 'mNew', 'createdAt': 'z'},
          'head': {...member('mNew', rank: 'head', name: (p['headName'] as String?) ?? '부장', status: 'starting'), 'departmentId': 'dNew'},
        };
    daemon.handlers['department.delete'] = (_) => {};
    final n = container.read(officeProvider.notifier);
    final r = await n.createDepartment(name: 'gamma', cwd: 'D:/z', headEngine: Engine.claude, headName: '부장');
    expect(r.department.id, 'dNew');
    expect(r.head?.id, 'mNew');
    expect(daemon.paramsOf('department.create'), {'name': 'gamma', 'cwd': 'D:/z', 'headEngine': 'claude', 'headName': '부장'});
    expect(container.read(departmentsProvider).keys, containsAll(['d1', 'dNew']));
    expect(container.read(membersProvider).containsKey('mNew'), isTrue);

    await n.deleteDepartment('d1');
    expect(daemon.paramsOf('department.delete'), {'departmentId': 'd1'});
    expect(container.read(departmentsProvider).keys, ['dNew']);
    expect(container.read(teamsProvider), isEmpty); // d1 의 팀
    expect(container.read(membersProvider).keys, ['mNew']); // d1 의 멤버는 빠지고 새 부장만
  });

  test('T37: events.query 는 departmentId 로 좁힐 수 있다(멤버 백필은 안 쓴다)', () async {
    await until(container, (s) => s.isConnected);
    daemon.handlers['events.query'] = (_) => {'events': [sampleEvent(3, memberId: 'm1')]};
    final n = container.read(officeProvider.notifier);
    final events = await n.queryEvents(departmentId: 'd1', limit: 50);
    expect(events.single.seq, 3);
    expect(daemon.paramsOf('events.query'), {'departmentId': 'd1', 'limit': 50});
    // 부서를 안 주면 키 자체가 안 나간다(옛 이벤트 행의 department_id 가 '' 라 거르면 사라진다).
    await n.queryEvents(memberId: 'm1');
    expect(daemon.paramsOf('events.query'), {'memberId': 'm1'});
  });

  test('T28: 스냅샷 멤버 행의 derived 를 그대로 쓴다(앱이 다시 계산하지 않는다)', () async {
    // 팀장이 위임하고 보고를 기다리는 중 — raw 는 idle 이고 배정 task 도 없어서 앱 혼자서는 free 로 볼 수밖에 없다.
    daemon.snapshotBody = {
      ...daemon.snapshotBody,
      'members': [
        {...member('m1', status: 'idle'), 'rank': 'leader', 'derived': 'waiting_reports'},
        member('m2', status: 'idle'),
      ],
    };
    await until(container, (s) => s.isConnected && s.members.isNotEmpty);
    expect(container.read(derivedStatusProvider('m1')), DerivedStatus.waitingReports);
    expect(container.read(derivedStatusProvider('m2')), DerivedStatus.free, reason: 'derived 가 없으면 예전대로 유추');
  });

  test('member.status: 상태 갱신, member 행 삽입, waiting 해제 시 pending 제거, exited 시 task 제거', () async {
    await until(container, (s) => s.isConnected && s.members.isNotEmpty);
    daemon.push('member.status', {'memberId': 'm1', 'status': 'waiting_approval', 'derived': 'waiting_approval'});
    await until(container, (s) => s.members['m1']!.status == MemberStatus.waitingApproval);
    expect(container.read(openPendingProvider).containsKey('a1'), isTrue);

    daemon.push('member.status', {'memberId': 'm1', 'status': 'working', 'derived': 'working'});
    await until(container, (s) => s.members['m1']!.status == MemberStatus.working);
    expect(container.read(openPendingProvider), isEmpty);

    // 새 멤버 출근(다른 클라이언트가 clockIn) → member 행 포함
    daemon.push('member.status', {'memberId': 'm9', 'status': 'starting', 'derived': 'starting', 'member': member('m9', status: 'starting', name: '신입')});
    await until(container, (s) => s.members.containsKey('m9'));
    expect(container.read(memberProvider('m9'))?.name, '신입');
    expect(container.read(membersOfTeamProvider('t1')).length, 3);

    // 모르는 멤버(행 없음)는 무시
    daemon.push('member.status', {'memberId': 'ghost', 'status': 'idle', 'derived': 'free'});
    daemon.push('member.status', {'memberId': 'm1', 'status': 'exited', 'derived': 'exited'});
    await until(container, (s) => s.members['m1']!.status == MemberStatus.exited);
    expect(container.read(membersProvider).containsKey('ghost'), isFalse);
    expect(container.read(openTasksProvider), isEmpty);
  });

  test('event: 링버퍼(전역·멤버)·latestEvent·waiting_approval→pending·reporting→task 제거·error{pendingId}', () async {
    await until(container, (s) => s.isConnected && s.members.isNotEmpty);
    daemon.emitEvent(sampleEvent(11, memberId: 'm1', kind: 'waiting_approval', detail: {'tool': 'Bash', 'cmd': 'rm -rf x'}, ref: {'approvalId': 'a2'}));
    daemon.emitEvent(sampleEvent(12, memberId: 'm2', kind: 'asking', detail: {'summary': '어느 폴더?'}, ref: {'questionId': 'q1'}));
    daemon.emitEvent(sampleEvent(13, memberId: 'm1', kind: 'reporting', detail: {'summary': '끝'}, ref: {'taskId': 1}));
    daemon.emitEvent(sampleEvent(14, memberId: 'm2', kind: 'error', detail: {'summary': '재지시 필요', 'pendingId': 'q1'}));
    daemon.emitEvent(sampleEvent(10, memberId: 'm2', kind: 'idle')); // 과거 seq → 버림
    await until(container, (s) => s.lastSeq == 14);
    final s = container.read(officeProvider);
    expect(s.events.map((e) => e.seq), [11, 12, 13, 14]);
    expect(container.read(memberEventsProvider('m1')).map((e) => e.seq), [11, 13]);
    expect(container.read(latestEventProvider('m2'))?.seq, 14);
    expect(container.read(openPendingProvider)['a2']?.summary, 'Bash rm -rf x');
    expect(container.read(openPendingProvider).containsKey('q1'), isFalse); // 만료됨
    expect(container.read(openTasksProvider), isEmpty); // reporting 으로 닫힘
  });

  test('T37: ask_parent asking 이벤트로 만든 pending 도 source/from/to 를 갖는다(사용자 몫으로 새지 않게)', () async {
    await until(container, (s) => s.isConnected && s.members.isNotEmpty);
    // 데몬(T35): asking{tool:'ask_parent', summary, options?, to, toName}.
    daemon.emitEvent(sampleEvent(21, memberId: 'm2', kind: 'asking', detail: {
      'tool': 'ask_parent',
      'summary': '이 폴더 지워도 됩니까?',
      'options': ['네', '아니오'],
      'to': 'm1',
      'toName': '하루',
    }, ref: {'questionId': 'q_p1'}));
    await until(container, (s) => s.pending.containsKey('q_p1'));
    final p = container.read(openPendingProvider)['q_p1']!;
    expect(p.isAskParent, isTrue);
    expect(p.isAskUser, isFalse);
    expect(p.askParentFrom, 'm2');
    expect(p.askParentTo, 'm1');
    expect(p.payload['options'], ['네', '아니오']);
    expect(p.goesToUser(rank: MemberRank.member), isFalse);
  });

  test('T19b: ask_user asking → pending 생성(payload source/question/options), raw idle + 파생 waiting_answer 여도 유지', () async {
    await until(container, (s) => s.isConnected && s.members.isNotEmpty);
    daemon.emitEvent(sampleEvent(11, memberId: 'm2', kind: 'asking',
        detail: {'tool': 'ask_user', 'summary': '점심은?', 'options': ['김밥', '라면']}, ref: {'questionId': 'q_1'}));
    await until(container, (s) => s.pending.containsKey('q_1'));
    final p = container.read(openPendingProvider)['q_1']!;
    expect(p.type, PendingType.question);
    expect(p.payload['source'], 'ask_user');
    expect(p.payload['question'], '점심은?');
    expect(p.payload['options'], ['김밥', '라면']);
    expect(p.summary, '점심은?');

    // 실기 순서(T19b): asking → waiting_answer → (PostToolUse) working → text → idle.
    // 중간의 working 알림이 방금 만든 질문 pending 을 지우면 안 된다.
    daemon.push('member.status', {'memberId': 'm2', 'status': 'waiting_answer', 'derived': 'waiting_answer'});
    await until(container, (s) => s.members['m2']!.status == MemberStatus.waitingAnswer);
    daemon.push('member.status', {'memberId': 'm2', 'status': 'working', 'derived': 'working'});
    await until(container, (s) => s.members['m2']!.status == MemberStatus.working);
    expect(container.read(openPendingProvider).containsKey('q_1'), isTrue);

    // 턴이 끝나면 raw 는 idle 로 돌아오고 파생만 waiting_answer.
    daemon.push('member.status', {'memberId': 'm2', 'status': 'idle', 'derived': 'waiting_answer'});
    await until(container, (s) => s.derived['m2'] == DerivedStatus.waitingAnswer);
    expect(container.read(openPendingProvider).containsKey('q_1'), isTrue); // 예전 버그: 여기서 지워졌다
    expect(container.read(memberStatusProvider('m2')), MemberStatus.idle);

    // 답이 들어가면 데몬이 pending 을 닫고 derived 갱신용 member.status 를 한 번 더 보낸다 → 그때 제거.
    daemon.push('member.status', {'memberId': 'm2', 'status': 'idle', 'derived': 'free'});
    await until(container, (s) => s.derived['m2'] == DerivedStatus.free);
    expect(container.read(openPendingProvider).containsKey('q_1'), isFalse);
  });

  test('T19b: 스냅샷의 열린 ask_user 질문 → idle 멤버의 파생은 waiting_answer (재접속·창 다시 열기)', () async {
    daemon.snapshotBody = {
      ...daemon.snapshotBody,
      'pending': [
        {
          'id': 'q_s', 'memberId': 'm2', 'type': 'question',
          'payload': {'source': 'ask_user', 'question': '점심은?', 'options': ['김밥', '라면']},
          'status': 'open', 'createdAt': 'c', 'answeredAt': null, 'answer': null,
        },
      ],
    };
    await until(container, (s) => s.isConnected && s.members.isNotEmpty);
    expect(container.read(memberStatusProvider('m2')), MemberStatus.idle);
    expect(container.read(derivedStatusProvider('m2')), DerivedStatus.waitingAnswer);
    expect(container.read(openPendingProvider)['q_s']?.summary, '점심은?');
    expect(container.read(derivedStatusProvider('m1')), DerivedStatus.working); // 질문 없는 멤버는 그대로
  });

  test('T19b: waiting_approval pending 도 파생이 waiting 인 동안은 유지된다', () async {
    await until(container, (s) => s.isConnected && s.members.isNotEmpty);
    // raw 는 idle 인데 파생만 waiting_approval → a1 유지.
    daemon.push('member.status', {'memberId': 'm1', 'status': 'idle', 'derived': 'waiting_approval'});
    await until(container, (s) => s.derived['m1'] == DerivedStatus.waitingApproval);
    expect(container.read(openPendingProvider).containsKey('a1'), isTrue);
    daemon.push('member.status', {'memberId': 'm1', 'status': 'working', 'derived': 'working'});
    await until(container, (s) => s.derived['m1'] == DerivedStatus.working);
    expect(container.read(openPendingProvider), isEmpty);
  });

  test('T19b: working 알림은 ask_user 질문만 남기고 나머지(허가·TUI 질문)는 지운다', () async {
    await until(container, (s) => s.isConnected && s.members.isNotEmpty);
    final n = container.read(officeProvider.notifier);
    // m1: 스냅샷 허가 a1 + TUI 질문 + ask_user 질문.
    n.applyEvent(OfficeEvent.fromJson(sampleEvent(20, memberId: 'm1', kind: 'asking',
        detail: {'tool': 'AskUserQuestion', 'summary': '어느 폴더?'}, ref: {'questionId': 'q_tui'})));
    n.applyEvent(OfficeEvent.fromJson(sampleEvent(21, memberId: 'm1', kind: 'asking',
        detail: {'tool': 'ask_user', 'summary': '점심은?'}, ref: {'questionId': 'q_mcp'})));
    expect(container.read(openPendingProvider).keys.toSet(), {'a1', 'q_tui', 'q_mcp'});
    expect(container.read(openPendingProvider)['q_tui']!.isAskUser, isFalse);
    expect(container.read(openPendingProvider)['q_mcp']!.isAskUser, isTrue);

    daemon.push('member.status', {'memberId': 'm1', 'status': 'working', 'derived': 'working'});
    await until(container, (s) => s.pending.length == 1);
    expect(container.read(openPendingProvider).keys, ['q_mcp']);

    // raw 가 idle 로 돌아오고 파생이 free 면(= 열린 질문 없음) ask_user 질문도 닫힌다.
    daemon.push('member.status', {'memberId': 'm1', 'status': 'idle', 'derived': 'free'});
    await until(container, (s) => s.pending.isEmpty);
  });

  test('daemon.json 없음: 소켓을 열지 못해도 reconnectAttempts·lastError 가 상태에 반영된다', () async {
    final c = ProviderContainer(overrides: [
      rpcClientProvider.overrideWith((ref) {
        final cl = RpcClient(minBackoff: const Duration(milliseconds: 20), maxBackoff: const Duration(milliseconds: 20));
        ref.onDispose(cl.close);
        return cl;
      }),
      daemonConnectorProvider.overrideWithValue(DaemonConnector(urlProvider: () => null, tokenProvider: () => null)),
    ]);
    try {
      await until(c, (s) => s.reconnectAttempts >= 2);
      expect(c.read(officeProvider).lastError, contains('daemon.json'));
      expect(c.read(connectionStateProvider), RpcConnectionState.disconnected);
    } finally {
      c.dispose();
    }
  });

  test('링버퍼는 2000건에서 오래된 것부터 버린다', () async {
    await until(container, (s) => s.isConnected);
    final n = container.read(officeProvider.notifier);
    for (var i = 1; i <= eventRingCapacity + 5; i++) {
      n.applyEvent(OfficeEvent.fromJson(sampleEvent(100 + i, memberId: 'm1')));
    }
    final s = container.read(officeProvider);
    expect(s.events.length, eventRingCapacity);
    expect(s.events.first.seq, 106);
    expect(s.memberEvents['m1']!.length, eventRingCapacity);
  });

  test('재접속: 스냅샷 재적용, 이벤트 링은 유지, 연결 상태 전이', () async {
    await until(container, (s) => s.isConnected && s.members.isNotEmpty);
    daemon.emitEvent(sampleEvent(11, memberId: 'm1'));
    await until(container, (s) => s.events.length == 1);
    daemon.snapshotBody = {...daemon.snapshotBody, 'members': [member('m1', status: 'exited')], 'pending': [], 'tasks': []};
    daemon.snapshotSeq = 11;
    await daemon.closeAll();
    await until(container, (s) => !s.isConnected);
    await until(container, (s) => s.isConnected && s.members['m1']?.status == MemberStatus.exited);
    expect(daemon.helloParams.last['since'], 11);
    final s = container.read(officeProvider);
    expect(s.members.keys, ['m1']);
    expect(s.pending, isEmpty);
    expect(s.events.length, 1);
    expect(s.reconnectAttempts, 0);
  });

  // T38: 다른 클라이언트(콘솔·다른 창)가 부서·팀을 지우면 데몬이 `snapshot` 알림을 민다 — hello 스냅샷과 **같은 코드**로
  // 적용돼야 유령 부서 탭·책상이 사라진다(T37 함정 ①). 재접속 없이.
  test('T38: 밀려온 snapshot 알림 = hello 스냅샷 — 없어진 부서·팀·멤버·pending·task 가 지워지고 이벤트 링은 남는다', () async {
    daemon.snapshotBody = {
      ...daemon.snapshotBody,
      'departments': [
        {'id': 'd1', 'name': 'alpha', 'cwd': 'D:/x', 'headId': 'mH', 'createdAt': '1'},
        {'id': 'd2', 'name': 'beta', 'cwd': 'D:/y', 'headId': 'mH2', 'createdAt': '2'},
      ],
      'members': [member('mH', rank: 'head', name: '부장'), member('m1', parentId: 'mH')],
    };
    await until(container, (s) => s.isConnected && s.departments.length == 2);
    daemon.emitEvent(sampleEvent(11, memberId: 'm1'));
    await until(container, (s) => s.events.length == 1);
    expect(container.read(openPendingProvider).keys, ['a1']);
    expect(container.read(openTasksProvider).keys, [1]);

    // 콘솔에서 `dept delete beta` 를 했다고 치자 — 데몬이 미는 스냅샷에는 d2 도, 그 행들도 없다.
    daemon.push('snapshot', {
      'seq': 12,
      'departments': [
        {'id': 'd1', 'name': 'alpha', 'cwd': 'D:/x', 'headId': 'mH', 'createdAt': '1'},
      ],
      'teams': <Map<String, dynamic>>[],
      'members': [member('mH', rank: 'head', name: '부장')],
      'pending': <Map<String, dynamic>>[],
      'tasks': <Map<String, dynamic>>[],
    });

    await until(container, (s) => s.departments.length == 1);
    final s = container.read(officeProvider);
    expect(container.read(departmentsProvider).keys, ['d1']);
    expect(container.read(teamsProvider), isEmpty); // 스냅샷에 없는 팀 행은 사라진다
    expect(container.read(membersProvider).keys, ['mH']);
    expect(container.read(openPendingProvider), isEmpty);
    expect(container.read(openTasksProvider), isEmpty);
    expect(container.read(derivedStatusProvider('mH')), DerivedStatus.free);
    expect(container.read(lastSeqProvider), 12);
    expect(s.events.length, 1); // 로컬 이벤트 링·말풍선은 유지(재접속 규칙 4)
    expect(daemon.helloParams.length, 1); // 재접속 없이 적용됐다
  });
}
