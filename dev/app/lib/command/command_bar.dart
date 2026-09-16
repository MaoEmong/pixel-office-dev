// 아래 지시 바(T14 → T37 rev 3). 대상은 **선택한 부서의 살아 있는 부장 하나로 고정**된다.
// 여러 줄 입력. Enter = 전송(`member.instruct`), Shift+Enter = 줄바꿈.
// 여러 줄 텍스트는 그대로 개행을 넣어 보낸다 — bracketed paste 처리는 데몬(InputQueue)이 한다.
// "중단" 은 `member.interrupt`(Ctrl+C). 데몬과 끊겼거나 살아 있는 부장이 없으면 비활성.
//
// T37 "부장에게만 지시"(D-32):
//  - 드롭다운에는 **부장 한 명만** 들어간다. 사무실에서 팀장·팀원을 골라도 지시 바는 부장을 가리킨다
//    (팀장에게 일을 시키는 것은 부장의 `delegate` 이지 사용자의 지시가 아니다).
//  - 살아 있는 부장이 없으면 드롭다운이 비활성 + 힌트 [commandBarNoHeadHint].
//  - 그래도 -32004 가 오면(앱 상태가 데몬보다 낡았을 때) 데몬 문구를 그대로 띄우고 `data.headId` 로 대상을 되돌린다.
//    `force` 는 콘솔 전용 디버그 탈출구라 앱에서는 쓰지 않는다(D-34).
// 판정 기준은 데몬 `Store.liveHead` 와 같은 `liveHeadProvider`(state/office_state.dart).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../rpc/rpc_client.dart';
import '../state/office_state.dart';
import '../topbar/selected_department.dart' show activeDepartmentIdProvider;

/// 입력 힌트(대상 이름별). 테스트·문서에서 참조.
String commandBarHint(String targetName) => '$targetName에게 지시 (Enter 전송, Shift+Enter 줄바꿈)';

/// 드롭다운 전체 툴팁 — 지시는 부장에게만 간다.
const String commandBarHeadOnlyTooltip = '지시는 부장에게만 갑니다';

/// 살아 있는 부장이 없을 때의 힌트(부서가 없거나 부장이 퇴근·오류).
const String commandBarNoHeadHint = '이 부서에 살아 있는 부장이 없습니다 — 부서를 만들거나 부장을 다시 고용하세요';

/// 전송 후 "#n 전송됨" 배지를 보여 주는 시간.
const Duration commandBarBadgeDuration = Duration(seconds: 3);

class CommandBar extends ConsumerStatefulWidget {
  const CommandBar({super.key, required this.selectedMemberId});

  /// 사무실/패널에서 고른 멤버. 대상 계산에는 쓰지 않고(대상은 부장 고정) 부서를 추정하는 데만 쓴다.
  final String? selectedMemberId;

  @override
  ConsumerState<CommandBar> createState() => _CommandBarState();
}

class _CommandBarState extends ConsumerState<CommandBar> {
  final TextEditingController _text = TextEditingController();
  late final FocusNode _focus = FocusNode(debugLabel: 'commandBar', onKeyEvent: _onKey);

  bool _busy = false;
  int? _sentTaskId;
  String? _error;

  /// -32004 응답이 알려 준 부장 id(앱 상태가 낡았을 때의 폴백 대상).
  String? _headOverride;
  Timer? _badgeTimer;

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

  // ---- 대상 --------------------------------------------------------------------

  /// 실제 지시가 갈 멤버 = **그 부서의 살아 있는 부장**(D-32).
  /// 고른 멤버가 있으면 그 멤버의 부서를, 없으면 활성 부서를 본다. [override] 는 -32004 가 알려 준 부장 id.
  static Member? resolveTarget({
    required Map<String, Member> members,
    required Map<String, Member> heads,
    required String? chosenMemberId,
    required String? activeDepartmentId,
    String? override,
  }) {
    final byOverride = override == null ? null : members[override];
    if (byOverride != null && !byOverride.status.isGone) return byOverride;
    final chosen = chosenMemberId == null ? null : members[chosenMemberId];
    final departmentId = chosen?.departmentId ?? activeDepartmentId;
    return departmentId == null ? null : heads[departmentId];
  }

  Member? _targetMember() => resolveTarget(
        members: ref.read(membersProvider),
        heads: ref.read(liveHeadsProvider),
        chosenMemberId: widget.selectedMemberId,
        activeDepartmentId: ref.read(activeDepartmentIdProvider),
        override: _headOverride,
      );

  /// -32004 응답의 `data:{headId}`(PROTOCOL `member.instruct`, T34).
  static String? _headIdOf(Object? data) => data is Map ? data['headId'] as String? : null;

  bool _canAct(Member? m) =>
      ref.read(connectionStateProvider) == RpcConnectionState.connected && m != null && !m.status.isGone && !_busy;

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
      if (mounted) {
        setState(() {
          _error = e is RpcException ? e.message : e.toString();
          // -32004 "부장에게만 지시할 수 있습니다 (head: …)" — 앱이 아직 모르는 부장이 있다는 뜻이니 대상을 그리로.
          final headId = e is RpcException && e.code == RpcException.rankRule ? _headIdOf(e.data) : null;
          if (headId != null) _headOverride = headId;
        });
      }
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
    final heads = ref.watch(liveHeadsProvider);
    final targetMember = resolveTarget(
      members: members,
      heads: heads,
      chosenMemberId: widget.selectedMemberId,
      activeDepartmentId: ref.watch(activeDepartmentIdProvider),
      override: _headOverride,
    );
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
            // 대상이 고정된다는 것을 드롭다운 전체 툴팁으로도 말해 준다(01 §직무 체계 rev 3).
            child: Tooltip(
              message: targetMember != null ? commandBarHeadOnlyTooltip : '',
              child: DropdownButtonFormField<String>(
                key: const Key('commandBar.target'),
                initialValue: targetMember?.id,
                isDense: true,
                isExpanded: true,
                hint: Text(
                  targetMember == null ? '부장 없음' : '대상',
                  style: const TextStyle(fontSize: 13),
                ),
                decoration: const InputDecoration(
                  isDense: true,
                  border: OutlineInputBorder(),
                  contentPadding: EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                ),
                items: [
                  if (targetMember != null)
                    DropdownMenuItem<String>(
                      value: targetMember.id,
                      child: _TargetItem(member: targetMember),
                    ),
                ],
                // 고를 것이 하나뿐이라 실제로 바뀌지는 않는다 — 비활성으로 두면 회색이라 "누구에게 가는지" 가
                // 안 보여서(T24b 의 교훈) 값만 고정하고 활성 상태를 유지한다.
                onChanged: targetMember == null ? null : (_) {},
              ),
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
                        ? commandBarNoHeadHint
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
            // 오류는 데몬 문구를 그대로 보여 준다(-32004 "부장에게만 지시할 수 있습니다 (head: …)" 도) — 조금 더 넓게.
            width: _error != null ? 180 : 120,
            child: _error != null
                ? Tooltip(
                    message: _error!,
                    child: Text(
                      _error!,
                      key: const Key('commandBar.error'),
                      style: TextStyle(fontSize: 11, color: scheme.error),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  )
                : _sentTaskId != null
                    ? Text(
                        '#$_sentTaskId 전송됨',
                        key: const Key('commandBar.badge'),
                        style: const TextStyle(fontSize: 12, color: Colors.greenAccent),
                      )
                    : const SizedBox.shrink(),
          ),
        ],
      ),
    );
  }
}

/// 대상 드롭다운 한 줄 — 부장 하나. 퇴근/오류는 "· exited" 처럼 상태를 붙인다.
class _TargetItem extends StatelessWidget {
  const _TargetItem({required this.member});

  final Member member;

  @override
  Widget build(BuildContext context) => Text(
        '${member.name} [${member.engine.wire}]'
        '${member.status.isGone ? ' · ${member.status.wire}' : ''} · ${member.rank.label}',
        style: TextStyle(fontSize: 13, color: member.status.isGone ? Colors.white38 : null),
        overflow: TextOverflow.ellipsis,
      );
}
