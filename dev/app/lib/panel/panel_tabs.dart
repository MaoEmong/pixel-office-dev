// 오른쪽 패널 탭 목록과 "이 탭으로 바꿔 달라" 요청(T18 · T26).
//
//  RightPanelTab              탭 순서(로그 · 터미널 · 지시문 · 보고서). 테스트·외부에서 인덱스로 고를 때.
//                             T26 에서 자리표시였던 `files`("변경 파일") 를 `instructions`(지시문 편집기) 로 교체했다.
//  panelTabRequestProvider    `ref.read(panelTabRequestProvider.notifier).request(RightPanelTab.terminal)` 하면
//                             RightPanel 이 그 탭으로 animateTo 한다. 같은 탭을 연달아 요청해도 nonce 가 달라 매번 반응한다.
//                             재지시 카드의 "터미널에서 답하기" 가 쓴다. main.dart 배선 불필요(RightPanel 안에서 듣는다).

import 'package:flutter_riverpod/flutter_riverpod.dart';

/// 탭 순서.
enum RightPanelTab { log, terminal, instructions, report }

class PanelTabRequest {
  const PanelTabRequest(this.tab, this.nonce);

  final RightPanelTab tab;

  /// 요청마다 증가 — 같은 탭을 두 번 요청해도 상태가 바뀌어 리스너가 불린다.
  final int nonce;
}

class PanelTabRequestNotifier extends Notifier<PanelTabRequest?> {
  int _nonce = 0;

  @override
  PanelTabRequest? build() => null;

  void request(RightPanelTab tab) => state = PanelTabRequest(tab, ++_nonce);
}

final panelTabRequestProvider = NotifierProvider<PanelTabRequestNotifier, PanelTabRequest?>(PanelTabRequestNotifier.new);
