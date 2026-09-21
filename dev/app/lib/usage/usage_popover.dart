// 사용량 팝오버(T43-2 ④ · 설계 §앱 1) — 상단 바 엔진 칩을 누르면 열린다.
//
//   엔진마다: 주간 막대 + 5시간 막대(없으면 숨김) + 요금제 + 리셋(절대·상대) + 마지막 확인
//   그 아래: **이 부서의 캐릭터 표**(이름 · 직급 · 엔진 · 컨텍스트 막대+% · 누적 토큰 · 비용) — 컨텍스트 큰 순
//   행 클릭 = 그 캐릭터 선택 + 팝오버 닫힘
//
// 닫기는 Esc · 바깥 클릭 둘 다(그래서 `showDialog(barrierDismissible: true)` 를 쓴다 — ModalRoute 가
// DismissIntent 를 이미 처리한다. 직접 만든 Overlay 였다면 그 배선을 새로 해야 한다).
// 계정 이메일은 어디에도 없다(D-45 2) — 요금제 이름과 "남음 N%" 뿐이다.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../state/office_state.dart';
import '../state/selection.dart';
import '../topbar/selected_department.dart';
import 'usage_bar.dart';
import 'usage_format.dart';

/// 팝오버 폭(오른쪽 패널 기본 폭과 같은 급 — 표 6열이 들어간다).
const double usagePopoverWidth = 560;

/// 상단 바 높이(팝오버가 그 아래에 뜬다).
const double _topBarHeight = 44;

/// 팝오버 제목.
const String usagePopoverTitle = '사용량';

/// 사용량 팝오버를 연다. [engine] 은 누른 칩(그 엔진 구역에 테두리를 준다).
Future<void> showUsagePopover(BuildContext context, {Engine? engine}) => showDialog<void>(
      context: context,
      barrierDismissible: true, // 바깥 클릭 · Esc 로 닫힘
      barrierColor: Colors.transparent,
      builder: (_) => UsagePopover(focusEngine: engine),
    );

class UsagePopover extends ConsumerWidget {
  const UsagePopover({super.key, this.focusEngine});

  /// 누른 칩의 엔진(강조만 한다 — 두 엔진을 다 보여 준다).
  final Engine? focusEngine;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    final departmentId = ref.watch(activeDepartmentIdProvider);
    final rows = ref.watch(departmentUsageRowsProvider(departmentId));
    return Align(
      alignment: Alignment.topRight,
      child: Padding(
        padding: const EdgeInsets.only(top: _topBarHeight + 4, right: 12),
        child: FocusScope(
          autofocus: true,
          child: Material(
            key: const Key('usage.popover'),
            color: scheme.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(4),
            child: Container(
              width: usagePopoverWidth,
              constraints: const BoxConstraints(maxHeight: 520),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(4),
                border: Border.all(color: Colors.white24),
              ),
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Text(usagePopoverTitle, style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
                      const Spacer(),
                      IconButton(
                        key: const Key('usage.popover.close'),
                        tooltip: '닫기 (Esc)',
                        iconSize: 16,
                        visualDensity: VisualDensity.compact,
                        onPressed: () => Navigator.of(context).maybePop(),
                        icon: const Icon(Icons.close),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Flexible(
                    child: SingleChildScrollView(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          for (final e in Engine.values) ...[
                            _EngineSection(engine: e, focused: e == focusEngine),
                            const SizedBox(height: 10),
                          ],
                          const Divider(height: 12, color: Colors.white12),
                          _MemberTable(rows: rows),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 엔진 한 개 구역 — 주간·5시간 막대 + 요금제 + 리셋 + 마지막 확인.
class _EngineSection extends ConsumerWidget {
  const _EngineSection({required this.engine, this.focused = false});

  final Engine engine;
  final bool focused;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final u = ref.watch(engineUsageProvider(engine));
    final color = engineChipColor(u);
    return Container(
      key: Key('usage.engine.${engine.wire}'),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: focused ? color.withValues(alpha: 0.6) : Colors.white12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(engineLabel(engine), style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold)),
              const SizedBox(width: 8),
              if (!u.connected)
                Tooltip(
                  message: notConnectedTooltip(engine, u.reason),
                  child: Text(
                    usageNotConnectedLabel,
                    key: Key('usage.engine.${engine.wire}.off'),
                    style: const TextStyle(fontSize: 12, color: usageOffColor),
                  ),
                )
              else if (u.plan != null)
                Text('요금제 ${u.plan}', style: const TextStyle(fontSize: 11.5, color: usageCalmColor)),
              const Spacer(),
              Text(
                '마지막 확인 ${formatCheckedAt(u.updatedAt)}',
                style: const TextStyle(fontSize: 11, color: usageCalmColor),
              ),
            ],
          ),
          if (u.connected) ...[
            const SizedBox(height: 6),
            if (u.weekly == null)
              const Text(
                '$usageNotMeasuredLabel — 이 엔진의 멤버가 한 턴 돌면 한도가 들어옵니다',
                style: TextStyle(fontSize: 11.5, color: usageCalmColor),
              )
            else ...[
              _WindowRow(label: '주간', window: u.weekly!, keySuffix: '${engine.wire}.weekly'),
              // 모델별 한도(T43-4)는 주간 막대 **바로 아래** 한 줄씩. 라벨은 CLI 가 준 그대로다
              // (실측값이 `Fable` 이었듯 모델 이름이 아닐 수 있다 — 해석하지 않는다).
              // 확인용 세션이 `/usage` 화면을 읽었을 때만 있고, Codex 는 언제나 비어 있다.
              for (final m in u.models) ...[
                const SizedBox(height: 4),
                _WindowRow(label: m.label, window: m.window, keySuffix: '${engine.wire}.model.${m.label}', indent: true),
              ],
              // 5시간 한도는 요금제에 따라 아예 안 온다 — 없으면 줄 자체를 만들지 않는다(빼기 원칙).
              if (u.session != null) ...[
                const SizedBox(height: 4),
                _WindowRow(label: '5시간', window: u.session!, keySuffix: '${engine.wire}.session'),
              ],
            ],
          ],
        ],
      ),
    );
  }
}

/// 한도 창 한 줄: `주간 [막대] 남음 45% · 9월 24일 18:00 (3일 뒤)`.
/// [indent] 면 모델별 줄 — 주간 막대에 딸린 것으로 보이게 라벨 칸을 들여 쓴다.
class _WindowRow extends StatelessWidget {
  const _WindowRow({required this.label, required this.window, required this.keySuffix, this.indent = false});

  final String label;
  final UsageWindow window;
  final String keySuffix;
  final bool indent;

  @override
  Widget build(BuildContext context) {
    final remaining = remainingPercent(window.usedPercent);
    final color = remainingColor(remaining);
    final at = formatResetAt(window.resetsAt);
    final relative = formatResetIn(window.resetsAt);
    return Row(
      key: Key('usage.window.$keySuffix'),
      children: [
        if (indent) const SizedBox(width: 10),
        SizedBox(
          // 모델 라벨은 길 수 있다(CLI 가 준 그대로) — 들여 쓴 줄은 라벨 칸을 넓히고 막대를 줄여 총폭을 맞춘다.
          width: indent ? 66 : 40,
          child: Text(
            label,
            style: const TextStyle(fontSize: 11.5, color: usageCalmColor),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        UsageBar(percent: remaining, color: color, width: indent ? 60 : 90),
        const SizedBox(width: 8),
        Text('남음 ${formatPercent(remaining)}', style: TextStyle(fontSize: 12, color: color)),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            at == null ? '' : '$at${relative == null ? '' : ' ($relative)'}',
            style: const TextStyle(fontSize: 11, color: usageCalmColor),
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }
}

/// 이 부서의 캐릭터 표(컨텍스트 큰 순).
class _MemberTable extends ConsumerWidget {
  const _MemberTable({required this.rows});

  final List<DepartmentUsageRow> rows;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (rows.isEmpty || rows.every((r) => r.usage == null)) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 10),
        child: Text(
          usageTableEmptyLabel,
          key: Key('usage.table.empty'),
          style: TextStyle(fontSize: 12, color: usageCalmColor),
        ),
      );
    }
    return Column(
      key: const Key('usage.table'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _TableHeader(),
        for (final r in rows) _MemberRow(row: r),
      ],
    );
  }
}

const double _rankWidth = 46;
const double _engineWidth = 54;
const double _contextWidth = 108;
const double _tokenWidth = 58;
const double _costWidth = 56;

class _TableHeader extends StatelessWidget {
  const _TableHeader();

  @override
  Widget build(BuildContext context) {
    const style = TextStyle(fontSize: 11, color: usageCalmColor);
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        children: const [
          Expanded(child: Text('이름', style: style)),
          SizedBox(width: _rankWidth, child: Text('직급', style: style)),
          SizedBox(width: _engineWidth, child: Text('엔진', style: style)),
          SizedBox(width: _contextWidth, child: Text('컨텍스트', style: style)),
          SizedBox(width: _tokenWidth, child: Text('토큰', style: style, textAlign: TextAlign.right)),
          SizedBox(width: _costWidth, child: Text('비용', style: style, textAlign: TextAlign.right)),
        ],
      ),
    );
  }
}

class _MemberRow extends ConsumerWidget {
  const _MemberRow({required this.row});

  final DepartmentUsageRow row;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final m = row.member;
    final u = row.usage;
    final percent = u?.contextPercent;
    final color = percent == null ? usageCalmColor : contextColor(percent);
    const style = TextStyle(fontSize: 12, color: Colors.white70);
    return InkWell(
      key: Key('usage.row.${m.id}'),
      borderRadius: BorderRadius.circular(4),
      onTap: () {
        // 행 클릭 = 그 캐릭터 선택 + 닫기(설계 §앱 1).
        ref.read(selectedMemberIdProvider.notifier).select(m.id);
        Navigator.of(context).maybePop();
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          children: [
            Expanded(child: Text(m.name, style: style, overflow: TextOverflow.ellipsis)),
            SizedBox(width: _rankWidth, child: Text(m.rank.label, style: style)),
            SizedBox(width: _engineWidth, child: Text(engineLabel(m.engine), style: style)),
            SizedBox(
              width: _contextWidth,
              child: percent == null
                  ? const Text('—', style: TextStyle(fontSize: 12, color: usageCalmColor))
                  : Row(
                      children: [
                        UsageBar(percent: percent, color: color, width: 56),
                        const SizedBox(width: 6),
                        Text(formatPercent(percent), style: TextStyle(fontSize: 12, color: color)),
                      ],
                    ),
            ),
            SizedBox(
              width: _tokenWidth,
              child: Text(
                u?.tokens == null ? '—' : formatTokens(u!.tokens!.total),
                style: style,
                textAlign: TextAlign.right,
              ),
            ),
            SizedBox(
              width: _costWidth,
              child: Text(
                // Codex 는 비용이 없다 — 칸을 비우지 않고 "—" 로 둔다(자리를 잃지 않게).
                formatCost(u?.costUsd) ?? '—',
                style: style,
                textAlign: TextAlign.right,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Esc 로 닫히는지 위젯 테스트가 확인할 때 쓰는 키 이벤트(문서용 상수).
const LogicalKeyboardKey usagePopoverCloseKey = LogicalKeyboardKey.escape;
