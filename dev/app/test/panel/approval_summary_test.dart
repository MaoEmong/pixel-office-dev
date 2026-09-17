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

    // T40d ③ — `❗ PowerShell · t40-a.txt") 실행` 처럼 따옴표·괄호가 딸려 나오던 자리.
    test('감싼 따옴표·괄호와 꼬리 구두점은 벗긴다', () {
      expect(
        approvalTarget('PowerShell', {'command': r'[System.IO.File]::ReadAllBytes("D:\proj\sandbox\t40-a.txt")'}),
        't40-a.txt',
      );
      expect(approvalTarget('Bash', {'command': 'cat "a b.txt" | head'}), 'a b.txt'); // 따옴표 안 공백은 한 토큰
      expect(approvalTarget('PowerShell', {'command': "Set-Content -Path 'x.txt'"}), 'x.txt');
      expect(approvalTarget('Bash', {'command': 'git push origin main'}), isNull);
      expect(approvalTarget('Bash', {'command': 'rm -rf build/'}), 'build');
      expect(approvalTarget('Bash', {'command': 'cat (report.md),'}), 'report.md');
      // 앞 점(숨김 파일)·확장자 점은 그대로.
      expect(approvalTarget('Bash', {'command': 'cat ./.gitignore'}), '.gitignore');
    });

    test('첫 줄도 꼬리 없이 — 셸 카드 회귀(T40d ③)', () {
      expect(
        approvalHeadline('PowerShell', {'command': r'[System.IO.File]::ReadAllBytes("D:\proj\sandbox\t40-a.txt")'}),
        '❗ PowerShell · t40-a.txt 실행',
      );
      expect(approvalHeadline('Bash', {'command': 'rm -rf build/'}), '❗ Bash · build 삭제');
      expect(approvalHeadline('Bash', {'command': 'git push origin main'}), '❗ Bash · 푸시');
    });

    test('shellTokens: 따옴표 안 공백은 자르지 않고 따옴표는 떨군다', () {
      expect(shellTokens('cat "a b.txt" | head'), ['cat', 'a b.txt', '|', 'head']);
      expect(shellTokens("Set-Content -Path 'x y.txt' -Value 'hi there'"), ['Set-Content', '-Path', 'x y.txt', '-Value', 'hi there']);
      expect(shellTokens('   '), isEmpty);
    });

    test('stripTargetWrappers', () {
      expect(stripTargetWrappers('t40-a.txt")'), 't40-a.txt');
      expect(stripTargetWrappers('[a.txt]'), 'a.txt');
      expect(stripTargetWrappers('a.txt,'), 'a.txt');
      expect(stripTargetWrappers('.gitignore'), '.gitignore');
      expect(stripTargetWrappers('""'), '');
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

  // T40d ① — 첫 줄은 한 줄. 모자라면 대상만 가운데 말줄임하고 동사는 살린다.
  group('한 줄 맞춤(fitApprovalHeadline)', () {
    test('글자 폭(displayColumns): 한글·이모지는 2칸', () {
      expect(displayColumns('abc'), 3);
      expect(displayColumns('쓰기'), 4);
      expect(displayColumns('❗'), 2);
      expect(displayColumns('❗ Write · a.txt 쓰기'), 2 + 1 + 5 + 3 + 5 + 1 + 4);
    });

    test('가운데 말줄임은 확장자를 남긴다 — `t40-abcdefgh.txt` → `t40-…txt`', () {
      expect(middleEllipsis('t40-abcdefgh.txt', 8), 't40-…txt');
      expect(middleEllipsis('짧다', 8), '짧다'); // 예산 안이면 그대로
      expect(middleEllipsis('t40-a.txt', 1), '…');
      // 전각 글자를 반으로 쪼개지 않는다(칸 수가 홀수여도).
      final cut = middleEllipsis('가나다라마바사아자차.md', 9);
      expect(displayColumns(cut) <= 9, isTrue);
      expect(cut, contains('…'));
    });

    test('420·480·660 — 짧은 첫 줄은 그대로', () {
      const input = {'command': 'Set-Content t40-a.txt -Value hi'};
      for (final w in [420.0, 480.0, 660.0]) {
        expect(fitApprovalHeadline('PowerShell', input, panelWidth: w), '❗ PowerShell · t40-a.txt 쓰기');
      }
    });

    test('420·480·660 — 긴 대상만 가운데 말줄임, 도구·동사는 온전하다', () {
      const input = {'file_path': r'D:\proj\docs\design\레이아웃-v2-아주-긴-파일-이름.md'};
      final lines = [
        for (final w in [420.0, 480.0, 660.0]) fitApprovalHeadline('Write', input, panelWidth: w),
      ];
      for (var i = 0; i < lines.length; i++) {
        final line = lines[i];
        expect(line, startsWith('❗ Write · '), reason: line);
        expect(line, endsWith(' 쓰기'), reason: '동사는 온전히: $line'); // 낱말 중간에서 끊지 않는다
        expect(displayColumns(line) <= approvalHeadlineColumns(approvalHeadlineTextWidth([420.0, 480.0, 660.0][i])), isTrue,
            reason: '예산 초과: $line');
      }
      expect(lines[0], contains('…')); // 420 에서는 줄었고
      expect(displayColumns(lines[0]) < displayColumns(lines[2]), isTrue); // 넓을수록 길다
      // 660 은 전문이 다 들어간다.
      expect(lines[2], '❗ Write · 레이아웃-v2-아주-긴-파일-이름.md 쓰기');
    });

    test('도구 이름이 첫 줄을 다 먹으면 도구도 줄인다 — 동사는 그래도 온전하다', () {
      // 대상에 최소 [approvalTargetMinColumns] 칸을 남기고 나머지를 도구에 준다.
      final line = fitApprovalHeadlineToColumns('mcp__very__long__tool__name__here', {'file_path': 'report.md'}, 20);
      expect(line, endsWith(' 실행'));
      expect(displayColumns(line) <= 20, isTrue, reason: line);
      expect('…'.allMatches(line).length, 2); // 도구·대상 둘 다 줄었다
      // 조금만 넓어도 대상은 온전해진다.
      final wide = fitApprovalHeadlineToColumns('mcp__notion__search', {'file_path': 'report.md'}, 40);
      expect(wide, '❗ mcp__notion__search · report.md 실행');
    });

    test('위험 태그가 붙으면 예산이 그만큼 준다', () {
      const input = {'command': 'rm -rf docs/design/레이아웃-v2-아주-긴-파일-이름.md'};
      final plain = fitApprovalHeadline('Bash', input, panelWidth: 480);
      final danger = fitApprovalHeadline('Bash', input, panelWidth: 480, danger: true);
      expect(displayColumns(danger) < displayColumns(plain), isTrue);
      expect(danger, endsWith(' 삭제'));
    });

    test('예산 하한 — 아주 좁아도 동사는 남는다', () {
      final line = fitApprovalHeadline('Write', {'file_path': 'a/very-long-name.txt'}, panelWidth: 200);
      expect(line, endsWith(' 쓰기'));
      expect(displayColumns(line) > 0, isTrue);
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
