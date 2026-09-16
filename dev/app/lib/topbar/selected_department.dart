// 상단 부서 탭의 선택 상태(T37, rev 3 — T24 의 `selected_team.dart` 를 대체).
// main.dart 는 `selectedDepartmentIdProvider`(사용자가 고른 것) 또는
// `activeDepartmentIdProvider`(고른 부서가 없거나 사라졌으면 첫 부서로 폴백) 를 읽는다.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../state/office_state.dart';

class SelectedDepartmentId extends Notifier<String?> {
  @override
  String? build() => null;

  void select(String? id) => state = id;
}

/// 사용자가 상단 탭에서 고른 부서 id(없으면 null).
final selectedDepartmentIdProvider = NotifierProvider<SelectedDepartmentId, String?>(SelectedDepartmentId.new);

/// 실제로 표시할 부서 id: 고른 부서가 `departmentsProvider` 에 있으면 그것, 아니면 첫 부서(createdAt 순),
/// 부서가 없으면 null.
final activeDepartmentIdProvider = Provider<String?>((ref) {
  final departments = ref.watch(departmentsProvider);
  final selected = ref.watch(selectedDepartmentIdProvider);
  if (selected != null && departments.containsKey(selected)) return selected;
  return sortedDepartments(departments).firstOrNull?.id;
});

/// 탭 순서 = createdAt 순(같으면 id 순) — 스냅샷 맵 순서에 기대지 않는다.
List<Department> sortedDepartments(Map<String, Department> departments) {
  final list = departments.values.toList()
    ..sort((a, b) {
      final c = a.createdAt.compareTo(b.createdAt);
      return c != 0 ? c : a.id.compareTo(b.id);
    });
  return List<Department>.unmodifiable(list);
}
