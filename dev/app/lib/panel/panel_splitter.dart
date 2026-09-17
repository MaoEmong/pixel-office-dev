// 사무실 ↔ 오른쪽 패널 분할(T40-4, 레이아웃 v2 §3 패스 6) + `Ctrl+T` 전체 폭 터미널 오버레이.
//
//  PanelSplitter(office: …, panel: …)
//     [사무실(나머지 폭)] │ 드래그 손잡이 │ [패널 panelWidthProvider.width]
//     손잡이를 끌면 420~720 안에서 폭이 바뀌고 앱 로컬에 저장된다. 터미널 탭을 열면 660 으로 자동 확장.
//     `terminalOverlayProvider` 가 켜지면 둘 위를 [TerminalOverlay] 가 덮는다(Esc 로 닫힘).
//
// 오버레이가 열려 있는 동안 오른쪽 패널은 터미널 탭 자리에 안내만 둔다(`RightPanel`) — 같은 멤버에
// `member.attach` 를 두 번 걸면 나중 detach 가 먼저 것을 끊어 버리기 때문. 터미널은 언제나 한 곳에만 붙는다.

import 'package:flutter/gestures.dart' show DragStartBehavior;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/office_state.dart';
import 'labels.dart';
import 'terminal_tab.dart';
import 'ui_prefs.dart';

/// 오버레이 안내 문구(패널 쪽 터미널 탭 자리).
const String terminalMovedToOverlay = '터미널이 전체 화면으로 열려 있습니다 — Esc 또는 Ctrl+T 로 닫기';

/// 오버레이 머리글.
String terminalOverlayTitle(String name) => '터미널 · $name';

class PanelSplitter extends ConsumerWidget {
  const PanelSplitter({super.key, required this.office, required this.panel, this.selectedMemberId});

  final Widget office;
  final Widget panel;

  /// 오버레이가 붙을 멤버(없으면 오버레이는 안내만).
  final String? selectedMemberId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final width = ref.watch(panelWidthProvider).width;
    final overlay = ref.watch(terminalOverlayProvider);
    return Stack(
      children: [
        Row(
          children: [
            Expanded(child: office),
            const PanelDragHandle(),
            SizedBox(key: const Key('panel.box'), width: width, child: panel),
          ],
        ),
        if (overlay) TerminalOverlay(memberId: selectedMemberId),
      ],
    );
  }
}

/// 패널 폭 드래그 손잡이. 좌우로 끌면 폭이 바뀐다(왼쪽으로 끌면 패널이 넓어진다).
class PanelDragHandle extends ConsumerStatefulWidget {
  const PanelDragHandle({super.key});

  @override
  ConsumerState<PanelDragHandle> createState() => _PanelDragHandleState();
}

class _PanelDragHandleState extends ConsumerState<PanelDragHandle> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final dragging = ref.watch(panelWidthProvider);
    return MouseRegion(
      cursor: SystemMouseCursors.resizeLeftRight,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        key: const Key('panel.divider'),
        behavior: HitTestBehavior.opaque,
        // 손잡이는 잡은 지점부터 바로 따라온다(기본 `start` 는 슬롭 18px 를 먹어 폭이 어긋난다).
        dragStartBehavior: DragStartBehavior.down,
        onHorizontalDragUpdate: (d) => ref.read(panelWidthProvider.notifier).dragBy(d.delta.dx),
        child: Tooltip(
          message: '패널 폭 ${dragging.preferred.round()} (끌어서 ${panelWidthMin.round()}~${panelWidthMax.round()})',
          waitDuration: const Duration(milliseconds: 600),
          child: SizedBox(
            width: panelDividerWidth,
            height: double.infinity,
            child: ColoredBox(color: _hover ? panelScrollbarThumb : Colors.white12),
          ),
        ),
      ),
    );
  }
}

/// `Ctrl+T` 전체 폭 터미널. Esc 로 닫힌다(포커스가 터미널 안에 있어도 되게 [Focus] 로 받는다).
class TerminalOverlay extends ConsumerWidget {
  const TerminalOverlay({super.key, required this.memberId});

  final String? memberId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final id = memberId;
    final name = id == null ? null : ref.watch(memberProvider(id))?.name ?? id;
    return Positioned.fill(
      child: Focus(
        autofocus: true,
        onKeyEvent: (node, e) {
          if (e is KeyDownEvent && e.logicalKey == LogicalKeyboardKey.escape) {
            ref.read(terminalOverlayProvider.notifier).close();
            return KeyEventResult.handled;
          }
          return KeyEventResult.ignored;
        },
        child: ColoredBox(
          color: const Color(0xF210141D),
          child: Column(
            children: [
              Container(
                height: 28,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                color: Theme.of(context).colorScheme.surfaceContainerHigh,
                child: Row(
                  children: [
                    Text(
                      name == null ? '터미널 — 캐릭터를 선택하세요' : terminalOverlayTitle(name),
                      key: const Key('terminalOverlay.title'),
                      style: const TextStyle(fontSize: 12, color: Colors.white70),
                    ),
                    const Spacer(),
                    const Text('Esc 닫기', style: TextStyle(fontSize: 11, color: Colors.white38)),
                    const SizedBox(width: 8),
                    IconButton(
                      key: const Key('terminalOverlay.close'),
                      tooltip: '닫기 (Esc)',
                      iconSize: 16,
                      visualDensity: VisualDensity.compact,
                      onPressed: () => ref.read(terminalOverlayProvider.notifier).close(),
                      icon: const Icon(Icons.close),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: id == null
                    ? const Center(child: Text('캐릭터를 선택하세요', style: TextStyle(color: Colors.white38)))
                    : TerminalTab(key: ValueKey('overlay-terminal-$id'), memberId: id),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
