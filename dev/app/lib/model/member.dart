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

  /// 사용자 응답을 기다리는 파생 상태. raw status 가 `idle` 이어도 `ask_user` 질문이 열려 있으면
  /// 데몬이 `waiting_answer` 를 보낸다(PROTOCOL `member.status.derived`, T17).
  bool get isWaiting => this == waitingApproval || this == waitingAnswer;

  /// 데몬이 파생을 안 실어 보낸 경우(옛 데몬)의 기본값 — PROTOCOL `member.status.derived` 의 규칙 중 앱이 알 수 있는 만큼:
  /// idle 인데 열린 질문 pending 이 있으면 `waiting_answer`(T17 `ask_user` 는 턴이 끝나도 질문이 열려 있다),
  /// idle 이고 배정 task 가 없으면 `free`, 그 외는 status 와 같다.
  static DerivedStatus fromStatus(MemberStatus s, {required bool hasAssignedTask, bool hasOpenQuestion = false}) {
    if (s == MemberStatus.idle && hasOpenQuestion) return DerivedStatus.waitingAnswer;
    if (s == MemberStatus.idle && !hasAssignedTask) return DerivedStatus.free;
    return DerivedStatus.parse(s.wire);
  }
}

/// 직급 3단 트리(D-32 rev 3, 데몬 `MemberRank`). 부장은 부서에 한 명(사용자와 직접 말하는 유일한 직급),
/// 팀장은 팀에 한 명(부장의 자식), 팀원은 팀장의 자식.
enum MemberRank {
  head,
  lead,
  member;

  /// 와이어 값. 레거시 `'leader'`(rev 2 의 팀장)는 `lead` 로 읽는다 — 데몬은 v2 마이그레이션에서 값을 이미
  /// 바꿨지만(T34) 옛 데몬·옛 기록을 만나도 죽지 않게 한다.
  static MemberRank parse(String s) => switch (s) {
        'head' => MemberRank.head,
        'lead' || 'leader' => MemberRank.lead,
        'member' => MemberRank.member,
        _ => throw FormatException('unknown rank: $s'),
      };

  String get wire => name;

  /// 한글 라벨(데몬 `RANK_LABEL` 과 같은 말).
  String get label => switch (this) {
        MemberRank.head => '부장',
        MemberRank.lead => '팀장',
        MemberRank.member => '팀원',
      };

  /// 배지 기호(부장 = 왕관, 팀장 = 별, 팀원 = 없음).
  String get mark => switch (this) {
        MemberRank.head => '♛',
        MemberRank.lead => '★',
        MemberRank.member => '',
      };

  /// 사용자와 직접 말하는 직급인가(D-32: 지시·`ask_user`·사용자 보고는 부장만).
  bool get talksToUser => this == MemberRank.head;
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
    required this.departmentId,
    required this.teamId,
    required this.parentId,
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
    this.derived,
  });

  final String id;

  /// 소속 부서(T34). 모든 멤버가 부서 하나에 속한다.
  final String departmentId;

  /// 소속 팀. **부장은 null**(부서 직속 — D-33).
  final String? teamId;

  /// 트리 간선 — 부장 null, 팀장 = 부장, 팀원 = 팀장.
  final String? parentId;

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

  /// 스냅샷의 멤버 행에만 실려 오는 파생 상태(PROTOCOL `snapshot`, T28). `member.status` 알림의 Member 행에는 없다 →
  /// 그때는 알림의 `derived` 를 쓴다. 옛 데몬(파생을 안 싣는)에서는 null 이라 `DerivedStatus.fromStatus` 로 떨어진다.
  final DerivedStatus? derived;

  factory Member.fromJson(Map<String, dynamic> j) => Member(
        id: j['id'] as String,
        departmentId: j['departmentId'] as String? ?? '',
        teamId: j['teamId'] as String?,
        parentId: j['parentId'] as String?,
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
        derived: j['derived'] == null ? null : DerivedStatus.parse(j['derived'] as String),
      );

  Member copyWith({MemberStatus? status, String? updatedAt}) => Member(
        id: id,
        departmentId: departmentId,
        teamId: teamId,
        parentId: parentId,
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
        derived: derived,
      );

  @override
  String toString() => 'Member($id $name [${engine.name}] ${rank.wire} ${status.wire})';
}
