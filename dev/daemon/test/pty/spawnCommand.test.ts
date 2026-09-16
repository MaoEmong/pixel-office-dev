// prepareSpawnCommand(T20): 엔진별 실행 파일·인자 + hook 설정 파일. 실측 ②④.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareSpawnCommand } from '../../src/pty/PtyManager.js';
import { PIXEL_OFFICE_MARKER, codexHooksPath, CODEX_HOOK_EVENTS } from '../../src/pty/hookSettings.js';
import type { SpawnOptions } from '../../src/pty/types.js';

const cfg = { claudeExe: 'C:\\claude.exe', codexExe: 'C:\\codex.exe', dataDir: '' };

describe('prepareSpawnCommand', () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t20-spawn-'));
    cwd = path.join(dir, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const opts = (over: Partial<SpawnOptions> = {}): SpawnOptions => ({
    memberId: 'm1',
    memberToken: 'tok',
    engine: 'codex',
    cwd,
    hookScriptPath: 'D:\\daemon\\src\\hooks\\hook.js',
    hookPort: 7421,
    ...over,
  });

  test('codex: 실측 플래그 + cwd 의 .codex/hooks.json (pixel-office 마커, node hook 명령)', () => {
    const cmd = prepareSpawnCommand({ ...cfg, dataDir: dir }, opts());
    assert.equal(cmd.file, 'C:\\codex.exe');
    assert.deepEqual(cmd.args, ['--dangerously-bypass-hook-trust', '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"']);
    assert.equal(cmd.warn, undefined);

    const file = codexHooksPath(cwd);
    assert.ok(fs.existsSync(file), `hooks.json written: ${file}`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { description: string; hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    assert.equal(parsed.description, PIXEL_OFFICE_MARKER);
    assert.deepEqual(Object.keys(parsed.hooks).sort(), [...CODEX_HOOK_EVENTS].sort());
    assert.ok(parsed.hooks.Interrupt, 'Codex 는 Interrupt hook 이 있다');
    assert.equal(parsed.hooks.PreToolUse![0]!.hooks[0]!.command, 'node D:/daemon/src/hooks/hook.js 7421 PreToolUse');
  });

  test('codex: mcpUrl 이 있으면 -c mcp_servers.team.url="…" 이 붙는다 (T22, 실측: codex mcp add --url 이 쓰는 키)', () => {
    const url = 'http://127.0.0.1:7422/mcp/abc123';
    const cmd = prepareSpawnCommand({ ...cfg, dataDir: dir }, opts({ mcpUrl: url }));
    assert.deepEqual(cmd.args, [
      '--dangerously-bypass-hook-trust',
      '-c',
      'approval_policy="on-request"',
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      `mcp_servers.team.url="${url}"`,
    ]);
    // 재개 때도 같은 인자가 붙는다(resume 서브커맨드가 맨 앞).
    const again = prepareSpawnCommand({ ...cfg, dataDir: dir }, opts({ mcpUrl: url, resumeSessionId: '01a0' }));
    assert.deepEqual(again.args.slice(0, 2), ['resume', '01a0']);
    assert.ok(again.args.includes(`mcp_servers.team.url="${url}"`));
    assert.equal(again.args.includes('--mcp-config'), false, 'Codex 에는 Claude 플래그를 쓰지 않는다');
  });

  test('codex: 재개는 resume <id> 가 맨 앞', () => {
    const cmd = prepareSpawnCommand({ ...cfg, dataDir: dir }, opts({ resumeSessionId: '01a09f50-13fe' }));
    assert.deepEqual(cmd.args.slice(0, 2), ['resume', '01a09f50-13fe']);
    assert.ok(cmd.args.includes('--dangerously-bypass-hook-trust'));
  });

  test('codex: 남이 쓴 hooks.json 은 덮어쓰지 않고 경고', () => {
    const file = codexHooksPath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ description: 'someone else', hooks: {} }));
    const cmd = prepareSpawnCommand({ ...cfg, dataDir: dir }, opts());
    assert.match(cmd.warn ?? '', /was not written by pixel-office/);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).description, 'someone else');
  });

  test('codex: 우리가 쓴 파일(스파이크 포함)은 덮어쓴다', () => {
    const file = codexHooksPath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ description: 'pixel-office spike', hooks: {} }));
    const cmd = prepareSpawnCommand({ ...cfg, dataDir: dir }, opts({ hookPort: 9999 }));
    assert.equal(cmd.warn, undefined);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    assert.match(parsed.hooks.SessionStart![0]!.hooks[0]!.command, /9999 SessionStart$/);
  });

  test('claude: --settings 세션 파일 + --permission-mode default (+mcp-config)', () => {
    const cmd = prepareSpawnCommand({ ...cfg, dataDir: dir }, opts({ engine: 'claude', mcpConfigPath: 'D:\\mcp.json' }));
    assert.equal(cmd.file, 'C:\\claude.exe');
    assert.equal(cmd.args[0], '--settings');
    assert.equal(cmd.args[1], path.join(dir, 'sessions', 'm1', 'claude-settings.json'));
    assert.ok(cmd.args.includes('--permission-mode'));
    assert.deepEqual(cmd.args.slice(-2), ['--mcp-config', 'D:\\mcp.json']);
    assert.ok(fs.existsSync(cmd.args[1]!));
    assert.equal(fs.existsSync(codexHooksPath(cwd)), false, 'claude 는 .codex/hooks.json 을 만들지 않는다');
  });
});
