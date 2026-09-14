// 패널 테스트용 가짜 데몬. test/fake_daemon.dart(T11) 와 같은 봉투/hello/replay 를 흉내 내되,
// hello 이후 메서드를 `handlers` 맵으로 바꿔 끼울 수 있다(member.attach / events.query 등).
// T11 의 FakeDaemon 은 메서드 분기가 클로저 안에 고정돼 있어 확장이 안 되므로 여기서 따로 둔다.
//  - handlers[method](params) 가 돌려준 값이 result. `FakeRpcError` 를 던지면 그 code/message 로 에러 응답.
//  - 정의 안 된 메서드 → -32601.
//  - push(method, params): 인증된 소켓 전부에 알림. closeAll(): 재접속 테스트.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

class FakeRpcError implements Exception {
  const FakeRpcError(this.code, this.message, [this.data]);
  final int code;
  final String message;
  final Object? data;
}

typedef FakeHandler = FutureOr<Object?> Function(Map<String, dynamic> params);

class PanelFakeDaemon {
  PanelFakeDaemon({this.token = 'tok', this.version = '9.9.9', this.pid = 4242});

  final String token;
  final String version;
  final int pid;

  late HttpServer _server;
  final List<WebSocket> _authed = [];
  final List<WebSocket> _all = [];

  /// hello 뒤 메서드 → 핸들러.
  final Map<String, FakeHandler> handlers = {};

  /// 받은 요청 전부(method, params). hello 포함.
  final List<(String, Map<String, dynamic>)> requests = [];

  /// replay 소스(seq 오름차순).
  final List<Map<String, dynamic>> history = [];

  Map<String, dynamic> snapshotBody = {'teams': [], 'members': [], 'pending': [], 'tasks': []};
  int? snapshotSeq;

  int get connections => _all.length;
  int get helloCount => requests.where((r) => r.$1 == 'hello').length;
  Uri get url => Uri.parse('ws://127.0.0.1:${_server.port}');

  List<Map<String, dynamic>> paramsOf(String method) =>
      requests.where((r) => r.$1 == method).map((r) => r.$2).toList(growable: false);

  int countOf(String method) => requests.where((r) => r.$1 == method).length;

  Future<void> start() async {
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server.listen((req) async {
      if (!WebSocketTransformer.isUpgradeRequest(req)) {
        req.response.statusCode = 400;
        await req.response.close();
        return;
      }
      final ws = await WebSocketTransformer.upgrade(req);
      _all.add(ws);
      var authed = false;
      ws.listen((data) async {
        final msg = jsonDecode(data as String) as Map<String, dynamic>;
        final id = msg['id'];
        final method = msg['method'] as String;
        final params = (msg['params'] as Map?)?.cast<String, dynamic>() ?? {};
        requests.add((method, params));
        void send(Map<String, dynamic> m) {
          // stop() 의 server.close(force:true) 뒤에는 readyState 가 open 인 채 sink 만 닫혀 있을 수 있다
          // (핸들러를 await 한 뒤 늦게 도착한 응답) — 테스트를 깨지 않게 삼킨다.
          if (ws.readyState != WebSocket.open) return;
          try {
            ws.add(jsonEncode(m));
          } on StateError {
            // StreamSink is closed
          }
        }

        void reply(Object? result) => send({'jsonrpc': '2.0', 'id': id, 'result': result});
        void error(int code, String message, [Object? data]) =>
            send({'jsonrpc': '2.0', 'id': id, 'error': {'code': code, 'message': message, 'data': ?data}});

        if (!authed) {
          if (method != 'hello' || params['token'] != token) {
            error(-32001, 'unauthorized');
            ws.close(4001, 'unauthorized');
            return;
          }
          authed = true;
          _authed.add(ws);
          final seq = snapshotSeq ?? (history.isEmpty ? 0 : history.last['seq'] as int);
          reply({
            'daemon': {'version': version, 'pid': pid},
            'snapshot': {'seq': seq, ...snapshotBody},
          });
          final since = params['since'];
          if (since is num) {
            for (final ev in history) {
              if ((ev['seq'] as int) > since) {
                ws.add(jsonEncode({'jsonrpc': '2.0', 'method': 'event', 'params': ev}));
              }
            }
          }
          return;
        }
        final h = handlers[method];
        if (h == null) {
          error(-32601, 'method not found: $method');
          return;
        }
        try {
          reply(await h(params));
        } on FakeRpcError catch (e) {
          error(e.code, e.message, e.data);
        }
      }, onDone: () {
        _all.remove(ws);
        _authed.remove(ws);
      });
    });
  }

  void push(String method, Map<String, dynamic> params) {
    final text = jsonEncode({'jsonrpc': '2.0', 'method': method, 'params': params});
    for (final ws in List.of(_authed)) {
      ws.add(text);
    }
  }

  void emitEvent(Map<String, dynamic> ev) {
    history.add(ev);
    push('event', ev);
  }

  Future<void> closeAll([int code = 1001]) async {
    for (final ws in List.of(_all)) {
      await ws.close(code, 'bye');
    }
  }

  Future<void> stop() async {
    await closeAll();
    await _server.close(force: true);
  }
}
