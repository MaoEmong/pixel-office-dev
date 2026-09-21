// 사용량 표시의 **순수 함수들**(T43-2) — 단위·문구·색. 위젯이 없으므로 단위 테스트로 전부 덮는다.
// 규칙은 `docs/design/사용량-표시.md` §앱 4(단위 표기) 와 D-45 3(앱은 전부 "남음 N%").
//
//   토큰      999 / 358k / 1.2M      (버림 — 358,600 은 "359k" 가 아니라 358k)
//   남은 비율  100 - usedPercent, 0~100 으로 자름
//   리셋      3일 뒤 / 5시간 뒤 / 12분 뒤 / 곧   (1분 미만·지난 시각은 "곧")
//   오래됨    12분 전                 — **10분 넘었을 때만** 보여 준다(그 아래는 null)
//   비용      $1.84                   (Codex 는 값 자체가 없어 호출되지 않는다)

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../model/models.dart';

/// 값이 "오래됐다" 고 말하기 시작하는 나이(설계: 10분↑).
const Duration usageStaleAfter = Duration(minutes: 10);

/// 컨텍스트 막대·캔버스 경고의 경계(주황 70 · 빨강 90).
const double contextWarnPercent = 70;
const double contextDangerPercent = 90;

/// 남은 비율 칩 색의 경계(주황 ≤50 · 빨강 <20).
const double remainingWarnPercent = 50;
const double remainingDangerPercent = 20;

// ---- 팔레트(레이아웃 v2 §4 토큰 — `office/office_painter.dart` 의 OfficeColors 와 같은 값) ----------
// 상단 바·패널은 `lib/office/` 를 import 하지 않으므로(labels.dart 와 같은 규칙) 값만 다시 적는다.

/// 평소(넉넉함) — 보조 글자 색. 사용량은 참고 정보라 평소엔 조용하다(패스 1 시선 서열).
const Color usageCalmColor = Color(0xFF8A93A8);

/// 주황(20~50% 남음 · 컨텍스트 70~89%).
const Color usageWarnColor = Color(0xFFFF9F43);

/// 빨강(<20% 남음 · 컨텍스트 ≥90%).
const Color usageDangerColor = Color(0xFFFF6B6B);

/// 연결 안 됨(회색).
const Color usageOffColor = Color(0xFF474D5E);

/// 막대의 빈 칸.
const Color usageTrackColor = Color(0xFF2A3042);

// ---- 숫자 ------------------------------------------------------------------------------

/// 토큰 수 → `999` / `358k` / `1.2M`. **버림**이라 실제보다 크게 말하지 않는다.
String formatTokens(num? n) {
  if (n == null) return '—';
  final v = n < 0 ? 0 : n;
  if (v < 1000) return '${v.floor()}';
  if (v < 1000000) return '${(v / 1000).floor()}k';
  final m = (v / 100000).floor() / 10; // 소수 첫째 자리까지 버림
  return '${m.toStringAsFixed(1)}M';
}

/// 쓴 비율 → **남은 비율**(0~100). D-45 3: 앱은 전부 "남음 N%".
double remainingPercent(double usedPercent) => (100 - usedPercent).clamp(0, 100).toDouble();

/// 백분율 → `45%`(반올림, 0~100).
String formatPercent(double percent) => '${percent.clamp(0, 100).round()}%';

/// 비용 → `$1.84`. null 이면 null(Codex 는 자리 자체가 없다).
String? formatCost(double? usd) => usd == null ? null : '\$${usd.toStringAsFixed(2)}';

// ---- 시각 ------------------------------------------------------------------------------

/// 리셋까지 남은 시간 → `3일 뒤` / `5시간 뒤` / `12분 뒤` / `곧`. null 이면 null.
String? formatResetIn(DateTime? resetsAt, {DateTime? now}) {
  if (resetsAt == null) return null;
  final d = resetsAt.difference(now ?? DateTime.now());
  if (d.inDays >= 1) return '${d.inDays}일 뒤';
  if (d.inHours >= 1) return '${d.inHours}시간 뒤';
  if (d.inMinutes >= 1) return '${d.inMinutes}분 뒤';
  return '곧';
}

/// 리셋 시각(절대) → 로컬 `9월 24일 18:00`. 팝오버가 상대 표기 옆에 같이 쓴다.
String? formatResetAt(DateTime? resetsAt) {
  if (resetsAt == null) return null;
  final t = resetsAt.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${t.month}월 ${t.day}일 ${two(t.hour)}:${two(t.minute)}';
}

/// 마지막 확인이 오래됐을 때만 `12분 전`(10분 이하면 null — 평소엔 아무 말도 하지 않는다).
String? formatStaleness(DateTime? updatedAt, {DateTime? now, Duration after = usageStaleAfter}) {
  if (updatedAt == null) return null;
  final d = (now ?? DateTime.now()).difference(updatedAt);
  if (d < after) return null;
  if (d.inDays >= 1) return '${d.inDays}일 전';
  if (d.inHours >= 1) return '${d.inHours}시간 전';
  return '${d.inMinutes}분 전';
}

/// 마지막 확인 시각(팝오버의 "마지막 확인" 줄) — 오래되지 않았으면 `방금`.
String formatCheckedAt(DateTime? updatedAt, {DateTime? now}) =>
    updatedAt == null ? '—' : (formatStaleness(updatedAt, now: now) ?? '방금');

// ---- 색 --------------------------------------------------------------------------------

/// 남은 비율 → 칩 색(>50 기본 · 20~50 주황 · <20 빨강).
Color remainingColor(double remaining) {
  if (remaining < remainingDangerPercent) return usageDangerColor;
  if (remaining <= remainingWarnPercent) return usageWarnColor;
  return usageCalmColor;
}

/// 컨텍스트 비율 → 막대 색(<70 기본 · 70~89 주황 · ≥90 빨강).
Color contextColor(double percent) {
  if (percent >= contextDangerPercent) return usageDangerColor;
  if (percent >= contextWarnPercent) return usageWarnColor;
  return usageCalmColor;
}

/// 컨텍스트 비율 → **캔버스 경고 막대 색**. 70 미만이면 null = 아무것도 그리지 않는다(빼기 원칙).
Color? contextWarningColor(double? percent) {
  if (percent == null || percent < contextWarnPercent) return null;
  return percent >= contextDangerPercent ? usageDangerColor : usageWarnColor;
}

// ---- 문구 ------------------------------------------------------------------------------

/// 엔진 표시 이름(칩·표에서 같은 말을 쓴다).
String engineLabel(Engine engine) => switch (engine) {
      Engine.claude => 'Claude',
      Engine.codex => 'Codex',
    };

/// 좁을 때의 한 글자 표시(`C` / `X`).
String engineMark(Engine engine) => switch (engine) {
      Engine.claude => 'C',
      Engine.codex => 'X',
    };

/// 연결이 안 된 엔진의 칩 문구.
const String usageNotConnectedLabel = '연결 안 됨';

/// 한 번도 한도를 못 본 엔진의 칩 꼬리.
const String usageNotMeasuredLabel = '첫 작업 후 표시';

/// 사용량이 아직 없는 멤버의 패널 한 줄.
const String usageNoDataLine = '사용량 — 첫 턴 뒤 표시';

/// 팝오버 표가 비었을 때.
const String usageTableEmptyLabel = '아직 사용 기록이 없습니다 — 첫 턴 뒤에 표시됩니다';

/// 연결 안 됨 칩의 툴팁(이유별). 터미널에서 뭘 치면 되는지까지 적는다.
String notConnectedTooltip(Engine engine, UsageReason? reason) {
  final exe = engine.wire; // claude / codex
  return switch (reason ?? UsageReason.unknown) {
    UsageReason.notInstalled => '$exe 가 설치돼 있지 않습니다',
    UsageReason.loggedOut => engine == Engine.claude
        ? '로그인이 필요합니다 — 터미널에서 claude 실행 후 로그인'
        : '로그인이 필요합니다 — 터미널에서 codex login',
    UsageReason.unknown => '상태를 확인하지 못했습니다',
  };
}

/// 상단 바 엔진 칩의 문구(넓을 때). 예:
///   `Claude 남음 45% · 3일 뒤`  / `Claude 남음 45% · 3일 뒤 · 12분 전`
///   `Codex 연결 안 됨`
///   `Claude · 첫 작업 후 표시`
String engineChipLabel(EngineUsage u, {DateTime? now}) {
  final name = engineLabel(u.engine);
  if (!u.connected) return '$name $usageNotConnectedLabel';
  final weekly = u.weekly;
  if (weekly == null) return '$name · $usageNotMeasuredLabel';
  final parts = <String>[
    '$name 남음 ${formatPercent(remainingPercent(weekly.usedPercent))}',
    ?formatResetIn(weekly.resetsAt, now: now),
    ?formatStaleness(u.updatedAt, now: now),
  ];
  return parts.join(' · ');
}

/// 칩이 줄어드는 세 단계(T43-4). **글자를 빼는 순서가 정해져 있다** — 이름은 마지막까지 지킨다.
enum UsageChipForm {
  /// `Claude 남음 45% · 3일 뒤 · 12분 전`
  full,

  /// `Claude 45%` — "남음"·리셋·신선도만 뺀다. **엔진 이름은 남는다**(T43-4: `C 45%` 는 읽을 수 없었다).
  compact,

  /// `C 45%` — 이름까지 뺀 마지막 수단. 여기서도 넘치면 상단 바 쪽을 손봐야 한다.
  minimal,
}

/// 좁을 때의 칩 문구 — `Claude 45%` / `Codex 연결 안 됨` / `Claude —`.
///
/// 예전에는 `C 45%` / `X 연결 안 됨` 이었는데 **무슨 글자인지 알 수 없었다**(T43-4). 엔진 이름은
/// 짧기도 하거니와 칩이 말해 주는 유일한 것이라 마지막까지 지킨다 — 대신 `남음`·리셋·신선도를 뺀다.
String engineChipCompactLabel(EngineUsage u) => _chipShort(u, engineLabel(u.engine));

/// 그래도 넘칠 때의 마지막 꼴 — `C 45%` / `X 연결 안 됨`.
String engineChipMinimalLabel(EngineUsage u) => _chipShort(u, engineMark(u.engine));

String _chipShort(EngineUsage u, String name) {
  if (!u.connected) return '$name $usageNotConnectedLabel';
  final weekly = u.weekly;
  if (weekly == null) return '$name —';
  return '$name ${formatPercent(remainingPercent(weekly.usedPercent))}';
}

/// 꼴에 맞는 칩 문구.
String engineChipLabelFor(EngineUsage u, UsageChipForm form, {DateTime? now}) => switch (form) {
      UsageChipForm.full => engineChipLabel(u, now: now),
      UsageChipForm.compact => engineChipCompactLabel(u),
      UsageChipForm.minimal => engineChipMinimalLabel(u),
    };

/// 칩 색 — 연결 안 됨은 회색, 아니면 남은 비율로.
Color engineChipColor(EngineUsage u) {
  if (!u.connected) return usageOffColor;
  final weekly = u.weekly;
  if (weekly == null) return usageCalmColor;
  return remainingColor(remainingPercent(weekly.usedPercent));
}

/// 오른쪽 패널 한 줄의 **글자 부분**(막대는 위젯이 그린다):
///   `37% (74k / 200k) · 토큰 358k · $1.84`  — Codex 는 비용 자리 없음.
/// 값이 하나도 없으면 null(호출부가 [usageNoDataLine] 을 쓴다).
String? usageLineText(MemberUsage? u) {
  if (u == null || u.isEmpty) return null;
  final ctx = u.context;
  final head = ctx == null
      ? null
      : ctx.window > 0
          ? '${formatPercent(ctx.percent)} (${formatTokens(ctx.used)} / ${formatTokens(ctx.window)})'
          : formatPercent(ctx.percent);
  final parts = <String>[
    ?head,
    if (u.tokens != null) '토큰 ${formatTokens(u.tokens!.total)}',
    ?formatCost(u.costUsd),
  ];
  return parts.isEmpty ? null : parts.join(' · ');
}

/// 패널 한 줄의 **꼬리**(토큰·비용) — 좁아지면 이 부분부터 말줄임한다(비용 → 토큰 순).
String? usageLineTail(MemberUsage? u) {
  if (u == null) return null;
  final parts = <String>[
    if (u.tokens != null) '토큰 ${formatTokens(u.tokens!.total)}',
    ?formatCost(u.costUsd),
  ];
  return parts.isEmpty ? null : parts.join(' · ');
}

/// 툴팁에 넣는 정확한 값(설계: "툴팁에 정확한 값").
String usageExactTooltip(MemberUsage u) {
  final ctx = u.context;
  final t = u.tokens;
  return [
    if (ctx != null) '컨텍스트 ${ctx.used} / ${ctx.window} (${ctx.percent.toStringAsFixed(1)}%)',
    if (t != null) '토큰 입력 ${t.input} · 출력 ${t.output} · 캐시읽기 ${t.cacheRead} · 캐시생성 ${t.cacheCreate} · 합계 ${t.total}',
    if (u.costUsd != null) '비용 \$${u.costUsd!.toStringAsFixed(4)}',
  ].join('\n');
}

/// 막대 하나의 채움 비율(0~1).
double barFraction(double percent) => (percent / 100).clamp(0, 1).toDouble();

/// 막대 폭 계산(정수 px — 반 픽셀 선이 흐리게 보이지 않게).
double barFillWidth(double width, double percent) => math.max(0, (width * barFraction(percent)).roundToDouble());
