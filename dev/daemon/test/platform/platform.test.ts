// T48-1: 운영체제에 닿는 코드(`src/platform.ts`)를 **플랫폼을 주입해** 고정한다(D-48 원칙 4).
//
// 이 파일에는 진짜 `ps`/`kill`/`tasklist`/PowerShell 을 부르는 테스트가 **하나도 없다** — `spawnSync`·`kill` 은
// 전부 가짜이고, 검사하는 것은 ① 어떤 명령에 어떤 인자를 줬는지 ② 그 출력을 어떻게 읽었는지다.
// 파일 트리(실행 파일 탐색)만 실제 임시 폴더를 쓴다(윈도우 테스트가 예전부터 그렇게 한다).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPlatform,
  dataDir,
  installShutdownSignals,
  killOrder,
  npmGlobalRoots,
  parseLstart,
  parsePidPpid,
  type PlatformDeps,
  type SpawnSyncLike,
} from '../../src/platform.js';

/** 가짜 spawnSync: 호출을 기록하고 `answers[file]` 의 stdout 을 돌려준다. */
function fakeSpawn(answers: Record<string, string> = {}) {
  const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
  const spawnSync: SpawnSyncLike = (file, args, options) => {
    calls.push({ file, args: [...args], options: options as Record<string, unknown> });
    return { status: 0, stdout: answers[file] ?? '', stderr: '' };
  };
  return { spawnSync, calls };
}

/** 가짜 kill: 신호를 기록하고, `fail[pid]` 가 있으면 그 code 로 던진다. */
function fakeKill(fail: Record<number, string> = {}) {
  const sent: Array<{ pid: number; signal: number | NodeJS.Signals }> = [];
  const kill = (pid: number, signal: number | NodeJS.Signals): void => {
    sent.push({ pid, signal });
    const code = fail[pid];
    if (code) {
      const err = new Error(code) as NodeJS.ErrnoException;
      err.code = code;
      throw err;
    }
  };
  return { kill, sent };
}

const HOME = '/Users/me';

function plat(over: Partial<PlatformDeps>) {
  return createPlatform({ homedir: () => HOME, env: {}, readdir: () => [], isFile: () => false, ...over });
}

// ─────────────────────────────────────────────────────────────────────────────
describe('dataDir — OS 별 규칙 + PIXEL_DATA_DIR (설계 표 1행)', () => {
  test('윈도우는 %LOCALAPPDATA%\\pixel-office (예전 그대로)', () => {
    assert.equal(dataDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32'), path.join('C:\\Users\\u\\AppData\\Local', 'pixel-office'));
  });

  test('윈도우에서 LOCALAPPDATA 가 없으면 홈 아래 AppData\\Local', () => {
    assert.equal(plat({ platform: 'win32', env: {} }).dataDir(), path.join(HOME, 'AppData', 'Local', 'pixel-office'));
  });

  test('맥은 ~/Library/Application Support/pixel-office — **공백이 든 경로**다', () => {
    const dir = plat({ platform: 'darwin' }).dataDir();
    assert.equal(dir, path.join(HOME, 'Library', 'Application Support', 'pixel-office'));
    assert.ok(/\s/.test(dir), '공백이 있으니 hook 명령에서 따옴표가 필요하다(hookSettings 테스트)');
  });

  test('리눅스는 $XDG_DATA_HOME, 없으면 ~/.local/share', () => {
    assert.equal(plat({ platform: 'linux', env: { XDG_DATA_HOME: '/x/share' } }).dataDir(), path.join('/x/share', 'pixel-office'));
    assert.equal(plat({ platform: 'linux' }).dataDir(), path.join(HOME, '.local', 'share', 'pixel-office'));
  });

  test('PIXEL_DATA_DIR 은 세 플랫폼 모두를 덮는다', () => {
    for (const p of ['win32', 'darwin', 'linux'] as const) {
      assert.equal(plat({ platform: p, env: { PIXEL_DATA_DIR: '/tmp/mine', LOCALAPPDATA: 'C:\\L', XDG_DATA_HOME: '/x' } }).dataDir(), '/tmp/mine');
    }
  });

  test('안내 문구용 표기는 플랫폼마다 다르다', () => {
    assert.equal(plat({ platform: 'win32' }).dataDirLabel(), '%LOCALAPPDATA%\\pixel-office');
    assert.equal(plat({ platform: 'darwin' }).dataDirLabel(), '~/Library/Application Support/pixel-office');
    assert.equal(plat({ platform: 'linux' }).dataDirLabel(), '$XDG_DATA_HOME/pixel-office');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('npmGlobalRoots — 플랫폼별 뿌리 (설계 표 2·3행)', () => {
  test('윈도우는 예전 그대로 prefix 셋(APPDATA\\npm · LOCALAPPDATA\\npm · ProgramFiles\\nodejs)', () => {
    const roots = npmGlobalRoots({ APPDATA: 'C:\\R', LOCALAPPDATA: 'C:\\L', ProgramFiles: 'C:\\PF' }, 'win32');
    assert.deepEqual(roots, [path.join('C:\\R', 'npm'), path.join('C:\\L', 'npm'), path.join('C:\\PF', 'nodejs')]);
  });

  test('윈도우의 모듈 뿌리는 prefix + node_modules (패키지 경로 계산은 이쪽만 쓴다)', () => {
    const p = plat({ platform: 'win32', env: { APPDATA: 'C:\\R', LOCALAPPDATA: 'C:\\L', ProgramFiles: 'C:\\PF' } });
    assert.deepEqual(
      p.npmModulesRoots(),
      p.npmGlobalRoots().map((r) => path.join(r, 'node_modules')),
    );
  });

  test('유닉스는 PIXEL_NPM_PREFIX 가 있으면 그 하나뿐 — `npm prefix -g` 를 띄우지 않는다', () => {
    const { spawnSync, calls } = fakeSpawn();
    const p = plat({ platform: 'darwin', env: { PIXEL_NPM_PREFIX: '/opt/my/node' }, spawnSync });
    assert.deepEqual(p.npmGlobalRoots(), [path.join('/opt/my/node', 'lib', 'node_modules')]);
    assert.deepEqual(p.npmModulesRoots(), p.npmGlobalRoots(), '유닉스 뿌리는 이미 node_modules 다');
    assert.equal(calls.length, 0, 'npm 을 부르지 않는다(비싸다)');
  });

  test('맥의 잘 알려진 뿌리들 — Homebrew 둘 · npm-global · nvm(최신 먼저) · volta', () => {
    const nvmDir = path.join(HOME, '.nvm', 'versions', 'node');
    const voltaDir = path.join(HOME, '.volta', 'tools', 'image', 'node');
    const p = plat({
      platform: 'darwin',
      readdir: (dir) => {
        if (dir === nvmDir) return ['v22.14.0', 'v24.8.0', 'v24.10.1', 'not-a-version'];
        if (dir === voltaDir) return ['24.9.0'];
        return [];
      },
    });
    const m = (x: string) => path.join(x, 'lib', 'node_modules');
    assert.deepEqual(p.npmGlobalRoots(), [
      '/opt/homebrew/lib/node_modules',
      '/usr/local/lib/node_modules',
      m(path.join(HOME, '.npm-global')),
      m(path.join(nvmDir, 'v24.10.1')),
      m(path.join(nvmDir, 'v24.8.0')),
      m(path.join(nvmDir, 'v22.14.0')),
      m(path.join(voltaDir, '24.9.0')),
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('맥에서 claude · codex 실행 파일 찾기 (설계 표 2·3행)', () => {
  let dir: string;
  let binDir: string;
  let prefix: string;

  /** 유닉스 npm 전역 모양: `<prefix>/lib/node_modules/<...>`. */
  const makeUnder = (...segments: string[]): string => {
    const file = path.join(prefix, 'lib', 'node_modules', ...segments);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/usr/bin/env node\n');
    return file;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t48-exe-'));
    binDir = path.join(dir, 'bin');
    prefix = path.join(dir, 'prefix');
    fs.mkdirSync(binDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const mac = (over: Record<string, string | undefined> = {}) =>
    createPlatform({ platform: 'darwin', homedir: () => dir, env: { PATH: binDir, PIXEL_NPM_PREFIX: prefix, ...over } });

  test('PATH 의 `#!/usr/bin/env node` 스크립트도 실행 파일이다 — 확장자 없는 이름을 찾는다', () => {
    const script = path.join(binDir, 'claude');
    fs.writeFileSync(script, '#!/usr/bin/env node\nrequire("...")\n');
    const r = mac().resolveClaudeExeDetailed();
    assert.equal(r.exe, script);
    assert.equal(r.found, true);
    assert.match(r.tried.at(-1)!, /^PATH: /);
  });

  test('PATH 에 `claude.exe` 만 있어도 맥에서는 안 센다(이름이 다르다)', () => {
    fs.writeFileSync(path.join(binDir, 'claude.exe'), 'MZ');
    assert.equal(mac().resolveClaudeExe(), 'claude');
  });

  test('npm 전역 `<prefix>/lib/node_modules/@anthropic-ai/claude-code/bin/claude`', () => {
    const exe = makeUnder('@anthropic-ai', 'claude-code', 'bin', 'claude');
    const r = mac().resolveClaudeExeDetailed();
    assert.equal(r.exe, exe);
    assert.ok(r.tried.at(-1)!.startsWith('npm 전역:'));
  });

  test('못 찾으면 `claude` 폴백 + 어디를 봤는지 — **번들 줄이 없다**(맥엔 앱 번들 탐색이 없다)', () => {
    // 윈도우라면 주워 갈 번들을 일부러 만들어 둔다.
    const bundle = path.join(dir, 'Roaming', 'Claude', 'claude-code', '2.1.270', 'claude');
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    fs.writeFileSync(bundle, '#!/bin/sh');
    const r = mac({ APPDATA: path.join(dir, 'Roaming') }).resolveClaudeExeDetailed();
    assert.equal(r.exe, 'claude');
    assert.equal(r.found, false);
    assert.equal(r.tried.length, 3, 'PIXEL_CLAUDE_EXE · PATH · npm 전역 — 번들 단계는 윈도우 전용');
    assert.match(r.tried[1]!, /셰뱅 스크립트도 실행 파일로 본다/);
    assert.ok(!r.tried.some((t) => t.includes('번들')));
  });

  test('PIXEL_CLAUDE_EXE 는 존재를 따지지 않고 그대로 쓴다', () => {
    const r = mac({ PIXEL_CLAUDE_EXE: '/opt/anywhere/claude' }).resolveClaudeExeDetailed();
    assert.deepEqual(r, { exe: '/opt/anywhere/claude', found: true, tried: ['PIXEL_CLAUDE_EXE'] });
  });

  test('codex 는 npm 전역 vendor 안의 진짜 파일(플랫폼 패키지 이름을 스캔) → 없으면 PATH → 없으면 `codex`', () => {
    assert.equal(mac().resolveCodexExe(), 'codex');

    const onPath = path.join(binDir, 'codex');
    fs.writeFileSync(onPath, '#!/bin/sh');
    assert.equal(mac().resolveCodexExe(), onPath, 'vendor 가 없으면 PATH');

    const vendor = makeUnder('@openai', 'codex', 'node_modules', '@openai', 'codex-darwin-arm64', 'vendor', 'aarch64-apple-darwin', 'bin', 'codex');
    assert.equal(mac().resolveCodexExe(), vendor, 'vendor 가 PATH 보다 먼저다');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('isProcessAlive — kill(pid,0) (설계 표 4행)', () => {
  test('신호가 통하면 살아 있다', () => {
    const { kill, sent } = fakeKill();
    assert.equal(plat({ platform: 'darwin', kill }).isProcessAlive(4242), true);
    assert.deepEqual(sent, [{ pid: 4242, signal: 0 }]);
  });

  test('EPERM 은 "내 것이 아니지만 살아 있음" (D-40 ①), ESRCH 는 죽음', () => {
    assert.equal(plat({ platform: 'darwin', kill: fakeKill({ 10: 'EPERM' }).kill }).isProcessAlive(10), true);
    assert.equal(plat({ platform: 'darwin', kill: fakeKill({ 11: 'ESRCH' }).kill }).isProcessAlive(11), false);
  });

  test('말이 안 되는 pid 는 묻지도 않는다', () => {
    const { kill, sent } = fakeKill();
    const p = plat({ platform: 'darwin', kill });
    assert.equal(p.isProcessAlive(0), false);
    assert.equal(p.isProcessAlive(-3), false);
    assert.equal(p.isProcessAlive(1.5), false);
    assert.deepEqual(sent, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('processImageName (설계 표 5행)', () => {
  test('맥은 `ps -p <pid> -o comm=` 의 basename(소문자)', () => {
    const { spawnSync, calls } = fakeSpawn({ ps: '/opt/homebrew/bin/Claude\n' });
    assert.equal(plat({ platform: 'darwin', spawnSync }).processImageName(4242), 'claude');
    assert.deepEqual(calls[0], { file: 'ps', args: ['-p', '4242', '-o', 'comm='], options: calls[0]!.options });
  });

  test('맥에서 빈 출력(죽은 pid)이면 undefined', () => {
    assert.equal(plat({ platform: 'darwin', spawnSync: fakeSpawn({ ps: '\n' }).spawnSync }).processImageName(4242), undefined);
  });

  test('윈도우는 tasklist CSV — 예전 인자·예전 파싱 그대로, pid 가 다르면 undefined', () => {
    const { spawnSync, calls } = fakeSpawn({ tasklist: '"claude.exe","14932","Console","1","265,524 K"\n' });
    const p = plat({ platform: 'win32', spawnSync });
    assert.equal(p.processImageName(14932), 'claude.exe');
    assert.deepEqual(calls[0]!.args, ['/FI', 'PID eq 14932', '/FO', 'CSV', '/NH']);
    assert.equal(calls[0]!.options.windowsHide, true);
    assert.equal(p.processImageName(999), undefined, 'pid 가 안 맞으면 남의 줄이다');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('killTree (설계 표 6행)', () => {
  test('윈도우는 taskkill /PID <pid> /T /F 한 번 (예전 그대로)', () => {
    const { spawnSync, calls } = fakeSpawn();
    const { kill, sent } = fakeKill();
    plat({ platform: 'win32', spawnSync, kill }).killTree(4242);
    assert.deepEqual(calls[0], { file: 'taskkill', args: ['/PID', '4242', '/T', '/F'], options: calls[0]!.options });
    assert.deepEqual(sent, [], '윈도우에서는 신호를 직접 보내지 않는다');
  });

  test('맥은 `ps -axo pid=,ppid=` **한 번**으로 트리를 만들어 아래부터 SIGKILL (3단 트리)', () => {
    // 100 ─ 200 ─ 300, 200 ─ 301, 그리고 무관한 900
    const psOut = ['    1     0', '  100    50', '  200   100', '  300   200', '  301   200', '  900     1'].join('\n') + '\n';
    const { spawnSync, calls } = fakeSpawn({ ps: psOut });
    const { kill, sent } = fakeKill();
    plat({ platform: 'darwin', spawnSync, kill }).killTree(100);
    assert.equal(calls.filter((c) => c.file === 'ps').length, 1, 'ps 는 한 번만(맥 ps 에는 --ppid 가 없다)');
    assert.deepEqual(calls[0]!.args, ['-axo', 'pid=,ppid=']);
    assert.deepEqual(
      sent.map((s) => s.pid),
      [301, 300, 200, 100],
      '깊은 자식부터, 뿌리는 마지막',
    );
    assert.ok(
      sent.every((s) => s.signal === 'SIGKILL'),
      '전부 SIGKILL',
    );
  });

  test('맥에서 한 pid 가 이미 죽어 있어도(ESRCH) 나머지를 계속 죽인다', () => {
    const { spawnSync } = fakeSpawn({ ps: '  200   100\n  100     1\n' });
    const { kill, sent } = fakeKill({ 200: 'ESRCH' });
    plat({ platform: 'darwin', spawnSync, kill }).killTree(100);
    assert.deepEqual(
      sent.map((s) => s.pid),
      [200, 100],
    );
  });

  test('ps 출력이 비어도 당사자는 죽인다', () => {
    const { kill, sent } = fakeKill();
    plat({ platform: 'darwin', spawnSync: fakeSpawn({ ps: '' }).spawnSync, kill }).killTree(100);
    assert.deepEqual(
      sent.map((s) => s.pid),
      [100],
    );
  });

  test('killOrder / parsePidPpid 는 순환·이상한 줄에도 죽지 않는다', () => {
    assert.deepEqual(parsePidPpid('  12   1\nheader junk\n  13   12\n'), [
      { pid: 12, ppid: 1 },
      { pid: 13, ppid: 12 },
    ]);
    assert.deepEqual(
      killOrder(
        [
          { pid: 2, ppid: 1 },
          { pid: 1, ppid: 2 },
        ],
        1,
      ),
      [2, 1],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('processStartTime (설계 표 7행)', () => {
  test('맥은 `LC_ALL=C ps -p <pid> -o lstart=` 를 쓰고 그 형식만 읽는다', () => {
    const { spawnSync, calls } = fakeSpawn({ ps: 'Mon Sep 29 10:11:12 2026\n' });
    const ms = plat({ platform: 'darwin', env: { TZ: 'X' }, spawnSync }).processStartTime(4242);
    assert.equal(ms, new Date(2026, 8, 29, 10, 11, 12).getTime());
    assert.deepEqual(calls[0]!.args, ['-p', '4242', '-o', 'lstart=']);
    assert.equal((calls[0]!.options.env as NodeJS.ProcessEnv).LC_ALL, 'C', '로캘을 못 박아야 형식이 하나다');
    assert.equal((calls[0]!.options.env as NodeJS.ProcessEnv).TZ, 'X', '나머지 환경은 그대로 물려준다');
  });

  test('lstart 파싱: 한 자리 일(day)·앞뒤 공백을 받고, 모르는 모양은 undefined', () => {
    assert.equal(parseLstart('Tue Oct  7 09:05:00 2025'), new Date(2025, 9, 7, 9, 5, 0).getTime());
    assert.equal(parseLstart('2026-09-29T10:11:12Z'), undefined, '로캘이 안 먹은 출력은 조용히 포기한다');
    assert.equal(parseLstart(''), undefined);
    assert.equal(parseLstart('Mon Xyz 29 10:11:12 2026'), undefined);
  });

  test('윈도우는 PowerShell Get-CimInstance ISO 문자열(예전 그대로)', () => {
    const { spawnSync, calls } = fakeSpawn({ 'powershell.exe': '2026-09-29T01:11:12.0000000Z\n' });
    const ms = plat({ platform: 'win32', spawnSync }).processStartTime(4242);
    assert.equal(ms, Date.parse('2026-09-29T01:11:12.000Z'));
    assert.equal(calls[0]!.file, 'powershell.exe');
    assert.match(String(calls[0]!.args.at(-1)), /Get-CimInstance Win32_Process -Filter "ProcessId=4242"/);
    assert.equal(calls[0]!.options.windowsHide, true);
  });

  test('말이 안 되는 pid 는 프로세스를 띄우지 않는다', () => {
    const { spawnSync, calls } = fakeSpawn();
    assert.equal(plat({ platform: 'darwin', spawnSync }).processStartTime(0), undefined);
    assert.equal(calls.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('안내 문구 (설계 표 8행)', () => {
  test('pid 끄기', () => {
    assert.equal(plat({ platform: 'win32' }).hintForKillingPid(4242), 'taskkill /F /PID 4242');
    assert.equal(plat({ platform: 'darwin' }).hintForKillingPid(4242), 'kill 4242');
    assert.equal(plat({ platform: 'linux' }).hintForKillingPid(4242), 'kill 4242');
  });

  test('포트 주인 찾기', () => {
    assert.equal(plat({ platform: 'win32' }).hintForFindingPortOwner(7421), 'netstat -ano | findstr :7421   →   taskkill /F /PID <pid>');
    assert.equal(plat({ platform: 'darwin' }).hintForFindingPortOwner(7421), 'lsof -i :7421   →   kill <pid>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('종료 신호 — 유닉스만 SIGHUP (설계 표 10행 · T48-1 §4)', () => {
  test('목록', () => {
    assert.deepEqual(plat({ platform: 'win32' }).shutdownSignals(), ['SIGINT', 'SIGTERM']);
    assert.deepEqual(plat({ platform: 'darwin' }).shutdownSignals(), ['SIGINT', 'SIGTERM', 'SIGHUP']);
    assert.deepEqual(plat({ platform: 'linux' }).shutdownSignals(), ['SIGINT', 'SIGTERM', 'SIGHUP']);
  });

  test('installShutdownSignals 는 플랫폼 목록대로 걸고 신호 이름을 그대로 넘긴다', () => {
    const registered: NodeJS.Signals[] = [];
    const fired: string[] = [];
    const listeners: Array<() => void> = [];
    const target = {
      on(signal: NodeJS.Signals, listener: () => void) {
        registered.push(signal);
        listeners.push(listener);
        return this;
      },
    };
    const signals = installShutdownSignals((sig) => fired.push(sig), { platform: plat({ platform: 'darwin' }), target });
    assert.deepEqual(registered, ['SIGINT', 'SIGTERM', 'SIGHUP']);
    assert.deepEqual(signals, registered);
    listeners.at(-1)!();
    assert.deepEqual(fired, ['SIGHUP'], '핸들러는 자기 신호 이름을 받는다');
  });

  test('윈도우에서는 SIGHUP 을 걸지 않는다(동작 불변)', () => {
    const registered: NodeJS.Signals[] = [];
    installShutdownSignals(() => {}, {
      platform: plat({ platform: 'win32' }),
      target: {
        on(signal: NodeJS.Signals) {
          registered.push(signal);
          return this;
        },
      },
    });
    assert.deepEqual(registered, ['SIGINT', 'SIGTERM']);
  });
});
