// "재지시 필요" 카드(T18) — 01 §대기 정책 · §데몬 재시작 복구, PROTOCOL "재시작 복구".
//
// 허가/질문이 사용자 답 없이 닫힌 경우 데몬은 `error{summary, pendingId, pendingType}` 를 남긴다:
//   - hook 보류 타임아웃 `hook hold timed out; answer in terminal` / 연결 끊김 `hook connection closed before answer`
//     (D-11: hook 응답은 `{}` 로 나가 CLI 가 자기 TUI 프롬프트를 띄운다 → 터미널에서 직접 답해야 한다)
//   - 데몬 재시작 `재지시 필요: 허가 요청이 재시작으로 만료됨` / `재지시 필요: 질문이 재시작으로 만료됨`
// 상태 층은 그 pending 을 목록에서 지우므로(허가 카드가 내려감) 여기서 흔적을 카드로 남긴다.
//
//  redoNeededProvider(id)   그 멤버의 마지막 `idle` 또는 본문 있는 `text` 이벤트 이후에 온 error{pendingId} 들(pendingId 중복 제거,
//                           오래된 순). 멤버가 새 턴을 끝내면(idle/text) 비워진다. `text{summary:'resumed'}` 는 본문이 없어 세지 않는다
//                           — 재시작 복구는 만료 error → resumed text 순서라 그걸 세면 카드가 뜨자마자 사라진다.
//  redoInstructionProvider(id)  "다시 지시" 가 복사할 원래 지시문: 열린 task(최신) → 로그의 마지막 `[TASK#N from user]` thinking.
//  RedoCards(memberId)      카드 목록(PendingCards 위에 놓는다). 없으면 빈 위젯.
//  RedoCard(event)          "⚠ 재지시 필요" + 사유 + 버튼:
//     터미널에서 답하기 → panelTabRequestProvider.request(terminal)
//     다시 지시         → 원래 지시문을 클립보드로 + 스낵바 "지시문을 복사했어요 — 지시 바에 붙여넣기" (포커스 이동은 범위 밖)

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../state/office_state.dart';
import 'labels.dart';
import 'member_log.dart';
import 'panel_tabs.dart';
import 'report_tab.dart' show parseTaskPrompt;

const Color _redoColor = Colors.deepOrangeAccent;

/// 인박스 안의 만료 카드 — 회색(레이아웃 v2 §3 패스 2 D10).
const Color _expiredColor = Color(0xFF8A93A8);

/// 재지시 필요 흔적(error{pendingId})인가.
bool isRedoEvent(OfficeEvent ev) => ev.kind == OfficeEventKind.error && ev.detail.pendingId != null;

/// 멤버가 새 턴을 끝냈다고 볼 이벤트(이 뒤의 재지시 흔적만 유효).
bool isTurnBoundary(OfficeEvent ev) =>
    ev.kind == OfficeEventKind.idle || (ev.kind == OfficeEventKind.text && (ev.detail.text ?? '').isNotEmpty);

final redoNeededProvider = Provider.family<List<OfficeEvent>, String>((ref, memberId) {
  final log = ref.watch(memberLogProvider(memberId));
  final byPending = <String, OfficeEvent>{};
  for (final ev in log) {
    if (isTurnBoundary(ev)) {
      byPending.clear();
    } else if (isRedoEvent(ev)) {
      byPending[ev.detail.pendingId!] = ev;
    }
  }
  return byPending.values.toList(growable: false);
});

/// 전 멤버의 재지시 흔적(seq 순) — 전역 인박스가 쓴다(T40-4 D10: 만료 카드가 인박스 안으로).
/// 멤버별 [redoNeededProvider] 와 달리 **전역 이벤트 링**만 본다(백필은 선택 멤버 것만 있으므로 섞지 않는다).
final globalRedoNeededProvider = Provider<List<OfficeEvent>>((ref) {
  final byMember = <String, Map<String, OfficeEvent>>{};
  for (final ev in ref.watch(globalEventsProvider)) {
    if (isTurnBoundary(ev)) {
      byMember[ev.memberId]?.clear();
    } else if (isRedoEvent(ev)) {
      (byMember[ev.memberId] ??= <String, OfficeEvent>{})[ev.detail.pendingId!] = ev;
    }
  }
  final out = [for (final m in byMember.values) ...m.values]..sort((a, b) => a.seq.compareTo(b.seq));
  return List<OfficeEvent>.unmodifiable(out);
});

final redoInstructionProvider = Provider.family<String?, String>((ref, memberId) {
  Task? latest;
  for (final t in ref.watch(openTasksProvider).values) {
    if (t.toMember == memberId && (latest == null || t.id > latest.id)) latest = t;
  }
  if (latest != null) return latest.instruction;
  final log = ref.watch(memberLogProvider(memberId));
  for (var i = log.length - 1; i >= 0; i--) {
    final ev = log[i];
    if (ev.kind != OfficeEventKind.thinking) continue;
    final parsed = parseTaskPrompt(ev.detail.text ?? '');
    if (parsed != null) return parsed.instruction;
  }
  return null;
});

/// error summary → 사람이 읽을 사유. 모르는 문구는 그대로.
String describeRedoSummary(String? summary, {String? pendingType}) {
  final s = summary ?? '';
  final what = switch (pendingType) {
    'approval' => '허가 요청',
    'question' => '질문',
    _ => '허가·질문',
  };
  if (s.contains('timed out')) return '$what 보류가 시간 초과로 닫혔어요 — CLI 가 자기 프롬프트를 띄웠으니 터미널에서 직접 답하세요';
  if (s.contains('connection closed')) return '$what 보류가 답하기 전에 끊겼어요 — 터미널에서 직접 답하세요';
  if (s.startsWith('재지시 필요')) return '$s — 데몬이 재시작되며 열려 있던 $what이 사라졌어요. 필요하면 다시 지시하세요';
  return s.isEmpty ? '$what이 답 없이 닫혔어요' : s;
}

/// 한 멤버의 재지시 카드(오래된 순). 없으면 빈 위젯.
class RedoCards extends ConsumerWidget {
  const RedoCards({super.key, required this.memberId});

  final String memberId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final events = ref.watch(redoNeededProvider(memberId));
    if (events.isEmpty) return const SizedBox.shrink();
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [for (final ev in events) RedoCard(key: ValueKey('redo-${ev.detail.pendingId}'), event: ev)],
    );
  }
}

/// 인박스 안에서 쓰는 회색 카드의 제목(D10: "복구로 만료된 허가는 인박스에 회색 만료 — 재지시 카드").
const String redoExpiredTitle = '만료 — 재지시';

class RedoCard extends ConsumerWidget {
  const RedoCard({super.key, required this.event, this.expired = false});

  final OfficeEvent event;

  /// 전역 인박스 안 — 회색 "만료 — 재지시" 카드(D10). 멤버 패널의 주황 "⚠ 재지시 필요" 와 같은 내용이다.
  final bool expired;

  Future<void> _copyInstruction(BuildContext context, WidgetRef ref) async {
    final instruction = ref.read(redoInstructionProvider(event.memberId));
    final messenger = ScaffoldMessenger.maybeOf(context);
    if (instruction == null || instruction.trim().isEmpty) {
      messenger?.showSnackBar(const SnackBar(content: Text('원래 지시문을 찾지 못했어요 — 지시 바에 직접 입력하세요')));
      return;
    }
    await Clipboard.setData(ClipboardData(text: instruction));
    messenger?.showSnackBar(const SnackBar(content: Text('지시문을 복사했어요 — 지시 바에 붙여넣기')));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pendingType = event.detail['pendingType']?.toString();
    final accent = expired ? _expiredColor : _redoColor;
    return Container(
      margin: const EdgeInsets.fromLTRB(8, 8, 8, 4),
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHigh,
        border: Border.all(color: accent.withValues(alpha: 0.7), width: 1.5),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Text(
                expired ? redoExpiredTitle : '⚠ 재지시 필요',
                style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.bold, color: accent),
              ),
              const Spacer(),
              Text(formatClock(event.ts), style: const TextStyle(fontSize: 11, color: Colors.white38)),
            ],
          ),
          const SizedBox(height: 6),
          Text(describeRedoSummary(event.detail.summary, pendingType: pendingType), style: const TextStyle(fontSize: 12.5, color: Colors.white, height: 1.35)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              FilledButton(
                key: ValueKey('redo-terminal-${event.detail.pendingId}'),
                style: _smallButtonStyle(),
                onPressed: () => ref.read(panelTabRequestProvider.notifier).request(RightPanelTab.terminal),
                child: const Text('터미널에서 답하기'),
              ),
              OutlinedButton(
                key: ValueKey('redo-instruct-${event.detail.pendingId}'),
                style: _smallButtonStyle(),
                onPressed: () => _copyInstruction(context, ref),
                child: const Text('다시 지시'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

ButtonStyle _smallButtonStyle() => ButtonStyle(
      visualDensity: VisualDensity.compact,
      padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 10, vertical: 4)),
      minimumSize: const WidgetStatePropertyAll(Size(0, 30)),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      textStyle: const WidgetStatePropertyAll(TextStyle(fontSize: 12.5)),
      shape: WidgetStatePropertyAll(RoundedRectangleBorder(borderRadius: BorderRadius.circular(3))),
    );
