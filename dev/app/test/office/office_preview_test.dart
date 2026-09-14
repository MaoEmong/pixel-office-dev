// 사무실 캔버스를 PNG 로 렌더링해 눈으로 확인하는 도구(기본 skip).
//   OFFICE_PREVIEW_OUT=<폴더> flutter test test/office/office_preview_test.dart
// 테스트 환경의 기본 글꼴(Ahem)은 네모만 그리므로 Windows 글꼴(맑은 고딕·Segoe UI Emoji·Consolas)을 FontLoader 로 올린다.
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
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

Future<void> render(OfficeScene scene, Size size, String name, {String? selected}) async {
  final rec = ui.PictureRecorder();
  final canvas = Canvas(rec);
  OfficePainter(
    scene: scene,
    selectedMemberId: selected,
    fontFamily: 'Malgun Gothic',
    fontFamilyFallback: const ['Segoe UI Emoji', 'Segoe UI Symbol'],
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

    await tester.runAsync(() async {
      await render(scene, const Size(1000, 700), 'T12-office', selected: 'm3');
      await render(scene, const Size(640, 520), 'T12-office-narrow');
      await render(OfficeScene.empty, const Size(1000, 700), 'T12-office-empty');
    });
  }, skip: outDir == null); // OFFICE_PREVIEW_OUT 미설정이면 건너뜀
}
