// T43-2 ①: 사용량 모델의 **방어적 파싱**. 설계문서 "CLI 가 업데이트되어 필드 이름이 바뀌면 해당 값만
// '알 수 없음' 으로 떨어지고 나머지는 계속 돈다" 를 그대로 확인한다 — 없는 키·null·타입 불일치·모르는 엔진.
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';

/// 설계문서 §데몬 와이어의 예시 그대로(claude, 연결됨, 주간 55% 사용 + 5시간 12%).
Map<String, dynamic> claudeEngineJson() => {
      'engine': 'claude',
      'connected': true,
      'plan': 'max',
      'weekly': {'usedPercent': 55, 'resetsAt': '2026-09-24T09:00:00Z'},
      'session': {'usedPercent': 12, 'resetsAt': '2026-09-21T15:00:00Z'},
      'updatedAt': '2026-09-21T10:12:03Z',
      'reason': null,
    };

Map<String, dynamic> memberUsageJson() => {
      'memberId': 'm_1',
      'engine': 'claude',
      'context': {'used': 74210, 'window': 200000, 'percent': 37},
      'tokens': {'input': 1200, 'output': 5400, 'cacheRead': 310000, 'cacheCreate': 42000, 'total': 358600},
      'costUsd': 1.84,
      'updatedAt': '2026-09-21T10:12:03Z',
    };

void main() {
  group('EngineUsage 파싱', () {
    test('와이어 예시를 그대로 읽는다', () {
      final u = EngineUsage.tryParse(claudeEngineJson())!;
      expect(u.engine, Engine.claude);
      expect(u.connected, isTrue);
      expect(u.reason, isNull);
      expect(u.plan, 'max');
      expect(u.weekly!.usedPercent, 55);
      expect(u.weekly!.resetsAt, DateTime.parse('2026-09-24T09:00:00Z'));
      expect(u.session!.usedPercent, 12);
      expect(u.updatedAt, DateTime.parse('2026-09-21T10:12:03Z'));
      expect(u.hasLimits, isTrue);
    });

    test('연결 안 됨: weekly/session 이 null 이어도 이유는 남는다', () {
      final u = EngineUsage.tryParse({
        'engine': 'codex',
        'connected': false,
        'reason': 'not-installed',
        'weekly': null,
        'session': null,
        'plan': null,
        'updatedAt': '2026-09-21T10:00:00Z',
      })!;
      expect(u.connected, isFalse);
      expect(u.reason, UsageReason.notInstalled);
      expect(u.weekly, isNull);
      expect(u.hasLimits, isFalse);
    });

    test('모르는 reason 은 unknown, reason 키가 아예 없어도 unknown', () {
      expect(EngineUsage.tryParse({'engine': 'codex', 'connected': false, 'reason': 'rate-limited'})!.reason,
          UsageReason.unknown);
      expect(EngineUsage.tryParse({'engine': 'codex', 'connected': false})!.reason, UsageReason.unknown);
      expect(UsageReason.parse(null), UsageReason.unknown);
      expect(UsageReason.parse('logged-out'), UsageReason.loggedOut);
    });

    test('모르는 엔진은 행 자체를 버린다', () {
      expect(EngineUsage.tryParse({'engine': 'gemini', 'connected': true}), isNull);
      expect(EngineUsage.tryParse({'connected': true}), isNull, reason: 'engine 키 없음');
      expect(EngineUsage.tryParse('nope'), isNull);
    });

    test('필드 이름이 바뀌어도(=키가 사라져도) 나머지는 산다', () {
      // CLI 가 `usedPercent` 를 `used_percentage` 로 바꿨다고 가정 — 주간 값만 "모름" 이 되고 연결·요금제는 그대로.
      final u = EngineUsage.tryParse({
        'engine': 'claude',
        'connected': true,
        'plan': 'max',
        'weekly': {'used_percentage': 55},
      })!;
      expect(u.weekly, isNull);
      expect(u.connected, isTrue);
      expect(u.plan, 'max');
    });

    test('붙어 있으면 이유를 들고 다니지 않는다(옛 값이 실려 와도)', () {
      final u = EngineUsage.tryParse({'engine': 'claude', 'connected': true, 'reason': 'logged-out'})!;
      expect(u.reason, isNull);
    });

    test('문자열 숫자·resetsAt 파싱 실패도 견딘다', () {
      final w = UsageWindow.tryParse({'usedPercent': '42.5', 'resetsAt': 'not-a-time'})!;
      expect(w.usedPercent, 42.5);
      expect(w.resetsAt, isNull);
    });

    test('unknown() 은 "아직 모름" 이지 "연결 안 됨" 이 아니다', () {
      final u = EngineUsage.unknown(Engine.codex);
      expect(u.connected, isTrue);
      expect(u.hasLimits, isFalse);
    });

    // ---- T43-4: 모델별 한도 + 출처 -------------------------------------------------

    test('models[] 와 source 를 읽는다 — 라벨은 CLI 가 준 그대로', () {
      final u = EngineUsage.tryParse({
        ...claudeEngineJson(),
        'models': [
          {'label': 'Fable', 'usedPercent': 55, 'resetsAt': '2026-09-24T08:59:00Z'},
          {'label': 'Nebula 9 preview', 'usedPercent': 3, 'resetsAt': null},
        ],
        'source': 'probe',
      })!;
      expect(u.models.map((m) => m.label), ['Fable', 'Nebula 9 preview'], reason: '모델 이름이 아닐 수 있다 — 해석하지 않는다');
      expect(u.models.first.window.usedPercent, 55);
      expect(u.models.first.window.resetsAt, DateTime.parse('2026-09-24T08:59:00Z'));
      expect(u.models.last.window.resetsAt, isNull, reason: '리셋을 못 읽어도 퍼센트는 산다');
      expect(u.source, UsageSource.probe);
    });

    test('옛 데몬(키 없음)·딴 타입·깨진 행 — 빈 목록이거나 그 행만 버린다', () {
      final old = EngineUsage.tryParse(claudeEngineJson())!;
      expect(old.models, isEmpty, reason: '키가 없으면 빈 목록(null 이 아니다)');
      expect(old.source, isNull);

      final weird = EngineUsage.tryParse({...claudeEngineJson(), 'models': 'nope', 'source': 'ouija'})!;
      expect(weird.models, isEmpty);
      expect(weird.source, isNull, reason: '모르는 출처 문자열은 null');

      final partly = EngineUsage.tryParse({
        ...claudeEngineJson(),
        'models': [
          {'label': 'Fable', 'usedPercent': 55},
          {'usedPercent': 10}, // 라벨 없음 → 버린다
          {'label': '라벨만'}, // 퍼센트 없음 → 버린다
          '문자열',
        ],
      })!;
      expect(partly.models.map((m) => m.label), ['Fable']);
    });

    test('source 는 "turn" 도 읽는다', () {
      expect(EngineUsage.tryParse({...claudeEngineJson(), 'source': 'turn'})!.source, UsageSource.turn);
    });

    test('models 가 다르면 EngineUsage 도 다르다(알림이 씹히지 않게)', () {
      final a = EngineUsage.tryParse({
        ...claudeEngineJson(),
        'models': [
          {'label': 'Fable', 'usedPercent': 55},
        ],
      })!;
      final b = EngineUsage.tryParse({
        ...claudeEngineJson(),
        'models': [
          {'label': 'Fable', 'usedPercent': 56},
        ],
      })!;
      expect(a == b, isFalse);
      expect(a == EngineUsage.tryParse({...claudeEngineJson(), 'models': [{'label': 'Fable', 'usedPercent': 55}]}), isTrue);
    });
  });

  group('MemberUsage 파싱', () {
    test('와이어 예시를 그대로 읽는다', () {
      final u = MemberUsage.tryParse(memberUsageJson())!;
      expect(u.memberId, 'm_1');
      expect(u.engine, Engine.claude);
      expect(u.context!.used, 74210);
      expect(u.context!.window, 200000);
      expect(u.contextPercent, 37);
      expect(u.tokens!.total, 358600);
      expect(u.tokens!.cacheRead, 310000);
      expect(u.costUsd, 1.84);
      expect(u.isEmpty, isFalse);
    });

    test('Codex: 비용 없음 · 캐시 항목 없음 — total 이 없으면 합으로 센다', () {
      final u = MemberUsage.tryParse({
        'memberId': 'm_2',
        'engine': 'codex',
        'context': {'used': 12000, 'window': 272000},
        'tokens': {'input': 900, 'output': 100},
        'costUsd': null,
      })!;
      expect(u.costUsd, isNull);
      expect(u.tokens!.total, 1000);
      // percent 가 없으면 used/window 로 계산한다.
      expect(u.contextPercent, closeTo(4.41, 0.01));
    });

    test('memberId 가 없으면 버린다, 빈 껍데기는 isEmpty', () {
      expect(MemberUsage.tryParse({'engine': 'claude'}), isNull);
      final empty = MemberUsage.tryParse({'memberId': 'm_3'})!;
      expect(empty.isEmpty, isTrue);
      expect(empty.contextPercent, isNull);
    });

    test('context 에 percent·window 가 둘 다 없으면 컨텍스트만 모름', () {
      final u = MemberUsage.tryParse({
        'memberId': 'm_4',
        'context': {'used': 100},
        'tokens': {'total': 5},
      })!;
      expect(u.context, isNull);
      expect(u.tokens!.total, 5);
    });
  });

  group('UsageSnapshot / Snapshot', () {
    test('usage 키가 없는 옛 스냅샷도 죽지 않는다', () {
      final s = Snapshot.fromJson({
        'seq': 3,
        'departments': [],
        'teams': [],
        'members': [],
        'pending': [],
        'tasks': [],
      });
      expect(s.usage.isEmpty, isTrue);
      expect(s.usage.engines, isEmpty);
    });

    test('usage.engines / usage.members 를 맵으로 접는다 — 모르는 엔진 행은 빠진다', () {
      final s = Snapshot.fromJson({
        'seq': 3,
        'departments': [],
        'teams': [],
        'members': [],
        'pending': [],
        'tasks': [],
        'usage': {
          'engines': [
            claudeEngineJson(),
            {'engine': 'gemini', 'connected': true},
            {'engine': 'codex', 'connected': false, 'reason': 'logged-out'},
          ],
          'members': [memberUsageJson(), {'engine': 'claude'}],
        },
      });
      expect(s.usage.engines.keys, containsAll([Engine.claude, Engine.codex]));
      expect(s.usage.engines, hasLength(2));
      expect(s.usage.members.keys, ['m_1']);
    });

    test('usage 가 리스트가 아니거나 딴 타입이어도 빈 것으로 떨어진다', () {
      expect(UsageSnapshot.fromJson(null).isEmpty, isTrue);
      expect(UsageSnapshot.fromJson('x').isEmpty, isTrue);
      expect(UsageSnapshot.fromJson({'engines': 'x', 'members': 3}).isEmpty, isTrue);
    });
  });
}
