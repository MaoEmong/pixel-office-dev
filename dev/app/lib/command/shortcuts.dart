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
//
// T40c(실기에서 발견): 자식을 `Focus(autofocus: true)` 로만 감싸면 **포커스가 이 subtree 밖으로 빠지는 순간
// 단축키가 통째로 죽는다.** 터미널 탭에 포커스를 준 뒤 다른 탭으로 가면 터미널 FocusNode 가 dispose 되고
// 포커스가 **바깥 라우트 스코프**(= CallbackShortcuts 보다 위)로 올라가 버려, 그 뒤로는 Ctrl+K/L/T/I/R 이
// 하나도 듣지 않았다(실기 캡처로 확인). `FocusScope` 로 감싸면 자식이 사라질 때 포커스가 **이 스코프**로
// 돌아오므로 키 경로가 언제나 CallbackShortcuts 를 지난다.

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

class AppShortcuts extends ConsumerStatefulWidget {
  const AppShortcuts({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<AppShortcuts> createState() => _AppShortcutsState();
}

class _AppShortcutsState extends ConsumerState<AppShortcuts> {
  final FocusScopeNode _scope = FocusScopeNode(debugLabel: 'appShortcuts');

  @override
  void initState() {
    super.initState();
    FocusManager.instance.addListener(_keepFocusInside);
  }

  @override
  void dispose() {
    FocusManager.instance.removeListener(_keepFocusInside);
    _scope.dispose();
    super.dispose();
  }

  /// 포커스가 **우리 위로 떠올랐을 때만**(= 아무 위젯도 들고 있지 않다) 도로 가져온다.
  /// 판정: 포커스가 없거나, 포커스 노드가 우리 스코프의 **조상 스코프**다(터미널 노드가 dispose 되면
  /// 포커스가 라우트 스코프로 올라간다). 다이얼로그처럼 **다른 라우트**의 스코프·입력란이 들고 있으면
  /// 조상이 아니므로 건드리지 않는다 — 그쪽이 먼저 키를 먹는 게 맞다.
  void _keepFocusInside() {
    final focus = FocusManager.instance.primaryFocus;
    if (focus != null && !_isAncestorOfScope(focus)) return;
    // 포커스 이동 중에 다시 옮기면 프레임워크가 던진다 — 다음 프레임에.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _scope.canRequestFocus && !_scope.hasFocus) _scope.requestFocus();
    });
  }

  bool _isAncestorOfScope(FocusNode node) {
    for (FocusNode? n = _scope.parent; n != null; n = n.parent) {
      if (identical(n, node)) return true;
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    final child = widget.child;
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
      child: FocusScope(node: _scope, autofocus: true, child: child),
    );
  }
}
