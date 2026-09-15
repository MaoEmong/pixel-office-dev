// 보고서 탭(T18) — v1a 보고 = Stop 의 마지막 assistant 메시지(01 §TeamTools "사용자 지시도 task").
//
// 스냅샷 `tasks` 에는 queued|assigned 만 오므로 보고된 task 는 이벤트에서 되살린다(`memberLogProvider` = 백필 ∪ 라이브,
// 재접속해도 남는다). 데몬은 Stop 때 `text{text}` → `idle` → (assigned task 마다) `reporting{summary}` ref `{taskId}` 순서로
// 이벤트를 쓰므로(Office.afterOfficeEvent), `reporting` 직전의 `text` 가 그 보고의 전문이다.
//
//  taskInstructionsProvider(id)  task id → 지시문. `openTasksProvider`(아직 열린 것) ∪ `thinking{text:'[TASK#N from user]\n…'}`
//                                이벤트(UserPromptSubmit, 200자 절단 — 보고된 뒤에도 남는 유일한 출처).
//  memberReportsProvider(id)     MemberReport 목록, 최신 먼저.
//     - reporting(ref.taskId) + 직전 text        → task#N 보고(본문 = text.text, 없으면 reporting.summary)
//     - 어떤 reporting 에도 쓰이지 않은 text     → "보고(작업 없음)" (터미널에서 직접 대화한 턴 등)
//     - `text{summary:'resumed'}` 처럼 본문이 없는 text 는 제외.
//  ReportTab(memberId)           카드 목록: `task#N · HH:MM · #seq` / 지시문 / 본문(선택 가능, 고정폭, 최대 높이 안에서 스크롤).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../model/models.dart';
import '../state/office_state.dart';
import 'labels.dart';
import 'member_log.dart';

/// 보고 본문 박스의 최대 높이(넘치면 박스 안에서 스크롤).
const double reportBodyMaxHeight = 260;

final RegExp _taskPrompt = RegExp(r'^\[TASK#(\d+) from ([^\]]*)\]\r?\n?');

/// `[TASK#N from user]\n<지시>` → (taskId, from, 지시). 그 형식이 아니면 null.
({int taskId, String from, String instruction})? parseTaskPrompt(String text) {
  final m = _taskPrompt.firstMatch(text);
  if (m == null) return null;
  return (taskId: int.parse(m.group(1)!), from: m.group(2)!, instruction: text.substring(m.end));
}

/// task id → 지시문. 열린 task(전문) 가 이벤트(200자 절단)보다 우선.
final taskInstructionsProvider = Provider.family<Map<int, String>, String>((ref, memberId) {
  final out = <int, String>{};
  for (final ev in ref.watch(memberLogProvider(memberId))) {
    if (ev.kind != OfficeEventKind.thinking) continue;
    final parsed = parseTaskPrompt(ev.detail.text ?? '');
    if (parsed != null) out[parsed.taskId] = parsed.instruction;
  }
  for (final t in ref.watch(openTasksProvider).values) {
    if (t.toMember == memberId) out[t.id] = t.instruction;
  }
  return out;
});

class MemberReport {
  const MemberReport({required this.seq, required this.ts, this.taskId, this.instruction, this.body, this.summary});

  /// 보고 시각·정렬 기준(reporting 이벤트, 없으면 text 이벤트)의 seq/ts.
  final int seq;
  final String ts;

  /// null 이면 "보고(작업 없음)".
  final int? taskId;
  final String? instruction;

  /// 전문(text 이벤트). 없으면 [summary] 라도.
  final String? body;
  final String? summary;

  String get title => taskId == null ? '보고(작업 없음)' : 'task#$taskId';
  String get text => (body != null && body!.isNotEmpty) ? body! : (summary ?? '');
}

/// 최신 먼저.
final memberReportsProvider = Provider.family<List<MemberReport>, String>((ref, memberId) {
  final log = ref.watch(memberLogProvider(memberId));
  final instructions = ref.watch(taskInstructionsProvider(memberId));
  final out = <MemberReport>[];
  OfficeEvent? pendingText; // 아직 어떤 reporting 에도 붙지 않은 마지막 text
  var consumed = false;
  void flushStandalone() {
    final t = pendingText;
    if (t != null && !consumed) out.add(MemberReport(seq: t.seq, ts: t.ts, body: t.detail.text));
  }

  for (final ev in log) {
    switch (ev.kind) {
      case OfficeEventKind.text:
        if ((ev.detail.text ?? '').isEmpty) continue; // resumed 등 본문 없는 text
        flushStandalone();
        pendingText = ev;
        consumed = false;
      case OfficeEventKind.reporting:
        final tid = ev.ref.taskId;
        out.add(MemberReport(
          seq: ev.seq,
          ts: ev.ts,
          taskId: tid,
          instruction: tid == null ? null : instructions[tid],
          body: pendingText?.detail.text,
          summary: ev.detail.summary,
        ));
        consumed = true;
      default:
        break;
    }
  }
  flushStandalone();
  return out.reversed.toList(growable: false);
});

class ReportTab extends ConsumerWidget {
  const ReportTab({super.key, required this.memberId});

  final String memberId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final reports = ref.watch(memberReportsProvider(memberId));
    final backfill = ref.watch(memberBackfillProvider(memberId));
    return Column(
      children: [
        if (backfill.loading || backfill.error != null)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            color: backfill.error != null ? Colors.red.withValues(alpha: 0.15) : Colors.white10,
            child: Text(
              backfill.error != null ? '과거 이벤트 조회 실패: ${backfill.error}' : '과거 이벤트 불러오는 중…',
              style: const TextStyle(fontSize: 11, color: Colors.white70),
            ),
          ),
        Expanded(
          child: reports.isEmpty
              ? const Center(child: Text('아직 보고 없음', style: TextStyle(color: Colors.white38)))
              : ListView.builder(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  itemCount: reports.length,
                  itemBuilder: (context, i) => ReportCard(key: ValueKey('report-${reports[i].seq}'), report: reports[i]),
                ),
        ),
      ],
    );
  }
}

/// 보고 하나. 테스트에서 `find.byType(ReportCard)` 로 센다.
class ReportCard extends StatelessWidget {
  const ReportCard({super.key, required this.report});

  final MemberReport report;

  @override
  Widget build(BuildContext context) {
    final r = report;
    final instruction = r.instruction;
    return Container(
      margin: const EdgeInsets.fromLTRB(8, 4, 8, 4),
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHigh,
        border: Border.all(color: r.taskId == null ? Colors.white12 : Colors.greenAccent.withValues(alpha: 0.5)),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Text(
                r.title,
                style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.bold, color: r.taskId == null ? Colors.white54 : Colors.greenAccent),
              ),
              Text(' · ${formatClock(r.ts)} · #${r.seq}', style: const TextStyle(fontSize: 11, color: Colors.white38)),
            ],
          ),
          if (instruction != null && instruction.trim().isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              '지시: ${instruction.trim()}',
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12, color: Colors.white70, height: 1.3),
            ),
          ],
          const SizedBox(height: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: reportBodyMaxHeight),
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              decoration: BoxDecoration(
                color: Colors.black26,
                border: Border.all(color: Colors.white12),
                borderRadius: BorderRadius.circular(3),
              ),
              child: SingleChildScrollView(
                child: SelectableText(
                  r.text.isEmpty ? '(본문 없음)' : r.text,
                  style: const TextStyle(fontSize: 12.5, height: 1.4, color: Colors.white70, fontFamily: panelMonoFamily, fontFamilyFallback: panelMonoFallback),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
