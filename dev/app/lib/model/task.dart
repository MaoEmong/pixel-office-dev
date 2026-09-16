// Task — dev/daemon/src/store/types.ts `Task`. 스냅샷에는 queued|assigned 만 온다.

/// tasks.from_member / to_member 의 사용자 값.
const userActor = 'user';

enum TaskStatus {
  queued,
  assigned,
  reported,
  aborted;

  static TaskStatus parse(String s) => switch (s) {
        'queued' => TaskStatus.queued,
        'assigned' => TaskStatus.assigned,
        'reported' => TaskStatus.reported,
        'aborted' => TaskStatus.aborted,
        _ => throw FormatException('unknown task status: $s'),
      };

  bool get isOpen => this == queued || this == assigned;
}

enum ReportStatus {
  done,
  blocked,
  aborted;

  static ReportStatus parse(String s) => switch (s) {
        'done' => ReportStatus.done,
        'blocked' => ReportStatus.blocked,
        'aborted' => ReportStatus.aborted,
        _ => throw FormatException('unknown report status: $s'),
      };
}

class Task {
  const Task({
    required this.id,
    required this.departmentId,
    required this.fromMember,
    required this.toMember,
    required this.instruction,
    required this.status,
    required this.reportText,
    required this.reportStatus,
    required this.createdAt,
    required this.updatedAt,
  });

  final int id;

  /// task 는 **부서 소유**다(T34, D-33) — 팀 없는 부장도 사용자 task 를 받는다.
  final String departmentId;

  /// 'user' 또는 멤버 id.
  final String fromMember;
  final String toMember;
  final String instruction;
  final TaskStatus status;
  final String? reportText;
  final ReportStatus? reportStatus;
  final String createdAt;
  final String updatedAt;

  factory Task.fromJson(Map<String, dynamic> j) => Task(
        id: (j['id'] as num).toInt(),
        departmentId: (j['departmentId'] ?? j['teamId']) as String? ?? '',
        fromMember: j['fromMember'] as String,
        toMember: j['toMember'] as String,
        instruction: j['instruction'] as String,
        status: TaskStatus.parse(j['status'] as String),
        reportText: j['reportText'] as String?,
        reportStatus: j['reportStatus'] == null ? null : ReportStatus.parse(j['reportStatus'] as String),
        createdAt: j['createdAt'] as String,
        updatedAt: j['updatedAt'] as String,
      );

  @override
  String toString() => 'Task(#$id $fromMember→$toMember ${status.name})';
}
