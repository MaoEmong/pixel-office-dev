// Member — dev/daemon/src/store/types.ts `Member` 과 1:1.

import 'team.dart';

/// 멤버 상태. types.ts `MemberStatus`. PROTOCOL `member.status` 알림의 `status` 도 같은 값.
enum MemberStatus {
  starting,
  idle,
  working,
  waitingApproval('waiting_approval'),
  waitingAnswer('waiting_answer'),
  exited,
  error;

  const MemberStatus([String? wire]) : _wire = wire;
  final String? _wire;

  /// 와이어 문자열(snake_case).
  String get wire => _wire ?? name;

  static MemberStatus parse(String s) {
    for (final v in values) {
      if (v.wire == s) return v;
    }
    throw FormatException('unknown member status: $s');
  }

  /// 프로세스가 더 이상 살아 있지 않은 상태(재출근 대상).
  bool get isGone => this == exited || this == error;

  /// 사용자 응답을 기다리는 상태.
  bool get isWaiting => this == waitingApproval || this == waitingAnswer;
}

/// `member.status` 알림의 `derived`. MemberStatus + `free` + `waiting_reports`(M4).
enum DerivedStatus {
  starting,
  idle,
  working,
  waitingApproval('waiting_approval'),
  waitingAnswer('waiting_answer'),
  exited,
  error,
  free,
  waitingReports('waiting_reports');

  const DerivedStatus([String? wire]) : _wire = wire;
  final String? _wire;
  String get wire => _wire ?? name;

  static DerivedStatus parse(String s) {
    for (final v in values) {
      if (v.wire == s) return v;
    }
    throw FormatException('unknown derived status: $s');
  }

  /// status 만 알고 derived 를 모를 때(스냅샷) 의 기본값 — v1a 규칙: idle 이고 배정 task 없으면 free.
  static DerivedStatus fromStatus(MemberStatus s, {required bool hasAssignedTask}) {
    if (s == MemberStatus.idle && !hasAssignedTask) return DerivedStatus.free;
    return DerivedStatus.parse(s.wire);
  }
}

enum MemberRank {
  leader,
  member;

  static MemberRank parse(String s) => switch (s) {
        'leader' => MemberRank.leader,
        'member' => MemberRank.member,
        _ => throw FormatException('unknown rank: $s'),
      };
}

enum HiredBy {
  user,
  leader;

  static HiredBy parse(String s) => switch (s) {
        'user' => HiredBy.user,
        'leader' => HiredBy.leader,
        _ => throw FormatException('unknown hiredBy: $s'),
      };
}

class Member {
  const Member({
    required this.id,
    required this.teamId,
    required this.name,
    required this.rank,
    required this.engine,
    required this.sessionId,
    required this.childPid,
    required this.cwd,
    required this.status,
    required this.hiredBy,
    required this.memberToken,
    required this.instructionsPath,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  final String teamId;
  final String name;
  final MemberRank rank;
  final Engine engine;
  final String? sessionId;
  final int? childPid;
  final String cwd;
  final MemberStatus status;
  final HiredBy hiredBy;
  final String memberToken;
  final String? instructionsPath;
  final String createdAt;
  final String updatedAt;

  factory Member.fromJson(Map<String, dynamic> j) => Member(
        id: j['id'] as String,
        teamId: j['teamId'] as String,
        name: j['name'] as String,
        rank: MemberRank.parse(j['rank'] as String),
        engine: Engine.parse(j['engine'] as String),
        sessionId: j['sessionId'] as String?,
        childPid: (j['childPid'] as num?)?.toInt(),
        cwd: j['cwd'] as String,
        status: MemberStatus.parse(j['status'] as String),
        hiredBy: HiredBy.parse(j['hiredBy'] as String),
        memberToken: j['memberToken'] as String,
        instructionsPath: j['instructionsPath'] as String?,
        createdAt: j['createdAt'] as String,
        updatedAt: j['updatedAt'] as String,
      );

  Member copyWith({MemberStatus? status, String? updatedAt}) => Member(
        id: id,
        teamId: teamId,
        name: name,
        rank: rank,
        engine: engine,
        sessionId: sessionId,
        childPid: childPid,
        cwd: cwd,
        status: status ?? this.status,
        hiredBy: hiredBy,
        memberToken: memberToken,
        instructionsPath: instructionsPath,
        createdAt: createdAt,
        updatedAt: updatedAt ?? this.updatedAt,
      );

  @override
  String toString() => 'Member($id $name [${engine.name}] ${status.wire})';
}
