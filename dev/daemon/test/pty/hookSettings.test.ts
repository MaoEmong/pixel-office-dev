// 세션 hooks 설정 파일 생성기 단위 테스트 — 스폰 없음.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  HOOK_TIMEOUT_SEC,
  PIXEL_OFFICE_MARKER,
  buildClaudeSessionSettings,
  buildCodexHooksFile,
  buildHookCommand,
  buildStatusLineCommand,
  claudeSettingsPath,
  codexHooksPath,
  ensureCodexHooksFile,
  isPixelOfficeHooksFile,
  toForwardSlashes,
  writeClaudeSessionSettings,
} from '../../src/pty/hookSettings.js';

const HOOK = 'D:\\myproject\\pixel-office\\dev\\daemon\\src\\hooks\\hook.js';
/** T43: 같은 폴더의 statusLine 스크립트. */
const STATUSLINE = 'D:\\myproject\\pixel-office\\dev\\daemon\\src\\hooks\\statusline.js';
const PORT = 7421;

describe('buildHookCommand', () => {
  test('uses forward slashes and `node <script> <port> <event>` shape', () => {
    assert.equal(buildHookCommand(HOOK, PORT, 'Stop'), 'node D:/myproject/pixel-office/dev/daemon/src/hooks/hook.js 7421 Stop');
  });

  test('quotes the script path only when it contains whitespace', () => {
    assert.equal(buildHookCommand('C:\\Program Files\\x\\hook.js', 1, 'Stop'), 'node "C:/Program Files/x/hook.js" 1 Stop');
    assert.equal(buildHookCommand('/c/x/hook.js', 1, 'Stop'), 'node /c/x/hook.js 1 Stop');
  });

  test('toForwardSlashes leaves forward-slash paths alone', () => {
    assert.equal(toForwardSlashes('D:/a/b.js'), 'D:/a/b.js');
    assert.equal(toForwardSlashes('D:\\a\\b.js'), 'D:/a/b.js');
  });
});

describe('buildClaudeSessionSettings', () => {
  const settings = buildClaudeSessionSettings(HOOK, PORT);

  test('has exactly the 11 verified Claude events', () => {
    assert.deepEqual(Object.keys(settings.hooks), [...CLAUDE_HOOK_EVENTS]);
    assert.equal(CLAUDE_HOOK_EVENTS.length, 11);
    for (const ev of ['SessionStart', 'PostToolUseFailure', 'PermissionRequest', 'PreCompact', 'SessionEnd']) {
      assert.ok(ev in settings.hooks, `missing ${ev}`);
    }
  });

  test('each event has one matcher group with one command hook, timeout = HOOK_TIMEOUT_SEC, event name as last arg', () => {
    for (const ev of CLAUDE_HOOK_EVENTS) {
      const groups = settings.hooks[ev];
      assert.equal(groups.length, 1);
      assert.equal(groups[0].hooks.length, 1);
      const h = groups[0].hooks[0];
      assert.equal(h.type, 'command');
      assert.equal(h.timeout, HOOK_TIMEOUT_SEC);
      assert.equal(h.timeout, 86400);
      assert.equal(h.command, `node D:/myproject/pixel-office/dev/daemon/src/hooks/hook.js ${PORT} ${ev}`);
      assert.ok(!h.command.includes('\\'), 'no backslashes in hook command');
    }
  });

  test('has no marker key at top level (only hooks) and round-trips through JSON', () => {
    assert.deepEqual(Object.keys(settings), ['hooks']);
    assert.deepEqual(JSON.parse(JSON.stringify(settings)), settings);
  });

  // ---- T43: statusLine 주입 ------------------------------------------------------
  test('statusLine 경로를 주지 않으면 statusLine 키가 없다(예전 그대로)', () => {
    assert.equal('statusLine' in settings, false);
  });

  test('statusLine 경로를 주면 `node <경로> <port>` 명령이 붙는다 (hooks 는 그대로)', () => {
    const withLine = buildClaudeSessionSettings(HOOK, PORT, STATUSLINE);
    assert.deepEqual(Object.keys(withLine), ['hooks', 'statusLine']);
    assert.deepEqual(withLine.hooks, settings.hooks, 'hooks 는 손대지 않는다');
    assert.deepEqual(withLine.statusLine, {
      type: 'command',
      command: `node D:/myproject/pixel-office/dev/daemon/src/hooks/statusline.js ${PORT}`,
      padding: 0,
    });
    assert.ok(!withLine.statusLine!.command.includes('\\'), 'no backslashes');
  });

  test('buildStatusLineCommand: 공백 있는 경로만 큰따옴표(hook 명령과 같은 규칙)', () => {
    assert.equal(buildStatusLineCommand('C:\\Program Files\\x\\statusline.js', 1), 'node "C:/Program Files/x/statusline.js" 1');
    assert.equal(buildStatusLineCommand('/c/x/statusline.js', 1), 'node /c/x/statusline.js 1');
  });
});

describe('buildCodexHooksFile', () => {
  const file = buildCodexHooksFile(HOOK, PORT);

  test('carries the pixel-office marker and the 8 verified Codex events', () => {
    assert.equal(file.description, PIXEL_OFFICE_MARKER);
    assert.equal(file.description, 'pixel-office');
    assert.deepEqual(Object.keys(file.hooks), [...CODEX_HOOK_EVENTS]);
    assert.equal(CODEX_HOOK_EVENTS.length, 8);
    assert.ok('Interrupt' in file.hooks);
    assert.ok(!('Notification' in file.hooks));
  });

  test('uses the same hook shape as Claude', () => {
    const h = file.hooks.Interrupt[0].hooks[0];
    assert.deepEqual(h, { type: 'command', command: `node D:/myproject/pixel-office/dev/daemon/src/hooks/hook.js ${PORT} Interrupt`, timeout: HOOK_TIMEOUT_SEC });
  });
});

describe('isPixelOfficeHooksFile', () => {
  test('true for our file and for the spike marker prefix', () => {
    assert.equal(isPixelOfficeHooksFile(JSON.stringify(buildCodexHooksFile(HOOK, PORT))), true);
    assert.equal(isPixelOfficeHooksFile('{"description":"pixel-office spike","hooks":{}}'), true);
  });

  test('false for foreign files, missing description, and invalid JSON', () => {
    assert.equal(isPixelOfficeHooksFile('{"hooks":{}}'), false);
    assert.equal(isPixelOfficeHooksFile('{"description":"my hooks","hooks":{}}'), false);
    assert.equal(isPixelOfficeHooksFile('{"description":42}'), false);
    assert.equal(isPixelOfficeHooksFile('not json'), false);
    assert.equal(isPixelOfficeHooksFile('null'), false);
    assert.equal(isPixelOfficeHooksFile(''), false);
  });
});

describe('paths', () => {
  test('claudeSettingsPath is <dataDir>/sessions/<memberId>/claude-settings.json', () => {
    assert.equal(claudeSettingsPath('D:\\data', 'm1'), path.join('D:\\data', 'sessions', 'm1', 'claude-settings.json'));
  });

  test('codexHooksPath is <cwd>/.codex/hooks.json', () => {
    assert.equal(codexHooksPath('D:\\proj'), path.join('D:\\proj', '.codex', 'hooks.json'));
  });
});

describe('file writers (temp dir, no spawn)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-pty-test-'));

  test('writeClaudeSessionSettings creates dirs and writes valid settings', () => {
    const file = writeClaudeSessionSettings(tmp, 'member-a', HOOK, PORT);
    assert.equal(file, claudeSettingsPath(tmp, 'member-a'));
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(parsed, buildClaudeSessionSettings(HOOK, PORT));
  });

  // T43: 같은 파일에 statusLine 도 같이 들어간다(실측에서 hooks 와 충돌 없음).
  test('writeClaudeSessionSettings writes statusLine when a script path is given', () => {
    const file = writeClaudeSessionSettings(tmp, 'member-line', HOOK, PORT, STATUSLINE);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(parsed, buildClaudeSessionSettings(HOOK, PORT, STATUSLINE));
    assert.equal((parsed as { statusLine: { command: string } }).statusLine.command, `node D:/myproject/pixel-office/dev/daemon/src/hooks/statusline.js ${PORT}`);
    assert.equal(Object.keys(parsed.hooks).length, CLAUDE_HOOK_EVENTS.length);
  });

  test('ensureCodexHooksFile writes when absent, overwrites its own file, refuses a foreign file', () => {
    const cwd = path.join(tmp, 'proj');
    fs.mkdirSync(cwd);
    const first = ensureCodexHooksFile(cwd, HOOK, PORT);
    assert.equal(first.written, true);
    assert.equal(first.path, codexHooksPath(cwd));
    assert.equal(isPixelOfficeHooksFile(fs.readFileSync(first.path, 'utf8')), true);

    // 우리 파일은 다른 포트로 덮어쓴다
    const second = ensureCodexHooksFile(cwd, HOOK, 9999);
    assert.equal(second.written, true);
    assert.match(fs.readFileSync(second.path, 'utf8'), /hook\.js 9999 SessionStart/);

    // 남의 파일은 건드리지 않는다
    const foreign = '{"description":"user hooks","hooks":{"Stop":[]}}';
    fs.writeFileSync(second.path, foreign);
    const third = ensureCodexHooksFile(cwd, HOOK, PORT);
    assert.equal(third.written, false);
    assert.match(third.reason ?? '', /not written by pixel-office/);
    assert.equal(fs.readFileSync(third.path, 'utf8'), foreign);
  });
});
