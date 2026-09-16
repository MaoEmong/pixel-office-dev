// 상태 층: 가짜 데몬에 붙어 스냅샷 → 맵, member.status → 상태/행 삽입, event → 링버퍼/말풍선/pending 파생.
import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/rpc/rpc_client.dart';
import 'package:pixel_office/state/office_state.dart';

import 'fake_daemon.dart';

Map<String, dynamic> member(String id, {String status = 'idle', String name = ''}) => {
      'id': id, 'teamId': 't1', 'name': name.isEmpty ? id : name, 'rank': 'member', 'engine': 'claude',
      'sessionId': null, 'childPid': null, 'cwd': 'D:/x', 'status': status, 'hiredBy': 'user',
      'memberToken': 'mt', 'instructionsPath': null, 'createdAt': 'c', 'updatedAt': 'u',
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
      'teams': [
        {'id': 't1', 'name': 'pixel', 'cwd': 'D:/x', 'leaderId': null, 'maxMembers': 5, 'allowedEngines': ['claude'], 'createdAt': 'c'},
      ],
      'members': [member('m1', status: 'working'), member('m2', status: 'idle')],
      'pending': [
        {'id': 'a1', 'memberId': 'm1', 'type': 'approval', 'payload': {'tool_name': 'Bash', 'tool_input': {'command': 'ls'}}, 'status': 'open', 'createdAt': 'c', 'answeredAt': null, 'answer': null},
      ],
      'tasks': [
        {'id': 1, 'teamId': 't1', 'fromMember': 'user', 'toMember': 'm1', 'instruction': 'go', 'status': 'assigned', 'reportText': null, 'reportStatus': null, 'createdAt': 'c', 'updatedAt': 'u'},
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
}
