// 스프라이트 아틀라스(T33 · D-43 2·3·5). 페인터가 원 대신 그리는 **픽셀 캐릭터·소품·아이콘**.
//
// 아틀라스: `assets/sprites/characters.png` 256×96 = **32×32 셀 8열 × 3줄**. 생성기는 `tool/gen_sprites.dart`
// (출처·라이선스는 `assets/LICENSES.md` — Kenney CC0 팩에 포즈·걷기 프레임이 없어 직접 그렸다).
//   줄 0 포즈 8종: idle · type1 · type2 · think · alert · ask · report · error
//   줄 1 걷기: 왼쪽 4프레임 · 오른쪽 4프레임(왼쪽의 좌우 반전)
//   줄 2 소품·아이콘: 왕관 · 별 · 의자 + 봉투 · 모래시계 · 경고 · 느낌표 · 물음표
//
// **배율은 정수만**(D-43 3): `OfficeLayout.spriteScale`(scale ≥ 0.75 → 2, 아니면 1). 그리는 자리도
// [alignSpriteRect] 로 정수 픽셀에 맞추고 `FilterQuality.none` 으로 그린다 — 픽셀아트는 보간하면 죽는다.
//
// **외형**(D-43 5): 셔츠는 엔진별(Claude `#E0956E` · Codex `#8FB4FF`), 머리는 이름 해시 4종. 아틀라스에는
// 셔츠 `#FF00FF` · 머리 `#00FFFF`(각각 그늘 키 하나씩)로 그려 두고, 불러올 때 **픽셀 한 판**으로 바꿔
// 엔진 2 × 머리 4 = 8벌을 캐시한다([SpriteSheet.load]). 직급은 왕관/별 소품으로만 구분한다.
//
// 이 파일의 매핑·프레임 계산은 전부 순수 함수다 — 이미지 없이 단위 테스트한다.

import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/services.dart';

import '../model/models.dart';
import 'office_scene.dart';

/// 아틀라스 에셋 경로(pubspec `assets:` 에 선언).
const String spriteAtlasAsset = 'assets/sprites/characters.png';

/// 셀 한 변(px). `OfficeLayout.spriteCellPx` 와 같은 값이다.
const double spriteCell = 32;

const int spriteAtlasColumns = 8;
const int spriteAtlasRows = 3;

/// 아틀라스 줄 번호.
const int spritePoseRow = 0;
const int spriteWalkRow = 1;
const int spritePropRow = 2;

/// 걷기 한 프레임이 유지되는 이동 거리(px). 거리 기준이라 느리게 걸으면 느리게 움직인다.
const double walkFramePx = 14;

/// 타이핑은 2프레임 **0.5초**(D-43 2).
const Duration typeFrameDuration = Duration(milliseconds: 500);

// ---- 포즈 -------------------------------------------------------------------------

/// 포즈 8종(D-43 2). 13가지 코드 상태가 [spritePoseFor] 로 여기 8개에 떨어진다.
/// `gone` 은 캐릭터를 그리지 않는다 — 책상에 [SpriteProp.chair] 만 남는다.
enum SpritePose { idle, type, think, alert, ask, report, error, gone }

/// 줄 0 에서의 열. `type` 만 2프레임(1·2열)이다.
int spritePoseColumn(SpritePose pose, {int frame = 0}) => switch (pose) {
      SpritePose.idle => 0,
      SpritePose.type => frame.isEven ? 1 : 2,
      SpritePose.think => 3,
      SpritePose.alert => 4,
      SpritePose.ask => 5,
      SpritePose.report => 6,
      SpritePose.error => 7,
      SpritePose.gone => 0,
    };

/// 셀 [col],[row] 의 아틀라스 좌표.
Rect spriteAtlasCell(int col, int row) => Rect.fromLTWH(col * spriteCell, row * spriteCell, spriteCell, spriteCell);

/// 포즈 하나의 아틀라스 좌표.
Rect spritePoseSrc(SpritePose pose, {int frame = 0}) => spriteAtlasCell(spritePoseColumn(pose, frame: frame), spritePoseRow);

/// 걷기 프레임의 아틀라스 좌표(왼쪽 0..3 = 열 0..3, 오른쪽 = 열 4..7).
Rect spriteWalkSrc(int frame, {required bool facingLeft}) =>
    spriteAtlasCell((facingLeft ? 0 : 4) + (frame % 4), spriteWalkRow);

/// 코드 상태 → 포즈(레이아웃-v2 패스 7 등록부 표). 상태 어휘의 단일 기준인 [LegendSlot] 을 받는다 —
/// 링 색과 포즈가 어긋나지 않게 **같은 입력**에서 갈라진다.
///
/// - 퇴근 → gone(의자만) · 오류 → error
/// - 보고 방문 중이거나 마지막 이벤트가 reporting → report
/// - `ask_parent` 답 대기 → ask (같은 "대기" 칸이어도 셸 락·출근 중과 포즈가 다르다)
/// - 내 차례(허가·질문) → alert
/// - 대기(셸 락·출근 중) · 보고 대기 · 한가 → idle
/// - 작업 → type, 단 마지막 이벤트가 thinking 이면 think
SpritePose spritePoseFor({
  required LegendSlot slot,
  OfficeEventKind? eventKind,
  bool askingParent = false,
  bool visiting = false,
}) {
  if (slot == LegendSlot.exited) return SpritePose.gone;
  if (slot == LegendSlot.error) return SpritePose.error;
  if (visiting || eventKind == OfficeEventKind.reporting) return SpritePose.report;
  if (askingParent) return SpritePose.ask;
  if (slot == LegendSlot.myTurn) return SpritePose.alert;
  if (slot == LegendSlot.working) {
    return eventKind == OfficeEventKind.thinking ? SpritePose.think : SpritePose.type;
  }
  return SpritePose.idle; // 한가 · 보고 대기 · 대기(셸 락·출근 중)
}

/// 장면 멤버의 포즈. [visiting] 은 지금 내 책상에 보고하러 와 있는가(OfficeMotion).
SpritePose spritePoseOf(SceneMember m, {bool visiting = false}) => spritePoseFor(
      slot: m.legendSlot,
      eventKind: m.eventKind,
      askingParent: m.isAskingParent,
      visiting: visiting,
    );

/// 지금 시각의 타이핑 프레임(0 또는 1).
int typeFrameAt(Duration now) => (now.inMilliseconds ~/ typeFrameDuration.inMilliseconds).abs() % 2;

/// 이만큼 걸어왔을 때의 걷기 프레임(0..3).
int walkFrameFor(double travelledPx) => ((travelledPx.abs() / walkFramePx).floor()) % 4;

/// 걷는 중인 멤버의 프레임·방향.
class SpriteWalk {
  const SpriteWalk({required this.frame, required this.facingLeft});

  final int frame;
  final bool facingLeft;

  @override
  bool operator ==(Object other) => other is SpriteWalk && other.frame == frame && other.facingLeft == facingLeft;

  @override
  int get hashCode => Object.hash(frame, facingLeft);

  @override
  String toString() => 'SpriteWalk($frame ${facingLeft ? '←' : '→'})';
}

// ---- 소품 · 아이콘 ------------------------------------------------------------------

/// 줄 2 의 소품·아이콘. 순서가 곧 열 번호다(생성기 `propColumns` 와 같은 순서).
enum SpriteProp {
  /// 부장 왕관(금색).
  crown(0, Rect.fromLTWH(8, 11, 16, 12)),

  /// 팀장 별(은색).
  star(1, Rect.fromLTWH(10, 11, 12, 10)),

  /// 퇴근한 책상에 남는 의자.
  chair(2, Rect.fromLTWH(8, 8, 16, 18)),

  /// 아래 다섯은 **흰 실루엣** — 페인터가 `ColorFilter.srcIn` 으로 범례 색을 입힌다.
  envelope(3, Rect.fromLTWH(10, 12, 12, 8)),
  hourglass(4, Rect.fromLTWH(11, 11, 10, 9)),
  warning(5, Rect.fromLTWH(10, 11, 12, 10)),
  exclam(6, Rect.fromLTWH(14, 11, 4, 9)),
  question(7, Rect.fromLTWH(13, 11, 6, 9));

  const SpriteProp(this.column, this.inCell);

  final int column;

  /// 셀 안에서 실제로 칠해진 부분(투명 여백 제외). `tool/gen_sprites.dart --bounds` 가 내는 값이고,
  /// `office_sprites_test` 가 실제 PNG 와 대조한다 — 그림을 고치면 테스트가 먼저 알려 준다.
  final Rect inCell;

  /// 아틀라스 좌표(여백을 뺀 실제 그림만).
  Rect get src => inCell.shift(Offset(column * spriteCell, spritePropRow * spriteCell));

  /// 색을 입히는 아이콘인가(흰 실루엣).
  bool get isTintable => index >= SpriteProp.envelope.index;
}

/// 범례 칸에 그릴 아이콘(없으면 null — 작업·한가·퇴근은 점만).
SpriteProp? legendPropFor(LegendSlot slot) => switch (slot) {
      LegendSlot.waitingReports => SpriteProp.envelope,
      LegendSlot.myTurn => SpriteProp.exclam,
      LegendSlot.waiting => SpriteProp.hourglass,
      LegendSlot.error => SpriteProp.warning,
      LegendSlot.working || LegendSlot.idle || LegendSlot.exited => null,
    };

/// 직급 배지에 그릴 소품(팀원은 없음).
SpriteProp? rankPropFor(MemberRank rank) => switch (rank) {
      MemberRank.head => SpriteProp.crown,
      MemberRank.lead => SpriteProp.star,
      MemberRank.member => null,
    };

// ---- 자리 맞추기 --------------------------------------------------------------------

/// 캐릭터 발치가 셀 가운데에서 얼마나 아래인가(배율 [scale] 적용). 아틀라스의 다리는 셀 y 27 쯤에서 끝나고
/// 셀 가운데는 16 이라 12px 아래다. 상태 링을 여기 놓으면 "바닥에 놓인 표시" 로 읽힌다([ringCenter]).
double spriteFeetDy(int scale) => 12.0 * scale;

/// 픽셀아트는 **정수 위치**에 놓아야 뭉개지지 않는다 — 왼쪽 위를 정수 픽셀로 반올림한다.
/// 크기는 이미 `셀 × 정수 배율` 이라 건드리지 않는다.
Rect alignSpriteRect(Rect r) => Rect.fromLTWH(r.left.roundToDouble(), r.top.roundToDouble(), r.width, r.height);

/// 소품 [prop] 을 [center] 에 [scale] 배(정수)로 놓을 자리.
Rect spritePropRect(SpriteProp prop, Offset center, int scale) => alignSpriteRect(Rect.fromCenter(
      center: center,
      width: prop.inCell.width * scale,
      height: prop.inCell.height * scale,
    ));

/// 소품 [prop] 을 높이 [height] 에 맞춰(가로세로 비 유지) [center] 에 놓을 자리.
/// 범례 아이콘처럼 배율이 아니라 **줄 높이**가 정하는 곳에서 쓴다. 높이는 정수로 내림한다.
Rect spritePropRectForHeight(SpriteProp prop, Offset center, double height) {
  final h = height.floorToDouble().clamp(1.0, double.infinity);
  final w = (prop.inCell.width / prop.inCell.height * h).roundToDouble();
  return alignSpriteRect(Rect.fromCenter(center: center, width: w, height: h));
}

// ---- 외형(셔츠·머리) ----------------------------------------------------------------

/// 아틀라스에 남겨 둔 교체 키(생성기와 같은 값, 0xAARRGGBB).
const int shirtKeyArgb = 0xFFFF00FF;
const int shirtKeyDarkArgb = 0xFFC000C0;
const int hairKeyArgb = 0xFF00FFFF;
const int hairKeyDarkArgb = 0xFF00C0C0;

/// 그늘은 원색을 이만큼 어둡게.
const double spriteShadeAmount = 0.3;

Color spriteShade(Color c) => Color.lerp(c, const Color(0xFF000000), spriteShadeAmount)!;

/// 엔진별 셔츠 색(D-43 5 — 책상 엔진 배지와 같은 색이라 한눈에 이어진다).
const Color shirtClaude = Color(0xFFE0956E);
const Color shirtCodex = Color(0xFF8FB4FF);

Color shirtColorFor(Engine engine) => engine == Engine.claude ? shirtClaude : shirtCodex;

/// 이름 해시로 고르는 머리색 4종(D-43 5 — 8명이 똑같아 보이지 않게).
const List<Color> hairColors = [
  Color(0xFF3F2A1F), // 흑갈
  Color(0xFF8A5A3A), // 갈색
  Color(0xFFD9B46A), // 금발
  Color(0xFFB0555A), // 적발
];

/// FNV-1a — 실행마다 같은 값이어야 해서 `String.hashCode` 를 쓰지 않는다.
int spriteNameHash(String name) {
  var h = 0x811C9DC5;
  for (final r in name.runes) {
    h = ((h ^ r) * 0x01000193) & 0xFFFFFFFF;
  }
  return h;
}

int hairIndexFor(String name) => spriteNameHash(name) % hairColors.length;

Color hairColorFor(String name) => hairColors[hairIndexFor(name)];

/// 아틀라스 RGBA 바이트에서 교체 키 4색을 실제 셔츠·머리색으로 바꾼다. **순수 함수**(원본은 안 건드린다).
Uint8List recolorAtlas(Uint8List rgba, {required Color shirt, required Color hair}) {
  final out = Uint8List.fromList(rgba);
  final map = <int, Color>{
    shirtKeyArgb: shirt,
    shirtKeyDarkArgb: spriteShade(shirt),
    hairKeyArgb: hair,
    hairKeyDarkArgb: spriteShade(hair),
  };
  final keys = {for (final e in map.entries) e.key: _rgbaBytes(e.value)};
  for (var i = 0; i + 3 < out.length; i += 4) {
    if (out[i + 3] != 0xFF) continue; // 반투명·투명은 키가 아니다
    final argb = 0xFF000000 | (out[i] << 16) | (out[i + 1] << 8) | out[i + 2];
    final to = keys[argb];
    if (to == null) continue;
    out[i] = to[0];
    out[i + 1] = to[1];
    out[i + 2] = to[2];
  }
  return out;
}

List<int> _rgbaBytes(Color c) => [
      (c.r * 255).round(),
      (c.g * 255).round(),
      (c.b * 255).round(),
      (c.a * 255).round(),
    ];

// ---- 불러오기 ----------------------------------------------------------------------

/// 색을 바꿔 둔 아틀라스 8벌(엔진 2 × 머리색 4). 앱에서 한 번 불러 계속 쓴다.
class SpriteSheet {
  SpriteSheet._(this._variants);

  /// 이미지 한 장을 8벌 자리에 모두 꽂는다 — 테스트·미리보기에서 진짜 아틀라스를 안 읽고 쓸 때.
  factory SpriteSheet.single(ui.Image image) => SpriteSheet._({
        for (final e in Engine.values)
          for (var h = 0; h < hairColors.length; h++) _key(e, h): image,
      });

  /// 엔진·머리색 조합 → 이미지. 키는 [_key].
  final Map<int, ui.Image> _variants;

  static int _key(Engine engine, int hairIndex) => engine.index * hairColors.length + hairIndex;

  /// 소품·아이콘은 교체 키를 쓰지 않으므로 아무 벌이나 같다.
  ui.Image get props => _variants.values.first;

  /// 이 멤버의 외형(엔진 셔츠 + 이름 해시 머리색).
  ui.Image imageFor(Engine engine, String name) =>
      _variants[_key(engine, hairIndexFor(name))] ?? _variants.values.first;

  int get variantCount => _variants.length;

  /// 아틀라스를 읽어 8벌을 만든다. [bundle] 은 테스트에서 갈아 끼울 수 있다.
  static Future<SpriteSheet> load({AssetBundle? bundle}) async {
    final data = await (bundle ?? rootBundle).load(spriteAtlasAsset);
    final codec = await ui.instantiateImageCodec(data.buffer.asUint8List());
    final frame = await codec.getNextFrame();
    final base = frame.image;
    final bytes = (await base.toByteData(format: ui.ImageByteFormat.rawRgba))!.buffer.asUint8List();
    final w = base.width, h = base.height;
    base.dispose();

    final variants = <int, ui.Image>{};
    for (final engine in Engine.values) {
      for (var hair = 0; hair < hairColors.length; hair++) {
        final pixels = recolorAtlas(bytes, shirt: shirtColorFor(engine), hair: hairColors[hair]);
        variants[_key(engine, hair)] = await _decode(pixels, w, h);
      }
    }
    return SpriteSheet._(variants);
  }

  static Future<ui.Image> _decode(Uint8List rgba, int w, int h) {
    final done = Completer<ui.Image>();
    ui.decodeImageFromPixels(rgba, w, h, ui.PixelFormat.rgba8888, done.complete);
    return done.future;
  }

  void dispose() {
    // 같은 이미지를 여러 자리에 꽂은 경우([SpriteSheet.single])가 있어 **한 번씩만** 버린다.
    final seen = <ui.Image>{};
    for (final img in _variants.values) {
      if (seen.add(img)) img.dispose();
    }
    _variants.clear();
  }
}
