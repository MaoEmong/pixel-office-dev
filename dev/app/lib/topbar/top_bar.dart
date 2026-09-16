// 상단 바(T14): 앱 이름 / 팀 탭 / 선택 멤버(+팀장 배지) + 퇴근 / 데몬 상태 칩 / 멤버·대기 개수 / 출근 버튼.
//  - 팀 탭 선택은 `selectedTeamIdProvider`(selected_team.dart, 여기서 export) 에 저장. main.dart 는 `activeTeamIdProvider` 를 읽으면 된다.
//  - 출근: 이름·엔진·지시문·팀 → `member.clockIn`. 팀이 없으면(또는 "새 팀" 을 켜면) 팀 이름·cwd·팀장 엔진·팀장 이름 → `team.create` 먼저.
//  - **팀 만들기 = 팀장 자동 출근(T24).** `team.create` 결과의 `leader` 를 바로 선택하고, 팀원 이름을 비워 두면
//    팀장만 출근한 빈 사무실이 된다(01 v1b 성공 기준 7).
//  - 퇴근: `selectedMemberId` 가 있으면 그 이름 옆 작은 버튼 → 확인 → `member.clockOut`.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

// 선택 멤버 provider 는 main.dart 에 있다(T11). 팀 만들기 직후 팀장을 고르려면 여기서 써야 한다 —
// Dart 는 순환 import 를 허용하지만, provider 를 lib/state/ 로 옮기는 정리는 T24b 로 넘긴다.
import '../main.dart' show selectedMemberIdProvider;
import '../model/models.dart';
import '../rpc/rpc_client.dart';
import '../state/office_state.dart';
import 'selected_team.dart';

export 'selected_team.dart';

/// `team.create` 에 `leaderName` 을 안 보냈을 때 데몬이 붙이는 기본 팀장 이름(daemon `DEFAULT_LEADER_NAME`).
const kDefaultLeaderName = '팀장';

class TopBar extends ConsumerWidget {
  const TopBar({super.key, this.selectedMemberId});

  /// 사무실/패널에서 고른 멤버(있으면 이름 + 퇴근 버튼 표시).
  final String? selectedMemberId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final connection = ref.watch(connectionStateProvider);
    final connected = connection == RpcConnectionState.connected;
    final version = ref.watch(daemonVersionProvider);
    final pid = ref.watch(daemonPidProvider);
    final teams = ref.watch(teamsProvider);
    final members = ref.watch(membersProvider);
    final pendingCount = ref.watch(openPendingProvider).length;
    final activeTeam = ref.watch(activeTeamIdProvider);
    final selected = selectedMemberId == null ? null : members[selectedMemberId];
    final style = Theme.of(context).textTheme.bodyMedium;
    final scheme = Theme.of(context).colorScheme;

    final (chipLabel, chipColor) = switch (connection) {
      RpcConnectionState.connected => ('데몬 v${version ?? '?'}${pid != null ? ' · pid $pid' : ''}', Colors.greenAccent),
      RpcConnectionState.connecting => ('데몬 연결 중', Colors.amber),
      RpcConnectionState.disconnected => ('데몬 연결 안 됨', Colors.redAccent),
    };

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
                  if (teams.isEmpty)
                    const Text('팀 없음', style: TextStyle(color: Colors.white38, fontSize: 13))
                  else
                    for (final t in teams.values)
                      _TeamTab(
                        key: Key('topbar.team.${t.id}'),
                        team: t,
                        active: t.id == activeTeam,
                        onTap: () => ref.read(selectedTeamIdProvider.notifier).select(t.id),
                      ),
                ],
              ),
            ),
          ),
          if (selected != null) ...[
            const SizedBox(width: 8),
            if (selected.rank == MemberRank.leader) ...[
              const _LeaderBadge(key: Key('topbar.leaderBadge')),
              const SizedBox(width: 6),
            ],
            Text('${selected.name} [${selected.engine.wire}]', style: style?.copyWith(color: Colors.white70)),
            const SizedBox(width: 2),
            IconButton(
              key: const Key('topbar.clockOut'),
              tooltip: '퇴근',
              visualDensity: VisualDensity.compact,
              iconSize: 18,
              onPressed: connected && !selected.status.isGone ? () => confirmClockOut(context, ref, selected) : null,
              icon: const Icon(Icons.logout),
            ),
            const SizedBox(width: 8),
          ],
          _StatusChip(key: const Key('topbar.daemon'), label: chipLabel, color: chipColor),
          const SizedBox(width: 12),
          Text('멤버 ${members.length} · 대기 $pendingCount', key: const Key('topbar.counts'), style: style),
          const SizedBox(width: 12),
          FilledButton.tonalIcon(
            key: const Key('topbar.clockIn'),
            onPressed: connected ? () => showClockInDialog(context, initialTeamId: activeTeam) : null,
            style: FilledButton.styleFrom(visualDensity: VisualDensity.compact),
            icon: const Icon(Icons.login, size: 16),
            label: const Text('출근'),
          ),
        ],
      ),
    );
  }
}

class _TeamTab extends StatelessWidget {
  const _TeamTab({super.key, required this.team, required this.active, required this.onTap});

  final Team team;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: active ? scheme.primary : Colors.transparent, width: 2)),
        ),
        child: Text(
          team.name,
          style: TextStyle(fontSize: 13, fontWeight: active ? FontWeight.bold : FontWeight.normal, color: active ? scheme.primary : Colors.white70),
        ),
      ),
    );
  }
}

/// 선택 멤버가 팀장(`rank:'leader'`)일 때 이름 앞에 붙는 왕관 배지(T24).
class _LeaderBadge extends StatelessWidget {
  const _LeaderBadge({super.key});

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.primary;
    return Tooltip(
      message: '팀장 — 사용자 지시는 팀장에게만 갑니다',
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: color.withValues(alpha: 0.6)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.workspace_premium, size: 12, color: color),
            const SizedBox(width: 4),
            Text(kDefaultLeaderName, style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.bold)),
          ],
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({super.key, required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: color.withValues(alpha: 0.5)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.circle, size: 8, color: color),
            const SizedBox(width: 6),
            Text(label, style: const TextStyle(fontSize: 12)),
          ],
        ),
      );
}

// ---- 퇴근 -------------------------------------------------------------------------

/// 확인 다이얼로그 → `member.clockOut`. 오류는 SnackBar.
Future<void> confirmClockOut(BuildContext context, WidgetRef ref, Member m) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('퇴근'),
      content: Text('${m.name} [${m.engine.wire}] 을(를) 퇴근시킬까요?\n진행 중인 작업은 중단되고 프로세스가 종료됩니다.'),
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

// ---- 출근 -------------------------------------------------------------------------

Future<void> showClockInDialog(BuildContext context, {String? initialTeamId}) =>
    showDialog<void>(context: context, builder: (_) => ClockInDialog(initialTeamId: initialTeamId));

/// 출근 다이얼로그. 팀이 없으면 "새 팀 만들기" 가 강제로 켜진다.
class ClockInDialog extends ConsumerStatefulWidget {
  const ClockInDialog({super.key, this.initialTeamId});

  final String? initialTeamId;

  @override
  ConsumerState<ClockInDialog> createState() => _ClockInDialogState();
}

class _ClockInDialogState extends ConsumerState<ClockInDialog> {
  final _name = TextEditingController();
  final _instructions = TextEditingController();
  final _teamName = TextEditingController();
  final _cwd = TextEditingController();
  final _leaderName = TextEditingController();
  Engine _engine = Engine.claude;
  Engine _leaderEngine = Engine.claude;
  String? _teamId;
  bool _createTeam = false;
  bool _busy = false;
  String? _nameError;
  String? _teamNameError;
  String? _cwdError;
  String? _error;

  @override
  void initState() {
    super.initState();
    _teamId = widget.initialTeamId;
  }

  @override
  void dispose() {
    _name.dispose();
    _instructions.dispose();
    _teamName.dispose();
    _cwd.dispose();
    _leaderName.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final teams = ref.read(teamsProvider);
    final createTeam = _createTeam || teams.isEmpty;
    final name = _name.text.trim();
    final teamName = _teamName.text.trim();
    final cwd = _cwd.text.trim();
    final leaderName = _leaderName.text.trim();
    setState(() {
      // 새 팀이면 팀장이 자동으로 출근하므로(T24) 팀원 이름은 선택 — 비우면 팀장만 있는 빈 사무실.
      _nameError = !createTeam && name.isEmpty ? '이름을 입력하세요' : null;
      _teamNameError = createTeam && teamName.isEmpty ? '팀 이름을 입력하세요' : null;
      _cwdError = createTeam && cwd.isEmpty ? '작업 폴더 경로를 입력하세요' : null;
      _error = !createTeam && (_teamId == null || !teams.containsKey(_teamId)) ? '팀을 고르세요' : null;
    });
    if (_nameError != null || _teamNameError != null || _cwdError != null || _error != null) return;

    setState(() => _busy = true);
    final client = ref.read(rpcClientProvider);
    try {
      var teamId = _teamId;
      if (createTeam) {
        // 결과는 `{ team, leader }` — 팀장이 자동 출근한다(PROTOCOL `team.create`, T24).
        final r = await client.call('team.create', {
          'name': teamName,
          'cwd': cwd,
          'leaderEngine': _leaderEngine.wire,
          if (leaderName.isNotEmpty) 'leaderName': leaderName,
        });
        teamId = ((r['team'] as Map?)?['id'] as String?) ?? (throw const RpcException(-32000, 'team.create 응답에 team.id 없음'));
        ref.read(selectedTeamIdProvider.notifier).select(teamId);
        // 새 팀에서 처음 고를 멤버는 팀장이다(지시는 팀장에게만 간다).
        final leaderId = (r['leader'] as Map?)?['id'] as String?;
        if (leaderId != null) ref.read(selectedMemberIdProvider.notifier).select(leaderId);
      }
      final instructions = _instructions.text.trim();
      if (!createTeam || name.isNotEmpty) {
        await client.call('member.clockIn', {
          'teamId': teamId,
          'engine': _engine.wire,
          'name': name,
          if (instructions.isNotEmpty) 'instructions': instructions,
        });
      }
      if (teamId != null) ref.read(selectedTeamIdProvider.notifier).select(teamId);
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
  Widget build(BuildContext context) {
    final teams = ref.watch(teamsProvider);
    final createTeam = _createTeam || teams.isEmpty;
    final teamValue = teams.containsKey(_teamId) ? _teamId : teams.keys.firstOrNull;
    return AlertDialog(
      title: const Text('출근'),
      content: SizedBox(
        width: 440,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                key: const Key('clockIn.name'),
                controller: _name,
                autofocus: true,
                enabled: !_busy,
                decoration: InputDecoration(
                  labelText: createTeam ? '팀원 이름 (선택)' : '이름',
                  hintText: '이음',
                  helperText: createTeam ? '비워 두면 팀장만 출근합니다' : null,
                  errorText: _nameError,
                  isDense: true,
                ),
              ),
              const SizedBox(height: 12),
              _EngineChooser(key: const Key('clockIn.engine'), value: _engine, enabled: !_busy, onChanged: (e) => setState(() => _engine = e)),
              const SizedBox(height: 12),
              TextField(
                key: const Key('clockIn.instructions'),
                controller: _instructions,
                enabled: !_busy,
                minLines: 2,
                maxLines: 6,
                keyboardType: TextInputType.multiline,
                decoration: const InputDecoration(labelText: '지시문 (선택)', hintText: '이 멤버의 역할·규칙 (INSTRUCTIONS.md)', isDense: true, alignLabelWithHint: true),
              ),
              const SizedBox(height: 12),
              if (teams.isNotEmpty) ...[
                Row(
                  children: [
                    Expanded(
                      child: DropdownButtonFormField<String>(
                        key: const Key('clockIn.team'),
                        initialValue: teamValue,
                        isDense: true,
                        decoration: const InputDecoration(labelText: '팀', isDense: true),
                        items: [for (final t in teams.values) DropdownMenuItem(value: t.id, child: Text(t.name, overflow: TextOverflow.ellipsis))],
                        onChanged: _busy || createTeam ? null : (id) => setState(() => _teamId = id),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Checkbox(
                          key: const Key('clockIn.createTeam'),
                          value: _createTeam,
                          onChanged: _busy ? null : (v) => setState(() => _createTeam = v ?? false),
                        ),
                        const Text('새 팀', style: TextStyle(fontSize: 13)),
                      ],
                    ),
                  ],
                ),
              ],
              if (createTeam) ...[
                const SizedBox(height: 8),
                Text(teams.isEmpty ? '팀이 없습니다 — 먼저 팀을 만듭니다' : '새 팀 만들기', style: Theme.of(context).textTheme.labelLarge),
                const SizedBox(height: 4),
                const Text(
                  '팀을 만들면 팀장이 자동으로 출근합니다. 지시는 팀장에게만 갑니다.',
                  key: Key('clockIn.leaderHint'),
                  style: TextStyle(fontSize: 12, color: Colors.white54),
                ),
                const SizedBox(height: 8),
                TextField(
                  key: const Key('clockIn.teamName'),
                  controller: _teamName,
                  enabled: !_busy,
                  decoration: InputDecoration(labelText: '팀 이름', errorText: _teamNameError, isDense: true),
                ),
                const SizedBox(height: 8),
                TextField(
                  key: const Key('clockIn.cwd'),
                  controller: _cwd,
                  enabled: !_busy,
                  decoration: InputDecoration(labelText: '작업 폴더 (cwd)', hintText: r'D:\myproject\...', errorText: _cwdError, isDense: true),
                ),
                const SizedBox(height: 8),
                TextField(
                  key: const Key('clockIn.leaderName'),
                  controller: _leaderName,
                  enabled: !_busy,
                  decoration: const InputDecoration(labelText: '팀장 이름', hintText: kDefaultLeaderName, isDense: true),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    const Text('팀장 엔진', style: TextStyle(fontSize: 13)),
                    const SizedBox(width: 12),
                    _EngineChooser(key: const Key('clockIn.leaderEngine'), value: _leaderEngine, enabled: !_busy, onChanged: (e) => setState(() => _leaderEngine = e)),
                  ],
                ),
              ],
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, key: const Key('clockIn.error'), style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12)),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: const Text('취소')),
        FilledButton(
          key: const Key('clockIn.submit'),
          onPressed: _busy ? null : _submit,
          child: _busy
              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('출근'),
        ),
      ],
    );
  }
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
