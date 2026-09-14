// OfficeEvent — dev/daemon/src/store/types.ts `OfficeEvent`, PROTOCOL "오피스 이벤트".

/// 이벤트 kind 11종. 01-설계문서 §2 표와 동일.
enum OfficeEventKind {
  thinking,
  text,
  reading,
  editing,
  running,
  waitingApproval('waiting_approval'),
  asking,
  delegating,
  reporting,
  idle,
  error;

  const OfficeEventKind([String? wire]) : _wire = wire;
  final String? _wire;
  String get wire => _wire ?? name;

  static OfficeEventKind parse(String s) {
    for (final v in values) {
      if (v.wire == s) return v;
    }
    throw FormatException('unknown event kind: $s');
  }

  /// alert 말풍선(01 §3: waiting_approval / asking / reporting).
  bool get isAlert => this == waitingApproval || this == asking || this == reporting;
}

/// `detail`: `{ tool?, path?, cmd?, summary?, text?, ...자유 확장 }`.
class EventDetail {
  const EventDetail(this.raw);

  final Map<String, dynamic> raw;

  String? get tool => raw['tool'] as String?;
  String? get path => raw['path'] as String?;
  String? get cmd => raw['cmd'] as String?;
  String? get summary => raw['summary'] as String?;
  String? get text => raw['text'] as String?;

  /// 재시작 복구 `error{재지시 필요…}` 가 붙이는 만료 pending id.
  String? get pendingId => raw['pendingId'] as String?;
  int? get exitCode => (raw['exitCode'] as num?)?.toInt();

  dynamic operator [](String key) => raw[key];

  /// 말풍선·로그용 한 줄 요약. 우선순위: summary > cmd > path > text > tool.
  String get oneLine {
    final s = summary ?? cmd ?? path ?? text ?? tool ?? '';
    final first = s.split('\n').first;
    return first.length > 120 ? '${first.substring(0, 120)}…' : first;
  }
}

class EventRef {
  const EventRef({this.approvalId, this.questionId, this.taskId});

  final String? approvalId;
  final String? questionId;
  final int? taskId;

  factory EventRef.fromJson(Map<String, dynamic>? j) {
    if (j == null) return const EventRef();
    return EventRef(
      approvalId: j['approvalId'] as String?,
      questionId: j['questionId'] as String?,
      taskId: (j['taskId'] as num?)?.toInt(),
    );
  }

  /// approval 이나 question 을 가리키면 그 pending id.
  String? get pendingId => approvalId ?? questionId;
}

class OfficeEvent {
  const OfficeEvent({
    required this.seq,
    required this.ts,
    required this.teamId,
    required this.memberId,
    required this.kind,
    required this.detail,
    required this.ref,
  });

  /// 전역 단조 증가(재시작 후에도 되돌아가지 않음).
  final int seq;
  final String ts;
  final String teamId;
  final String memberId;
  final OfficeEventKind kind;
  final EventDetail detail;
  final EventRef ref;

  factory OfficeEvent.fromJson(Map<String, dynamic> j) => OfficeEvent(
        seq: (j['seq'] as num).toInt(),
        ts: j['ts'] as String,
        teamId: j['teamId'] as String,
        memberId: j['memberId'] as String,
        kind: OfficeEventKind.parse(j['kind'] as String),
        detail: EventDetail(Map<String, dynamic>.from((j['detail'] as Map?) ?? const {})),
        ref: EventRef.fromJson((j['ref'] as Map?)?.cast<String, dynamic>()),
      );

  @override
  String toString() => '#$seq ${kind.wire} $memberId ${detail.oneLine}';
}
