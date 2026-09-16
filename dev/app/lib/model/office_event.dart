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

/// TeamTools MCP 도구 이름 접두사(`mcp__team__report` …).
const String teamToolPrefix = 'mcp__team__';

/// `detail`: `{ tool?, path?, cmd?, summary?, text?, waiting?, ...자유 확장 }`.
class EventDetail {
  const EventDetail(this.raw);

  final Map<String, dynamic> raw;

  String? get tool => raw['tool'] as String?;
  String? get path => raw['path'] as String?;
  String? get cmd => raw['cmd'] as String?;
  String? get summary => raw['summary'] as String?;
  String? get text => raw['text'] as String?;

  /// 무엇을 기다리는지(지금은 `'shell-lock'` 하나 — 데몬 `Office.noticeShellWait`). 값이 있으면
  /// `running` 이벤트여도 **아직 실행이 시작되지 않았다** — 말풍선·모니터는 `cmd` 가 아니라 [summary] 를 써야 한다
  /// (T29 결함 ③ / T37). `holder` 는 락을 쥔 멤버 id.
  String? get waiting => raw['waiting'] as String?;
  String? get holder => raw['holder'] as String?;

  /// MCP 팀 도구 호출인가(`mcp__team__report` 등). 보고 방문을 취소하면 안 되는 이벤트다(T29 결함 ④ / T37).
  bool get isTeamTool => (tool ?? '').startsWith(teamToolPrefix);

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
    required this.departmentId,
    required this.teamId,
    required this.memberId,
    required this.kind,
    required this.detail,
    required this.ref,
  });

  /// 전역 단조 증가(재시작 후에도 되돌아가지 않음).
  final int seq;
  final String ts;

  /// 이벤트를 낸 멤버의 부서(T34).
  final String departmentId;

  /// 그 멤버의 팀. **팀 없는 부장의 이벤트는 `''`**(PROTOCOL "오피스 이벤트").
  final String teamId;
  final String memberId;
  final OfficeEventKind kind;
  final EventDetail detail;
  final EventRef ref;

  factory OfficeEvent.fromJson(Map<String, dynamic> j) => OfficeEvent(
        seq: (j['seq'] as num).toInt(),
        ts: j['ts'] as String,
        departmentId: j['departmentId'] as String? ?? '',
        teamId: j['teamId'] as String? ?? '',
        memberId: j['memberId'] as String,
        kind: OfficeEventKind.parse(j['kind'] as String),
        detail: EventDetail(Map<String, dynamic>.from((j['detail'] as Map?) ?? const {})),
        ref: EventRef.fromJson((j['ref'] as Map?)?.cast<String, dynamic>()),
      );

  @override
  String toString() => '#$seq ${kind.wire} $memberId ${detail.oneLine}';
}
