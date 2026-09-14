// 오피스 상태(Riverpod). RpcClient 의 hello/알림/이벤트를 받아 스냅샷 기반 맵과 이벤트 링버퍼를 유지한다.
//
// 재접속 규칙(PROTOCOL "재접속 규칙"):
//  1. lastSeq 는 RpcClient 가 기억한다(스냅샷 seq + 통과한 event seq).
//  2. hello{since} → 스냅샷 재적용(teams/members/pending/tasks 교체) → seq > snapshot.seq 이벤트만 적용
//     (RpcClient.events 가 이미 걸러 준다). 이벤트 링버퍼는 재접속해도 지우지 않는다.
//  3. term 은 replay 되지 않는다 — 터미널 탭(T13)이 member.attach 로 화면을 다시 받는다.
//
// 제공 프로바이더(T12~T14 가 쓰는 이름):
//  rpcClientProvider, daemonConnectorProvider, officeProvider(전체 OfficeState),
//  connectionStateProvider, daemonVersionProvider, daemonPidProvider, reconnectAttemptsProvider, lastSeqProvider,
//  teamsProvider, membersProvider, memberProvider(id), memberStatusProvider(id), derivedStatusProvider(id),
//  membersOfTeamProvider(teamId), openPendingProvider, openTasksProvider,
//  globalEventsProvider, memberEventsProvider(id), latestEventProvider(id), noticesProvider.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../rpc/daemon_info.dart';
import '../rpc/rpc_client.dart';

/// 이벤트 링버퍼 크기(전역·멤버별 각각).
const int eventRingCapacity = 2000;

/// daemon.notice 보관 개수.
const int noticeCapacity = 50;

// ---- 연결 설정 ---------------------------------------------------------------

/// 재접속 시도마다 호출되는 url/token 공급자. 기본은 daemon.json.
class DaemonConnector {
  const DaemonConnector({required this.urlProvider, required this.tokenProvider});

  final UrlProvider urlProvider;
  final TokenProvider tokenProvider;

  /// `%LOCALAPPDATA%\pixel-office\daemon.json` 을 매 시도마다 읽는다(token 은 데몬 기동마다 바뀜).
  static DaemonConnector fromDaemonJson({String? path}) => DaemonConnector(
        urlProvider: () async => (await DaemonInfo.read(path: path))?.wsUrl,
        tokenProvider: () async => (await DaemonInfo.read(path: path))?.token,
      );
}

final daemonConnectorProvider = Provider<DaemonConnector>((ref) => DaemonConnector.fromDaemonJson());

final rpcClientProvider = Provider<RpcClient>((ref) {
  final client = RpcClient();
  ref.onDispose(() => client.close());
  return client;
});

// ---- 상태 ----------------------------------------------------------------------

class OfficeState {
  const OfficeState({
    this.connection = RpcConnectionState.disconnected,
    this.daemonVersion,
    this.daemonPid,
    this.lastSeq = 0,
    this.reconnectAttempts = 0,
    this.lastError,
    this.teams = const {},
    this.members = const {},
    this.derived = const {},
    this.pending = const {},
    this.tasks = const {},
    this.events = const [],
    this.memberEvents = const {},
    this.latestEvent = const {},
    this.notices = const [],
  });

  final RpcConnectionState connection;
  final String? daemonVersion;
  final int? daemonPid;
  final int lastSeq;
  final int reconnectAttempts;
  final String? lastError;

  /// 팀 id → Team.
  final Map<String, Team> teams;

  /// 멤버 id → Member(`status` 는 member.status 알림으로 갱신됨).
  final Map<String, Member> members;

  /// 멤버 id → 파생 상태(free 등). 스냅샷에서는 v1a 규칙으로 계산.
  final Map<String, DerivedStatus> derived;

  /// 열린 pending(id → Pending). 스냅샷 + waiting_approval/asking 이벤트로 추가, error{pendingId}·status 변화로 제거.
  final Map<String, Pending> pending;

  /// 열린 task(queued|assigned, id → Task).
  final Map<int, Task> tasks;

  /// 전역 이벤트 링(오래된 것 → 최신, 최대 [eventRingCapacity]).
  final List<OfficeEvent> events;

  /// 멤버별 이벤트 링.
  final Map<String, List<OfficeEvent>> memberEvents;

  /// 멤버별 마지막 이벤트(말풍선).
  final Map<String, OfficeEvent> latestEvent;

  /// daemon.notice 최근 [noticeCapacity]건.
  final List<DaemonNotice> notices;

  bool get isConnected => connection == RpcConnectionState.connected;

  List<Member> membersOf(String teamId) => members.values.where((m) => m.teamId == teamId).toList(growable: false);

  OfficeState copyWith({
    RpcConnectionState? connection,
    String? daemonVersion,
    int? daemonPid,
    int? lastSeq,
    int? reconnectAttempts,
    String? lastError,
    bool clearError = false,
    Map<String, Team>? teams,
    Map<String, Member>? members,
    Map<String, DerivedStatus>? derived,
    Map<String, Pending>? pending,
    Map<int, Task>? tasks,
    List<OfficeEvent>? events,
    Map<String, List<OfficeEvent>>? memberEvents,
    Map<String, OfficeEvent>? latestEvent,
    List<DaemonNotice>? notices,
  }) =>
      OfficeState(
        connection: connection ?? this.connection,
        daemonVersion: daemonVersion ?? this.daemonVersion,
        daemonPid: daemonPid ?? this.daemonPid,
        lastSeq: lastSeq ?? this.lastSeq,
        reconnectAttempts: reconnectAttempts ?? this.reconnectAttempts,
        lastError: clearError ? null : (lastError ?? this.lastError),
        teams: teams ?? this.teams,
        members: members ?? this.members,
        derived: derived ?? this.derived,
        pending: pending ?? this.pending,
        tasks: tasks ?? this.tasks,
        events: events ?? this.events,
        memberEvents: memberEvents ?? this.memberEvents,
        latestEvent: latestEvent ?? this.latestEvent,
        notices: notices ?? this.notices,
      );
}

List<T> _push<T>(List<T> list, T item, int cap) {
  if (list.length < cap) return List<T>.of(list, growable: true)..add(item);
  return List<T>.of(list.sublist(list.length - cap + 1), growable: true)..add(item);
}

class OfficeNotifier extends Notifier<OfficeState> {
  final List<StreamSubscription<dynamic>> _subs = [];

  @override
  OfficeState build() {
    final client = ref.watch(rpcClientProvider);
    final connector = ref.watch(daemonConnectorProvider);
    _subs.add(client.stateStream.listen(_onConnection));
    _subs.add(client.hellos.listen(_onHello));
    _subs.add(client.events.listen(_onEventJson));
    _subs.add(client.notifications.listen(_onNotification));
    _subs.add(client.attemptStream.listen(_onAttempt));
    ref.onDispose(() {
      for (final s in _subs) {
        s.cancel();
      }
      _subs.clear();
    });
    client.start(urlProvider: connector.urlProvider, tokenProvider: connector.tokenProvider);
    return OfficeState(connection: client.state);
  }

  RpcClient get client => ref.read(rpcClientProvider);

  // ---- RPC 편의 (T14 가 확장) --------------------------------------------------

  /// 지시 → task 생성. 결과 taskId 로 로컬 tasks 에 queued 행을 미리 넣는다(스냅샷이 오면 교체됨).
  Future<int> instruct(String memberId, String text) async {
    final r = await client.call('member.instruct', {'memberId': memberId, 'text': text});
    final taskId = (r['taskId'] as num).toInt();
    final m = state.members[memberId];
    final now = DateTime.now().toUtc().toIso8601String();
    upsertTask(Task(
      id: taskId,
      teamId: m?.teamId ?? '',
      fromMember: userActor,
      toMember: memberId,
      instruction: text,
      status: TaskStatus.queued,
      reportText: null,
      reportStatus: null,
      createdAt: now,
      updatedAt: now,
    ));
    return taskId;
  }

  Future<void> respondApproval(String pendingId, {required bool allow, String? message, bool alwaysThisSession = false}) async {
    await client.call('approval.respond', {
      'pendingId': pendingId,
      'behavior': allow ? 'allow' : 'deny',
      'message': ?message,
      if (alwaysThisSession) 'alwaysThisSession': true,
    });
    removePending(pendingId);
  }

  Future<void> respondQuestion(String pendingId, Map<String, String> answers) async {
    await client.call('question.respond', {'pendingId': pendingId, 'answers': answers});
    removePending(pendingId);
  }

  void upsertTask(Task t) => state = state.copyWith(tasks: {...state.tasks, t.id: t});
  void removeTask(int id) => state = state.copyWith(tasks: {...state.tasks}..remove(id));
  void removePending(String id) => state = state.copyWith(pending: {...state.pending}..remove(id));

  // ---- 수신 처리 -------------------------------------------------------------------

  void _onConnection(RpcConnectionState s) {
    state = state.copyWith(
      connection: s,
      reconnectAttempts: client.reconnectAttempts,
      lastError: client.lastError?.toString(),
      clearError: s == RpcConnectionState.connected,
    );
  }

  void _onAttempt(int attempts) {
    state = state.copyWith(
      reconnectAttempts: attempts,
      lastError: client.lastError?.toString(),
      clearError: attempts == 0,
    );
  }

  void _onHello(HelloResult h) {
    final snap = Snapshot.fromJson(h.snapshot);
    state = _applySnapshot(state, snap).copyWith(
      daemonVersion: h.daemonVersion,
      daemonPid: h.daemonPid,
      lastSeq: client.lastSeq,
      reconnectAttempts: 0,
      clearError: true,
    );
  }

  static OfficeState _applySnapshot(OfficeState s, Snapshot snap) {
    final teams = {for (final t in snap.teams) t.id: t};
    final members = {for (final m in snap.members) m.id: m};
    final pending = {for (final p in snap.pending) p.id: p};
    final tasks = {for (final t in snap.tasks) t.id: t};
    final assigned = {for (final t in snap.tasks) if (t.status == TaskStatus.assigned) t.toMember};
    final derived = {
      for (final m in snap.members) m.id: DerivedStatus.fromStatus(m.status, hasAssignedTask: assigned.contains(m.id)),
    };
    return s.copyWith(
      teams: teams,
      members: members,
      derived: derived,
      pending: pending,
      tasks: tasks,
      lastSeq: snap.seq > s.lastSeq ? snap.seq : s.lastSeq,
    );
  }

  void _onNotification(RpcNotification n) {
    switch (n.method) {
      case 'member.status':
        _onMemberStatus(MemberStatusNotice.fromJson(n.params));
      case 'snapshot':
        state = _applySnapshot(state, Snapshot.fromJson(n.params)).copyWith(lastSeq: client.lastSeq);
      case 'daemon.notice':
        final notice = DaemonNotice.fromJson(n.params);
        state = state.copyWith(notices: _push(state.notices, notice, noticeCapacity));
      // 'event' 는 client.events(중복 제거)로, 'term' 은 터미널 탭(T13)이 notifications 를 직접 구독.
    }
  }

  void _onMemberStatus(MemberStatusNotice n) {
    final members = {...state.members};
    final existing = members[n.memberId];
    if (n.member != null) {
      members[n.memberId] = n.member!;
    } else if (existing != null) {
      members[n.memberId] = existing.copyWith(status: n.status);
    } else {
      // 행이 삭제된(team.delete) 멤버의 마지막 상태 — 모르는 멤버면 무시.
      return;
    }
    final derived = {...state.derived, n.memberId: n.derived};
    var pending = state.pending;
    var tasks = state.tasks;
    if (!n.status.isWaiting) {
      // 허가/질문에 응답이 끝났거나(→working) 멤버가 사라졌다 — 그 멤버의 열린 pending 은 닫힌 것.
      final open = pending.values.where((p) => p.memberId == n.memberId).toList();
      if (open.isNotEmpty) {
        pending = {...pending}..removeWhere((_, p) => p.memberId == n.memberId);
      }
    }
    if (n.status.isGone) {
      // clockOut / 프로세스 종료 → 그 멤버의 미종료 task 는 aborted.
      if (tasks.values.any((t) => t.toMember == n.memberId)) {
        tasks = {...tasks}..removeWhere((_, t) => t.toMember == n.memberId);
      }
    }
    state = state.copyWith(members: members, derived: derived, pending: pending, tasks: tasks);
  }

  void _onEventJson(Map<String, dynamic> json) {
    final OfficeEvent ev;
    try {
      ev = OfficeEvent.fromJson(json);
    } on FormatException {
      return; // 모르는 kind(프로토콜 확장) — 무시
    } on TypeError {
      return;
    }
    applyEvent(ev);
  }

  /// 이벤트 하나 적용(링버퍼·말풍선·pending/task 파생). 테스트에서도 직접 호출.
  void applyEvent(OfficeEvent ev) {
    final memberEvents = {...state.memberEvents};
    memberEvents[ev.memberId] = _push(memberEvents[ev.memberId] ?? const [], ev, eventRingCapacity);
    var pending = state.pending;
    var tasks = state.tasks;
    switch (ev.kind) {
      case OfficeEventKind.waitingApproval:
        final id = ev.ref.approvalId;
        if (id != null && !pending.containsKey(id)) {
          pending = {
            ...pending,
            id: Pending(
              id: id,
              memberId: ev.memberId,
              type: PendingType.approval,
              payload: {
                'tool_name': ev.detail.tool ?? '',
                'tool_input': {
                  if (ev.detail.cmd != null) 'command': ev.detail.cmd,
                  if (ev.detail.path != null) 'file_path': ev.detail.path,
                },
                if (ev.detail.summary != null) 'summary': ev.detail.summary,
                'fromEvent': true,
              },
              status: PendingStatus.open,
              createdAt: ev.ts,
              answeredAt: null,
              answer: null,
            ),
          };
        }
      case OfficeEventKind.asking:
        final id = ev.ref.questionId;
        if (id != null && !pending.containsKey(id)) {
          pending = {
            ...pending,
            id: Pending(
              id: id,
              memberId: ev.memberId,
              type: PendingType.question,
              payload: {'question': ev.detail.summary ?? ev.detail.text ?? '', 'fromEvent': true},
              status: PendingStatus.open,
              createdAt: ev.ts,
              answeredAt: null,
              answer: null,
            ),
          };
        }
      case OfficeEventKind.error:
        final pid = ev.detail.pendingId;
        if (pid != null && pending.containsKey(pid)) pending = {...pending}..remove(pid);
      case OfficeEventKind.reporting:
        final tid = ev.ref.taskId;
        if (tid != null && tasks.containsKey(tid)) tasks = {...tasks}..remove(tid);
      default:
        break;
    }
    state = state.copyWith(
      events: _push(state.events, ev, eventRingCapacity),
      memberEvents: memberEvents,
      latestEvent: {...state.latestEvent, ev.memberId: ev},
      pending: pending,
      tasks: tasks,
      lastSeq: ev.seq > state.lastSeq ? ev.seq : state.lastSeq,
    );
  }
}

final officeProvider = NotifierProvider<OfficeNotifier, OfficeState>(OfficeNotifier.new);

// ---- 파생 프로바이더 -------------------------------------------------------------

final connectionStateProvider = Provider<RpcConnectionState>((ref) => ref.watch(officeProvider.select((s) => s.connection)));
final daemonVersionProvider = Provider<String?>((ref) => ref.watch(officeProvider.select((s) => s.daemonVersion)));
final daemonPidProvider = Provider<int?>((ref) => ref.watch(officeProvider.select((s) => s.daemonPid)));
final reconnectAttemptsProvider = Provider<int>((ref) => ref.watch(officeProvider.select((s) => s.reconnectAttempts)));
final lastSeqProvider = Provider<int>((ref) => ref.watch(officeProvider.select((s) => s.lastSeq)));

final teamsProvider = Provider<Map<String, Team>>((ref) => ref.watch(officeProvider.select((s) => s.teams)));
final membersProvider = Provider<Map<String, Member>>((ref) => ref.watch(officeProvider.select((s) => s.members)));
final memberProvider = Provider.family<Member?, String>((ref, id) => ref.watch(membersProvider)[id]);
final memberStatusProvider = Provider.family<MemberStatus?, String>((ref, id) => ref.watch(memberProvider(id))?.status);
final derivedStatusProvider =
    Provider.family<DerivedStatus?, String>((ref, id) => ref.watch(officeProvider.select((s) => s.derived[id])));
final membersOfTeamProvider = Provider.family<List<Member>, String>(
  (ref, teamId) => ref.watch(membersProvider).values.where((m) => m.teamId == teamId).toList(growable: false),
);

final openPendingProvider = Provider<Map<String, Pending>>((ref) => ref.watch(officeProvider.select((s) => s.pending)));
final openTasksProvider = Provider<Map<int, Task>>((ref) => ref.watch(officeProvider.select((s) => s.tasks)));

final globalEventsProvider = Provider<List<OfficeEvent>>((ref) => ref.watch(officeProvider.select((s) => s.events)));
final memberEventsProvider = Provider.family<List<OfficeEvent>, String>(
  (ref, id) => ref.watch(officeProvider.select((s) => s.memberEvents[id])) ?? const [],
);
final latestEventProvider = Provider.family<OfficeEvent?, String>(
  (ref, id) => ref.watch(officeProvider.select((s) => s.latestEvent[id])),
);
final noticesProvider = Provider<List<DaemonNotice>>((ref) => ref.watch(officeProvider.select((s) => s.notices)));
