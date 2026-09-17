// 픽셀 오피스 데스크탑 앱 (M1 배선 → T40 레이아웃 v2). 01-설계문서 §3 · docs/design/레이아웃-v2.md:
//   상단 바(TopBar) / 왼쪽 사무실(OfficeView) / 오른쪽 패널(RightPanel) / 아래 지시 바(CommandBar) / 끊김 오버레이.
//
// T40-5 에서 바뀐 것:
//  - 사무실↔패널 사이에 [PanelSplitter] — 드래그 420~720(기본 480, 앱 로컬 저장), 터미널 탭 660 자동,
//    `Ctrl+T` 전체 폭 터미널 오버레이.
//  - [AppShortcuts] 로 Ctrl+K/L/T/I/R · Esc 를 한 곳에서 묶는다(인박스의 Alt+Y/N 은 인박스가 직접 듣는다).
//  - 끊김 오버레이는 `topbar/disconnected_overlay.dart` 로 옮겼다(pill 과 같은 문구 + 진행 바 + "자세히" 접힘).
//  - 테마에 팔레트 포커스 링(2px `#FFFFFF` 알파 0.8)과 6px 스크롤바를 심었다(패스 6 접근성).
//
// T40c(두 절반의 접점)에서 배선한 것 — 이 파일이 사무실과 패널을 이어 주는 **유일한** 자리다:
//  - `OfficeView.onSelectPending` → [selectPendingFromOffice] (내 책상 슬롯 클릭 = 그 멤버 + 인박스 스크롤, D6).
//  - `OfficeView.onCreateDepartment` → 상단 바와 **같은** `showCreateDepartmentDialog`(부서 0 개 빈 상태).
//  접점 회귀는 `test/app_shell_test.dart` 가 본다.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'command/command_bar.dart';
import 'command/shortcuts.dart';
import 'office/office_view.dart';
import 'panel/right_panel.dart';
import 'rpc/rpc_client.dart';
import 'state/office_state.dart';
import 'state/selection.dart';

import 'topbar/notices.dart';
import 'topbar/top_bar.dart';

export 'topbar/disconnected_overlay.dart' show DisconnectedOverlay;

void main() {
  runApp(const ProviderScope(child: PixelOfficeApp()));
}

// 선택 멤버 provider(`selectedMemberIdProvider`)는 T24b 에서 `lib/state/selection.dart` 로 옮겼다 —
// 상단 바·지시 바가 쓰면서 main.dart 와 순환 import 가 됐기 때문(T24 함정 4).

/// 패널·상단 바·지시 바의 표시 서체(패스 4 구체성 · D-43 4, OFL). 캔버스는 Galmuri11
/// (`office/office_painter.dart` 의 [officeFontFamily]), 터미널·고정폭은 D2Coding 이다.
const String appFontFamily = 'Pretendard';

/// Pretendard 에 없는 글자를 대신 낼 순서. **번들 서체를 먼저** 둔다 — T40 편차 ⑤ 에서 시스템 폴백이
/// `♛`(지시 바 칩)·`❗`·`❓`(카드·범례)를 두부로 냈다. `♛` 는 D2Coding, `❗`·`❓` 는 Galmuri11 에 있다.
const List<String> appFontFallback = ['D2Coding', 'Galmuri11', 'Malgun Gothic'];

/// 앱 테마 — 서체 3종 + 팔레트 포커스 링·스크롤바(패스 6). 색은 `panel/labels.dart` 의 §4 토큰.
ThemeData pixelOfficeTheme() {
  final base = ThemeData(
    brightness: Brightness.dark,
    colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6C8EFF), brightness: Brightness.dark),
    useMaterial3: true,
    fontFamily: appFontFamily,
    fontFamilyFallback: appFontFallback,
  );
  return base.copyWith(
    focusColor: panelFocusRing,
    scrollbarTheme: ScrollbarThemeData(
      thickness: const WidgetStatePropertyAll(panelScrollbarThickness),
      thumbColor: const WidgetStatePropertyAll(panelScrollbarThumb),
      radius: const Radius.circular(3),
      interactive: true,
    ),
    inputDecorationTheme: base.inputDecorationTheme.copyWith(
      focusedBorder: const OutlineInputBorder(
        borderSide: BorderSide(color: panelFocusRing, width: panelFocusRingWidth),
      ),
    ),
  );
}

class PixelOfficeApp extends StatelessWidget {
  const PixelOfficeApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: '픽셀 오피스',
        debugShowCheckedModeBanner: false,
        theme: pixelOfficeTheme(),
        home: const OfficeShell(),
      );
}

/// 전체 레이아웃. 오버레이는 상단 바 아래 전부를 덮는다.
class OfficeShell extends ConsumerWidget {
  const OfficeShell({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final connection = ref.watch(connectionStateProvider);
    final selected = ref.watch(selectedMemberIdProvider);
    final departmentId = ref.watch(activeDepartmentIdProvider);
    return Scaffold(
      body: AppShortcuts(
        child: Column(
          children: [
            TopBar(selectedMemberId: selected),
            Expanded(
              child: Stack(
                children: [
                  Column(
                    children: [
                      Expanded(
                        child: PanelSplitter(
                          selectedMemberId: selected,
                          office: OfficeView(
                            selectedMemberId: selected,
                            departmentId: departmentId,
                            onSelectMember: (id) => ref.read(selectedMemberIdProvider.notifier).select(id),
                            // 내 책상 슬롯 클릭 = 그 멤버 선택 + 인박스에서 그 카드로 스크롤(D6).
                            onSelectPending: (pendingId) => selectPendingFromOffice(ref, pendingId),
                            // 부서 0 개일 때 캔버스 가운데 큰 버튼 → 상단 바와 같은 다이얼로그(패스 2 이슈 7).
                            onCreateDepartment: () => showCreateDepartmentDialog(context),
                          ),
                          panel: RightPanel(memberId: selected),
                        ),
                      ),
                      CommandBar(selectedMemberId: selected),
                    ],
                  ),
                  if (connection != RpcConnectionState.connected) const DisconnectedOverlay(),
                  const NoticeBanner(),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 사무실 내 책상 슬롯 클릭 → 그 pending 을 낸 멤버를 고르고 인박스에서 그 카드로 스크롤한다(D6).
/// `OfficeView.onSelectPending` 이 이것을 부른다(T40c 배선).
void selectPendingFromOffice(WidgetRef ref, String pendingId) {
  final pending = ref.read(openPendingProvider)[pendingId];
  if (pending != null) ref.read(selectedMemberIdProvider.notifier).select(pending.memberId);
  ref.read(inboxFocusProvider.notifier).focus(pendingId);
}
