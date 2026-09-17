// 상단 바(T14 → T37 rev 3): 앱 이름 / **부서 탭** / 선택 멤버(+직급 배지) + 비상 퇴근 / 데몬 상태 칩 /
// 멤버·대기 개수 / "부서 만들기" / 부서 메뉴(삭제).
//
//  - 부서 탭 선택은 `selectedDepartmentIdProvider`(selected_department.dart, 여기서 export) 에 저장.
//    main.dart 는 `activeDepartmentIdProvider` 를 읽으면 된다.
//  - **부서 만들기 = 부장 임명**(D-32): 이름 · 작업 폴더(cwd) · 부장 엔진 · 부장 이름 → `department.create`
//    → 결과의 head 를 바로 선택한다. 사용자가 만드는 유일한 것이고, 그 아래(팀·팀원)는 전부 멤버가 만든다.
//  - **출근 버튼은 없앴다**(T24 의 `member.clockIn` 경로). 데몬은 `force:true` 없이는 -32004 로 막고,
//    그 길은 콘솔 전용 디버그다(D-34).
//  - 퇴근은 **비상용**으로만 남긴다: 선택 멤버 옆 작은 버튼 → 확인 다이얼로그([clockOutEmergencyWarning])
//    → `member.clockOut`. 부장·팀장을 내보내면 그 하위가 전부 정리된다.
//  - 부서 삭제는 탭 오른쪽 메뉴(⋮) → 확인 → `department.delete`(하위 트리 잎부터 정리).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../panel/inbox.dart' show inboxCountProvider;
import '../panel/panel_tabs.dart' show RightPanelTab, panelTabRequestProvider;
import '../panel/report_tab.dart' show reportUnreadProvider;
import '../rpc/rpc_client.dart';
import '../state/office_state.dart';
// 부서를 만든 직후 부장을 고르려고 쓴다(T24 함정 4 — 상태는 상태 층에).
import '../state/selection.dart';
import 'daemon_pill.dart';
import 'selected_department.dart';

export 'daemon_pill.dart' show DaemonPill, ReportCountBadge, daemonPillLabel, daemonPillColor, daemonBlinkHalfPeriod;
export 'disconnected_overlay.dart';
export 'selected_department.dart';

/// `department.create` 에 `headName` 을 안 보냈을 때 데몬이 붙이는 기본 부장 이름(daemon `DEFAULT_HEAD_NAME`).
const kDefaultHeadName = '부장';

/// 비상 퇴근 확인 다이얼로그의 경고(D-32: 사용자는 더 이상 팀장·팀원을 출퇴근시키지 않는다).
const String clockOutEmergencyWarning = '비상용: 부장/팀장 퇴근 시 하위 전원이 정리됩니다';

class TopBar extends ConsumerWidget {
  const TopBar({super.key, this.selectedMemberId});

  /// 사무실/패널에서 고른 멤버(있으면 이름 + 비상 퇴근 버튼 표시).
  final String? selectedMemberId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final connection = ref.watch(connectionStateProvider);
    final connected = connection == RpcConnectionState.connected;
    final departments = sortedDepartments(ref.watch(departmentsProvider));
    final members = ref.watch(membersProvider);
    // "대기 N" 은 인박스(내 책상)와 같은 수를 센다 — 화면 두 곳이 다른 수를 말하지 않게(D6).
    final pendingCount = ref.watch(inboxCountProvider);
    final activeDept = ref.watch(activeDepartmentIdProvider);
    final head = ref.watch(liveHeadProvider(activeDept));
    final reportCount = head == null ? 0 : ref.watch(reportUnreadProvider(head.id));
    final selected = selectedMemberId == null ? null : members[selectedMemberId];
    final style = Theme.of(context).textTheme.bodyMedium;
    final scheme = Theme.of(context).colorScheme;

    return Container(
      height: 44,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      color: scheme.surfaceContainerHigh,
      child: Row(
        children: [
          Text('픽셀 오피스', style: style?.copyWith(fontWeight: FontWeight.bold)),
          const SizedBox(width: 16),
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  if (departments.isEmpty)
                    const Text('부서 없음', key: Key('topbar.noDepartments'), style: TextStyle(color: Colors.white38, fontSize: 13))
                  else
                    for (final d in departments)
                      _DepartmentTab(
                        key: Key('topbar.department.${d.id}'),
                        department: d,
                        active: d.id == activeDept,
                        onTap: () => ref.read(selectedDepartmentIdProvider.notifier).select(d.id),
                      ),
                ],
              ),
            ),
          ),
          if (selected != null) ...[
            const SizedBox(width: 8),
            if (selected.rank != MemberRank.member) ...[
              RankBadge(key: const Key('topbar.rankBadge'), rank: selected.rank),
              const SizedBox(width: 6),
            ],
            Text('${selected.name} [${selected.engine.wire}]', style: style?.copyWith(color: Colors.white70)),
            const SizedBox(width: 2),
            IconButton(
              key: const Key('topbar.clockOut'),
              tooltip: '퇴근 (비상용)',
              visualDensity: VisualDensity.compact,
              iconSize: 18,
              onPressed: connected && !selected.status.isGone ? () => confirmClockOut(context, ref, selected) : null,
              icon: const Icon(Icons.logout),
            ),
            const SizedBox(width: 8),
          ],
          const DaemonPill(),
          const SizedBox(width: 12),
          Text('멤버 ${members.length} · 대기 $pendingCount', key: const Key('topbar.counts'), style: style),
          if (reportCount > 0) ...[
            const SizedBox(width: 8),
            // 보고는 답할 것이 없으므로 카드가 아니라 배지다(이슈 9). 누르면 부장 + 보고서 탭.
            ReportCountBadge(
              count: reportCount,
              onTap: () {
                ref.read(selectedMemberIdProvider.notifier).select(head!.id);
                ref.read(panelTabRequestProvider.notifier).request(RightPanelTab.report);
              },
            ),
          ],
          const SizedBox(width: 12),
          FilledButton.tonalIcon(
            key: const Key('topbar.createDepartment'),
            onPressed: connected ? () => showCreateDepartmentDialog(context) : null,
            style: FilledButton.styleFrom(visualDensity: VisualDensity.compact),
            icon: const Icon(Icons.add_business, size: 16),
            label: const Text('부서 만들기'),
          ),
          _DepartmentMenu(departmentId: activeDept, enabled: connected),
        ],
      ),
    );
  }
}

class _DepartmentTab extends StatelessWidget {
  const _DepartmentTab({super.key, required this.department, required this.active, required this.onTap});

  final Department department;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Tooltip(
      message: department.cwd,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(6),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: active ? scheme.primary : Colors.transparent, width: 2)),
          ),
          // 폴더 아이콘 + 이름(변형 C, 패스 7 등록부). 툴팁은 cwd.
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                active ? Icons.folder : Icons.folder_outlined,
                size: 14,
                color: active ? scheme.primary : Colors.white54,
              ),
              const SizedBox(width: 5),
              Text(
                department.name,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: active ? FontWeight.bold : FontWeight.normal,
                  color: active ? scheme.primary : Colors.white70,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 선택 멤버의 직급 배지(부장 왕관 · 팀장 별). 팀원은 배지 없음.
class RankBadge extends StatelessWidget {
  const RankBadge({super.key, required this.rank});

  final MemberRank rank;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final color = rank == MemberRank.head ? const Color(0xFFFFD166) : scheme.primary;
    return Tooltip(
      message: rank == MemberRank.head ? '부장 — 사용자 지시는 부장에게만 갑니다' : '팀장 — 지시는 부장이 내립니다',
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: color.withValues(alpha: 0.6)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(rank == MemberRank.head ? Icons.workspace_premium : Icons.star, size: 12, color: color),
            const SizedBox(width: 4),
            Text(rank.label, style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.bold)),
          ],
        ),
      ),
    );
  }
}

// 데몬 상태 칩은 T40-5 에서 3상태 pill(`daemon_pill.dart` 의 [DaemonPill])로 바뀌었다.

// ---- 부서 메뉴(삭제) ----------------------------------------------------------------

class _DepartmentMenu extends ConsumerWidget {
  const _DepartmentMenu({required this.departmentId, required this.enabled});

  final String? departmentId;
  final bool enabled;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dept = ref.watch(departmentProvider(departmentId));
    return PopupMenuButton<String>(
      key: const Key('topbar.departmentMenu'),
      tooltip: '부서',
      enabled: enabled && dept != null,
      iconSize: 18,
      onSelected: (v) {
        if (v == 'delete' && dept != null) confirmDeleteDepartment(context, ref, dept);
      },
      itemBuilder: (_) => [
        PopupMenuItem(
          key: const Key('topbar.deleteDepartment'),
          value: 'delete',
          child: Text('부서 삭제${dept == null ? '' : ' — ${dept.name}'}'),
        ),
      ],
    );
  }
}

/// 확인 다이얼로그 → `department.delete`. 하위 트리(팀원 → 팀장 → 부장)가 잎부터 정리된다.
Future<void> confirmDeleteDepartment(BuildContext context, WidgetRef ref, Department d) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('부서 삭제'),
      content: Text('부서 "${d.name}" 을(를) 지울까요?\n부장·팀장·팀원 전원이 퇴근하고 팀·진행 중인 일도 함께 사라집니다.'),
      actions: [
        TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('취소')),
        FilledButton(
          key: const Key('deleteDepartment.confirm'),
          onPressed: () => Navigator.of(ctx).pop(true),
          child: const Text('삭제'),
        ),
      ],
    ),
  );
  if (ok != true) return;
  try {
    await ref.read(officeProvider.notifier).deleteDepartment(d.id);
    ref.read(selectedDepartmentIdProvider.notifier).select(null);
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text('부서 삭제 실패: ${e is RpcException ? e.message : e}')));
    }
  }
}

// ---- 퇴근(비상용) -------------------------------------------------------------------

/// 확인 다이얼로그 → `member.clockOut`. 오류는 SnackBar.
Future<void> confirmClockOut(BuildContext context, WidgetRef ref, Member m) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('퇴근'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${m.name} [${m.engine.wire}] · ${m.rank.label} 을(를) 퇴근시킬까요?\n진행 중인 작업은 중단되고 프로세스가 종료됩니다.'),
          const SizedBox(height: 8),
          Text(
            clockOutEmergencyWarning,
            key: const Key('clockOut.warning'),
            style: TextStyle(fontSize: 12, color: Theme.of(ctx).colorScheme.error),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('취소')),
        FilledButton(key: const Key('clockOut.confirm'), onPressed: () => Navigator.of(ctx).pop(true), child: const Text('퇴근')),
      ],
    ),
  );
  if (ok != true) return;
  try {
    await ref.read(rpcClientProvider).call('member.clockOut', {'memberId': m.id});
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text('퇴근 실패: ${e is RpcException ? e.message : e}')));
    }
  }
}

// ---- 부서 만들기 --------------------------------------------------------------------

Future<void> showCreateDepartmentDialog(BuildContext context) =>
    showDialog<void>(context: context, builder: (_) => const CreateDepartmentDialog());

/// 부서 만들기 = 부장 임명(D-32). 이름·작업 폴더·부장 엔진·부장 이름.
class CreateDepartmentDialog extends ConsumerStatefulWidget {
  const CreateDepartmentDialog({super.key});

  @override
  ConsumerState<CreateDepartmentDialog> createState() => _CreateDepartmentDialogState();
}

class _CreateDepartmentDialogState extends ConsumerState<CreateDepartmentDialog> {
  final _name = TextEditingController();
  final _cwd = TextEditingController();
  final _headName = TextEditingController();
  Engine _headEngine = Engine.claude;
  bool _busy = false;
  String? _nameError;
  String? _cwdError;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _cwd.dispose();
    _headName.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final name = _name.text.trim();
    final cwd = _cwd.text.trim();
    final headName = _headName.text.trim();
    setState(() {
      _nameError = name.isEmpty ? '부서 이름을 입력하세요' : null;
      _cwdError = cwd.isEmpty ? '작업 폴더 경로를 입력하세요' : null;
    });
    if (_nameError != null || _cwdError != null) return;

    setState(() => _busy = true);
    try {
      final r = await ref.read(officeProvider.notifier).createDepartment(
            name: name,
            cwd: cwd,
            headEngine: _headEngine,
            headName: headName.isEmpty ? null : headName,
          );
      ref.read(selectedDepartmentIdProvider.notifier).select(r.department.id);
      // 새 부서에서 처음 고를 멤버는 부장이다(지시는 부장에게만 간다).
      if (r.head != null) ref.read(selectedMemberIdProvider.notifier).select(r.head!.id);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e is RpcException ? '${e.message} (${e.code})' : e.toString();
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('부서 만들기'),
        content: SizedBox(
          width: 440,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  '부서를 만들면 부장이 자동으로 출근합니다. 팀·팀원은 부장이 만듭니다 — 지시는 부장에게만 갑니다.',
                  key: Key('createDepartment.headHint'),
                  style: TextStyle(fontSize: 12, color: Colors.white54),
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const Key('createDepartment.name'),
                  controller: _name,
                  autofocus: true,
                  enabled: !_busy,
                  decoration: InputDecoration(labelText: '부서 이름', hintText: 'alpha', errorText: _nameError, isDense: true),
                ),
                const SizedBox(height: 10),
                TextField(
                  key: const Key('createDepartment.cwd'),
                  controller: _cwd,
                  enabled: !_busy,
                  decoration: InputDecoration(
                    labelText: '작업 폴더 (cwd)',
                    hintText: r'D:\myproject\...',
                    helperText: '이 부서의 모든 팀이 이 폴더에서 일합니다',
                    errorText: _cwdError,
                    isDense: true,
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  key: const Key('createDepartment.headName'),
                  controller: _headName,
                  enabled: !_busy,
                  decoration: const InputDecoration(labelText: '부장 이름', hintText: kDefaultHeadName, isDense: true),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    const Text('부장 엔진', style: TextStyle(fontSize: 13)),
                    const SizedBox(width: 12),
                    _EngineChooser(
                      key: const Key('createDepartment.headEngine'),
                      value: _headEngine,
                      enabled: !_busy,
                      onChanged: (e) => setState(() => _headEngine = e),
                    ),
                  ],
                ),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(_error!, key: const Key('createDepartment.error'), style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12)),
                ],
              ],
            ),
          ),
        ),
        actions: [
          TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: const Text('취소')),
          FilledButton(
            key: const Key('createDepartment.submit'),
            onPressed: _busy ? null : _submit,
            child: _busy
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('만들기'),
          ),
        ],
      );
}

class _EngineChooser extends StatelessWidget {
  const _EngineChooser({super.key, required this.value, required this.onChanged, this.enabled = true});

  final Engine value;
  final ValueChanged<Engine> onChanged;
  final bool enabled;

  @override
  Widget build(BuildContext context) => SegmentedButton<Engine>(
        segments: [
          for (final e in Engine.values) ButtonSegment(value: e, label: Text(e.wire)),
        ],
        selected: {value},
        showSelectedIcon: false,
        style: const ButtonStyle(visualDensity: VisualDensity.compact),
        onSelectionChanged: enabled ? (s) => onChanged(s.first) : null,
      );
}
