// 사무실 장면 모델(순수 Dart). 상태 층의 members/latestEvent/pending 맵을 화면에 필요한 값만 추린 불변 데이터로 바꾼다.
// 페인터·레이아웃은 이 클래스만 보고, 상태 층의 형태 변화는 여기서만 흡수한다.
//
// 배치(T37, 01 §직무 체계 rev 3 "사무실 배치"): **부서 하나가 한 화면**이다.
//   맨 위 가운데 = 부장 책상, 그 아래 팀마다 클러스터(제목 줄 + 팀장 책상이 먼저, 팀원이 뒤),
//   팀이 없는 멤버(정상적으로는 없다)는 "미배정" 클러스터, 문과 내 책상은 그대로.
//
// 요약 규칙(01-설계문서 §3 "캐릭터 상태 3중 표현" 중 모니터·말풍선):
//   status exited → "(퇴근)", error → "⚠ 오류" (이벤트보다 우선)
//   `ask_parent` 로 상사 답을 기다리는 중 → "❓ 상사에게 질문"(사용자 줄에는 서지 않는다 — T37)
//   event reading → "◫ <basename>", editing → "✎ <basename>", running → "▶ <cmd 40자>", thinking → "…",
//         idle → "(대기)", waiting_approval → "❗ 허가 대기", asking → "❓ 질문", error → "⚠ 오류",
//         text → "❝ <text>", delegating → "→ 위임", reporting → "▤ 보고"
//   **running 이어도 `detail.waiting` 이 있으면**(셸 락 대기) cmd 가 아니라 summary 를 "◷" 를 붙여 보여 준다
//     (T29 결함 ③ — "셸 대기 중 (락: 작가)" 가 명령에 가려 안 보였다).
//   이벤트 없음 → status 로: starting "(출근 중)", idle "(대기)", working "…", waiting_* 는 위와 동일.
//   파생 status 가 waiting_reports 면 "✉ 보고 대기"(상사가 위임하고 부하 보고를 기다리는 중).
//   파생 status 가 free 면(턴 끝 + 맡은 일 없음, T28) "(대기)" 자리에 "(한가함)".
//   파생 status 가 waiting_answer/waiting_approval 이면 이벤트보다 "❓ 질문"/"❗ 허가 대기" 가 앞선다
//   (`ask_user` 는 질문이 열린 채 raw status 가 idle 로 돌아간다 — PROTOCOL `member.status.derived`, T19 함정 1).

import '../model/models.dart';

// **기호는 번들 서체 3종 안에 있는 것만 쓴다**(T33 · T40 편차 ⑤).
//
// 앱은 Galmuri11(캔버스) · Pretendard(패널) · D2Coding(고정폭) 셋만 동봉하고, 한 서체에 없는 글자는
// `fontFamilyFallback` 으로 나머지 둘이 대신한다. **시스템 서체 폴백은 믿을 수 없다** — T40 실기에서
// `📨`(U+1F4E8) `⏳`(U+23F3) `♛`(U+265B) 이 전부 두부(□)로 나왔다(`❗` `⚠` 는 나왔다).
// 그래서 세 서체 어디에도 없는 이모지는 같은 뜻의 기호로 바꿨다:
//
// | 옛 글자 | 바꾼 글자 | 어느 서체에 있나 |
// |---|---|---|
// | `📨` 보고 대기 | `✉` U+2709 | Galmuri11 · D2Coding |
// | `⏳` 대기 | `◷` U+25F7 | Galmuri11 · D2Coding |
// | `📖` 읽는 중 | `◫` U+25EB | Galmuri11 · D2Coding |
// | `📋` `📄` 보고 | `▤` U+25A4 | Galmuri11 · D2Coding |
// | `💬` 한마디 | `❝` U+275D | D2Coding |
//
// 그대로 둔 것: `❗` `❓`(Galmuri11) · `⚠` `★` `▶` `…` `→` `↻`(세 서체 모두) · `✎` `♛`(D2Coding).
// 새 기호를 넣기 전에 `test/office/office_fonts_test.dart` 의 허용 목록을 먼저 본다.
//
// 사무실 **캔버스**는 이 글자들 대신 아틀라스에 그린 아이콘을 쓴다(`office_sprites.dart`) — 여기 글자는
// 오른쪽 패널처럼 캔버스 밖에서 같은 상태를 보여 주는 곳의 몫이다.

/// 말풍선 최대 글자 수.
const int bubbleMaxChars = 28;

/// running 요약에 쓰는 명령 최대 글자 수.
const int cmdMaxChars = 40;

// ---- 레이아웃 v2 상수(docs/design/레이아웃-v2.md 패스 2·4) --------------------------

/// 모니터 한 줄의 최대 글자 수(2줄 × 22자 — 패스 4 구체성).
const int monitorMaxChars = 22;

/// 이 배율 미만이면 모니터 둘째 줄을 숨긴다.
const double monitorSecondLineMinScale = 0.7;

/// 이 배율 미만이면 엔진 배지를 숨긴다(글자 빼기 1단계 — 패스 1 D7).
const double engineBadgeMinScale = 0.8;

/// 이 배율 미만이면 직급 배지에서 글자를 빼고 아이콘(♛/★)만 남긴다(2단계).
const double rankLabelMinScale = 0.7;

/// 내 책상 대기 슬롯 수(D-42 3).
const int mySlotCount = 4;

/// 상사 책상 옆에 동시에 보여 주는 방문자 수(3명째부터 "+N").
const int visitorMaxShown = 2;

/// 퇴근한 책상이 "퇴근 N" 배지로 접히기까지(패스 2 이슈 7, 앱 로컬).
const Duration exitFoldAfter = Duration(minutes: 10);

/// 복구(`[RESUMED]`) 표시가 유지되는 시간(패스 2 D10).
const Duration resumedMarkDuration = Duration(seconds: 3);

/// 복구 말풍선.
const String resumedBubble = '↻ 복구됨';

/// 출근 걷기 시간(문 → 책상, 패스 2 D10).
const Duration arrivalWalkDuration = Duration(milliseconds: 1200);

/// 부서가 하나도 없을 때의 가운데 버튼·한 줄(패스 2 이슈 7).
const String createDepartmentLabel = '부서 만들기';
const String emptyDepartmentHint = '프로젝트 폴더 하나 = 부서 하나. 부장이 팀을 꾸립니다.';

/// 부장만 있고 팀이 없을 때 점선 클러스터 자리에 쓰는 문구.
const String noTeamPlaceholderHint = '팀은 부장이 만듭니다 — 아래 지시 바에 첫 지시를';

/// 내 책상 헤더 문구. **사무실 캔버스와 오른쪽 패널 인박스가 같은 말을 쓴다**(T40c — 전에는 0 일 때
/// 캔버스가 "대기 없음", 패널이 "대기 0" 이라 한 화면에 두 말이 같이 떴다).
String myDeskHeaderLabel(int count) => count == 0 ? '내 책상 · 대기 없음' : '내 책상 · 대기 $count';

/// 엔진 배지·직급 배지·이름을 이 배율에서 어떻게 줄일지(패스 1 D7 — 숨기는 순서).
bool showsEngineBadge(double scale) => scale >= engineBadgeMinScale;
bool showsRankLabel(double scale) => scale >= rankLabelMinScale;
bool showsMonitorSecondLine(double scale) => scale >= monitorSecondLineMinScale;

/// 이 배율에서 책상에 그릴 직급 배지 글자(팀원은 빈 문자열, 좁아지면 아이콘만).
String rankBadgeAt(MemberRank rank, double scale) {
  if (rank == MemberRank.member) return '';
  return showsRankLabel(scale) ? '${rank.mark} ${rank.label}' : rank.mark;
}

/// 상태 범례 7칸(D-42 3 · 패스 2 매핑표). 캐릭터 링 색 · 하단 범례 · 패널 상태 점의 **단일 기준**이다.
/// 색은 ARGB 값(이 파일은 순수 Dart — 페인터가 `Color(...)` 로 쓴다).
enum LegendSlot {
  working('작업', 0xFF6C8EFF, ''),
  idle('한가', 0xFF7ED3A1, ''),
  waitingReports('보고 대기', 0xFF7ED3A1, '✉', dashedRing: true),
  myTurn('내 차례', 0xFFFF9F43, '❗'),
  waiting('대기', 0xFFFFC857, '◷'),
  error('오류', 0xFFFF6B6B, '⚠'),
  exited('퇴근', 0xFF474D5E, '');

  const LegendSlot(this.label, this.argb, this.icon, {this.dashedRing = false});

  final String label;
  final int argb;
  final String icon;

  /// 점선 링으로 그린다(색만으로 구분하지 않는다 — 패스 6 색약 대응).
  final bool dashedRing;
}

/// 코드 상태 13종 → 범례 7칸. **이 함수 하나가 유일한 매핑**이다(링 색·범례·패널 헤더 상태 점 공용).
///
/// 사무실은 [SceneMember] 를 들고 있으므로 [legendSlotOf] 를, 패널처럼 장면이 없는 곳은 이 함수를 직접 쓴다
/// (T40c: `panel/labels.dart` 에 있던 사본 `LegendCategory`/`legendCategory` 를 지우고 여기로 합쳤다).
///
/// - [askingParent] `ask_parent` 로 상사 답을 기다리는 중 — 사용자 몫이 아니라 `대기`.
/// - [shellWaiting] 셸 락 대기(`running{detail.waiting}`).
/// - [queued] 내 책상 줄(슬롯)에 서 있다.
LegendSlot legendSlotFor({
  required MemberStatus status,
  DerivedStatus? derived,
  OfficeEventKind? eventKind,
  bool askingParent = false,
  bool shellWaiting = false,
  bool queued = false,
}) {
  if (status == MemberStatus.exited) return LegendSlot.exited;
  if (status == MemberStatus.error) return LegendSlot.error;
  // ask_parent 답 대기는 "대기"(노랑) — 사용자가 할 일이 없다.
  if (askingParent) return LegendSlot.waiting;
  // 내 차례: 허가 대기 · 부장 ask_user · TUI 질문(= 내 책상 줄에 선 사람).
  if (queued || status.isWaiting || (derived?.isWaiting ?? false)) return LegendSlot.myTurn;
  if (status == MemberStatus.starting) return LegendSlot.waiting;
  if (shellWaiting) return LegendSlot.waiting;
  if (derived == DerivedStatus.waitingReports) return LegendSlot.waitingReports;
  if (derived == DerivedStatus.free) return LegendSlot.idle;
  if (eventKind == OfficeEventKind.delegating || eventKind == OfficeEventKind.reporting) return LegendSlot.working;
  return switch (status) {
    MemberStatus.working => LegendSlot.working,
    MemberStatus.idle => LegendSlot.idle,
    _ => LegendSlot.idle,
  };
}

/// 장면 멤버의 범례 칸. [legendSlotFor] 에 그 멤버의 플래그를 넘기는 얇은 껍데기다.
LegendSlot legendSlotOf(SceneMember m) => legendSlotFor(
      status: m.status,
      derived: m.derived,
      eventKind: m.eventKind,
      askingParent: m.isAskingParent,
      shellWaiting: m.isShellWaiting,
      queued: m.isQueued,
    );

/// 파생 상태 `waiting_reports`(상사가 위임하고 부하 보고를 기다리는 중 — 01 §3) 의 모니터·말풍선 문구.
const String waitingReportsSummary = '✉ 보고 대기';

/// 파생 상태 `free`(턴도 끝났고 맡은 일도 없다 — PROTOCOL `derived`, T28) 의 문구. 같은 "(대기)" 라도
/// **일이 남아 있는** idle 과 구분해 보여 준다.
const String freeSummary = '(한가함)';

/// `ask_parent`(T35) 로 직속 상사의 답을 기다리는 중. 사용자 줄에 서지 않고 상사 책상 옆으로 간다(T37).
const String askParentSummary = '❓ 상사에게 질문';

/// 셸 락 대기(`running{waiting:'shell-lock'}`) 앞에 붙는 표시(T29 결함 ③).
const String waitingPrefix = '◷';

/// 팀이 없는 멤버를 모으는 클러스터 제목(정상 트리에서는 비어 있다).
const String unassignedClusterTitle = '미배정';

/// 책상 배지의 직급 표시. 팀원은 배지 없음.
String rankBadgeLabel(MemberRank rank) => rank == MemberRank.member ? '' : '${rank.mark} ${rank.label}';

/// 캐릭터 한 명이 화면에 필요한 값.
class SceneMember {
  const SceneMember({
    required this.id,
    required this.name,
    required this.engine,
    required this.status,
    required this.deskIndex,
    required this.summary,
    required this.isAlert,
    this.rank = MemberRank.member,
    this.teamId,
    this.queueIndex,
    this.eventKind,
    this.eventSeq,
    this.eventTool,
    this.askParentDeskIndex,
    this.derived,
    this.monitorSecond,
    this.askParentVisitorIndex,
    this.isShellWaiting = false,
    this.isResumed = false,
  });

  final String id;
  final String name;
  final Engine engine;
  final MemberStatus status;

  /// 직급(T37 rev 3). 부장·팀장은 책상 배지 + 캐릭터 링으로 표시한다.
  final MemberRank rank;

  /// 소속 팀(부장은 null).
  final String? teamId;

  /// 책상 번호(0부터, 장면 순서 = 부장 → 팀 클러스터 순). 라벨은 `책상 ${deskIndex + 1}`.
  final int deskIndex;

  /// 모니터·말풍선 텍스트(말풍선은 [bubbleText] 로 잘라 쓴다).
  final String summary;

  /// alert 말풍선(waiting_approval / asking / reporting, 또는 waiting 상태).
  final bool isAlert;

  /// 내 책상 줄에 서 있으면 그 순서(0부터), 자기 자리면 null.
  final int? queueIndex;

  /// 마지막 이벤트의 kind·seq·tool(없으면 null). T16 이 reporting 방문(새 seq 인지)을 판정하고,
  /// [eventTool] 로 **MCP 팀 도구 호출은 방문을 취소하지 않는다**(T29 결함 ④).
  final OfficeEventKind? eventKind;
  final int? eventSeq;
  final String? eventTool;

  /// `ask_parent` 로 답을 기다리는 중이면 **직속 상사의 책상 번호**(그 상사가 같은 화면에 있을 때).
  /// 이 멤버는 내 책상 줄이 아니라 상사 책상 옆으로 걸어간다(T37).
  final int? askParentDeskIndex;

  /// 파생 상태(`waiting_reports`·`free`·`waiting_answer` …). 범례 매핑([legendSlotOf])의 입력이다.
  final DerivedStatus? derived;

  /// 모니터 둘째 줄(결과 요약). 없으면 null — 배율이 작으면 페인터가 숨긴다.
  final String? monitorSecond;

  /// 같은 상사에게 동시에 질문하러 간 사람 중 몇 번째인가(0부터, T40-3).
  final int? askParentVisitorIndex;

  /// 셸 락 대기(`running{waiting:'shell-lock'}`) 중인가 — 범례 "대기"(노랑).
  final bool isShellWaiting;

  /// 방금 복구된(`[RESUMED]`) 멤버인가 — 책상 점선 3초 + "↻ 복구됨" 말풍선(패스 2 D10).
  final bool isResumed;

  bool get isQueued => queueIndex != null;

  /// 내 책상 슬롯(4칸)에 자리가 있는 대기자인가. 5명째부터는 자기 책상에 남는다(D-42 3).
  bool get hasSlot => queueIndex != null && queueIndex! < mySlotCount;

  /// 상사 책상 옆에 실제로 서 있는가(3명째부터는 자기 자리에 남고 "+N" 만 뜬다).
  bool get showsAsVisitor => isAskingParent && (askParentVisitorIndex ?? 0) < visitorMaxShown;

  /// 상사 책상으로 질문하러 간 상태인가.
  bool get isAskingParent => askParentDeskIndex != null;

  /// 부장인가(사용자 지시·`ask_user` 는 부장에게만 — D-32).
  bool get isHead => rank == MemberRank.head;

  /// 팀장인가.
  bool get isLead => rank == MemberRank.lead;

  /// 회색 처리(exited / error).
  bool get isGone => status.isGone;

  /// 오류 포즈(T30): 비정상 종료(크래시·강제 종료). 붉은 링 + "⚠ 오류" 말풍선 — 퇴근(exited)과 구분한다.
  bool get isError => status == MemberStatus.error;

  /// 이름 첫 글자(빈 이름이면 '?').
  String get initial => name.isEmpty ? '?' : String.fromCharCode(name.runes.first);

  String get engineLabel => switch (engine) {
        Engine.claude => 'Claude',
        Engine.codex => 'Codex',
      };

  /// 책상 라벨 = **이름만**(패스 1 D7: "책상 N ·" 접두어 삭제 — 번호는 툴팁·로그에만).
  String get deskLabel => name;

  /// 툴팁·시맨틱·로그용(번호 포함).
  String get deskTooltip => '책상 ${deskIndex + 1} · $name';

  String get bubbleText => truncate(summary, bubbleMaxChars);

  /// 모니터 첫 줄(명령·도구) — 22자.
  String get monitorTop => truncate(summary, monitorMaxChars);

  /// 모니터 둘째 줄(결과 요약) — 22자, 없으면 null.
  String? get monitorBottom => monitorSecond == null ? null : truncate(monitorSecond!, monitorMaxChars);

  /// 이 멤버의 범례 칸(링 색·상태 점의 단일 기준).
  LegendSlot get legendSlot => legendSlotOf(this);

  @override
  bool operator ==(Object other) =>
      other is SceneMember &&
      other.id == id &&
      other.name == name &&
      other.engine == engine &&
      other.status == status &&
      other.rank == rank &&
      other.teamId == teamId &&
      other.deskIndex == deskIndex &&
      other.summary == summary &&
      other.isAlert == isAlert &&
      other.queueIndex == queueIndex &&
      other.eventKind == eventKind &&
      other.eventSeq == eventSeq &&
      other.eventTool == eventTool &&
      other.askParentDeskIndex == askParentDeskIndex &&
      other.derived == derived &&
      other.monitorSecond == monitorSecond &&
      other.askParentVisitorIndex == askParentVisitorIndex &&
      other.isShellWaiting == isShellWaiting &&
      other.isResumed == isResumed;

  @override
  int get hashCode => Object.hash(id, name, engine, status, rank, teamId, deskIndex, summary, isAlert, queueIndex, eventKind,
      eventSeq, eventTool, askParentDeskIndex, derived, monitorSecond, askParentVisitorIndex, isShellWaiting, isResumed);

  @override
  String toString() => 'SceneMember($id $name ${rank.wire} desk=$deskIndex queue=$queueIndex "$summary")';
}

/// 내 책상 줄의 한 항목.
class QueueEntry {
  const QueueEntry({required this.pendingId, required this.memberId, required this.memberName, required this.label});

  final String pendingId;
  final String memberId;
  final String memberName;

  /// "허가: (명령)" / "질문: (첫 질문)".
  final String label;

  /// 목록 한 줄: "1. 이음 — 허가: rm -rf build/".
  String line(int index) => '${index + 1}. $memberName — $label';

  @override
  bool operator ==(Object other) =>
      other is QueueEntry &&
      other.pendingId == pendingId &&
      other.memberId == memberId &&
      other.memberName == memberName &&
      other.label == label;

  @override
  int get hashCode => Object.hash(pendingId, memberId, memberName, label);
}

// ---- 책상 배치 계획 ---------------------------------------------------------------

/// 책상 한 무리 = 팀 하나(T37). 제목 줄 + 그 팀의 책상들(팀장이 먼저).
class DeskCluster {
  const DeskCluster({
    required this.deskCount,
    this.teamId,
    this.title,
    this.exitedFolded = 0,
    this.allExited = false,
    this.isPlaceholder = false,
  });

  /// 팀 id(미배정 클러스터·평면 배치는 null).
  final String? teamId;

  /// 제목 줄 텍스트. null 이면 제목 없이 책상만(T12 평면 배치 호환).
  final String? title;

  final int deskCount;

  /// 10분 넘게 퇴근해 접힌 책상 수 — 제목 줄의 "퇴근 N" 배지(패스 2 이슈 7).
  final int exitedFolded;

  /// 팀원이 전원 퇴근 — 제목 줄만 남긴 낮은 상자.
  final bool allExited;

  /// 아직 팀이 없을 때의 **점선 자리**(부장만 있는 부서, T40-6).
  final bool isPlaceholder;

  @override
  bool operator ==(Object other) =>
      other is DeskCluster &&
      other.teamId == teamId &&
      other.title == title &&
      other.deskCount == deskCount &&
      other.exitedFolded == exitedFolded &&
      other.allExited == allExited &&
      other.isPlaceholder == isPlaceholder;

  @override
  int get hashCode => Object.hash(teamId, title, deskCount, exitedFolded, allExited, isPlaceholder);

  @override
  String toString() => 'DeskCluster(${title ?? '-'} × $deskCount)';
}

/// 한 화면의 책상 배치 계획. 부장 책상(맨 위 가운데) + 클러스터들.
/// 책상 번호는 이 순서 그대로다 — 부장 0, 그다음 클러스터 순.
class OfficeDeskPlan {
  const OfficeDeskPlan({required this.hasHead, required this.clusters});

  /// 제목 없는 클러스터 하나(= T12 의 평면 격자).
  factory OfficeDeskPlan.flat(int deskCount) =>
      OfficeDeskPlan(hasHead: false, clusters: deskCount == 0 ? const [] : [DeskCluster(deskCount: deskCount)]);

  static const OfficeDeskPlan empty = OfficeDeskPlan(hasHead: false, clusters: []);

  /// 맨 윗줄 가운데에 부장 책상이 있는가.
  final bool hasHead;

  final List<DeskCluster> clusters;

  int get deskCount => (hasHead ? 1 : 0) + clusters.fold(0, (a, c) => a + c.deskCount);

  /// 클러스터 [i] 의 첫 책상 번호.
  int startOf(int i) {
    var n = hasHead ? 1 : 0;
    for (var k = 0; k < i; k++) {
      n += clusters[k].deskCount;
    }
    return n;
  }

  @override
  bool operator ==(Object other) =>
      other is OfficeDeskPlan && other.hasHead == hasHead && _listEq(other.clusters, clusters);

  @override
  int get hashCode => Object.hash(hasHead, Object.hashAll(clusters));
}

/// 사무실 한 장면. 값 비교 가능(페인터 shouldRepaint 용).
class OfficeScene {
  const OfficeScene({required this.members, required this.queue, OfficeDeskPlan? plan}) : _plan = plan;

  static const OfficeScene empty = OfficeScene(members: [], queue: []);

  /// 책상 순서(부장 → 팀 클러스터 → 미배정).
  final List<SceneMember> members;

  /// 열린 pending 중 **사용자가 답할 것**만, createdAt 순(T37: `ask_parent` 는 빠진다).
  final List<QueueEntry> queue;

  final OfficeDeskPlan? _plan;

  /// 책상 배치 계획(부장 자리·팀 클러스터). 손으로 만든 장면(테스트·미리보기)처럼 계획이 없으면
  /// 멤버 수만큼의 평면 격자(T12 배치)로 본다.
  OfficeDeskPlan get plan => _plan ?? OfficeDeskPlan.flat(members.length);

  bool get isEmpty => members.isEmpty;

  /// 내 책상 헤더(패스 2 이슈 5: N 은 **전체** 대기 수 — 슬롯 4칸을 넘어도 다 센다).
  String get myDeskHeader => myDeskHeaderLabel(queue.length);

  /// 슬롯 4칸을 넘은 대기 수("+N" 배지). 0 이면 배지 없음.
  int get slotOverflow => queue.length > mySlotCount ? queue.length - mySlotCount : 0;

  /// 슬롯 [k] 에 선 대기 항목(없으면 null — 빈 슬롯은 점선 실루엣).
  QueueEntry? slotEntry(int k) => k >= 0 && k < queue.length && k < mySlotCount ? queue[k] : null;

  /// 상사 책상 [deskIndex] 옆에서 답을 기다리는 사람 수(3명째부터 "+N" 말풍선).
  int visitorsAt(int deskIndex) => members.where((m) => m.askParentDeskIndex == deskIndex).length;

  SceneMember? memberById(String id) {
    for (final m in members) {
      if (m.id == id) return m;
    }
    return null;
  }

  /// 상태 층 맵에서 장면을 만든다.
  /// [departmentId] 를 주면 그 부서의 멤버·팀만(= 상단 탭 하나), null 이면 전체.
  factory OfficeScene.build({
    required Map<String, Member> members,
    required Map<String, OfficeEvent> latestEvents,
    required Map<String, Pending> pending,
    Map<String, DerivedStatus> derived = const {},
    Map<String, Team> teams = const {},
    String? departmentId,
    DateTime? now,
    Set<String> expandedTeamIds = const {},
    Map<String, int> reportCounts = const {},
  }) {
    if (departmentId != null) {
      members = {for (final e in members.entries) if (e.value.departmentId == departmentId) e.key: e.value};
      teams = {for (final e in teams.entries) if (e.value.departmentId == departmentId) e.key: e.value};
      pending = {for (final e in pending.entries) if (members.containsKey(e.value.memberId)) e.key: e.value};
    }
    final all = members.values.toList(growable: false)..sort(_byCreatedAt);
    final openPending = pending.values.toList(growable: false)..sort(_pendingByCreatedAt);

    // ---- 책상 순서: 부장 → 팀 클러스터(팀장 먼저) → 미배정 -------------------------------
    final heads = all.where((m) => m.rank == MemberRank.head).toList(growable: false);
    final head = heads.where((m) => !m.status.isGone).firstOrNull ?? heads.firstOrNull;

    final teamOrder = teams.values.toList(growable: false)..sort(_teamByCreatedAt);
    final teamIds = <String>[for (final t in teamOrder) t.id];
    // 팀 행이 아직 안 온 팀(스냅샷 지연)도 멤버의 teamId 로 클러스터를 만든다.
    for (final m in all) {
      final tid = m.teamId;
      if (tid != null && !teamIds.contains(tid)) teamIds.add(tid);
    }

    final ordered = <Member>[];
    final clusters = <DeskCluster>[];
    if (head != null) ordered.add(head);
    for (final tid in teamIds) {
      final crew = all.where((m) => m.teamId == tid && m.id != head?.id).toList(growable: false)..sort(_byRankThenCreatedAt);
      final name = teams[tid]?.name ?? tid;
      // 전원 퇴근 팀 = 제목 줄만 남긴 낮은 상자(패스 2 이슈 7).
      if (crew.isNotEmpty && crew.every((m) => m.status == MemberStatus.exited)) {
        clusters.add(DeskCluster(
          teamId: tid,
          title: '팀 $name · 전원 퇴근 · 보고 ${reportCounts[tid] ?? 0}건',
          deskCount: 0,
          allExited: true,
        ));
        continue;
      }
      // 10분 넘게 퇴근한 책상은 접어 제목 줄의 "퇴근 N" 배지로(펼치면 다시 보인다 — 앱 로컬).
      final folded = expandedTeamIds.contains(tid)
          ? const <Member>[]
          : crew.where((m) => _isFoldableExit(m, now)).toList(growable: false);
      final shown = folded.isEmpty ? crew : crew.where((m) => !folded.contains(m)).toList(growable: false);
      clusters.add(DeskCluster(
        teamId: tid,
        title: _clusterTitle(name, crew.length),
        deskCount: shown.length,
        exitedFolded: folded.length,
      ));
      ordered.addAll(shown);
    }
    final orphans = all
        .where((m) => m.id != head?.id && (m.teamId == null || !teamIds.contains(m.teamId)))
        .toList(growable: false)
      ..sort(_byRankThenCreatedAt);
    if (orphans.isNotEmpty) {
      clusters.add(DeskCluster(title: '$unassignedClusterTitle · ${orphans.length}명', deskCount: orphans.length));
      ordered.addAll(orphans);
    }
    // 부장만 있고 팀이 하나도 없으면 점선 클러스터 자리 하나(T40-6).
    if (head != null && clusters.isEmpty) {
      clusters.add(const DeskCluster(title: noTeamPlaceholderHint, deskCount: 0, isPlaceholder: true));
    }
    final plan = OfficeDeskPlan(hasHead: head != null, clusters: clusters);
    final deskIndexOf = {for (var i = 0; i < ordered.length; i++) ordered[i].id: i};

    // ---- 사용자 줄 --------------------------------------------------------------------
    // 내 책상에는 **사용자가 답할 것**만 선다(T37, D-32): 허가는 직급 무관 전부, 질문은 부장의 `ask_user`
    // (와 턴을 붙잡는 TUI 질문). `ask_parent` 는 상사에게 가는 것이라 여기 없다 — 그 멤버는 상사 책상으로 간다.
    final userPending = [for (final p in openPending) if (p.goesToUser(rank: members[p.memberId]?.rank)) p];
    final withUserPending = {for (final p in userPending) p.memberId};
    final otherPending = {for (final p in openPending) if (!p.goesToUser(rank: members[p.memberId]?.rank)) p.memberId};
    // `ask_parent` 질문자 → 답을 기다리는 상사(같은 화면에 있을 때만 책상 번호를 얻는다).
    final askParentTarget = <String, int>{};
    // 같은 상사에게 동시에 질문한 사람의 순번(오래된 질문부터 0, 1, 2 …) — 방문 자리 배정(T40-3).
    final askParentVisitorIndex = <String, int>{};
    final visitorsPerDesk = <int, int>{};
    for (final p in openPending) {
      if (!p.isAskParent) continue;
      final to = p.askParentTo ?? members[p.memberId]?.parentId;
      final idx = to == null ? null : deskIndexOf[to];
      if (idx == null || askParentTarget.containsKey(p.memberId)) continue;
      askParentTarget[p.memberId] = idx;
      askParentVisitorIndex[p.memberId] = visitorsPerDesk[idx] ?? 0;
      visitorsPerDesk[idx] = (visitorsPerDesk[idx] ?? 0) + 1;
    }

    // 줄에 서는 기준(T19 함정 1): "사용자 몫 pending 이 있다" 또는 "파생/raw status 가 waiting".
    // 단 `ask_parent` 같은 남의 몫 pending 때문에 waiting 인 멤버는 서지 않는다.
    bool isQueuedMember(Member m) =>
        withUserPending.contains(m.id) ||
        (!otherPending.contains(m.id) && ((derived[m.id]?.isWaiting ?? false) || m.status.isWaiting));

    // 줄(슬롯)은 **인박스 카드와 1:1** 이다(D6) — `queue[k]` 가 슬롯 k 의 카드고, 슬롯 k 에 서는 사람은
    // 그 카드의 주인이다. 그래서 멤버의 슬롯 번호를 따로 매기지 않고 **카드 목록에서 찾는다**
    // (T40c: 전에는 멤버 순번과 카드 순번을 따로 압축해서, 한 멤버가 카드 2장을 들면 옆 사람 슬롯을 누를 때
    //  남의 카드가 열렸다). 카드 2장을 든 멤버는 자기 **첫 카드** 자리에 서고 나머지 칸은 빈 슬롯으로 남는다.
    final queue = <QueueEntry>[
      for (final p in userPending)
        if (members.containsKey(p.memberId))
          QueueEntry(
            pendingId: p.id,
            memberId: p.memberId,
            memberName: members[p.memberId]?.name ?? p.memberId,
            label: pendingLabel(p),
          ),
    ];
    final queued = <String, int>{};
    for (var k = 0; k < queue.length; k++) {
      queued.putIfAbsent(queue[k].memberId, () => k);
    }
    // 카드 없이 상태만 waiting 인 멤버(pending 이 아직 안 온 찰나)는 카드 뒤에 createdAt 순으로 선다.
    var tail = queue.length;
    for (final m in ordered) {
      if (isQueuedMember(m) && !queued.containsKey(m.id)) queued[m.id] = tail++;
    }

    final sceneMembers = <SceneMember>[
      for (var i = 0; i < ordered.length; i++)
        SceneMember(
          id: ordered[i].id,
          name: ordered[i].name,
          engine: ordered[i].engine,
          status: ordered[i].status,
          rank: ordered[i].rank,
          teamId: ordered[i].teamId,
          deskIndex: i,
          summary: summarize(
            ordered[i].status,
            latestEvents[ordered[i].id],
            derived: derived[ordered[i].id],
            askingParent: askParentTarget.containsKey(ordered[i].id),
          ),
          isAlert: isAlertFor(
            ordered[i].status,
            latestEvents[ordered[i].id],
            derived: derived[ordered[i].id],
            askingParent: askParentTarget.containsKey(ordered[i].id),
          ),
          queueIndex: queued[ordered[i].id],
          eventKind: latestEvents[ordered[i].id]?.kind,
          eventSeq: latestEvents[ordered[i].id]?.seq,
          eventTool: latestEvents[ordered[i].id]?.detail.tool,
          // 줄에 선(= 사용자 몫이 있는) 멤버는 상사 방문보다 내 책상이 우선.
          askParentDeskIndex: queued.containsKey(ordered[i].id) ? null : askParentTarget[ordered[i].id],
          askParentVisitorIndex: queued.containsKey(ordered[i].id) ? null : askParentVisitorIndex[ordered[i].id],
          derived: derived[ordered[i].id] ?? ordered[i].derived,
          monitorSecond: monitorSecondLine(
            ordered[i].status,
            latestEvents[ordered[i].id],
            askingParent: askParentTarget.containsKey(ordered[i].id),
          ),
          isShellWaiting: latestEvents[ordered[i].id]?.detail.waiting != null,
          isResumed: isResumeEvent(latestEvents[ordered[i].id]),
        ),
    ];

    return OfficeScene(members: sceneMembers, queue: queue, plan: plan);
  }

  static String _clusterTitle(String name, int count) => '팀 $name · $count명';

  /// 10분 넘게 퇴근해 있는 책상인가(기준 시각 [now] 가 없으면 접지 않는다).
  static bool _isFoldableExit(Member m, DateTime? now) {
    if (now == null || m.status != MemberStatus.exited) return false;
    final t = DateTime.tryParse(m.updatedAt);
    return t != null && now.difference(t.toUtc()) >= exitFoldAfter;
  }

  static int _byCreatedAt(Member a, Member b) {
    final c = a.createdAt.compareTo(b.createdAt);
    return c != 0 ? c : a.id.compareTo(b.id);
  }

  /// 클러스터 안 순서: 팀장 먼저, 그다음 팀원(각각 createdAt 순).
  static int _byRankThenCreatedAt(Member a, Member b) {
    final r = a.rank.index.compareTo(b.rank.index);
    return r != 0 ? r : _byCreatedAt(a, b);
  }

  static int _teamByCreatedAt(Team a, Team b) {
    final c = a.createdAt.compareTo(b.createdAt);
    return c != 0 ? c : a.id.compareTo(b.id);
  }

  static int _pendingByCreatedAt(Pending a, Pending b) {
    final c = a.createdAt.compareTo(b.createdAt);
    return c != 0 ? c : a.id.compareTo(b.id);
  }

  @override
  bool operator ==(Object other) =>
      other is OfficeScene && _listEq(other.members, members) && _listEq(other.queue, queue) && other.plan == plan;

  @override
  int get hashCode => Object.hash(Object.hashAll(members), Object.hashAll(queue), plan);
}

bool _listEq<T>(List<T> a, List<T> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

// ---- 요약 함수 -------------------------------------------------------------------

/// 모니터·말풍선용 한 줄 요약. [derived] 가 `waiting_answer` 면(= `ask_user` 질문이 열린 채 raw 는 `idle`)
/// 마지막 이벤트보다 "❓ 질문" 이 앞선다 — 답을 기다리는 동안 "(대기)" 로 보이지 않게(T19 함정 1).
/// [askingParent] 면 상사 답을 기다리는 중이라 그 표시가 가장 앞선다(T37).
String summarize(MemberStatus status, OfficeEvent? event, {DerivedStatus? derived, bool askingParent = false}) {
  if (status == MemberStatus.exited) return '(퇴근)';
  if (status == MemberStatus.error) return '⚠ 오류';
  if (askingParent) return askParentSummary;
  if (derived == DerivedStatus.waitingAnswer) return '❓ 질문';
  if (derived == DerivedStatus.waitingApproval) return '❗ 허가 대기';
  // 상사가 위임 후 idle 인데 미종료 task 가 남았다 — 마지막 이벤트("(대기)")보다 이게 사실에 가깝다(01 §3).
  if (derived == DerivedStatus.waitingReports) return waitingReportsSummary;
  // 턴도 끝났고 맡은 일도 없다(T28). "(대기)" 가 나올 자리에서만 바꾼다 — 방금 한 일(보고·편집)은 그대로 보여 준다.
  if (derived == DerivedStatus.free && (event == null || event.kind == OfficeEventKind.idle)) return freeSummary;
  if (event == null) return _statusSummary(status);
  final d = event.detail;
  return switch (event.kind) {
    OfficeEventKind.reading => '◫ ${d.path != null ? basename(d.path!) : d.oneLine}',
    OfficeEventKind.editing => '✎ ${d.path != null ? basename(d.path!) : d.oneLine}',
    // 셸 락 대기는 아직 실행 전이다 — cmd 대신 summary(T29 결함 ③).
    OfficeEventKind.running => d.waiting != null
        ? '$waitingPrefix ${truncate(firstLine(d.summary ?? d.oneLine), cmdMaxChars)}'
        : '▶ ${truncate(firstLine(d.cmd ?? d.oneLine), cmdMaxChars)}',
    OfficeEventKind.thinking => '…',
    OfficeEventKind.idle => '(대기)',
    OfficeEventKind.waitingApproval => '❗ 허가 대기',
    OfficeEventKind.asking => '❓ 질문',
    OfficeEventKind.error => '⚠ 오류',
    OfficeEventKind.text => d.oneLine.isEmpty ? '❝' : '❝ ${d.oneLine}',
    OfficeEventKind.delegating => '→ 위임',
    OfficeEventKind.reporting => '▤ 보고',
  };
}

String _statusSummary(MemberStatus s) => switch (s) {
      MemberStatus.starting => '(출근 중)',
      MemberStatus.idle => '(대기)',
      MemberStatus.working => '…',
      MemberStatus.waitingApproval => '❗ 허가 대기',
      MemberStatus.waitingAnswer => '❓ 질문',
      MemberStatus.exited => '(퇴근)',
      MemberStatus.error => '⚠ 오류',
    };

/// 모니터 **둘째 줄**(결과 요약, 패스 4). 첫 줄은 명령·도구([summarize]) 이므로 같은 내용은 되풀이하지 않는다.
/// 퇴근·오류·상사 질문 중이거나 요약이 없으면 null(= 한 줄).
String? monitorSecondLine(MemberStatus status, OfficeEvent? event, {bool askingParent = false}) {
  if (status.isGone || askingParent || event == null) return null;
  final d = event.detail;
  // 셸 락 대기는 첫 줄이 이미 summary 다(T29 결함 ③).
  if (d.waiting != null) return null;
  final raw = d.summary ?? (event.kind == OfficeEventKind.text ? null : d.text);
  if (raw == null) return null;
  final line = firstLine(raw);
  if (line.isEmpty) return null;
  final top = summarize(status, event);
  if (top.contains(line)) return null;
  return truncate(line, monitorMaxChars);
}

/// 재시작 복구 이벤트인가 — 데몬은 `--resume` 재스폰 뒤 `text{summary:'resumed'}` 를 내고 큐에 `[RESUMED] …` 를 넣는다.
bool isResumeEvent(OfficeEvent? event) {
  if (event == null || event.kind != OfficeEventKind.text) return false;
  final d = event.detail;
  return (d.summary ?? '') == 'resumed' || (d.text ?? '').startsWith('[RESUMED]');
}

/// alert 말풍선 여부: 마지막 이벤트가 waiting_approval/asking/reporting 이거나 멤버가 (raw·파생) waiting 상태.
bool isAlertFor(MemberStatus status, OfficeEvent? event, {DerivedStatus? derived, bool askingParent = false}) {
  if (status.isGone) return false;
  if (askingParent) return true;
  if (status.isWaiting) return true;
  if (derived?.isWaiting ?? false) return true;
  return event?.kind.isAlert ?? false;
}

/// 내 책상 목록용 "허가: (명령)" / "질문: (첫 질문)".
String pendingLabel(Pending p) {
  if (p.type == PendingType.approval) {
    final input = p.payload['tool_input'];
    String? arg;
    if (input is Map) arg = (input['command'] ?? input['file_path'] ?? input['path'])?.toString();
    final tool = p.payload['tool_name']?.toString() ?? '';
    final what = firstLine(arg ?? tool);
    return '허가: ${what.isEmpty ? '(도구)' : what}';
  }
  final q = firstLine(p.summary);
  return '질문: ${q.isEmpty ? '(내용 없음)' : q}';
}

/// 경로의 마지막 조각(`/`·`\` 모두).
String basename(String path) {
  final trimmed = path.replaceAll(RegExp(r'[\\/]+$'), '');
  final i = trimmed.lastIndexOf(RegExp(r'[\\/]'));
  return i < 0 ? trimmed : trimmed.substring(i + 1);
}

String firstLine(String s) => s.split('\n').first.trim();

/// 글자 수(rune 기준)로 자르고 넘치면 '…'.
String truncate(String s, int max) {
  final runes = s.runes.toList();
  if (runes.length <= max) return s;
  return '${String.fromCharCodes(runes.take(max - 1))}…';
}
