// 환경변수 정리기 + 인자 생성기 단위 테스트 — 스폰 없음.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CHILD_TERM, DROP_ENV_RE, sanitizeEnv } from '../../src/pty/env.js';
import { buildClaudeArgs, buildCodexArgs } from '../../src/pty/args.js';

describe('sanitizeEnv', () => {
  const base: NodeJS.ProcessEnv = {
    PATH: 'C:\\x',
    HOME: 'C:\\Users\\u',
    TERM: 'dumb',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDECODE: '1',
    claudecode_lower: 'x',
    CLAUDE_CONFIG_DIR: 'C:\\cfg',
    claude_code_mixed: 'y',
    CLAUDE_MODEL: 'keep-me', // CLAUDE_ 로 시작하지만 패턴에 없음 → 유지
    ANTHROPIC_API_KEY: 'keep',
    UNDEFINED_ONE: undefined,
  };

  test('drops CLAUDE_CODE*/CLAUDECODE*/CLAUDE_CONFIG_DIR case-insensitively, keeps the rest', () => {
    const env = sanitizeEnv(base, 'tok-1');
    for (const k of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE', 'claudecode_lower', 'CLAUDE_CONFIG_DIR', 'claude_code_mixed']) {
      assert.ok(!(k in env), `${k} should be dropped`);
    }
    assert.equal(env.PATH, 'C:\\x');
    assert.equal(env.HOME, 'C:\\Users\\u');
    assert.equal(env.CLAUDE_MODEL, 'keep-me');
    assert.equal(env.ANTHROPIC_API_KEY, 'keep');
  });

  test('sets PIXEL_MEMBER and forces TERM=xterm-256color', () => {
    const env = sanitizeEnv(base, 'tok-1');
    assert.equal(env.PIXEL_MEMBER, 'tok-1');
    assert.equal(env.TERM, 'xterm-256color');
    assert.equal(env.TERM, CHILD_TERM);
  });

  test('skips undefined values and returns only strings', () => {
    const env = sanitizeEnv(base, 'tok-1');
    assert.ok(!('UNDEFINED_ONE' in env));
    for (const v of Object.values(env)) assert.equal(typeof v, 'string');
  });

  test('does not mutate the input', () => {
    const copy = { ...base };
    sanitizeEnv(base, 'tok-1');
    assert.deepEqual(base, copy);
    assert.ok(!('PIXEL_MEMBER' in base));
  });

  test('DROP_ENV_RE matches the documented prefixes', () => {
    for (const k of ['CLAUDE_CODE_X', 'CLAUDECODE', 'CLAUDECODE_Y', 'CLAUDE_CONFIG_DIR', 'claude_code_x']) assert.ok(DROP_ENV_RE.test(k), k);
    for (const k of ['CLAUDE', 'CLAUDE_MODEL', 'PIXEL_MEMBER', 'XCLAUDE_CODE']) assert.ok(!DROP_ENV_RE.test(k), k);
  });
});

describe('buildClaudeArgs (T17 --mcp-config)', () => {
  test('mcpConfigPath adds --mcp-config after --resume and before extraArgs', () => {
    assert.deepEqual(buildClaudeArgs('D:\\s.json', undefined, [], { mcpConfigPath: 'D:\\m.json' }), [
      '--settings',
      'D:\\s.json',
      '--permission-mode',
      'default',
      '--mcp-config',
      'D:\\m.json',
    ]);
    assert.deepEqual(buildClaudeArgs('D:\\s.json', 'sess-1', ['--model', 'x'], { mcpConfigPath: 'D:\\m.json' }), [
      '--settings',
      'D:\\s.json',
      '--permission-mode',
      'default',
      '--resume',
      'sess-1',
      '--mcp-config',
      'D:\\m.json',
      '--model',
      'x',
    ]);
  });
});

describe('buildClaudeArgs', () => {
  test('fresh session', () => {
    assert.deepEqual(buildClaudeArgs('D:\\s.json'), ['--settings', 'D:\\s.json', '--permission-mode', 'default']);
  });
  test('resume + extra args appended', () => {
    assert.deepEqual(buildClaudeArgs('D:\\s.json', 'sess-1', ['--model', 'x']), [
      '--settings', 'D:\\s.json', '--permission-mode', 'default', '--resume', 'sess-1', '--model', 'x',
    ]);
  });
});

describe('buildCodexArgs', () => {
  test('fresh session', () => {
    assert.deepEqual(buildCodexArgs(), [
      '--dangerously-bypass-hook-trust', '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"',
    ]);
  });
  test('resume subcommand goes first, extra args last', () => {
    assert.deepEqual(buildCodexArgs('01a09f4f', ['-m', 'x']), [
      'resume', '01a09f4f', '--dangerously-bypass-hook-trust', '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"', '-m', 'x',
    ]);
  });
});
