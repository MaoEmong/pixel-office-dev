// T30 ②: 데몬은 하나만 (T38 함정 ⑤).
// 같은 데이터 폴더를 두 데몬이 열면 SQLite 마이그레이션 중 읽기가 깨지고 포트가 겹친다. 기동 때 daemon.json 의 pid 가
// **살아 있고 그 ws 포트가 듣고 있으면** 거부한다(exit 3). pid 가 죽었으면 예전처럼 덮어쓴다.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office } from '../../src/office/Office.js';
import {
  assertSingleDaemon,
  bindOrRefuse,
  DaemonAlreadyRunningError,
  DaemonPortInUseError,
  DaemonStartRefusedError,
  DAEMON_BUSY_EXIT_CODE,
  FORCE_START_ENV,
  defaultSingletonProbe,
  isAddrInUse,
  readDaemonJsonHead,
  type SingletonProbe,
} from '../../src/office/singleton.js';
import { Store } from '../../src/store/Store.js';
import { FakeMcp, FakePty, FakeReceiver } from './fakes.js';

/** 살아 있다고/듣고 있다고 대답하는 가짜 확인기. */
function probe(alive: boolean, portOpen: boolean): SingletonProbe & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isPidAlive(pid) {
      calls.push(`pid:${pid}`);
      return alive;
    },
    isPortOpen(port) {
      calls.push(`port:${port}`);
      return Promise.resolve(portOpen);
    },
  };
}

describe('T30 데몬 단일 기동 가드', () => {
  let dir: string;
  let daemonJsonPath: string;
  const write = (info: Record<string, unknown>) => fs.writeFileSync(daemonJsonPath, JSON.stringify(info));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-single-'));
    daemonJsonPath = path.join(dir, 'daemon.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('daemon.json 이 없으면 그냥 통과한다', async () => {
    await assertSingleDaemon({ daemonJsonPath, probe: probe(true, true), env: {} });
  });

  test('pid 가 살아 있고 ws 포트가 열려 있으면 거부 — 메시지에 pid 와 끄는 법', async () => {
    write({ pid: 4242, wsPort: 7420, token: 't' });
    const err = await assertSingleDaemon({ daemonJsonPath, probe: probe(true, true), env: {} }).then(
      () => null,
      (e: unknown) => e as DaemonAlreadyRunningError,
    );
    assert.ok(err instanceof DaemonAlreadyRunningError);
    assert.equal(err.pid, 4242);
    assert.equal(err.wsPort, 7420);
    assert.equal(err.exitCode, 3);
    assert.equal(DAEMON_BUSY_EXIT_CODE, 3);
    assert.match(err.message, /pid 4242/);
    assert.match(err.message, /taskkill \/F \/PID 4242/);
    assert.match(err.message, /shutdown/);
    assert.ok(err.message.includes(daemonJsonPath));
  });

  test('pid 가 죽었으면 통과한다(크래시 뒤 재기동) — 포트는 보지도 않는다', async () => {
    write({ pid: 4242, wsPort: 7420, token: 't' });
    const p = probe(false, true);
    await assertSingleDaemon({ daemonJsonPath, probe: p, env: {} });
    assert.deepEqual(p.calls, ['pid:4242'], 'pid 가 죽었으면 포트 확인은 건너뛴다');
  });

  test('pid 는 살아 있지만 ws 포트가 닫혀 있으면 통과한다(pid 재사용)', async () => {
    write({ pid: 4242, wsPort: 7420, token: 't' });
    const p = probe(true, false);
    await assertSingleDaemon({ daemonJsonPath, probe: p, env: {} });
    assert.deepEqual(p.calls, ['pid:4242', 'port:7420']);
  });

  test(`${FORCE_START_ENV}=1 이면 확인 자체를 하지 않는다`, async () => {
    write({ pid: 4242, wsPort: 7420, token: 't' });
    const p = probe(true, true);
    await assertSingleDaemon({ daemonJsonPath, probe: p, env: { [FORCE_START_ENV]: '1' } });
    assert.deepEqual(p.calls, []);
  });

  test('깨진 daemon.json / pid 0 은 통과한다', async () => {
    fs.writeFileSync(daemonJsonPath, '{ not json');
    await assertSingleDaemon({ daemonJsonPath, probe: probe(true, true), env: {} });
    assert.equal(readDaemonJsonHead(daemonJsonPath), null);
    write({ wsPort: 7420, token: 't' });
    assert.equal(readDaemonJsonHead(daemonJsonPath), null);
    await assertSingleDaemon({ daemonJsonPath, probe: probe(true, true), env: {} });
  });

  test('기본 확인기: 자기 pid 와 없는 pid 는 "살아 있음" 이 아니다', () => {
    assert.equal(defaultSingletonProbe.isPidAlive(process.pid), false, '자기 자신은 세지 않는다');
    assert.equal(defaultSingletonProbe.isPidAlive(0), false);
    assert.equal(defaultSingletonProbe.isPidAlive(-1), false);
  });

  test('Office.start() 가 거부한다 — 그리고 살아 있는 데몬의 daemon.json 을 덮어쓰지 않는다', async () => {
    const before = { pid: 4242, wsPort: 7420, hookPort: 7421, token: 'other-token' };
    write(before);
    const office = new Office({
      config: { dataDir: dir, hookPort: 0, wsPort: 0, mcpPort: 0 },
      store: new Store(':memory:'),
      pty: new FakePty(),
      receiver: new FakeReceiver(),
      mcp: new FakeMcp(),
      singletonProbe: probe(true, true),
    });
    await assert.rejects(office.start(), (e: unknown) => e instanceof DaemonAlreadyRunningError && e.pid === 4242);
    assert.deepEqual(JSON.parse(fs.readFileSync(daemonJsonPath, 'utf8')), before, 'daemon.json 은 그대로다');
    assert.equal(office.daemonInfo, undefined);
  });

  // T41: daemon.json 이 **없는데** 포트만 잡혀 있는 경우(다른 환경에서 띄운 데몬).
  test('포트가 EADDRINUSE 면 같은 문구·같은 exit 3 으로 거부한다 — 포트 번호와 찾는 법이 들어간다', async () => {
    const inUse = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:7421'), {
      code: 'EADDRINUSE',
    });
    const err = await bindOrRefuse('hook', 7421, daemonJsonPath, () => Promise.reject(inUse)).then(
      () => null,
      (e: unknown) => e as DaemonPortInUseError,
    );
    assert.ok(err instanceof DaemonPortInUseError);
    assert.ok(err instanceof DaemonStartRefusedError, '진입점은 조상 하나만 보고 exit 3 한다');
    assert.equal(err.exitCode, DAEMON_BUSY_EXIT_CODE);
    assert.equal(err.port, 7421);
    assert.equal(err.role, 'hook');
    assert.match(err.message, /^이미 데몬이 돌고 있습니다/, 'pid 거부와 같은 첫 문장');
    assert.match(err.message, /127\.0\.0\.1:7421/);
    assert.match(err.message, /netstat -ano \| findstr :7421/);
    assert.match(err.message, /PIXEL_HOOK_PORT/);
    assert.ok(err.message.includes(daemonJsonPath));
    assert.equal(err.cause, inUse);
  });

  test('EADDRINUSE 가 아닌 오류는 그대로 올린다 / isAddrInUse 는 cause 사슬도 본다', async () => {
    const other = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    await assert.rejects(
      bindOrRefuse('ws', 7420, daemonJsonPath, () => Promise.reject(other)),
      (e: unknown) => e === other,
    );
    assert.equal(isAddrInUse(other), false);
    assert.equal(isAddrInUse(new Error('wrapped', { cause: Object.assign(new Error('x'), { code: 'EADDRINUSE' }) })), true);
    assert.equal(isAddrInUse(undefined), false);

    // 성공하면 그냥 값을 돌려준다.
    assert.equal(await bindOrRefuse('mcp', 0, daemonJsonPath, async () => 45679), 45679);
  });

  test('Office.start(): daemon.json 이 없어도 hook 포트가 잡혀 있으면 거부한다(daemon.json 을 쓰지 않는다)', async () => {
    const receiver = new FakeReceiver();
    receiver.listen = () =>
      Promise.reject(Object.assign(new Error('listen EADDRINUSE 127.0.0.1:7421'), { code: 'EADDRINUSE' }));
    const office = new Office({
      config: { dataDir: dir, hookPort: 7421, wsPort: 0, mcpPort: 0 },
      store: new Store(':memory:'),
      pty: new FakePty(),
      receiver,
      mcp: new FakeMcp(),
      retentionIntervalMs: 0,
    });
    await assert.rejects(office.start(), (e: unknown) => e instanceof DaemonPortInUseError && e.port === 7421);
    assert.equal(fs.existsSync(daemonJsonPath), false, '반쯤 뜬 데몬의 daemon.json 을 남기지 않는다');
    assert.equal(office.daemonInfo, undefined);
  });

  test('Office.start() 는 죽은 pid 의 daemon.json 을 예전처럼 덮어쓴다', async () => {
    write({ pid: 4242, wsPort: 7420, token: 'stale' });
    const office = new Office({
      config: { dataDir: dir, hookPort: 0, wsPort: 0, mcpPort: 0 },
      store: new Store(':memory:'),
      pty: new FakePty(),
      receiver: new FakeReceiver(),
      mcp: new FakeMcp(),
      singletonProbe: probe(false, false),
      retentionIntervalMs: 0,
    });
    const info = await office.start();
    assert.equal(info.pid, process.pid);
    const written = JSON.parse(fs.readFileSync(daemonJsonPath, 'utf8')) as { pid: number; token: string };
    assert.equal(written.pid, process.pid);
    assert.notEqual(written.token, 'stale');
    await office.shutdown();
  });
});
