// 상단 바 엔진 칩 두 개(T43-2 ③ · 설계 §앱 1). 데몬 pill **왼쪽**에 선다.
//
//   Claude 남음 45% · 3일 뒤        (오래된 값이면 꼬리에 "· 12분 전")
//   Codex 연결 안 됨                (툴팁에 이유와 할 일)
//   Claude · 첫 작업 후 표시        (붙었지만 한 번도 한도를 못 봤다)
//
// 칩은 **엔진마다 항상 하나씩**이다 — 데몬이 아직 아무 말도 안 했어도 자리를 비우지 않는다
// (`engineUsageProvider` 가 EngineUsage.unknown 을 준다).
//
// 좁은 창(패스 6: 최소 1100×640)에서는 글자를 뺀다 — 상단 바가 넘치기 **전에** 줄어든다
// (패스 1 D7 "글자 빼기" 와 같은 원칙). **빼는 순서가 정해져 있다**(T43-4):
//
//   1500↑  `Claude 남음 45% · 3일 뒤`   (full)
//   1500↓  `Claude 45%`                 (compact — "남음"·리셋·신선도만 뺀다. **이름은 남긴다**)
//   1000↓  `C 45%`                      (minimal — 마지막 수단)
//
// 예전에는 1500 아래가 바로 `C 45%` / `X 연결 안 됨` 이었는데 **무슨 글자인지 알 수 없었다**.
// 기본 창(1280)·1400 에서 쓰는 꼴이 그것이면 사실상 늘 암호였던 셈이다.
//
// 사용량은 참고 정보다(패스 1 시선 서열: 허가 카드 > 내 책상 > 부장 > 클러스터 > 로그). 그래서 평소엔
// 보조 글자 색이고, 남은 양이 적을 때만 주황·빨강이 든다.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../state/office_state.dart';
import 'usage_format.dart';
import 'usage_popover.dart';

/// 상단 바가 이 폭보다 좁으면 칩이 짧은 꼴로 바뀐다.
///
/// **왜 1500 인가**: 상단 바는 이미 빽빽하다(앱 이름 · 부서 탭 · 선택 멤버 + 퇴근 · 데몬 pill ·
/// "멤버 N · 대기 N" · 보고 배지 · "부서 만들기" · ⋮). 긴 꼴 칩 두 개는 300px 을 넘게 먹어서
/// 패스 6 창 크기 표의 1280(기본)·1400 에서는 긴 꼴이 들어갈 자리가 없다 — 실제로 1400 에서
/// RenderFlex 가 160px 넘쳤다. 1920 창부터 긴 꼴이 뜬다. 짧은 꼴에서도 툴팁에 원문이 그대로 있다.
const double usageChipsCompactWidth = 1500;

/// 이 폭보다 좁으면 엔진 **이름까지** 뺀 마지막 꼴(`C 45%`)로 간다.
///
/// **왜 1000 인가**: 패스 6 의 최소 창은 1100 이고, 거기서도 `Claude 45%` 두 개(약 190px)는 들어간다
/// (레이아웃 테스트가 1100·1280·1400·1920 에서 넘치지 않는 것을 지킨다). 1000 은 그보다 더 좁게
/// 줄였을 때의 안전망이다 — 최소 창 아래는 지원 범위가 아니지만 넘쳐 보이느니 암호가 낫다.
const double usageChipsMinimalWidth = 1000;

/// 이 폭에 맞는 칩 꼴.
UsageChipForm usageChipForm(double topBarWidth) {
  if (topBarWidth < usageChipsMinimalWidth) return UsageChipForm.minimal;
  if (topBarWidth < usageChipsCompactWidth) return UsageChipForm.compact;
  return UsageChipForm.full;
}

/// 이 폭에서 칩을 줄일지(= full 이 아닌가).
bool usageChipsCompact(double topBarWidth) => usageChipForm(topBarWidth) != UsageChipForm.full;

/// 엔진 칩 두 개(Claude · Codex). 순서는 [Engine.values] 고정.
class EngineUsageChips extends StatelessWidget {
  const EngineUsageChips({super.key, this.form = UsageChipForm.full});

  final UsageChipForm form;

  @override
  Widget build(BuildContext context) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final e in Engine.values) ...[
            EngineUsageChip(engine: e, form: form),
            const SizedBox(width: 6),
          ],
        ],
      );
}

class EngineUsageChip extends ConsumerWidget {
  const EngineUsageChip({super.key, required this.engine, this.form = UsageChipForm.full});

  final Engine engine;
  final UsageChipForm form;

  /// 칩 위젯 키(`topbar.usage.claude` / `topbar.usage.codex`).
  static Key keyFor(Engine engine) => Key('topbar.usage.${engine.wire}');

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final usage = ref.watch(engineUsageProvider(engine));
    final color = engineChipColor(usage);
    final full = engineChipLabel(usage);
    final label = engineChipLabelFor(usage, form);
    // 연결이 안 됐으면 **이유와 할 일**을, 붙어 있으면 짧아진 글자의 원문 + 여는 법을 툴팁에 둔다.
    final tooltip = usage.connected ? '$full — 눌러서 사용량 보기' : notConnectedTooltip(engine, usage.reason);
    return Tooltip(
      message: tooltip,
      child: InkWell(
        key: keyFor(engine),
        onTap: () => showUsagePopover(context, engine: engine),
        borderRadius: BorderRadius.circular(4),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(4),
            border: Border.all(color: color.withValues(alpha: 0.5)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              // 색만으로 구분하지 않는다(패스 6 색약 대응): 연결 안 됨은 **빈 원**.
              Icon(usage.connected ? Icons.circle : Icons.circle_outlined, size: 7, color: color),
              const SizedBox(width: 5),
              Text(label, style: TextStyle(fontSize: 12, color: color)),
            ],
          ),
        ),
      ),
    );
  }
}
