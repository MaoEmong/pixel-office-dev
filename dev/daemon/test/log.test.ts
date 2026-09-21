// 데몬 로그 목적지 (T46-3 실기 결함 ③ — `src/log.ts` 머리말에 까닭이 전부 있다).
//
// 앱이 데몬을 **파이프 모드**로 띄우므로 데몬 stdout 을 읽는 사람은 앱 하나뿐이고, 그 앱이 죽으면
// 그 뒤의 `console.log` 한 줄이 **데몬의 이벤트 루프를 멈춘다**(윈도우). 그래서 앱이 띄운 데몬은
// stdout 을 안 쓰고 로그 파일에 직접 쓴다. 아래 마지막 테스트가 그 성질을 진짜 자식 프로세스로 본다.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DAEMON_LOG_ENV, fileSink, formatLogLine, installFileLog } from '../src/log.js';

describe('데몬 로그 목적지 (T46-3)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-log-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('formatLogLine 은 console 처럼 여러 인자를 합치고 객체를 펼친다', () => {
    assert.equal(formatLogLine(['[office]', '종료:', 3]), '[office] 종료: 3');
    assert.match(formatLogLine(['x', { a: 1 }]), /x \{ a: 1 \}/);
  });

  test('fileSink 는 줄 단위로 이어 쓰고, 못 쓰게 되면 조용히 포기한다', () => {
    const p = path.join(dir, 'daemon.log');
    const sink = fileSink(p);
    sink(['첫 줄']);
    sink(['둘째', 2]);
    assert.equal(fs.readFileSync(p, 'utf8'), '첫 줄\n둘째 2\n');

    // 폴더가 아닌 곳으로 향한 sink — 던지지 않는다(로그 때문에 데몬이 멈추면 안 된다).
    const bad = fileSink(path.join(p, 'nope', 'x.log'));
    bad(['아무거나']);
  });

  test('installFileLog: 경로가 있으면 console.* 가 파일로 가고 stdout 은 건드리지 않는다', () => {
    const p = path.join(dir, 'daemon.log');
    const calls: string[] = [];
    const fake = { log: () => calls.push('log'), warn: () => calls.push('warn'), error: () => calls.push('error'), info: () => {}, debug: () => {} } as unknown as Console;
    assert.equal(installFileLog(p, fake), true);
    fake.log('[daemon] listening');
    fake.warn('[office] 경고', 1);
    fake.error('[daemon] bye');
    assert.deepEqual(fs.readFileSync(p, 'utf8').split('\n').filter(Boolean), [
      '[daemon] listening',
      '[office] 경고 1',
      '[daemon] bye',
    ]);
    assert.deepEqual(calls, [], '원래 console 로는 한 줄도 안 갔다 = stdout 에 안 썼다');
  });

  test('installFileLog: 경로가 없으면 아무것도 바꾸지 않는다(콘솔 실행)', () => {
    const calls: string[] = [];
    const fake = { log: () => calls.push('log'), warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } as unknown as Console;
    assert.equal(installFileLog(undefined, fake), false);
    assert.equal(installFileLog('   ', fake), false);
    fake.log('x');
    assert.deepEqual(calls, ['log'], 'stdout 그대로');
  });

  // 실기 결함 재현. `PIXEL_DAEMON_LOG` 가 없던 시절에는 이 자식이 **파이프를 읽던 쪽이 사라진 순간
  // 멈춰서** 영영 끝나지 않았다(실기에서 데몬이 그렇게 굳어 claude.exe 가 남았다).
  test('읽는 쪽이 사라진 파이프에 써도 데몬은 멈추지 않는다 (win32 실측 재현)', { skip: process.platform !== 'win32' }, async () => {
    const logPath = path.join(dir, 'daemon.log');
    const progress = path.join(dir, 'progress.txt');
    const script = path.join(dir, 'child.mjs');
    const logModule = pathToFileURL(path.resolve(import.meta.dirname, '../src/log.ts')).href;
    fs.writeFileSync(
      script,
      `import fs from 'node:fs';
       import { installFileLog } from ${JSON.stringify(logModule)};
       installFileLog();
       let n = 0;
       const timer = setInterval(() => {
         n++;
         console.log('[daemon] tick ' + n + ' ' + 'x'.repeat(4000));   // 파이프였다면 여기서 굳는다
         fs.writeFileSync(${JSON.stringify(progress)}, String(n));
         if (n >= 40) { clearInterval(timer); process.exit(0); }
       }, 50);`,
      'utf8',
    );
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, [DAEMON_LOG_ENV]: logPath },
    });
    let err = '';
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    const exited = new Promise<number>((r) => child.on('exit', (code) => r(code ?? -1)));
    // 자식이 몇 번 돌 때까지 기다렸다가 **읽는 쪽을 없앤다**(앱이 죽은 것과 같다).
    const read = (f: string) => { try { return Number(fs.readFileSync(f, 'utf8')); } catch { return 0; } };
    const until = async (want: number, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (read(progress) >= want) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };
    // 스위트 전체와 같이 돌 때 `node --import tsx` 기동이 느릴 수 있어 넉넉하게 기다린다.
    assert.equal(await until(2, 45_000), true, `자식이 돌기 시작해야 한다 — stderr: ${err}`);
    child.stdout.destroy();
    child.stderr.destroy();
    const before = read(progress);
    assert.equal(await until(before + 10, 30_000), true, '파이프가 끊긴 뒤에도 이벤트 루프가 계속 돈다');
    assert.equal(await exited, 0, '스스로 끝까지 가서 종료한다');
    assert.match(fs.readFileSync(logPath, 'utf8'), /\[daemon\] tick 40 /, '끊긴 뒤의 줄도 로그 파일에 남는다');
  });
});
