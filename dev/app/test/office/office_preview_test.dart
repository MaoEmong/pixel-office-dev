// 사무실 캔버스를 PNG 로 렌더링해 눈으로 확인하는 도구(기본 skip).
//   OFFICE_PREVIEW_OUT=<폴더> flutter test test/office/office_preview_test.dart
// 테스트 환경의 기본 글꼴(Ahem)은 네모만 그리므로 Windows 글꼴(맑은 고딕·Segoe UI Emoji·Consolas)을 FontLoader 로 올린다.
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_layout.dart';
import 'package:pixel_office/office/office_motion.dart';
import 'package:pixel_office/office/office_painter.dart';
import 'package:pixel_office/office/office_scene.dart';

import 'office_fixtures.dart';

final outDir = Platform.environment['OFFICE_PREVIEW_OUT'];

Future<bool> loadFont(String family, String file) async {
  final f = File('C:/Windows/Fonts/$file');
  if (!f.existsSync()) return false;
  final loader = FontLoader(family)..addFont(Future.value(ByteData.sublistView(await f.readAsBytes())));
  await loader.load();
  return true;
}

Future<void> render(
  OfficeScene scene,
  Size size,
  String name, {
  String? selected,
  List<CharacterPlacement>? placements,
  Map<String, double> bob = const {},
  Map<String, String> bubbleOverrides = const {},
}) async {
  final rec = ui.PictureRecorder();
  final canvas = Canvas(rec);
  OfficePainter(
    scene: scene,
    selectedMemberId: selected,
    fontFamily: 'Malgun Gothic',
    fontFamilyFallback: const ['Segoe UI Emoji', 'Segoe UI Symbol'],
    placements: placements,
    bob: bob,
    bubbleOverrides: bubbleOverrides,
  ).paint(canvas, size);
  final img = await rec.endRecording().toImage(size.width.toInt(), size.height.toInt());
  final png = await img.toByteData(format: ui.ImageByteFormat.png);
  final path = '$outDir/$name.png';
  File(path).writeAsBytesSync(png!.buffer.asUint8List());
  // ignore: avoid_print
  print('wrote $path');
}

void main() {
  testWidgets('사무실 미리보기 PNG', (tester) async {
    // 실제 파일 IO 는 FakeAsync 존 밖(runAsync)에서만 끝난다 — 밖에서 await 하면 영원히 멈춘다.
    await tester.runAsync(() async {
      await loadFont('Malgun Gothic', 'malgun.ttf');
      await loadFont('Segoe UI Emoji', 'seguiemj.ttf');
      await loadFont('Segoe UI Symbol', 'seguisym.ttf');
      await loadFont('Consolas', 'consola.ttf');
    });

    final members = {
      'm1': member('m1', name: '하루', status: MemberStatus.working, createdAt: '1'),
      'm2': member('m2', name: '모시', status: MemberStatus.working, engine: Engine.codex, createdAt: '2'),
      'm3': member('m3', name: '이음', status: MemberStatus.waitingApproval, createdAt: '3'),
      'm4': member('m4', name: '신입', status: MemberStatus.idle, createdAt: '4'),
      'm5': member('m5', name: '퇴근자', status: MemberStatus.exited, createdAt: '5'),
      'm6': member('m6', name: '질문이', status: MemberStatus.waitingAnswer, engine: Engine.codex, createdAt: '6'),
    };
    final latest = {
      'm1': event('m1', OfficeEventKind.editing, detail: {'tool': 'Edit', 'path': 'lib/map/tiles.dart'}),
      'm2': event('m2', OfficeEventKind.running, detail: {'tool': 'Bash', 'cmd': 'flutter test test/stt_test.dart --reporter expanded'}),
      'm3': event('m3', OfficeEventKind.waitingApproval, detail: {'tool': 'Bash', 'cmd': 'rm -rf build/'}),
      'm4': event('m4', OfficeEventKind.idle),
      'm6': event('m6', OfficeEventKind.asking, detail: {'summary': '어느 폴더에 둘까요?'}),
    };
    final pending = {
      'a1': approval('a1', 'm3', 'rm -rf build/ && flutter build apk', createdAt: '2026-09-15T00:00:02Z'),
      'q1': question('q1', 'm6', '어느 폴더에 둘까요?', createdAt: '2026-09-15T00:00:01Z'),
    };
    final scene = OfficeScene.build(members: members, latestEvents: latest, pending: pending);

    // T16 한 프레임: 이음(m3)이 자리 → 줄 자리 절반쯤 걷는 중, 신입(m4)이 보고하러 와서 줄 뒤에 서 있음, 하루(m1)는 흔들림.
    const size = Size(1000, 700);
    final layout = OfficeLayout(size: size, deskCount: scene.members.length);
    final motion = OfficeMotion();
    final t16Members = {...members, 'm4': member('m4', name: '신입', status: MemberStatus.idle, createdAt: '4')};
    final t16Latest = {...latest, 'm4': event('m4', OfficeEventKind.reporting, seq: 9)};
    final t16Scene = OfficeScene.build(members: t16Members, latestEvents: t16Latest, pending: pending);
    // 첫 sync 는 즉시 배치 → 이음을 자리에 두었다가 두 번째 sync 로 줄 세우면 걷기 시작.
    motion.sync(OfficeScene.build(members: {...t16Members, 'm3': member('m3', name: '이음', status: MemberStatus.working, createdAt: '3')}, latestEvents: t16Latest, pending: pending), layout, Duration.zero);
    motion.sync(t16Scene, layout, Duration.zero);
    final walk = motion.movements['m3']!;
    final half = Duration(milliseconds: walk.durationMs ~/ 2);

    await tester.runAsync(() async {
      await render(scene, size, 'T12-office', selected: 'm3');
      await render(scene, const Size(640, 520), 'T12-office-narrow');
      await render(OfficeScene.empty, size, 'T12-office-empty');
      await render(t16Scene, size, 'T16-office-walk',
          selected: 'm3', placements: motion.placementsAt(half), bob: motion.bobAt(const Duration(milliseconds: 250)), bubbleOverrides: motion.bubbleOverrides);
    });
  }, skip: outDir == null); // OFFICE_PREVIEW_OUT 미설정이면 건너뜀
}
