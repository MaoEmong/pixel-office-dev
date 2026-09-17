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
//  departmentsProvider, teamsProvider, teamsOfDepartmentProvider(departmentId), membersProvider, memberProvider(id),
//  memberStatusProvider(id), derivedStatusProvider(id), membersOfTeamProvider(teamId), membersOfDepartmentProvider(id),
//  liveHeadsProvider, liveHeadProvider(departmentId), liveLeadsProvider, liveLeadProvider(teamId),
//  childrenProvider(memberId), parentProvider(memberId), openPendingProvider, openTasksProvider,
//  globalEventsProvider, memberEventsProvider(id), latestEventProvider(id), noticesProvider.
//
// T37(rev 3): 최상위 단위가 팀 → **부서**다. 부서 = 프로젝트(cwd), 그 안에 부장 한 명 → 팀(팀장) → 팀원.
// "살아 있는 부장/팀장" 은 `departments.headId`/`teams.leaderId` 가 아니라 멤버 행의 rank·status 로 판정한다
// (데몬 `Store.liveHead`/`liveLead` 와 같은 규칙 — 나간 뒤에도 id 는 남는다).

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
  // 못 붙을 때의 문구에 **찾아본 daemon.json 경로**와 환경변수 유무를 싣는다(T41 실기 사고).
  final client = RpcClient(noDaemonInfoMessage: daemonJsonMissingMessage());
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
    this.departments = const {},
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

  /// 부서 id → Department(T37). 상단 탭의 원본.
  final Map<String, Department> departments;

  /// 팀 id → Team.
  final Map<String, Team> teams;

  /// 멤버 id → Member(`status` 는 member.status 알림으로 갱신됨).
  final Map<String, Member> members;

  /// 멤버 id → 파생 상태(free 등). 스냅샷에서는 v1a 규칙으로 계산.
  final Map<String, DerivedStatus> derived;

  /// 열린 pending(id → Pending). 스냅샷 + waiting_approval/asking 이벤트로 추가.
  /// 제거는 (a) `error{pendingId}`, (b) 스냅샷에서 빠짐, (c) `member.status` 의 raw·파생이 **둘 다** waiting 이 아님
  /// (단 `ask_user` 질문은 raw 가 idle/종료 일 때만 — [_onMemberStatus] 주석) — 세 가지뿐.
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

  /// 그 부서의 멤버 전부(부장 포함).
  List<Member> membersOfDepartment(String departmentId) =>
      members.values.where((m) => m.departmentId == departmentId).toList(growable: false);

  OfficeState copyWith({
    RpcConnectionState? connection,
    String? daemonVersion,
    int? daemonPid,
    int? lastSeq,
    int? reconnectAttempts,
    String? lastError,
    bool clearError = false,
    Map<String, Department>? departments,
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
        departments: departments ?? this.departments,
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
      departmentId: m?.departmentId ?? '',
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

  /// 부서 만들기 + 부장 임명(PROTOCOL `department.create`) → `{department, head}`. 사용자가 하는 유일한 생성(D-32).
  /// 결과의 부서·부장은 스냅샷/알림이 오기 전에 미리 상태에 넣어 둔다(탭·지시 대상이 바로 잡히게).
  Future<({Department department, Member? head})> createDepartment({
    required String name,
    required String cwd,
    required Engine headEngine,
    String? headName,
  }) async {
    final r = await client.call('department.create', {
      'name': name,
      'cwd': cwd,
      'headEngine': headEngine.wire,
      if (headName != null && headName.isNotEmpty) 'headName': headName,
    });
    final dept = Department.fromJson(Map<String, dynamic>.from(r['department'] as Map));
    final headJson = r['head'];
    final head = headJson == null ? null : Member.fromJson(Map<String, dynamic>.from(headJson as Map));
    state = state.copyWith(
      departments: {...state.departments, dept.id: dept},
      members: head == null ? null : {...state.members, head.id: head},
    );
    return (department: dept, head: head);
  }

  /// 부서 삭제(PROTOCOL `department.delete`) — 하위 트리를 잎부터 정리한 뒤 행을 지운다.
  Future<void> deleteDepartment(String departmentId) async {
    await client.call('department.delete', {'departmentId': departmentId});
    state = state.copyWith(
      departments: {...state.departments}..remove(departmentId),
      teams: {...state.teams}..removeWhere((_, t) => t.departmentId == departmentId),
      members: {...state.members}..removeWhere((_, m) => m.departmentId == departmentId),
    );
  }

  /// `events.query`(PROTOCOL). 부서·멤버로 좁힐 수 있다.
  ///
  /// **주의:** 멤버 로그 백필은 `departmentId` 를 **보내지 않는다** — T34 마이그레이션 이전 이벤트 행은
  /// `department_id` 가 `''` 이라 부서로 거르면 옛 기록이 통째로 사라진다.
  Future<List<OfficeEvent>> queryEvents({String? departmentId, String? memberId, int? beforeSeq, int? limit}) async {
    final r = await client.call('events.query', {
      'departmentId': ?departmentId,
      'memberId': ?memberId,
      'beforeSeq': ?beforeSeq,
      'limit': ?limit,
    });
    return [
      for (final e in (r['events'] as List?) ?? const [])
        OfficeEvent.fromJson(Map<String, dynamic>.from(e as Map)),
    ];
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
    final departments = {for (final d in snap.departments) d.id: d};
    final teams = {for (final t in snap.teams) t.id: t};
    final members = {for (final m in snap.members) m.id: m};
    final pending = {for (final p in snap.pending) p.id: p};
    final tasks = {for (final t in snap.tasks) t.id: t};
    final assigned = {for (final t in snap.tasks) if (t.status == TaskStatus.assigned) t.toMember};
    // 열린 질문이 있는 멤버는 raw 가 idle 이어도 파생이 waiting_answer 다(`ask_user` — PROTOCOL, T19b).
    final withQuestion = {for (final p in snap.pending) if (p.type == PendingType.question) p.memberId};
    // 데몬이 스냅샷 멤버 행에 파생 상태를 실어 준다(T28) — 그대로 쓴다. 없으면(옛 데몬) 스냅샷으로 유추한다.
    final derived = {
      for (final m in snap.members)
        m.id: m.derived ??
            DerivedStatus.fromStatus(
              m.status,
              hasAssignedTask: assigned.contains(m.id),
              hasOpenQuestion: withQuestion.contains(m.id),
            ),
    };
    return s.copyWith(
      departments: departments,
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
    if (!n.status.isWaiting && !n.derived.isWaiting) {
      // 허가/질문에 응답이 끝났거나(→working) 멤버가 사라졌다 — 그 멤버의 열린 pending 은 닫힌 것.
      //
      // 예외: TeamTools `ask_user` 질문(T17)은 **턴을 붙잡지 않는다**. 도구가 끝나면 status 가 곧 `working` 으로
      // 돌아오고(PostToolUse) 턴이 끝나면 `idle` 이 된다 — 그 동안에도 질문은 열려 있다. 데몬의 파생 규칙은
      // "idle 인데 열린 질문이 있으면 waiting_answer" 이므로 **raw 가 idle 일 때만** 질문이 닫혔는지 알 수 있다.
      // 따라서 raw 가 idle/종료 일 때만 ask_user 질문까지 지우고, working/starting 일 때는 남겨 둔다
      // (T19b: 이 예외가 없으면 `asking` 직후의 `working` 알림이 방금 만든 질문 pending 을 지워 버린다).
      final canCloseAskUser = n.status == MemberStatus.idle || n.status.isGone;
      bool closedBy(Pending p) => p.memberId == n.memberId && (canCloseAskUser || !p.isAskUser);
      if (pending.values.any(closedBy)) {
        pending = {...pending}..removeWhere((_, p) => closedBy(p));
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
          // TeamTools `ask_user`(T17) 는 `asking{tool:'ask_user', summary:<질문>, options?}`,
          // `ask_parent`(T35) 는 `asking{tool:'ask_parent', summary, options?, to, toName}` 로 온다 —
          // 스냅샷 payload 와 **같은 모양**(`{source, question, options[, from, to]}`)으로 만들어야 카드가 같게 그려지고,
          // 무엇보다 `ask_parent` 가 사용자 몫(내 책상 줄·카드)으로 새지 않는다(T37).
          final tool = ev.detail.tool;
          final source = tool == 'ask_user' || tool == 'ask_parent' ? tool : null;
          final rawOptions = ev.detail['options'];
          final options = rawOptions is List ? [for (final o in rawOptions) o] : null;
          pending = {
            ...pending,
            id: Pending(
              id: id,
              memberId: ev.memberId,
              type: PendingType.question,
              payload: {
                'source': ?source,
                'question': ev.detail.summary ?? ev.detail.text ?? '',
                'options': ?options,
                if (source == 'ask_parent') ...{'from': ev.memberId, 'to': ?ev.detail['to'] as String?},
                'fromEvent': true,
              },
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

final departmentsProvider = Provider<Map<String, Department>>((ref) => ref.watch(officeProvider.select((s) => s.departments)));
final departmentProvider = Provider.family<Department?, String?>(
  (ref, id) => id == null ? null : ref.watch(departmentsProvider)[id],
);
final teamsProvider = Provider<Map<String, Team>>((ref) => ref.watch(officeProvider.select((s) => s.teams)));

/// 그 부서의 팀(createdAt 순). 부서가 null 이면 빈 목록.
final teamsOfDepartmentProvider = Provider.family<List<Team>, String?>((ref, departmentId) {
  if (departmentId == null) return const [];
  final list = ref.watch(teamsProvider).values.where((t) => t.departmentId == departmentId).toList()
    ..sort((a, b) {
      final c = a.createdAt.compareTo(b.createdAt);
      return c != 0 ? c : a.id.compareTo(b.id);
    });
  return List<Team>.unmodifiable(list);
});
final membersProvider = Provider<Map<String, Member>>((ref) => ref.watch(officeProvider.select((s) => s.members)));
final memberProvider = Provider.family<Member?, String>((ref, id) => ref.watch(membersProvider)[id]);
final memberStatusProvider = Provider.family<MemberStatus?, String>((ref, id) => ref.watch(memberProvider(id))?.status);
final derivedStatusProvider =
    Provider.family<DerivedStatus?, String>((ref, id) => ref.watch(officeProvider.select((s) => s.derived[id])));
final membersOfTeamProvider = Provider.family<List<Member>, String>(
  (ref, teamId) => ref.watch(membersProvider).values.where((m) => m.teamId == teamId).toList(growable: false),
);

final membersOfDepartmentProvider = Provider.family<List<Member>, String?>(
  (ref, departmentId) => departmentId == null
      ? const []
      : ref.watch(membersProvider).values.where((m) => m.departmentId == departmentId).toList(growable: false),
);

/// 살아 있는 상급자 판정의 공통 규칙: 그 직급이고 status 가 exited/error 가 아닌 **첫**(createdAt 순) 멤버.
/// `departments.headId` / `teams.leaderId` 는 나간 뒤에도 남으므로 그것으로 판정하면 안 된다
/// (PROTOCOL "팀·직급", 데몬 `Store.liveHead` / `Store.liveLead`).
Map<String, Member> _liveByKey(Iterable<Member> members, MemberRank rank, String? Function(Member) key) {
  final sorted = members.where((m) => m.rank == rank && !m.status.isGone).toList(growable: false)
    ..sort((a, b) {
      final c = a.createdAt.compareTo(b.createdAt);
      return c != 0 ? c : a.id.compareTo(b.id);
    });
  final out = <String, Member>{};
  for (final m in sorted) {
    final k = key(m);
    if (k != null) out.putIfAbsent(k, () => m);
  }
  return out;
}

/// 부서 id → 살아 있는 부장.
Map<String, Member> liveHeadsByDepartment(Iterable<Member> members) =>
    _liveByKey(members, MemberRank.head, (m) => m.departmentId);

/// 팀 id → 살아 있는 팀장.
Map<String, Member> liveLeadsByTeam(Iterable<Member> members) => _liveByKey(members, MemberRank.lead, (m) => m.teamId);

final liveHeadsProvider = Provider<Map<String, Member>>((ref) => liveHeadsByDepartment(ref.watch(membersProvider).values));

/// 그 부서의 살아 있는 부장(없으면 null). **사용자 지시가 갈 수 있는 유일한 대상**(D-32, 게이트 -32004).
final liveHeadProvider = Provider.family<Member?, String?>(
  (ref, departmentId) => departmentId == null ? null : ref.watch(liveHeadsProvider)[departmentId],
);

final liveLeadsProvider = Provider<Map<String, Member>>((ref) => liveLeadsByTeam(ref.watch(membersProvider).values));

/// 그 팀의 살아 있는 팀장(없으면 null).
final liveLeadProvider = Provider.family<Member?, String?>(
  (ref, teamId) => teamId == null ? null : ref.watch(liveLeadsProvider)[teamId],
);

/// 직속 부하(`parentId` 가 이 멤버). createdAt 순, 나간 멤버도 포함(사무실은 회색 책상으로 남긴다).
final childrenProvider = Provider.family<List<Member>, String>((ref, memberId) {
  final list = ref.watch(membersProvider).values.where((m) => m.parentId == memberId).toList()
    ..sort((a, b) {
      final c = a.createdAt.compareTo(b.createdAt);
      return c != 0 ? c : a.id.compareTo(b.id);
    });
  return List<Member>.unmodifiable(list);
});

/// 직속 상사(`parentId` 가 가리키는 멤버). 부장이거나 행이 없으면 null.
final parentProvider = Provider.family<Member?, String>((ref, memberId) {
  final parentId = ref.watch(membersProvider)[memberId]?.parentId;
  return parentId == null ? null : ref.watch(membersProvider)[parentId];
});

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
