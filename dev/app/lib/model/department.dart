// Department — dev/daemon/src/store/types.ts `Department` 과 1:1 (T34, D-32).
// 부서 = 프로젝트(cwd). 사용자가 만드는 유일한 단위이고, 그 안에 부장 한 명 → 팀 → 팀원 트리가 산다.

class Department {
  const Department({
    required this.id,
    required this.name,
    required this.cwd,
    required this.headId,
    required this.createdAt,
  });

  final String id;
  final String name;

  /// 이 부서의 팀·멤버가 모두 쓰는 작업 폴더(D-32 "부서 = 프로젝트").
  final String cwd;

  /// 부장 memberId. **부장이 나가도 남는다** — "살아 있는 부장" 판정은 `liveHeadProvider`
  /// (멤버 행의 rank·status 로, 데몬 `Store.liveHead` 와 같은 규칙).
  final String? headId;

  final String createdAt;

  factory Department.fromJson(Map<String, dynamic> j) => Department(
        id: j['id'] as String,
        name: j['name'] as String,
        cwd: j['cwd'] as String,
        headId: j['headId'] as String?,
        createdAt: j['createdAt'] as String,
      );

  @override
  String toString() => 'Department($id $name cwd=$cwd)';
}
