// 오른쪽 패널의 한국어 라벨·시각 포맷. 로그 탭(kind 라벨), 헤더(상태·경과 시간)에서 공유.

import 'package:flutter/material.dart';

import '../model/models.dart';

/// 이벤트 kind → 로그 탭 라벨.
String eventKindLabel(OfficeEventKind k) => switch (k) {
      OfficeEventKind.thinking => '생각 중',
      OfficeEventKind.text => '응답',
      OfficeEventKind.reading => '읽는 중',
      OfficeEventKind.editing => '편집',
      OfficeEventKind.running => '실행',
      OfficeEventKind.waitingApproval => '허가 대기',
      OfficeEventKind.asking => '질문',
      OfficeEventKind.delegating => '위임',
      OfficeEventKind.reporting => '보고',
      OfficeEventKind.idle => '완료',
      OfficeEventKind.error => '오류',
    };

/// 이벤트 kind → 라벨 색(로그 탭). alert 성격은 눈에 띄게.
Color eventKindColor(OfficeEventKind k) => switch (k) {
      OfficeEventKind.waitingApproval => Colors.amber,
      OfficeEventKind.asking => Colors.cyanAccent,
      OfficeEventKind.reporting => Colors.greenAccent,
      OfficeEventKind.error => Colors.redAccent,
      OfficeEventKind.idle => Colors.white38,
      OfficeEventKind.delegating => Colors.purpleAccent,
      OfficeEventKind.editing => Colors.orangeAccent,
      _ => Colors.white70,
    };

/// 멤버 status → 헤더 라벨.
String memberStatusLabel(MemberStatus s) => switch (s) {
      MemberStatus.starting => '출근 중',
      MemberStatus.idle => '대기',
      MemberStatus.working => '작업 중',
      MemberStatus.waitingApproval => '허가 대기',
      MemberStatus.waitingAnswer => '답변 대기',
      MemberStatus.exited => '퇴근',
      MemberStatus.error => '오류',
    };

/// 파생 상태 → 헤더 라벨(free/waiting_reports 만 status 와 다르다).
String derivedStatusLabel(DerivedStatus d) => switch (d) {
      DerivedStatus.free => '한가함',
      DerivedStatus.waitingReports => '보고 대기',
      _ => memberStatusLabel(MemberStatus.parse(d.wire)),
    };

Color memberStatusColor(MemberStatus s) => switch (s) {
      MemberStatus.starting => Colors.amber,
      MemberStatus.idle => Colors.greenAccent,
      MemberStatus.working => Colors.lightBlueAccent,
      MemberStatus.waitingApproval || MemberStatus.waitingAnswer => Colors.amber,
      MemberStatus.exited => Colors.white38,
      MemberStatus.error => Colors.redAccent,
    };

/// 이벤트 `ts`(ISO 8601, UTC) → 로컬 `HH:MM`. 파싱 실패면 원문 앞 5자.
String formatClock(String ts) {
  final t = DateTime.tryParse(ts)?.toLocal();
  if (t == null) return ts.length > 5 ? ts.substring(0, 5) : ts;
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(t.hour)}:${two(t.minute)}';
}

/// `HH:MM:SS` (보고서 탭 등 초 단위가 필요한 곳).
String formatClockSeconds(String ts) {
  final t = DateTime.tryParse(ts)?.toLocal();
  if (t == null) return formatClock(ts);
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(t.hour)}:${two(t.minute)}:${two(t.second)}';
}

/// 경과 시간 → `방금`, `N분`, `N시간 M분`, `N일 H시간`.
String formatElapsed(Duration d) {
  if (d.isNegative) return '방금';
  if (d.inMinutes < 1) return '방금';
  if (d.inHours < 1) return '${d.inMinutes}분';
  if (d.inDays < 1) return '${d.inHours}시간 ${d.inMinutes % 60}분';
  return '${d.inDays}일 ${d.inHours % 24}시간';
}

/// 로그 행의 상세 한 줄: `tool` + (path | cmd | summary | text) 첫 줄. 길면 자른다.
String eventDetailLine(OfficeEvent e, {int maxLength = 200}) {
  final d = e.detail;
  final body = d.path ?? d.cmd ?? d.summary ?? d.text;
  final parts = <String>[
    if (d.tool != null && d.tool!.isNotEmpty) d.tool!,
    if (body != null && body.isNotEmpty) body.split('\n').first.trimRight(),
  ];
  // running 처럼 cmd 와 summary 가 둘 다 있으면 summary 를 뒤에 덧붙인다.
  if (d.summary != null && body != d.summary && d.summary!.isNotEmpty && (d.path != null || d.cmd != null)) {
    parts.add('— ${d.summary!.split('\n').first}');
  }
  final line = parts.join(' ');
  return line.length > maxLength ? '${line.substring(0, maxLength)}…' : line;
}

/// 패널 공용 고정폭 글꼴(스파이크 실측: Cascadia Mono 로 한글·이모지 OK).
const String panelMonoFamily = 'D2Coding';
const List<String> panelMonoFallback = ['Consolas', 'D2Coding', 'Malgun Gothic', 'monospace'];

// ---- 팔레트(레이아웃 v2 §4) --------------------------------------------------------
// 코드 쪽 단일 소스는 `office/office_painter.dart` 의 `OfficeColors` 다(패스 5). 패널·상단 바는
// `lib/office/` 를 import 하지 않으므로(T40a 와 파일을 나눠 가진다) 같은 값만 여기에 다시 적는다.

/// 포커스 링 — 2px `#FFFFFF` 알파 0.8(브라우저/Flutter 기본 대신 팔레트로, 패스 6).
const Color panelFocusRing = Color(0xCCFFFFFF);
const double panelFocusRingWidth = 2;

/// 스크롤바 6px 팔레트 색(패스 6).
const double panelScrollbarThickness = 6;
const Color panelScrollbarThumb = Color(0x66BFC7DA);

/// 위험 태그 틴트(`#FF6B6B` 알파 0.15).
const Color panelDangerTint = Color(0x26FF6B6B);
const Color panelDangerColor = Color(0xFFFF6B6B);

// ---- 상태 범례 7칸(레이아웃 v2 §3 패스 2, D-42 3) ------------------------------------
// 매핑은 `office/office_scene.dart` 의 `legendSlotFor` **하나**뿐이고(T40c: 여기 있던 사본
// `LegendCategory`/`legendCategory` 를 지웠다), 색은 `office/office_painter.dart` 의 `legendColor` 다.
// 패널 헤더 상태 점·배지는 그 둘을 그대로 import 해서 쓴다 — 사무실 링 색·하단 범례와 같은 값을 말한다.
