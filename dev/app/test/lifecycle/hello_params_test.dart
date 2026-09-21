// T46-2 · 수명주기 §3 · §5: `hello` 가 싣는 두 가지.
//   parentPid            데몬이 부모(앱)를 지켜본다. **"계속 일하기" 면 안 보낸다** = 감시하지 말라는 뜻.
//   activeDepartmentId   지금 보고 있는 부서부터 되살려라(힌트).
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/rpc/rpc_client.dart';
import 'package:pixel_office/state/office_state.dart';

import '../fake_daemon.dart';

void main() {
  late FakeDaemon daemon;
  late RpcClient client;

  setUp(() async {
    daemon = FakeDaemon();
    await daemon.start();
    client = RpcClient(callTimeout: const Duration(milliseconds: 500));
  });

  tearDown(() async {
    await client.close();
    await daemon.stop();
  });

  test('기본은 둘 다 안 보낸다(옛 데몬과 같은 hello)', () async {
    await client.connect(daemon.url);
    await client.hello('tok');
    expect(daemon.helloParams.single.containsKey('parentPid'), isFalse);
    expect(daemon.helloParams.single.containsKey('activeDepartmentId'), isFalse);
  });

  test('parentPid 를 넣으면 그대로 간다(§3 부모 감시)', () async {
    client.parentPid = 1234;
    await client.connect(daemon.url);
    await client.hello('tok');
    expect(daemon.helloParams.single['parentPid'], 1234);
  });

  test('activeDepartmentId 를 넣으면 그대로 간다(§5 복구 순서 힌트)', () async {
    client.activeDepartmentId = 'd7';
    await client.connect(daemon.url);
    await client.hello('tok');
    expect(daemon.helloParams.single['activeDepartmentId'], 'd7');
  });

  test('탭을 바꾸면 **다음** hello 부터 바뀐 부서가 간다(전용 RPC 없음)', () async {
    client.activeDepartmentId = 'd1';
    await client.connect(daemon.url);
    await client.hello('tok');
    client.activeDepartmentId = 'd2';
    await client.disconnect();
    await client.connect(daemon.url);
    await client.hello('tok');
    expect(daemon.helloParams.map((p) => p['activeDepartmentId']), ['d1', 'd2']);
  });

  test('계속 일하기: parentPid 를 null 로 두면 파라미터 자체가 없다', () async {
    client.parentPid = null;
    client.activeDepartmentId = 'd1';
    await client.connect(daemon.url);
    await client.hello('tok');
    final p = daemon.helloParams.single;
    expect(p.containsKey('parentPid'), isFalse);
    expect(p['activeDepartmentId'], 'd1');
  });

  test('helloParentPidProvider 가 클라이언트에 꽂힌다(main 이 덮어쓰는 자리)', () {
    final plain = ProviderContainer();
    addTearDown(plain.dispose);
    expect(plain.read(rpcClientProvider).parentPid, isNull);

    final withPid = ProviderContainer(overrides: [helloParentPidProvider.overrideWithValue(4321)]);
    addTearDown(withPid.dispose);
    expect(withPid.read(rpcClientProvider).parentPid, 4321);
  });
}
