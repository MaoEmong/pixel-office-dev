// 사무실 뷰(T12). main.dart 의 OfficeArea 자리에 그대로 들어간다:
//   OfficeView(selectedMemberId: id, onSelectMember: (id) => ..., teamId: null /* 전체 */)
// membersProvider / latestEvent 맵 / openPendingProvider 세 개만 watch 해 OfficeScene 을 만들고 OfficePainter 로 그린다.
// 탭 → OfficeLayout.hitTest → onSelectMember(멤버 id, 빈 곳이면 null).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../state/office_state.dart';
import 'office_layout.dart';
import 'office_painter.dart';
import 'office_scene.dart';

export 'office_scene.dart' show OfficeScene, SceneMember, QueueEntry;

/// 멤버별 마지막 이벤트 맵. office_state 에는 멤버별 family(latestEventProvider)만 있어 여기서 맵 전체를 슬라이스한다.
final officeLatestEventsProvider = Provider<Map<String, OfficeEvent>>(
  (ref) => ref.watch(officeProvider.select((s) => s.latestEvent)),
);

/// 화면용 장면(팀 id 별, null = 전체). members / latestEvent / pending 중 하나라도 바뀌면 다시 만든다
/// (값 비교로 불필요한 repaint 는 페인터가 거른다).
final officeSceneProvider = Provider.family<OfficeScene, String?>(
  (ref, teamId) => OfficeScene.build(
    members: ref.watch(membersProvider),
    latestEvents: ref.watch(officeLatestEventsProvider),
    pending: ref.watch(openPendingProvider),
    teamId: teamId,
  ),
);

class OfficeView extends ConsumerWidget {
  const OfficeView({super.key, this.selectedMemberId, this.onSelectMember, this.teamId});

  /// 선택된 멤버(외곽 링). null 이면 없음.
  final String? selectedMemberId;

  /// 탭 결과: 캐릭터/책상이면 그 멤버 id, 빈 곳이면 null.
  final ValueChanged<String?>? onSelectMember;

  /// 보여줄 팀. null 이면 전체 멤버.
  final String? teamId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scene = ref.watch(officeSceneProvider(teamId));
    final textDirection = Directionality.maybeOf(context) ?? TextDirection.ltr;
    return LayoutBuilder(
      builder: (context, constraints) {
        final size = Size(
          constraints.hasBoundedWidth ? constraints.maxWidth : 900,
          constraints.hasBoundedHeight ? constraints.maxHeight : 600,
        );
        final painter = OfficePainter(scene: scene, selectedMemberId: selectedMemberId, textDirection: textDirection);
        return GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapUp: onSelectMember == null
              ? null
              : (d) {
                  final layout = OfficeLayout(size: size, deskCount: scene.members.length);
                  onSelectMember!(layout.hitTest(d.localPosition, scene));
                },
          child: ClipRect(
            child: CustomPaint(
              size: size,
              painter: painter,
              willChange: false,
            ),
          ),
        );
      },
    );
  }
}
