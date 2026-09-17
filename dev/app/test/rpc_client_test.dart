import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/rpc/rpc_client.dart';

import 'fake_daemon.dart';

Future<T> firstWhere<T>(Stream<T> s, bool Function(T) test, {Duration timeout = const Duration(seconds: 5)}) =>
    s.firstWhere(test).timeout(timeout);

/// 이미 만족했을 수도 있는 조건을 폴링으로 기다린다.
Future<void> waitFor(bool Function() cond, {Duration timeout = const Duration(seconds: 3)}) async {
  final deadline = DateTime.now().add(timeout);
  while (!cond()) {
    if (DateTime.now().isAfter(deadline)) fail('waitFor timeout');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

void main() {
  late FakeDaemon daemon;
  late RpcClient client;

  setUp(() async {
    daemon = FakeDaemon();
    await daemon.start();
    client = RpcClient(
      callTimeout: const Duration(milliseconds: 500),
      minBackoff: const Duration(milliseconds: 50),
      maxBackoff: const Duration(milliseconds: 100),
    );
  });

  tearDown(() async {
    await client.close();
    await daemon.stop();
  });

  test('hello: daemon 정보·snapshot 반환, lastSeq = snapshot.seq, 상태 connected', () async {
    daemon.snapshotSeq = 12;
    final states = <RpcConnectionState>[];
    client.stateStream.listen(states.add);
    await client.connect(daemon.url);
    expect(client.state, RpcConnectionState.connecting);
    final h = await client.hello('tok');
    expect(h.daemonVersion, '9.9.9');
    expect(h.daemonPid, 4242);
    expect(h.snapshotSeq, 12);
    expect(client.lastSeq, 12);
    expect(client.synced, isTrue);
    expect(client.state, RpcConnectionState.connected);
    await waitFor(() => states.length == 2);
    expect(states, [RpcConnectionState.connecting, RpcConnectionState.connected]);
    expect(daemon.helloParams.single['client'], {'name': 'pixel-office', 'version': '0.1.0'});
    expect(daemon.helloParams.single.containsKey('since'), isFalse);
  });

  test('call: id 상관 — 늦게 오는 응답이 먼저 보낸 요청에 붙는다', () async {
    await client.connect(daemon.url);
    await client.hello('tok');
    final slow = client.call('echo', {'n': 1, 'delayMs': 120});
    final fast = client.call('echo', {'n': 2});
    final results = await Future.wait([slow, fast]);
    expect(results[0]['n'], 1);
    expect(results[1]['n'], 2);
    expect((await client.call('empty')), isEmpty);
  });

  test('call: 에러 응답 → RpcException(code, message, data)', () async {
    await client.connect(daemon.url);
    await client.hello('tok');
    try {
      await client.call('fail');
      fail('should throw');
    } on RpcException catch (e) {
      expect(e.code, RpcException.badState);
      expect(e.message, 'bad state');
      expect(e.data, {'why': 'test'});
    }
    await expectLater(
      client.call('nope'),
      throwsA(isA<RpcException>().having((e) => e.code, 'code', -32601)),
    );
    // 인증 후의 오류는 소켓을 끊지 않는다.
    expect(client.state, RpcConnectionState.connected);
  });

  test('hello: 토큰 불일치 → -32001, 소켓 닫힘 → disconnected', () async {
    await client.connect(daemon.url);
    await expectLater(
      client.hello('wrong'),
      throwsA(isA<RpcException>().having((e) => e.code, 'code', RpcException.auth)),
    );
    await waitFor(() => client.state == RpcConnectionState.disconnected);
    expect(client.isOpen, isFalse);
  });

  test('call: 미접속 -1, 대기 중 끊김 -1, 응답 없음 -2(timeout)', () async {
    await expectLater(client.call('echo'), throwsA(isA<RpcException>().having((e) => e.code, 'code', RpcException.closed)));
    await client.connect(daemon.url);
    await client.hello('tok');
    final hung = client.call('hang');
    await expectLater(hung, throwsA(isA<RpcException>().having((e) => e.code, 'code', RpcException.timeout)));
    final pending = client.call('echo', {'delayMs': 400});
    final closedCheck = expectLater(pending, throwsA(isA<RpcException>().having((e) => e.code, 'code', RpcException.closed)));
    await daemon.closeAll();
    await closedCheck;
  });

  test('replay dedupe: seq <= snapshot.seq 인 replay 는 events 에서 제외, notifications 에는 그대로', () async {
    for (var i = 1; i <= 7; i++) {
      daemon.history.add(sampleEvent(i));
    }
    final raw = <RpcNotification>[];
    final passed = <int>[];
    client.notifications.listen(raw.add);
    client.events.listen((e) => passed.add(e['seq'] as int));

    await client.connect(daemon.url);
    final h = await client.hello('tok', since: 5);
    expect(h.snapshotSeq, 7);
    expect(client.lastSeq, 7);
    // replay(6,7) 가 도착할 때까지 잠깐
    await waitFor(() => raw.any((n) => n.method == 'event' && n.params['seq'] == 7));
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(raw.where((n) => n.method == 'event').map((n) => n.params['seq']), [6, 7]);
    expect(passed, isEmpty);

    daemon.push('event', sampleEvent(8));
    daemon.push('event', sampleEvent(8)); // 중복
    daemon.push('event', sampleEvent(9));
    daemon.push('event', sampleEvent(3)); // 과거
    await firstWhere(client.events, (e) => e['seq'] == 9);
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(passed, [8, 9]);
    expect(client.lastSeq, 9);

    // snapshot 알림도 lastSeq 를 올린다
    daemon.push('snapshot', {'seq': 20, 'teams': [], 'members': [], 'pending': [], 'tasks': []});
    await firstWhere(client.notifications, (n) => n.method == 'snapshot');
    expect(client.lastSeq, 20);
  });

  test('start: 자동 재접속 — 끊기면 backoff 후 다시 붙고 since = lastSeq 를 보낸다', () async {
    daemon.snapshotSeq = 3;
    final states = <RpcConnectionState>[];
    client.stateStream.listen(states.add);
    final hellos = <HelloResult>[];
    client.hellos.listen(hellos.add);

    client.start(urlProvider: () => daemon.url, tokenProvider: () => 'tok');
    // 폴링으로 기다린다 — stateStream 은 브로드캐스트라 구독 전에 붙어 버리면 이벤트를 놓친다(T40c).
    await waitFor(() => client.state == RpcConnectionState.connected, timeout: const Duration(seconds: 10));
    expect(daemon.helloParams.length, 1);
    expect(daemon.helloParams[0].containsKey('since'), isFalse);

    daemon.emitEvent(sampleEvent(4));
    daemon.emitEvent(sampleEvent(5));
    await firstWhere(client.events, (e) => e['seq'] == 5);
    expect(client.lastSeq, 5);

    // 데몬이 끊음 → disconnected → connecting → connected
    daemon.snapshotSeq = null; // history 마지막(5)
    await daemon.closeAll();
    // 브로드캐스트 스트림은 늦게 구독하면 놓치므로 처음부터 모은 states 로 기다린다.
    await waitFor(() => states.contains(RpcConnectionState.disconnected));
    await waitFor(() => states.length >= 5 && states.last == RpcConnectionState.connected);
    expect(daemon.helloParams.length, 2);
    expect(daemon.helloParams[1]['since'], 5);
    await waitFor(() => hellos.length == 2);
    expect(hellos[1].snapshotSeq, 5);
    expect(states, containsAllInOrder([
      RpcConnectionState.connecting,
      RpcConnectionState.connected,
      RpcConnectionState.disconnected,
      RpcConnectionState.connecting,
      RpcConnectionState.connected,
    ]));

    // 재접속 후 라이브 이벤트 계속 수신
    daemon.emitEvent(sampleEvent(6));
    await firstWhere(client.events, (e) => e['seq'] == 6);
    expect(client.reconnectAttempts, 0);

    await client.stop();
    expect(client.state, RpcConnectionState.disconnected);
  });

  test('start: 데몬이 없으면 실패 횟수를 세며 재시도, 나타나면 붙는다', () async {
    final port = daemon.url.port;
    await daemon.stop();
    client.start(urlProvider: () => Uri.parse('ws://127.0.0.1:$port'), tokenProvider: () => 'tok');
    // Windows 는 닫힌 loopback 포트 접속 실패에 ~2초 걸린다(SYN 재전송) → 넉넉히 기다린다.
    await waitFor(() => client.reconnectAttempts >= 2, timeout: const Duration(seconds: 30));
    expect(client.state, RpcConnectionState.disconnected);
    expect(client.lastError, isNotNull);

    // daemon.json 이 없는 경우(null) 도 같은 경로
    await client.stop();
    // T41: 문구는 주입 가능하다 — 앱은 여기에 "찾아본 경로 + 환경변수 유무" 를 넣는다.
    final c2 = RpcClient(
      minBackoff: const Duration(milliseconds: 20),
      maxBackoff: const Duration(milliseconds: 20),
      noDaemonInfoMessage: 'daemon.json 없음 — 찾은 곳: C:/fake/daemon.json',
    );
    final attempts = <int>[];
    c2.attemptStream.listen(attempts.add);
    c2.start(urlProvider: () => null, tokenProvider: () => null);
    await waitFor(() => c2.reconnectAttempts >= 2);
    expect(c2.lastError.toString(), contains('C:/fake/daemon.json'));
    await waitFor(() => attempts.length >= 2);
    expect(attempts.take(2), [1, 2]); // 소켓을 열지 못한 시도도 attemptStream 으로 알린다
    await c2.close();

    // 같은 포트로 데몬이 다시 뜨면 붙는다
    daemon = FakeDaemon();
    await daemon.start();
    client = RpcClient(minBackoff: const Duration(milliseconds: 20), maxBackoff: const Duration(milliseconds: 40));
    client.start(urlProvider: () => daemon.url, tokenProvider: () => 'tok');
    // 폴링으로 기다린다 — stateStream 은 브로드캐스트라 구독 전에 붙어 버리면 이벤트를 놓친다(T40c).
    await waitFor(() => client.state == RpcConnectionState.connected, timeout: const Duration(seconds: 10));
    expect(client.reconnectAttempts, 0);
  });
}
