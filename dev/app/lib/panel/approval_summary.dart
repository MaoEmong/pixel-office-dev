// 허가 카드 요약 줄(T40-4, 레이아웃 v2 §3 패스 3 D12) — 순수 함수만. 위젯은 pending_card.dart.
//
//  첫 줄  `❗ <도구> · <대상 마지막 조각> <동사>`   예) `❗ PowerShell · demo39-c.txt 쓰기`
//     **한 줄 고정**(T40d ①). 폭이 모자라면 대상만 가운데 말줄임(`t40-…txt`), 동사는 안 줄인다 —
//     `fitApprovalHeadline`(아래 "첫 줄을 한 줄에 맞추기") 가 규칙이다.
//     동사: Write → 쓰기 / Edit·MultiEdit·NotebookEdit → 수정 /
//           Bash·PowerShell → 첫 토큰 + 패턴(Set-Content·리다이렉션 → 쓰기, rm·Remove-Item·del → 삭제,
//                            git push → 푸시, 그 밖에는 실행) /
//           그 밖의 도구 → 명령이 있으면 첫 토큰 그대로, 없으면 실행.
//     대상: file_path|notebook_path|path 의 마지막 조각. 없으면 명령에서 **마지막 경로 같은 토큰**(`/`·`\`·확장자)의
//           마지막 조각. 둘 다 없으면 생략한다(`❗ Bash · 삭제`).
//           토큰은 따옴표를 아는 쪼개기(`shellTokens`)로 끊고 감싼 따옴표·괄호·꼬리 구두점을 벗긴다
//           (T40d ③ — `t40-a.txt") 실행` 처럼 꼬리가 붙어 나오던 자리).
//  위험 패턴(`rm -rf` · `Remove-Item -Recurse` · `git push --force` · `del /s` · 줄 첫머리 `format`)이면
//     첫 줄 배경에 빨강 틴트(#FF6B6B 알파 0.15) + 태그 `위험`.
//  메타(오른쪽 위) `요청 2분 전 · 내일 10:32 만료` — 만료 = createdAt + 86400초(hook 보류 상한, D10).
//     남은 1시간부터 주황, 지나면 회색 "만료 — 재지시" 카드.

import 'labels.dart' show formatElapsed;

/// hook 보류 상한(PROTOCOL) — 허가·질문 카드의 만료 시각 = createdAt + 이 값.
const Duration approvalHoldLimit = Duration(seconds: 86400);

/// 만료가 이 시간 안으로 들어오면 메타 글자가 주황이 된다.
const Duration approvalExpirySoon = Duration(hours: 1);

/// 위험 태그 문구.
const String approvalDangerTag = '위험';

// ---- 위험 패턴 ---------------------------------------------------------------------

final List<RegExp> _dangerPatterns = [
  // rm -rf / rm -fr / rm -Rf …
  RegExp(r'\brm\s+(-\w+\s+)*-\w*r\w*f\w*\b'),
  RegExp(r'\brm\s+(-\w+\s+)*-\w*f\w*r\w*\b'),
  RegExp(r'\bremove-item\b[\s\S]*-recurse\b'),
  RegExp(r'\bgit\s+push\b[\s\S]*(--force|\s-f\b)'),
  RegExp(r'\bdel\s+/s\b'),
  // 디스크 포맷만 — `dart format` 같은 하위 명령은 아니다(문장 첫머리나 구분자 뒤에 올 때만).
  RegExp(r'(^|[;&|]\s*)format\b'),
];

/// 명령이 되돌릴 수 없는 위험 패턴을 담고 있는가(대소문자 무시).
bool isDangerousCommand(String? command) {
  final c = (command ?? '').toLowerCase();
  if (c.trim().isEmpty) return false;
  return _dangerPatterns.any((p) => p.hasMatch(c));
}

/// 도구·입력 전체로 본 위험 여부(지금은 명령 기준 — 파일 도구는 위험으로 보지 않는다).
bool isDangerousApproval(String toolName, Map<String, dynamic> input) => isDangerousCommand(input['command']?.toString());

// ---- 동사 -------------------------------------------------------------------------

/// 셸 명령의 첫 토큰(파이프·`&&` 앞). 없으면 빈 문자열.
String commandFirstToken(String command) {
  for (final raw in command.trim().split(RegExp(r'\s+'))) {
    final t = raw.trim();
    if (t.isEmpty) continue;
    return t;
  }
  return '';
}

/// 셸 명령 → 동사(쓰기 · 삭제 · 푸시 · 실행).
String shellVerb(String? command) {
  final cmd = (command ?? '').trim();
  if (cmd.isEmpty) return '실행';
  final lower = cmd.toLowerCase();
  final first = commandFirstToken(lower);
  const deleters = {'rm', 'remove-item', 'ri', 'del', 'erase', 'rmdir', 'rd', 'unlink'};
  if (deleters.contains(first) || RegExp(r'(^|[;&|]\s*)(rm|remove-item|del)\s').hasMatch(lower)) return '삭제';
  if (RegExp(r'\bgit\s+push\b').hasMatch(lower)) return '푸시';
  const writers = {'set-content', 'add-content', 'out-file', 'tee', 'tee-object'};
  if (writers.contains(first) || RegExp(r'\b(set-content|add-content|out-file)\b').hasMatch(lower)) return '쓰기';
  // 리다이렉션(`>` `>>`). `2>&1` 같은 것은 파일 쓰기가 아니므로 뺀다.
  if (RegExp(r'(^|[^0-9&>])>>?\s*[^&\s]').hasMatch(lower)) return '쓰기';
  return '실행';
}

/// 도구 이름 + tool_input → 동사.
String approvalVerb(String toolName, Map<String, dynamic> input) {
  switch (toolName) {
    case 'Write':
      return '쓰기';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return '수정';
  }
  final command = input['command']?.toString();
  if (isShellToolName(toolName)) return shellVerb(command);
  if (command != null && command.trim().isNotEmpty) {
    final first = commandFirstToken(command);
    return first.isEmpty ? '실행' : first;
  }
  return '실행';
}

/// 셸 계열 도구인가(pending_card.isShellTool 과 같은 규칙 — 순환 import 를 피하려고 여기에 둔다).
bool isShellToolName(String toolName) {
  final t = toolName.toLowerCase();
  return t == 'bash' || t == 'powershell' || t == 'pwsh' || t == 'shell' || t == 'cmd' || t.endsWith('_shell');
}

// ---- 대상 -------------------------------------------------------------------------

/// 경로의 마지막 조각(`D:/a/b/c.txt` → `c.txt`). 끝의 구분자는 무시한다.
String lastPathSegment(String path) {
  var p = path.trim();
  while (p.length > 1 && (p.endsWith('/') || p.endsWith('\\'))) {
    p = p.substring(0, p.length - 1);
  }
  final i = p.lastIndexOf(RegExp(r'[/\\]'));
  final seg = i < 0 ? p : p.substring(i + 1);
  return seg.isEmpty ? p : seg;
}

final RegExp _pathLike = RegExp(r'[/\\]|\.[A-Za-z0-9]{1,6}$');

/// 대상 앞뒤에 붙어 오는 군더더기 — 따옴표·괄호·꼬리 구두점(T40d ③).
const String _openers = '([{<"\'`';
const String _closers = ')]}>"\'`,;:!?';

/// 대상에서 감싼 따옴표·괄호와 꼬리 구두점을 벗긴다 — `t40-a.txt")` → `t40-a.txt`.
/// 확장자의 점(`.txt`)이나 숨김 파일의 앞 점(`.gitignore`)은 건드리지 않는다.
String stripTargetWrappers(String s) {
  var t = s.trim();
  var changed = true;
  while (changed && t.isNotEmpty) {
    changed = false;
    while (t.isNotEmpty && _openers.contains(t[0])) {
      t = t.substring(1);
      changed = true;
    }
    while (t.isNotEmpty && _closers.contains(t[t.length - 1])) {
      t = t.substring(0, t.length - 1);
      changed = true;
    }
  }
  return t;
}

/// 셸 명령을 토큰으로 — **따옴표 안의 공백은 자르지 않고**(`cat "a b.txt"` → `cat`, `a b.txt`)
/// 따옴표 자체는 떨어뜨린다. PowerShell 의 `…ReadAllBytes("D:\x\a.txt")` 처럼 토큰 가운데에 낀
/// 따옴표도 같이 벗겨져 뒤에 `")` 가 남지 않는다.
List<String> shellTokens(String command) {
  final out = <String>[];
  final buf = StringBuffer();
  String? quote;
  void flush() {
    if (buf.isNotEmpty) {
      out.add(buf.toString());
      buf.clear();
    }
  }

  for (final ch in command.split('')) {
    if (quote != null) {
      if (ch == quote) {
        quote = null;
      } else {
        buf.write(ch);
      }
      continue;
    }
    if (ch == '"' || ch == "'") {
      quote = ch;
      continue;
    }
    if (ch.trim().isEmpty) {
      flush();
      continue;
    }
    buf.write(ch);
  }
  flush();
  return List<String>.unmodifiable(out);
}

/// 명령에서 마지막 "경로 같은" 토큰(플래그·리다이렉션 기호는 뺀다). 없으면 null.
String? commandTarget(String? command) {
  final cmd = (command ?? '').trim();
  if (cmd.isEmpty) return null;
  String? found;
  for (final raw in shellTokens(cmd)) {
    // 리다이렉션 기호·감싼 따옴표·괄호·꼬리 구두점 벗기기.
    final t = stripTargetWrappers(raw.replaceAll(RegExp(r'^>+'), ''));
    if (t.isEmpty || t.startsWith('-') || t.startsWith('/')) continue; // 플래그(`-rf`, `/s`)
    if (!_pathLike.hasMatch(t)) continue;
    found = t;
  }
  if (found == null) return null;
  final seg = stripTargetWrappers(lastPathSegment(found));
  return seg.isEmpty ? null : seg;
}

/// 허가 카드 첫 줄의 대상(없으면 null).
String? approvalTarget(String toolName, Map<String, dynamic> input) {
  final path = (input['file_path'] ?? input['notebook_path'] ?? input['path'])?.toString();
  if (path != null && path.trim().isNotEmpty) return lastPathSegment(path);
  return commandTarget(input['command']?.toString());
}

/// 첫 줄 전체: `❗ <도구> · <대상> <동사>` (대상이 없으면 `❗ <도구> · <동사>`).
String approvalHeadline(String toolName, Map<String, dynamic> input) {
  final tool = toolName.isEmpty ? '도구' : toolName;
  final verb = approvalVerb(toolName, input);
  final target = approvalTarget(toolName, input);
  return target == null ? '❗ $tool · $verb' : '❗ $tool · $target $verb';
}

// ---- 첫 줄을 한 줄에 맞추기(T40d ①) ---------------------------------------------------
//
// 규칙: 첫 줄은 **언제나 한 줄**이다(카드는 `maxLines: 1`). 폭이 모자라면 줄이는 순서는
//   ① 대상을 **가운데** 말줄임(`t40-abcdef.txt` → `t40-…txt`) — 확장자를 남겨 무엇인지 알아보게,
//   ② 그래도 모자라면 도구 이름을 가운데 말줄임,
//   ③ **동사는 절대 줄이지 않는다** — "쓰기/삭제/푸시" 가 잘리면 카드가 쓸모없어진다.
// 낱말 중간 줄바꿈(`쓰 / 기`)은 구조로 막는다: 첫 줄 Text 는 한 줄 고정이고, 오른쪽 메타는
// `Expanded` 뒤에 붙어 첫 줄의 남은 폭을 반으로 가르지 않는다(전에는 `Spacer` 가 절반을 먹었다).

/// 예산 계산의 한 칸(13.5px 굵은 가변폭의 **반각** 평균 폭). 정밀 측정이 아니라 넉넉한 어림이다.
const double approvalHeadlineColumnPx = 7.0;

/// 카드 바깥 여백 + 테두리 + 첫 줄 좌우 패딩(margin 8·8 + 테두리 1.5·2 + padding 10·10).
const double approvalHeadlineChromePx = 39;

/// 오른쪽 위 메타(`요청 2분 전 · 내일 10:32 만료`, 10.5px)가 먹는 폭 + 사이 간격.
const double approvalHeadlineMetaPx = 160;

/// `위험` 태그가 먹는 폭 + 사이 간격.
const double approvalHeadlineDangerPx = 46;

/// 대상에 최소로 남기는 칸 수. 이보다 좁아지면 도구 이름부터 줄인다.
const int approvalTargetMinColumns = 6;

/// 첫 줄 예산의 하한(패널이 아무리 좁아도 이만큼은 있다고 본다).
const int approvalHeadlineMinColumns = 14;

const int _wideEmojiFirst = 0x2600;
const int _wideEmojiLast = 0x27BF;

/// 반각 한 칸을 1 로 센 글자 폭 — 한글·한자·가나·전각·이모지는 2. (`❗`·`쓰기` 가 2칸씩)
int displayColumns(String s) {
  var n = 0;
  for (final r in s.runes) {
    n += _isWideRune(r) ? 2 : 1;
  }
  return n;
}

bool _isWideRune(int r) =>
    (r >= 0x1100 && r <= 0x115F) || // 한글 자모
    (r >= _wideEmojiFirst && r <= _wideEmojiLast) || // ❗ ⚠ 등 그림 문자
    (r >= 0x2E80 && r <= 0x303E) || // CJK 부수 · 괄호
    (r >= 0x3041 && r <= 0x33FF) || // 가나 · 한글 호환 자모 · 기호
    (r >= 0x3400 && r <= 0x4DBF) ||
    (r >= 0x4E00 && r <= 0x9FFF) || // 한자
    (r >= 0xA000 && r <= 0xA4CF) ||
    (r >= 0xAC00 && r <= 0xD7A3) || // 한글 완성형
    (r >= 0xF900 && r <= 0xFAFF) ||
    (r >= 0xFE30 && r <= 0xFE6F) ||
    (r >= 0xFF00 && r <= 0xFF60) ||
    (r >= 0xFFE0 && r <= 0xFFE6) ||
    (r >= 0x1F300 && r <= 0x1FAFF) || // 이모지
    (r >= 0x20000 && r <= 0x3FFFD);

/// [s] 의 앞(또는 뒤)에서 [columns] 칸만큼 — 대리쌍·전각 글자를 반으로 쪼개지 않는다.
String _takeColumns(String s, int columns, {required bool fromStart}) {
  if (columns <= 0) return '';
  final runes = s.runes.toList(growable: false);
  final out = <int>[];
  var n = 0;
  for (var i = 0; i < runes.length; i++) {
    final r = runes[fromStart ? i : runes.length - 1 - i];
    final w = _isWideRune(r) ? 2 : 1;
    if (n + w > columns) break;
    n += w;
    if (fromStart) {
      out.add(r);
    } else {
      out.insert(0, r);
    }
  }
  return String.fromCharCodes(out);
}

/// 가운데 말줄임 — `t40-abcdef.txt` → `t40-…txt`(뒤쪽 = 확장자를 우선 남긴다).
String middleEllipsis(String s, int columns) {
  if (s.isEmpty || displayColumns(s) <= columns) return s;
  if (columns <= 1) return '…';
  final keep = columns - 1; // '…' 한 칸
  final tail = keep ~/ 2;
  return '${_takeColumns(s, keep - tail, fromStart: true)}…${_takeColumns(s, tail, fromStart: false)}';
}

/// 패널(= 카드에 주어진) 폭 → 첫 줄 글자가 쓸 수 있는 px. 여백·오른쪽 메타·위험 태그를 뺀다.
double approvalHeadlineTextWidth(double panelWidth, {bool danger = false}) =>
    panelWidth - approvalHeadlineChromePx - approvalHeadlineMetaPx - (danger ? approvalHeadlineDangerPx : 0);

/// 첫 줄 글자 폭(px) → 칸 수(하한 [approvalHeadlineMinColumns]).
int approvalHeadlineColumns(double textWidth) {
  final n = (textWidth / approvalHeadlineColumnPx).floor();
  return n < approvalHeadlineMinColumns ? approvalHeadlineMinColumns : n;
}

/// [columns] 칸 한 줄에 맞춘 첫 줄. 동사는 언제나 온전하다.
String fitApprovalHeadlineToColumns(String toolName, Map<String, dynamic> input, int columns) {
  final tool = toolName.isEmpty ? '도구' : toolName;
  final verb = approvalVerb(toolName, input);
  final target = approvalTarget(toolName, input);
  String line(String t, String? g) => g == null ? '❗ $t · $verb' : '❗ $t · $g $verb';
  final full = line(tool, target);
  if (displayColumns(full) <= columns) return full;
  if (target == null) {
    // 줄일 대상이 없다 — 도구 이름만 줄인다.
    return line(middleEllipsis(tool, columns - (displayColumns(full) - displayColumns(tool))), null);
  }
  final room = columns - (displayColumns(full) - displayColumns(target));
  if (room >= approvalTargetMinColumns) return line(tool, middleEllipsis(target, room));
  // 대상에 최소 칸도 안 남는다 — 도구 이름을 먼저 줄이고 대상에 최소 칸을 준다.
  final toolRoom = displayColumns(tool) - (approvalTargetMinColumns - room);
  return line(middleEllipsis(tool, toolRoom), middleEllipsis(target, approvalTargetMinColumns));
}

/// 첫 줄 글자에 [textWidth] px 가 주어졌을 때의 한 줄 요약(카드가 쓰는 길).
String fitApprovalHeadlineToWidth(String toolName, Map<String, dynamic> input, double textWidth) =>
    fitApprovalHeadlineToColumns(toolName, input, approvalHeadlineColumns(textWidth));

/// 패널 폭에 맞춘 한 줄 요약(테스트·문서가 쓰는 지름길).
String fitApprovalHeadline(String toolName, Map<String, dynamic> input, {required double panelWidth, bool danger = false}) =>
    fitApprovalHeadlineToWidth(toolName, input, approvalHeadlineTextWidth(panelWidth, danger: danger));

// ---- 만료 메타 ---------------------------------------------------------------------

/// `createdAt`(ISO) → 만료 시각(로컬). 파싱 실패면 null.
DateTime? approvalExpiryAt(String createdAt) => DateTime.tryParse(createdAt)?.toLocal().add(approvalHoldLimit);

String _two(int n) => n.toString().padLeft(2, '0');

/// 만료 시각 → `10:32` / `내일 10:32` / `9/19 10:32`(오늘·내일이 아니면 날짜까지).
String formatExpiryClock(DateTime expiry, {DateTime? now}) {
  final base = now ?? DateTime.now();
  final today = DateTime(base.year, base.month, base.day);
  final day = DateTime(expiry.year, expiry.month, expiry.day);
  final diff = day.difference(today).inDays;
  final hm = '${_two(expiry.hour)}:${_two(expiry.minute)}';
  return switch (diff) {
    0 => hm,
    1 => '내일 $hm',
    _ => '${expiry.month}/${expiry.day} $hm',
  };
}

/// 카드 오른쪽 위 메타: `요청 2분 전 · 내일 10:32 만료`. createdAt 을 못 읽으면 앞부분만.
String approvalMetaLine(String createdAt, {DateTime? now}) {
  final base = now ?? DateTime.now();
  final t = DateTime.tryParse(createdAt)?.toLocal();
  final age = t == null ? null : '요청 ${formatElapsed(base.difference(t))} 전';
  final expiry = approvalExpiryAt(createdAt);
  final exp = expiry == null ? null : '${formatExpiryClock(expiry, now: base)} 만료';
  return [?age, ?exp].join(' · ');
}

/// 만료까지 [approvalExpirySoon] 이하로 남았는가(만료된 것은 false — 그건 [isApprovalExpired]).
bool isApprovalExpirySoon(String createdAt, {DateTime? now}) {
  final base = now ?? DateTime.now();
  final expiry = approvalExpiryAt(createdAt);
  if (expiry == null) return false;
  final left = expiry.difference(base);
  return !left.isNegative && left <= approvalExpirySoon;
}

/// 만료 시각이 지났는가.
bool isApprovalExpired(String createdAt, {DateTime? now}) {
  final base = now ?? DateTime.now();
  final expiry = approvalExpiryAt(createdAt);
  return expiry != null && !expiry.isAfter(base);
}
