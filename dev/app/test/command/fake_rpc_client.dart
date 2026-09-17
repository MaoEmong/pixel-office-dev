// 위젯 테스트용 가짜 RpcClient. 소켓 없이 스트림을 직접 밀어 넣고(`emitHello`/`setState`/`pushNotification`)
// `call` 은 기록만 한 뒤 `responder` 가 돌려주는 결과를 낸다. 실제 OfficeNotifier 가 이 위에서 그대로 돈다.
// (test/fake_daemon.dart 는 진짜 WebSocket 이라 위젯 테스트에서는 runAsync 가 필요해 여기선 안 쓴다.)

import 'dart:async';

import 'package:pixel_office/rpc/rpc_client.dart';
import 'package:pixel_office/state/office_state.dart';

typedef FakeResponder = FutureOr<Map<String, dynamic>> Function(String method, Map<String, dynamic> params);

class FakeRpcClient extends RpcClient {
  FakeRpcClient({this.responder});

  FakeResponder? responder;

  /// `call` 기록(method, params).
  final List<(String, Map<String, dynamic>)> calls = [];

  /// `expect` 로 깊은 비교하기 위한 형태: `[[method, params], ...]` (레코드 안의 Map 은 == 가 identity).
  List<List<Object?>> get callList => [for (final c in calls) [c.$1, c.$2]];
  int retryNowCount = 0;

  final _stateCtl = StreamController<RpcConnectionState>.broadcast();
  final _notifCtl = StreamController<RpcNotification>.broadcast();
  final _eventCtl = StreamController<Map<String, dynamic>>.broadcast();
  final _helloCtl = StreamController<HelloResult>.broadcast();
  final _attemptCtl = StreamController<int>.broadcast();
  RpcConnectionState _fakeState = RpcConnectionState.disconnected;
  int _fakeSeq = 0;

  @override
  RpcConnectionState get state => _fakeState;
  @override
  Stream<RpcConnectionState> get stateStream => _stateCtl.stream;
  @override
  Stream<RpcNotification> get notifications => _notifCtl.stream;
  @override
  Stream<Map<String, dynamic>> get events => _eventCtl.stream;
  @override
  Stream<HelloResult> get hellos => _helloCtl.stream;
  @override
  Stream<int> get attemptStream => _attemptCtl.stream;
  @override
  int get lastSeq => _fakeSeq;
  int _attempts = 0;
  Object? fakeError;

  @override
  int get reconnectAttempts => _attempts;
  @override
  Object? get lastError => fakeError;

  /// 재접속 실패 한 번(끊김 오버레이·pill 의 "재시도 N회" 와 "자세히" 예외 문자열).
  void emitAttempt(int n, {Object? error}) {
    _attempts = n;
    if (error != null) fakeError = error;
    setState(RpcConnectionState.disconnected);
    _attemptCtl.add(n);
  }

  @override
  void start({required UrlProvider urlProvider, required TokenProvider tokenProvider}) {}

  @override
  Future<void> stop() async {}

  @override
  void retryNow() => retryNowCount++;

  @override
  Future<Map<String, dynamic>> call(String method, [Map<String, dynamic> params = const {}]) async {
    calls.add((method, params));
    final r = responder;
    if (r == null) return {};
    return await r(method, params);
  }

  /// 스냅샷 hello → connected 순서(실제 클라이언트와 같음).
  void emitHello({
    String version = '9.9.9',
    int pid = 4242,
    int seq = 0,
    List<Map<String, dynamic>> departments = const [],
    List<Map<String, dynamic>> teams = const [],
    List<Map<String, dynamic>> members = const [],
    List<Map<String, dynamic>> pending = const [],
    List<Map<String, dynamic>> tasks = const [],
  }) {
    _fakeSeq = seq;
    _helloCtl.add(HelloResult(
      daemonVersion: version,
      daemonPid: pid,
      snapshot: {
        'seq': seq,
        'departments': departments,
        'teams': teams,
        'members': members,
        'pending': pending,
        'tasks': tasks,
      },
    ));
    setState(RpcConnectionState.connected);
  }

  void setState(RpcConnectionState s) {
    if (_fakeState == s) return;
    _fakeState = s;
    _stateCtl.add(s);
  }

  void pushNotification(String method, Map<String, dynamic> params) => _notifCtl.add(RpcNotification(method, params));

  @override
  Future<void> close() async {
    await _stateCtl.close();
    await _notifCtl.close();
    await _eventCtl.close();
    await _helloCtl.close();
    await _attemptCtl.close();
    await super.close();
  }

  /// `ProviderScope(overrides: fake.overrides)`. (riverpod 3.3 은 `Override` 타입을 export 하지 않아 추론에 맡긴다.)
  late final overrides = [rpcClientProvider.overrideWithValue(this)];
}

Map<String, dynamic> fakeDepartment(String id, {String name = 'alpha', String? headId, String cwd = 'D:/x', String createdAt = 'c'}) =>
    {'id': id, 'name': name, 'cwd': cwd, 'headId': headId, 'createdAt': createdAt};

Map<String, dynamic> fakeTeam(String id, {String name = 'pixel', String? leaderId, String departmentId = 'd1'}) => {
      'id': id,
      'departmentId': departmentId,
      'name': name,
      'cwd': 'D:/x',
      'leaderId': leaderId,
      'maxMembers': 5,
      'allowedEngines': ['claude', 'codex'],
      'createdAt': 'c',
    };

Map<String, dynamic> fakeMember(
  String id, {
  String status = 'idle',
  String name = '',
  String departmentId = 'd1',
  String? teamId = 't1',
  String? parentId,
  String engine = 'claude',
  String rank = 'member',
  String createdAt = 'c',
}) =>
    {
      'id': id,
      'departmentId': departmentId,
      'teamId': rank == 'head' ? null : teamId,
      'parentId': parentId,
      'name': name.isEmpty ? id : name,
      'rank': rank,
      'engine': engine,
      'sessionId': null,
      'childPid': null,
      'cwd': 'D:/x',
      'status': status,
      'hiredBy': 'user',
      'memberToken': 'mt',
      'instructionsPath': null,
      'createdAt': createdAt,
      'updatedAt': 'u',
    };
