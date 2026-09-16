// 선택 멤버 상태(T24b). T11 때는 main.dart 에 있었지만, 상단 바(팀 만들기 직후 팀장 선택)·지시 바가 쓰면서
// `topbar/top_bar.dart → main.dart → topbar/top_bar.dart` 순환 import 가 생겼다 — 상태는 상태 층에 둔다.
// main.dart 는 `state/selection.dart` 를 import 한다(반대 방향 import 없음).

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'office_state.dart';

/// 사무실에서 클릭해 선택한 멤버. 오른쪽 패널·지시 바·상단 바 퇴근 버튼이 공유한다.
final selectedMemberIdProvider = NotifierProvider<SelectedMemberId, String?>(SelectedMemberId.new);

class SelectedMemberId extends Notifier<String?> {
  @override
  String? build() {
    // 선택된 멤버가 사라지면(퇴근·팀 삭제) 선택 해제. 퇴근(exited)은 행이 남으므로 선택이 유지된다.
    ref.listen(membersProvider, (_, members) {
      final id = state;
      if (id != null && !members.containsKey(id)) state = null;
    });
    return null;
  }

  void select(String? id) => state = id;
}
