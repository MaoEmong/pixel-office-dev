// Pending — dev/daemon/src/store/types.ts `Pending`. 스냅샷에는 status='open' 만 온다.

enum PendingType {
  approval,
  question;

  static PendingType parse(String s) => switch (s) {
        'approval' => PendingType.approval,
        'question' => PendingType.question,
        _ => throw FormatException('unknown pending type: $s'),
      };
}

enum PendingStatus {
  open,
  answered,
  expired;

  static PendingStatus parse(String s) => switch (s) {
        'open' => PendingStatus.open,
        'answered' => PendingStatus.answered,
        'expired' => PendingStatus.expired,
        _ => throw FormatException('unknown pending status: $s'),
      };
}

class Pending {
  const Pending({
    required this.id,
    required this.memberId,
    required this.type,
    required this.payload,
    required this.status,
    required this.createdAt,
    required this.answeredAt,
    required this.answer,
  });

  final String id;
  final String memberId;
  final PendingType type;

  /// approval: hook 의 PermissionRequest payload(`tool_name`, `tool_input` …).
  /// question: AskUserQuestion `tool_input` 또는 M2 `ask_user` 본문.
  final Map<String, dynamic> payload;
  final PendingStatus status;
  final String createdAt;
  final String? answeredAt;
  final Object? answer;

  factory Pending.fromJson(Map<String, dynamic> j) => Pending(
        id: j['id'] as String,
        memberId: j['memberId'] as String,
        type: PendingType.parse(j['type'] as String),
        payload: Map<String, dynamic>.from((j['payload'] as Map?) ?? const {}),
        status: PendingStatus.parse(j['status'] as String),
        createdAt: j['createdAt'] as String,
        answeredAt: j['answeredAt'] as String?,
        answer: j['answer'],
      );

  /// TeamTools `ask_user`(T17) 가 만든 질문인가 — payload `{source:'ask_user', question, options}`(D-19: `tool_input` 없음).
  /// TUI `AskUserQuestion` 과 달리 **턴을 붙잡지 않아** 질문이 열린 채 멤버가 계속 일하거나 idle 로 돌아간다.
  bool get isAskUser => type == PendingType.question && payload['source'] == 'ask_user';

  /// 카드 제목용 요약. approval: `tool_name` + command|file_path|path, question: 첫 질문.
  String get summary {
    if (type == PendingType.approval) {
      final tool = payload['tool_name'] as String? ?? '';
      final input = payload['tool_input'];
      String? arg;
      if (input is Map) {
        arg = (input['command'] ?? input['file_path'] ?? input['path'])?.toString();
      }
      return arg == null ? tool : '$tool $arg';
    }
    // TUI AskUserQuestion 은 payload.tool_input.questions[], M2 ask_user 는 payload.question|text.
    final input = payload['tool_input'];
    final qs = (input is Map ? input['questions'] : null) ?? payload['questions'];
    if (qs is List && qs.isNotEmpty && qs.first is Map) {
      return (qs.first as Map)['question']?.toString() ?? '';
    }
    return payload['question']?.toString() ?? payload['text']?.toString() ?? '';
  }

  @override
  String toString() => 'Pending($id ${type.name} $memberId ${status.name})';
}
