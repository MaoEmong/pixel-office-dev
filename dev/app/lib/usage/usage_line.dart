// 오른쪽 패널 헤더의 사용량 한 줄(T43-2 ⑤ · 설계 §앱 2) — cwd 줄 **아래**.
//
//   컨텍스트 [▓▓▓░░░░░] 37% (74k / 200k) · 토큰 358k · $1.84
//
// 막대 색: <70 기본 · 70~89 주황 · ≥90 빨강(곧 자동 요약이 일어난다는 뜻). Codex 는 비용 자리 없음.
// 값이 아직 없으면 `사용량 — 첫 턴 뒤 표시`.
//
// **높이는 늘 한 줄**이다(패널 420px 에서도). 인박스·탭이 밀리지 않게 줄바꿈하지 않고, 좁아지면
// 꼬리(토큰·비용)부터 말줄임한다 — 비용이 먼저 잘리고 그다음 토큰이다(설계: 컨텍스트가 제일 중요).
// 막대 글자(▓░)는 **쓰지 않는다** — 번들 서체 3종에 없는 글자는 두부가 된다(T40 편차 ⑤). 막대는 도형이다.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/office_state.dart';
import 'usage_bar.dart';
import 'usage_format.dart';

/// 한 줄의 고정 높이(패널 레이아웃이 이 줄 때문에 출렁이지 않게).
const double usageLineHeight = 16;

/// 헤더 한 줄 앞의 라벨.
const String usageLineLabel = '컨텍스트';

class MemberUsageLine extends ConsumerWidget {
  const MemberUsageLine({super.key, required this.memberId});

  final String memberId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final usage = ref.watch(memberUsageProvider(memberId));
    final text = usageLineText(usage);
    if (usage == null || text == null) {
      return const SizedBox(
        height: usageLineHeight,
        child: Text(
          usageNoDataLine,
          key: Key('panel.usage.empty'),
          style: TextStyle(fontSize: 11, color: usageCalmColor),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      );
    }
    final ctx = usage.context;
    final percent = ctx?.percent;
    final color = percent == null ? usageCalmColor : contextColor(percent);
    final head = ctx == null
        ? null
        : '${formatPercent(ctx.percent)}'
            '${ctx.window > 0 ? ' (${formatTokens(ctx.used)} / ${formatTokens(ctx.window)})' : ''}';
    final tail = usageLineTail(usage);
    return Tooltip(
      message: usageExactTooltip(usage),
      child: SizedBox(
        height: usageLineHeight,
        child: Row(
          key: const Key('panel.usage'),
          children: [
            const Text(usageLineLabel, style: TextStyle(fontSize: 11, color: usageCalmColor)),
            if (percent != null) ...[
              const SizedBox(width: 5),
              UsageBar(key: const Key('panel.usage.bar'), percent: percent, color: color, width: 48),
            ],
            if (head != null) ...[
              const SizedBox(width: 5),
              Text(head, key: const Key('panel.usage.context'), style: TextStyle(fontSize: 11, color: color)),
            ],
            if (tail != null) ...[
              const SizedBox(width: 5),
              // 좁아지면 여기부터 잘린다(비용 → 토큰 순으로 사라진다).
              Flexible(
                child: Text(
                  '· $tail',
                  key: const Key('panel.usage.tail'),
                  style: const TextStyle(fontSize: 11, color: usageCalmColor),
                  maxLines: 1,
                  softWrap: false,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
