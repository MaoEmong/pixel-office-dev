// JSON-RPC 2.0 over WebSocket 클라이언트. dev/daemon/PROTOCOL.md 의 봉투·hello·재접속 규칙을 따른다.
// 데몬 쪽 참조 구현: dev/daemon/src/cli/RpcClient.ts (T08).
//
// - `connect(url)`: 소켓 한 번 열기(상태 connecting). `hello()` 가 성공해야 connected.
// - `hello(token, since)`: 결과의 `snapshot.seq` 를 응답 핸들러 안에서 **동기적으로** lastSeq 에 반영해
//   뒤따르는 replay `event` 보다 먼저 적용되게 한다(재접속 규칙 2).
// - `events`: `event` 알림 중 seq > lastSeq 인 것만(중복 제거). `notifications` 는 원본 전부.
// - `start(urlProvider, tokenProvider)`: 자동 재접속 루프. 끊기면 1s→2s→4s→5s 간격으로 다시 접속해
//   한 번이라도 동기화된 뒤라면 `since = lastSeq` 로 hello 한다. token 은 시도마다 다시 읽는다(데몬 재기동 시 바뀜).

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:web_socket_channel/web_socket_channel.dart';

enum RpcConnectionState { disconnected, connecting, connected }

/// 데몬이 돌려준 JSON-RPC 에러 또는 로컬 오류(code -1 연결 끊김, -2 타임아웃).
class RpcException implements Exception {
  const RpcException(this.code, this.message, [this.data]);

  final int code;
  final String message;
  final Object? data;

  static const int closed = -1;
  static const int timeout = -2;

  /// PROTOCOL 에러 코드.
  static const int auth = -32001;
  static const int notFound = -32002;
  static const int badState = -32003;
  static const int rankRule = -32004;
  static const int invalidParams = -32602;

  @override
  String toString() => 'RpcException($code: $message${data == null ? '' : ', data=$data'})';
}

class RpcNotification {
  const RpcNotification(this.method, this.params);

  final String method;
  final Map<String, dynamic> params;

  @override
  String toString() => 'RpcNotification($method $params)';
}

/// `hello` 결과. snapshot 은 원본 JSON — 모델 파싱은 state 층(`Snapshot.fromJson`)에서.
class HelloResult {
  const HelloResult({required this.daemonVersion, required this.daemonPid, required this.snapshot});

  final String daemonVersion;
  final int daemonPid;
  final Map<String, dynamic> snapshot;

  int get snapshotSeq => (snapshot['seq'] as num?)?.toInt() ?? 0;
}

typedef WebSocketConnector = Future<WebSocketChannel> Function(Uri url);
typedef UrlProvider = FutureOr<Uri?> Function();
typedef TokenProvider = FutureOr<String?> Function();

Future<WebSocketChannel> _defaultConnector(Uri url) async {
  final ch = WebSocketChannel.connect(url);
  await ch.ready;
  return ch;
}

class _PendingCall {
  _PendingCall(this.method, this.completer);
  final String method;
  final Completer<Map<String, dynamic>> completer;
}

class RpcClient {
  RpcClient({
    WebSocketConnector? connector,
    this.callTimeout = const Duration(seconds: 15),
    this.minBackoff = const Duration(seconds: 1),
    this.maxBackoff = const Duration(seconds: 5),
    this.clientName = 'pixel-office',
    this.clientVersion = '0.1.0',
    this.noDaemonInfoMessage = defaultNoDaemonInfoMessage,
  }) : _connector = connector ?? _defaultConnector;

  /// url/token 을 못 구했을 때(= daemon.json 없음) 쓰는 기본 문구. 앱은 찾아본 경로까지 담은 문구를
  /// 넣어 준다(`daemonJsonMissingMessage()`, T41) — 이 층은 파일 경로를 모른다.
  static const String defaultNoDaemonInfoMessage = 'daemon.json 없음(데몬 미기동)';

  final WebSocketConnector _connector;
  final Duration callTimeout;
  final Duration minBackoff;
  final Duration maxBackoff;
  final String clientName;
  final String clientVersion;

  /// daemon.json 을 못 읽었을 때의 오류 문구(오버레이 "자세히" 에 그대로 나온다).
  final String noDaemonInfoMessage;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  Completer<void>? _closedCompleter;
  int _nextId = 1;
  final Map<int, _PendingCall> _pending = {};

  RpcConnectionState _state = RpcConnectionState.disconnected;
  final _stateCtl = StreamController<RpcConnectionState>.broadcast();
  final _notifCtl = StreamController<RpcNotification>.broadcast();
  final _eventCtl = StreamController<Map<String, dynamic>>.broadcast();
  final _helloCtl = StreamController<HelloResult>.broadcast();
  final _attemptCtl = StreamController<int>.broadcast();

  int _lastSeq = 0;
  bool _synced = false;
  bool _disposed = false;

  // 자동 재접속 루프
  bool _running = false;
  Completer<void>? _wake;
  int _attempts = 0;
  Object? _lastError;

  /// 현재 연결 상태.
  RpcConnectionState get state => _state;

  /// 상태 변화(값이 실제로 바뀔 때만).
  Stream<RpcConnectionState> get stateStream => _stateCtl.stream;

  /// 데몬 알림 원본 전부(`event`, `snapshot`, `term`, `member.status`, `daemon.notice`).
  Stream<RpcNotification> get notifications => _notifCtl.stream;

  /// 중복 제거된 `event` 알림의 params(seq > lastSeq 만, 통과 시 lastSeq 갱신).
  Stream<Map<String, dynamic>> get events => _eventCtl.stream;

  /// 성공한 모든 hello(첫 접속·재접속). 스냅샷 재적용용.
  Stream<HelloResult> get hellos => _helloCtl.stream;

  /// 마지막으로 적용한 seq(스냅샷 seq 와 통과한 이벤트 seq 의 최댓값).
  int get lastSeq => _lastSeq;

  /// 한 번이라도 hello 에 성공했는가(재접속 시 since 를 보낼지).
  bool get synced => _synced;

  /// 소켓이 열려 있는가(hello 여부와 무관).
  bool get isOpen => _channel != null;

  /// 자동 재접속 루프의 연속 실패 횟수(UI 표시용).
  int get reconnectAttempts => _attempts;

  /// 실패 횟수가 바뀔 때마다(실패 시 증가, 성공 시 0). daemon.json 이 없어 소켓을 열지도 못한
  /// 시도는 stateStream 에 안 나타나므로 UI 는 이걸로 "시도 N회 · 원인" 을 갱신한다.
  Stream<int> get attemptStream => _attemptCtl.stream;

  /// 마지막 접속 실패 원인.
  Object? get lastError => _lastError;

  void _setState(RpcConnectionState s) {
    if (_state == s || _disposed) return;
    _state = s;
    _stateCtl.add(s);
  }

  // ---- 단일 접속 ------------------------------------------------------------

  /// 소켓을 연다. 실패하면 throw 하고 disconnected. 성공해도 hello 전까지는 connecting.
  Future<void> connect(Uri url) async {
    if (_disposed) throw StateError('RpcClient disposed');
    if (_channel != null) await disconnect();
    _setState(RpcConnectionState.connecting);
    final WebSocketChannel ch;
    try {
      ch = await _connector(url);
    } catch (e) {
      _lastError = e;
      _setState(RpcConnectionState.disconnected);
      rethrow;
    }
    _channel = ch;
    _closedCompleter = Completer<void>();
    _sub = ch.stream.listen(
      _onMessage,
      onError: (Object e) {
        _lastError = e;
        _teardown();
      },
      onDone: _teardown,
      cancelOnError: true,
    );
  }

  /// 소켓을 닫는다(재접속 루프는 건드리지 않음 — 루프가 돌고 있으면 다시 붙는다).
  Future<void> disconnect() async {
    final ch = _channel;
    if (ch == null) return;
    _teardown();
    try {
      await ch.sink.close();
    } catch (_) {
      // 이미 닫힘
    }
  }

  void _teardown() {
    final ch = _channel;
    if (ch == null) return;
    _channel = null;
    _sub?.cancel();
    _sub = null;
    final pend = List.of(_pending.values);
    _pending.clear();
    for (final p in pend) {
      if (!p.completer.isCompleted) {
        p.completer.completeError(RpcException(RpcException.closed, 'connection closed during ${p.method}'));
      }
    }
    _setState(RpcConnectionState.disconnected);
    final c = _closedCompleter;
    _closedCompleter = null;
    if (c != null && !c.isCompleted) c.complete();
  }

  /// `hello{token, since?, client}`. 성공하면 connected, `hellos` 로도 내보낸다.
  Future<HelloResult> hello(String token, {int? since}) async {
    final params = <String, dynamic>{
      'token': token,
      'since': ?since,
      'client': {'name': clientName, 'version': clientVersion},
    };
    final result = await _send('hello', params, isHello: true);
    final daemon = (result['daemon'] as Map?)?.cast<String, dynamic>() ?? const {};
    final snapshot = (result['snapshot'] as Map?)?.cast<String, dynamic>() ?? const {};
    final hr = HelloResult(
      daemonVersion: daemon['version']?.toString() ?? '?',
      daemonPid: (daemon['pid'] as num?)?.toInt() ?? 0,
      snapshot: snapshot,
    );
    _synced = true;
    // 스냅샷(hellos)을 먼저 내보내고 connected 로 — 구독자가 connected 를 볼 때 데이터가 이미 있게.
    if (!_disposed) _helloCtl.add(hr);
    _setState(RpcConnectionState.connected);
    return hr;
  }

  /// 요청 하나. 에러 응답은 `RpcException(code, message, data)` 로 throw.
  Future<Map<String, dynamic>> call(String method, [Map<String, dynamic> params = const {}]) =>
      _send(method, params);

  Future<Map<String, dynamic>> _send(String method, Map<String, dynamic> params, {bool isHello = false}) {
    final ch = _channel;
    if (ch == null) {
      return Future.error(RpcException(RpcException.closed, 'not connected ($method)'));
    }
    final id = _nextId++;
    final completer = Completer<Map<String, dynamic>>();
    _pending[id] = _PendingCall(method, completer);
    ch.sink.add(jsonEncode({'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params}));
    return completer.future.timeout(callTimeout, onTimeout: () {
      _pending.remove(id);
      throw RpcException(RpcException.timeout, 'timeout after ${callTimeout.inMilliseconds}ms ($method)');
    });
  }

  void _onMessage(dynamic raw) {
    final Object? decoded;
    try {
      decoded = jsonDecode(raw is String ? raw : utf8.decode(raw as List<int>));
    } catch (_) {
      return;
    }
    if (decoded is! Map) return;
    final msg = decoded.cast<String, dynamic>();
    final id = msg['id'];
    if (id != null) {
      _onResponse(id, msg);
      return;
    }
    final method = msg['method'];
    if (method is! String) return;
    final params = (msg['params'] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{};
    _onNotification(method, params);
  }

  void _onResponse(Object id, Map<String, dynamic> msg) {
    final key = id is num ? id.toInt() : int.tryParse(id.toString());
    final p = key == null ? null : _pending.remove(key);
    if (p == null) return;
    final err = msg['error'];
    if (err is Map) {
      final e = err.cast<String, dynamic>();
      p.completer.completeError(RpcException(
        (e['code'] as num?)?.toInt() ?? -32000,
        e['message']?.toString() ?? 'error',
        e['data'],
      ));
      return;
    }
    final res = msg['result'];
    final map = res is Map ? res.cast<String, dynamic>() : <String, dynamic>{'value': res};
    if (p.method == 'hello') {
      // replay 가 이 응답 바로 뒤에 오므로 여기서 동기적으로 반영.
      final seq = ((map['snapshot'] as Map?)?['seq'] as num?)?.toInt();
      if (seq != null) _lastSeq = math.max(_lastSeq, seq);
    }
    p.completer.complete(map);
  }

  void _onNotification(String method, Map<String, dynamic> params) {
    if (_disposed) return;
    _notifCtl.add(RpcNotification(method, params));
    switch (method) {
      case 'event':
        final seq = (params['seq'] as num?)?.toInt();
        if (seq == null) return;
        if (seq <= _lastSeq) return; // replay 이중 적용 방지
        _lastSeq = seq;
        _eventCtl.add(params);
      case 'snapshot':
        final seq = (params['seq'] as num?)?.toInt();
        if (seq != null) _lastSeq = math.max(_lastSeq, seq);
    }
  }

  // ---- 자동 재접속 ----------------------------------------------------------

  /// 재접속 루프 시작(이미 돌고 있으면 무시). 끊길 때마다 backoff 후 다시 connect+hello.
  void start({required UrlProvider urlProvider, required TokenProvider tokenProvider}) {
    if (_running || _disposed) return;
    _running = true;
    unawaited(_loop(urlProvider, tokenProvider));
  }

  /// 루프를 멈추고 소켓을 닫는다.
  Future<void> stop() async {
    _running = false;
    _wake?.complete();
    await disconnect();
  }

  /// 대기 중이면 즉시 다음 시도(UI 의 "다시 연결" 버튼용).
  void retryNow() {
    final w = _wake;
    if (w != null && !w.isCompleted) w.complete();
  }

  Future<void> _loop(UrlProvider urlProvider, TokenProvider tokenProvider) async {
    var backoff = minBackoff;
    while (_running && !_disposed) {
      try {
        final url = await urlProvider();
        final token = await tokenProvider();
        if (url == null || token == null) {
          throw RpcException(RpcException.closed, noDaemonInfoMessage);
        }
        await connect(url);
        await hello(token, since: _synced ? _lastSeq : null);
        _attempts = 0;
        _lastError = null;
        backoff = minBackoff;
        if (!_disposed) _attemptCtl.add(0);
        await (_closedCompleter?.future ?? Future<void>.value());
      } catch (e) {
        _lastError = e;
        _attempts++;
        await disconnect();
        if (!_disposed) _attemptCtl.add(_attempts);
      }
      if (!_running || _disposed) break;
      _wake = Completer<void>();
      final timer = Timer(backoff, () => retryNow());
      await _wake!.future;
      timer.cancel();
      _wake = null;
      final next = backoff * 2;
      backoff = next > maxBackoff ? maxBackoff : next;
    }
  }

  /// 루프 정지 + 소켓 닫기 + 스트림 해제. 이후 사용 불가.
  Future<void> close() async {
    await stop();
    _disposed = true;
    await _stateCtl.close();
    await _notifCtl.close();
    await _eventCtl.close();
    await _helloCtl.close();
    await _attemptCtl.close();
  }
}
