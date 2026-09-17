// 앱 전역 단축키(T40-5, 레이아웃 v2 §3 패스 6 키보드).
//
//   Ctrl+K  지시 바 포커스          Ctrl+L  로그 탭        Ctrl+T  터미널 전체 폭 오버레이 토글
//   Ctrl+I  지시문 탭               Ctrl+R  보고서 탭      Esc     (오버레이가 열려 있으면 닫기) → 부장 선택으로 복귀
//
// 인박스 맨 위 카드의 `Alt+Y`/`Alt+N` 은 인박스가 직접 듣는다(panel/inbox.dart) — 목록을 아는 쪽이 처리해야 해서.
// Enter 전송 · Shift+Enter 줄바꿈은 지시 바 자신의 FocusNode 가 본다(T14).
//
// 이 위젯은 포커스 subtree 위에 얹는다. 단축키는 **포커스된 노드에서 위로** 올라오므로 터미널·입력란이
// 먼저 먹은 키는 여기까지 오지 않는다(터미널 타이핑을 뺏지 않는다).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../panel/panel_tabs.dart';
import '../panel/ui_prefs.dart';
import '../state/office_state.dart';
import '../state/selection.dart';
import '../topbar/selected_department.dart';
import 'command_bar.dart' show commandBarFocusProvider;

/// 화면 아래 힌트 줄에 쓰는 요약(변형 A 의 "맨 아래 단축키 힌트 줄").
const String shortcutHintLine = 'Ctrl+K 지시 · Ctrl+L 로그 · Ctrl+T 터미널 · Ctrl+I 지시문 · Ctrl+R 보고서 · Esc 부장';

class AppShortcuts extends ConsumerWidget {
  const AppShortcuts({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    void tab(RightPanelTab t) => ref.read(panelTabRequestProvider.notifier).request(t);

    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyK, control: true): () =>
            ref.read(commandBarFocusProvider.notifier).request(),
        const SingleActivator(LogicalKeyboardKey.keyL, control: true): () => tab(RightPanelTab.log),
        const SingleActivator(LogicalKeyboardKey.keyI, control: true): () => tab(RightPanelTab.instructions),
        const SingleActivator(LogicalKeyboardKey.keyR, control: true): () => tab(RightPanelTab.report),
        const SingleActivator(LogicalKeyboardKey.keyT, control: true): () =>
            ref.read(terminalOverlayProvider.notifier).toggle(),
        const SingleActivator(LogicalKeyboardKey.escape): () {
          // 오버레이가 열려 있으면 그것부터 닫고, 아니면 선택을 부장으로 되돌린다.
          if (ref.read(terminalOverlayProvider)) {
            ref.read(terminalOverlayProvider.notifier).close();
            return;
          }
          final head = ref.read(liveHeadProvider(ref.read(activeDepartmentIdProvider)));
          ref.read(selectedMemberIdProvider.notifier).select(head?.id);
        },
      },
      child: Focus(autofocus: true, child: child),
    );
  }
}
