// T33 서체 3종(D-43 4) — 번들·배선·**글자 허용 목록**.
//
// 핵심 회귀는 마지막 그룹이다: T40 실기에서 `📨` `⏳` `♛` 가 두부(□)로 나왔다(편차 ⑤). 원인은
// "시스템 서체에 있겠지" 라고 믿은 것 — 실제로는 Flutter Windows 의 시스템 폴백이 그 세 글자를 못 냈다.
// 그래서 **앱이 쓰는 기호는 동봉한 세 서체(Galmuri11 · Pretendard · D2Coding) 안에 있는 것만**으로 못 박고,
// 그 목록을 여기서 지킨다. 새 기호를 쓰고 싶으면 먼저 세 서체의 cmap 을 확인하고 [bundledGlyphs] 에 추가한다.

import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/main.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_motion.dart';
import 'package:pixel_office/office/office_painter.dart';
import 'package:pixel_office/office/office_scene.dart';

import 'office_fixtures.dart';

/// 동봉한 서체 3종 중 **적어도 하나**에 있는 것이 확인된 기호(cmap 실측, T33).
/// 값 = 어느 서체가 내 주는가(문서용). 여기 없는 기호를 앱 문구에 쓰면 아래 테스트가 잡는다.
const Map<String, String> bundledGlyphs = {
  '·': '세 서체 모두',
  '—': '세 서체 모두',
  '–': '세 서체 모두',
  '“': '세 서체 모두',
  '”': '세 서체 모두',
  '‘': '세 서체 모두',
  '’': '세 서체 모두',
  '…': '세 서체 모두',
  '→': '세 서체 모두',
  '↻': '세 서체 모두',
  '▶': '세 서체 모두',
  '★': '세 서체 모두',
  '⚠': '세 서체 모두',
  '✉': 'Galmuri11 · D2Coding',
  '◷': 'Galmuri11 · D2Coding',
  '◫': 'Galmuri11 · D2Coding',
  '▤': 'Galmuri11 · D2Coding',
  '❗': 'Galmuri11',
  '❓': 'Galmuri11',
  '❝': 'D2Coding',
  '✎': 'D2Coding',
  '♛': 'D2Coding',
};

/// T40 편차 ⑤ 에서 두부로 나온 글자 + 같은 블록의 이모지 — 다시 들어오면 안 된다.
const List<String> bannedGlyphs = ['📨', '⏳', '📄', '📋', '📖', '💬', '⌛', '♕'];

/// ASCII·한글·한글 자모·공백이 아닌 글자만 추린다(= 기호).
Set<String> symbolsIn(Iterable<String> texts) {
  final out = <String>{};
  for (final t in texts) {
    for (final r in t.runes) {
      if (r < 0x80) continue; // ASCII
      if (r >= 0xAC00 && r <= 0xD7A3) continue; // 한글 음절
      if (r >= 0x3130 && r <= 0x318F) continue; // 한글 자모
      out.add(String.fromCharCode(r));
    }
  }
  return out;
}

/// 앱이 화면에 내는 고정 문구 전부(캔버스 + 범례 + 요약 13갈래).
List<String> appTexts() {
  const w = MemberStatus.working;
  return [
    emptyOfficeHint,
    awayMonitorText,
    resumedBubble,
    reportVisitBubble,
    askParentSummary,
    waitingReportsSummary,
    waitingPrefix,
    freeSummary,
    unassignedClusterTitle,
    noTeamPlaceholderHint,
    createDepartmentLabel,
    emptyDepartmentHint,
    myDeskHeaderLabel(0),
    myDeskHeaderLabel(3),
    for (final s in LegendSlot.values) ...[s.icon, s.label],
    for (final r in MemberRank.values) ...[rankBadgeLabel(r), rankBadgeAt(r, 1.0), rankBadgeAt(r, 0.6), r.mark, r.label],
    for (final s in MemberStatus.values) summarize(s, null),
    for (final d in DerivedStatus.values) summarize(MemberStatus.idle, null, derived: d),
    for (final k in OfficeEventKind.values) summarize(w, event('m', k, detail: {'path': 'a/b.dart', 'cmd': 'ls', 'text': 'hi'})),
    summarize(w, event('m', OfficeEventKind.running, detail: {'waiting': 'shell-lock', 'summary': '셸 대기 중'})),
    summarize(w, event('m', OfficeEventKind.text, detail: const {})),
    summarize(w, null, askingParent: true),
  ];
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('T33 서체 배선', () {
    test('캔버스는 Galmuri11, 못 내는 글자는 **번들 서체**가 먼저 대신한다', () {
      expect(officeFontFamily, 'Galmuri11');
      // 시스템 서체(Malgun Gothic)는 맨 뒤 — T40 편차 ⑤ 의 원인이 시스템 폴백을 믿은 것이었다.
      expect(officeFontFallback.first, 'D2Coding');
      expect(officeFontFallback, containsAllInOrder(['D2Coding', 'Pretendard']));
      expect(officeFontFallback.last, 'Malgun Gothic');
    });

    test('페인터 기본값이 캔버스 서체다(호출부가 따로 넘기지 않아도 된다)', () {
      final p = OfficePainter(scene: OfficeScene.empty);
      expect(p.fontFamily, officeFontFamily);
      expect(p.fontFamilyFallback, officeFontFallback);
    });

    test('패널·상단 바 테마는 Pretendard + 번들 폴백', () {
      expect(appFontFamily, 'Pretendard');
      expect(appFontFallback, ['D2Coding', 'Galmuri11', 'Malgun Gothic']);
      final theme = pixelOfficeTheme();
      expect(theme.textTheme.bodyMedium?.fontFamily, 'Pretendard');
      expect(theme.textTheme.bodyMedium?.fontFamilyFallback, appFontFallback);
    });

    test('픽셀 서체는 정수 크기에서만 또렷하다 — 캔버스 글자 크기는 반올림', () {
      expect(officeFontPx(11, 1.0), 11);
      expect(officeFontPx(11, 0.75), 8); // 8.25 → 8
      expect(officeFontPx(9, 0.9), 8); // 8.1 → 8
      expect(officeFontPx(12, 1.5), 18);
      expect(officeFontPx(11, 0.6) % 1, 0);
      expect(officeFontPx(1, 0.01), 1); // 하한 1px
    });

    testWidgets('서체 3종이 FontManifest 에 실려 있다', (tester) async {
      final manifest = await rootBundle.loadString('FontManifest.json');
      for (final family in ['Galmuri11', 'Pretendard', 'D2Coding']) {
        expect(manifest, contains('"$family"'), reason: '$family 가 pubspec fonts 에 없다');
      }
      // Pretendard 는 Regular + Bold 두 벌.
      expect(manifest, contains('Pretendard-Regular.otf'));
      expect(manifest, contains('Pretendard-Bold.otf'));
    });

    // `testWidgets` 안에서 dart:io 를 await 하면 가짜 시계 존에 갇혀 영영 안 끝난다 — 동기로 읽는다(T33 함정).
    test('OFL 전문 3개가 에셋 폴더에 있다(재배포 조건)', () {
      for (final f in ['Galmuri-OFL.txt', 'Pretendard-OFL.txt', 'D2Coding-OFL.txt']) {
        final file = File('assets/fonts/$f');
        expect(file.existsSync(), isTrue, reason: '$f 가 없다');
        expect(file.readAsStringSync(), contains('SIL OPEN FONT LICENSE'), reason: '$f 가 OFL 전문이 아니다');
      }
    });
  });

  group('T33 글자 허용 목록(T40 편차 ⑤ 회귀)', () {
    test('앱 문구의 기호는 전부 번들 서체 안에 있다', () {
      final used = symbolsIn(appTexts());
      final unknown = used.where((g) => !bundledGlyphs.containsKey(g)).toList()..sort();
      expect(unknown, isEmpty,
          reason: '동봉 서체에 있는지 확인되지 않은 기호: '
              '${unknown.map((g) => '$g(U+${g.runes.first.toRadixString(16).toUpperCase().padLeft(4, '0')})').join(' ')}');
    });

    test('두부로 나왔던 이모지는 하나도 남아 있지 않다', () {
      final all = appTexts().join('\n');
      for (final g in bannedGlyphs) {
        expect(all.contains(g), isFalse, reason: '$g 는 동봉 서체 셋 중 어디에도 없다');
      }
    });

    test('바꾼 기호가 같은 뜻으로 제자리에 있다', () {
      expect(LegendSlot.waitingReports.icon, '✉');
      expect(LegendSlot.waiting.icon, '◷');
      expect(waitingReportsSummary, '✉ 보고 대기');
      expect(waitingPrefix, '◷');
      expect(reportVisitBubble, '▤ 보고');
      expect(summarize(MemberStatus.working, event('m', OfficeEventKind.reading, detail: {'path': 'a/b.dart'})), '◫ b.dart');
      expect(summarize(MemberStatus.working, event('m', OfficeEventKind.reporting)), '▤ 보고');
      expect(summarize(MemberStatus.working, event('m', OfficeEventKind.text, detail: {'text': '끝'})), '❝ 끝');
    });

    test('Galmuri11 에만 있는 ❗❓ 와 D2Coding 에만 있는 ♛ 는 그대로 쓴다(폴백이 받아 준다)', () {
      expect(LegendSlot.myTurn.icon, '❗');
      expect(askParentSummary, startsWith('❓'));
      expect(MemberRank.head.mark, '♛');
      expect(bundledGlyphs['♛'], 'D2Coding');
      expect(officeFontFallback, contains('D2Coding'));
      expect(appFontFallback, contains('D2Coding'));
      expect(appFontFallback, contains('Galmuri11'));
    });
  });
}
