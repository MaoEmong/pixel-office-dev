// 패널 위젯 테스트 공용: 가짜 데몬 + 실제 RpcClient/OfficeNotifier 를 ProviderScope 로 묶어 띄운다.
// 소켓 I/O 가 실제로 돌아야 하므로 각 테스트 본문은 `tester.runAsync` 안에서 실행하고, 조건은 `pumpUntil` 로 기다린다.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/rpc/rpc_client.dart';
import 'package:pixel_office/state/office_state.dart';

import '../fake_daemon.dart' show sampleEvent;
import 'panel_fake_daemon.dart';

export '../fake_daemon.dart' show sampleEvent;
export 'panel_fake_daemon.dart';

Map<String, dynamic> memberJson(
  String id, {
  String status = 'idle',
  String name = '',
  String engine = 'claude',
  String createdAt = '',
  String rank = 'member',
  String departmentId = 'd1',
  String? teamId = 't1',
  String? parentId,
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
      'createdAt': createdAt.isEmpty ? DateTime.now().toUtc().subtract(const Duration(minutes: 90)).toIso8601String() : createdAt,
      'updatedAt': 'u',
    };

Map<String, dynamic> departmentJson({String id = 'd1', String name = 'alpha', String cwd = 'D:/proj/pixel', String? headId}) =>
    {'id': id, 'name': name, 'cwd': cwd, 'headId': headId, 'createdAt': 'c'};

Map<String, dynamic> teamJson({String id = 't1', String name = 'pixel', String cwd = 'D:/proj/pixel', String departmentId = 'd1'}) => {
      'id': id,
      'departmentId': departmentId,
      'name': name,
      'cwd': cwd,
      'leaderId': null,
      'maxMembers': 5,
      'allowedEngines': ['claude', 'codex'],
      'createdAt': 'c',
    };

/// 스냅샷 `pending` 행(status open). [payload] 는 approval 이면 `{tool_name, tool_input}`, question 이면 `{questions}` 등.
Map<String, dynamic> pendingJson(
  String id, {
  String memberId = 'm1',
  String type = 'approval',
  required Map<String, dynamic> payload,
  String? createdAt,
}) =>
    {
      'id': id,
      'memberId': memberId,
      'type': type,
      'payload': payload,
      'status': 'open',
      'createdAt': createdAt ?? DateTime.now().toUtc().toIso8601String(),
      'answeredAt': null,
      'answer': null,
    };

/// 기본 스냅샷(팀 1, 멤버 m1 working / m2 idle)과 기본 핸들러(attach/detach/type/resize/events.query 빈 결과)를 가진 가짜 데몬.
Future<PanelFakeDaemon> startDaemon() async {
  final d = PanelFakeDaemon();
  d.snapshotBody = {
    'departments': [departmentJson(headId: 'mH')],
    'teams': [teamJson()],
    'members': [
      memberJson('m1', status: 'working', name: '하루', parentId: 'mH'),
      memberJson('m2', status: 'idle', name: '모시', engine: 'codex', parentId: 'mH'),
    ],
    'pending': [],
    'tasks': [],
  };
  d.snapshotSeq = 10;
  d.handlers['events.query'] = (_) => {'events': <Map<String, dynamic>>[]};
  d.handlers['member.attach'] = (p) => {'screen': 'SCREEN:${p['memberId']}', 'cols': p['cols'], 'rows': p['rows']};
  d.handlers['member.detach'] = (_) => {};
  d.handlers['member.type'] = (_) => {};
  d.handlers['member.resize'] = (_) => {};
  await d.start();
  return d;
}

List<Override> panelOverrides(PanelFakeDaemon daemon) => [
      rpcClientProvider.overrideWith((ref) {
        final c = RpcClient(
          minBackoff: const Duration(milliseconds: 20),
          maxBackoff: const Duration(milliseconds: 50),
          callTimeout: const Duration(seconds: 3),
        );
        ref.onDispose(c.close);
        return c;
      }),
      daemonConnectorProvider.overrideWithValue(DaemonConnector(urlProvider: () => daemon.url, tokenProvider: () => 'tok')),
    ];

GlobalKey? _appKey;

/// 테스트 하나 안에서만 같은 키를 쓴다(테스트가 끝나면 버림 — 한 테스트의 트리가 깨져도 다음 테스트로 번지지 않게).
GlobalKey _keyForThisTest() {
  final existing = _appKey;
  if (existing != null) return existing;
  final key = GlobalKey();
  _appKey = key;
  addTearDown(() => _appKey = null);
  return key;
}

/// ProviderScope + MaterialApp(dark) + 고정 크기(오른쪽 패널 기본 폭 480 — T40-4 에서 420~720 이 됐다) 로 child 를 띄운다.
/// 같은 테스트 안에서 자식만 바꿔 다시 띄우려면(dispose·멤버 교체) `overrides` 를 같은 리스트로 넘긴다
/// — ProviderScope 는 overrides 목록이 바뀌는 것을 허용하지 않는다.
Future<ProviderContainer> pumpPanel(
  WidgetTester tester,
  PanelFakeDaemon daemon,
  Widget child, {
  Size size = const Size(480, 700),
  List<Override>? overrides,
}) async {
  // 키를 고정해 같은 테스트 안에서 다시 띄우면 MaterialApp 아래 트리가 유지된다(멤버 교체 = didUpdateWidget 경로).
  final key = _keyForThisTest();
  await tester.pumpWidget(
    ProviderScope(
      overrides: overrides ?? panelOverrides(daemon),
      child: MaterialApp(
        key: key,
        debugShowCheckedModeBanner: false,
        theme: ThemeData(brightness: Brightness.dark, useMaterial3: true),
        home: Scaffold(body: Center(child: SizedBox(width: size.width, height: size.height, child: child))),
      ),
    ),
  );
  await tester.pump();
  return ProviderScope.containerOf(key.currentContext!);
}

/// [pumpUntil] 이 실제로 기다리는 시간의 상한. 조건이 차면 바로 돌아오므로 통과하는 실행은 이 값에 영향받지 않는다
/// — 실패를 빨리 내려고 5초로 두었더니 머신이 잠깐 멈출 때(전체 suite 동시 실행·디스크 스캔 등) 멀쩡한 테스트가
/// `pumpUntil timeout` 으로 깨졌다(T18: `test/panel/` 한 판이 3~4초 대신 9초 걸리며 1건 실패). 20초로 올린다.
const Duration pumpUntilTimeout = Duration(seconds: 20);

/// `runAsync` 안에서: 조건이 참이 될 때까지 pump + 실시간 대기.
Future<void> pumpUntil(WidgetTester tester, bool Function() cond, {Duration timeout = pumpUntilTimeout, String? reason}) async {
  final deadline = DateTime.now().add(timeout);
  while (true) {
    await tester.pump();
    if (cond()) return;
    if (DateTime.now().isAfter(deadline)) fail('pumpUntil timeout${reason == null ? '' : ': $reason'}');
    await Future<void>.delayed(const Duration(milliseconds: 15));
  }
}

/// 연결이 되고 스냅샷 멤버가 들어올 때까지.
Future<void> pumpUntilConnected(WidgetTester tester, ProviderContainer c) =>
    pumpUntil(tester, () => c.read(connectionStateProvider) == RpcConnectionState.connected && c.read(membersProvider).isNotEmpty, reason: 'connected');

Map<String, dynamic> ev(int seq, {String memberId = 'm1', String kind = 'reading', Map<String, dynamic>? detail}) =>
    sampleEvent(seq, memberId: memberId, kind: kind, detail: detail);
