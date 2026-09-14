// mapping.ts 순수 매핑 표 테스트. 입력 모양은 hooklog-2.json 실측 그대로.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapPreToolUse,
  pathFromInput,
  questionSummary,
  shellFromInput,
  toolDetail,
  truncate,
  MAX_CMD_CHARS,
} from '../../src/adapters/mapping.js';

describe('mapping: PreToolUse tool_name → kind/detail', () => {
  test('reading tools take path from file_path|pattern|path|url|query', () => {
    assert.deepEqual(mapPreToolUse('Read', { file_path: 'D:\\a\\b.ts' }), {
      kind: 'reading',
      detail: { tool: 'Read', path: 'D:\\a\\b.ts' },
    });
    assert.deepEqual(mapPreToolUse('Glob', { pattern: '**/*.ts' }), { kind: 'reading', detail: { tool: 'Glob', path: '**/*.ts' } });
    assert.deepEqual(mapPreToolUse('Grep', { pattern: 'foo', path: 'src' }), {
      kind: 'reading',
      detail: { tool: 'Grep', path: 'foo' },
    });
    assert.deepEqual(mapPreToolUse('LS', { path: 'src' }), { kind: 'reading', detail: { tool: 'LS', path: 'src' } });
    assert.deepEqual(mapPreToolUse('WebFetch', { url: 'https://x.y/' }), {
      kind: 'reading',
      detail: { tool: 'WebFetch', path: 'https://x.y/' },
    });
    assert.deepEqual(mapPreToolUse('WebSearch', { query: 'node sqlite' }), {
      kind: 'reading',
      detail: { tool: 'WebSearch', path: 'node sqlite' },
    });
  });

  test('editing tools: Edit/Write/NotebookEdit/MultiEdit → editing with path', () => {
    const write = { file_path: 'D:\\myproject\\pixel-office\\dev\\spike-0\\sandbox\\multi.txt', content: '첫째 줄\n둘째 줄\n셋째 줄\n' };
    assert.deepEqual(mapPreToolUse('Write', write), {
      kind: 'editing',
      detail: { tool: 'Write', path: write.file_path },
    });
    assert.equal(mapPreToolUse('Edit', { file_path: 'x' })!.kind, 'editing');
    assert.equal(mapPreToolUse('MultiEdit', { file_path: 'x' })!.kind, 'editing');
    assert.deepEqual(mapPreToolUse('NotebookEdit', { notebook_path: 'n.ipynb' }), {
      kind: 'editing',
      detail: { tool: 'NotebookEdit', path: 'n.ipynb' },
    });
  });

  test('shell tools: Bash/PowerShell → running with cmd + summary', () => {
    const bash = { command: 'echo hold > hold.txt', description: 'Write "hold" to hold.txt' };
    assert.deepEqual(mapPreToolUse('Bash', bash), {
      kind: 'running',
      detail: { tool: 'Bash', cmd: 'echo hold > hold.txt', summary: 'Write "hold" to hold.txt' },
    });
    assert.deepEqual(mapPreToolUse('PowerShell', { command: 'ls' }), {
      kind: 'running',
      detail: { tool: 'PowerShell', cmd: 'ls' },
    });
  });

  test('AskUserQuestion → null (asking is produced from PermissionRequest)', () => {
    assert.equal(mapPreToolUse('AskUserQuestion', { questions: [] }), null);
  });

  test('mcp__* and unknown tools → running with tool (and summary from description)', () => {
    assert.deepEqual(mapPreToolUse('mcp__team__delegate', { to_member: 'm2' }), {
      kind: 'running',
      detail: { tool: 'mcp__team__delegate' },
    });
    assert.deepEqual(mapPreToolUse('Agent', { description: 'Explore repo', prompt: '...' }), {
      kind: 'running',
      detail: { tool: 'Agent', summary: 'Explore repo' },
    });
    assert.deepEqual(mapPreToolUse('TodoWrite', { todos: [] }), { kind: 'running', detail: { tool: 'TodoWrite' } });
  });

  test('helpers tolerate non-object input and truncate long strings', () => {
    assert.equal(pathFromInput(undefined), undefined);
    assert.equal(pathFromInput('nope'), undefined);
    assert.deepEqual(shellFromInput(null), {});
    assert.deepEqual(toolDetail('Bash', undefined), { tool: 'Bash' });
    const long = 'x'.repeat(MAX_CMD_CHARS + 50);
    const d = toolDetail('Bash', { command: long });
    assert.equal(d.cmd!.length, MAX_CMD_CHARS);
    assert.ok(d.cmd!.endsWith('…'));
    assert.equal(truncate('abc', 10), 'abc');
  });

  test('questionSummary joins question texts', () => {
    const input = {
      questions: [
        { question: '좋아하는 색은?', header: '색', options: [{ label: '빨강' }, { label: '파랑' }], multiSelect: false },
        { question: '크기는?', header: '크기', options: [] },
      ],
    };
    assert.equal(questionSummary(input), '좋아하는 색은? / 크기는?');
    assert.equal(questionSummary({}), undefined);
    assert.equal(questionSummary({ questions: [{}] }), undefined);
  });
});
