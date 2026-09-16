// Snapshot — PROTOCOL `snapshot` 알림 / `hello` 결과. types.ts `Snapshot`.

import 'department.dart';
import 'member.dart';
import 'pending.dart';
import 'task.dart';
import 'team.dart';

class Snapshot {
  const Snapshot({
    required this.seq,
    required this.departments,
    required this.teams,
    required this.members,
    required this.pending,
    required this.tasks,
  });

  /// 스냅샷 시점의 lastSeq. 클라이언트는 seq > 이 값만 적용한다(재접속 규칙 2).
  final int seq;

  /// 부서 목록(T34). 상단 탭의 원본.
  final List<Department> departments;

  final List<Team> teams;
  final List<Member> members;

  /// status='open' 만.
  final List<Pending> pending;

  /// status in ('queued','assigned') 만.
  final List<Task> tasks;

  factory Snapshot.fromJson(Map<String, dynamic> j) => Snapshot(
        seq: (j['seq'] as num).toInt(),
        departments: _list(j['departments'], Department.fromJson),
        teams: _list(j['teams'], Team.fromJson),
        members: _list(j['members'], Member.fromJson),
        pending: _list(j['pending'], Pending.fromJson),
        tasks: _list(j['tasks'], Task.fromJson),
      );

  static List<T> _list<T>(Object? v, T Function(Map<String, dynamic>) f) =>
      ((v as List?) ?? const []).map((e) => f(Map<String, dynamic>.from(e as Map))).toList(growable: false);
}

/// `member.status` 알림. `member` 는 그 시점의 Member 행(행이 삭제됐으면 null).
class MemberStatusNotice {
  const MemberStatusNotice({
    required this.memberId,
    required this.status,
    required this.derived,
    required this.member,
  });

  final String memberId;
  final MemberStatus status;
  final DerivedStatus derived;
  final Member? member;

  factory MemberStatusNotice.fromJson(Map<String, dynamic> j) => MemberStatusNotice(
        memberId: j['memberId'] as String,
        status: MemberStatus.parse(j['status'] as String),
        derived: DerivedStatus.parse(j['derived'] as String),
        member: j['member'] == null ? null : Member.fromJson(Map<String, dynamic>.from(j['member'] as Map)),
      );
}

/// `daemon.notice` 알림.
enum NoticeLevel {
  info,
  warn,
  error;

  static NoticeLevel parse(String s) => switch (s) {
        'info' => NoticeLevel.info,
        'warn' => NoticeLevel.warn,
        'error' => NoticeLevel.error,
        _ => throw FormatException('unknown notice level: $s'),
      };
}

class DaemonNotice {
  const DaemonNotice({required this.level, required this.message, required this.receivedAt});

  final NoticeLevel level;
  final String message;
  final DateTime receivedAt;

  factory DaemonNotice.fromJson(Map<String, dynamic> j) => DaemonNotice(
        level: NoticeLevel.parse(j['level'] as String),
        message: j['message'] as String,
        receivedAt: DateTime.now(),
      );
}
