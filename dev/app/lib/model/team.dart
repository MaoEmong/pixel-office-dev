// Team — dev/daemon/src/store/types.ts `Team` 과 1:1.

/// 멤버 CLI 엔진. types.ts `Engine`.
enum Engine {
  claude,
  codex;

  static Engine parse(String s) => switch (s) {
        'claude' => Engine.claude,
        'codex' => Engine.codex,
        _ => throw FormatException('unknown engine: $s'),
      };

  String get wire => name;
}

class Team {
  const Team({
    required this.id,
    required this.departmentId,
    required this.name,
    required this.cwd,
    required this.leaderId,
    required this.maxMembers,
    required this.allowedEngines,
    required this.createdAt,
  });

  final String id;

  /// 팀이 속한 부서(T34). 팀은 부서 안에서만 만들어진다.
  final String departmentId;

  final String name;

  /// 당분간 부서 cwd 와 같다(D-32 "한 부서 안의 팀들은 같은 cwd").
  final String cwd;

  /// 팀장 memberId. **팀장이 나가도 남는다** — 살아 있는 팀장은 `liveLeadProvider`.
  final String? leaderId;
  final int maxMembers;
  final List<Engine> allowedEngines;
  final String createdAt;

  factory Team.fromJson(Map<String, dynamic> j) => Team(
        id: j['id'] as String,
        departmentId: j['departmentId'] as String? ?? '',
        name: j['name'] as String,
        cwd: j['cwd'] as String,
        leaderId: j['leaderId'] as String?,
        maxMembers: (j['maxMembers'] as num).toInt(),
        allowedEngines: ((j['allowedEngines'] as List?) ?? const [])
            .map((e) => Engine.parse(e as String))
            .toList(growable: false),
        createdAt: j['createdAt'] as String,
      );

  @override
  String toString() => 'Team($id $name cwd=$cwd)';
}
