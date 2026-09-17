// 허가 카드 요약 줄의 순수 함수(T40-4, 레이아웃 v2 §3 패스 3 D12):
// 동사 추출 · 대상(마지막 경로 조각) · 위험 패턴 · 만료 메타.
import 'package:flutter_test/flutter_test.dart';
import 'package:pixel_office/panel/approval_summary.dart';

void main() {
  group('동사(approvalVerb)', () {
    test('Write → 쓰기, Edit·MultiEdit·NotebookEdit → 수정', () {
      expect(approvalVerb('Write', {'file_path': 'a.txt', 'content': 'x'}), '쓰기');
      expect(approvalVerb('Edit', {'file_path': 'a.dart'}), '수정');
      expect(approvalVerb('MultiEdit', {'file_path': 'a.dart'}), '수정');
      expect(approvalVerb('NotebookEdit', {'notebook_path': 'a.ipynb'}), '수정');
    });

    test('셸: Set-Content·리다이렉션 → 쓰기', () {
      expect(approvalVerb('PowerShell', {'command': 'Set-Content demo39-c.txt -Value hi'}), '쓰기');
      expect(approvalVerb('PowerShell', {'command': 'Add-Content log.txt "x"'}), '쓰기');
      expect(approvalVerb('Bash', {'command': 'echo hi > out.txt'}), '쓰기');
      expect(approvalVerb('Bash', {'command': 'cat a >> b.log'}), '쓰기');
      // `2>&1` 은 파일 쓰기가 아니다.
      expect(approvalVerb('Bash', {'command': 'flutter test 2>&1'}), '실행');
    });

    test('셸: rm·Remove-Item·del → 삭제, git push → 푸시, 나머지는 실행', () {
      expect(approvalVerb('Bash', {'command': 'rm -rf build'}), '삭제');
      expect(approvalVerb('PowerShell', {'command': 'Remove-Item -Recurse -Force build'}), '삭제');
      expect(approvalVerb('cmd', {'command': 'del /s tmp'}), '삭제');
      expect(approvalVerb('Bash', {'command': 'git push origin main'}), '푸시');
      expect(approvalVerb('Bash', {'command': 'flutter test'}), '실행');
      expect(approvalVerb('Bash', {'command': '   '}), '실행');
    });

    test('그 밖의 도구: 명령이 있으면 첫 토큰 그대로, 없으면 실행', () {
      expect(approvalVerb('mcp__notion__search', {'query': 'x'}), '실행');
      expect(approvalVerb('WeirdTool', {'command': 'deploy --prod'}), 'deploy');
    });
  });

  group('대상(approvalTarget) · 첫 줄(approvalHeadline)', () {
    test('파일 도구는 file_path 의 마지막 조각', () {
      expect(approvalTarget('Edit', {'file_path': r'D:\proj\lib\main.dart'}), 'main.dart');
      expect(approvalTarget('Write', {'file_path': 'a/b/c.txt'}), 'c.txt');
      expect(approvalTarget('NotebookEdit', {'notebook_path': 'nb/x.ipynb'}), 'x.ipynb');
    });

    test('셸은 명령의 마지막 "경로 같은" 토큰(플래그 제외)', () {
      expect(approvalTarget('PowerShell', {'command': 'Set-Content demo39-c.txt -Value hi'}), 'demo39-c.txt');
      expect(approvalTarget('Bash', {'command': 'rm -rf build'}), isNull); // 확장자·구분자 없음
      expect(approvalTarget('Bash', {'command': 'cat docs/design/레이아웃-v2.md'}), '레이아웃-v2.md');
      expect(approvalTarget('cmd', {'command': 'del /s tmp'}), isNull); // `/s` 는 플래그
    });

    test('첫 줄 = `❗ 도구 · 대상 동사`(대상이 없으면 동사만)', () {
      expect(
        approvalHeadline('PowerShell', {'command': 'Set-Content demo39-c.txt -Value hi'}),
        '❗ PowerShell · demo39-c.txt 쓰기',
      );
      expect(approvalHeadline('Bash', {'command': 'rm -rf build'}), '❗ Bash · 삭제');
      expect(approvalHeadline('Edit', {'file_path': 'lib/main.dart'}), '❗ Edit · main.dart 수정');
      expect(approvalHeadline('', const {}), '❗ 도구 · 실행');
    });

    test('lastPathSegment: 끝 구분자·윈도 경로', () {
      expect(lastPathSegment(r'D:\a\b\'), 'b');
      expect(lastPathSegment('/usr/local/bin'), 'bin');
      expect(lastPathSegment('plain'), 'plain');
    });
  });

  group('위험 패턴(isDangerousCommand)', () {
    test('rm -rf · Remove-Item -Recurse · git push --force · del /s · format', () {
      expect(isDangerousCommand('rm -rf build'), isTrue);
      expect(isDangerousCommand('RM -fr /tmp'), isTrue);
      expect(isDangerousCommand('Remove-Item -Recurse -Force .\\build'), isTrue);
      expect(isDangerousCommand('git push --force origin main'), isTrue);
      expect(isDangerousCommand('git push -f'), isTrue);
      expect(isDangerousCommand('del /s tmp'), isTrue);
      expect(isDangerousCommand('format D:'), isTrue);
    });

    test('안전한 명령은 위험이 아니다 — `dart format` 오탐 없음', () {
      expect(isDangerousCommand('dart format .'), isFalse);
      expect(isDangerousCommand('flutter test'), isFalse);
      expect(isDangerousCommand('git push origin main'), isFalse);
      expect(isDangerousCommand('rm build/app.txt'), isFalse); // -rf 아님
      expect(isDangerousCommand(null), isFalse);
      expect(isDangerousCommand(''), isFalse);
    });
  });

  group('만료 메타', () {
    final created = DateTime.utc(2026, 9, 17, 1, 32); // 로컬 변환은 아래에서 같이 계산
    final createdIso = created.toIso8601String();

    test('만료 = createdAt + 86400초', () {
      final exp = approvalExpiryAt(createdIso)!;
      expect(exp.difference(created.toLocal()), const Duration(hours: 24));
      expect(approvalHoldLimit, const Duration(seconds: 86400));
      expect(approvalExpiryAt('망가진 시각'), isNull);
    });

    test('만료 시각 표기: 오늘 / 내일 / 그 밖', () {
      final now = DateTime(2026, 9, 17, 10, 0);
      expect(formatExpiryClock(DateTime(2026, 9, 17, 23, 5), now: now), '23:05');
      expect(formatExpiryClock(DateTime(2026, 9, 18, 10, 32), now: now), '내일 10:32');
      expect(formatExpiryClock(DateTime(2026, 9, 19, 9, 7), now: now), '9/19 09:07');
    });

    test('메타 한 줄 `요청 N분 전 · <만료> 만료`', () {
      final base = created.toLocal().add(const Duration(minutes: 2));
      final line = approvalMetaLine(createdIso, now: base);
      expect(line, startsWith('요청 2분 전 · '));
      expect(line, endsWith(' 만료'));
    });

    test('남은 1시간부터 주황, 지나면 만료', () {
      final base = created.toLocal();
      expect(isApprovalExpirySoon(createdIso, now: base), isFalse);
      expect(isApprovalExpirySoon(createdIso, now: base.add(const Duration(hours: 23, minutes: 30))), isTrue);
      expect(isApprovalExpired(createdIso, now: base.add(const Duration(hours: 23, minutes: 30))), isFalse);
      expect(isApprovalExpired(createdIso, now: base.add(const Duration(hours: 24, minutes: 1))), isTrue);
      expect(isApprovalExpirySoon(createdIso, now: base.add(const Duration(hours: 24, minutes: 1))), isFalse);
    });
  });
}
