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
    required this.name,
    required this.cwd,
    required this.leaderId,
    required this.maxMembers,
    required this.allowedEngines,
    required this.createdAt,
  });

  final String id;
  final String name;
  final String cwd;
  final String? leaderId;
  final int maxMembers;
  final List<Engine> allowedEngines;
  final String createdAt;

  factory Team.fromJson(Map<String, dynamic> j) => Team(
        id: j['id'] as String,
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
