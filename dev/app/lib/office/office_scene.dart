// 사무실 장면 모델(순수 Dart). 상태 층의 members/latestEvent/pending 맵을 화면에 필요한 값만 추린 불변 데이터로 바꾼다.
// 페인터·레이아웃은 이 클래스만 보고, 상태 층의 형태 변화는 여기서만 흡수한다.
//
// 요약 규칙(01-설계문서 §3 "캐릭터 상태 3중 표현" 중 모니터·말풍선):
//   status exited → "(퇴근)", error → "⚠ 오류" (이벤트보다 우선)
//   event reading → "📖 <basename>", editing → "✎ <basename>", running → "▶ <cmd 40자>", thinking → "…",
//         idle → "(대기)", waiting_approval → "❗ 허가 대기", asking → "❓ 질문", error → "⚠ 오류",
//         text → "💬 <text>", delegating → "→ 위임", reporting → "📋 보고"
//   이벤트 없음 → status 로: starting "(출근 중)", idle "(대기)", working "…", waiting_* 는 위와 동일.
//   파생 status 가 waiting_reports 면 "📨 보고 대기"(팀장이 위임하고 팀원 보고를 기다리는 중 — M4).
//   파생 status 가 waiting_answer/waiting_approval 이면 이벤트보다 "❓ 질문"/"❗ 허가 대기" 가 앞선다
//   (`ask_user` 는 질문이 열린 채 raw status 가 idle 로 돌아간다 — PROTOCOL `member.status.derived`, T19 함정 1).

import '../model/models.dart';

/// 말풍선 최대 글자 수.
const int bubbleMaxChars = 28;

/// running 요약에 쓰는 명령 최대 글자 수.
const int cmdMaxChars = 40;

/// 책상 배지에 붙는 팀장 표시(T24b).
const String leaderBadgeLabel = '팀장';

/// 파생 상태 `waiting_reports`(팀장이 위임하고 팀원 보고를 기다리는 중 — 01 §3, M4) 의 모니터·말풍선 문구.
const String waitingReportsSummary = '📨 보고 대기';

/// 캐릭터 한 명이 화면에 필요한 값.
class SceneMember {
  const SceneMember({
    required this.id,
    required this.name,
    required this.engine,
    required this.status,
    required this.deskIndex,
    required this.summary,
    required this.isAlert,
    this.rank = MemberRank.member,
    this.queueIndex,
    this.eventKind,
    this.eventSeq,
  });

  final String id;
  final String name;
  final Engine engine;
  final MemberStatus status;

  /// 직급(T24). 팀장은 책상 배지 "팀장" + 캐릭터 금색 링으로 표시한다.
  final MemberRank rank;

  /// 책상 번호(0부터). 라벨은 `책상 ${deskIndex + 1}`.
  final int deskIndex;

  /// 모니터·말풍선 텍스트(말풍선은 [bubbleText] 로 잘라 쓴다).
  final String summary;

  /// alert 말풍선(waiting_approval / asking / reporting, 또는 waiting 상태).
  final bool isAlert;

  /// 내 책상 줄에 서 있으면 그 순서(0부터), 자기 자리면 null.
  final int? queueIndex;

  /// 마지막 이벤트의 kind·seq(없으면 null). T16 이 reporting 방문(새 seq 인지)을 판정하는 데 쓴다.
  final OfficeEventKind? eventKind;
  final int? eventSeq;

  bool get isQueued => queueIndex != null;

  /// 팀장인가(사용자 지시는 팀장에게만 간다 — 01 §4).
  bool get isLeader => rank == MemberRank.leader;

  /// 회색 처리(exited / error).
  bool get isGone => status.isGone;

  /// 이름 첫 글자(빈 이름이면 '?').
  String get initial => name.isEmpty ? '?' : String.fromCharCode(name.runes.first);

  String get engineLabel => switch (engine) {
        Engine.claude => 'Claude',
        Engine.codex => 'Codex',
      };

  String get deskLabel => '책상 ${deskIndex + 1} · $name';

  String get bubbleText => truncate(summary, bubbleMaxChars);

  @override
  bool operator ==(Object other) =>
      other is SceneMember &&
      other.id == id &&
      other.name == name &&
      other.engine == engine &&
      other.status == status &&
      other.rank == rank &&
      other.deskIndex == deskIndex &&
      other.summary == summary &&
      other.isAlert == isAlert &&
      other.queueIndex == queueIndex &&
      other.eventKind == eventKind &&
      other.eventSeq == eventSeq;

  @override
  int get hashCode => Object.hash(id, name, engine, status, rank, deskIndex, summary, isAlert, queueIndex, eventKind, eventSeq);

  @override
  String toString() => 'SceneMember($id $name desk=$deskIndex queue=$queueIndex "$summary")';
}

/// 내 책상 줄의 한 항목.
class QueueEntry {
  const QueueEntry({required this.pendingId, required this.memberId, required this.memberName, required this.label});

  final String pendingId;
  final String memberId;
  final String memberName;

  /// "허가: (명령)" / "질문: (첫 질문)".
  final String label;

  /// 목록 한 줄: "1. 이음 — 허가: rm -rf build/".
  String line(int index) => '${index + 1}. $memberName — $label';

  @override
  bool operator ==(Object other) =>
      other is QueueEntry &&
      other.pendingId == pendingId &&
      other.memberId == memberId &&
      other.memberName == memberName &&
      other.label == label;

  @override
  int get hashCode => Object.hash(pendingId, memberId, memberName, label);
}

/// 사무실 한 장면. 값 비교 가능(페인터 shouldRepaint 용).
class OfficeScene {
  const OfficeScene({required this.members, required this.queue});

  static const OfficeScene empty = OfficeScene(members: [], queue: []);

  /// createdAt 순(책상 순서와 동일).
  final List<SceneMember> members;

  /// 열린 pending, createdAt 순.
  final List<QueueEntry> queue;

  bool get isEmpty => members.isEmpty;

  SceneMember? memberById(String id) {
    for (final m in members) {
      if (m.id == id) return m;
    }
    return null;
  }

  /// 상태 층 맵에서 장면을 만든다. 멤버는 createdAt 순(= 책상 순서).
  /// [teamId] 를 주면 그 팀 멤버(와 그 멤버들의 pending)만, null 이면 전체.
  factory OfficeScene.build({
    required Map<String, Member> members,
    required Map<String, OfficeEvent> latestEvents,
    required Map<String, Pending> pending,
    Map<String, DerivedStatus> derived = const {},
    String? teamId,
  }) {
    if (teamId != null) {
      members = {for (final e in members.entries) if (e.value.teamId == teamId) e.key: e.value};
      pending = {for (final e in pending.entries) if (members.containsKey(e.value.memberId)) e.key: e.value};
    }
    final sorted = members.values.toList(growable: false)..sort(_byCreatedAt);
    final openPending = pending.values.toList(growable: false)..sort(_pendingByCreatedAt);

    // 줄에 서는 기준(T19 함정 1 수정): "열린 pending 이 있다" 또는 "파생 status 가 waiting"(raw 가 `idle` 이어도
    // `ask_user` 질문이 열려 있으면 파생은 `waiting_answer`). raw status 만 보면 `ask_user` 질문자가 줄에 안 선다.
    final withPending = {for (final p in openPending) p.memberId};
    bool isQueuedMember(Member m) =>
        withPending.contains(m.id) || (derived[m.id]?.isWaiting ?? false) || m.status.isWaiting;

    // 줄 순서: pending 생성 순으로 멤버가 처음 나타나는 순서. pending 없이 waiting 인 멤버는 그 뒤에 createdAt 순.
    final queueOrder = <String>[];
    for (final p in openPending) {
      if (!queueOrder.contains(p.memberId) && members.containsKey(p.memberId)) queueOrder.add(p.memberId);
    }
    for (final m in sorted) {
      if (isQueuedMember(m) && !queueOrder.contains(m.id)) queueOrder.add(m.id);
    }
    final queued = <String, int>{};
    for (final id in queueOrder) {
      final m = members[id];
      if (m != null && isQueuedMember(m)) queued[id] = queued.length;
    }

    final sceneMembers = <SceneMember>[
      for (var i = 0; i < sorted.length; i++)
        SceneMember(
          id: sorted[i].id,
          name: sorted[i].name,
          engine: sorted[i].engine,
          status: sorted[i].status,
          rank: sorted[i].rank,
          deskIndex: i,
          summary: summarize(sorted[i].status, latestEvents[sorted[i].id], derived: derived[sorted[i].id]),
          isAlert: isAlertFor(sorted[i].status, latestEvents[sorted[i].id], derived: derived[sorted[i].id]),
          queueIndex: queued[sorted[i].id],
          eventKind: latestEvents[sorted[i].id]?.kind,
          eventSeq: latestEvents[sorted[i].id]?.seq,
        ),
    ];

    final queue = <QueueEntry>[
      for (final p in openPending)
        QueueEntry(
          pendingId: p.id,
          memberId: p.memberId,
          memberName: members[p.memberId]?.name ?? p.memberId,
          label: pendingLabel(p),
        ),
    ];
    return OfficeScene(members: sceneMembers, queue: queue);
  }

  static int _byCreatedAt(Member a, Member b) {
    final c = a.createdAt.compareTo(b.createdAt);
    return c != 0 ? c : a.id.compareTo(b.id);
  }

  static int _pendingByCreatedAt(Pending a, Pending b) {
    final c = a.createdAt.compareTo(b.createdAt);
    return c != 0 ? c : a.id.compareTo(b.id);
  }

  @override
  bool operator ==(Object other) =>
      other is OfficeScene && _listEq(other.members, members) && _listEq(other.queue, queue);

  @override
  int get hashCode => Object.hash(Object.hashAll(members), Object.hashAll(queue));

  static bool _listEq<T>(List<T> a, List<T> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }
}

// ---- 요약 함수 -------------------------------------------------------------------

/// 모니터·말풍선용 한 줄 요약. [derived] 가 `waiting_answer` 면(= `ask_user` 질문이 열린 채 raw 는 `idle`)
/// 마지막 이벤트보다 "❓ 질문" 이 앞선다 — 답을 기다리는 동안 "(대기)" 로 보이지 않게(T19 함정 1).
String summarize(MemberStatus status, OfficeEvent? event, {DerivedStatus? derived}) {
  if (status == MemberStatus.exited) return '(퇴근)';
  if (status == MemberStatus.error) return '⚠ 오류';
  if (derived == DerivedStatus.waitingAnswer) return '❓ 질문';
  if (derived == DerivedStatus.waitingApproval) return '❗ 허가 대기';
  // 팀장이 위임 후 idle 인데 미종료 task 가 남았다 — 마지막 이벤트("(대기)")보다 이게 사실에 가깝다(01 §3, M4).
  if (derived == DerivedStatus.waitingReports) return waitingReportsSummary;
  if (event == null) return _statusSummary(status);
  final d = event.detail;
  return switch (event.kind) {
    OfficeEventKind.reading => '📖 ${d.path != null ? basename(d.path!) : d.oneLine}',
    OfficeEventKind.editing => '✎ ${d.path != null ? basename(d.path!) : d.oneLine}',
    OfficeEventKind.running => '▶ ${truncate(firstLine(d.cmd ?? d.oneLine), cmdMaxChars)}',
    OfficeEventKind.thinking => '…',
    OfficeEventKind.idle => '(대기)',
    OfficeEventKind.waitingApproval => '❗ 허가 대기',
    OfficeEventKind.asking => '❓ 질문',
    OfficeEventKind.error => '⚠ 오류',
    OfficeEventKind.text => d.oneLine.isEmpty ? '💬' : '💬 ${d.oneLine}',
    OfficeEventKind.delegating => '→ 위임',
    OfficeEventKind.reporting => '📋 보고',
  };
}

String _statusSummary(MemberStatus s) => switch (s) {
      MemberStatus.starting => '(출근 중)',
      MemberStatus.idle => '(대기)',
      MemberStatus.working => '…',
      MemberStatus.waitingApproval => '❗ 허가 대기',
      MemberStatus.waitingAnswer => '❓ 질문',
      MemberStatus.exited => '(퇴근)',
      MemberStatus.error => '⚠ 오류',
    };

/// alert 말풍선 여부: 마지막 이벤트가 waiting_approval/asking/reporting 이거나 멤버가 (raw·파생) waiting 상태.
bool isAlertFor(MemberStatus status, OfficeEvent? event, {DerivedStatus? derived}) {
  if (status.isGone) return false;
  if (status.isWaiting) return true;
  if (derived?.isWaiting ?? false) return true;
  return event?.kind.isAlert ?? false;
}

/// 내 책상 목록용 "허가: (명령)" / "질문: (첫 질문)".
String pendingLabel(Pending p) {
  if (p.type == PendingType.approval) {
    final input = p.payload['tool_input'];
    String? arg;
    if (input is Map) arg = (input['command'] ?? input['file_path'] ?? input['path'])?.toString();
    final tool = p.payload['tool_name']?.toString() ?? '';
    final what = firstLine(arg ?? tool);
    return '허가: ${what.isEmpty ? '(도구)' : what}';
  }
  final q = firstLine(p.summary);
  return '질문: ${q.isEmpty ? '(내용 없음)' : q}';
}

/// 경로의 마지막 조각(`/`·`\` 모두).
String basename(String path) {
  final trimmed = path.replaceAll(RegExp(r'[\\/]+$'), '');
  final i = trimmed.lastIndexOf(RegExp(r'[\\/]'));
  return i < 0 ? trimmed : trimmed.substring(i + 1);
}

String firstLine(String s) => s.split('\n').first.trim();

/// 글자 수(rune 기준)로 자르고 넘치면 '…'.
String truncate(String s, int max) {
  final runes = s.runes.toList();
  if (runes.length <= max) return s;
  return '${String.fromCharCodes(runes.take(max - 1))}…';
}
