// 스프라이트 아틀라스 생성기 (T33 · D-43 2). `dart run tool/gen_sprites.dart` 로
// `assets/sprites/characters.png`(256×96, 32×32 셀 8열 × 3줄)를 다시 만든다.
//
// **왜 생성기인가**: D-43 4 는 "CC0 우선(Kenney) 16×16 캐릭터를 2× 로 쓰고 포즈는 직접 편집" 이다.
// 실제로 받아 본 Kenney CC0 팩(roguelike-characters 2.0 · tiny-town)에는 **앉음·타이핑·보고·걷기 프레임이 없다**
// (paperdoll 정면 1포즈 + 장비 레이어, 마을 타일). D-43 이 요구하는 8포즈 + 걷기 4프레임을 만들려면 어차피
// 전부 새로 그려야 해서, **손으로 쓴 픽셀 좌표를 코드로 찍는 방식**으로 그렸다. AI 이미지 생성이 아니라
// 결정론적 도형 코드이므로 D-43 의 "AI 생성 스프라이트 금지" 에 걸리지 않고, 프레임 간 일관성도 코드가 보장한다.
// 라이선스는 이 저장소(CC0) — `assets/LICENSES.md` 참조.
//
// 아틀라스 배치(열 0..7):
//   줄 0 — 포즈 8종: idle · type1 · type2 · think · alert · ask · report · error   (gone 은 캐릭터 없음 = 의자 소품)
//   줄 1 — 걷기: 왼쪽 0..3 · 오른쪽 0..3 (오른쪽은 왼쪽을 좌우 반전한 것 — 프레임 일관성)
//   줄 2 — 소품·아이콘: 왕관 16×16 · 별 12×12 · 의자 16×16 · 봉투 · 모래시계 · 경고 · 느낌표 · 물음표
//          (뒤 다섯 개는 **흰 실루엣** — 페인터가 `ColorFilter.srcIn` 으로 범례 색을 입힌다)
//
// 색 교체 키: 셔츠 `#FF00FF`(그늘 `#C000C0`), 머리 `#00FFFF`(그늘 `#00C0C0`).
// 런타임에서 엔진별 셔츠색 2종 × 이름 해시 머리색 4종 = 8벌로 바꿔 캐시한다(`lib/office/office_sprites.dart`).

import 'dart:io';
import 'dart:typed_data';

// ---- 팔레트 -------------------------------------------------------------------

const int kClear = 0x00000000;
const int kOutline = 0xFF10141D;
const int kSkin = 0xFFF0C9A0;
const int kSkinShade = 0xFFD2A77C;
const int kShirt = 0xFFFF00FF; // 교체 키
const int kShirtDk = 0xFFC000C0; // 교체 키(그늘)
const int kHair = 0xFF00FFFF; // 교체 키
const int kHairDk = 0xFF00C0C0; // 교체 키(그늘)
const int kPants = 0xFF3A4054;
const int kPantsDk = 0xFF2A3042;
const int kPaper = 0xFFF3F4F8;
const int kPaperLine = 0xFF8A93A8;
const int kGold = 0xFFFFD166;
const int kGoldDk = 0xFFC9A24F;
const int kSilver = 0xFFBFC7DA;
const int kSilverDk = 0xFF8A93A8;
const int kAmber = 0xFFFF9F43;
const int kWhite = 0xFFFFFFFF;

const int cell = 32;
const int cols = 8;
const int rows = 3;

// ---- 비트맵 -------------------------------------------------------------------

class Bitmap {
  Bitmap(this.w, this.h) : px = Uint32List(w * h);

  final int w;
  final int h;

  /// 0xAARRGGBB.
  final Uint32List px;

  int get(int x, int y) => (x < 0 || y < 0 || x >= w || y >= h) ? kClear : px[y * w + x];

  void set(int x, int y, int c) {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    px[y * w + x] = c;
  }

  void rect(int x, int y, int rw, int rh, int c) {
    for (var j = 0; j < rh; j++) {
      for (var i = 0; i < rw; i++) {
        set(x + i, y + j, c);
      }
    }
  }

  void hline(int x, int y, int len, int c) => rect(x, y, len, 1, c);

  void vline(int x, int y, int len, int c) => rect(x, y, 1, len, c);

  /// ASCII 도형 — `#` 는 [c], 그 밖의 문자는 건너뛴다.
  void stamp(int x, int y, List<String> art, int c) {
    for (var j = 0; j < art.length; j++) {
      for (var i = 0; i < art[j].length; i++) {
        if (art[j][i] == '#') set(x + i, y + j, c);
      }
    }
  }

  /// 셀 하나를 좌우 반전해 다른 셀에 복사한다(걷기 오른쪽 = 왼쪽의 거울).
  void mirrorCell(int srcX, int srcY, int dstX, int dstY) {
    for (var j = 0; j < cell; j++) {
      for (var i = 0; i < cell; i++) {
        set(dstX + (cell - 1 - i), dstY + j, get(srcX + i, srcY + j));
      }
    }
  }

  /// 셀 한 칸에 1px 외곽선을 두른다 — 투명 픽셀 중 4방향에 그림이 닿은 곳을 외곽선 색으로.
  /// 포즈마다 손으로 외곽선을 찍지 않아도 프레임 간 굵기가 항상 같다.
  void outlineCell(int cx, int cy) {
    final add = <int>[];
    for (var j = 0; j < cell; j++) {
      for (var i = 0; i < cell; i++) {
        final x = cx + i, y = cy + j;
        if (get(x, y) != kClear) continue;
        final touches = get(x - 1, y) != kClear && get(x - 1, y) != kOutline ||
            get(x + 1, y) != kClear && get(x + 1, y) != kOutline ||
            get(x, y - 1) != kClear && get(x, y - 1) != kOutline ||
            get(x, y + 1) != kClear && get(x, y + 1) != kOutline;
        if (touches) add.add(y * w + x);
      }
    }
    for (final i in add) {
      px[i] = kOutline;
    }
  }
}

// ---- 캐릭터 -------------------------------------------------------------------

/// 32×32 셀 안의 몸 좌표(셀 기준). 머리 6..13 · 몸통 15..22 · 다리 23..27 → 세로 가운데 ≈ 16.
class Body {
  const Body({this.dx = 0, this.dy = 0, this.headDx = 0, this.headDy = 0});

  /// 몸 전체 이동(걷기 bob).
  final int dx;
  final int dy;

  /// 머리만 이동(고개 기울임·숙임·바라보는 방향).
  final int headDx;
  final int headDy;
}

void drawHead(Bitmap b, int ox, int oy, Body p, {String eyes = 'open', bool mouthOpen = false}) {
  final x = ox + p.dx + p.headDx;
  final y = oy + p.dy + p.headDy;
  // 얼굴
  b.rect(x + 11, y + 7, 10, 7, kSkin);
  b.rect(x + 11, y + 13, 10, 1, kSkinShade);
  // 머리카락(위 3줄 + 옆 구레나룻)
  b.rect(x + 11, y + 6, 10, 3, kHair);
  b.hline(x + 11, y + 8, 10, kHairDk);
  b.vline(x + 11, y + 9, 2, kHair);
  b.vline(x + 20, y + 9, 2, kHair);
  // 눈
  switch (eyes) {
    case 'open':
      b.set(x + 13, y + 10, kOutline);
      b.set(x + 18, y + 10, kOutline);
    case 'line': // 생각 중 — 반쯤 감은 눈
      b.hline(x + 13, y + 10, 2, kOutline);
      b.hline(x + 17, y + 10, 2, kOutline);
    case 'x': // 오류
      b.set(x + 12, y + 9, kOutline);
      b.set(x + 14, y + 9, kOutline);
      b.set(x + 13, y + 10, kOutline);
      b.set(x + 12, y + 11, kOutline);
      b.set(x + 14, y + 11, kOutline);
      b.set(x + 17, y + 9, kOutline);
      b.set(x + 19, y + 9, kOutline);
      b.set(x + 18, y + 10, kOutline);
      b.set(x + 17, y + 11, kOutline);
      b.set(x + 19, y + 11, kOutline);
  }
  if (mouthOpen) {
    b.rect(x + 15, y + 12, 2, 2, kOutline);
  } else {
    b.hline(x + 15, y + 12, 2, kSkinShade);
  }
}

void drawTorso(Bitmap b, int ox, int oy, Body p) {
  final x = ox + p.dx, y = oy + p.dy;
  b.rect(x + 14, y + 14, 4, 1, kSkinShade); // 목
  b.rect(x + 10, y + 15, 12, 8, kShirt);
  b.hline(x + 10, y + 22, 12, kShirtDk); // 밑단 그늘
  b.vline(x + 21, y + 15, 8, kShirtDk); // 오른쪽 그늘
}

void drawLegs(Bitmap b, int ox, int oy, Body p, {int stride = 0}) {
  final x = ox + p.dx, y = oy + p.dy;
  switch (stride) {
    case 0: // 서 있음
      b.rect(x + 12, y + 23, 3, 5, kPants);
      b.rect(x + 17, y + 23, 3, 5, kPants);
      b.hline(x + 11, y + 27, 4, kPantsDk);
      b.hline(x + 17, y + 27, 4, kPantsDk);
    case 1: // 접지 — 다리를 벌린다
      b.rect(x + 10, y + 23, 3, 5, kPants);
      b.rect(x + 19, y + 23, 3, 5, kPants);
      b.hline(x + 9, y + 27, 4, kPantsDk);
      b.hline(x + 19, y + 27, 4, kPantsDk);
    case 2: // 교차 — 다리를 모은다(반대 위상)
      b.rect(x + 13, y + 23, 3, 4, kPants);
      b.rect(x + 16, y + 23, 3, 4, kPants);
      b.hline(x + 13, y + 26, 3, kPantsDk);
      b.hline(x + 16, y + 26, 3, kPantsDk);
  }
}

/// 팔 한 쪽. [side] -1 = 왼쪽(화면 기준), 1 = 오른쪽.
void drawArm(Bitmap b, int ox, int oy, Body p, int side, {required String pose}) {
  final x = ox + p.dx, y = oy + p.dy;
  final ax = side < 0 ? x + 8 : x + 22;
  final hx = side < 0 ? x + 8 : x + 22;
  switch (pose) {
    case 'down':
      b.rect(ax, y + 16, 2, 6, kShirt);
      b.rect(hx, y + 22, 2, 2, kSkin);
    case 'typeHigh': // 책상 위 — 손이 한 칸 위
      b.rect(ax, y + 16, 2, 4, kShirt);
      b.rect(side < 0 ? x + 9 : x + 21, y + 20, 2, 2, kSkin);
    case 'typeLow':
      b.rect(ax, y + 16, 2, 5, kShirt);
      b.rect(side < 0 ? x + 9 : x + 21, y + 21, 2, 2, kSkin);
    case 'chin': // 턱을 괸다(생각)
      b.rect(ax, y + 17, 2, 3, kShirt);
      b.rect(side < 0 ? x + 10 : x + 20, y + 14, 2, 3, kSkin);
    case 'up': // 손 들기(내 차례)
      b.rect(ax, y + 12, 2, 6, kShirt);
      b.rect(hx, y + 10, 2, 2, kSkin);
    case 'half': // 반쯤 들기(질문)
      b.rect(ax, y + 14, 2, 4, kShirt);
      b.rect(hx, y + 12, 2, 2, kSkin);
    case 'front': // 앞으로(서류를 든다)
      b.rect(ax, y + 16, 2, 4, kShirt);
      b.rect(side < 0 ? x + 9 : x + 21, y + 20, 2, 2, kSkin);
    case 'swingFwd': // 걷기 — 앞으로 나온 팔(몸통 위에 겹친다)
      b.rect(side < 0 ? x + 10 : x + 20, y + 16, 2, 5, kShirtDk);
      b.rect(side < 0 ? x + 10 : x + 20, y + 21, 2, 2, kSkin);
    case 'swingBack':
      b.rect(ax, y + 15, 2, 6, kShirt);
      b.rect(hx, y + 21, 2, 2, kSkin);
  }
}

/// 머리 위 작은 표시(느낌표·물음표·생각 점) — 셀 오른쪽 위 여백을 쓴다.
void drawOverhead(Bitmap b, int ox, int oy, String kind) {
  switch (kind) {
    case 'bang':
      b.rect(ox + 24, oy + 1, 2, 4, kAmber);
      b.rect(ox + 24, oy + 6, 2, 2, kAmber);
    case 'question':
      b.stamp(ox + 23, oy + 1, const ['.###.', '#...#', '...##', '..##.', '..#..', '.....', '..#..'], kAmber);
    case 'dots':
      b.set(ox + 23, oy + 6, kPaper);
      b.set(ox + 25, oy + 5, kPaper);
      b.set(ox + 27, oy + 4, kPaper);
  }
}

void drawPose(Bitmap b, int ox, int oy, String pose) {
  switch (pose) {
    case 'idle':
      const p = Body();
      drawLegs(b, ox, oy, p);
      drawTorso(b, ox, oy, p);
      drawArm(b, ox, oy, p, -1, pose: 'down');
      drawArm(b, ox, oy, p, 1, pose: 'down');
      drawHead(b, ox, oy, p);
    case 'type1':
    case 'type2':
      const p = Body();
      final high = pose == 'type1';
      drawLegs(b, ox, oy, p);
      drawTorso(b, ox, oy, p);
      drawArm(b, ox, oy, p, -1, pose: high ? 'typeHigh' : 'typeLow');
      drawArm(b, ox, oy, p, 1, pose: high ? 'typeLow' : 'typeHigh');
      drawHead(b, ox, oy, p);
    case 'think':
      const p = Body(headDx: 1, headDy: -1);
      drawLegs(b, ox, oy, p);
      drawTorso(b, ox, oy, p);
      drawArm(b, ox, oy, p, -1, pose: 'down');
      drawArm(b, ox, oy, p, 1, pose: 'chin');
      drawHead(b, ox, oy, p, eyes: 'line');
      drawOverhead(b, ox, oy, 'dots');
    case 'alert':
      const p = Body();
      drawLegs(b, ox, oy, p);
      drawTorso(b, ox, oy, p);
      drawArm(b, ox, oy, p, -1, pose: 'down');
      drawArm(b, ox, oy, p, 1, pose: 'up');
      drawHead(b, ox, oy, p, mouthOpen: true);
      drawOverhead(b, ox, oy, 'bang');
    case 'ask':
      const p = Body();
      drawLegs(b, ox, oy, p);
      drawTorso(b, ox, oy, p);
      drawArm(b, ox, oy, p, -1, pose: 'down');
      drawArm(b, ox, oy, p, 1, pose: 'half');
      drawHead(b, ox, oy, p);
      drawOverhead(b, ox, oy, 'question');
    case 'report':
      const p = Body();
      drawLegs(b, ox, oy, p);
      drawTorso(b, ox, oy, p);
      drawArm(b, ox, oy, p, -1, pose: 'front');
      drawArm(b, ox, oy, p, 1, pose: 'front');
      drawHead(b, ox, oy, p);
      // 가슴 앞 서류
      b.rect(ox + 11, oy + 17, 10, 6, kPaper);
      b.hline(ox + 13, oy + 19, 6, kPaperLine);
      b.hline(ox + 13, oy + 21, 6, kPaperLine);
    case 'error':
      const p = Body(headDy: 2);
      drawLegs(b, ox, oy, p);
      drawTorso(b, ox, oy, p);
      drawArm(b, ox, oy, p, -1, pose: 'down');
      drawArm(b, ox, oy, p, 1, pose: 'down');
      drawHead(b, ox, oy, p, eyes: 'x');
    default:
      throw ArgumentError('unknown pose: $pose');
  }
}

/// 걷기 프레임(왼쪽을 향한다). 0·2 는 두 발 모음(2 는 1px 튀어 오른다), 1·3 은 성큼.
void drawWalk(Bitmap b, int ox, int oy, int frame) {
  final bob = (frame == 1 || frame == 3) ? -1 : 0;
  final p = Body(dy: bob, headDx: -1);
  final stride = switch (frame) { 1 => 1, 3 => 2, _ => 0 };
  drawLegs(b, ox, oy, p, stride: stride);
  drawTorso(b, ox, oy, p);
  switch (frame) {
    case 1:
      drawArm(b, ox, oy, p, -1, pose: 'swingBack');
      drawArm(b, ox, oy, p, 1, pose: 'swingFwd');
    case 3:
      drawArm(b, ox, oy, p, -1, pose: 'swingFwd');
      drawArm(b, ox, oy, p, 1, pose: 'swingBack');
    default:
      drawArm(b, ox, oy, p, -1, pose: 'down');
      drawArm(b, ox, oy, p, 1, pose: 'down');
  }
  drawHead(b, ox, oy, p);
}

// ---- 소품 · 아이콘 ----------------------------------------------------------------

/// 왕관 16×16(부장). 셀 가운데에 놓는다.
void drawCrown(Bitmap b, int ox, int oy) {
  b.rect(ox + 9, oy + 13, 2, 9, kGold);
  b.rect(ox + 15, oy + 12, 2, 10, kGold);
  b.rect(ox + 21, oy + 13, 2, 9, kGold);
  b.rect(ox + 11, oy + 17, 4, 5, kGold);
  b.rect(ox + 17, oy + 17, 4, 5, kGold);
  b.rect(ox + 9, oy + 19, 14, 3, kGold);
  b.hline(ox + 9, oy + 21, 14, kGoldDk);
  b.set(ox + 15, oy + 20, kGoldDk);
  b.set(ox + 16, oy + 20, kGoldDk);
}

/// 별 12×12(팀장).
void drawStar(Bitmap b, int ox, int oy) {
  const art = [
    '....##....',
    '...####...',
    '##########',
    '.########.',
    '..######..',
    '..######..',
    '.###..###.',
    '.##....##.',
  ];
  b.stamp(ox + 11, oy + 12, art, kSilver);
  b.hline(ox + 12, oy + 19, 8, kSilverDk);
}

/// 의자 16×16(퇴근한 책상에 남는 것).
void drawChair(Bitmap b, int ox, int oy) {
  b.rect(ox + 11, oy + 9, 10, 7, kPants);
  b.hline(ox + 11, oy + 15, 10, kPantsDk);
  b.rect(ox + 9, oy + 17, 14, 3, kPants);
  b.hline(ox + 9, oy + 19, 14, kPantsDk);
  b.rect(ox + 15, oy + 20, 2, 3, kPantsDk);
  b.rect(ox + 11, oy + 23, 10, 1, kPantsDk);
  b.set(ox + 10, oy + 24, kPantsDk);
  b.set(ox + 21, oy + 24, kPantsDk);
}

/// 범례·배지 아이콘은 **흰 실루엣** — 페인터가 `ColorFilter.srcIn` 으로 색을 입힌다.
const Map<String, List<String>> icons = {
  // 봉투(보고 대기 — 옛 📨)
  'envelope': [
    '############',
    '##........##',
    '#.##....##.#',
    '#..##..##..#',
    '#...####...#',
    '#..........#',
    '#..........#',
    '############',
  ],
  // 모래시계(대기 — 옛 ⏳)
  'hourglass': [
    '##########',
    '.########.',
    '..######..',
    '...####...',
    '....##....',
    '...####...',
    '..######..',
    '.########.',
    '##########',
  ],
  // 경고 삼각형(오류 — ⚠). 가운데 느낌표는 **뚫린 구멍**이다(색을 입혀도 읽힌다).
  'warning': [
    '.....##.....',
    '....####....',
    '....#..#....',
    '...##..##...',
    '...##..##...',
    '..###..###..',
    '..###..###..',
    '.##########.',
    '.####..####.',
    '############',
  ],
  // 느낌표(내 차례 — ❗)
  'exclam': [
    '####',
    '####',
    '####',
    '####',
    '####',
    '####',
    '....',
    '####',
    '####',
  ],
  // 물음표
  'question': [
    '..####..',
    '.##..##.',
    '.##..##.',
    '....##..',
    '...##...',
    '...##...',
    '........',
    '...##...',
    '...##...',
  ],
};

void drawIcon(Bitmap b, int ox, int oy, String name) {
  final art = icons[name]!;
  final w = art.first.length, h = art.length;
  b.stamp(ox + (cell - w) ~/ 2, oy + (cell - h) ~/ 2, art, kWhite);
}

// ---- PNG 인코딩(순수 Dart — dart:io 의 zlib) ------------------------------------------

Uint8List encodePng(Bitmap b) {
  // 스캔라인마다 filter 0 을 앞에 붙인 RGBA8.
  final raw = Uint8List(b.h * (1 + b.w * 4));
  var o = 0;
  for (var y = 0; y < b.h; y++) {
    raw[o++] = 0;
    for (var x = 0; x < b.w; x++) {
      final c = b.px[y * b.w + x];
      raw[o++] = (c >> 16) & 0xFF;
      raw[o++] = (c >> 8) & 0xFF;
      raw[o++] = c & 0xFF;
      raw[o++] = (c >> 24) & 0xFF;
    }
  }
  final idat = Uint8List.fromList(ZLibCodec(level: 9).encode(raw));
  final out = BytesBuilder();
  out.add(const [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  final ihdr = BytesBuilder()
    ..add(_u32(b.w))
    ..add(_u32(b.h))
    ..add([8, 6, 0, 0, 0]); // 8bit, RGBA, deflate, no filter, no interlace
  out.add(_chunk('IHDR', ihdr.toBytes()));
  out.add(_chunk('IDAT', idat));
  out.add(_chunk('IEND', Uint8List(0)));
  return out.toBytes();
}

List<int> _u32(int v) => [(v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF];

Uint8List _chunk(String tag, Uint8List data) {
  final body = Uint8List(4 + data.length);
  for (var i = 0; i < 4; i++) {
    body[i] = tag.codeUnitAt(i);
  }
  body.setRange(4, body.length, data);
  final out = BytesBuilder()
    ..add(_u32(data.length))
    ..add(body)
    ..add(_u32(_crc32(body)));
  return out.toBytes();
}

final Uint32List _crcTable = () {
  final t = Uint32List(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) {
      c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
    }
    t[n] = c;
  }
  return t;
}();

int _crc32(Uint8List data) {
  var c = 0xFFFFFFFF;
  for (final b in data) {
    c = _crcTable[(c ^ b) & 0xFF] ^ (c >> 8);
  }
  return (c ^ 0xFFFFFFFF) & 0xFFFFFFFF;
}

// ---- 조립 ---------------------------------------------------------------------

const List<String> poseColumns = ['idle', 'type1', 'type2', 'think', 'alert', 'ask', 'report', 'error'];
const List<String> propColumns = ['crown', 'star', 'chair', 'envelope', 'hourglass', 'warning', 'exclam', 'question'];

Bitmap buildAtlas() {
  final b = Bitmap(cols * cell, rows * cell);

  // 줄 0 — 포즈 8종.
  for (var c = 0; c < poseColumns.length; c++) {
    drawPose(b, c * cell, 0, poseColumns[c]);
    b.outlineCell(c * cell, 0);
  }

  // 줄 1 — 걷기 왼쪽 0..3, 오른쪽 0..3(왼쪽의 거울).
  for (var f = 0; f < 4; f++) {
    drawWalk(b, f * cell, cell, f);
    b.outlineCell(f * cell, cell);
  }
  for (var f = 0; f < 4; f++) {
    b.mirrorCell(f * cell, cell, (4 + f) * cell, cell);
  }

  // 줄 2 — 소품(외곽선 O) + 흰 실루엣 아이콘(외곽선 X — 색을 입히면 같이 물든다).
  drawCrown(b, 0 * cell, 2 * cell);
  drawStar(b, 1 * cell, 2 * cell);
  drawChair(b, 2 * cell, 2 * cell);
  for (var c = 0; c < 3; c++) {
    b.outlineCell(c * cell, 2 * cell);
  }
  for (var c = 3; c < propColumns.length; c++) {
    drawIcon(b, c * cell, 2 * cell, propColumns[c]);
  }
  return b;
}

/// 눈으로 확인할 때 쓰는 확대본(최근접 이웃 — 픽셀아트는 보간하지 않는다).
/// [bg] 를 주면 그 색을 깔고 그린다 — 흰 실루엣 아이콘은 투명 배경 위에서 안 보인다.
Bitmap zoom(Bitmap src, int n, {int bg = kClear}) {
  final b = Bitmap(src.w * n, src.h * n);
  if (bg != kClear) b.rect(0, 0, b.w, b.h, bg);
  for (var y = 0; y < src.h; y++) {
    for (var x = 0; x < src.w; x++) {
      final c = src.px[y * src.w + x];
      if (c != kClear) b.rect(x * n, y * n, n, n, c);
    }
  }
  return b;
}

/// 셀 하나에서 **투명하지 않은 부분의 최소 사각형**(셀 기준 좌표). 소품·아이콘은 셀 전체가 아니라
/// 이 상자만 그려야 크기가 맞는다 — `office_sprites.dart` 의 상수와 `office_sprites_test` 가 이 값을 쓴다.
List<int> tightBounds(Bitmap b, int col, int row) {
  var minX = cell, minY = cell, maxX = -1, maxY = -1;
  for (var j = 0; j < cell; j++) {
    for (var i = 0; i < cell; i++) {
      if (b.get(col * cell + i, row * cell + j) == kClear) continue;
      if (i < minX) minX = i;
      if (j < minY) minY = j;
      if (i > maxX) maxX = i;
      if (j > maxY) maxY = j;
    }
  }
  return maxX < 0 ? const [0, 0, 0, 0] : [minX, minY, maxX - minX + 1, maxY - minY + 1];
}

/// `dart run tool/gen_sprites.dart [out.png] [--preview=<path> --zoom=8] [--bounds]`
void main(List<String> args) {
  final positional = args.where((a) => !a.startsWith('--')).toList();
  final flags = {
    for (final a in args.where((a) => a.startsWith('--')))
      a.substring(2).split('=').first: a.contains('=') ? a.split('=').last : '',
  };
  final out = positional.isNotEmpty ? positional.first : 'assets/sprites/characters.png';
  final b = buildAtlas();
  final f = File(out);
  f.parent.createSync(recursive: true);
  f.writeAsBytesSync(encodePng(b));
  stdout.writeln('wrote $out (${b.w}x${b.h}, ${f.lengthSync()} bytes)');
  if (flags.containsKey('bounds')) {
    for (var c = 0; c < propColumns.length; c++) {
      final t = tightBounds(b, c, 2);
      stdout.writeln('  ${propColumns[c].padRight(10)} x=${t[0]} y=${t[1]} w=${t[2]} h=${t[3]}');
    }
  }
  final preview = flags['preview'];
  if (preview != null && preview.isNotEmpty) {
    final n = int.tryParse(flags['zoom'] ?? '8') ?? 8;
    final bg = 0xFF000000 | (int.tryParse(flags['bg'] ?? '1B1F2A', radix: 16) ?? 0x1B1F2A);
    final p = File(preview)..parent.createSync(recursive: true);
    p.writeAsBytesSync(encodePng(zoom(b, n, bg: bg)));
    stdout.writeln('wrote $preview (${b.w * n}x${b.h * n}, zoom ${n}x)');
  }
}
