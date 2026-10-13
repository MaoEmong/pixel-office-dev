import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../state/office_state.dart';
import 'error_panel.dart';
import '../state/selection.dart';

class EnvironmentDialog extends ConsumerStatefulWidget {
  const EnvironmentDialog({super.key});
  @override
  ConsumerState<EnvironmentDialog> createState() => _EnvironmentDialogState();
}

class _EnvironmentDialogState extends ConsumerState<EnvironmentDialog> {
  bool busy = false;
  Map<String, dynamic>? result;
  String? error;
  List<String>? allowedEngines;
  bool policyLoaded = false;
  int maxLiveSessions = 16, maxTeamsPerDepartment = 8;
  @override
  void initState() {
    super.initState();
    check();
  }

  Future<void> check({String? memberId}) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      if (!policyLoaded) {
        final limits = await ref.read(rpcClientProvider).call('resources.get');
        maxLiveSessions = (limits['maxLiveSessions'] as num?)?.toInt() ?? 16;
        maxTeamsPerDepartment =
            (limits['maxTeamsPerDepartment'] as num?)?.toInt() ?? 8;
        final policy = await ref.read(rpcClientProvider).call('engines.get');
        allowedEngines = (policy['allowedEngines'] as List?)?.cast<String>();
        policyLoaded = true;
      }
      final value = await ref.read(rpcClientProvider).call(
        'environment.check',
        {'memberId': ?memberId},
      );
      if (mounted) setState(() => result = value);
    } catch (e) {
      if (mounted) setState(() => error = errorMessage(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> savePolicy(List<String>? engines) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final value = await ref.read(rpcClientProvider).call('engines.set', {
        'allowedEngines': engines,
      });
      if (mounted) {
        setState(
          () => allowedEngines = (value['allowedEngines'] as List?)
              ?.cast<String>(),
        );
      }
    } catch (e) {
      if (mounted) setState(() => error = errorMessage(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> saveLimits({int? sessions, int? teams}) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final value = await ref.read(rpcClientProvider).call('resources.set', {
        'maxLiveSessions': sessions ?? maxLiveSessions,
        'maxTeamsPerDepartment': teams ?? maxTeamsPerDepartment,
      });
      if (mounted) {
        setState(() {
          maxLiveSessions = (value['maxLiveSessions'] as num).toInt();
          maxTeamsPerDepartment = (value['maxTeamsPerDepartment'] as num)
              .toInt();
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = errorMessage(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Widget limitPicker(
    String label,
    int value,
    int maximum,
    String key,
    void Function(int?) change,
  ) => SizedBox(
    width: 264,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(fontSize: 12, color: Colors.white60),
        ),
        DropdownButton<int>(
          key: Key(key),
          value: value,
          isExpanded: true,
          items:
              ({
                    1,
                    4,
                    8,
                    16,
                    32,
                    maximum,
                    value,
                  }.where((n) => n <= maximum).toList()..sort())
                  .map((n) => DropdownMenuItem(value: n, child: Text('$n개')))
                  .toList(),
          onChanged: busy ? null : change,
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('환경 점검 · CLI 로그인'),
    content: SizedBox(
      width: 620,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              '사용할 엔진만 설치·로그인하면 됩니다. 점검은 CLI의 상태 명령을 읽으며 자동 설치나 로그인 변경을 하지 않습니다.',
            ),
            const SizedBox(height: 12),
            const Text('사용 엔진 · 결제 여부는 자동으로 판단하지 않습니다.'),
            if (policyLoaded)
              DropdownButton<String>(
                value: allowedEngines == null
                    ? 'head'
                    : allowedEngines!.length == 2
                    ? 'both'
                    : allowedEngines!.first,
                isExpanded: true,
                items: const [
                  DropdownMenuItem(
                    value: 'head',
                    child: Text('부장과 같은 엔진만 사용 (기본)'),
                  ),
                  DropdownMenuItem(
                    value: 'claude',
                    child: Text('Claude Code만 사용'),
                  ),
                  DropdownMenuItem(value: 'codex', child: Text('Codex만 사용')),
                  DropdownMenuItem(
                    value: 'both',
                    child: Text('Claude Code + Codex 사용'),
                  ),
                ],
                onChanged: busy
                    ? null
                    : (v) => savePolicy(
                        v == 'head'
                            ? null
                            : v == 'both'
                            ? ['claude', 'codex']
                            : [v!],
                      ),
              ),
            const Text('생성·재고용·복구에 적용됩니다. 이미 실행 중인 작업은 중단하지 않습니다.'),
            const SizedBox(height: 16),
            const Text(
              '동시 작업 제한',
              style: TextStyle(fontWeight: FontWeight.bold),
            ),
            if (policyLoaded)
              Wrap(
                spacing: 16,
                runSpacing: 8,
                children: [
                  limitPicker(
                    '전체 AI 세션 수',
                    maxLiveSessions,
                    64,
                    'environment.sessionLimit',
                    (n) => saveLimits(sessions: n),
                  ),
                  limitPicker(
                    '부서별 팀 수',
                    maxTeamsPerDepartment,
                    32,
                    'environment.teamLimit',
                    (n) => saveLimits(teams: n),
                  ),
                ],
              ),
            const Text('이미 실행 중인 세션은 유지하며 새 생성·복구부터 제한합니다.'),
            if (busy)
              const Padding(
                padding: EdgeInsets.all(12),
                child: LinearProgressIndicator(),
              ),
            if (error != null)
              ErrorPanel(
                title: '환경 점검을 완료하지 못했어요',
                message: error!,
                compact: true,
              ),
            if (result != null) ...[
              Text('Node.js ${result!["nodeVersion"] ?? "확인 불가"}'),
              if (result!['memberName'] != null)
                Text('프로젝트 세션: ${result!["memberName"]}'),
              for (final engine
                  in (result!['engines'] as List? ?? []).whereType<Map>())
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          engine['engine'] == 'claude'
                              ? 'Claude Code'
                              : 'Codex',
                          style: const TextStyle(fontWeight: FontWeight.bold),
                        ),
                        SelectableText(
                          engine['message']?.toString() ?? '점검 결과 없음',
                        ),
                      ],
                    ),
                  ),
                ),
            ],
            const SizedBox(height: 12),
            const Text(
              '설치·로그인 후 다시 검사하세요. 새 설치로 PATH가 바뀌었다면 앱을 다시 열어야 할 수 있습니다. 프로젝트 전용 세션의 로그인 문제는 해당 멤버 터미널에서도 확인하세요.',
            ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('닫기'),
      ),
      if (ref.watch(selectedMemberIdProvider) != null)
        TextButton(
          onPressed: busy
              ? null
              : () => check(memberId: ref.read(selectedMemberIdProvider)),
          child: const Text('선택 멤버 검사'),
        ),
      FilledButton(
        onPressed: busy ? null : () => check(),
        child: const Text('다시 검사'),
      ),
    ],
  );
}
