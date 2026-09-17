// 허가 카드 요약 줄(T40-4, 레이아웃 v2 §3 패스 3 D12) — 순수 함수만. 위젯은 pending_card.dart.
//
//  첫 줄  `❗ <도구> · <대상 마지막 조각> <동사>`   예) `❗ PowerShell · demo39-c.txt 쓰기`
//     동사: Write → 쓰기 / Edit·MultiEdit·NotebookEdit → 수정 /
//           Bash·PowerShell → 첫 토큰 + 패턴(Set-Content·리다이렉션 → 쓰기, rm·Remove-Item·del → 삭제,
//                            git push → 푸시, 그 밖에는 실행) /
//           그 밖의 도구 → 명령이 있으면 첫 토큰 그대로, 없으면 실행.
//     대상: file_path|notebook_path|path 의 마지막 조각. 없으면 명령에서 **마지막 경로 같은 토큰**(`/`·`\`·확장자)의
//           마지막 조각. 둘 다 없으면 생략한다(`❗ Bash · 삭제`).
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

/// 명령에서 마지막 "경로 같은" 토큰(플래그·리다이렉션 기호는 뺀다). 없으면 null.
String? commandTarget(String? command) {
  final cmd = (command ?? '').trim();
  if (cmd.isEmpty) return null;
  String? found;
  for (final raw in cmd.split(RegExp(r'\s+'))) {
    var t = raw.trim();
    // 따옴표·리다이렉션 기호 벗기기.
    t = t.replaceAll(RegExp(r'''^["'>]+|["']+$'''), '');
    if (t.isEmpty || t.startsWith('-') || t.startsWith('/')) continue; // 플래그(`-rf`, `/s`)
    if (!_pathLike.hasMatch(t)) continue;
    found = t;
  }
  return found == null ? null : lastPathSegment(found);
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
