// 아래 지시 바(T14). 대상 멤버 선택 + 여러 줄 입력. Enter = 전송(`member.instruct`), Shift+Enter = 줄바꿈.
// 여러 줄 텍스트는 그대로 개행을 넣어 보낸다 — bracketed paste 처리는 데몬(InputQueue)이 한다.
// "중단" 은 `member.interrupt`(Ctrl+C). 데몬과 끊겼거나 대상이 없으면(또는 대상이 exited/error) 비활성.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../rpc/rpc_client.dart';
import '../state/office_state.dart';

/// 입력 힌트(대상 이름별). 테스트·문서에서 참조.
String commandBarHint(String targetName) => '$targetName에게 지시 (Enter 전송, Shift+Enter 줄바꿈)';

/// 전송 후 "#n 전송됨" 배지를 보여 주는 시간.
const Duration commandBarBadgeDuration = Duration(seconds: 3);

class CommandBar extends ConsumerStatefulWidget {
  const CommandBar({super.key, required this.selectedMemberId});

  /// 사무실/패널에서 고른 멤버. 바뀌면 대상 드롭다운이 따라간다(사용자가 드롭다운으로 바꾼 뒤에도).
  final String? selectedMemberId;

  @override
  ConsumerState<CommandBar> createState() => _CommandBarState();
}

class _CommandBarState extends ConsumerState<CommandBar> {
  final TextEditingController _text = TextEditingController();
  late final FocusNode _focus = FocusNode(debugLabel: 'commandBar', onKeyEvent: _onKey);

  String? _target;
  bool _busy = false;
  int? _sentTaskId;
  String? _error;
  Timer? _badgeTimer;

  @override
  void initState() {
    super.initState();
    _target = widget.selectedMemberId;
  }

  @override
  void didUpdateWidget(CommandBar old) {
    super.didUpdateWidget(old);
    if (widget.selectedMemberId != old.selectedMemberId && widget.selectedMemberId != null) {
      _target = widget.selectedMemberId;
    }
  }

  @override
  void dispose() {
    _badgeTimer?.cancel();
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  // ---- 키 처리 ------------------------------------------------------------------

  KeyEventResult _onKey(FocusNode node, KeyEvent e) {
    final isEnter = e.logicalKey == LogicalKeyboardKey.enter || e.logicalKey == LogicalKeyboardKey.numpadEnter;
    if (!isEnter) return KeyEventResult.ignored;
    if (e is KeyUpEvent) return KeyEventResult.handled;
    if (HardwareKeyboard.instance.isShiftPressed) {
      _insertNewline();
      return KeyEventResult.handled;
    }
    if (e is KeyDownEvent) _send(); // 키 반복(KeyRepeatEvent)으로는 보내지 않는다.
    return KeyEventResult.handled; // 기본 개행 삽입 막기
  }

  void _insertNewline() {
    final v = _text.value;
    final sel = v.selection.isValid ? v.selection : TextSelection.collapsed(offset: v.text.length);
    final newText = v.text.replaceRange(sel.start, sel.end, '\n');
    _text.value = TextEditingValue(text: newText, selection: TextSelection.collapsed(offset: sel.start + 1));
  }

  // ---- RPC ------------------------------------------------------------------------

  Member? _targetMember() {
    final id = _target;
    return id == null ? null : ref.read(membersProvider)[id];
  }

  bool _canAct(Member? m) => ref.read(connectionStateProvider) == RpcConnectionState.connected && m != null && !m.status.isGone && !_busy;

  Future<void> _send() async {
    final m = _targetMember();
    final text = _text.text.trim();
    if (text.isEmpty || !_canAct(m)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final taskId = await ref.read(officeProvider.notifier).instruct(m!.id, text);
      _text.clear();
      _badgeTimer?.cancel();
      _badgeTimer = Timer(commandBarBadgeDuration, () {
        if (mounted) setState(() => _sentTaskId = null);
      });
      if (mounted) setState(() => _sentTaskId = taskId);
    } catch (e) {
      if (mounted) setState(() => _error = e is RpcException ? e.message : e.toString());
    } finally {
      if (mounted) {
        setState(() => _busy = false);
        _focus.requestFocus();
      }
    }
  }

  Future<void> _interrupt() async {
    final m = _targetMember();
    if (!_canAct(m)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(rpcClientProvider).call('member.interrupt', {'memberId': m!.id});
    } catch (e) {
      if (mounted) setState(() => _error = e is RpcException ? e.message : e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // ---- UI --------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final connected = ref.watch(connectionStateProvider) == RpcConnectionState.connected;
    final members = ref.watch(membersProvider);
    final sorted = members.values.toList()..sort((a, b) => a.name.compareTo(b.name));
    final target = members.containsKey(_target) ? _target : null;
    final targetMember = target == null ? null : members[target];
    final enabled = connected && targetMember != null && !targetMember.status.isGone && !_busy;
    final scheme = Theme.of(context).colorScheme;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      color: scheme.surfaceContainerHigh,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          SizedBox(
            width: 180,
            child: DropdownButtonFormField<String>(
              key: const Key('commandBar.target'),
              initialValue: target,
              isDense: true,
              isExpanded: true,
              hint: Text(members.isEmpty ? '멤버 없음' : '대상', style: const TextStyle(fontSize: 13)),
              decoration: const InputDecoration(isDense: true, border: OutlineInputBorder(), contentPadding: EdgeInsets.symmetric(horizontal: 8, vertical: 8)),
              items: [
                for (final m in sorted)
                  DropdownMenuItem<String>(
                    value: m.id,
                    enabled: !m.status.isGone,
                    child: Text(
                      '${m.name} [${m.engine.wire}]${m.status.isGone ? ' · ${m.status.wire}' : ''}',
                      style: TextStyle(fontSize: 13, color: m.status.isGone ? Colors.white38 : null),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
              onChanged: members.isEmpty ? null : (id) => setState(() => _target = id),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              key: const Key('commandBar.input'),
              controller: _text,
              focusNode: _focus,
              enabled: enabled,
              minLines: 1,
              maxLines: 4,
              keyboardType: TextInputType.multiline,
              textInputAction: TextInputAction.newline,
              style: const TextStyle(fontSize: 13),
              decoration: InputDecoration(
                isDense: true,
                border: const OutlineInputBorder(),
                hintText: !connected
                    ? '데몬 연결 안 됨'
                    : targetMember == null
                        ? '대상을 고르세요'
                        : targetMember.status.isGone
                            ? '${targetMember.name} 은(는) 퇴근했습니다'
                            : commandBarHint(targetMember.name),
                hintStyle: const TextStyle(fontSize: 13, color: Colors.white38),
              ),
            ),
          ),
          const SizedBox(width: 8),
          OutlinedButton(
            key: const Key('commandBar.interrupt'),
            onPressed: enabled ? _interrupt : null,
            style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact),
            child: const Text('중단'),
          ),
          const SizedBox(width: 4),
          IconButton(
            key: const Key('commandBar.send'),
            tooltip: '전송 (Enter)',
            onPressed: enabled ? _send : null,
            icon: const Icon(Icons.send, size: 20),
          ),
          SizedBox(
            width: 120,
            child: _error != null
                ? Text(_error!, key: const Key('commandBar.error'), style: TextStyle(fontSize: 11, color: scheme.error), maxLines: 2, overflow: TextOverflow.ellipsis)
                : _sentTaskId != null
                    ? Text('#$_sentTaskId 전송됨', key: const Key('commandBar.badge'), style: const TextStyle(fontSize: 12, color: Colors.greenAccent))
                    : const SizedBox.shrink(),
          ),
        ],
      ),
    );
  }
}
