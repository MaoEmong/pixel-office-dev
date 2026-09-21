// T43-2 ②: 단위·문구·색 포매터(순수 함수). 설계문서 §앱 4 "토큰은 358k · 1.2M, 리셋은 3일 뒤 / 5시간 뒤 / 곧"
// 와 D-45 3 "앱은 전부 남음 N%".
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/usage/usage_format.dart';

final now = DateTime.parse('2026-09-21T10:00:00Z');

EngineUsage engine({
  Engine engine = Engine.claude,
  bool connected = true,
  UsageReason? reason,
  double? weeklyUsed,
  DateTime? resetsAt,
  DateTime? updatedAt,
}) =>
    EngineUsage(
      engine: engine,
      connected: connected,
      reason: reason,
      weekly: weeklyUsed == null ? null : UsageWindow(usedPercent: weeklyUsed, resetsAt: resetsAt),
      updatedAt: updatedAt,
    );

void main() {
  group('토큰 단위', () {
    test('999 / 358k / 1.2M — 버림', () {
      expect(formatTokens(0), '0');
      expect(formatTokens(999), '999');
      expect(formatTokens(1000), '1k');
      expect(formatTokens(358600), '358k', reason: '반올림하면 359k 가 된다 — 실제보다 크게 말하지 않는다');
      expect(formatTokens(999999), '999k');
      expect(formatTokens(1000000), '1.0M');
      expect(formatTokens(1234567), '1.2M');
      expect(formatTokens(1299999), '1.2M');
    });

    test('null 과 음수', () {
      expect(formatTokens(null), '—');
      expect(formatTokens(-5), '0');
    });
  });

  group('남은 비율', () {
    test('100 - usedPercent, 0~100 으로 자른다', () {
      expect(remainingPercent(55), 45);
      expect(remainingPercent(0), 100);
      expect(remainingPercent(120), 0);
      expect(remainingPercent(-20), 100);
    });

    test('formatPercent 는 반올림', () {
      expect(formatPercent(36.6), '37%');
      expect(formatPercent(0), '0%');
      expect(formatPercent(140), '100%');
    });
  });

  test('비용은 소수 둘째 자리', () {
    expect(formatCost(1.84), r'$1.84');
    expect(formatCost(0), r'$0.00');
    expect(formatCost(12.3456), r'$12.35');
    expect(formatCost(null), isNull);
  });

  group('리셋까지', () {
    String? inAfter(Duration d) => formatResetIn(now.add(d), now: now);

    test('3일 뒤 / 5시간 뒤 / 12분 뒤 / 곧', () {
      expect(inAfter(const Duration(days: 3, hours: 2)), '3일 뒤');
      expect(inAfter(const Duration(days: 1)), '1일 뒤');
      expect(inAfter(const Duration(hours: 5, minutes: 30)), '5시간 뒤');
      expect(inAfter(const Duration(minutes: 12)), '12분 뒤');
      expect(inAfter(const Duration(seconds: 30)), '곧');
      expect(inAfter(const Duration(hours: -3)), '곧', reason: '이미 지난 시각도 "곧"');
      expect(formatResetIn(null), isNull);
    });

    test('절대 시각은 로컬 M월 d일 HH:mm', () {
      final t = DateTime(2026, 9, 24, 18, 5);
      expect(formatResetAt(t), '9월 24일 18:05');
      expect(formatResetAt(null), isNull);
    });
  });

  group('오래된 값', () {
    String? ago(Duration d) => formatStaleness(now.subtract(d), now: now);

    test('10분을 넘었을 때만 말한다', () {
      expect(ago(const Duration(minutes: 3)), isNull);
      expect(ago(const Duration(minutes: 10)), '10분 전', reason: '10분 이상이면 표시');
      expect(ago(const Duration(minutes: 9, seconds: 59)), isNull);
      expect(ago(const Duration(minutes: 12)), '12분 전');
      expect(ago(const Duration(hours: 3)), '3시간 전');
      expect(ago(const Duration(days: 2)), '2일 전');
      expect(formatStaleness(null), isNull);
    });

    test('마지막 확인 줄은 오래되지 않았으면 "방금"', () {
      expect(formatCheckedAt(now.subtract(const Duration(minutes: 2)), now: now), '방금');
      expect(formatCheckedAt(now.subtract(const Duration(minutes: 30)), now: now), '30분 전');
      expect(formatCheckedAt(null), '—');
    });
  });

  group('색', () {
    test('남은 비율: >50 기본 · 20~50 주황 · <20 빨강', () {
      expect(remainingColor(80), usageCalmColor);
      expect(remainingColor(51), usageCalmColor);
      expect(remainingColor(50), usageWarnColor);
      expect(remainingColor(20), usageWarnColor);
      expect(remainingColor(19.9), usageDangerColor);
      expect(remainingColor(0), usageDangerColor);
    });

    test('컨텍스트: <70 기본 · 70~89 주황 · ≥90 빨강', () {
      expect(contextColor(69), usageCalmColor);
      expect(contextColor(70), usageWarnColor);
      expect(contextColor(89.9), usageWarnColor);
      expect(contextColor(90), usageDangerColor);
    });

    test('캔버스 경고 막대는 70 미만이면 아예 없다', () {
      expect(contextWarningColor(null), isNull);
      expect(contextWarningColor(69), isNull);
      expect(contextWarningColor(70), usageWarnColor);
      expect(contextWarningColor(90), usageDangerColor);
    });
  });

  group('칩 문구', () {
    test('정상: Claude 남음 45% · 3일 뒤', () {
      final u = engine(weeklyUsed: 55, resetsAt: now.add(const Duration(days: 3)), updatedAt: now);
      expect(engineChipLabel(u, now: now), 'Claude 남음 45% · 3일 뒤');
      // 45% 남음은 20~50 구간이라 **주황**이다(설계 §앱 1 색 규칙 — 45 는 예시 문구일 뿐 "정상 색" 이 아니다).
      expect(engineChipColor(u), usageWarnColor);
      expect(engineChipColor(engine(weeklyUsed: 20)), usageCalmColor, reason: '남음 80%');
    });

    test('오래된 값이면 꼬리에 "· 12분 전"', () {
      final u = engine(
        weeklyUsed: 55,
        resetsAt: now.add(const Duration(days: 3)),
        updatedAt: now.subtract(const Duration(minutes: 12)),
      );
      expect(engineChipLabel(u, now: now), 'Claude 남음 45% · 3일 뒤 · 12분 전');
    });

    test('주황·빨강 상태', () {
      expect(engineChipColor(engine(weeklyUsed: 70)), usageWarnColor, reason: '남음 30%');
      expect(engineChipColor(engine(weeklyUsed: 95)), usageDangerColor, reason: '남음 5%');
      expect(engineChipLabel(engine(weeklyUsed: 95), now: now), 'Claude 남음 5%');
    });

    test('연결 안 됨 · 측정 전', () {
      final off = engine(engine: Engine.codex, connected: false, reason: UsageReason.notInstalled);
      expect(engineChipLabel(off, now: now), 'Codex 연결 안 됨');
      expect(engineChipColor(off), usageOffColor);

      final fresh = engine(); // 붙었지만 한 번도 한도를 못 봤다
      expect(engineChipLabel(fresh, now: now), 'Claude · 첫 작업 후 표시');
      expect(engineChipColor(fresh), usageCalmColor);
    });

    test('좁을 때: C 45% / X 연결 안 됨 / C —', () {
      expect(engineChipCompactLabel(engine(weeklyUsed: 55)), 'C 45%');
      expect(engineChipCompactLabel(engine(engine: Engine.codex, weeklyUsed: 10)), 'X 90%');
      expect(engineChipCompactLabel(engine(engine: Engine.codex, connected: false)), 'X 연결 안 됨');
      expect(engineChipCompactLabel(engine()), 'C —');
    });

    test('연결 안 됨 툴팁은 이유별로 다르고 할 일을 적는다', () {
      expect(notConnectedTooltip(Engine.codex, UsageReason.notInstalled), 'codex 가 설치돼 있지 않습니다');
      expect(notConnectedTooltip(Engine.claude, UsageReason.notInstalled), 'claude 가 설치돼 있지 않습니다');
      expect(notConnectedTooltip(Engine.codex, UsageReason.loggedOut), '로그인이 필요합니다 — 터미널에서 codex login');
      expect(notConnectedTooltip(Engine.claude, UsageReason.loggedOut), '로그인이 필요합니다 — 터미널에서 claude 실행 후 로그인');
      expect(notConnectedTooltip(Engine.claude, UsageReason.unknown), '상태를 확인하지 못했습니다');
      expect(notConnectedTooltip(Engine.claude, null), '상태를 확인하지 못했습니다');
    });
  });

  group('패널 한 줄', () {
    MemberUsage usage({double? percent, int? total, double? cost}) => MemberUsage(
          memberId: 'm1',
          context: percent == null ? null : ContextUsage(used: 74210, window: 200000, percent: percent),
          tokens: total == null ? null : TokenUsage(total: total),
          costUsd: cost,
        );

    test(r'Claude: 37% (74k / 200k) · 토큰 358k · $1.84', () {
      expect(usageLineText(usage(percent: 37, total: 358600, cost: 1.84)), r'37% (74k / 200k) · 토큰 358k · $1.84');
    });

    test('Codex 는 비용 자리가 없다', () {
      expect(usageLineText(usage(percent: 37, total: 358600)), '37% (74k / 200k) · 토큰 358k');
    });

    test('값이 없으면 null(호출부가 "첫 턴 뒤 표시")', () {
      expect(usageLineText(null), isNull);
      expect(usageLineText(usage()), isNull);
      expect(usageNoDataLine, '사용량 — 첫 턴 뒤 표시');
    });

    test('꼬리는 토큰 · 비용 순 — 좁아지면 비용부터 잘린다', () {
      expect(usageLineTail(usage(percent: 37, total: 358600, cost: 1.84)), r'토큰 358k · $1.84');
      expect(usageLineTail(usage(percent: 37, total: 358600)), '토큰 358k');
      expect(usageLineTail(usage(percent: 37)), isNull);
    });

    test('툴팁에는 정확한 값', () {
      final t = usageExactTooltip(MemberUsage(
        memberId: 'm1',
        context: const ContextUsage(used: 74210, window: 200000, percent: 37.1),
        tokens: const TokenUsage(input: 1200, output: 5400, cacheRead: 310000, cacheCreate: 42000, total: 358600),
        costUsd: 1.8412,
      ));
      expect(t, contains('74210 / 200000'));
      expect(t, contains('합계 358600'));
      expect(t, contains(r'$1.8412'));
    });
  });

  test('막대 채움은 0~1 로 잘리고 정수 px', () {
    expect(barFraction(37), closeTo(0.37, 1e-9));
    expect(barFraction(-3), 0);
    expect(barFraction(140), 1);
    expect(barFillWidth(100, 37), 37);
    expect(barFillWidth(48, 33.3), 16);
  });

  test('엔진 이름·기호', () {
    expect(engineLabel(Engine.claude), 'Claude');
    expect(engineLabel(Engine.codex), 'Codex');
    expect(engineMark(Engine.claude), 'C');
    expect(engineMark(Engine.codex), 'X');
  });

  test('팔레트는 레이아웃 v2 §4 토큰과 같은 값', () {
    expect(usageWarnColor, const Color(0xFFFF9F43), reason: '"내 차례" 주황');
    expect(usageDangerColor, const Color(0xFFFF6B6B), reason: '오류 빨강');
    expect(usageCalmColor, const Color(0xFF8A93A8), reason: '보조 글자');
    expect(usageOffColor, const Color(0xFF474D5E), reason: '퇴근 회색');
  });
}
