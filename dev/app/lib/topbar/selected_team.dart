// 상단 팀 탭의 선택 상태. main.dart 는 `selectedTeamIdProvider`(사용자가 고른 것) 또는
// `activeTeamIdProvider`(고른 팀이 없거나 사라졌으면 첫 팀으로 폴백) 를 읽는다.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/office_state.dart';

class SelectedTeamId extends Notifier<String?> {
  @override
  String? build() => null;

  void select(String? id) => state = id;
}

/// 사용자가 상단 탭에서 고른 팀 id(없으면 null).
final selectedTeamIdProvider = NotifierProvider<SelectedTeamId, String?>(SelectedTeamId.new);

/// 실제로 표시할 팀 id: 고른 팀이 `teamsProvider` 에 있으면 그것, 아니면 첫 팀, 팀이 없으면 null.
final activeTeamIdProvider = Provider<String?>((ref) {
  final teams = ref.watch(teamsProvider);
  final selected = ref.watch(selectedTeamIdProvider);
  if (selected != null && teams.containsKey(selected)) return selected;
  return teams.keys.firstOrNull;
});
