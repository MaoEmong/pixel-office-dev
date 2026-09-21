// T46-1 §3 — 부모 앱 감시. 진짜 프로세스도 진짜 시계도 쓰지 않는다: 가짜 프로세스 표 + 손으로 돌리는 타이머.
//   ① 살아 있으면 아무 일도 없다 → 사라지면 onGone 이 **한 번만**
//   ② pid 가 살아 있어도 시작 시각이 다르면(pid 재사용) 사라진 것으로 본다
//   ③ 시작 시각을 못 읽으면 pid 만 본다(감시를 끄지 않는다)
//   ④ retarget 은 새 pid 의 시작 시각을 다시 읽는다(hello{parentPid})
//   ⑤ 대상이 없으면 타이머 자체를 걸지 않는다
// 그리고 Office 배선: 부모가 사라지면 `daemon.notice{kind:'parent-gone'}` + shutdown.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ParentWatch, PARENT_WATCH_INTERVAL_MS, type ProcessProbe, type WatchTimer } from '../../src/office/parentWatch.js';
import { Office } from '../../src/office/Office.js';
import { Store } from '../../src/store/Store.js';
import type { NoticeExtra } from '../../src/office/types.js';
import type { OrphanOps } from '../../src/office/orphans.js';
import { FakePty, FakeReceiver } from './fakes.js';

/** 손으로 돌리는 타이머: 등록된 콜백을 `fire()` 로 부른다. */
function fakeTimer(): WatchTimer & { fire(): void; intervals: number[]; cleared: number } {
  const fns: Array<() => void> = [];
  const state = {
    intervals: [] as number[],
    cleared: 0,
    setInterval(fn: () => void, ms: number) {
      state.intervals.push(ms);
      fns.push(fn);
      return { unref() {} } as unknown as NodeJS.Timeout;
    },
    clearInterval() {
      state.cleared += 1;
      fns.length = 0;
    },
    fire() {
      for (const fn of [...fns]) fn();
    },
  };
  return state;
}

/** 가짜 프로세스 표. `alive` 와 `startedAt` 을 테스트가 손으로 바꾼다. */
function fakeProbe(table: Map<number, number | undefined>): ProcessProbe & { calls: { alive: number; startedAt: number } } {
  const calls = { alive: 0, startedAt: 0 };
  return {
    calls,
    alive(pid) {
      calls.alive += 1;
      return table.has(pid);
    },
    startedAt(pid) {
      calls.startedAt += 1;
      return table.get(pid);
    },
  };
}

describe('ParentWatch — 부모 앱 감시 (T46-1 §3)', () => {
  test('살아 있으면 조용하고, 사라지면 onGone 이 한 번만 불린다', () => {
    const table = new Map<number, number | undefined>([[111, 1000]]);
    const probe = fakeProbe(table);
    const timer = fakeTimer();
    const gone: Array<{ pid: number; reason: string }> = [];
    const w = new ParentWatch({ parentPid: 111, probe, timer, onGone: (i) => gone.push(i) });
    w.start();
    assert.deepEqual(timer.intervals, [PARENT_WATCH_INTERVAL_MS], '기본 2초');
    timer.fire();
    timer.fire();
    assert.deepEqual(gone, [], '살아 있는 동안은 아무 일도 없다');

    table.delete(111);
    timer.fire();
    assert.deepEqual(gone, [{ pid: 111, reason: 'exited' }]);
    timer.fire(); // 타이머가 멈추지 않았더라도
    assert.equal(gone.length, 1, '두 번 쏘지 않는다');
    assert.equal(w.watching, false, '쏜 뒤에는 스스로 멈춘다');
  });

  test('pid 재사용: 같은 번호가 살아 있어도 시작 시각이 다르면 "사라진 것"', () => {
    const table = new Map<number, number | undefined>([[222, 1000]]);
    const probe = fakeProbe(table);
    const timer = fakeTimer();
    const gone: Array<{ pid: number; reason: string }> = [];
    const w = new ParentWatch({ parentPid: 222, probe, timer, onGone: (i) => gone.push(i) });
    w.start();
    assert.equal(w.parentStartedAt, 1000, '기동 때 한 번 읽어 둔다');
    const afterTarget = probe.calls.startedAt;
    timer.fire();
    assert.deepEqual(gone, []);

    table.set(222, 2000); // 같은 번호, 다른 프로세스
    timer.fire();
    assert.deepEqual(gone, [{ pid: 222, reason: 'pid-reused' }]);
    assert.ok(probe.calls.startedAt > afterTarget, '폴링에서도 시작 시각을 보긴 한다(값을 읽어 둔 경우에만)');
  });

  test('시작 시각을 못 읽으면 pid 만 본다 — 감시를 끄지는 않는다', () => {
    const table = new Map<number, number | undefined>([[333, undefined]]);
    const probe = fakeProbe(table);
    const timer = fakeTimer();
    const gone: Array<{ pid: number; reason: string }> = [];
    const w = new ParentWatch({ parentPid: 333, probe, timer, onGone: (i) => gone.push(i) });
    w.start();
    assert.equal(w.parentStartedAt, undefined);
    const before = probe.calls.startedAt;
    timer.fire();
    timer.fire();
    assert.equal(probe.calls.startedAt, before, '비싼 조회를 폴링에서 다시 부르지 않는다');
    assert.deepEqual(gone, []);
    table.delete(333);
    timer.fire();
    assert.deepEqual(gone, [{ pid: 333, reason: 'exited' }]);
  });

  test('retarget(hello{parentPid}): 새 pid 의 시작 시각을 다시 읽고 그쪽을 본다', () => {
    const table = new Map<number, number | undefined>([
      [444, 1000],
      [555, 5000],
    ]);
    const probe = fakeProbe(table);
    const timer = fakeTimer();
    const gone: Array<{ pid: number; reason: string }> = [];
    const w = new ParentWatch({ parentPid: 444, probe, timer, onGone: (i) => gone.push(i) });
    w.start();
    w.retarget(555);
    assert.equal(w.parentPid, 555);
    assert.equal(w.parentStartedAt, 5000);
    assert.equal(w.watching, true, '돌던 감시는 새 대상으로 이어진다');

    table.delete(444); // 옛 부모가 죽어도
    timer.fire();
    assert.deepEqual(gone, [], '이제 보는 것은 555 다');
    table.delete(555);
    timer.fire();
    assert.deepEqual(gone, [{ pid: 555, reason: 'exited' }]);
  });

  test('대상이 없으면(콘솔 데몬·PIXEL_KEEP_DAEMON=1) 타이머 자체를 걸지 않는다', () => {
    const timer = fakeTimer();
    const w = new ParentWatch({ probe: fakeProbe(new Map()), timer, onGone: () => assert.fail('불리면 안 된다') });
    w.start();
    assert.deepEqual(timer.intervals, []);
    assert.equal(w.watching, false);
    assert.equal(w.parentPid, undefined);
  });

  test('확인이 던져도 살아 있는 부모를 죽었다고 보지 않는다', () => {
    const timer = fakeTimer();
    const gone: unknown[] = [];
    const probe: ProcessProbe = {
      alive() {
        throw new Error('권한 없음');
      },
      startedAt: () => undefined,
    };
    const w = new ParentWatch({ parentPid: 666, probe, timer, onGone: (i) => gone.push(i) });
    w.start();
    timer.fire();
    assert.deepEqual(gone, []);
  });
});

describe('Office 배선 — 부모가 사라지면 정리하고 끝난다 (T46-1 §3)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let office: Office | undefined;
  const noOrphans: OrphanOps = { alive: () => false, name: () => undefined, kill: () => {} };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t46pw-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
  });
  afterEach(async () => {
    await office?.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const mk = (opts: { parentPid?: number; keepDaemon?: boolean; timer: WatchTimer; probe: ProcessProbe }) =>
    new Office({
      config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0, parentPid: opts.parentPid, keepDaemon: opts.keepDaemon === true },
      store,
      pty,
      receiver,
      version: 't46',
      recovery: { orphanOps: noOrphans },
      parentWatch: { timer: opts.timer, probe: opts.probe },
    });

  test('부모가 사라지면 `부모 앱이 사라졌다` + notice{kind:parent-gone} + shutdown 한 번', async () => {
    const table = new Map<number, number | undefined>([[777, 1000]]);
    const timer = fakeTimer();
    office = mk({ parentPid: 777, timer, probe: fakeProbe(table) });
    const notices: Array<{ level: string; message: string; extra?: NoticeExtra }> = [];
    office.on('notice', (level, message, extra) => notices.push({ level, message, extra }));
    let shut = 0;
    office.on('shutdown', () => shut++);
    await office.start();
    assert.equal(office.watchedParentPid, 777);

    table.delete(777);
    timer.fire();
    await new Promise((r) => setTimeout(r, 50));

    const gone = notices.find((n) => n.extra?.kind === 'parent-gone');
    assert.ok(gone, `parent-gone notice: ${JSON.stringify(notices)}`);
    assert.equal(gone.level, 'warn');
    assert.ok(gone.message.startsWith('부모 앱이 사라졌다'), gone.message);
    assert.equal(shut, 1);
    assert.equal(fs.existsSync(path.join(dataDir, 'daemon.json')), false, '`daemon.shutdown` 과 같은 정리를 한다');
  });

  test('PIXEL_KEEP_DAEMON=1 이면 부모 pid 가 있어도 감시하지 않는다', async () => {
    const timer = fakeTimer();
    office = mk({ parentPid: 888, keepDaemon: true, timer, probe: fakeProbe(new Map()) });
    await office.start();
    assert.equal(office.watchedParentPid, undefined);
    assert.deepEqual(timer.intervals, []);
    // hello{parentPid} 도 무시한다 — "앱을 닫아도 계속 일하기" 가 켜진 상태다.
    office.watchParent(999);
    assert.equal(office.watchedParentPid, undefined);
  });

  test('부모 pid 가 없으면 감시하지 않다가 hello{parentPid} 로 켜진다', async () => {
    const table = new Map<number, number | undefined>([[1234, 7000]]);
    const timer = fakeTimer();
    office = mk({ timer, probe: fakeProbe(table) });
    let shut = 0;
    office.on('shutdown', () => shut++);
    await office.start();
    assert.equal(office.watchedParentPid, undefined, '콘솔에서 띄운 데몬은 주인이 없다');

    office.watchParent(1234); // 앱이 붙었다
    assert.equal(office.watchedParentPid, 1234);
    timer.fire();
    assert.equal(shut, 0);
    table.delete(1234);
    timer.fire();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(shut, 1);
  });
});
