// Snapshot — PROTOCOL `snapshot` 알림 / `hello` 결과. types.ts `Snapshot`.

import 'department.dart';
import 'member.dart';
import 'pending.dart';
import 'task.dart';
import 'team.dart';
import 'usage.dart';

class Snapshot {
  const Snapshot({
    required this.seq,
    required this.departments,
    required this.teams,
    required this.members,
    required this.pending,
    required this.tasks,
    this.usage = UsageSnapshot.empty,
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

  /// 엔진·멤버 사용량(T43, D-45). **옛 데몬에는 없는 키**라 없으면 빈 것으로 떨어진다.
  final UsageSnapshot usage;

  factory Snapshot.fromJson(Map<String, dynamic> j) => Snapshot(
        seq: (j['seq'] as num).toInt(),
        departments: _list(j['departments'], Department.fromJson),
        teams: _list(j['teams'], Team.fromJson),
        members: _list(j['members'], Member.fromJson),
        pending: _list(j['pending'], Pending.fromJson),
        tasks: _list(j['tasks'], Task.fromJson),
        usage: UsageSnapshot.fromJson(j['usage']),
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

/// `daemon.notice` 의 `kind`(T46 · 수명주기 "상태 · 와이어 변화"). 없으면 [DaemonNoticeKind.plain] —
/// 지금까지의 알림은 전부 그쪽이다(토스트로만 뜬다).
enum DaemonNoticeKind {
  /// kind 없는 보통 알림.
  plain,

  /// 데몬이 부모 앱이 사라진 것을 알아챘다(§3).
  parentGone('parent-gone'),

  /// 세션 복구 진행(§4) — `total` 중 `done` 명.
  recovering;

  const DaemonNoticeKind([String? wire]) : _wire = wire;
  final String? _wire;
  String get wire => _wire ?? name;

  /// 모르는 kind 는 [plain] 으로 떨어진다(프로토콜이 늘어나도 앱이 죽지 않는다).
  static DaemonNoticeKind parse(Object? s) {
    for (final v in values) {
      if (v != plain && v.wire == s) return v;
    }
    return plain;
  }
}

class DaemonNotice {
  const DaemonNotice({
    required this.level,
    required this.message,
    required this.receivedAt,
    this.kind = DaemonNoticeKind.plain,
    this.total,
    this.done,
  });

  final NoticeLevel level;
  final String message;
  final DateTime receivedAt;

  /// 수명 주기 알림인가(§3 · §4).
  final DaemonNoticeKind kind;

  /// `kind:'recovering'` 의 진행 — 되살릴 전체 수와 끝난 수.
  final int? total;
  final int? done;

  /// `level`·`message` 는 수명 주기 알림에서 빠질 수 있다 — 없으면 info · 빈 문자열로 본다
  /// (모르는 level 도 info. 알림 하나 때문에 스트림이 끊기면 안 된다).
  factory DaemonNotice.fromJson(Map<String, dynamic> j) {
    NoticeLevel level;
    try {
      level = NoticeLevel.parse(j['level'] as String);
    } catch (_) {
      level = NoticeLevel.info;
    }
    return DaemonNotice(
      level: level,
      message: j['message']?.toString() ?? '',
      receivedAt: DateTime.now(),
      kind: DaemonNoticeKind.parse(j['kind']),
      total: (j['total'] as num?)?.toInt(),
      done: (j['done'] as num?)?.toInt(),
    );
  }

  /// 진행 표시로 쓸 수 있는가(`복구 2 / 5`).
  bool get hasProgress => kind == DaemonNoticeKind.recovering && total != null && total! > 0;
}
