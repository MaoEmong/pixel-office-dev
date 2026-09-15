// 허가·질문 카드(T15) — 설계 §3 "허가·질문 카드", 모달 없음.
//
//  PendingCards(memberId)   그 멤버의 열린 pending 을 오래된 순으로 카드로(RightPanel 헤더 아래). 보통 0~1장.
//  PendingInbox()           전 멤버의 열린 pending, 최신 먼저 + 멤버 이름 (내 책상 UI 용, 아직 배선 안 함).
//  PendingCard(pending)     type 으로 ApprovalCard / QuestionCard 분기.
//  ApprovalCard(pending)    "❗ 허가 요청 — <tool_name>"
//     Bash/PowerShell: command 고정폭 박스 + description.  Edit/Write: 파일 경로 + diff/내용 미리보기(12줄).
//     그 외: tool_input JSON(12줄 넘으면 접음).
//     버튼: 허가 / 거부(사유 입력란이 인라인으로) / 이번 세션 항상 허가 / 수정해서 허가(명령 박스가 편집 가능해짐 → updatedInput).
//     키: 카드 자체가 포커스를 가질 때 Enter = 허가, Esc = 포커스 해제. 전역 단축키 없음(지시 바를 뺏지 않는다).
//  QuestionCard(pending)    AskUserQuestion `{questions:[{question, header?, options:[{label, description?}], multiSelect?}]}`
//     또는 M2 ask_user `{question, options?}`(질문 하나). 옵션 버튼(설명은 툴팁) + "직접 입력" 란.
//     질문 하나·단일 선택이면 옵션을 누르는 즉시 전송, 그 외(여러 질문·multiSelect·직접 입력)는 확인 버튼.
//     answers = `{question: label}`(multiSelect 는 ", " 로 이음).
//
//  보낸 뒤에는 버튼을 잠그고 "전송됨" 을 띄운다. pending 은 상태 층이 지우면(응답 성공 → removePending,
//  member.status 가 waiting 을 벗어남, error{pendingId}) 목록에서 빠져 카드가 사라진다. 실패하면 사유를 보여 주고 다시 연다.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../rpc/rpc_client.dart';
import '../state/office_state.dart';
import 'labels.dart';

/// 미리보기(내용·diff·JSON)에 보여 줄 최대 줄 수.
const int pendingPreviewLines = 12;

const Color _approvalColor = Colors.amber;
const Color _questionColor = Colors.cyanAccent;

const TextStyle _monoStyle = TextStyle(
  fontSize: 12,
  height: 1.35,
  color: Colors.white,
  fontFamily: panelMonoFamily,
  fontFamilyFallback: panelMonoFallback,
);

// ---- 목록 --------------------------------------------------------------------------

/// 한 멤버의 열린 pending(오래된 순). 없으면 빈 위젯.
class PendingCards extends ConsumerWidget {
  const PendingCards({super.key, required this.memberId});

  final String memberId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final all = ref.watch(openPendingProvider);
    final mine = all.values.where((p) => p.memberId == memberId).toList()..sort((a, b) => a.createdAt.compareTo(b.createdAt));
    if (mine.isEmpty) return const SizedBox.shrink();
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [for (final p in mine) PendingCard(key: ValueKey('pending-${p.id}'), pending: p)],
    );
  }
}

/// 전 멤버의 열린 pending, 최신 먼저. 카드 위에 멤버 이름을 붙인다. (내 책상 인박스 — 아직 배선하지 않음)
class PendingInbox extends ConsumerWidget {
  const PendingInbox({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final all = ref.watch(openPendingProvider);
    final members = ref.watch(membersProvider);
    final list = all.values.toList()..sort((a, b) => b.createdAt.compareTo(a.createdAt));
    if (list.isEmpty) {
      return const Center(child: Text('기다리는 허가·질문 없음', style: TextStyle(color: Colors.white38)));
    }
    return ListView.builder(
      itemCount: list.length,
      itemBuilder: (context, i) {
        final p = list[i];
        final m = members[p.memberId];
        return Column(
          key: ValueKey('inbox-${p.id}'),
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 8, 12, 0),
              child: Text(
                '${m?.name ?? p.memberId} · ${formatClock(p.createdAt)}',
                style: const TextStyle(fontSize: 11, color: Colors.white54),
              ),
            ),
            PendingCard(pending: p),
          ],
        );
      },
    );
  }
}

/// type 분기.
class PendingCard extends StatelessWidget {
  const PendingCard({super.key, required this.pending});

  final Pending pending;

  @override
  Widget build(BuildContext context) => switch (pending.type) {
        PendingType.approval => ApprovalCard(pending: pending),
        PendingType.question => QuestionCard(pending: pending),
      };
}

// ---- 공용 틀 ------------------------------------------------------------------------

class _CardFrame extends StatelessWidget {
  const _CardFrame({required this.accent, required this.title, required this.focused, required this.children});

  final Color accent;
  final String title;
  final bool focused;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.fromLTRB(8, 8, 8, 4),
        padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHigh,
          border: Border.all(color: focused ? accent : accent.withValues(alpha: 0.6), width: focused ? 2 : 1.5),
          borderRadius: BorderRadius.circular(4),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(title, style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.bold, color: accent)),
            const SizedBox(height: 6),
            ...children,
          ],
        ),
      );
}

class _MonoBox extends StatelessWidget {
  const _MonoBox({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        decoration: BoxDecoration(
          color: Colors.black26,
          border: Border.all(color: Colors.white24),
          borderRadius: BorderRadius.circular(3),
        ),
        child: SelectableText(text, style: _monoStyle),
      );
}

class _SentBadge extends StatelessWidget {
  const _SentBadge();

  @override
  Widget build(BuildContext context) => const Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(width: 10, height: 10, child: CircularProgressIndicator(strokeWidth: 1.5, color: Colors.white54)),
          SizedBox(width: 6),
          Text('전송됨', style: TextStyle(fontSize: 11.5, color: Colors.white54)),
        ],
      );
}

class _ErrorLine extends StatelessWidget {
  const _ErrorLine(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Text('전송 실패: $text', style: const TextStyle(fontSize: 11.5, color: Colors.redAccent)),
      );
}

/// 카드 안의 작은 버튼(들쭉날쭉하지 않게 공통 스타일).
ButtonStyle _smallButtonStyle({Color? fg, Color? bg}) => ButtonStyle(
      visualDensity: VisualDensity.compact,
      padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 10, vertical: 4)),
      minimumSize: const WidgetStatePropertyAll(Size(0, 30)),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      textStyle: const WidgetStatePropertyAll(TextStyle(fontSize: 12.5)),
      foregroundColor: fg == null ? null : WidgetStatePropertyAll(fg),
      backgroundColor: bg == null ? null : WidgetStatePropertyAll(bg),
      shape: WidgetStatePropertyAll(RoundedRectangleBorder(borderRadius: BorderRadius.circular(3))),
    );

String _describeError(Object e) => e is RpcException ? '${e.message} (${e.code})' : e.toString();

/// 데몬 오류 중 "이미 닫힌 pending"(-32002 없음, -32003 이미 answered/expired) — 재시도해도 소용없다.
bool _isGoneError(Object e) => e is RpcException && (e.code == -32002 || e.code == -32003);

// ---- 허가 카드 --------------------------------------------------------------------------

/// 셸 계열 도구(명령 박스 + 수정해서 허가).
bool isShellTool(String toolName) {
  final t = toolName.toLowerCase();
  return t == 'bash' || t == 'powershell' || t == 'shell' || t.endsWith('_shell') || t == 'cmd';
}

/// 파일 편집 계열 도구(경로 + 미리보기).
bool isFileTool(String toolName) => const {'Edit', 'Write', 'MultiEdit', 'NotebookEdit'}.contains(toolName);

class ApprovalCard extends ConsumerStatefulWidget {
  const ApprovalCard({super.key, required this.pending});

  final Pending pending;

  @override
  ConsumerState<ApprovalCard> createState() => _ApprovalCardState();
}

class _ApprovalCardState extends ConsumerState<ApprovalCard> {
  late final FocusNode _focus = FocusNode(debugLabel: 'approvalCard', onKeyEvent: _onKey);
  final TextEditingController _reason = TextEditingController();
  TextEditingController? _editor; // 수정해서 허가 모드일 때만
  bool _denying = false;
  bool _sent = false;
  bool _expanded = false;
  String? _error;

  Map<String, dynamic> get _payload => widget.pending.payload;
  String get _toolName => _payload['tool_name']?.toString() ?? '';
  Map<String, dynamic> get _toolInput {
    final v = _payload['tool_input'];
    return v is Map ? Map<String, dynamic>.from(v) : const {};
  }

  String? get _command => _toolInput['command']?.toString();

  @override
  void dispose() {
    _focus.dispose();
    _reason.dispose();
    _editor?.dispose();
    super.dispose();
  }

  // ---- 키 ------------------------------------------------------------------------------

  KeyEventResult _onKey(FocusNode node, KeyEvent e) {
    if (e is! KeyDownEvent) return KeyEventResult.ignored;
    if (e.logicalKey == LogicalKeyboardKey.escape) {
      node.unfocus();
      return KeyEventResult.handled;
    }
    final isEnter = e.logicalKey == LogicalKeyboardKey.enter || e.logicalKey == LogicalKeyboardKey.numpadEnter;
    // 카드 자체가 포커스일 때만(안의 입력란·버튼이 포커스면 그쪽이 처리).
    if (isEnter && node.hasPrimaryFocus && !_sent) {
      _allow();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  // ---- RPC ------------------------------------------------------------------------------

  bool get _canSend => !_sent && ref.read(connectionStateProvider) == RpcConnectionState.connected;

  Future<void> _submit(Future<void> Function() call) async {
    if (!_canSend) return;
    setState(() {
      _sent = true;
      _error = null;
    });
    try {
      await call();
    } catch (e) {
      if (!mounted) return;
      if (_isGoneError(e)) {
        // 이미 닫힌 pending — 상태 층 정리를 기다리는 동안 잠근 채로 사유만.
        setState(() => _error = _describeError(e));
      } else {
        setState(() {
          _sent = false;
          _error = _describeError(e);
        });
      }
    }
  }

  void _allow() => _submit(() => ref.read(officeProvider.notifier).respondApproval(widget.pending.id, allow: true));

  void _allowAlways() =>
      _submit(() => ref.read(officeProvider.notifier).respondApproval(widget.pending.id, allow: true, alwaysThisSession: true));

  void _deny() {
    final msg = _reason.text.trim();
    _submit(() => ref.read(officeProvider.notifier).respondApproval(widget.pending.id, allow: false, message: msg.isEmpty ? null : msg));
  }

  void _allowEdited() {
    final edited = _editor?.text ?? '';
    if (edited.trim().isEmpty) return;
    _submit(() async {
      await ref.read(rpcClientProvider).call('approval.respond', {
        'pendingId': widget.pending.id,
        'behavior': 'allow',
        'updatedInput': {..._toolInput, 'command': edited},
      });
      ref.read(officeProvider.notifier).removePending(widget.pending.id);
    });
  }

  void _startEdit() {
    setState(() {
      _editor ??= TextEditingController(text: _command ?? '');
      _denying = false;
    });
  }

  void _cancelEdit() {
    setState(() {
      _editor?.dispose();
      _editor = null;
    });
  }

  // ---- 그리기 ------------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final connected = ref.watch(connectionStateProvider) == RpcConnectionState.connected;
    final locked = _sent || !connected;
    return Listener(
      // 카드 빈 곳을 누르면 카드에 포커스(Enter = 허가). 버튼·입력란은 자기 포커스를 가진다.
      onPointerDown: (_) {
        if (!_focus.hasFocus) _focus.requestFocus();
      },
      child: Focus(
        focusNode: _focus,
        child: ListenableBuilder(
          listenable: _focus,
          builder: (context, _) => _CardFrame(
            accent: _approvalColor,
            title: '❗ 허가 요청 — $_toolName',
            focused: _focus.hasPrimaryFocus,
            children: [
              _body(),
              if (_denying) _denyField(locked),
              const SizedBox(height: 8),
              _buttons(locked),
              if (!connected && !_sent)
                const Padding(
                  padding: EdgeInsets.only(top: 6),
                  child: Text('데몬 연결 안 됨 — 재접속되면 응답할 수 있습니다', style: TextStyle(fontSize: 11.5, color: Colors.white54)),
                ),
              if (_error != null) _ErrorLine(_error!),
            ],
          ),
        ),
      ),
    );
  }

  Widget _body() {
    final input = _toolInput;
    final description = (input['description'] ?? _payload['summary'])?.toString();
    if (isShellTool(_toolName) || (_command != null && input.length <= 2)) {
      final editor = _editor;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (editor != null)
            TextField(
              key: const ValueKey('approval-command-editor'),
              controller: editor,
              autofocus: true,
              maxLines: null,
              minLines: 2,
              style: _monoStyle,
              decoration: const InputDecoration(
                isDense: true,
                contentPadding: EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                border: OutlineInputBorder(borderSide: BorderSide(color: Colors.white24)),
                helperText: '명령을 고친 뒤 "수정한 명령으로 허가"',
                helperStyle: TextStyle(fontSize: 10.5),
              ),
            )
          else
            _MonoBox(text: _command ?? '(명령 없음)'),
          if (description != null && description.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(description, style: const TextStyle(fontSize: 12, color: Colors.white70)),
            ),
        ],
      );
    }
    if (isFileTool(_toolName)) {
      final path = (input['file_path'] ?? input['notebook_path'] ?? input['path'])?.toString() ?? '';
      final preview = filePreviewLines(_toolName, input);
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(path, style: _monoStyle.copyWith(color: Colors.white), overflow: TextOverflow.ellipsis, maxLines: 2),
          if (preview.lines.isNotEmpty) ...[
            const SizedBox(height: 4),
            _MonoBox(text: preview.lines.join('\n')),
          ],
          if (preview.omitted > 0)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text('… ${preview.omitted}줄 더', style: const TextStyle(fontSize: 11, color: Colors.white38)),
            ),
        ],
      );
    }
    // 그 외 도구: JSON.
    final json = prettyJson(input);
    final lines = json.split('\n');
    final collapsible = lines.length > pendingPreviewLines;
    final shown = collapsible && !_expanded ? lines.take(pendingPreviewLines).join('\n') : json;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        _MonoBox(text: shown),
        if (collapsible)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              style: _smallButtonStyle(fg: Colors.white54),
              onPressed: () => setState(() => _expanded = !_expanded),
              child: Text(_expanded ? '접기' : '… ${lines.length - pendingPreviewLines}줄 더 보기'),
            ),
          ),
      ],
    );
  }

  Widget _denyField(bool locked) => Padding(
        padding: const EdgeInsets.only(top: 8),
        child: TextField(
          key: const ValueKey('approval-deny-reason'),
          controller: _reason,
          autofocus: true,
          enabled: !locked,
          onSubmitted: (_) => _deny(),
          style: const TextStyle(fontSize: 12.5),
          decoration: const InputDecoration(
            isDense: true,
            hintText: '거부 사유(선택) — 멤버에게 전달됩니다',
            contentPadding: EdgeInsets.symmetric(horizontal: 8, vertical: 8),
            border: OutlineInputBorder(),
          ),
        ),
      );

  Widget _buttons(bool locked) {
    final editing = _editor != null;
    final shell = isShellTool(_toolName) || _command != null;
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        if (editing)
          FilledButton(
            style: _smallButtonStyle(),
            onPressed: locked ? null : _allowEdited,
            child: const Text('수정한 명령으로 허가'),
          )
        else
          FilledButton(
            style: _smallButtonStyle(),
            onPressed: locked ? null : _allow,
            child: const Text('허가'),
          ),
        if (_denying)
          OutlinedButton(
            style: _smallButtonStyle(fg: Colors.redAccent),
            onPressed: locked ? null : _deny,
            child: const Text('거부 전송'),
          )
        else
          OutlinedButton(
            style: _smallButtonStyle(fg: Colors.redAccent),
            onPressed: locked ? null : () => setState(() => _denying = true),
            child: const Text('거부'),
          ),
        if (!editing)
          OutlinedButton(
            style: _smallButtonStyle(),
            onPressed: locked ? null : _allowAlways,
            child: const Text('이번 세션 항상 허가'),
          ),
        if (shell && !editing)
          OutlinedButton(
            style: _smallButtonStyle(),
            onPressed: locked ? null : _startEdit,
            child: const Text('수정해서 허가'),
          ),
        if (editing || _denying)
          TextButton(
            style: _smallButtonStyle(fg: Colors.white54),
            onPressed: locked
                ? null
                : () {
                    if (editing) _cancelEdit();
                    if (_denying) setState(() => _denying = false);
                  },
            child: const Text('취소'),
          ),
        if (_sent) const _SentBadge(),
      ],
    );
  }
}

/// 미리보기 줄 + 잘린 줄 수.
typedef PreviewLines = ({List<String> lines, int omitted});

PreviewLines _cap(List<String> lines) => lines.length <= pendingPreviewLines
    ? (lines: lines, omitted: 0)
    : (lines: lines.take(pendingPreviewLines).toList(growable: false), omitted: lines.length - pendingPreviewLines);

/// Edit/Write/MultiEdit/NotebookEdit 의 tool_input → 짧은 diff/내용 미리보기(최대 [pendingPreviewLines] 줄).
///  Write: `content` 첫 줄들.  Edit: `- old` / `+ new`.  MultiEdit: 첫 edit 의 diff + 개수.  NotebookEdit: `new_source`.
PreviewLines filePreviewLines(String toolName, Map<String, dynamic> input) {
  List<String> diff(Object? oldS, Object? newS) => [
        for (final l in (oldS?.toString() ?? '').split('\n')) '- $l',
        for (final l in (newS?.toString() ?? '').split('\n')) '+ $l',
      ];
  if (input['content'] != null) return _cap(input['content'].toString().split('\n'));
  if (input['old_string'] != null || input['new_string'] != null) return _cap(diff(input['old_string'], input['new_string']));
  final edits = input['edits'];
  if (edits is List && edits.isNotEmpty && edits.first is Map) {
    final first = edits.first as Map;
    final lines = [if (edits.length > 1) '(${edits.length}개 수정 중 첫 번째)', ...diff(first['old_string'], first['new_string'])];
    return _cap(lines);
  }
  if (input['new_source'] != null) return _cap(input['new_source'].toString().split('\n'));
  return (lines: const [], omitted: 0);
}

String prettyJson(Object? v) {
  try {
    return const JsonEncoder.withIndent('  ').convert(v);
  } on JsonUnsupportedObjectError {
    return v.toString();
  }
}

// ---- 질문 카드 --------------------------------------------------------------------------

/// 질문 하나의 정규화된 형태.
class PendingQuestion {
  const PendingQuestion({required this.question, this.header, required this.options, this.multiSelect = false});

  final String question;
  final String? header;
  final List<PendingOption> options;
  final bool multiSelect;
}

class PendingOption {
  const PendingOption({required this.label, this.description});
  final String label;
  final String? description;
}

/// payload → 질문 목록. AskUserQuestion(`questions[]` 또는 `tool_input.questions[]`) / M2 ask_user(`question`, `options?`).
List<PendingQuestion> parseQuestions(Map<String, dynamic> payload) {
  final input = payload['tool_input'];
  final raw = payload['questions'] ?? (input is Map ? input['questions'] : null);
  if (raw is List && raw.isNotEmpty) {
    return [
      for (final q in raw)
        if (q is Map)
          PendingQuestion(
            question: q['question']?.toString() ?? '',
            header: q['header']?.toString(),
            options: _parseOptions(q['options']),
            multiSelect: q['multiSelect'] == true,
          ),
    ];
  }
  final single = (payload['question'] ?? payload['text'])?.toString() ?? '';
  return [PendingQuestion(question: single, options: _parseOptions(payload['options']), multiSelect: payload['multiSelect'] == true)];
}

List<PendingOption> _parseOptions(Object? raw) {
  if (raw is! List) return const [];
  return [
    for (final o in raw)
      if (o is Map && o['label'] != null)
        PendingOption(label: o['label'].toString(), description: o['description']?.toString())
      else if (o is String)
        PendingOption(label: o),
  ];
}

class QuestionCard extends ConsumerStatefulWidget {
  const QuestionCard({super.key, required this.pending});

  final Pending pending;

  @override
  ConsumerState<QuestionCard> createState() => _QuestionCardState();
}

class _QuestionCardState extends ConsumerState<QuestionCard> {
  late final FocusNode _focus = FocusNode(debugLabel: 'questionCard', onKeyEvent: _onKey);
  late final List<PendingQuestion> _questions = parseQuestions(widget.pending.payload);
  late final List<Set<String>> _selected = [for (final _ in _questions) <String>{}];
  late final List<TextEditingController> _free = [for (final _ in _questions) TextEditingController()];
  bool _sent = false;
  String? _error;

  @override
  void dispose() {
    _focus.dispose();
    for (final c in _free) {
      c.dispose();
    }
    super.dispose();
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent e) {
    if (e is KeyDownEvent && e.logicalKey == LogicalKeyboardKey.escape) {
      node.unfocus();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  /// 질문 i 의 답(직접 입력이 있으면 그것, 없으면 선택한 라벨들). 없으면 null.
  String? _answerOf(int i) {
    final free = _free[i].text.trim();
    if (free.isNotEmpty) return free;
    if (_selected[i].isEmpty) return null;
    // 옵션 순서대로 이어 붙인다.
    return _questions[i].options.map((o) => o.label).where(_selected[i].contains).join(', ');
  }

  bool get _allAnswered => List.generate(_questions.length, _answerOf).every((a) => a != null);

  /// 질문 하나·단일 선택이면 옵션을 누르는 즉시 보낸다.
  bool get _immediate => _questions.length == 1 && !_questions.single.multiSelect;

  bool get _canSend => !_sent && ref.read(connectionStateProvider) == RpcConnectionState.connected;

  Future<void> _send() async {
    if (!_canSend || !_allAnswered) return;
    final answers = {for (var i = 0; i < _questions.length; i++) _questions[i].question: _answerOf(i)!};
    setState(() {
      _sent = true;
      _error = null;
    });
    try {
      await ref.read(officeProvider.notifier).respondQuestion(widget.pending.id, answers);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        if (!_isGoneError(e)) _sent = false;
        _error = _describeError(e);
      });
    }
  }

  void _pick(int i, String label) {
    setState(() {
      final q = _questions[i];
      if (q.multiSelect) {
        if (!_selected[i].remove(label)) _selected[i].add(label);
      } else {
        _selected[i]
          ..clear()
          ..add(label);
        _free[i].clear();
      }
    });
    if (_immediate && !_questions[i].multiSelect) _send();
  }

  @override
  Widget build(BuildContext context) {
    final connected = ref.watch(connectionStateProvider) == RpcConnectionState.connected;
    final locked = _sent || !connected;
    final title = _questions.length == 1 ? '❓ 질문' : '❓ 질문 ${_questions.length}개';
    return Listener(
      onPointerDown: (_) {
        if (!_focus.hasFocus) _focus.requestFocus();
      },
      child: Focus(
        focusNode: _focus,
        child: ListenableBuilder(
          listenable: _focus,
          builder: (context, _) => _CardFrame(
            accent: _questionColor,
            title: title,
            focused: _focus.hasPrimaryFocus,
            children: [
              for (var i = 0; i < _questions.length; i++) ...[
                if (i > 0) const Divider(height: 14, color: Colors.white12),
                _questionBlock(i, locked),
              ],
              const SizedBox(height: 8),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  FilledButton(
                    style: _smallButtonStyle(),
                    onPressed: locked || !_allAnswered ? null : _send,
                    child: const Text('확인'),
                  ),
                  if (_sent) const _SentBadge(),
                ],
              ),
              if (!connected && !_sent)
                const Padding(
                  padding: EdgeInsets.only(top: 6),
                  child: Text('데몬 연결 안 됨 — 재접속되면 응답할 수 있습니다', style: TextStyle(fontSize: 11.5, color: Colors.white54)),
                ),
              if (_error != null) _ErrorLine(_error!),
            ],
          ),
        ),
      ),
    );
  }

  Widget _questionBlock(int i, bool locked) {
    final q = _questions[i];
    final header = q.header;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (header != null && header.isNotEmpty)
          Text(header, style: const TextStyle(fontSize: 11, color: Colors.white54, letterSpacing: 0.5)),
        Text(q.question, style: const TextStyle(fontSize: 13, color: Colors.white, height: 1.35)),
        if (q.options.isNotEmpty) ...[
          const SizedBox(height: 6),
          if (q.multiSelect)
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [for (final o in q.options) _checkRow(i, o, locked)],
            )
          else
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [for (final o in q.options) _optionButton(i, o, locked)],
            ),
        ],
        const SizedBox(height: 6),
        TextField(
          key: ValueKey('question-free-$i'),
          controller: _free[i],
          enabled: !locked,
          onChanged: (_) => setState(() {}),
          onSubmitted: (_) => _send(),
          style: const TextStyle(fontSize: 12.5),
          decoration: const InputDecoration(
            isDense: true,
            hintText: '직접 입력',
            contentPadding: EdgeInsets.symmetric(horizontal: 8, vertical: 8),
            border: OutlineInputBorder(),
          ),
        ),
      ],
    );
  }

  Widget _optionButton(int i, PendingOption o, bool locked) {
    final selected = _selected[i].contains(o.label);
    final button = selected
        ? FilledButton.tonal(
            style: _smallButtonStyle(),
            onPressed: locked ? null : () => _pick(i, o.label),
            child: Text(o.label),
          )
        : OutlinedButton(
            style: _smallButtonStyle(),
            onPressed: locked ? null : () => _pick(i, o.label),
            child: Text(o.label),
          );
    final d = o.description;
    return d == null || d.isEmpty ? button : Tooltip(message: d, waitDuration: const Duration(milliseconds: 400), child: button);
  }

  Widget _checkRow(int i, PendingOption o, bool locked) {
    final selected = _selected[i].contains(o.label);
    final d = o.description;
    return InkWell(
      onTap: locked ? null : () => _pick(i, o.label),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Checkbox(
            value: selected,
            visualDensity: VisualDensity.compact,
            materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
            onChanged: locked ? null : (_) => _pick(i, o.label),
          ),
          Flexible(
            child: Tooltip(
              message: d ?? '',
              waitDuration: const Duration(milliseconds: 400),
              child: Text(o.label, style: const TextStyle(fontSize: 12.5)),
            ),
          ),
        ],
      ),
    );
  }
}
