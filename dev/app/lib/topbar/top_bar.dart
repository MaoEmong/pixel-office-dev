// 상단 바(T14 → T37 rev 3): 앱 이름 / **부서 탭** / 선택 멤버(+직급 배지) + 비상 퇴근 / 데몬 상태 칩 /
// 멤버·대기 개수 / "부서 만들기" / 부서 메뉴(삭제).
//
//  - 부서 탭 선택은 `selectedDepartmentIdProvider`(selected_department.dart, 여기서 export) 에 저장.
//    main.dart 는 `activeDepartmentIdProvider` 를 읽으면 된다.
//  - **부서 만들기 = 부장 임명**(D-32): 이름 · 작업 폴더(cwd) · 부장 엔진 · 부장 이름 → `department.create`
//    → 결과의 head 를 바로 선택한다. 사용자가 만드는 유일한 것이고, 그 아래(팀·팀원)는 전부 멤버가 만든다.
//  - **T41**: 작업 폴더는 **"폴더 선택…"**(file_selector) 으로 고른다 — 손으로 치던 경로 입력은 오타 하나로
//    데몬이 -32602 를 뱉던 자리였다. 칸은 그대로 편집 가능(붙여넣기 폴백)이고, 폴더가 **실제로 있을 때만**
//    만들기가 켜진다. 부서 이름은 폴더 이름, 부장 이름은 `부장`, 엔진은 `claude` 가 기본이라
//    **폴더만 고르면 아무것도 안 치고 만들 수 있다**.
//  - **출근 버튼은 없앴다**(T24 의 `member.clockIn` 경로). 데몬은 `force:true` 없이는 -32004 로 막고,
//    그 길은 콘솔 전용 디버그다(D-34).
//  - 퇴근은 **비상용**으로만 남긴다: 선택 멤버 옆 작은 버튼 → 확인 다이얼로그([clockOutEmergencyWarning])
//    → `member.clockOut`. 부장·팀장을 내보내면 그 하위가 전부 정리된다.
//  - 부서 삭제는 탭 오른쪽 메뉴(⋮) → 확인 → `department.delete`(하위 트리 잎부터 정리).

import 'dart:async';
import 'dart:io';

import 'package:file_selector/file_selector.dart' show getDirectoryPath;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../panel/inbox.dart' show inboxCountProvider;
import '../panel/ui_prefs.dart' show lastDepartmentDirProvider;
import '../panel/panel_tabs.dart' show RightPanelTab, panelTabRequestProvider;
import '../panel/report_tab.dart' show reportUnreadProvider;
import '../rpc/rpc_client.dart';
import '../state/office_state.dart';
// 부서를 만든 직후 부장을 고르려고 쓴다(T24 함정 4 — 상태는 상태 층에).
import '../state/selection.dart';
import '../usage/usage_chips.dart';
import 'daemon_pill.dart';
import 'selected_department.dart';

export 'daemon_pill.dart' show DaemonPill, ReportCountBadge, daemonPillLabel, daemonPillColor, daemonBlinkHalfPeriod;
export 'disconnected_overlay.dart';
export 'selected_department.dart';
export '../usage/usage_chips.dart' show EngineUsageChip, EngineUsageChips, usageChipsCompact, usageChipsCompactWidth;
export '../usage/usage_popover.dart' show UsagePopover, showUsagePopover, usagePopoverTitle, usagePopoverWidth;

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
      // 창이 좁으면(패스 6 최소 1100) 엔진 칩이 **넘치기 전에** 짧은 꼴로 줄어든다.
      child: LayoutBuilder(
        builder: (context, box) => Row(
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
            // 이름은 길이를 모른다 — 좁아지면 말줄임으로 양보한다(상단 바가 넘치지 않게, T43-2).
            Flexible(
              child: Text(
                '${selected.name} [${selected.engine.wire}]',
                style: style?.copyWith(color: Colors.white70),
                maxLines: 1,
                softWrap: false,
                overflow: TextOverflow.ellipsis,
              ),
            ),
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
          // 엔진 칩(사용량) → 데몬 pill 순서(설계 §앱 1: "데몬 pill 왼쪽").
          EngineUsageChips(compact: usageChipsCompact(box.maxWidth)),
          const SizedBox(width: 6),
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

Future<void> showCreateDepartmentDialog(BuildContext context, {DirectoryPicker pickDirectory = pickDepartmentFolder}) =>
    showDialog<void>(context: context, builder: (_) => CreateDepartmentDialog(pickDirectory: pickDirectory));

/// 폴더 선택기(T41). 테스트는 **절대** 네이티브 창을 열지 않으므로 가짜를 주입한다.
/// 취소하면 null.
typedef DirectoryPicker = Future<String?> Function({String? initialDirectory});

/// 진짜 폴더 선택기 — file_selector(Windows 는 `IFileDialog`).
Future<String?> pickDepartmentFolder({String? initialDirectory}) =>
    getDirectoryPath(initialDirectory: initialDirectory, confirmButtonText: '이 폴더로');

/// 고른 폴더에서 뽑는 기본 부서 이름 = 마지막 조각(`D:\myproject\pixel-office` → `pixel-office`).
/// 드라이브 루트(`D:\`)면 `D`. 구분자는 `\`·`/` 둘 다, 꼬리 구분자는 무시한다.
String departmentNameForPath(String path) {
  final parts = path.trim().split(RegExp(r'[\\/]+')).where((s) => s.isNotEmpty).toList();
  if (parts.isEmpty) return '';
  final last = parts.last;
  return last.endsWith(':') ? last.substring(0, last.length - 1) : last;
}

/// 폴더가 실제로 있는지 확인하는 함수. **provider 로 뺀 이유(T41 함정)**: 위젯 테스트의 fake-async 존에서는
/// `dart:io` 의 Future 가 영영 안 끝난다(`tester.runAsync` 없이는 pumpAndSettle 이 타임아웃). 선택기는 위젯
/// 파라미터로, 파일시스템 확인은 provider 로 갈아끼운다 — 테스트가 진짜 디스크를 건드릴 일이 없다.
typedef DirectoryExists = Future<bool> Function(String path);

final directoryExistsProvider = Provider<DirectoryExists>((_) => (path) => Directory(path).exists());

/// 없는 폴더를 넣었을 때의 문구(선택기 대신 손으로 친 경우).
const String createDepartmentMissingFolder = '그런 폴더가 없습니다 — "폴더 선택…" 으로 고르세요';

/// 폴더를 아직 안 골랐을 때 만들기 버튼이 꺼져 있는 이유.
const String createDepartmentPickFolderHint = '작업 폴더를 골라야 만들 수 있습니다';

/// 부서 만들기 = 부장 임명(D-32). 폴더 선택 + 이름·부장 이름·부장 엔진 기본값(T41).
class CreateDepartmentDialog extends ConsumerStatefulWidget {
  const CreateDepartmentDialog({super.key, this.pickDirectory = pickDepartmentFolder});

  /// "폴더 선택…" 이 부르는 것. 기본은 네이티브 대화상자([pickDepartmentFolder]).
  final DirectoryPicker pickDirectory;

  @override
  ConsumerState<CreateDepartmentDialog> createState() => _CreateDepartmentDialogState();
}

class _CreateDepartmentDialogState extends ConsumerState<CreateDepartmentDialog> {
  final _name = TextEditingController();
  final _cwd = TextEditingController();
  // 기본값(T41) — 폴더만 고르면 아무것도 안 치고 만들 수 있다.
  final _headName = TextEditingController(text: kDefaultHeadName);
  Engine _headEngine = Engine.claude;
  bool _busy = false;
  bool _picking = false;

  /// 사용자가 이름을 직접 고쳤는가. true 면 폴더를 바꿔도 이름을 덮어쓰지 않는다.
  bool _nameEdited = false;

  /// 지금 칸에 있는 경로가 실제로 있는 폴더인가(만들기 버튼의 조건).
  bool _cwdOk = false;

  /// 비동기 존재 확인의 경합 방지 — 마지막 확인만 반영한다.
  int _checkToken = 0;
  String? _cwdError;
  String? _error;

  @override
  void initState() {
    super.initState();
    // 선택기로 고르든 손으로 치든 **같은 길**을 탄다: 이름 기본값 + 폴더 존재 확인.
    _cwd.addListener(_onCwdChanged);
  }

  @override
  void dispose() {
    _cwd.removeListener(_onCwdChanged);
    _name.dispose();
    _cwd.dispose();
    _headName.dispose();
    super.dispose();
  }

  void _onCwdChanged() {
    if (!_nameEdited) {
      final suggested = departmentNameForPath(_cwd.text);
      if (_name.text != suggested) _name.text = suggested;
    }
    unawaited(_checkCwd());
  }

  Future<void> _checkCwd() async {
    final path = _cwd.text.trim();
    final token = ++_checkToken;
    if (path.isEmpty) {
      if (mounted) {
        setState(() {
          _cwdOk = false;
          _cwdError = null;
        });
      }
      return;
    }
    final exists = await ref.read(directoryExistsProvider)(path);
    if (!mounted || token != _checkToken) return;
    setState(() {
      _cwdOk = exists;
      _cwdError = exists ? null : createDepartmentMissingFolder;
    });
  }

  Future<void> _pick() async {
    setState(() => _picking = true);
    try {
      final initial = await ref.read(lastDepartmentDirProvider.notifier).initialDir();
      final picked = await widget.pickDirectory(initialDirectory: initial);
      if (picked == null || picked.isEmpty) return; // 취소
      _cwd.text = picked; // 리스너가 이름 기본값과 존재 확인을 맡는다
      unawaited(ref.read(lastDepartmentDirProvider.notifier).remember(picked));
    } catch (e) {
      if (mounted) setState(() => _error = '폴더 선택 실패: $e');
    } finally {
      if (mounted) setState(() => _picking = false);
    }
  }

  bool get _canSubmit => !_busy && !_picking && _cwdOk && _name.text.trim().isNotEmpty;

  Future<void> _submit() async {
    final name = _name.text.trim();
    final cwd = _cwd.text.trim();
    final headName = _headName.text.trim();
    if (!_canSubmit) return;

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
                // 폴더가 먼저다 — 고르면 아래 이름 칸이 폴더 이름으로 채워진다(T41).
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: TextField(
                        key: const Key('createDepartment.cwd'),
                        controller: _cwd,
                        enabled: !_busy,
                        decoration: InputDecoration(
                          labelText: '작업 폴더 (cwd)',
                          hintText: r'D:\myproject\...',
                          helperText: '이 부서의 모든 팀이 이 폴더에서 일합니다 · 경로를 직접 붙여넣어도 됩니다',
                          errorText: _cwdError,
                          isDense: true,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: OutlinedButton.icon(
                        key: const Key('createDepartment.pickFolder'),
                        onPressed: _busy || _picking ? null : _pick,
                        icon: const Icon(Icons.folder_open, size: 16),
                        label: const Text('폴더 선택…'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                TextField(
                  key: const Key('createDepartment.name'),
                  controller: _name,
                  autofocus: true,
                  enabled: !_busy,
                  onChanged: (v) => setState(() => _nameEdited = v.trim().isNotEmpty),
                  decoration: const InputDecoration(
                    labelText: '부서 이름',
                    hintText: 'alpha',
                    helperText: '기본값 = 고른 폴더 이름',
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
          // 버튼이 꺼져 있는 이유를 옆에 적어 둔다 — 눌러 보고 나서야 알게 하지 않는다.
          if (!_busy && !_cwdOk)
            const Padding(
              padding: EdgeInsets.only(right: 4),
              child: Text(
                createDepartmentPickFolderHint,
                key: Key('createDepartment.submitHint'),
                style: TextStyle(fontSize: 11, color: Colors.white38),
              ),
            ),
          TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: const Text('취소')),
          FilledButton(
            key: const Key('createDepartment.submit'),
            onPressed: _canSubmit ? _submit : null,
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
