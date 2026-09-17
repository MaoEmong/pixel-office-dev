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
  const MemberReport({required this.seq, required this.ts, this.taskId, this.instruction, this.body, this.summary, this.status});

  /// 보고 시각·정렬 기준(reporting 이벤트, 없으면 text 이벤트)의 seq/ts.
  final int seq;
  final String ts;

  /// null 이면 "보고(작업 없음)".
  final int? taskId;
  final String? instruction;

  /// 전문(text 이벤트). 없으면 [summary] 라도.
  final String? body;
  final String? summary;

  /// 헤더 줄 끝의 상태(`done` 등). `reporting` 이벤트가 안 실어 보내면 task 보고는 `done`, 그 밖은 null.
  final String? status;

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
          status: ev.detail['status']?.toString() ?? (tid == null ? null : 'done'),
        ));
        consumed = true;
      default:
        break;
    }
  }
  flushStandalone();
  return out.reversed.toList(growable: false);
});

// ---- 미확인 배지(이슈 9, 앱 로컬 "읽음") ----------------------------------------------

/// 멤버별 "여기까지 읽었다" seq. 보고서 탭을 열면 그 멤버의 마지막 보고 seq 로 올린다(앱이 사는 동안만).
class ReportReadNotifier extends Notifier<Map<String, int>> {
  @override
  Map<String, int> build() => const {};

  /// 그 멤버의 보고를 전부 읽음 처리. [upTo] 를 주면 그 seq 까지만.
  void markRead(String memberId, {int? upTo}) {
    final seq = upTo ?? _latestReportSeq(ref, memberId);
    if ((state[memberId] ?? 0) >= seq) return;
    state = {...state, memberId: seq};
  }
}

int _latestReportSeq(Ref ref, String memberId) {
  var max = 0;
  for (final e in ref.read(globalEventsProvider)) {
    if (e.memberId == memberId && e.kind == OfficeEventKind.reporting && e.seq > max) max = e.seq;
  }
  return max;
}

final reportReadProvider = NotifierProvider<ReportReadNotifier, Map<String, int>>(ReportReadNotifier.new);

/// 그 멤버의 미확인 보고 수 = 마지막으로 보고서 탭을 연 뒤 도착한 `reporting` 이벤트 수.
/// **전역 이벤트 링만** 본다 — 상단 바("보고 N")가 읽을 때 백필(`events.query`)을 일으키지 않게.
final reportUnreadProvider = Provider.family<int, String>((ref, memberId) {
  final seen = ref.watch(reportReadProvider)[memberId] ?? 0;
  return ref
      .watch(globalEventsProvider)
      .where((e) => e.memberId == memberId && e.kind == OfficeEventKind.reporting && e.seq > seen)
      .length;
});

// ---- 문서 흐름(패스 4 하드리젝션 ①) ---------------------------------------------------

/// 보고 하나의 헤더 줄: `보고 · 부장 · 23:08 · task#12 · done`(11px 회색).
String reportHeaderLine({required String name, required String ts, int? taskId, String? status}) => [
      '보고',
      name,
      formatClock(ts),
      if (taskId != null) 'task#$taskId' else reportNoTaskLabel,
      if (status != null && status.isNotEmpty) status,
    ].join(' · ');

/// task 없이 남은 보고(터미널에서 직접 나눈 턴 등).
const String reportNoTaskLabel = '작업 없음';

/// 본문 클램프 줄 수 + 펼치기 문구. **표시 줄**(원문 줄이 아니라 접혀 그려진 줄) 기준이다(T40d ④).
const int reportBodyClampLines = 6;
const String reportExpandLabel = '펼치기';

/// 본문 가변폭 글자(패스 4 ①: 14px / 행간 1.6). 클램프 계산도 이 크기로 잰다.
const TextStyle reportBodyTextStyle = TextStyle(fontSize: 14, height: 1.6, color: Colors.white70);

/// 본문 고정폭(코드·경로) 글자.
const TextStyle reportMonoTextStyle = TextStyle(
  fontSize: 12.5,
  height: 1.5,
  color: Colors.white70,
  fontFamily: panelMonoFamily,
  fontFamilyFallback: panelMonoFallback,
);

/// `SelectableText`(= `EditableText`)는 커서 자리를 남기느라 준 폭보다 **좁게** 접는다.
/// 그만큼 미리 빼고 재야 잰 줄 수와 그려진 줄 수가 같다(실측: 456 폭에서 8px 넘게 좁다).
const double reportBodyCaretGutter = 24;

/// 본문을 **표시 줄** [maxLines] 까지로 자른다 — 폭 [width] 에서 실제로 그려지는 줄을 센다.
///
/// 원문 줄 수로 자르면 긴 문단 하나가 화면을 다 채운다(T40 남은 것 ④ — 실기 캡처에서 11줄).
/// 자른 자리는 원문의 글자 위치라 `splitReportBody` 가 그대로 이어서 쓴다(고정폭 덩어리 판정 유지).
/// 재는 글자는 가변폭 하나로 통일한다 — 고정폭 줄(12.5/1.5)은 더 낮으므로 결과는 6줄 이하로 안전하다.
({String text, bool clamped}) clampReportBody(
  String body, {
  required double width,
  int maxLines = reportBodyClampLines,
  TextStyle style = reportBodyTextStyle,
}) {
  if (body.isEmpty || width <= 0 || !width.isFinite) return (text: body, clamped: false);
  final measure = (width - reportBodyCaretGutter).clamp(1.0, width);
  final painter = TextPainter(
    text: TextSpan(text: body, style: style),
    textDirection: TextDirection.ltr,
    maxLines: maxLines,
  )..layout(maxWidth: measure);
  if (!painter.didExceedMaxLines) {
    painter.dispose();
    return (text: body, clamped: false);
  }
  // 마지막으로 그려진 줄의 오른쪽 끝 = 잘라야 할 글자 위치.
  final end = painter.getPositionForOffset(Offset(measure, painter.height - 1)).offset;
  painter.dispose();
  final cut = body.substring(0, end.clamp(0, body.length)).trimRight();
  return (text: cut.isEmpty ? body.substring(0, 1) : cut, clamped: true);
}

/// 본문 조각 — 가변폭 문단이거나 고정폭(코드·경로) 덩어리다.
typedef ReportSpan = ({String text, bool mono});

final RegExp _fence = RegExp(r'^\s*```');
final RegExp _pathish = RegExp(r'^\s*[A-Za-z]:[\\/]|^\s*[./~][\w./\\-]+$|^\s{2,}\S');
final RegExp _shellish = RegExp(r'^\s*[\$>#]\s+\S');

/// 한 줄이 코드·경로인가(그 줄만 고정폭으로).
bool isMonoLine(String line) =>
    _shellish.hasMatch(line) || _pathish.hasMatch(line) || (line.contains('\\') && !line.contains(' '));

/// 본문 → 문단/코드 덩어리(연속된 같은 종류를 묶는다). 마크다운 렌더링은 범위 밖(§4) — 코드 펜스는 고정폭 신호로만 쓴다.
List<ReportSpan> splitReportBody(String body) {
  final out = <ReportSpan>[];
  final buf = <String>[];
  bool? mode;
  var inFence = false;
  void flush() {
    if (buf.isEmpty) return;
    out.add((text: buf.join('\n'), mono: mode ?? false));
    buf.clear();
  }

  for (final line in body.split('\n')) {
    if (_fence.hasMatch(line)) {
      flush();
      inFence = !inFence;
      mode = inFence;
      continue;
    }
    final mono = inFence || isMonoLine(line);
    if (mode != null && mono != mode) flush();
    mode = mono;
    buf.add(line);
  }
  flush();
  return List<ReportSpan>.unmodifiable(out);
}

/// 로컬 날짜 구분선용 `2026-09-16`.
String reportDateLabel(String ts) {
  final t = DateTime.tryParse(ts)?.toLocal();
  if (t == null) return ts;
  String two(int n) => n.toString().padLeft(2, '0');
  return '${t.year}-${two(t.month)}-${two(t.day)}';
}

class ReportTab extends ConsumerWidget {
  const ReportTab({super.key, required this.memberId});

  final String memberId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final reports = ref.watch(memberReportsProvider(memberId));
    final backfill = ref.watch(memberBackfillProvider(memberId));
    final name = ref.watch(memberProvider(memberId))?.name ?? memberId;
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
              ? const Center(child: Text('아직 보고 없음 — 부장이 보고하면 여기에', style: TextStyle(color: Colors.white38)))
              : ListView.builder(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  itemCount: reports.length,
                  itemBuilder: (context, i) {
                    // 최신 먼저 — 날짜가 바뀌는 자리에 구분선(D-35 "보고 이력은 부서에 남는다").
                    final day = reportDateLabel(reports[i].ts);
                    final showDate = i == 0 || reportDateLabel(reports[i - 1].ts) != day;
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (showDate)
                          Padding(
                            padding: const EdgeInsets.fromLTRB(12, 10, 12, 2),
                            child: Text(day, style: const TextStyle(fontSize: 10.5, color: Colors.white30)),
                          ),
                        ReportCard(key: ValueKey('report-${reports[i].seq}'), report: reports[i], memberName: name),
                      ],
                    );
                  },
                ),
        ),
      ],
    );
  }
}

/// 보고 하나 — **카드가 아니라 문서 흐름**(패스 4 ①): 헤더 줄 + 본문(가변폭 14px/행간 1.6),
/// 코드·경로만 고정폭, 6줄 클램프 + "펼치기", 보고 사이는 1px 구분선. 테두리 카드 없음.
/// 위젯 이름은 T18 때부터 테스트가 세던 이름을 그대로 둔다(`find.byType(ReportCard)`).
class ReportCard extends StatefulWidget {
  const ReportCard({super.key, required this.report, this.memberName = ''});

  final MemberReport report;
  final String memberName;

  @override
  State<ReportCard> createState() => _ReportCardState();
}

class _ReportCardState extends State<ReportCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final r = widget.report;
    final instruction = r.instruction;
    final body = r.text.isEmpty ? '(본문 없음)' : r.text;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
      decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Colors.white12))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            reportHeaderLine(name: widget.memberName, ts: r.ts, taskId: r.taskId, status: r.status),
            key: ValueKey('report-header-${r.seq}'),
            style: const TextStyle(fontSize: 11, color: Colors.white38),
          ),
          if (instruction != null && instruction.trim().isNotEmpty) ...[
            const SizedBox(height: 5),
            // 지시(`[TASK]`)는 왼쪽 세로선 대신 **배경 틴트** 블록(패스 4 ①).
            Container(
              padding: const EdgeInsets.fromLTRB(8, 5, 8, 5),
              decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.05), borderRadius: BorderRadius.circular(3)),
              child: Text(
                '지시: ${instruction.trim()}',
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12, color: Colors.white60, height: 1.4),
              ),
            ),
          ],
          const SizedBox(height: 6),
          // 클램프는 **표시 줄** 기준이라 본문이 그려질 폭을 알아야 한다(T40d ④).
          LayoutBuilder(
            builder: (context, box) {
              final clamp = clampReportBody(body, width: box.maxWidth);
              final shown = _expanded ? body : clamp.text;
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final span in splitReportBody(shown))
                    SelectableText(span.text, style: span.mono ? reportMonoTextStyle : reportBodyTextStyle),
                  if (clamp.clamped)
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton(
                        key: ValueKey('report-expand-${r.seq}'),
                        style: TextButton.styleFrom(
                          visualDensity: VisualDensity.compact,
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          padding: EdgeInsets.zero,
                          foregroundColor: Colors.white54,
                          textStyle: const TextStyle(fontSize: 12),
                        ),
                        onPressed: () => setState(() => _expanded = !_expanded),
                        child: Text(_expanded ? '접기' : reportExpandLabel),
                      ),
                    ),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}
