// T33 스프라이트 — 포즈 매핑 · 프레임 · 정수 배율 · 색 교체 · 소품, 그리고 페인터가 실제로 무엇을 그리는지.
//
// 앞 절반은 이미지 없이 도는 순수 함수 테스트, 뒤 절반은 가짜 아틀라스 한 장([SpriteSheet.single])을 꽂고
// `drawImageRect` 호출을 [_Recorder] 로 받아 센다(office_painter_test 의 대역과 같은 수법, 이미지 판만 추가).
// 마지막 그룹은 실제 PNG 를 읽어 [SpriteProp.inCell] 상수가 그림과 맞는지 본다 — 그림을 고치면 여기서 걸린다.

import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/model/models.dart';
import 'package:pixel_office/office/office_layout.dart';
import 'package:pixel_office/office/office_motion.dart';
import 'package:pixel_office/office/office_painter.dart';
import 'package:pixel_office/office/office_scene.dart';
import 'package:pixel_office/office/office_sprites.dart';

import 'office_fixtures.dart';

const canvasSize = Size(1000, 700);

SceneMember sceneMember({
  String id = 'm1',
  String name = '이음',
  Engine engine = Engine.claude,
  MemberStatus status = MemberStatus.idle,
  MemberRank rank = MemberRank.member,
  int deskIndex = 0,
  OfficeEventKind? eventKind,
  DerivedStatus? derived,
  int? askParentDeskIndex,
  int? queueIndex,
  bool shellWaiting = false,
}) =>
    SceneMember(
      id: id,
      name: name,
      engine: engine,
      status: status,
      rank: rank,
      deskIndex: deskIndex,
      summary: '',
      isAlert: false,
      eventKind: eventKind,
      eventSeq: eventKind == null ? null : 1,
      derived: derived,
      askParentDeskIndex: askParentDeskIndex,
      queueIndex: queueIndex,
      isShellWaiting: shellWaiting,
    );

/// 부장 + 팀 하나(팀장 + 팀원) — 살아 있는 팀이어야 퇴근 책상이 남는다(T40a 함정 6).
OfficeScene teamScene({MemberStatus crewStatus = MemberStatus.idle, Map<String, OfficeEvent> events = const {}}) =>
    OfficeScene.build(
      members: {
        'mH': head('mH', name: '부장', createdAt: '0'),
        'mL': lead('mL', name: '반장', teamId: 't0', parentId: 'mH', status: MemberStatus.working, createdAt: '1'),
        'm1': member('m1', name: '이음', teamId: 't0', parentId: 'mL', status: crewStatus, createdAt: '2'),
      },
      latestEvents: events,
      pending: const {},
      teams: {'t0': team('t0', name: 't0', createdAt: '0')},
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // ---- 포즈 매핑(D-43 2 · 레이아웃-v2 패스 7 표) -------------------------------------

  group('13가지 상태 → 포즈 8종', () {
    void poseIs(String what, SceneMember m, SpritePose expected, {bool visiting = false}) {
      test(what, () => expect(spritePoseOf(m, visiting: visiting), expected));
    }

    poseIs('작업(reading) → type', sceneMember(status: MemberStatus.working, eventKind: OfficeEventKind.reading), SpritePose.type);
    poseIs('작업(editing) → type', sceneMember(status: MemberStatus.working, eventKind: OfficeEventKind.editing), SpritePose.type);
    poseIs('작업(running) → type', sceneMember(status: MemberStatus.working, eventKind: OfficeEventKind.running), SpritePose.type);
    poseIs('작업(이벤트 없음) → type', sceneMember(status: MemberStatus.working), SpritePose.type);
    poseIs('thinking → think', sceneMember(status: MemberStatus.working, eventKind: OfficeEventKind.thinking), SpritePose.think);
    poseIs('위임(delegating) → type', sceneMember(status: MemberStatus.working, eventKind: OfficeEventKind.delegating),
        SpritePose.type);
    poseIs('한가(idle) → idle', sceneMember(status: MemberStatus.idle), SpritePose.idle);
    poseIs('한가(free) → idle', sceneMember(status: MemberStatus.idle, derived: DerivedStatus.free), SpritePose.idle);
    poseIs('보고 대기 → idle', sceneMember(status: MemberStatus.idle, derived: DerivedStatus.waitingReports), SpritePose.idle);
    poseIs('내 차례(허가) → alert', sceneMember(status: MemberStatus.waitingApproval), SpritePose.alert);
    poseIs('내 차례(부장 ask_user) → alert', sceneMember(status: MemberStatus.idle, derived: DerivedStatus.waitingAnswer),
        SpritePose.alert);
    poseIs('내 차례(내 책상 줄) → alert', sceneMember(status: MemberStatus.idle, queueIndex: 0), SpritePose.alert);
    poseIs('대기(ask_parent) → ask', sceneMember(status: MemberStatus.waitingAnswer, askParentDeskIndex: 0), SpritePose.ask);
    poseIs('대기(셸 락) → idle', sceneMember(status: MemberStatus.working, shellWaiting: true), SpritePose.idle);
    poseIs('대기(출근 중) → idle', sceneMember(status: MemberStatus.starting), SpritePose.idle);
    poseIs('오류 → error', sceneMember(status: MemberStatus.error), SpritePose.error);
    poseIs('퇴근 → gone', sceneMember(status: MemberStatus.exited), SpritePose.gone);
    poseIs('보고(reporting 이벤트) → report',
        sceneMember(status: MemberStatus.working, eventKind: OfficeEventKind.reporting), SpritePose.report);
    poseIs('보고 방문 중 → report', sceneMember(status: MemberStatus.idle), SpritePose.report, visiting: true);

    test('퇴근·오류는 보고 방문보다 앞선다(먼저 걸러진다)', () {
      expect(spritePoseOf(sceneMember(status: MemberStatus.exited), visiting: true), SpritePose.gone);
      expect(spritePoseOf(sceneMember(status: MemberStatus.error), visiting: true), SpritePose.error);
    });

    test('포즈 8종이 아틀라스 열 8개를 덮는다(type 만 2프레임)', () {
      expect(SpritePose.values, hasLength(8));
      final columns = {
        for (final p in SpritePose.values)
          if (p != SpritePose.gone) spritePoseColumn(p),
      };
      expect(columns, {0, 1, 3, 4, 5, 6, 7});
      expect(spritePoseColumn(SpritePose.type, frame: 0), 1);
      expect(spritePoseColumn(SpritePose.type, frame: 1), 2);
    });

    test('범례 칸과 포즈는 같은 입력에서 갈라진다 — 매핑이 어긋나지 않는다', () {
      for (final status in MemberStatus.values) {
        final m = sceneMember(status: status);
        expect(spritePoseOf(m), spritePoseFor(slot: m.legendSlot, eventKind: m.eventKind));
      }
    });
  });

  // ---- 프레임 ----------------------------------------------------------------------

  group('프레임 타이밍', () {
    test('타이핑은 2프레임 0.5초(D-43 2)', () {
      expect(typeFrameDuration, const Duration(milliseconds: 500));
      expect(typeFrameAt(Duration.zero), 0);
      expect(typeFrameAt(const Duration(milliseconds: 499)), 0);
      expect(typeFrameAt(const Duration(milliseconds: 500)), 1);
      expect(typeFrameAt(const Duration(milliseconds: 999)), 1);
      expect(typeFrameAt(const Duration(milliseconds: 1000)), 0);
      expect(typeFrameAt(const Duration(seconds: 7, milliseconds: 500)), 1);
    });

    test('걷기 프레임은 **걸어온 거리**로 고른다(0..3 순환)', () {
      expect(walkFramePx, 14);
      expect(walkFrameFor(0), 0);
      expect(walkFrameFor(13.9), 0);
      expect(walkFrameFor(14), 1);
      expect(walkFrameFor(28), 2);
      expect(walkFrameFor(42), 3);
      expect(walkFrameFor(56), 0, reason: '한 바퀴');
      expect(walkFrameFor(-20), 1, reason: '거리는 부호가 없다');
    });

    test('걷기 아틀라스 칸: 왼쪽 0..3열 · 오른쪽 4..7열', () {
      expect(spriteWalkSrc(0, facingLeft: true).left, 0);
      expect(spriteWalkSrc(3, facingLeft: true).left, 3 * 32);
      expect(spriteWalkSrc(0, facingLeft: false).left, 4 * 32);
      expect(spriteWalkSrc(3, facingLeft: false).left, 7 * 32);
      expect(spriteWalkSrc(5, facingLeft: true).left, 32, reason: '프레임은 4로 감는다');
      for (final left in [true, false]) {
        for (var f = 0; f < 4; f++) {
          expect(spriteWalkSrc(f, facingLeft: left).top, 32, reason: '걷기는 줄 1');
        }
      }
    });

    test('OfficeMotion.walkAt: 걷는 동안만, 방향은 dx 부호', () {
      final layout = OfficeLayout(size: canvasSize, deskCount: 2);
      final motion = OfficeMotion();
      final scene = OfficeScene(members: [sceneMember(id: 'a', deskIndex: 0)], queue: const []);
      motion.sync(scene, layout, Duration.zero);
      expect(motion.walkAt(Duration.zero), isEmpty, reason: '즉시 배치는 걷는 것이 아니다');

      // 오른쪽 끝 → 왼쪽으로 걷게 만든다(책상 0 자리에서 멀리 떨어진 곳으로).
      final from = layout.seatCenter(0);
      motion.sync(
        OfficeScene(members: [sceneMember(id: 'a', deskIndex: 1)], queue: const []),
        layout,
        const Duration(milliseconds: 1),
      );
      final mv = motion.movements['a'];
      expect(mv, isNotNull);
      final goesLeft = mv!.to.center.dx < from.dx;
      final mid = const Duration(milliseconds: 1) + Duration(milliseconds: mv.durationMs ~/ 2);
      final w = motion.walkAt(mid)['a'];
      expect(w, isNotNull, reason: '걷는 중이면 프레임이 나온다');
      expect(w!.facingLeft, goesLeft);
      expect(w.frame, inInclusiveRange(0, 3));
      expect(motion.walkAt(const Duration(seconds: 30)), isEmpty, reason: '다 걸으면 없다');
    });
  });

  // ---- 정수 배율(D-43 3) --------------------------------------------------------------

  group('정수 배율 · 정수 자리', () {
    test('spriteScale 은 scale 0.75 를 경계로 1 또는 2 (연속 배율과 분리)', () {
      // 폭 → scale: 540→0.6 · 675→0.75 · 900→1.0 · 1440→1.0 · 2080→1.5
      for (final (width, scale, sprite) in [
        (540.0, 0.6, 1),
        (675.0, 0.75, 2),
        (900.0, 1.0, 2),
        (2080.0, 1.5, 2),
      ]) {
        final l = OfficeLayout(size: Size(width, 700), deskCount: 1);
        expect(l.scale, closeTo(scale, 0.001), reason: 'width $width');
        expect(l.spriteScale, sprite, reason: 'width $width');
        expect(l.spriteCell(const Offset(100, 100)).width, 32.0 * sprite);
        expect(l.spriteCell(const Offset(100, 100)).height, 32.0 * sprite);
      }
    });

    test('셀 크기는 언제나 32의 정수배 — 소수 배율이 새어 들지 않는다', () {
      for (var w = 500.0; w <= 2600; w += 37) {
        final l = OfficeLayout(size: Size(w, 700), deskCount: 1);
        expect(l.spriteScale, isIn([1, 2]));
        expect(l.spriteCell(Offset.zero).width % 32, 0);
      }
    });

    test('alignSpriteRect 은 왼쪽 위를 정수로 맞추고 크기는 안 건드린다', () {
      final r = alignSpriteRect(const Rect.fromLTWH(10.4, 20.6, 64, 64));
      expect(r.left, 10);
      expect(r.top, 21);
      expect(r.width, 64);
      expect(r.height, 64);
      // 실제 자리(소수가 나오는 seatCenter)에서도 정수가 된다.
      final l = OfficeLayout(size: const Size(1000, 700), deskCount: 3);
      for (var i = 0; i < 3; i++) {
        final dst = alignSpriteRect(l.spriteCell(l.seatCenter(i)));
        expect(dst.left % 1, 0);
        expect(dst.top % 1, 0);
      }
    });

    test('소품 자리도 정수 · 배율은 정수배', () {
      final r = spritePropRect(SpriteProp.crown, const Offset(100.3, 50.7), 2);
      expect(r.width, SpriteProp.crown.inCell.width * 2);
      expect(r.height, SpriteProp.crown.inCell.height * 2);
      expect(r.left % 1, 0);
      expect(r.top % 1, 0);
      // 높이에 맞추는 쪽(범례 아이콘)도 정수 크기.
      final icon = spritePropRectForHeight(SpriteProp.hourglass, const Offset(20.4, 30.6), 10.7);
      expect(icon.height, 10);
      expect(icon.width % 1, 0);
      expect(icon.left % 1, 0);
    });
  });

  // ---- 외형(셔츠·머리) ----------------------------------------------------------------

  group('외형 — 엔진 셔츠 · 이름 해시 머리색(D-43 5)', () {
    test('셔츠는 엔진 배지와 같은 색', () {
      expect(shirtColorFor(Engine.claude), const Color(0xFFE0956E));
      expect(shirtColorFor(Engine.codex), const Color(0xFF8FB4FF));
      expect(shirtColorFor(Engine.claude), OfficeColors.badgeClaude);
      expect(shirtColorFor(Engine.codex), OfficeColors.badgeCodex);
    });

    test('머리색 4종, 이름이 같으면 항상 같은 색(String.hashCode 를 안 쓴다)', () {
      expect(hairColors, hasLength(4));
      expect(hairIndexFor('이음'), hairIndexFor('이음'));
      expect(spriteNameHash('하루'), spriteNameHash('하루'));
      expect(spriteNameHash('하루'), isNot(spriteNameHash('이음')));
      for (final n in ['', '하루', '이음', '반장', 'Codex-1', '가나다라']) {
        expect(hairIndexFor(n), inInclusiveRange(0, 3));
        expect(hairColorFor(n), hairColors[hairIndexFor(n)]);
      }
    });

    test('네 가지 색이 실제로 갈린다(같은 색만 나오지 않는다)', () {
      final seen = <int>{};
      for (var i = 0; i < 200; i++) {
        seen.add(hairIndexFor('멤버$i'));
      }
      expect(seen, hasLength(4));
    });

    test('recolorAtlas: 교체 키 4색만 바꾸고 나머지는 그대로', () {
      const shirt = Color(0xFFE0956E);
      const hair = Color(0xFF8A5A3A);
      final src = Uint8List.fromList([
        ...[0xFF, 0x00, 0xFF, 0xFF], // 셔츠 키
        ...[0xC0, 0x00, 0xC0, 0xFF], // 셔츠 그늘 키
        ...[0x00, 0xFF, 0xFF, 0xFF], // 머리 키
        ...[0x00, 0xC0, 0xC0, 0xFF], // 머리 그늘 키
        ...[0x10, 0x14, 0x1D, 0xFF], // 외곽선(그대로)
        ...[0x00, 0x00, 0x00, 0x00], // 투명(그대로)
      ]);
      final out = recolorAtlas(src, shirt: shirt, hair: hair);
      int at(int i) => 0xFF000000 | (out[i * 4] << 16) | (out[i * 4 + 1] << 8) | out[i * 4 + 2];
      expect(at(0), shirt.toARGB32());
      expect(at(1), spriteShade(shirt).toARGB32());
      expect(at(2), hair.toARGB32());
      expect(at(3), spriteShade(hair).toARGB32());
      expect(at(4), 0xFF10141D, reason: '외곽선은 키가 아니다');
      expect(out[5 * 4 + 3], 0, reason: '투명은 그대로');
      expect(src[0], 0xFF, reason: '원본은 안 건드린다');
    });

    test('그늘은 원색보다 어둡다', () {
      for (final c in [...hairColors, shirtClaude, shirtCodex]) {
        expect(spriteShade(c).r, lessThan(c.r + 0.001));
        expect(spriteShade(c).computeLuminance(), lessThan(c.computeLuminance()));
      }
    });
  });

  // ---- 소품 · 범례 아이콘 --------------------------------------------------------------

  group('소품 · 아이콘 매핑', () {
    test('범례 7칸 중 아이콘이 있는 4칸만 소품을 쓴다', () {
      expect(legendPropFor(LegendSlot.waitingReports), SpriteProp.envelope);
      expect(legendPropFor(LegendSlot.myTurn), SpriteProp.exclam);
      expect(legendPropFor(LegendSlot.waiting), SpriteProp.hourglass);
      expect(legendPropFor(LegendSlot.error), SpriteProp.warning);
      expect(legendPropFor(LegendSlot.working), isNull);
      expect(legendPropFor(LegendSlot.idle), isNull);
      expect(legendPropFor(LegendSlot.exited), isNull);
      // 글자 아이콘이 있는 칸과 정확히 같은 집합이다.
      final withText = LegendSlot.values.where((s) => s.icon.isNotEmpty).toSet();
      final withProp = LegendSlot.values.where((s) => legendPropFor(s) != null).toSet();
      expect(withProp, withText);
    });

    test('직급은 왕관·별로만(D-43 5)', () {
      expect(rankPropFor(MemberRank.head), SpriteProp.crown);
      expect(rankPropFor(MemberRank.lead), SpriteProp.star);
      expect(rankPropFor(MemberRank.member), isNull);
    });

    test('색을 입히는 것은 아이콘 다섯뿐(왕관·별·의자는 제 색)', () {
      expect(SpriteProp.crown.isTintable, isFalse);
      expect(SpriteProp.star.isTintable, isFalse);
      expect(SpriteProp.chair.isTintable, isFalse);
      for (final p in [SpriteProp.envelope, SpriteProp.hourglass, SpriteProp.warning, SpriteProp.exclam, SpriteProp.question]) {
        expect(p.isTintable, isTrue);
      }
    });

    test('모든 아틀라스 좌표가 256×96 안에 있다', () {
      const w = spriteAtlasColumns * spriteCell, h = spriteAtlasRows * spriteCell;
      for (final p in SpriteProp.values) {
        expect(p.src.right, lessThanOrEqualTo(w), reason: p.name);
        expect(p.src.bottom, lessThanOrEqualTo(h), reason: p.name);
        expect(p.src.top, greaterThanOrEqualTo(spritePropRow * spriteCell));
      }
      for (final pose in SpritePose.values) {
        expect(spritePoseSrc(pose).right, lessThanOrEqualTo(w));
      }
      for (var f = 0; f < 4; f++) {
        expect(spriteWalkSrc(f, facingLeft: false).right, lessThanOrEqualTo(w));
      }
    });
  });

  // ---- 페인터가 실제로 그리는 것 -------------------------------------------------------

  group('페인터 — 원 대신 스프라이트', () {
    late ui.Image fake;
    late SpriteSheet sheet;

    setUpAll(() async {
      fake = await _solidImage(spriteAtlasColumns * spriteCell.toInt(), spriteAtlasRows * spriteCell.toInt());
      sheet = SpriteSheet.single(fake);
    });

    tearDownAll(() => sheet.dispose());

    OfficePainter p(OfficeScene scene, {SpriteSheet? sprites, int typeFrame = 0, Map<String, SpriteWalk> walk = const {}}) =>
        OfficePainter(scene: scene, sprites: sprites ?? sheet, typeFrame: typeFrame, walk: walk);

    test('아틀라스가 있으면 캐릭터를 drawImageRect 로 — 보간 없음, 정수 자리, 32의 배수', () {
      final calls = _images(p(teamScene()));
      expect(calls, isNotEmpty);
      final chars = calls.where((c) => c.src.top == 0).toList();
      expect(chars, hasLength(3), reason: '부장 + 팀장 + 팀원');
      for (final c in chars) {
        expect(c.paint.filterQuality, FilterQuality.none);
        expect(c.paint.isAntiAlias, isFalse);
        expect(c.dst.left % 1, 0);
        expect(c.dst.top % 1, 0);
        expect(c.dst.width % 32, 0);
        expect(c.src.width, 32);
      }
    });

    test('아틀라스가 없으면 예전 원으로 그린다(첫 프레임·미리보기 안전망)', () {
      final withSheet = _images(OfficePainter(scene: teamScene(), sprites: sheet));
      final without = _images(OfficePainter(scene: teamScene()));
      expect(withSheet, isNotEmpty);
      expect(without, isEmpty);
      // 원은 여전히 범례 색으로 칠해진다(T40a 테스트가 보던 그림).
      expect(_circles(OfficePainter(scene: teamScene()), OfficeColors.charWorking), greaterThan(0));
    });

    test('타이핑은 0.5초마다 1열 ↔ 2열', () {
      final scene = teamScene(crewStatus: MemberStatus.working);
      final f0 = _images(p(scene, typeFrame: 0)).map((c) => c.src.left).toSet();
      final f1 = _images(p(scene, typeFrame: 1)).map((c) => c.src.left).toSet();
      expect(f0, contains(1 * 32.0));
      expect(f1, contains(2 * 32.0));
      expect(f0, isNot(contains(2 * 32.0)));
    });

    test('걷는 중이면 포즈 대신 걷기 줄(방향에 따라 좌/우 열)', () {
      final scene = teamScene(crewStatus: MemberStatus.working);
      final left = _images(p(scene, walk: {'m1': const SpriteWalk(frame: 2, facingLeft: true)}));
      expect(left.any((c) => c.src.top == 32 && c.src.left == 2 * 32), isTrue);
      final right = _images(p(scene, walk: {'m1': const SpriteWalk(frame: 2, facingLeft: false)}));
      expect(right.any((c) => c.src.top == 32 && c.src.left == 6 * 32), isTrue);
    });

    test('상태마다 다른 열을 쓴다(오류·내 차례·보고 대기)', () {
      Set<double> columnsFor(OfficeScene s, {Set<String> visiting = const {}}) =>
          _images(OfficePainter(scene: s, sprites: sheet, visitingIds: visiting))
              .where((c) => c.src.top == 0)
              .map((c) => c.src.left / 32)
              .toSet();
      expect(columnsFor(teamScene(crewStatus: MemberStatus.error)), contains(7.0));
      expect(columnsFor(teamScene(crewStatus: MemberStatus.waitingApproval)), contains(4.0));
      expect(columnsFor(teamScene(), visiting: {'m1'}), contains(6.0));
    });

    test('퇴근한 책상 = 의자 소품 + 캐릭터 없음', () {
      final scene = teamScene(crewStatus: MemberStatus.exited);
      final calls = _images(p(scene));
      final chairs = calls.where((c) => c.src.left == SpriteProp.chair.src.left && c.src.top == SpriteProp.chair.src.top);
      expect(chairs, hasLength(1));
      // 캐릭터는 둘(부장·팀장)만 — 퇴근한 팀원은 안 그린다.
      expect(calls.where((c) => c.src.top == 0), hasLength(2));
    });

    test('부장 왕관은 도형이 아니라 소품 — 책상 위 앵커 + 직급 배지 둘', () {
      final calls = _images(p(teamScene()));
      final crowns = calls.where((c) => c.src.left == SpriteProp.crown.src.left && c.src.top == SpriteProp.crown.src.top).toList();
      expect(crowns, hasLength(2), reason: '부장 책상 위 앵커(패스 1 D5) + 책상 라벨의 직급 배지');
      final anchor = crowns.where((c) => c.dst.width == SpriteProp.crown.inCell.width * 2);
      expect(anchor, hasLength(1), reason: '앵커는 spriteScale(1000px 폭 → 2) 배');
      final badge = crowns.where((c) => c.dst.width < SpriteProp.crown.inCell.width * 2);
      expect(badge, hasLength(1), reason: '배지는 글자 높이에 맞춘 작은 왕관');
      // 옛 왕관 도형(drawPath, 금색)은 이제 안 나온다.
      expect(_paths(p(teamScene()), OfficeColors.headMark), 0);
    });

    test('팀장 별은 책상 직급 배지 자리에', () {
      final calls = _images(p(teamScene()));
      expect(calls.where((c) => c.src.left == SpriteProp.star.src.left && c.src.top == SpriteProp.star.src.top), hasLength(1));
    });

    test('범례 아이콘 4개를 범례 색으로 물들여 그린다', () {
      final calls = _images(p(teamScene()));
      for (final slot in [LegendSlot.waitingReports, LegendSlot.myTurn, LegendSlot.waiting, LegendSlot.error]) {
        final prop = legendPropFor(slot)!;
        final hit = calls.where((c) => c.src.left == prop.src.left && c.src.top == prop.src.top).toList();
        expect(hit, isNotEmpty, reason: '${slot.label} 아이콘');
        expect(hit.first.paint.colorFilter, isNotNull, reason: '${slot.label} 은 색을 입혀야 한다');
      }
      // 왕관·의자는 물들이지 않는다.
      final crown = calls.firstWhere((c) => c.src.left == SpriteProp.crown.src.left && c.src.top == SpriteProp.crown.src.top);
      expect(crown.paint.colorFilter, isNull);
    });

    test('링(선택·직급·상태)은 스프라이트 **아래**에 그대로 남는다', () {
      final scene = teamScene(crewStatus: MemberStatus.error);
      // 오류 빨강 링.
      expect(_strokeCircles(p(scene), OfficeColors.charError), greaterThan(0));
      // 선택 흰 링.
      final selected = OfficePainter(scene: teamScene(), sprites: sheet, selectedMemberId: 'm1');
      expect(_strokeCircles(selected, OfficeColors.selectedRing), 1);
      // 부장 금색 직급 링.
      expect(_strokeCircles(p(teamScene()), OfficeColors.headMark), greaterThan(0));
    });

    test('링은 캐릭터 가운데가 아니라 **발치**에 — 좁은 머리 옆으로 삐져나오지 않게', () {
      final layout = OfficeLayout(size: canvasSize, plan: teamScene().plan);
      final center = layout.seatCenter(0);
      final withSprites = OfficePainter(scene: teamScene(), sprites: sheet);
      final without = OfficePainter(scene: teamScene());
      expect(without.ringCenter(layout, center), center, reason: '원으로 그릴 때는 예전 그대로');
      final moved = withSprites.ringCenter(layout, center);
      expect(moved.dx, center.dx);
      expect(moved.dy, center.dy + spriteFeetDy(layout.spriteScale));
      expect(moved.dy, greaterThan(center.dy));
      // 발치는 스프라이트 셀 안에 있다(밖으로 새지 않는다).
      expect(moved.dy, lessThan(layout.spriteCell(center).bottom));
    });
  });

  // ---- 말풍선 자리(T40 편차 ⑥) ---------------------------------------------------------

  group('내 책상 말풍선은 헤더를 안 덮는다(T40 편차 ⑥)', () {
    test('슬롯 대기자·보고 방문자의 말풍선 꼬리는 내 책상 상자 **위**', () {
      final l = OfficeLayout(size: canvasSize, deskCount: 4);
      expect(l.barBubbleY, lessThan(l.myDeskRect.top));
      for (var k = 0; k < mySlotCount; k++) {
        expect(l.queueBubbleAnchor(k).dy, l.barBubbleY);
        expect(l.queueBubbleAnchor(k).dy, lessThan(l.myDeskRect.top), reason: '슬롯 $k');
        expect(l.queueBubbleAnchor(k).dx, l.slotCenter(k).dx, reason: '가로는 슬롯 위 그대로');
      }
      expect(l.reportBubbleAnchor(0).dy, l.barBubbleY);
    });

    test('네 창 크기 전부에서 헤더 글자 위쪽에 있다', () {
      for (final w in [1100.0, 1280.0, 1920.0, 2560.0]) {
        final l = OfficeLayout(size: Size(w, 720), deskCount: 4);
        final headerTop = l.myDeskRect.top + 5 * l.scale;
        expect(l.queueBubbleAnchor(0).dy, lessThan(headerTop), reason: 'width $w');
      }
    });
  });

  // ---- 진짜 아틀라스 -----------------------------------------------------------------

  group('아틀라스 PNG', () {
    test('256×96 이고 교체 키 4색이 실제로 들어 있다', () async {
      final (image, bytes) = await _loadAtlas();
      expect(image.width, 256);
      expect(image.height, 96);
      final present = <int>{};
      for (var i = 0; i + 3 < bytes.length; i += 4) {
        if (bytes[i + 3] != 0xFF) continue;
        present.add(0xFF000000 | (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]);
      }
      for (final key in [shirtKeyArgb, shirtKeyDarkArgb, hairKeyArgb, hairKeyDarkArgb]) {
        expect(present, contains(key), reason: '교체 키 ${key.toRadixString(16)} 가 없다');
      }
      image.dispose();
    });

    test('SpriteProp.inCell 이 그림의 실제 경계와 같다', () async {
      final (image, bytes) = await _loadAtlas();
      for (final prop in SpriteProp.values) {
        expect(_tightBounds(bytes, image.width, prop.column, spritePropRow), prop.inCell, reason: prop.name);
      }
      image.dispose();
    });

    test('포즈 8칸 · 걷기 8칸이 모두 비어 있지 않다', () async {
      final (image, bytes) = await _loadAtlas();
      for (var c = 0; c < spriteAtlasColumns; c++) {
        expect(_tightBounds(bytes, image.width, c, 0).isEmpty, isFalse, reason: '포즈 열 $c');
        expect(_tightBounds(bytes, image.width, c, 1).isEmpty, isFalse, reason: '걷기 열 $c');
      }
      image.dispose();
    });

    test('실제 아틀라스로 8벌을 만든다(엔진 2 × 머리 4)', () async {
      final sheet = await SpriteSheet.load();
      expect(sheet.variantCount, 8);
      expect(sheet.imageFor(Engine.claude, '이음'), isNotNull);
      // 같은 이름이면 같은 벌, 머리색이 다른 이름끼리는 다른 벌.
      expect(identical(sheet.imageFor(Engine.claude, '이음'), sheet.imageFor(Engine.claude, '이음')), isTrue);
      expect(identical(sheet.imageFor(Engine.claude, '이음'), sheet.imageFor(Engine.codex, '이음')), isFalse);
      sheet.dispose();
    });
  });
}

// ---- 도우미 -------------------------------------------------------------------------

Future<ui.Image> _solidImage(int w, int h) {
  final recorder = ui.PictureRecorder();
  Canvas(recorder).drawRect(Rect.fromLTWH(0, 0, w.toDouble(), h.toDouble()), Paint()..color = const Color(0xFFFFFFFF));
  return recorder.endRecording().toImage(w, h);
}

Future<(ui.Image, Uint8List)> _loadAtlas() async {
  final data = await rootBundle.load(spriteAtlasAsset);
  final codec = await ui.instantiateImageCodec(data.buffer.asUint8List());
  final image = (await codec.getNextFrame()).image;
  final bytes = (await image.toByteData(format: ui.ImageByteFormat.rawRgba))!.buffer.asUint8List();
  return (image, bytes);
}

/// 셀 한 칸에서 투명하지 않은 부분의 최소 사각형(셀 기준) — `tool/gen_sprites.dart --bounds` 와 같은 계산.
Rect _tightBounds(Uint8List rgba, int width, int col, int row) {
  var minX = 32, minY = 32, maxX = -1, maxY = -1;
  for (var j = 0; j < 32; j++) {
    for (var i = 0; i < 32; i++) {
      final x = col * 32 + i, y = row * 32 + j;
      if (rgba[(y * width + x) * 4 + 3] == 0) continue;
      if (i < minX) minX = i;
      if (j < minY) minY = j;
      if (i > maxX) maxX = i;
      if (j > maxY) maxY = j;
    }
  }
  return maxX < 0 ? Rect.zero : Rect.fromLTWH(minX.toDouble(), minY.toDouble(), (maxX - minX + 1).toDouble(), (maxY - minY + 1).toDouble());
}

class _ImageCall {
  _ImageCall(this.src, this.dst, this.paint);
  final Rect src;
  final Rect dst;
  final Paint paint;
}

List<_ImageCall> _images(OfficePainter p) {
  final rec = _Recorder();
  p.paint(rec, canvasSize);
  return rec.images;
}

int _count(OfficePainter p, bool Function(Symbol, List<dynamic>) test) {
  final rec = _Recorder(test: test);
  p.paint(rec, canvasSize);
  return rec.hits;
}

bool _same(Color a, Color b) => a.toARGB32() == b.toARGB32();

int _circles(OfficePainter p, Color color) => _count(
    p,
    (s, a) =>
        s == #drawCircle && _same((a[2] as Paint).color, color) && (a[2] as Paint).style == PaintingStyle.fill);

int _strokeCircles(OfficePainter p, Color color) => _count(
    p,
    (s, a) =>
        s == #drawCircle && _same((a[2] as Paint).color, color) && (a[2] as Paint).style == PaintingStyle.stroke);

int _paths(OfficePainter p, Color color) => _count(p, (s, a) => s == #drawPath && _same((a[1] as Paint).color, color));

/// 이미지 호출을 모으고, 필요하면 다른 호출도 세는 Canvas 대역.
class _Recorder implements Canvas {
  _Recorder({this.test});

  final bool Function(Symbol, List<dynamic>)? test;
  final List<_ImageCall> images = [];
  int hits = 0;

  void _hit(Symbol s, List<dynamic> args) {
    if (test?.call(s, args) ?? false) hits++;
  }

  @override
  void drawImageRect(ui.Image image, Rect src, Rect dst, Paint paint) {
    images.add(_ImageCall(src, dst, paint));
    _hit(#drawImageRect, [image, src, dst, paint]);
  }

  @override
  void drawCircle(Offset c, double radius, Paint paint) => _hit(#drawCircle, [c, radius, paint]);

  @override
  void drawRRect(RRect rrect, Paint paint) => _hit(#drawRRect, [rrect, paint]);

  @override
  void drawPath(Path path, Paint paint) => _hit(#drawPath, [path, paint]);

  @override
  void drawRect(Rect rect, Paint paint) => _hit(#drawRect, [rect, paint]);

  @override
  void drawLine(Offset p1, Offset p2, Paint paint) => _hit(#drawLine, [p1, p2, paint]);

  @override
  void drawParagraph(ui.Paragraph paragraph, Offset offset) {}

  @override
  void save() {}

  @override
  void restore() {}

  @override
  void translate(double dx, double dy) {}

  @override
  void clipRect(Rect rect, {ui.ClipOp clipOp = ui.ClipOp.intersect, bool doAntiAlias = true}) {}

  @override
  noSuchMethod(Invocation invocation) => null;
}
