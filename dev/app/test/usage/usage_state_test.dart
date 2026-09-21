// T43-2 ①: 상태 층 — 스냅샷 `usage` 적용, `usage.engine`/`usage.member` 알림, 멤버 행이 사라질 때의 정리,
// 그리고 프로바이더 3종(engineUsage / memberUsage / departmentUsageRows 정렬).
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/state/office_state.dart';

import '../command/fake_rpc_client.dart';

/// 브로드캐스트 스트림이 리스너에 닿을 때까지(마이크로태스크 한 바퀴).
Future<void> settle() => Future<void>.delayed(Duration.zero);

Map<String, dynamic> engineJson(
  String engine, {
  bool connected = true,
  String? reason,
  String? plan,
  num? weeklyUsed,
  String? weeklyResetsAt,
  num? sessionUsed,
  String? updatedAt,
}) =>
    {
      'engine': engine,
      'connected': connected,
      'reason': reason,
      'plan': plan,
      'weekly': weeklyUsed == null ? null : {'usedPercent': weeklyUsed, 'resetsAt': weeklyResetsAt},
      'session': sessionUsed == null ? null : {'usedPercent': sessionUsed},
      'updatedAt': updatedAt,
    };

Map<String, dynamic> memberJson(String id, {num? percent, int total = 1000, double? cost, String engine = 'claude'}) => {
      'memberId': id,
      'engine': engine,
      'context': percent == null ? null : {'used': 1000, 'window': 10000, 'percent': percent},
      'tokens': {'total': total},
      'costUsd': cost,
      'updatedAt': '2026-09-21T10:00:00Z',
    };

void main() {
  late FakeRpcClient fake;
  late ProviderContainer c;

  setUp(() {
    fake = FakeRpcClient();
    c = ProviderContainer(overrides: fake.overrides);
    c.read(officeProvider); // 구독 시작
  });

  tearDown(() async {
    c.dispose();
    await fake.close();
  });

  Future<void> hello({
    List<Map<String, dynamic>> members = const [],
    Map<String, dynamic>? usage,
  }) async {
    fake.emitHello(
      departments: [fakeDepartment('d1', headId: 'mH')],
      members: members,
      usage: usage,
    );
    await settle();
  }

  group('스냅샷', () {
    test('usage.engines / usage.members 를 상태로 옮긴다', () async {
      await hello(
        members: [fakeMember('m1', name: '하루')],
        usage: {
          'engines': [engineJson('claude', plan: 'max', weeklyUsed: 55)],
          'members': [memberJson('m1', percent: 37, total: 358600, cost: 1.84)],
        },
      );
      final s = c.read(officeProvider);
      expect(s.engineUsage[Engine.claude]!.plan, 'max');
      expect(s.memberUsage['m1']!.contextPercent, 37);
      expect(c.read(memberUsageProvider('m1'))!.tokens!.total, 358600);
      expect(c.read(engineUsageProvider(Engine.claude)).weekly!.usedPercent, 55);
    });

    test('usage 가 없는 옛 데몬이면 프로바이더가 "아직 모름" 을 준다(연결 안 됨이 아니다)', () async {
      await hello(members: [fakeMember('m1')]);
      final u = c.read(engineUsageProvider(Engine.codex));
      expect(u.engine, Engine.codex);
      expect(u.connected, isTrue);
      expect(u.hasLimits, isFalse);
      expect(c.read(memberUsageProvider('m1')), isNull);
    });

    test('재접속(스냅샷 재적용) 때 엔진 행은 남고, 사라진 멤버의 값은 지워진다', () async {
      await hello(
        members: [fakeMember('m1'), fakeMember('m2')],
        usage: {
          'engines': [engineJson('claude', weeklyUsed: 10)],
          'members': [memberJson('m1', percent: 20), memberJson('m2', percent: 30)],
        },
      );
      expect(c.read(officeProvider).memberUsage.keys, containsAll(['m1', 'm2']));

      // 두 번째 스냅샷: m2 가 사라졌고 usage 는 아예 실려 오지 않았다.
      fake.pushNotification('snapshot', {
        'seq': 20,
        'departments': [fakeDepartment('d1', headId: 'mH')],
        'teams': <Map<String, dynamic>>[],
        'members': [fakeMember('m1')],
        'pending': <Map<String, dynamic>>[],
        'tasks': <Map<String, dynamic>>[],
      });
      await settle();
      final s = c.read(officeProvider);
      expect(s.engineUsage[Engine.claude]!.weekly!.usedPercent, 10, reason: '엔진 행은 마지막 값을 남긴다');
      expect(s.memberUsage.keys, ['m1'], reason: '멤버 행이 사라지면 그 사용량도 간다');
    });
  });

  group('알림', () {
    test('usage.engine 이 그 엔진만 갈아끼운다', () async {
      await hello(usage: {
        'engines': [engineJson('claude', weeklyUsed: 10), engineJson('codex', weeklyUsed: 20)],
      });
      fake.pushNotification('usage.engine', engineJson('codex', connected: false, reason: 'logged-out'));
      await settle();
      expect(c.read(engineUsageProvider(Engine.claude)).weekly!.usedPercent, 10);
      final codex = c.read(engineUsageProvider(Engine.codex));
      expect(codex.connected, isFalse);
      expect(codex.reason, UsageReason.loggedOut);
    });

    test('모르는 엔진의 usage.engine 은 무시한다', () async {
      await hello();
      fake.pushNotification('usage.engine', {'engine': 'gemini', 'connected': true});
      await settle();
      expect(c.read(officeProvider).engineUsage, isEmpty);
    });

    test('usage.member 가 그 멤버만 갈아끼운다', () async {
      await hello(members: [fakeMember('m1'), fakeMember('m2')]);
      fake.pushNotification('usage.member', memberJson('m1', percent: 72, total: 1200));
      await settle();
      expect(c.read(memberUsageProvider('m1'))!.contextPercent, 72);
      expect(c.read(memberUsageProvider('m2')), isNull);
    });

    test('행이 없는 멤버의 usage.member 는 무시한다(지워진 멤버가 되살아나지 않게)', () async {
      await hello(members: [fakeMember('m1')]);
      fake.pushNotification('usage.member', memberJson('mZ', percent: 50));
      await settle();
      expect(c.read(officeProvider).memberUsage.keys, isEmpty);
    });

    test('알림은 lastSeq 를 건드리지 않는다(비영속 · seq 없음)', () async {
      await hello(members: [fakeMember('m1')]);
      final before = c.read(lastSeqProvider);
      fake.pushNotification('usage.member', memberJson('m1', percent: 5));
      fake.pushNotification('usage.engine', engineJson('claude', weeklyUsed: 5));
      await settle();
      expect(c.read(lastSeqProvider), before);
    });
  });

  group('departmentUsageRowsProvider', () {
    test('컨텍스트 큰 순, 값 없는 사람은 맨 뒤', () async {
      await hello(
        members: [
          fakeMember('m1', name: '하루', createdAt: 'a'),
          fakeMember('m2', name: '모시', createdAt: 'b'),
          fakeMember('m3', name: '이음', createdAt: 'c'),
          fakeMember('m4', name: '나린', createdAt: 'd'),
        ],
        usage: {
          'members': [
            memberJson('m1', percent: 12),
            memberJson('m2', percent: 91),
            memberJson('m3', percent: 44),
          ],
        },
      );
      final rows = c.read(departmentUsageRowsProvider('d1'));
      expect(rows.map((r) => r.member.id), ['m2', 'm3', 'm1', 'm4']);
      expect(rows.last.usage, isNull);
      expect(rows.first.contextPercent, 91);
    });

    test('같은 비율이면 createdAt 순으로 안정적이다', () async {
      await hello(
        members: [fakeMember('mB', createdAt: 'b'), fakeMember('mA', createdAt: 'a')],
        usage: {
          'members': [memberJson('mA', percent: 50), memberJson('mB', percent: 50)],
        },
      );
      expect(c.read(departmentUsageRowsProvider('d1')).map((r) => r.member.id), ['mA', 'mB']);
    });

    test('부서가 없으면 빈 목록', () async {
      await hello(members: [fakeMember('m1')]);
      expect(c.read(departmentUsageRowsProvider(null)), isEmpty);
      expect(c.read(departmentUsageRowsProvider('dX')), isEmpty);
    });
  });
}
