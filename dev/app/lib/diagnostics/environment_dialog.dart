import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../state/office_state.dart';
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
      if (mounted) setState(() => error = e.toString());
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
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

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
            if (busy)
              const Padding(
                padding: EdgeInsets.all(12),
                child: LinearProgressIndicator(),
              ),
            if (error != null) SelectableText(error!),
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
