// codexMapping 순수 함수 테스트(T20). 설계 01 §2 표의 Codex 열: 읽기 명령 휴리스틱 / apply_patch / 그 외 셸.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatchPath, classifyCommand, isApplyPatch, isReadOnlyCommand, mapCodexTool, normalizeToolName, parseSegment, splitCommand } from '../../src/adapters/codexMapping.js';

describe('codexMapping', () => {
  test('normalizeToolName: 대소문자·구분자 무시', () => {
    assert.equal(normalizeToolName('apply_patch'), 'applypatch');
    assert.equal(normalizeToolName('ApplyPatch'), 'applypatch');
    assert.equal(normalizeToolName('apply-patch'), 'applypatch');
    assert.equal(normalizeToolName('Bash'), 'bash');
  });

  test('splitCommand / parseSegment: 파이프·&&·환경변수 접두·경로·확장자', () => {
    assert.deepEqual(splitCommand('cd src && cat a.ts | head -5'), ['cd src', 'cat a.ts', 'head -5']);
    assert.deepEqual(parseSegment('FOO=1 /usr/bin/cat a.ts'), { name: 'cat', args: ['a.ts'] });
    assert.deepEqual(parseSegment('C:\\Windows\\System32\\findstr.exe /I x'), { name: 'findstr', args: ['/I', 'x'] });
    assert.equal(parseSegment('   '), undefined);
  });

  describe('isReadOnlyCommand', () => {
    const readOnly = [
      'cat outside.txt',
      'rg -n TODO src',
      'ls -la',
      'dir',
      'type hello.txt',
      'Get-Content .\\a.txt',
      'sed -n 1,20p src/a.ts',
      'git diff --stat',
      'git log --oneline -5',
      'git status',
      'cd src && cat a.ts',
      'rg -n foo src | head -20',
      'grep -r foo . 2>/dev/null',
      'find . -name *.ts',
    ];
    for (const cmd of readOnly) {
      test(`읽기: ${cmd}`, () => assert.equal(isReadOnlyCommand(cmd), true, cmd));
    }

    const notReadOnly = [
      'echo hi > hello.txt',
      'cat a.txt > b.txt',
      'rm -rf build',
      'npm test',
      'git commit -m x',
      'git add .',
      'sed -i s/a/b/ a.ts',
      'sed s/a/b/ a.ts',
      'cat a.ts && npm run build',
      'bash -lc "cat a.ts"',
      'powershell -Command "Get-Content a.txt"',
      'find . -name *.tmp -delete',
      '',
      'cd src',
    ];
    for (const cmd of notReadOnly) {
      test(`읽기 아님: ${JSON.stringify(cmd)}`, () => assert.equal(isReadOnlyCommand(cmd), false, cmd));
    }
  });

  describe('apply_patch', () => {
    const patch = "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: src/office/Office.ts\n@@\n-a\n+b\n*** End Patch\nPATCH";
    test('첫 토큰이 apply_patch 이거나 패치 본문이 있으면 editing', () => {
      assert.equal(isApplyPatch(patch), true);
      assert.equal(classifyCommand(patch), 'editing');
      assert.equal(classifyCommand('bash -lc "*** Begin Patch"'), 'editing');
    });
    test('문자열로만 등장하면 apply_patch 가 아니다(검색 명령)', () => {
      assert.equal(isApplyPatch("rg -n 'apply_patch' src"), false);
      assert.equal(classifyCommand("rg -n 'apply_patch' src"), 'reading');
    });
    test('applyPatchPath: 첫 파일 경로', () => {
      assert.equal(applyPatchPath(patch), 'src/office/Office.ts');
      assert.equal(applyPatchPath('*** Add File: a/b c.txt'), 'a/b c.txt');
      assert.equal(applyPatchPath('*** Delete File: gone.txt'), 'gone.txt');
      assert.equal(applyPatchPath('no patch here'), undefined);
    });
  });

  describe('mapCodexTool', () => {
    test('Bash + 쓰기 명령 → running{tool,cmd}', () => {
      assert.deepEqual(mapCodexTool('Bash', { command: 'echo hi > ../outside.txt' }), {
        kind: 'running',
        detail: { tool: 'Bash', cmd: 'echo hi > ../outside.txt' },
      });
    });

    test('PermissionRequest 의 description 은 summary 로 (실측: 한국어 승인 문구)', () => {
      const m = mapCodexTool('Bash', { command: 'cat a.txt', description: 'a.txt 를 읽을까요?' });
      assert.equal(m.kind, 'reading');
      assert.deepEqual(m.detail, { tool: 'Bash', cmd: 'cat a.txt', summary: 'a.txt 를 읽을까요?' });
    });

    test('셸에서 돌린 apply_patch → editing{path}', () => {
      const m = mapCodexTool('shell', { command: "apply_patch <<'P'\n*** Begin Patch\n*** Add File: new.txt\n*** End Patch\nP" });
      assert.equal(m.kind, 'editing');
      assert.equal(m.detail.path, 'new.txt');
    });

    test('편집 도구 이름(apply_patch / fileChange)은 입력에서 경로를 찾는다', () => {
      assert.deepEqual(mapCodexTool('apply_patch', { patch: '*** Begin Patch\n*** Update File: src/x.ts\n*** End Patch' }), {
        kind: 'editing',
        detail: { tool: 'apply_patch', path: 'src/x.ts' },
      });
      assert.deepEqual(mapCodexTool('fileChange', { file_path: 'D:/p/a.ts' }), { kind: 'editing', detail: { tool: 'fileChange', path: 'D:/p/a.ts' } });
    });

    test('빈/이상한 입력도 터지지 않는다', () => {
      assert.deepEqual(mapCodexTool('Bash', undefined), { kind: 'running', detail: { tool: 'Bash' } });
      assert.deepEqual(mapCodexTool('Bash', { command: 123 }), { kind: 'running', detail: { tool: 'Bash' } });
      assert.equal(mapCodexTool('무슨도구', { x: 1 }).kind, 'running');
    });

    test('Claude 이름표 도구가 오면 그 매핑을 쓴다(mcp__*, Read 등)', () => {
      assert.deepEqual(mapCodexTool('Read', { file_path: 'a.ts' }), { kind: 'reading', detail: { tool: 'Read', path: 'a.ts' } });
      assert.deepEqual(mapCodexTool('mcp__team__report', { summary: 'x' }), { kind: 'running', detail: { tool: 'mcp__team__report' } });
    });
  });
});
