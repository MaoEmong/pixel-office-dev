// InputQueue 게이트·순서·타이밍 테스트. 시계는 now() 주입, 지연 동작은 tick() 을 직접 불러 실행한다(setInterval 없음).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { InputQueue, TIMING } from '../../src/input/InputQueue.js';
import type { BlockReason, DialogKey, InputItem } from '../../src/input/InputQueue.js';

interface Harness {
  q: InputQueue;
  /** session 호출 로그: `paste:<text>` / `write:<data>` / `key:<name>` */
  calls: string[];
  state: { idle: boolean; ready: boolean; dialog: { kind: string; suggestedKeys: DialogKey[] } };
  flushed: InputItem[];
  blocked: BlockReason[];
  dialogs: string[];
  /** dialogBlocked(kind) — 권장 키가 없어 통과할 수 없는 다이얼로그. */
  blockedDialogs: string[];
  advance(ms: number): void;
  now(): number;
}

function harness(opts: { graceMs?: number; useRealClock?: boolean } = {}): Harness {
  let t = 1_000_000;
  const calls: string[] = [];
  const state: Harness['state'] = { idle: true, ready: true, dialog: { kind: 'none', suggestedKeys: [] } };
  const q = new InputQueue({
    session: {
      paste: (s) => calls.push(`paste:${s}`),
      write: (s) => calls.push(`write:${s}`),
      sendKeys: (k) => calls.push(`key:${k}`),
    },
    screen: { promptReady: () => state.ready, detectDialog: () => state.dialog },
    isIdle: () => state.idle,
    userTypingGraceMs: opts.graceMs,
    ...(opts.useRealClock ? { pollMs: 20 } : { now: () => t }),
  });
  const flushed: InputItem[] = [];
  const blocked: BlockReason[] = [];
  const dialogs: string[] = [];
  const blockedDialogs: string[] = [];
  q.on('flushed', (i) => flushed.push(i));
  q.on('blocked', (r) => blocked.push(r));
  q.on('dialogPassed', (k) => dialogs.push(k));
  q.on('dialogBlocked', (k) => blockedDialogs.push(k));
  return { q, calls, state, flushed, blocked, dialogs, blockedDialogs, advance: (ms) => (t += ms), now: () => t };
}

const instruct = (text: string, id?: string): InputItem => ({ kind: 'instruct', text, id });

describe('flush gate', () => {
  test('flushes only when isIdle && promptReady && no recent user typing (all three)', () => {
    const h = harness();
    h.state.idle = false;
    h.q.enqueue(instruct('hello'));
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.blocked, ['not-idle']);
    assert.equal(h.q.size(), 1);

    h.state.idle = true;
    h.state.ready = false;
    h.q.tick();
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.blocked, ['not-idle', 'not-ready']);

    h.state.ready = true;
    h.q.typeRaw('x');
    h.q.tick();
    assert.deepEqual(h.calls, ['write:x']);
    assert.deepEqual(h.blocked, ['not-idle', 'not-ready', 'user-typing']);

    h.advance(3001);
    h.q.tick();
    assert.deepEqual(h.calls, ['write:x', 'paste:hello']);
    assert.equal(h.q.size(), 0);
    assert.deepEqual(h.flushed, []); // Enter 전까지는 flushed 아님

    h.advance(TIMING.enterDelayMs);
    h.q.tick();
    assert.deepEqual(h.calls, ['write:x', 'paste:hello', 'key:enter']);
    assert.deepEqual(h.flushed, [instruct('hello')]);
  });

  test('single-line text also goes through paste (uniform), and system items behave like instruct', () => {
    const h = harness();
    h.q.enqueue({ kind: 'system', text: '[TASK#7 from user]\n파일을 만들어라', id: 'task-7' });
    assert.deepEqual(h.calls, ['paste:[TASK#7 from user]\n파일을 만들어라']);
    h.advance(TIMING.enterDelayMs);
    h.q.tick();
    assert.deepEqual(h.calls.at(-1), 'key:enter');
    assert.equal(h.flushed[0].kind, 'system');
    assert.equal((h.flushed[0] as { id?: string }).id, 'task-7');
  });

  test('user typing within grace blocks with blocked(user-typing); boundary is strictly greater than grace', () => {
    const h = harness();
    h.q.typeRaw('abc');
    assert.deepEqual(h.calls, ['write:abc']); // 직접 타이핑은 게이트 없이 즉시
    h.q.enqueue(instruct('later'));
    assert.deepEqual(h.blocked, ['user-typing']);
    assert.deepEqual(h.calls, ['write:abc']);

    h.advance(3000); // now - last == grace → 아직 typing 으로 본다
    h.q.tick();
    assert.deepEqual(h.calls, ['write:abc']);

    h.advance(1);
    h.q.tick();
    assert.deepEqual(h.calls, ['write:abc', 'paste:later']);
  });

  test('typing again resets the grace window', () => {
    const h = harness({ graceMs: 1000 });
    h.q.enqueue(instruct('a'));
    // 큐가 비어(이미 paste 됨) 새 항목을 넣고 사용자가 계속 친다
    h.advance(TIMING.enterDelayMs);
    h.q.tick(); // enter
    h.advance(TIMING.busyAfterFlushMs);
    h.q.typeRaw('1');
    h.q.enqueue(instruct('b'));
    h.advance(800);
    h.q.typeRaw('2');
    h.advance(800);
    h.q.tick(); // 마지막 타이핑 후 800ms — 아직 grace 안
    assert.ok(!h.calls.includes('paste:b'));
    h.advance(201);
    h.q.tick();
    assert.ok(h.calls.includes('paste:b'));
  });

  test('blocked events are rate-limited to one per reason per 5s; the limit resets after a flush', () => {
    const h = harness();
    h.state.idle = false;
    h.q.enqueue(instruct('a'));
    for (let i = 0; i < 9; i++) {
      h.advance(500);
      h.q.tick();
    }
    assert.deepEqual(h.blocked, ['not-idle']);
    h.advance(500); // 5000ms 경과
    h.q.tick();
    assert.deepEqual(h.blocked, ['not-idle', 'not-idle']);

    // 다른 이유는 별도 계량
    h.state.idle = true;
    h.state.ready = false;
    h.q.tick();
    assert.deepEqual(h.blocked, ['not-idle', 'not-idle', 'not-ready']);

    // flush 후 같은 이유가 다시 막히면 5초를 기다리지 않고 알린다
    h.state.ready = true;
    h.q.tick(); // paste a
    h.advance(TIMING.enterDelayMs);
    h.q.tick(); // enter
    h.q.enqueue(instruct('b'));
    h.state.ready = false;
    h.advance(TIMING.busyAfterFlushMs);
    h.q.tick();
    assert.deepEqual(h.blocked, ['not-idle', 'not-idle', 'not-ready', 'not-ready']);
  });

  test('no blocked event when the queue is empty', () => {
    const h = harness();
    h.state.idle = false;
    h.q.tick();
    h.q.typeRaw('z');
    h.q.tick();
    assert.deepEqual(h.blocked, []);
  });
});

describe('dialog pass-through', () => {
  test('sends suggested keys 150ms apart, emits dialogPassed, and does not flush the queue while the dialog is up', () => {
    const h = harness();
    h.state.dialog = { kind: 'trust-folder-claude', suggestedKeys: ['down', 'enter'] };
    h.q.enqueue(instruct('hi'));
    assert.deepEqual(h.calls, ['key:down']);
    assert.deepEqual(h.dialogs, ['trust-folder-claude']);
    assert.equal(h.q.size(), 1);
    assert.equal(h.q.pendingActions(), 1);

    h.advance(TIMING.keySpacingMs - 1);
    h.q.tick();
    assert.deepEqual(h.calls, ['key:down']);
    h.advance(1);
    h.q.tick();
    assert.deepEqual(h.calls, ['key:down', 'key:enter']);
    assert.equal(h.q.pendingActions(), 0);
    assert.ok(!h.calls.some((c) => c.startsWith('paste:')));

    // 다이얼로그가 사라지면 큐가 흐른다
    h.state.dialog = { kind: 'none', suggestedKeys: [] };
    h.q.tick();
    assert.equal(h.calls.at(-1), 'paste:hi');
  });

  test('guards repeats: same dialog kind at most once per 2s, then blocked(dialog) while a queued item waits', () => {
    const h = harness();
    h.state.dialog = { kind: 'onboarding-enter', suggestedKeys: ['enter'] };
    h.q.enqueue(instruct('x'));
    assert.deepEqual(h.calls, ['key:enter']);
    for (let i = 0; i < 3; i++) {
      h.advance(500);
      h.q.tick();
    }
    assert.deepEqual(h.calls, ['key:enter']); // 1500ms 동안 재전송 없음
    assert.deepEqual(h.blocked, ['dialog']); // 큐에 항목이 있으니 이유를 알림(5초 계량)
    assert.deepEqual(h.dialogs, ['onboarding-enter']);

    h.advance(500); // 2000ms 경과 → 화면이 그대로면 한 번 더
    h.q.tick();
    assert.deepEqual(h.calls, ['key:enter', 'key:enter']);
    assert.deepEqual(h.dialogs, ['onboarding-enter', 'onboarding-enter']);

    // 다른 kind 는 즉시
    h.state.dialog = { kind: 'security-notes', suggestedKeys: ['enter'] };
    h.q.tick();
    assert.deepEqual(h.calls, ['key:enter', 'key:enter', 'key:enter']);
    assert.deepEqual(h.dialogs, ['onboarding-enter', 'onboarding-enter', 'security-notes']);
  });

  test('dialog is passed even when the queue is empty (first-run dialogs happen before any instruction)', () => {
    const h = harness();
    h.state.idle = false;
    h.state.dialog = { kind: 'trust-folder-codex', suggestedKeys: ['enter'] };
    h.q.tick();
    assert.deepEqual(h.calls, ['key:enter']);
    assert.deepEqual(h.dialogs, ['trust-folder-codex']);
    assert.deepEqual(h.blocked, []);
  });

  test('empty suggestedKeys (CLI approval prompt): no keys, no dialogPassed — blocked(dialog) + one dialogBlocked(kind) (D-26)', () => {
    const h = harness();
    h.state.dialog = { kind: 'approval-prompt', suggestedKeys: [] };
    h.q.enqueue(instruct('나중에'));
    assert.deepEqual(h.calls, [], '키도 paste 도 나가지 않는다');
    assert.deepEqual(h.dialogs, [], '"통과했다" 가 아니다');
    assert.deepEqual(h.blockedDialogs, ['approval-prompt']);
    assert.deepEqual(h.blocked, ['dialog']);
    assert.equal(h.q.size(), 1);
    assert.equal(h.q.pendingActions(), 0);

    // 2초(기존 재전송 가드)·5초(blocked 계량)를 넘겨도 dialogBlocked 는 그대로 한 번뿐이다(T23 함정 2 의 2초 스팸 방지).
    for (let i = 0; i < 24; i++) {
      h.advance(500);
      h.q.tick();
    }
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.dialogs, []);
    assert.deepEqual(h.blockedDialogs, ['approval-prompt']);
    assert.deepEqual(h.blocked, ['dialog', 'dialog', 'dialog'], 'blocked 는 이유별 5초 계량 그대로');
  });

  test('dialogBlocked repeats only after the dialog clears (or a different kind shows up)', () => {
    const h = harness();
    h.state.dialog = { kind: 'approval-prompt', suggestedKeys: [] };
    h.q.tick();
    assert.deepEqual(h.blockedDialogs, ['approval-prompt']);
    assert.deepEqual(h.blocked, [], '큐가 비어 있으면 blocked 는 내지 않는다(기존 규칙)');

    // 다른 kind 로 바뀌면 그건 새 사건이다
    h.state.dialog = { kind: 'approval-exec', suggestedKeys: [] };
    h.advance(500);
    h.q.tick();
    assert.deepEqual(h.blockedDialogs, ['approval-prompt', 'approval-exec']);

    // 사라졌다가 다시 뜨면 다시 한 번
    h.state.dialog = { kind: 'none', suggestedKeys: [] };
    h.advance(500);
    h.q.tick();
    h.state.dialog = { kind: 'approval-exec', suggestedKeys: [] };
    h.advance(500);
    h.q.tick();
    assert.deepEqual(h.blockedDialogs, ['approval-prompt', 'approval-exec', 'approval-exec']);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.dialogs, []);

    // 통과할 수 있는 다이얼로그로 바뀌면 다시 평소대로 통과한다
    h.state.dialog = { kind: 'trust-folder-claude', suggestedKeys: ['enter'] };
    h.advance(500);
    h.q.tick();
    assert.deepEqual(h.calls, ['key:enter']);
    assert.deepEqual(h.dialogs, ['trust-folder-claude']);
    assert.deepEqual(h.blockedDialogs, ['approval-prompt', 'approval-exec', 'approval-exec']);
  });

  test('a blocked dialog keeps the queue intact — it flushes as soon as the prompt returns', () => {
    const h = harness();
    h.state.dialog = { kind: 'approval-prompt', suggestedKeys: [] };
    h.q.enqueue(instruct('허가 끝나고'));
    h.advance(500);
    h.q.tick();
    assert.equal(h.q.size(), 1);
    h.state.dialog = { kind: 'none', suggestedKeys: [] };
    h.q.tick();
    assert.deepEqual(h.calls, ['paste:허가 끝나고']);
  });

  test('does not auto-pass a dialog while the user is typing (they may be answering it themselves)', () => {
    const h = harness();
    h.state.dialog = { kind: 'trust-folder-claude', suggestedKeys: ['down', 'enter'] };
    h.q.typeRaw('\x1b[B');
    h.q.tick();
    assert.deepEqual(h.calls, ['write:\x1b[B']);
    assert.deepEqual(h.dialogs, []);
    h.advance(3001);
    h.q.tick();
    assert.deepEqual(h.calls, ['write:\x1b[B', 'key:down']);
  });
});

describe('ordering and busy window', () => {
  test('FIFO order is preserved across multiple ticks', () => {
    const h = harness();
    h.state.idle = false;
    h.q.enqueue(instruct('A', '1'));
    h.q.enqueue(instruct('B', '2'));
    h.q.enqueue(instruct('C', '3'));
    assert.equal(h.q.size(), 3);
    assert.deepEqual(h.q.peek(), instruct('A', '1'));

    h.state.idle = true;
    const pastes = () => h.calls.filter((c) => c.startsWith('paste:'));
    for (let i = 0; i < 20; i++) {
      h.advance(500);
      h.q.tick();
    }
    assert.deepEqual(pastes(), ['paste:A', 'paste:B', 'paste:C']);
    assert.deepEqual(
      h.flushed.map((i) => (i as { id?: string }).id),
      ['1', '2', '3'],
    );
    // 각 항목은 paste → enter 순서로 붙어 있다
    assert.deepEqual(
      h.calls,
      ['paste:A', 'key:enter', 'paste:B', 'key:enter', 'paste:C', 'key:enter'],
    );
    assert.equal(h.q.size(), 0);
  });

  test('busy window: no second flush within 1500ms after Enter, and none between paste and Enter', () => {
    const h = harness();
    h.q.enqueue(instruct('one'));
    h.q.enqueue(instruct('two'));
    assert.deepEqual(h.calls, ['paste:one']);
    const t0 = h.now();

    // paste 와 Enter 사이: 아무리 tick 해도 두 번째 paste 없음
    h.advance(100);
    h.q.tick();
    h.advance(100);
    h.q.tick();
    assert.deepEqual(h.calls, ['paste:one']);

    h.advance(100); // t0 + 300 → Enter
    h.q.tick();
    assert.deepEqual(h.calls, ['paste:one', 'key:enter']);
    const tEnter = h.now();
    assert.equal(tEnter, t0 + TIMING.enterDelayMs);

    // Enter 후 1500ms 미만: 대기(조용히 — blocked 도 안 냄)
    h.advance(TIMING.busyAfterFlushMs - 1);
    h.q.tick();
    assert.deepEqual(h.calls, ['paste:one', 'key:enter']);
    assert.deepEqual(h.blocked, []);

    h.advance(1);
    h.q.tick();
    assert.deepEqual(h.calls, ['paste:one', 'key:enter', 'paste:two']);
  });

  test('isIdle turning false after Enter (UserPromptSubmit) keeps the next item waiting past the busy window', () => {
    const h = harness();
    h.q.enqueue(instruct('one'));
    h.q.enqueue(instruct('two'));
    h.advance(TIMING.enterDelayMs);
    h.q.tick();
    h.state.idle = false; // hook 도착
    h.advance(5000);
    h.q.tick();
    assert.deepEqual(h.calls, ['paste:one', 'key:enter']);
    assert.deepEqual(h.blocked, ['not-idle']);
  });
});

describe('keys, interrupt, clear', () => {
  test('keys items execute immediately (bypass gating), spaced 150ms', () => {
    const h = harness();
    h.state.idle = false;
    h.state.ready = false;
    h.q.typeRaw('typing');
    h.q.enqueue({ kind: 'keys', keys: ['down', 'enter'] });
    assert.deepEqual(h.calls, ['write:typing', 'key:down']);
    assert.equal(h.q.size(), 0);
    h.advance(TIMING.keySpacingMs);
    h.q.tick();
    assert.deepEqual(h.calls, ['write:typing', 'key:down', 'key:enter']);
    assert.deepEqual(h.blocked, []);
  });

  test('interrupt() sends ctrl-c and does not clear the queue', () => {
    const h = harness();
    h.state.idle = false;
    h.q.enqueue(instruct('pending'));
    h.q.interrupt();
    assert.deepEqual(h.calls, ['key:ctrl-c']);
    assert.equal(h.q.size(), 1);
    // 중단 후 화면으로 idle 판정(Stop hook 없음) → 흐름 재개
    h.state.idle = true;
    h.q.tick();
    assert.deepEqual(h.calls, ['key:ctrl-c', 'paste:pending']);
  });

  test('clear() returns and removes waiting items only; an already pasted item still gets its Enter', () => {
    const h = harness();
    h.q.enqueue(instruct('a'));
    h.q.enqueue(instruct('b'));
    h.q.enqueue(instruct('c'));
    assert.deepEqual(h.calls, ['paste:a']);
    assert.deepEqual(h.q.clear(), [instruct('b'), instruct('c')]);
    assert.equal(h.q.size(), 0);
    assert.equal(h.q.peek(), undefined);
    h.advance(TIMING.enterDelayMs);
    h.q.tick();
    assert.deepEqual(h.calls, ['paste:a', 'key:enter']);
    assert.deepEqual(h.flushed, [instruct('a')]);
  });
});

describe('poll loop (real timers)', () => {
  test('start() drives paste → Enter → next item without manual ticks; stop() halts', async () => {
    const h = harness({ useRealClock: true });
    const flushedTwo = new Promise<void>((resolve) => h.q.on('flushed', () => h.flushed.length === 2 && resolve()));
    h.q.enqueue(instruct('r1'));
    h.q.enqueue(instruct('r2'));
    assert.deepEqual(h.calls, ['paste:r1']); // enqueue 는 즉시 평가
    h.q.start();
    const started = Date.now();
    await Promise.race([flushedTwo, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
    const elapsed = Date.now() - started;
    h.q.stop();
    assert.deepEqual(h.calls, ['paste:r1', 'key:enter', 'paste:r2', 'key:enter']);
    // Enter(300) + busy(1500) + Enter(300) ≈ 2.1s 이상 걸려야 한다(busy 창이 실제로 작동)
    assert.ok(elapsed >= TIMING.enterDelayMs + TIMING.busyAfterFlushMs + TIMING.enterDelayMs - 50, `elapsed ${elapsed}ms`);
    assert.equal(h.q.pendingActions(), 0);

    // stop 이후엔 새 항목이 있어도 시계가 흐르지 않는다(enqueue 의 즉시 평가는 busy 창에 걸려 조용히 대기)
    h.q.enqueue(instruct('r3'));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(h.calls.length, 4);
  });
});
