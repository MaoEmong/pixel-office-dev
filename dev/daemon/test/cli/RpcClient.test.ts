// RpcClient 테스트. PROTOCOL.md 대로 동작하는 작은 가짜 ws 서버를 테스트 안에서 띄운다.
// - hello(token 검증, since replay), echo(파라미터 반환), fail(에러), hang(무응답), 알림 push.
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RpcClient,
  RpcError,
  RPC_CLIENT_CLOSED,
  RPC_CLIENT_TIMEOUT,
  readDaemonInfo,
  backoffDelay,
  RECONNECT_MIN_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
} from '../../src/cli/RpcClient.js';
import type { OfficeEvent } from '../../src/store/types.js';

const TOKEN = 'secret-token';

function makeEvent(seq: number): OfficeEvent {
  return { seq, ts: new Date(seq * 1000).toISOString(), departmentId: 'd1', teamId: 't1', memberId: 'm1', kind: 'idle', detail: {}, ref: {} };
}

interface FakeDaemon {
  url: string;
  /** hello 요청에서 받은 since 값들(순서대로). undefined = 없음. */
  sinces: Array<number | undefined>;
  /** 이벤트 저장소(seq 1..N). 스냅샷 seq = 마지막. */
  events: OfficeEvent[];
  sockets: Set<WebSocket>;
  /** 모든 연결에 알림 push. */
  notify(method: string, params: unknown): void;
  close(): Promise<void>;
}

function startFakeDaemon(eventCount: number): Promise<FakeDaemon> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const d: FakeDaemon = {
    url: '',
    sinces: [],
    events: Array.from({ length: eventCount }, (_, i) => makeEvent(i + 1)),
    sockets: new Set(),
    notify(method, params) {
      const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
      for (const s of d.sockets) s.send(msg);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of d.sockets) s.terminate();
        wss.close(() => resolve());
      }),
  };
  wss.on('connection', (ws) => {
    d.sockets.add(ws);
    ws.on('close', () => d.sockets.delete(ws));
    ws.on('message', (raw) => {
      const req = JSON.parse(raw.toString()) as { id: number; method: string; params: Record<string, unknown> };
      const reply = (body: Record<string, unknown>) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }));
      switch (req.method) {
        case 'hello': {
          if (req.params.token !== TOKEN) {
            reply({ error: { code: -32001, message: 'auth failed' } });
            ws.close();
            return;
          }
          const since = typeof req.params.since === 'number' ? req.params.since : undefined;
          d.sinces.push(since);
          const seq = d.events.length ? d.events[d.events.length - 1]!.seq : 0;
          reply({
            result: { daemon: { version: '0.0.0-fake', pid: 1 }, snapshot: { seq, teams: [], members: [], pending: [], tasks: [] } },
          });
          if (since !== undefined) {
            for (const ev of d.events) if (ev.seq > since) ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: ev }));
          }
          return;
        }
        case 'echo':
          // 상관(correlation) 테스트용: 일부러 지연을 다르게 줘서 응답 순서를 섞는다.
          setTimeout(() => reply({ result: req.params }), typeof req.params.delay === 'number' ? req.params.delay : 0);
          return;
        case 'fail':
          reply({ error: { code: -32003, message: 'state error', data: { memberId: 'm1' } } });
          return;
        case 'hang':
          return;
        default:
          reply({ error: { code: -32601, message: `unknown method ${req.method}` } });
      }
    });
  });
  return new Promise((resolve) => {
    wss.on('listening', () => {
      d.url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
      resolve(d);
    });
  });
}

describe('RpcClient', () => {
  let daemon: FakeDaemon;
  before(async () => {
    daemon = await startFakeDaemon(5);
  });
  after(async () => {
    await daemon.close();
  });

  test('hello: 결과 반환, snapshot.seq → lastSeq, since 없으면 replay 없음', async () => {
    const c = new RpcClient();
    await c.connect(daemon.url);
    const events: OfficeEvent[] = [];
    c.on('event', (e) => events.push(e));
    const res = await c.hello({ token: TOKEN, client: { name: 'test', version: '0' } });
    assert.equal(res.daemon.version, '0.0.0-fake');
    assert.equal(res.snapshot.seq, 5);
    assert.equal(c.lastSeq, 5);
    assert.equal(c.synced, true);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(events, []);
    assert.equal(daemon.sinces.at(-1), undefined);
    c.close();
  });

  test('call: id 상관 — 응답 순서가 섞여도 각 호출이 제 결과를 받는다', async () => {
    const c = new RpcClient();
    await c.connect(daemon.url);
    const [a, b, d] = await Promise.all([
      c.call('echo', { n: 1, delay: 40 }),
      c.call('echo', { n: 2, delay: 0 }),
      c.call('echo', { n: 3, delay: 20 }),
    ]);
    assert.deepEqual(a, { n: 1, delay: 40 });
    assert.deepEqual(b, { n: 2, delay: 0 });
    assert.deepEqual(d, { n: 3, delay: 20 });
    c.close();
  });

  test('call: error 응답 → RpcError{code,message,data}', async () => {
    const c = new RpcClient();
    await c.connect(daemon.url);
    await assert.rejects(c.call('fail', {}), (e: unknown) => {
      assert.ok(e instanceof RpcError);
      assert.equal(e.code, -32003);
      assert.equal(e.message, 'state error');
      assert.deepEqual(e.data, { memberId: 'm1' });
      return true;
    });
    await assert.rejects(c.call('nope', {}), (e: unknown) => e instanceof RpcError && e.code === -32601);
    c.close();
  });

  test('call: 타임아웃 / 연결 종료 시 대기 중 호출 거부', async () => {
    const c = new RpcClient();
    await c.connect(daemon.url);
    await assert.rejects(c.call('hang', {}, 50), (e: unknown) => e instanceof RpcError && e.code === RPC_CLIENT_TIMEOUT);
    const p = c.call('hang', {}, 0);
    c.close();
    await assert.rejects(p, (e: unknown) => e instanceof RpcError && e.code === RPC_CLIENT_CLOSED);
    await assert.rejects(c.call('echo', {}), (e: unknown) => e instanceof RpcError && e.code === RPC_CLIENT_CLOSED);
  });

  test('hello: 토큰 불일치 → -32001 후 소켓 종료', async () => {
    const c = new RpcClient();
    await c.connect(daemon.url);
    const closed = once(c, 'close');
    await assert.rejects(c.hello({ token: 'wrong' }), (e: unknown) => e instanceof RpcError && e.code === -32001);
    await closed;
    assert.equal(c.connected, false);
    assert.equal(c.synced, false);
  });

  test('알림: notification 원본 + 타입별 이벤트, event 로 lastSeq 추적, 중복 seq 무시', async () => {
    const c = new RpcClient();
    await c.connect(daemon.url);
    await c.hello({ token: TOKEN });
    const raw: string[] = [];
    const events: number[] = [];
    const notices: string[] = [];
    const terms: string[] = [];
    const statuses: string[] = [];
    c.on('notification', (n) => raw.push(n.method));
    c.on('event', (e) => events.push(e.seq));
    c.on('daemon.notice', (n) => notices.push(n.message));
    c.on('term', (t) => terms.push(t.data));
    c.on('member.status', (s) => statuses.push(`${s.memberId}:${s.status}`));

    daemon.notify('daemon.notice', { level: 'warn', message: 'hi' });
    daemon.notify('event', makeEvent(6));
    daemon.notify('event', makeEvent(6)); // 중복
    daemon.notify('event', makeEvent(3)); // 이미 스냅샷에 반영된 과거
    daemon.notify('event', makeEvent(7));
    daemon.notify('term', { memberId: 'm1', data: '\x1b[31mred\x1b[0m' });
    daemon.notify('member.status', { memberId: 'm1', status: 'working', derived: null });
    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(raw, ['daemon.notice', 'event', 'event', 'event', 'event', 'term', 'member.status']);
    assert.deepEqual(events, [6, 7]);
    assert.equal(c.lastSeq, 7);
    assert.deepEqual(notices, ['hi']);
    assert.deepEqual(terms, ['\x1b[31mred\x1b[0m']);
    assert.deepEqual(statuses, ['m1:working']);
    c.close();
  });

  test('재접속: connectWithRetry 가 since=lastSeq 로 hello 하고 replay 중 snapshot.seq 이하만 건너뛴다', async () => {
    const d = await startFakeDaemon(5);
    try {
      const c = new RpcClient();
      const events: number[] = [];
      c.on('event', (e) => events.push(e.seq));
      const closes: number[] = [];
      c.on('close', (code) => closes.push(code));

      // 첫 접속: since 없음
      await c.connectWithRetry({ url: d.url, hello: { token: TOKEN } });
      assert.equal(c.lastSeq, 5);
      assert.deepEqual(d.sinces, [undefined]);

      // 데몬이 이벤트 6 을 보내고 연결을 끊는다. 끊긴 사이 7, 8 이 쌓인다.
      d.events.push(makeEvent(6));
      d.notify('event', makeEvent(6));
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(c.lastSeq, 6);
      for (const s of d.sockets) s.terminate();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(closes.length, 1);
      d.events.push(makeEvent(7), makeEvent(8));

      // 재접속: token/client 는 저장된 것 재사용, since=6 → 스냅샷 seq=8 → replay 7,8 은 seq<=8 이므로 건너뜀
      const res = await c.connectWithRetry({ url: d.url, intervalMs: 10, maxAttempts: 3 });
      assert.equal(res.snapshot.seq, 8);
      assert.deepEqual(d.sinces, [undefined, 6]);
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(events, [6]);
      assert.equal(c.lastSeq, 8);

      // 스냅샷보다 새 이벤트는 정상 적용
      d.notify('event', makeEvent(9));
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(events, [6, 9]);
      c.close();
    } finally {
      await d.close();
    }
  });

  test('재접속: replay 가 스냅샷보다 앞서 있어도(since < snapshot.seq 의 replay) 순서대로 적용', async () => {
    // 스냅샷 seq 가 replay 이벤트보다 작은 경우 — 데몬이 snapshot 을 만든 뒤 이벤트가 더 생긴 상황을 흉내내기 위해
    // 스냅샷을 준 뒤 lastSeq 보다 큰 event 만 통과하는지 확인한다.
    const c = new RpcClient();
    await c.connect(daemon.url);
    c.lastSeq = 2;
    const events: number[] = [];
    c.on('event', (e) => events.push(e.seq));
    await c.hello({ token: TOKEN, since: 2 }); // replay 3,4,5 — 전부 snapshot.seq(5) 이하
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(events, []);
    assert.equal(c.lastSeq, 5);
    c.close();
  });

  test('connectWithRetry: 접속 실패 시 재시도 후 포기 (T30: 대기가 1초 아래로 내려가지 않는다)', async () => {
    const c = new RpcClient();
    const attempts: number[] = [];
    const delays: Array<number | undefined> = [];
    const t0 = Date.now();
    await assert.rejects(
      c.connectWithRetry({
        url: 'ws://127.0.0.1:1',
        intervalMs: 5, // 옛 호출부 호환 — 그래도 하한 1초가 이긴다
        jitter: 0,
        maxAttempts: 2,
        onAttemptFailed: (n, _e, next) => {
          attempts.push(n);
          delays.push(next);
        },
      }),
    );
    assert.deepEqual(attempts, [1, 2]);
    assert.deepEqual(delays, [1000, undefined], '마지막 시도 뒤에는 기다리지 않는다');
    assert.ok(Date.now() - t0 >= 900, `실제로 1초를 기다려야 한다 (${Date.now() - t0}ms)`);
  });

  // T30 ②: 콘솔이 데몬 사망 시 재접속을 폭주시켜 TIME_WAIT 16,000개 → 데몬 재기동 EADDRINUSE (T38·T39 관찰).
  describe('재접속 백오프 (T30)', () => {
    test('1초에서 시작해 두 배씩, 30초에서 멈춘다', () => {
      const fixed = { jitter: 0 };
      assert.deepEqual(
        [1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => backoffDelay(n, fixed)),
        [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000],
      );
      assert.equal(RECONNECT_MIN_DELAY_MS, 1000);
      assert.equal(RECONNECT_MAX_DELAY_MS, 30000);
    });

    test('1초보다 빨리 재시도하지 않는다 — 지터가 최솟값이어도, intervalMs 를 작게 줘도', () => {
      for (let n = 1; n <= 40; n++) {
        assert.ok(backoffDelay(n, { random: () => 0 }) >= 1000, `attempt ${n}`);
        assert.ok(backoffDelay(n, { initialMs: 1, random: () => 0 }) >= 1000, `attempt ${n} (initialMs 1)`);
        assert.ok(backoffDelay(n, { initialMs: 0, jitter: 5, random: () => 0 }) >= 1000, `attempt ${n} (과한 지터)`);
      }
    });

    test('지터는 ±20% 안이고 상한을 넘지 않는다', () => {
      assert.equal(backoffDelay(2, { random: () => 0 }), 1600); // 2000 * 0.8
      assert.equal(backoffDelay(2, { random: () => 1 }), 2400); // 2000 * 1.2
      assert.equal(backoffDelay(2, { random: () => 0.5 }), 2000);
      assert.equal(backoffDelay(9, { random: () => 1 }), 30000, '상한에서는 지터로도 넘지 않는다');
    });
  });

  test('readDaemonInfo / hello 의 token 자동 읽기', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-cli-'));
    try {
      assert.equal(readDaemonInfo(dir), null);
      fs.writeFileSync(
        path.join(dir, 'daemon.json'),
        JSON.stringify({ wsPort: 7420, hookPort: 7421, token: TOKEN, pid: 42, startedAt: '2026-09-14T00:00:00Z' }),
      );
      const info = readDaemonInfo(dir);
      assert.deepEqual(info, { wsPort: 7420, hookPort: 7421, token: TOKEN, pid: 42, startedAt: '2026-09-14T00:00:00Z' });

      const c = new RpcClient(dir);
      await c.connect(daemon.url);
      const res = await c.hello(); // token 생략 → daemon.json
      assert.equal(res.snapshot.seq, 5);
      c.close();

      const c2 = new RpcClient(path.join(dir, 'nope'));
      await c2.connect(daemon.url);
      await assert.rejects(c2.hello(), /token 이 없습니다/);
      c2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
