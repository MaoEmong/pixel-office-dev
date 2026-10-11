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
/**
 * hook 명령의 첫 토큰 — 지금 이 데몬을 돌리는 node 의 **절대 경로**다(맨 `node` 가 아니다).
 * CLI 는 hook 을 셸로 돌리고 그 셸은 데몬의 PATH 를 물려받는데, Finder 로 띄운 앱이 낳은 데몬은
 * PATH 에 nvm·Homebrew 가 없어 맨 `node` 가 `command not found` 로 죽는다(T51 실기).
 * 경로에 공백이 있으면 따옴표가 붙는 것도 명령 생성기와 같은 규칙이라 여기서 그대로 흉내 낸다.
 */
const NODE = (() => {
  const p = process.execPath.replace(/\\/g, '/');
  return /\s/.test(p) ? `"${p}"` : p;
})();

const PORT = 7421;

describe('buildHookCommand', () => {
  test('uses forward slashes and `node <script> <port> <event>` shape', () => {
    assert.equal(buildHookCommand(HOOK, PORT, 'Stop'), `${NODE} D:/myproject/pixel-office/dev/daemon/src/hooks/hook.js 7421 Stop`);
  });

  test('quotes the script path only when it contains whitespace', () => {
    assert.equal(buildHookCommand('C:\\Program Files\\x\\hook.js', 1, 'Stop'), `${NODE} "C:/Program Files/x/hook.js" 1 Stop`);
    assert.equal(buildHookCommand('/c/x/hook.js', 1, 'Stop'), `${NODE} /c/x/hook.js 1 Stop`);
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
      assert.equal(h.command, `${NODE} D:/myproject/pixel-office/dev/daemon/src/hooks/hook.js ${PORT} ${ev}`);
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
      command: `${NODE} D:/myproject/pixel-office/dev/daemon/src/hooks/statusline.js ${PORT}`,
      padding: 0,
    });
    assert.ok(!withLine.statusLine!.command.includes('\\'), 'no backslashes');
  });

  test('buildStatusLineCommand: 공백 있는 경로만 큰따옴표(hook 명령과 같은 규칙)', () => {
    assert.equal(buildStatusLineCommand('C:\\Program Files\\x\\statusline.js', 1), `${NODE} "C:/Program Files/x/statusline.js" 1`);
    assert.equal(buildStatusLineCommand('/c/x/statusline.js', 1), `${NODE} /c/x/statusline.js 1`);
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
    assert.deepEqual(h, { type: 'command', command: `${NODE} D:/myproject/pixel-office/dev/daemon/src/hooks/hook.js ${PORT} Interrupt`, timeout: HOOK_TIMEOUT_SEC });
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
    assert.equal((parsed as { statusLine: { command: string } }).statusLine.command, `${NODE} D:/myproject/pixel-office/dev/daemon/src/hooks/statusline.js ${PORT}`);
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

// ─────────────────────────────────────────────────────────────────────────────
// T48-1: 맥의 데이터 폴더는 `~/Library/Application Support/pixel-office` — **경로에 공백이 있다.**
// 윈도우 `%LOCALAPPDATA%` 에는 공백이 없어 지금까지 드러나지 않던 자리다(설계 표 "세션 설정 파일의 hook 명령").
// hook 명령은 셸이 한 줄로 받아 단어를 쪼개므로 공백이 든 경로는 **반드시 따옴표** 안에 있어야 한다.
// ─────────────────────────────────────────────────────────────────────────────
describe('공백이 든 경로 인용 — 맥 `Application Support` (T48-1)', () => {
  const MAC_DATA = '/Users/me/Library/Application Support/pixel-office';
  const MAC_HOOK = `${MAC_DATA}/hooks/hook.js`;
  const MAC_STATUSLINE = `${MAC_DATA}/hooks/statusline.js`;

  test('hook 명령: 경로만 따옴표 안에 있고 포트·이벤트는 밖에 있다', () => {
    assert.equal(buildHookCommand(MAC_HOOK, PORT, 'PreToolUse'), `${NODE} "${MAC_HOOK}" 7421 PreToolUse`);
  });

  test('statusLine 명령도 같은 규칙', () => {
    assert.equal(buildStatusLineCommand(MAC_STATUSLINE, PORT), `${NODE} "${MAC_STATUSLINE}" 7421`);
  });

  test('Claude 세션 설정 JSON: 모든 이벤트 명령이 인용돼 있고 셸이 볼 토큰은 넷이다', () => {
    const json = JSON.parse(JSON.stringify(buildClaudeSessionSettings(MAC_HOOK, PORT, MAC_STATUSLINE))) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      statusLine: { command: string };
    };
    for (const event of CLAUDE_HOOK_EVENTS) {
      const command = json.hooks[event]![0]!.hooks[0]!.command;
      assert.equal(command, `${NODE} "${MAC_HOOK}" ${PORT} ${event}`, event);
      assert.deepEqual(command.match(/"[^"]*"|\S+/g), [NODE, `"${MAC_HOOK}"`, String(PORT), event]);
    }
    assert.equal(json.statusLine.command, `${NODE} "${MAC_STATUSLINE}" ${PORT}`);
  });

  test('Codex `.codex/hooks.json` 도 같은 인용을 쓴다', () => {
    const file = buildCodexHooksFile(MAC_HOOK, PORT);
    for (const event of CODEX_HOOK_EVENTS) {
      assert.equal(file.hooks[event]![0]!.hooks[0]!.command, `${NODE} "${MAC_HOOK}" ${PORT} ${event}`, event);
    }
  });

  test('공백이 든 데이터 폴더·cwd 에 실제로 써 본다(임시 폴더)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t48-quote-'));
    try {
      const dataDir = path.join(root, 'Application Support', 'pixel-office');
      const file = writeClaudeSessionSettings(dataDir, 'm1', MAC_HOOK, PORT, MAC_STATUSLINE);
      assert.equal(file, claudeSettingsPath(dataDir, 'm1'));
      assert.ok(/\s/.test(file), '데이터 폴더에 공백이 있는 상황이 이 테스트의 전제다');
      const written = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      assert.equal(written.hooks.SessionStart![0]!.hooks[0]!.command, `${NODE} "${MAC_HOOK}" ${PORT} SessionStart`);

      // Codex: cwd 에 공백이 있어도 파일 **경로**는 path.join 이 맡는다(명령 문자열이 아니라 인자다).
      const cwd = path.join(root, 'my project');
      fs.mkdirSync(cwd, { recursive: true });
      const res = ensureCodexHooksFile(cwd, MAC_HOOK, PORT);
      assert.equal(res.written, true);
      assert.equal(res.path, path.join(cwd, '.codex', 'hooks.json'));
      const codexJson = JSON.parse(fs.readFileSync(res.path, 'utf8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      assert.equal(codexJson.hooks.SessionStart![0]!.hooks[0]!.command, `${NODE} "${MAC_HOOK}" ${PORT} SessionStart`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('윈도우 경로는 예전 그대로 — 공백이 없으면 따옴표를 붙이지 않는다', () => {
    assert.equal(buildHookCommand(HOOK, PORT, 'Stop'), `${NODE} D:/myproject/pixel-office/dev/daemon/src/hooks/hook.js 7421 Stop`);
    assert.equal(buildStatusLineCommand(STATUSLINE, PORT), `${NODE} D:/myproject/pixel-office/dev/daemon/src/hooks/statusline.js 7421`);
  });
});
