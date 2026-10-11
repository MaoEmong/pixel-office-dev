// Department — dev/daemon/src/store/types.ts `Department` 과 1:1 (T34, D-32).
// 부서 = 프로젝트(cwd). 사용자가 만드는 유일한 단위이고, 그 안에 부장 한 명 → 팀 → 팀원 트리가 산다.

/// 부서의 **허가 방식**(U-02, D-51) — 이 부서 멤버의 허가 요청을 어디까지 묻지 않고 넘길 것인가.
///
/// 판정은 데몬(`adapters/autoApproval.ts`)이 한다. 앱은 고르고 보여 주기만 한다.
/// 어느 방식이든 **작업 폴더 밖 · `.git`/`.claude`/`.codex` 안 · 비밀 파일(`.env`·키) · 웹 요청**은 늘 묻는다.
enum ApprovalPolicy {
  ask('ask', '전부 묻기', '허가가 필요한 것은 전부 내 책상으로 옵니다.'),
  edits('edits', '폴더 안 편집은 자동', '작업 폴더 안의 파일 편집과 읽기만 하는 명령은 묻지 않습니다. 그 밖의 명령은 묻습니다.'),
  trust('trust', '위험한 것만 묻기', '평범한 명령(테스트·빌드·커밋 등)도 묻지 않습니다. 삭제·푸시·설치·폴더 밖처럼 위험해 보이는 것만 묻습니다.');

  const ApprovalPolicy(this.wire, this.label, this.hint);

  final String wire;

  /// 고르는 자리(부서 만들기 · 허가 방식 다이얼로그)의 이름.
  final String label;

  /// 그 아래 한 줄 설명.
  final String hint;

  /// 모르는 값·없는 값(옛 데몬)은 `ask` — 틀려도 "묻는" 쪽으로 틀린다.
  static ApprovalPolicy fromWire(Object? v) => values.firstWhere((p) => p.wire == v, orElse: () => ApprovalPolicy.ask);
}

/// `trust` 를 고를 때 꼭 보여 주는 한 줄. 이 방식은 **사고를 막는 장치이지 보안 경계가 아니다.**
const String approvalTrustCaveat = '실수를 막는 장치이지 보안 장치가 아닙니다 — 스크립트 안에서 일어나는 일까지는 보지 못합니다.';

class Department {
  const Department({
    required this.id,
    required this.name,
    required this.cwd,
    required this.headId,
    required this.createdAt,
    this.approvalPolicy = ApprovalPolicy.ask,
  });

  final String id;
  final String name;

  /// 이 부서의 팀·멤버가 모두 쓰는 작업 폴더(D-32 "부서 = 프로젝트").
  final String cwd;

  /// 부장 memberId. **부장이 나가도 남는다** — "살아 있는 부장" 판정은 `liveHeadProvider`
  /// (멤버 행의 rank·status 로, 데몬 `Store.liveHead` 와 같은 규칙).
  final String? headId;

  final String createdAt;

  /// 허가 방식(U-02). 옛 데몬은 이 키를 안 보낸다 → `ask`.
  final ApprovalPolicy approvalPolicy;

  factory Department.fromJson(Map<String, dynamic> j) => Department(
        id: j['id'] as String,
        name: j['name'] as String,
        cwd: j['cwd'] as String,
        headId: j['headId'] as String?,
        createdAt: j['createdAt'] as String,
        approvalPolicy: ApprovalPolicy.fromWire(j['approvalPolicy']),
      );

  @override
  String toString() => 'Department($id $name cwd=$cwd)';
}
