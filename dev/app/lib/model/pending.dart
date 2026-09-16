// Pending — dev/daemon/src/store/types.ts `Pending`. 스냅샷에는 status='open' 만 온다.

import 'member.dart' show MemberRank;

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

  /// TeamTools `ask_parent`(T35) 가 만든 질문인가 — payload `{source:'ask_parent', question, options, from, to}`.
  /// **사용자에게 오는 질문이 아니다**(D-32: 팀장·팀원은 바로 위에만 묻는다). 앱은 내 책상 줄·카드에서 빼고
  /// 질문한 멤버의 패널에 "상사에게 질문 중" 안내 카드로만 보여 준다(T37).
  bool get isAskParent => type == PendingType.question && payload['source'] == 'ask_parent';

  /// `ask_parent` 질문을 받은 상사 memberId(payload `to`). 다른 출처면 null.
  String? get askParentTo => isAskParent ? payload['to'] as String? : null;

  /// `ask_parent` 질문을 낸 멤버 id(payload `from`). 보통 [memberId] 와 같다.
  String? get askParentFrom => isAskParent ? payload['from'] as String? : null;

  /// 사용자가 답해야 하는 pending 인가 — 내 책상 줄·카드에 들어갈 자격(T37, D-32).
  ///  - **허가(approval)는 직급과 무관하게 사용자에게** 온다(D-32 3: 셸 허가는 보고 체계와 별개인 안전 문제).
  ///  - `ask_parent` 는 상사에게 가는 질문이라 제외.
  ///  - `ask_user` 는 부장 전용이므로 **부장의 것만**(옛 데몬이 팀장 것을 보내와도 사용자 줄에 세우지 않는다).
  ///  - 그 밖의 질문(TUI `AskUserQuestion`)은 **턴을 붙잡고 있어 사용자만 풀 수 있다** → 직급과 무관하게 보여 준다.
  bool goesToUser({required MemberRank? rank}) {
    if (type == PendingType.approval) return true;
    if (isAskParent) return false;
    if (isAskUser) return rank == null || rank.talksToUser;
    return true;
  }

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
