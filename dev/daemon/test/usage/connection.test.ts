// T43-1 연결 폴링 — 실행 파일 해석(config.ts 규칙 그대로) · 판정 표 · 환경변수 정리.
// 실제 CLI 를 띄우지 않는다: `run` 을 갈아 끼워 실측 출력(픽스처)을 돌려준다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeClaudeConnection, probeCodexConnection, PROBE_TIMEOUT_MS, runCommand, type RunResult } from '../../src/usage/connection.js';
import { DROP_ENV_RE, stripDaemonEnv } from '../../src/pty/env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../fixtures/usage');
const read = (f: string): string => fs.readFileSync(path.join(fixtures, f), 'utf8');

const ok = (stdout: string): RunResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stdout: string, exitCode: number): RunResult => ({ stdout, stderr: '', exitCode });

/** `resolveClaudeExeDetailed` 가 found:true 를 주도록 PIXEL_CLAUDE_EXE 를 쓴다. */
const CLAUDE_ENV = { PIXEL_CLAUDE_EXE: 'D:/fake/claude.exe' };
const CODEX_ENV = { PIXEL_CODEX_EXE: 'D:/fake/codex.exe' };

describe('probeClaudeConnection', () => {
  test('로그인됨 → connected + 요금제', async () => {
    const got = await probeClaudeConnection({ env: CLAUDE_ENV, run: async () => ok(read('claude-auth-status.json')) });
    assert.deepEqual(got, { connected: true, plan: 'max', reason: null });
  });

  test('로그아웃(exit 1) → logged-out', async () => {
    const got = await probeClaudeConnection({ env: CLAUDE_ENV, run: async () => fail(read('claude-auth-status-logged-out.json'), 1) });
    assert.deepEqual(got, { connected: false, plan: null, reason: 'logged-out' });
  });

  test('exe 를 못 찾으면 띄워 보지도 않는다 → not-installed', async () => {
    let ran = false;
    const got = await probeClaudeConnection({
      env: { PATH: path.join(os.tmpdir(), 'nope-pixel'), APPDATA: path.join(os.tmpdir(), 'nope-pixel') },
      platform: 'win32',
      run: async () => {
        ran = true;
        return ok('{}');
      },
    });
    assert.deepEqual(got, { connected: false, plan: null, reason: 'not-installed' });
    assert.equal(ran, false, '없는 exe 는 스폰하지 않는다');
  });

  test('스폰이 ENOENT 면 not-installed (PIXEL_CLAUDE_EXE 가 없는 경로)', async () => {
    const got = await probeClaudeConnection({ env: CLAUDE_ENV, run: async () => ({ stdout: '', stderr: '', exitCode: null, errorCode: 'ENOENT' }) });
    assert.equal(got.reason, 'not-installed');
  });

  test('타임아웃 → unknown', async () => {
    const got = await probeClaudeConnection({ env: CLAUDE_ENV, run: async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true }) });
    assert.deepEqual(got, { connected: false, plan: null, reason: 'unknown' });
  });

  test('JSON 이 아닌 출력(명령 모양이 바뀜) → unknown', async () => {
    const got = await probeClaudeConnection({ env: CLAUDE_ENV, run: async () => ok('Usage: claude auth status') });
    assert.equal(got.reason, 'unknown');
  });

  test('이메일이 들어 있는 출력을 줘도 결과 객체에는 없다 (D-45 ②)', async () => {
    const withEmail = read('claude-auth-status.json').replace('<이메일>', 'someone@example.com').replace('<orgId>', 'org_9');
    const got = await probeClaudeConnection({ env: CLAUDE_ENV, run: async () => ok(withEmail) });
    assert.deepEqual(Object.keys(got).sort(), ['connected', 'plan', 'reason']);
    assert.ok(!JSON.stringify(got).includes('@'), JSON.stringify(got));
    assert.ok(!JSON.stringify(got).includes('org_'), JSON.stringify(got));
  });

  test('명령은 `auth status` 이고 타임아웃 기본값이 5초다', async () => {
    let seen: { file: string; args: string[]; timeout: number } | undefined;
    await probeClaudeConnection({
      env: CLAUDE_ENV,
      run: async (file, args, timeout) => {
        seen = { file, args, timeout };
        return ok('{"loggedIn":true}');
      },
    });
    assert.deepEqual(seen?.args, ['auth', 'status']);
    assert.equal(seen?.file, 'D:/fake/claude.exe');
    assert.equal(seen?.timeout, PROBE_TIMEOUT_MS);
  });
});

describe('probeCodexConnection', () => {
  test('로그인됨 / 로그아웃', async () => {
    assert.deepEqual(await probeCodexConnection({ env: CODEX_ENV, run: async () => ok(read('codex-login-status.txt')) }), {
      connected: true,
      plan: null,
      reason: null,
    });
    assert.deepEqual(await probeCodexConnection({ env: CODEX_ENV, run: async () => fail(read('codex-login-status-logged-out.txt'), 1) }), {
      connected: false,
      plan: null,
      reason: 'logged-out',
    });
  });

  test('PIXEL_CODEX_EXE 가 없는 경로면 ENOENT → not-installed (T43-3 실기가 쓰는 길)', async () => {
    const got = await probeCodexConnection({
      env: { PIXEL_CODEX_EXE: 'D:/no/such/codex.exe' },
      run: async () => ({ stdout: '', stderr: '', exitCode: null, errorCode: 'ENOENT' }),
    });
    assert.deepEqual(got, { connected: false, plan: null, reason: 'not-installed' });
  });

  test('요금제는 이 명령이 주지 않는다(rollout 에서 온다)', async () => {
    const got = await probeCodexConnection({ env: CODEX_ENV, run: async () => ok('Logged in using ChatGPT') });
    assert.equal(got.plan, null);
  });

  test('명령은 `login status`', async () => {
    let args: string[] | undefined;
    await probeCodexConnection({
      env: CODEX_ENV,
      run: async (_f, a) => {
        args = a;
        return ok('Logged in using ChatGPT');
      },
    });
    assert.deepEqual(args, ['login', 'status']);
  });
});

describe('환경변수 정리 (pty/env.ts 와 같은 규칙)', () => {
  test('CLAUDE_CODE* · CLAUDECODE · CLAUDE_CONFIG_DIR 을 지운다', () => {
    const base = {
      PATH: 'p',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDECODE: '1',
      CLAUDE_CONFIG_DIR: 'C:/other',
      claude_config_dir: 'C:/other',
      PIXEL_DATA_DIR: 'D:/data',
    };
    const out = stripDaemonEnv(base);
    assert.deepEqual(Object.keys(out).sort(), ['PATH', 'PIXEL_DATA_DIR']);
    for (const key of Object.keys(base)) {
      if (key === 'PATH' || key === 'PIXEL_DATA_DIR') continue;
      assert.ok(DROP_ENV_RE.test(key), `${key} 는 지워지는 패턴이어야 한다`);
    }
  });

  test('실제 실행기는 거부하지 않고 RunResult 로 실패를 돌려준다', async () => {
    const res = await runCommand(path.join(os.tmpdir(), 'pixel-no-such-exe'), ['--x'], 2_000);
    assert.equal(res.exitCode, null);
    assert.ok(res.errorCode === 'ENOENT' || res.errorCode === 'EACCES' || res.errorCode === 'EPERM', String(res.errorCode));
  });
});
