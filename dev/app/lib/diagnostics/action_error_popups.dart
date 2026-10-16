import 'dart:async';
import 'dart:collection';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../model/models.dart';
import '../panel/ui_prefs.dart';
import '../panel/panel_tabs.dart';
import '../state/selection.dart';
import '../rpc/rpc_client.dart';
import '../state/office_state.dart';
import '../workflow/workflow_panel.dart' show workflowProvider;
import 'error_panel.dart';

class ActiveProblems extends Notifier<Map<String, String>> {
  @override
  Map<String, String> build() => {};
  void set(String key, String? message) {
    if (state[key] == message) return;
    final next = {...state}..remove(key);
    if (message != null) next[key] = message;
    state = next;
  }
}

final activeProblemsProvider =
    NotifierProvider<ActiveProblems, Map<String, String>>(ActiveProblems.new);

/// Remains visible after the user closes the popup, until the actual problem clears.
class ActiveProblemsBanner extends ConsumerWidget {
  const ActiveProblemsBanner({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final problems = ref.watch(activeProblemsProvider);
    if (problems.isEmpty) return const SizedBox.shrink();
    final message = problems.values.join('\n\n');
    return Material(
      key: const Key('activeProblems.banner'),
      color: const Color(0xFF493140),
      child: InkWell(
        onTap: () => showErrorPanel(
          context,
          title: '해결이 필요한 문제 ${problems.length}건',
          message: message,
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Row(
            children: [
              const Icon(
                Icons.error_outline,
                color: Color(0xFFFFB4BF),
                size: 20,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '해결이 필요한 문제 ${problems.length}건 · ${problems.values.first}',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Color(0xFFFFD2DB)),
                ),
              ),
              const SizedBox(width: 8),
              const Text(
                '눌러서 원인 확인',
                style: TextStyle(color: Color(0xFFFFD2DB), fontSize: 12),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Map user operations to useful titles; connection probes and cleanup stay quiet.
String? actionErrorTitle(String method) => const {
  'member.login': '로그인 화면을 열지 못했어요',
  'member.auth.recover': '연결 갱신을 진행하지 못했어요',
  'member.terminalCommand': '터미널 명령을 보내지 못했어요',
  'clipboard.copy': '내용을 복사하지 못했어요',
  'department.update': '부서 설정을 바꾸지 못했어요',
  'department.delete': '부서를 삭제하지 못했어요',
  'member.instruct': '지시를 보내지 못했어요',
  'member.interrupt': '작업을 중단하지 못했어요',
  'member.clockOut': '퇴근 처리하지 못했어요',
  'member.rehire': '다시 출근시키지 못했어요',
  'member.restart': '다시 시작하지 못했어요',
  'member.instructions.get': '지시문을 불러오지 못했어요',
  'member.instructions.set': '지시문을 저장하지 못했어요',
  'approval.respond': '승인 응답을 보내지 못했어요',
  'question.respond': '질문에 대한 답을 보내지 못했어요',
  'task.retrySubmit': '지시를 다시 제출하지 못했어요',
  'member.attach': '작업 화면을 연결하지 못했어요',
  'member.type': '작업 화면에 입력을 보내지 못했어요',
  'member.resize': '작업 화면 크기를 맞추지 못했어요',
  'events.query': '작업 기록을 불러오지 못했어요',
  'workflow.get': '대화와 작업 상태를 불러오지 못했어요',
  'workflow.discuss': '대화를 보내지 못했어요',
  'workflow.start': '작업을 시작하지 못했어요',
  'workflow.resume': '작업을 재개하지 못했어요',
  'workflow.cancel': '작업을 취소하지 못했어요',
  'workflow.complete': '검수 완료를 저장하지 못했어요',
  'environment.check': '실행 환경을 점검하지 못했어요',
  'resources.get': '동시 작업 설정을 불러오지 못했어요',
  'resources.set': '동시 작업 설정을 저장하지 못했어요',
  'engines.get': '사용할 AI 설정을 불러오지 못했어요',
  'engines.set': '사용할 AI 설정을 저장하지 못했어요',
  'storage.get': '저장 상태를 확인하지 못했어요',
  'storage.backup': '기록을 백업하지 못했어요',
  'remote.status': '기기 연결 상태를 불러오지 못했어요',
  'remote.retry': '원격 연결을 다시 시작하지 못했어요',
  'remote.configure': '접속 주소를 저장하지 못했어요',
  'remote.pair.create': '기기 등록 키를 만들지 못했어요',
  'remote.device.approve': '기기 연결을 승인하지 못했어요',
  'remote.device.revoke': '기기 연결을 해제하지 못했어요',
}[method];

String actionErrorMessage(Object error, {String? method}) {
  if ((method == 'member.auth.recover' || method == 'member.login') &&
      error is RpcException &&
      error.code == RpcException.badState &&
      error.message.startsWith('진행 중')) {
    return '${error.message}\n\n진행 중인 작업을 보호하기 위한 안내입니다. 로그인이 만료되었다는 뜻은 아니에요.';
  }
  return switch (error) {
    RpcException(code: RpcException.closed) =>
      '작업 관리 프로그램과 연결이 끊어졌어요.\n상단의 연결 상태가 정상으로 돌아오면 처리 결과를 확인한 뒤 다시 시도해 주세요.',
    RpcException(code: RpcException.timeout) =>
      '처리 시간이 길어져 결과를 확인하지 못했어요.\n잠시 기다린 뒤 처리 결과를 확인하고, 반영되지 않았다면 다시 시도해 주세요.',
    _ => '${errorMessage(error)}\n\n문제를 해결한 뒤 다시 시도해 주세요.',
  };
}

/// One app-wide listener also covers keyboard shortcuts and terminal input whose
/// callers deliberately ignore exceptions. No request text or credentials are kept.
class ActionErrorPopups extends ConsumerStatefulWidget {
  const ActionErrorPopups({super.key, required this.child});
  final Widget child;
  @override
  ConsumerState<ActionErrorPopups> createState() => _ActionErrorPopupsState();
}

class _ActionErrorPopupsState extends ConsumerState<ActionErrorPopups> {
  final _queue =
      Queue<
        ({String title, String message, String? issueKey, String? memberId})
      >();
  final _pending = <String>{};
  StreamSubscription<RpcCallFailure>? _subscription;
  StreamSubscription<String>? _successes;
  StreamSubscription<RpcNotification>? _notifications;
  StreamSubscription<HelloResult>? _hellos;
  final _workflowProblems = <String, String>{};
  final _failedReads = <String, String>{};
  bool _showing = false;
  String? _activeIssueKey;
  BuildContext? _activeDialog;

  @override
  void initState() {
    super.initState();
    _subscription = ref.read(rpcClientProvider).failures.listen((failure) {
      // Department creation already owns its popup. Older daemons may omit this
      // optional health method, which the environment dialog handles explicitly.
      if (failure.method == 'storage.get' &&
          failure.error is RpcException &&
          (failure.error as RpcException).code == -32601) {
        return;
      }
      final title = actionErrorTitle(failure.method);
      if (title == null) return;
      final message = actionErrorMessage(failure.error, method: failure.method);
      if (const [
        'remote.status',
        'workflow.get',
        'events.query',
      ].contains(failure.method)) {
        if (_failedReads[failure.method] == message) return;
        _failedReads[failure.method] = message;
      }
      _enqueue(title, message);
    });
    _successes = ref
        .read(rpcClientProvider)
        .successes
        .listen(_failedReads.remove);
    _notifications = ref.read(rpcClientProvider).notifications.listen((
      notification,
    ) {
      if (notification.method == 'workflow.changed') {
        _workflow(notification.params);
      }
    });
    _hellos = ref.read(rpcClientProvider).hellos.listen((hello) {
      // Restored errors need the same announcement as newly occurring errors.
      final workflows = (hello.snapshot['workflows'] as List? ?? [])
          .whereType<Map>();
      final ids = workflows.map((w) => w['departmentId']?.toString()).toSet();
      for (final id in _workflowProblems.keys.toList()) {
        if (!ids.contains(id)) _workflow({'departmentId': id});
      }
      for (final w in workflows) {
        _workflow(w);
      }
    });
  }

  void _workflow(Map data) {
    final id = data['departmentId']?.toString();
    if (id == null) return;
    final problem = data['phase'] == 'blocked'
        ? (data['problem']?.toString() ??
              '작업이 중단됐습니다. 부장과 대화 · 회의 보기에서 상태를 확인하세요.')
        : null;
    ref.read(activeProblemsProvider.notifier).set('workflow:$id', problem);
    if (problem == null || problem.isEmpty) {
      _workflowProblems.remove(id);
      _resolved('workflow:$id');
    } else if (_workflowProblems[id] != problem) {
      _workflowProblems[id] = problem;
      _enqueue('작업을 계속할 수 없어요', problem, issueKey: 'workflow:$id');
    }
  }

  void _resolved(String key) {
    _queue.removeWhere((item) {
      if (item.issueKey != key) return false;
      _pending.remove(item.message);
      return true;
    });
    if (_activeIssueKey != key) return;
    final dialog = _activeDialog;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted ||
          dialog == null ||
          !dialog.mounted ||
          _activeIssueKey != key ||
          ref.read(activeProblemsProvider).containsKey(key)) {
        return;
      }
      final route = ModalRoute.of(dialog);
      if (route != null && route.isActive) {
        Navigator.of(dialog).removeRoute(route);
      }
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  void _enqueue(
    String title,
    String message, {
    String? issueKey,
    String? memberId,
  }) {
    if (!mounted || !_pending.add(message)) return;
    _queue.add((
      title: title,
      message: message,
      issueKey: issueKey,
      memberId: memberId,
    ));
    if (!_showing) {
      _showing = true;
      WidgetsBinding.instance.addPostFrameCallback((_) => _drain());
      WidgetsBinding.instance.ensureVisualUpdate();
    }
  }

  Future<void> _drain() async {
    while (mounted && _queue.isNotEmpty) {
      final next = _queue.removeFirst();
      if (next.issueKey != null &&
          !ref.read(activeProblemsProvider).containsKey(next.issueKey)) {
        _pending.remove(next.message);
        continue;
      }
      _activeIssueKey = next.issueKey;
      await showErrorPanel(
        context,
        title: next.title,
        message: next.message,
        onOpened: (dialog) => _activeDialog = dialog,
        actions: [
          if (next.memberId != null)
            TextButton.icon(
              onPressed: () {
                ref
                    .read(selectedMemberIdProvider.notifier)
                    .select(next.memberId);
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (mounted) {
                    ref
                        .read(panelTabRequestProvider.notifier)
                        .request(RightPanelTab.terminal);
                  }
                });
                if (_activeDialog != null) Navigator.pop(_activeDialog!);
              },
              icon: const Icon(Icons.terminal),
              label: const Text('터미널 열기 · 로그인 복구'),
            ),
        ],
      );
      _activeDialog = null;
      _activeIssueKey = null;
      _pending.remove(next.message);
    }
    _showing = false;
  }

  @override
  void dispose() {
    _subscription?.cancel();
    _successes?.cancel();
    _notifications?.cancel();
    _hellos?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    for (final id in ref.watch(departmentsProvider).keys) {
      ref.listen(workflowProvider(id), (_, next) {
        if (next.asData?.value case final Map data) {
          _workflow(data);
        }
      });
    }
    ref.listen(membersProvider, (previous, next) {
      final registry = ref.read(activeProblemsProvider.notifier);
      for (final id in {...?previous?.keys, ...next.keys}) {
        final member = next[id];
        final key = 'member:$id';
        if (member?.status != MemberStatus.error) {
          registry.set(key, null);
          _resolved(key);
        } else {
          final event = ref
              .read(memberEventsProvider(id))
              .where((e) => e.kind == OfficeEventKind.error)
              .lastOrNull;
          final detail =
              event?.detail.summary ??
              event?.detail.text ??
              'AI 실행에 실패했습니다. 작업 화면과 로그인 상태를 확인한 뒤 다시 출근시켜 주세요.';
          final message = detail.startsWith('${member!.name}:')
              ? detail
              : '${member.name}: $detail';
          registry.set(key, message);
          if (previous?[id]?.status != MemberStatus.error) {
            _enqueue('AI를 실행하지 못했어요', message, issueKey: key, memberId: id);
          }
        }
      }
    });
    ref.listen(noticesProvider, (previous, next) {
      if (next.isEmpty ||
          (previous?.isNotEmpty == true &&
              identical(previous!.last, next.last))) {
        return;
      }
      final notice = next.last;
      if (notice.level == NoticeLevel.error && notice.message.isNotEmpty) {
        _enqueue('작업 중 문제가 생겼어요', notice.message);
      }
    });
    ref.listen(prefsSaveFailureProvider, (previous, next) {
      if (next != null && next != previous) {
        _enqueue(
          '설정을 저장하지 못했어요',
          '$next\n\n폴더의 쓰기 권한과 남은 공간을 확인한 뒤 ‘다시 저장’을 눌러 주세요.',
        );
      }
    });
    ref.listen(prefsReadFailureProvider, (previous, next) {
      if (next != null && next != previous) {
        _enqueue(
          '설정을 불러오지 못했어요',
          '저장된 설정을 읽을 수 없어 기본 화면 설정을 사용합니다.\n설정 파일의 내용과 읽기 권한을 확인해 주세요.\n\n$next',
        );
      }
    });
    ref.listen(globalEventsProvider, (previous, next) {
      if (next.isEmpty ||
          (previous?.isNotEmpty == true &&
              previous!.last.seq == next.last.seq)) {
        return;
      }
      final event = next.last;
      if (event.kind == OfficeEventKind.error) {
        final member = ref.read(membersProvider)[event.memberId]?.name ?? 'AI';
        _enqueue(
          '$member 작업 중 문제가 생겼어요',
          event.detail.summary ??
              event.detail.text ??
              '작업을 계속하지 못했어요. 작업 기록과 실행 환경을 확인해 주세요.',
          memberId: event.memberId,
        );
      }
    });
    return widget.child;
  }
}
