// 통합 테스트(opt-in): 실제 claude.exe 를 스폰해 입력 프롬프트까지 도달한 뒤 종료한다.
// 실행: PIXEL_IT=1 npx tsx --test test/pty/*.test.ts   (bash)
// hook 수신기는 안 떠 있으므로 hook 은 실패한다("hook error" 표시) — 무해, 예상된 동작.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @xterm/headless 는 번들된 CJS 라 Node ESM 이 named export 를 못 찾는다 → default import 후 꺼낸다.
import xterm from '@xterm/headless';
import { PtyManager } from '../../src/pty/PtyManager.js';

const { Terminal } = xterm;

const IT = process.env.PIXEL_IT === '1';
const SANDBOX = path.resolve(import.meta.dirname, '..', '..', '..', 'spike-0', 'sandbox');
const COLS = 120;
const ROWS = 40;

// 실측 ①: 준비된 입력 프롬프트 하단 문구. 패턴 표는 T02 에서 tui-maps 로 옮긴다.
const READY_RE = /\? for shortcuts|shift\+tab to cycle/i;
const TRUST_RE = /trust this folder/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('spawns real claude, reaches the input prompt, then exits cleanly', { skip: IT ? false : 'set PIXEL_IT=1 to run', timeout: 120_000 }, async () => {
  assert.ok(fs.existsSync(SANDBOX), `sandbox missing: ${SANDBOX}`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-it-'));

  // headless xterm 으로 화면을 재구성해야 문구 검사가 안정적이다 (raw 는 ANSI 로 쪼개짐).
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const screen = (): string => {
    const lines: string[] = [];
    const buf = term.buffer.active;
    for (let i = 0; i < ROWS; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join('\n');
  };

  const mgr = new PtyManager({ dataDir, cols: COLS, rows: ROWS });
  let raw = 0;
  const exits: Array<{ id: string; exitCode: number; signal?: number }> = [];
  mgr.on('data', (_id, chunk) => {
    raw += chunk.length;
    term.write(chunk);
  });
  mgr.on('exit', (id, info) => exits.push({ id, ...info }));

  const t0 = Date.now();
  const session = mgr.spawn({
    memberId: 'it-claude',
    memberToken: 'it-token',
    engine: 'claude',
    cwd: SANDBOX,
    hookScriptPath: path.join(dataDir, 'no-such-hook.js'), // 수신기 없음 → hook 실패는 무해
    hookPort: 7421,
  });
  console.log(`[IT] spawned pid=${session.pid} engine=${session.engine} cwd=${SANDBOX}`);
  assert.ok(session.pid > 0);
  assert.equal(session.alive, true);
  assert.equal(mgr.get('it-claude'), session);
  assert.equal(mgr.list().length, 1);

  // 세션 설정 파일이 실제로 쓰였는지
  const settingsFile = path.join(dataDir, 'sessions', 'it-claude', 'claude-settings.json');
  assert.ok(fs.existsSync(settingsFile), 'session settings file written');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.ok('SessionStart' in settings.hooks && 'Stop' in settings.hooks);

  // 준비 문구까지 대기 (최대 60초). 신뢰 다이얼로그가 보이면 ↓+Enter.
  let ready = false;
  let trustPassed = 0;
  for (let k = 0; k < 60 && session.alive; k++) {
    await sleep(1000);
    const sc = screen();
    if (READY_RE.test(sc)) {
      ready = true;
      break;
    }
    if (TRUST_RE.test(sc)) {
      trustPassed++;
      console.log(`[IT] trust dialog at t+${k + 1}s → down+enter`);
      session.sendKeys('down');
      await sleep(300);
      session.sendKeys('enter');
      await sleep(1500);
    }
  }
  const elapsed = Date.now() - t0;
  const tail = screen().split('\n').slice(-6).join('\n');
  console.log(`[IT] ready=${ready} after ${elapsed}ms raw=${raw} bytes trustDialogs=${trustPassed}\n--- screen tail ---\n${tail}\n--- end ---`);
  assert.ok(ready, `prompt not ready within 60s; screen:\n${screen()}`);

  // 리사이즈가 예외 없이 먹는지 (재그리기 확인은 T02)
  session.resize(100, 30);
  await sleep(500);
  session.resize(COLS, ROWS);

  // 정중한 종료(/exit) → exit 이벤트
  await mgr.kill('it-claude', { graceful: true, timeoutMs: 8000 });
  console.log(`[IT] kill done alive=${session.alive} exits=${JSON.stringify(exits)}`);
  assert.equal(session.alive, false);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].id, 'it-claude');
  assert.equal(mgr.get('it-claude'), undefined);
  assert.equal(mgr.list().length, 0);
  assert.throws(() => session.write('x'), /not alive/);

  term.dispose();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
