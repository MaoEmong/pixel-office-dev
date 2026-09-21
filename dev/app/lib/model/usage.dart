// 사용량(T43, D-45) — 엔진별 한도 + 멤버별 컨텍스트·누적 토큰. 와이어는 `docs/design/사용량-표시.md` §데몬:
//
//   snapshot.usage = { engines: [EngineUsage…], members: [MemberUsage…] }
//   알림 `usage.engine` params = engines[] 한 원소
//   알림 `usage.member` params = members[] 한 원소   (둘 다 비영속 · seq 없음 · 바뀔 때만)
//
// **부호는 데몬 쪽 한 가지뿐이다**(D-45 3): 여기 들어오는 값은 전부 `usedPercent`(쓴 비율 0~100) 고,
// 화면에 나가는 "남음 N%" 는 `lib/usage/usage_format.dart` 의 [remainingPercent] 가 만든다.
//
// **파싱은 필드마다 방어적으로**(설계문서 "CLI 가 업데이트되어 필드 이름이 바뀌면 해당 값만 '알 수 없음' 으로
// 떨어지고 나머지는 계속 돈다"): 없는 키·null·타입이 틀린 값은 null 로 떨어지고 예외를 던지지 않는다.
// 모르는 엔진(`gemini` 같은 것)은 **행 자체를 버린다**([EngineUsage.tryParse] → null).

import 'team.dart' show Engine;

/// 연결이 안 된 이유(`connected:false` 일 때만). 모르는 문자열은 [unknown].
enum UsageReason {
  notInstalled('not-installed'),
  loggedOut('logged-out'),
  unknown('unknown');

  const UsageReason(this.wire);

  final String wire;

  /// 모르는 값도 죽지 않고 [unknown] 으로 떨어진다.
  static UsageReason parse(String? s) {
    for (final v in values) {
      if (v.wire == s) return v;
    }
    return UsageReason.unknown;
  }
}

/// 한도 창 하나(주간 = 7일, 세션 = 5시간). `usedPercent` 는 **쓴 비율**이다.
class UsageWindow {
  const UsageWindow({required this.usedPercent, this.resetsAt});

  /// 쓴 비율 0~100(범위 밖 값도 그대로 담고, 화면 쪽에서 자른다).
  final double usedPercent;

  /// 한도가 다시 차는 시각(파싱 실패·없음이면 null).
  final DateTime? resetsAt;

  /// `usedPercent` 가 없거나 숫자가 아니면 **창 자체가 없는 것**(= 아직 측정 전)으로 본다.
  static UsageWindow? tryParse(Object? v) {
    if (v is! Map) return null;
    final j = Map<String, dynamic>.from(v);
    final used = _num(j['usedPercent']);
    if (used == null) return null;
    return UsageWindow(usedPercent: used, resetsAt: _time(j['resetsAt']));
  }

  @override
  bool operator ==(Object other) =>
      other is UsageWindow && other.usedPercent == usedPercent && other.resetsAt == resetsAt;

  @override
  int get hashCode => Object.hash(usedPercent, resetsAt);

  @override
  String toString() => 'UsageWindow(${usedPercent.toStringAsFixed(1)}% → $resetsAt)';
}

/// 엔진 하나의 상태 — 연결 여부 · 요금제 · 주간/5시간 한도.
class EngineUsage {
  const EngineUsage({
    required this.engine,
    this.connected = false,
    this.reason,
    this.plan,
    this.weekly,
    this.session,
    this.updatedAt,
  });

  /// 아직 데몬이 아무 말도 안 한 엔진의 자리(상단 바는 칩 두 개를 **항상** 보여 준다).
  /// 연결 여부를 모르는 동안은 "연결 안 됨"(회색) 이 아니라 **"첫 작업 후 표시"** 로 둔다 —
  /// 데몬이 기동 직후 `auth status` 를 물어보기 전에 회색으로 깜빡이지 않게.
  factory EngineUsage.unknown(Engine engine) => EngineUsage(engine: engine, connected: true);

  final Engine engine;

  /// 로그인돼 있고 실행 파일이 있는가(`claude auth status` / `codex login status`).
  final bool connected;

  /// [connected] 가 false 일 때의 이유.
  final UsageReason? reason;

  /// 요금제 이름(`max` 등). **계정 이메일은 담지 않는다**(D-45 2).
  final String? plan;

  /// 주간(7일) 한도. **한 번도 못 봤으면 null** — 그 엔진의 멤버가 한 턴이라도 돌아야 들어온다.
  final UsageWindow? weekly;

  /// 5시간 한도. 요금제에 따라 늘 null 일 수 있다.
  final UsageWindow? session;

  /// 이 값을 마지막으로 확인한 시각.
  final DateTime? updatedAt;

  /// 한 번이라도 한도를 본 적이 있는가.
  bool get hasLimits => weekly != null;

  /// 모르는 엔진이면 null(행을 버린다).
  static EngineUsage? tryParse(Object? v) {
    if (v is! Map) return null;
    final j = Map<String, dynamic>.from(v);
    final engine = _engine(j['engine']);
    if (engine == null) return null;
    final connected = j['connected'] == true;
    return EngineUsage(
      engine: engine,
      connected: connected,
      // 붙어 있으면 이유는 없다(데몬이 옛 값을 남겨 보내도 화면에 안 쓴다).
      reason: connected ? null : UsageReason.parse(j['reason'] as String?),
      plan: _text(j['plan']),
      weekly: UsageWindow.tryParse(j['weekly']),
      session: UsageWindow.tryParse(j['session']),
      updatedAt: _time(j['updatedAt']),
    );
  }

  @override
  bool operator ==(Object other) =>
      other is EngineUsage &&
      other.engine == engine &&
      other.connected == connected &&
      other.reason == reason &&
      other.plan == plan &&
      other.weekly == weekly &&
      other.session == session &&
      other.updatedAt == updatedAt;

  @override
  int get hashCode => Object.hash(engine, connected, reason, plan, weekly, session, updatedAt);

  @override
  String toString() => 'EngineUsage(${engine.wire} connected=$connected weekly=$weekly)';
}

/// 멤버의 컨텍스트 창(`percent` 가 없으면 used/window 로 계산한다).
class ContextUsage {
  const ContextUsage({required this.used, required this.window, required this.percent});

  /// 지금 쓰고 있는 토큰 수.
  final int used;

  /// 컨텍스트 창 크기(0 이면 모름).
  final int window;

  /// 0~100.
  final double percent;

  static ContextUsage? tryParse(Object? v) {
    if (v is! Map) return null;
    final j = Map<String, dynamic>.from(v);
    final used = _num(j['used'])?.round() ?? 0;
    final window = _num(j['window'])?.round() ?? 0;
    final percent = _num(j['percent']) ?? (window > 0 ? used / window * 100 : null);
    if (percent == null) return null;
    return ContextUsage(used: used, window: window, percent: percent);
  }

  @override
  bool operator ==(Object other) =>
      other is ContextUsage && other.used == used && other.window == window && other.percent == percent;

  @override
  int get hashCode => Object.hash(used, window, percent);

  @override
  String toString() => 'ContextUsage($used/$window = ${percent.toStringAsFixed(1)}%)';
}

/// 누적 토큰(Claude 는 캐시 항목까지, Codex 는 input/output 만 오는 일이 많다).
class TokenUsage {
  const TokenUsage({
    this.input = 0,
    this.output = 0,
    this.cacheRead = 0,
    this.cacheCreate = 0,
    int? total,
  }) : _total = total;

  final int input;
  final int output;
  final int cacheRead;
  final int cacheCreate;
  final int? _total;

  /// `total` 이 안 왔으면 네 항목의 합으로 본다.
  int get total => _total ?? (input + output + cacheRead + cacheCreate);

  static TokenUsage? tryParse(Object? v) {
    if (v is! Map) return null;
    final j = Map<String, dynamic>.from(v);
    final total = _num(j['total'])?.round();
    final input = _num(j['input'])?.round() ?? 0;
    final output = _num(j['output'])?.round() ?? 0;
    final cacheRead = _num(j['cacheRead'])?.round() ?? 0;
    final cacheCreate = _num(j['cacheCreate'])?.round() ?? 0;
    if (total == null && input == 0 && output == 0 && cacheRead == 0 && cacheCreate == 0) return null;
    return TokenUsage(input: input, output: output, cacheRead: cacheRead, cacheCreate: cacheCreate, total: total);
  }

  @override
  bool operator ==(Object other) =>
      other is TokenUsage &&
      other.input == input &&
      other.output == output &&
      other.cacheRead == cacheRead &&
      other.cacheCreate == cacheCreate &&
      other.total == total;

  @override
  int get hashCode => Object.hash(input, output, cacheRead, cacheCreate, total);

  @override
  String toString() => 'TokenUsage(total=$total)';
}

/// 캐릭터 한 명의 사용량.
class MemberUsage {
  const MemberUsage({
    required this.memberId,
    this.engine,
    this.context,
    this.tokens,
    this.costUsd,
    this.updatedAt,
  });

  final String memberId;

  /// 그 멤버의 엔진(없으면 멤버 행에서 찾는다).
  final Engine? engine;
  final ContextUsage? context;
  final TokenUsage? tokens;

  /// 누적 비용(USD). **Codex 는 늘 null** — 토큰만 온다(D-45 표).
  final double? costUsd;
  final DateTime? updatedAt;

  /// 컨텍스트 비율(모르면 null) — 캔버스 경고 막대·패널 한 줄의 입력.
  double? get contextPercent => context?.percent;

  /// `memberId` 가 없으면 쓸 데가 없다 → null.
  static MemberUsage? tryParse(Object? v) {
    if (v is! Map) return null;
    final j = Map<String, dynamic>.from(v);
    final id = _text(j['memberId']);
    if (id == null) return null;
    return MemberUsage(
      memberId: id,
      engine: _engine(j['engine']),
      context: ContextUsage.tryParse(j['context']),
      tokens: TokenUsage.tryParse(j['tokens']),
      costUsd: _num(j['costUsd']),
      updatedAt: _time(j['updatedAt']),
    );
  }

  /// 보여 줄 것이 하나도 없는가(= 패널 한 줄이 "첫 턴 뒤 표시" 로 떨어진다).
  bool get isEmpty => context == null && tokens == null && costUsd == null;

  @override
  bool operator ==(Object other) =>
      other is MemberUsage &&
      other.memberId == memberId &&
      other.engine == engine &&
      other.context == context &&
      other.tokens == tokens &&
      other.costUsd == costUsd &&
      other.updatedAt == updatedAt;

  @override
  int get hashCode => Object.hash(memberId, engine, context, tokens, costUsd, updatedAt);

  @override
  String toString() => 'MemberUsage($memberId ctx=$context tokens=$tokens)';
}

/// `snapshot.usage` 한 덩어리. 키가 없으면 빈 것([empty]).
class UsageSnapshot {
  const UsageSnapshot({this.engines = const {}, this.members = const {}});

  static const UsageSnapshot empty = UsageSnapshot();

  /// 엔진 → 그 엔진의 상태.
  final Map<Engine, EngineUsage> engines;

  /// 멤버 id → 그 멤버의 사용량.
  final Map<String, MemberUsage> members;

  bool get isEmpty => engines.isEmpty && members.isEmpty;

  /// `snapshot['usage']` 를 그대로 받는다(없으면 [empty]).
  factory UsageSnapshot.fromJson(Object? v) {
    if (v is! Map) return empty;
    final j = Map<String, dynamic>.from(v);
    final engines = <Engine, EngineUsage>{};
    for (final e in _rows(j['engines'])) {
      final u = EngineUsage.tryParse(e);
      if (u != null) engines[u.engine] = u;
    }
    final members = <String, MemberUsage>{};
    for (final m in _rows(j['members'])) {
      final u = MemberUsage.tryParse(m);
      if (u != null) members[u.memberId] = u;
    }
    return UsageSnapshot(engines: engines, members: members);
  }
}

// ---- 값 하나짜리 방어 파서 -------------------------------------------------------------

/// 리스트가 아니면 빈 목록(키가 통째로 딴 타입이어도 죽지 않는다).
List<Object?> _rows(Object? v) => v is List ? v : const [];

double? _num(Object? v) {
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v);
  return null;
}

String? _text(Object? v) {
  if (v is String && v.isNotEmpty) return v;
  return null;
}

DateTime? _time(Object? v) => v is String ? DateTime.tryParse(v) : null;

Engine? _engine(Object? v) {
  if (v is! String) return null;
  for (final e in Engine.values) {
    if (e.wire == v) return e;
  }
  return null; // 모르는 엔진은 버린다
}
