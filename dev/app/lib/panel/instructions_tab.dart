// 지시문 탭(T26) — 설계 01 §3 "지시문" 탭 · 전제 7 "멤버마다 자기 지시문이 있다",
// PROTOCOL `member.instructions.get/set` · `member.restart`.
//
//  InstructionsTab(memberId)   그 멤버의 INSTRUCTIONS.md 편집기.
//     - 탭이 보이면(= 위젯이 만들어지고 데몬에 연결되면) 아직 못 불러온 경우에만
//       `member.instructions.get{memberId}` → `{markdown}`.
//     - 편집기는 탭을 오가도 살아 있다(TabBarView 가 숨은 탭을 내리므로 컨트롤러를 `instructionsCacheProvider` 에 둔다 —
//       터미널 탭의 `terminalCacheProvider` 와 같은 이유. 쓰던 초안이 탭 전환으로 날아가지 않는다).
//     - 저장 (다음 세션부터) → `member.instructions.set{memberId, markdown}`. 데몬은 다음 SessionStart 부터 주입한다.
//     - 저장하고 지금 재시작 → 확인 다이얼로그("진행 중인 작업이 있으면 중단됩니다") → set → `member.restart{memberId}`
//       (`--resume` 재스폰 + 큐에 `[RESUMED] …`).
//     - 되돌리기 → 마지막으로 불러오거나 저장한 내용으로 되돌린다.
//     - 비어 있으면 "기본 템플릿 넣기" — `Member.rank` 로 팀장/팀원 템플릿을 고른다.
//
//  instructionTemplate(rank)   기본 템플릿(팀장 = 오케스트레이션 규칙, 팀원 = 역할 규칙).
//  instructionsCacheProvider   멤버별 편집 초안(TextEditingController + 저장돼 있다고 아는 값).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../rpc/rpc_client.dart';
import '../state/office_state.dart';
import 'labels.dart';

/// 편집기 위에 늘 보이는 안내(설계 01 §멤버 지시문 주입 · 8-2 "문서 편집기에 경고 문구").
const String instructionsHint =
    '이 문서는 세션 시작·재개·/clear 때마다 이 멤버에게 주입됩니다. 프로젝트의 CLAUDE.md/AGENTS.md는 건드리지 않습니다.';

/// 팀장(오케스트레이터) 기본 템플릿 — 설계 01 §팀 규칙 "팀장 = 오케스트레이터".
const String leaderInstructionTemplate = r'''# 팀장 지시문
너는 이 팀의 팀장(오케스트레이터)이다. 사용자의 [TASK#n from user] 지시를 받으면:
1. 작업을 팀원 단위로 쪼갠다. 필요한 팀원이 없으면 team MCP의 hire(name, role, engine?, instructions?)로 만든다.
2. delegate(to_member, task)로 배정한다. 팀원마다 겹치지 않는 디렉토리/파일을 맡기고, 빌드·테스트 명령은 한 번에 한 명만.
3. 보고는 [REPORTS ...] 메시지로 온다. [ALL_REPORTS_IN]이 오면 취합해 report(taskId, summary, status)로 사용자에게 보고한다.
4. 일이 끝난 팀원은 dismiss(memberId)로 정리한다. 팀원 상한은 팀 설정을 따른다.
5. 사용자에게 물어볼 것은 ask_user(question, options?)로. 답은 [ANSWER q#n] 메시지로 온다.
도구 이름: mcp__team__hire, mcp__team__dismiss, mcp__team__delegate, mcp__team__report, mcp__team__ask_user (도구 목록에 없으면 ToolSearch로 찾는다).
''';

/// 팀원 기본 템플릿.
const String memberInstructionTemplate = r'''# 팀원 지시문
너는 이 팀의 팀원이다. [TASK#n from <팀장>] 지시를 받으면 그 범위만 작업한다.
- 맡은 디렉토리/파일 밖은 건드리지 않는다. 빌드·테스트는 지시받은 경우에만.
- 끝나면 report(taskId, summary, status: done|blocked)로 팀장에게 보고한다. 막히면 status: blocked로 이유를 적는다.
- 사용자에게 직접 물어야 하면 ask_user(question, options?)를 쓴다.
도구 이름: mcp__team__report, mcp__team__ask_user (도구 목록에 없으면 ToolSearch로 찾는다).
''';

/// 부장(head) 기본 템플릿 — 01 §직무 체계 rev 3. 부장은 팀을 만들고 팀장에게만 일을 준다.
const String headInstructionTemplate = r'''# 부장 지시문
너는 이 부서의 부장이다. 사용자의 [TASK#n from user] 지시를 받으면:
1. 일을 팀 단위로 쪼갠다. 필요한 팀이 없으면 team MCP의 create_team(name, leadName, engine?, instructions?)으로 만든다.
2. delegate(to_member=팀장, task)로 팀장에게만 배정한다. 팀원은 팀장이 직접 고용한다 — 네가 팀원을 만들지 않는다.
3. 팀장의 보고는 [REPORTS ...] 메시지로 온다. [ALL_REPORTS_IN]이 오면 취합해 report(taskId, summary, status)로 사용자에게 보고한다.
4. 팀장이 [QUESTION from ...]으로 물으면 reply(to_member, text)로 답한다. 네가 판단할 수 없는 "진짜 중요한 문제"만 ask_user로 사용자에게 올린다.
5. 끝난 팀은 dismiss_team(teamId)로 정리한다.
도구 이름: mcp__team__create_team, mcp__team__dismiss_team, mcp__team__delegate, mcp__team__reply, mcp__team__report, mcp__team__ask_user (도구 목록에 없으면 ToolSearch로 찾는다).
''';

/// 직급별 기본 템플릿. 직급을 모르면(멤버 행이 없으면) 팀원 것.
String instructionTemplate(MemberRank? rank) => switch (rank) {
      MemberRank.head => headInstructionTemplate,
      MemberRank.lead => leaderInstructionTemplate,
      _ => memberInstructionTemplate,
    };

// ---- 초안 캐시 ----------------------------------------------------------------------

/// 한 멤버의 편집 상태. 탭을 오가도 유지된다.
class InstructionsDraft {
  InstructionsDraft(this.memberId);

  final String memberId;
  final TextEditingController controller = TextEditingController();

  /// 데몬에 들어 있다고 아는 내용(불러온 값 · 마지막으로 저장한 값). 아직 못 불러왔으면 null.
  String? saved;

  bool get loaded => saved != null;

  /// 저장할 것이 남아 있는가.
  bool get dirty => saved != null && controller.text != saved;

  /// 불러오거나 저장한 직후 — 편집기와 기준값을 맞춘다.
  void adopt(String markdown, {bool setText = true}) {
    saved = markdown;
    if (setText && controller.text != markdown) controller.text = markdown;
  }

  void dispose() => controller.dispose();
}

/// 멤버별 [InstructionsDraft] 보관. `of(memberId)` 는 같은 멤버엔 항상 같은 인스턴스를 준다.
class InstructionsCache {
  final Map<String, InstructionsDraft> _byMember = {};

  InstructionsDraft of(String memberId) => _byMember.putIfAbsent(memberId, () => InstructionsDraft(memberId));

  void remove(String memberId) => _byMember.remove(memberId)?.dispose();

  void dispose() {
    for (final d in _byMember.values) {
      d.dispose();
    }
    _byMember.clear();
  }
}

final instructionsCacheProvider = Provider<InstructionsCache>((ref) {
  final cache = InstructionsCache();
  ref.onDispose(cache.dispose);
  return cache;
});

// ---- 탭 ----------------------------------------------------------------------------

const TextStyle _editorStyle = TextStyle(
  fontSize: 12.5,
  height: 1.4,
  color: Colors.white,
  fontFamily: panelMonoFamily,
  fontFamilyFallback: panelMonoFallback,
);

class InstructionsTab extends ConsumerStatefulWidget {
  const InstructionsTab({super.key, required this.memberId});

  final String memberId;

  @override
  ConsumerState<InstructionsTab> createState() => _InstructionsTabState();
}

class _InstructionsTabState extends ConsumerState<InstructionsTab> {
  late InstructionsDraft _draft;
  ProviderSubscription<RpcConnectionState>? _connSub;

  /// 진행 중인 작업 — 버튼을 잠그고 무엇을 하는지 보여 준다.
  String? _busy;
  String? _error;
  String? _status;

  @override
  void initState() {
    super.initState();
    _draft = ref.read(instructionsCacheProvider).of(widget.memberId);
    _draft.controller.addListener(_onEdit);
    // 연결되기 전의 call 은 즉시 `not connected` 로 실패한다 — 연결될 때(그리고 재접속될 때) 다시 불러온다.
    _connSub = ref.listenManual<RpcConnectionState>(connectionStateProvider, (prev, next) {
      if (next == RpcConnectionState.connected && prev != RpcConnectionState.connected) _maybeLoad();
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybeLoad());
  }

  @override
  void didUpdateWidget(InstructionsTab old) {
    super.didUpdateWidget(old);
    if (old.memberId == widget.memberId) return;
    _draft.controller.removeListener(_onEdit);
    _draft = ref.read(instructionsCacheProvider).of(widget.memberId);
    _draft.controller.addListener(_onEdit);
    _error = null;
    _status = null;
    _busy = null;
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybeLoad());
  }

  @override
  void dispose() {
    _connSub?.close();
    _draft.controller.removeListener(_onEdit);
    super.dispose();
  }

  /// 아직 못 불러왔고, 연결돼 있고, 다른 일을 하고 있지 않으면 불러온다.
  void _maybeLoad() {
    if (!mounted || _draft.loaded || _busy != null) return;
    if (ref.read(connectionStateProvider) != RpcConnectionState.connected) return;
    _load();
  }

  /// 편집 → 저장 버튼 활성/비활성(dirty) 과 "기본 템플릿 넣기" 노출이 바뀐다.
  void _onEdit() {
    if (mounted) setState(() => _status = null);
  }

  Future<void> _load() async {
    final id = widget.memberId;
    setState(() {
      _busy = '불러오는 중…';
      _error = null;
    });
    try {
      final r = await ref.read(rpcClientProvider).call('member.instructions.get', {'memberId': id});
      if (!mounted || widget.memberId != id) return;
      final markdown = (r['markdown'] as String?) ?? '';
      setState(() {
        // 불러오는 사이에 사용자가 쳐 넣은 것이 있으면 덮어쓰지 않는다(기준값만 맞춘다).
        _draft.adopt(markdown, setText: _draft.controller.text.isEmpty);
        _busy = null;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = null;
          _error = '지시문을 불러오지 못했어요: ${describeRpcError(e)}';
        });
      }
    }
  }

  /// set → (restart) 공통 경로. 성공하면 기준값을 맞추고 안내를 남긴다.
  Future<void> _save({required bool restart}) async {
    if (_busy != null) return;
    final id = widget.memberId;
    final markdown = _draft.controller.text;
    setState(() {
      _busy = restart ? '저장하고 재시작하는 중…' : '저장하는 중…';
      _error = null;
      _status = null;
    });
    try {
      final client = ref.read(rpcClientProvider);
      await client.call('member.instructions.set', {'memberId': id, 'markdown': markdown});
      if (!mounted || widget.memberId != id) return;
      setState(() => _draft.adopt(markdown, setText: false));
      if (restart) {
        await client.call('member.restart', {'memberId': id});
        if (!mounted || widget.memberId != id) return;
        setState(() => _status = '저장하고 재시작했어요 — 새 세션부터 이 지시문이 적용됩니다');
      } else {
        setState(() => _status = '저장했어요 — 다음 세션부터 반영됩니다');
      }
    } catch (e) {
      if (mounted) setState(() => _error = '${restart ? '저장·재시작' : '저장'} 실패: ${describeRpcError(e)}');
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _saveAndRestart() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        key: const Key('panel.instructions.restartDialog'),
        title: const Text('지금 재시작할까요?', style: TextStyle(fontSize: 15)),
        content: const Text(
          '진행 중인 작업이 있으면 중단됩니다. 지시문을 저장하고 이 멤버를 같은 세션으로 다시 띄웁니다.',
          style: TextStyle(fontSize: 13),
        ),
        actions: [
          TextButton(
            key: const Key('panel.instructions.restartCancel'),
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('취소'),
          ),
          FilledButton(
            key: const Key('panel.instructions.restartConfirm'),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('저장하고 재시작'),
          ),
        ],
      ),
    );
    if (ok == true) await _save(restart: true);
  }

  void _revert() {
    final saved = _draft.saved;
    if (saved == null) return;
    setState(() {
      _draft.controller.text = saved;
      _status = null;
      _error = null;
    });
  }

  void _insertTemplate(MemberRank? rank) {
    setState(() {
      _draft.controller.text = instructionTemplate(rank);
      _status = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final connected = ref.watch(connectionStateProvider) == RpcConnectionState.connected;
    final rank = ref.watch(memberProvider(widget.memberId))?.rank;
    final busy = _busy != null;
    final dirty = _draft.dirty;
    final canEdit = _draft.loaded;
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            instructionsHint,
            key: const Key('panel.instructions.hint'),
            style: const TextStyle(fontSize: 11, color: Colors.white54, height: 1.3),
          ),
          const SizedBox(height: 6),
          Expanded(
            child: Stack(
              children: [
                Positioned.fill(
                  child: TextField(
                    key: const Key('panel.instructions.editor'),
                    controller: _draft.controller,
                    enabled: canEdit && !busy,
                    maxLines: null,
                    expands: true,
                    textAlignVertical: TextAlignVertical.top,
                    style: _editorStyle,
                    decoration: const InputDecoration(
                      isDense: true,
                      filled: true,
                      fillColor: Color(0xFF16161A),
                      hintText: '이 멤버에게만 적용할 지시문(마크다운)',
                      hintStyle: TextStyle(fontSize: 12, color: Colors.white24),
                      contentPadding: EdgeInsets.all(8),
                      border: OutlineInputBorder(borderSide: BorderSide(color: Colors.white24)),
                      enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: Colors.white24)),
                    ),
                  ),
                ),
                if (canEdit && _draft.controller.text.isEmpty)
                  Positioned(
                    right: 8,
                    bottom: 8,
                    child: FilledButton.tonal(
                      key: const Key('panel.instructions.template'),
                      style: _buttonStyle,
                      onPressed: busy ? null : () => _insertTemplate(rank),
                      child: const Text('기본 템플릿 넣기'),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 6,
            runSpacing: 4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              FilledButton(
                key: const Key('panel.instructions.save'),
                style: _buttonStyle,
                onPressed: connected && dirty && !busy ? () => _save(restart: false) : null,
                child: const Text('저장 (다음 세션부터)'),
              ),
              FilledButton.tonal(
                key: const Key('panel.instructions.saveRestart'),
                style: _buttonStyle,
                onPressed: connected && canEdit && !busy ? _saveAndRestart : null,
                child: const Text('저장하고 지금 재시작'),
              ),
              TextButton(
                key: const Key('panel.instructions.revert'),
                style: _buttonStyle,
                onPressed: dirty && !busy ? _revert : null,
                child: const Text('되돌리기'),
              ),
              if (busy) ...[
                const SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.5, color: Colors.white54)),
                Text(_busy!, style: const TextStyle(fontSize: 11, color: Colors.white54)),
              ] else if (dirty)
                const Text('저장 안 됨', key: Key('panel.instructions.dirty'), style: TextStyle(fontSize: 11, color: Colors.amber)),
            ],
          ),
          if (!connected)
            const Padding(
              padding: EdgeInsets.only(top: 4),
              child: Text('데몬 연결 안 됨 — 재접속되면 저장할 수 있습니다', style: TextStyle(fontSize: 11, color: Colors.white54)),
            ),
          if (_status != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                _status!,
                key: const Key('panel.instructions.status'),
                style: const TextStyle(fontSize: 11, color: Colors.greenAccent),
              ),
            ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      _error!,
                      key: const Key('panel.instructions.error'),
                      style: const TextStyle(fontSize: 11, color: Colors.redAccent),
                    ),
                  ),
                  if (!_draft.loaded)
                    TextButton(
                      key: const Key('panel.instructions.retry'),
                      style: _buttonStyle,
                      onPressed: busy ? null : _load,
                      child: const Text('다시 시도'),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// RPC 오류를 한 줄로. `RpcException` 이면 message(+ 상태 오류가 아닌 코드).
String describeRpcError(Object e) =>
    e is RpcException ? (e.code == RpcException.badState ? e.message : '${e.message} (${e.code})') : '$e';

final ButtonStyle _buttonStyle = ButtonStyle(
  visualDensity: VisualDensity.compact,
  padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 10, vertical: 2)),
  minimumSize: const WidgetStatePropertyAll(Size(0, 28)),
  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
  textStyle: const WidgetStatePropertyAll(TextStyle(fontSize: 12)),
  shape: WidgetStatePropertyAll(RoundedRectangleBorder(borderRadius: BorderRadius.circular(3))),
);
