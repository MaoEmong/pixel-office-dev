// T48-1: 위험한 셸 명령 판별. **유닉스 계열과 PowerShell/CMD 계열을 한 파일에서 같이** 고정한다 —
// 판별은 플랫폼을 보지 않는다(D-48 ④: 맥에서 PowerShell 을, 윈도우에서 git-bash 를 쓸 수 있다).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DANGER_PATTERNS, dangerousMatches, dangerousReasons, isDangerousCommand } from '../../src/adapters/mapping.js';
import { CODEX_SHELL_TOOLS, isReadOnlyCommand, normalizeToolName } from '../../src/adapters/codexMapping.js';

/** 그 명령이 위험하고, 기대한 패턴이 걸렸는지. */
function hits(cmd: string, id: string): void {
  assert.equal(isDangerousCommand(cmd), true, `위험으로 봐야 한다: ${cmd}`);
  assert.ok(dangerousMatches(cmd).includes(id), `${JSON.stringify(cmd)} → ${id} 가 걸려야 한다 (걸린 것: ${dangerousMatches(cmd).join(',')})`);
}

describe('위험 명령 — 유닉스 계열 (설계 표 "위험한 셸 명령 판별")', () => {
  test('rm -rf · rm -r · rm -fr · rm -Rf · --recursive', () => {
    for (const cmd of ['rm -rf /tmp/x', 'rm -r build', 'rm -fr build', 'rm -Rf build', 'rm --recursive build', 'sudo rm -rf --no-preserve-root /']) {
      hits(cmd, 'rm-recursive');
    }
  });

  test('rm -f 는 되묻지 않는 삭제라 따로 걸린다', () => {
    hits('rm -f a.txt', 'rm-force');
    assert.equal(isDangerousCommand('rm a.txt'), false, '평범한 rm 한 개는 위험 태그까지 붙이지 않는다');
  });

  test('sudo', () => {
    hits('sudo npm i -g @anthropic-ai/claude-code', 'sudo');
    hits('cd /tmp && sudo make install', 'sudo');
  });

  test('chmod -R · chown -R', () => {
    hits('chmod -R 777 .', 'chmod-recursive');
    hits('chown -R me:staff /opt/x', 'chown-recursive');
    assert.equal(isDangerousCommand('chmod +x tool/capture-window.sh'), false, '파일 하나 실행 권한은 위험이 아니다');
  });

  test('git push --force · -f · git reset --hard · git clean -fd', () => {
    hits('git push --force origin main', 'git-push-force');
    hits('git push -f', 'git-push-force');
    hits('git push --force-with-lease', 'git-push-force');
    hits('git reset --hard HEAD~3', 'git-reset-hard');
    hits('git clean -fd', 'git-clean-force');
    hits('git clean -fdx', 'git-clean-force');
    assert.equal(isDangerousCommand('git push origin main'), false);
    assert.equal(isDangerousCommand('git reset HEAD~1'), false, '--hard 없는 reset 은 되돌릴 수 있다');
  });

  test('파일로 리다이렉션(`>`·`>>`) — 해롭지 않은 리다이렉트는 뺀다', () => {
    hits('echo hi > notes.txt', 'write-redirect');
    hits('cat a b >> merged.txt', 'write-redirect');
    for (const safe of ['make 2>&1', 'ls /nope 2>/dev/null', 'claude auth status > $null', 'dir > nul']) {
      assert.ok(!dangerousMatches(safe).includes('write-redirect'), `리다이렉트만으로 위험이 아니다: ${safe}`);
    }
  });

  test('mv 는 덮어쓸 수 있으니 피연산자가 둘이면 위험', () => {
    hits('mv old.txt new.txt', 'mv-overwrite');
    hits('/bin/mv -f a b', 'mv-overwrite');
    assert.equal(isDangerousCommand('mv'), false, '인자 없는 mv 는 아무것도 안 한다');
    assert.ok(!dangerousMatches('rg mv src').includes('mv-overwrite'), '첫 토큰이 mv 일 때만 본다');
  });

  test('truncate · dd · mkfs', () => {
    hits('truncate -s 0 daemon.log', 'truncate');
    hits('dd if=/dev/zero of=/dev/disk2 bs=1m', 'dd');
    hits('mkfs.ext4 /dev/sdb1', 'mkfs');
    assert.equal(isDangerousCommand('dd-report --help'), false, 'dd 는 if=/of=/bs= 가 있을 때만');
  });
});

describe('위험 명령 — PowerShell · CMD 계열 (예전 것을 그대로 남긴다)', () => {
  test('Remove-Item -Recurse / -Force', () => {
    hits('Remove-Item -Recurse -Force .\\build', 'remove-item-recurse');
    hits('remove-item -force x.txt', 'remove-item-force');
    assert.equal(isDangerousCommand('Get-ChildItem -Recurse'), false, '읽기만 하는 -Recurse 는 위험이 아니다');
  });

  test('del /s · rd|rmdir /s · format', () => {
    hits('del /s /q C:\\temp\\*', 'del-s');
    hits('rd /s /q build', 'rd-s');
    hits('rmdir /s build', 'rd-s');
    hits('format D: /fs:ntfs', 'format');
    assert.equal(isDangerousCommand('dart format lib'), false, 'format 은 문장 첫머리일 때만 디스크 포맷이다');
  });

  test('대소문자를 가리지 않는다(PowerShell 관례)', () => {
    assert.equal(isDangerousCommand('REMOVE-ITEM -RECURSE x'), true);
    assert.equal(isDangerousCommand('RM -RF x'), true);
  });
});

describe('표 자체의 규칙', () => {
  test('id 는 중복되지 않고 why 는 비어 있지 않다', () => {
    const ids = DANGER_PATTERNS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const p of DANGER_PATTERNS) assert.ok(p.why.trim().length > 0, `${p.id} 에 설명이 없다`);
  });

  test('빈 명령·undefined 는 위험이 아니다', () => {
    assert.equal(isDangerousCommand(undefined), false);
    assert.equal(isDangerousCommand('   '), false);
    assert.deepEqual(dangerousMatches(''), []);
  });

  test('dangerousReasons 는 걸린 패턴의 설명을 준다', () => {
    const reasons = dangerousReasons('sudo rm -rf /');
    assert.ok(reasons.length >= 2);
    assert.ok(reasons.some((r) => r.includes('sudo')));
  });

  test('위험한 명령은 절대 "읽기 전용" 이 아니다 — 셸 뮤텍스 안전망(D-27)', () => {
    for (const cmd of ['rm -rf build', 'sudo cat /etc/hosts', 'git push --force', 'cat a > b', 'Remove-Item -Recurse x']) {
      assert.equal(isReadOnlyCommand(cmd), false, cmd);
    }
    assert.equal(isReadOnlyCommand('git log --oneline -5'), true, '평범한 읽기는 그대로 읽기다');
  });
});

describe('셸 도구 이름 — 맥 기본 셸도 셸이다', () => {
  test('sh · zsh 가 셸 도구 목록에 있다(PowerShell 계열도 그대로)', () => {
    for (const name of ['bash', 'sh', 'zsh', 'powershell', 'pwsh', 'Local_Shell', 'container.exec']) {
      assert.equal(CODEX_SHELL_TOOLS.has(normalizeToolName(name)), true, name);
    }
    assert.equal(CODEX_SHELL_TOOLS.has(normalizeToolName('Read')), false);
  });
});
