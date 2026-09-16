// 테스트용 가짜 데몬: dart:io HttpServer + WebSocketTransformer 로 PROTOCOL 의 봉투/hello/replay 를 흉내 낸다.
//  - hello: token 불일치 → -32001 + close 4001. since 가 있으면 seq > since 인 history 를 event 로 replay.
//  - hello 전 다른 메서드 → -32001 + close 4001.
//  - echo{delayMs?} → params 그대로. fail → -32003(data 포함). hang → 응답 없음.
//  - push(method, params): 인증된 모든 소켓에 알림. closeAll(): 소켓 전부 닫기(재접속 테스트).

import 'dart:async';
import 'dart:convert';
import 'dart:io';

class FakeDaemon {
  FakeDaemon({this.token = 'tok', this.version = '9.9.9', this.pid = 4242});

  final String token;
  final String version;
  final int pid;

  late HttpServer _server;
  final List<WebSocket> _authed = [];
  final List<WebSocket> _all = [];

  /// 지금까지 받은 hello params(순서대로).
  final List<Map<String, dynamic>> helloParams = [];

  /// 요청 전부(method, params).
  final List<(String, Map<String, dynamic>)> requests = [];

  /// replay 소스. seq 오름차순.
  final List<Map<String, dynamic>> history = [];

  /// 스냅샷 본문(seq 는 history 마지막 seq 또는 [snapshotSeq]).
  Map<String, dynamic> snapshotBody = {'departments': [], 'teams': [], 'members': [], 'pending': [], 'tasks': []};
  int? snapshotSeq;

  /// 메서드별 응답(등록 안 된 메서드는 아래 기본 동작 → -32601).
  final Map<String, Map<String, dynamic> Function(Map<String, dynamic>)> handlers = {};

  /// 마지막으로 받은 그 메서드의 params(없으면 null).
  Map<String, dynamic>? paramsOf(String method) {
    for (final r in requests.reversed) {
      if (r.$1 == method) return r.$2;
    }
    return null;
  }

  int countOf(String method) => requests.where((r) => r.$1 == method).length;

  int get connections => _all.length;
  Uri get url => Uri.parse('ws://127.0.0.1:${_server.port}');

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
      ws.listen((data) {
        final msg = jsonDecode(data as String) as Map<String, dynamic>;
        final id = msg['id'];
        final method = msg['method'] as String;
        final params = (msg['params'] as Map?)?.cast<String, dynamic>() ?? {};
        requests.add((method, params));
        void send(Map<String, dynamic> m) {
          if (ws.readyState == WebSocket.open) ws.add(jsonEncode(m));
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
          helloParams.add(params);
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
        final handler = handlers[method];
        if (handler != null) {
          reply(handler(params));
          return;
        }
        switch (method) {
          case 'hello':
            authed = false;
            error(-32003, 'already said hello');
          case 'echo':
            final delay = (params['delayMs'] as num?)?.toInt() ?? 0;
            Future.delayed(Duration(milliseconds: delay), () => reply(params));
          case 'fail':
            error(-32003, 'bad state', {'why': 'test'});
          case 'hang':
            break;
          case 'empty':
            reply({});
          default:
            error(-32601, 'method not found: $method');
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

  /// history 에 추가하고 라이브로도 보낸다.
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

Map<String, dynamic> sampleEvent(int seq, {String memberId = 'm1', String kind = 'reading', Map<String, dynamic>? detail, Map<String, dynamic>? ref}) => {
      'seq': seq,
      'ts': '2026-09-15T00:00:${seq.toString().padLeft(2, '0')}.000Z',
      'departmentId': 'd1',
      'teamId': 't1',
      'memberId': memberId,
      'kind': kind,
      'detail': detail ?? {'tool': 'Read', 'path': 'lib/main.dart'},
      'ref': ref ?? {'approvalId': null, 'questionId': null, 'taskId': null},
    };
