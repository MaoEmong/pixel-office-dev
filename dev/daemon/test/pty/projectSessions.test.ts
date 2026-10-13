import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareProjectSession, projectMemberDir } from '../../src/pty/projectSessions.js';

test('project sessions isolate histories, preserve existing login state and migrate only the resumed conversation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const homes = { claude: path.join(root, 'global-claude'), codex: path.join(root, 'global-codex'), claudeConfig: path.join(root, 'global-claude.json') };
  fs.mkdirSync(path.join(homes.claude, 'projects', 'old-project'), { recursive: true });
  fs.writeFileSync(path.join(homes.claude, '.credentials.json'), '{"test":"original"}');
  fs.writeFileSync(homes.claudeConfig, '{}');
  fs.writeFileSync(path.join(homes.claude, 'projects', 'old-project', 'session-1.jsonl'), 'old conversation\n');
  fs.writeFileSync(path.join(homes.claude, 'projects', 'old-project', 'unrelated.jsonl'), 'not this member');
  const env = prepareProjectSession(cwd, 'm1', 'claude', 'session-1', homes);
  const local = path.join(projectMemberDir(cwd, 'm1'), 'claude');
  assert.equal(env.CLAUDE_CONFIG_DIR, local);
  assert.equal(fs.readFileSync(path.join(local, 'projects', 'old-project', 'session-1.jsonl'), 'utf8'), 'old conversation\n');
  assert.equal(fs.existsSync(path.join(local, 'projects', 'old-project', 'unrelated.jsonl')), false);
  assert.equal(fs.readFileSync(path.join(cwd, '.pixel-office', '.gitignore'), 'utf8'), '*\n');
  fs.writeFileSync(path.join(local, '.credentials.json'), '{"test":"refreshed"}');
  prepareProjectSession(cwd, 'm1', 'claude', 'session-1', homes);
  assert.equal(fs.readFileSync(path.join(local, '.credentials.json'), 'utf8'), '{"test":"refreshed"}');
  assert.equal(fs.readFileSync(path.join(homes.claude, '.credentials.json'), 'utf8'), '{"test":"original"}');
  assert.notEqual(prepareProjectSession(cwd, 'm2', 'claude', undefined, homes).CLAUDE_CONFIG_DIR, local);
  assert.throws(() => projectMemberDir(cwd, '../escape'));

  fs.mkdirSync(path.join(homes.codex, 'sessions', '2026', '10'), { recursive: true });
  fs.writeFileSync(path.join(homes.codex, 'auth.json'), '{}');
  fs.writeFileSync(path.join(homes.codex, 'sessions', '2026', '10', 'rollout-session-2.jsonl'), 'codex history');
  const codex = prepareProjectSession(cwd, 'm3', 'codex', 'session-2', homes);
  assert.equal(codex.CODEX_HOME, codex.CODEX_SQLITE_HOME);
  assert.equal(fs.readFileSync(path.join(codex.CODEX_HOME!, 'sessions', '2026', '10', 'rollout-session-2.jsonl'), 'utf8'), 'codex history');
});
