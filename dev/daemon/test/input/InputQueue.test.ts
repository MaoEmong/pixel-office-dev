// InputQueue 게이트·순서·타이밍 테스트. 시계는 now() 주입, 지연 동작은 tick() 을 직접 불러 실행한다(setInterval 없음).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { InputQueue, SUBMIT_RETRY_MAX, TIMING } from '../../src/input/InputQueue.js';
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
    h.state.idle = false; // UserPromptSubmit — 제출 확정. 여기서 임계 구간이 닫힌다(T44)
    h.q.tick();
    h.state.idle = true; // 턴 종료
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
    // 각 항목은 paste → enter 순서로 붙어 있다.
    // (뒤에 붙는 여분 'key:enter' 는 제출 확인 재시도다 — 이 가짜 세션은 Enter 를 받아도 idle 을 안 풀기 때문.
    //  실제 CLI 는 UserPromptSubmit 으로 idle 이 풀려 재시도가 멈춘다. 아래 'submit 확인' 절 참고.)
    assert.deepEqual(
      h.calls.slice(0, 6),
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

// T42 실기: Codex `resume` 직후 화면은 prompt ready 인데 Enter 가 먹지 않아 `[RESUMED]` 지시가 입력 상자에 남고
// 그 멤버의 큐가 영구히 막혔다(여러 줄 텍스트가 상자를 채워 promptReady 까지 false 가 된다). 판정은 화면이 아니라
// "프롬프트가 들어갔을 때만 생기는 사실" = isIdle 이 풀리는 것으로 한다.
describe('submit 확인 — Enter 가 안 먹으면 다시 보낸다 (T42)', () => {
  const retryHarness = () => {
    const h = harness();
    const retried: number[] = [];
    const lost: string[] = [];
    h.q.on('submitRetried', (_i, n) => retried.push(n));
    h.q.on('submitLost', (i) => lost.push((i as { text: string }).text));
    return { h, retried, lost };
  };

  test('정상: Enter 뒤 isIdle 이 풀리면(UserPromptSubmit) 재시도하지 않는다', () => {
    const { h, retried } = retryHarness();
    h.q.enqueue(instruct('hello'));
    h.advance(TIMING.enterDelayMs + 1);
    h.q.tick();
    assert.deepEqual(h.calls, ['paste:hello', 'key:enter']);

    h.state.idle = false; // CLI 가 프롬프트를 받았다
    for (let i = 0; i < 10; i++) {
      h.advance(1000);
      h.q.tick();
    }
    assert.deepEqual(h.calls, ['paste:hello', 'key:enter']);
    assert.deepEqual(retried, []);
  });

  test('Enter 가 안 먹으면 submitCheckMs 마다 다시 보내고, 들어가면 멈춘다', () => {
    const { h, retried } = retryHarness();
    h.q.enqueue(instruct('[RESUMED] …'));
    h.advance(TIMING.enterDelayMs + 1);
    h.q.tick();
    assert.equal(h.calls.filter((c) => c === 'key:enter').length, 1);

    // 계속 idle = 안 들어갔다
    h.advance(TIMING.submitCheckMs);
    h.q.tick();
    assert.deepEqual(retried, [1]);
    assert.equal(h.calls.filter((c) => c === 'key:enter').length, 2);

    // 확인 창이 지나기 전에는 또 보내지 않는다
    h.advance(TIMING.submitCheckMs - 1);
    h.q.tick();
    assert.deepEqual(retried, [1]);

    // 두 번째 재시도가 먹었다
    h.advance(1);
    h.q.tick();
    assert.deepEqual(retried, [1, 2]);
    h.state.idle = false;
    h.advance(TIMING.submitCheckMs * 5);
    h.q.tick();
    assert.deepEqual(retried, [1, 2]);
    assert.equal(h.calls.filter((c) => c === 'key:enter').length, 3);
  });

  test('재시도 상한을 넘으면 submitLost 를 내고 포기한다', () => {
    const { h, retried, lost } = retryHarness();
    h.q.enqueue(instruct('stuck'));
    h.advance(TIMING.enterDelayMs + 1);
    h.q.tick();
    for (let i = 0; i < 10; i++) {
      h.advance(TIMING.submitCheckMs);
      h.q.tick();
    }
    assert.deepEqual(retried, [1, 2, 3, 4]);
    assert.deepEqual(lost, ['stuck']);
    // 포기한 뒤에는 더 안 보낸다
    const enters = h.calls.filter((c) => c === 'key:enter').length;
    h.advance(TIMING.submitCheckMs * 5);
    h.q.tick();
    assert.equal(h.calls.filter((c) => c === 'key:enter').length, enters);
  });

  test('다이얼로그가 뜨면 재시도하지 않고, 모아 둔 사용자 키를 돌려준다', () => {
    const { h, retried } = retryHarness();
    h.q.enqueue(instruct('a'));
    h.advance(TIMING.enterDelayMs + 1);
    h.q.tick();
    h.q.typeRaw('z'); // 임계 구간이라 모아 둔다
    h.state.dialog = { kind: 'trust-folder-codex', suggestedKeys: ['enter'] };
    h.advance(TIMING.submitCheckMs);
    h.q.tick();
    assert.deepEqual(retried, []);
    // 화면을 다이얼로그가 쥐었으니 확인을 접고, 붙잡아 둔 키는 그대로 흘려보낸다(삼켜서는 안 된다).
    assert.equal(h.q.heldUserInput(), 0);
    assert.ok(h.calls.includes('write:z'), h.calls.join(' '));
  });

  test('사용자 키는 임계 구간에 모아 두므로 재시도 확인이 접히지 않는다(T44 — 씹힌 Enter 를 계속 확인한다)', () => {
    const { h, retried } = retryHarness();
    h.q.enqueue(instruct('b'));
    h.advance(TIMING.enterDelayMs + 1);
    h.q.tick();
    h.q.typeRaw('x'); // pty 로 가지 않는다 → 제출 확인은 그대로 살아 있다
    assert.equal(h.q.heldUserInput(), 1);
    h.advance(TIMING.submitCheckMs);
    h.q.tick();
    assert.deepEqual(retried, [1]);
    assert.deepEqual(h.calls, ['paste:b', 'key:enter', 'key:enter']);
  });
});

// T44: 붙여넣기와 Enter 사이(또는 Enter 재시도 사이)에 사용자 키가 하나만 끼어도 지시가 깨진다 —
// T42 실기 함정 2 에서는 `/status` 오버레이 중에 보낸 Esc 가 입력 상자를 비워 Enter 가 빈 상자에 떨어졌고
// 지시 하나가 통째로 증발했다(task 는 assigned 인 채). paste ~ 제출 확정을 임계 구간으로 묶어 막는다.
describe('붙여넣기 ↔ Enter 임계 구간 (T44)', () => {
  const critHarness = () => {
    const h = harness();
    const lost: string[] = [];
    h.q.on('submitLost', (i) => lost.push((i as { text: string }).text));
    return { h, lost };
  };

  test('paste 와 Enter 사이의 키는 pty 로 안 가고, 제출이 확정된 뒤에 순서대로 재생된다', () => {
    const { h } = critHarness();
    h.q.enqueue(instruct('지시문'));
    assert.deepEqual(h.calls, ['paste:지시문']);

    h.q.typeRaw('\x1b'); // Esc — 그대로 갔으면 입력 상자가 비어 지시가 증발한다
    h.q.typeRaw('ab');
    assert.equal(h.q.heldUserInput(), 2);
    assert.deepEqual(h.calls, ['paste:지시문']);

    h.advance(TIMING.enterDelayMs);
    h.q.tick();
    assert.deepEqual(h.calls, ['paste:지시문', 'key:enter']);
    assert.equal(h.q.heldUserInput(), 2); // Enter 를 보냈어도 확정 전까지는 계속 붙잡는다

    h.state.idle = false; // UserPromptSubmit — 프롬프트가 들어갔다
    h.q.tick();
    assert.deepEqual(h.calls, ['paste:지시문', 'key:enter', 'write:\x1b', 'write:ab']);
    assert.equal(h.q.heldUserInput(), 0);
  });

  test('재생된 키가 grace 를 다시 건다 — 다음 지시는 사용자가 멈춘 뒤에 나간다', () => {
    const { h } = critHarness();
    h.q.enqueue(instruct('one'));
    h.q.enqueue(instruct('two'));
    h.q.typeRaw('x');
    h.advance(TIMING.enterDelayMs);
    h.q.tick(); // Enter
    h.state.idle = false;
    h.q.tick(); // 확정 → 재생
    assert.deepEqual(h.calls, ['paste:one', 'key:enter', 'write:x']);

    h.state.idle = true;
    h.advance(TIMING.busyAfterFlushMs + 1);
    h.q.tick();
    assert.deepEqual(h.blocked, ['user-typing']); // 재생 직후 3초는 사용자 차례
    assert.equal(h.q.size(), 1);

    h.advance(3001);
    h.q.tick();
    assert.deepEqual(h.calls, ['paste:one', 'key:enter', 'write:x', 'paste:two']);
  });

  test('Enter 재시도 중에 친 키도 모아 뒀다가 포기(submitLost) 시점에 순서대로 돌려준다', () => {
    const { h, lost } = critHarness();
    h.q.enqueue(instruct('stuck'));
    h.advance(TIMING.enterDelayMs + 1);
    h.q.tick();
    h.q.typeRaw('1');
    for (let i = 0; i < SUBMIT_RETRY_MAX; i++) {
      h.advance(TIMING.submitCheckMs);
      h.q.tick();
      h.q.typeRaw(String(i + 2)); // 재시도 창마다 한 번씩 더 친다
    }
    assert.equal(h.q.heldUserInput(), 5);
    assert.deepEqual(lost, []);

    h.advance(TIMING.submitCheckMs);
    h.q.tick();
    assert.deepEqual(lost, ['stuck']);
    assert.equal(h.q.heldUserInput(), 0);
    // Enter 5번(최초 + 재시도 4) 이 **먼저**, 그 다음 사용자 키 5개가 친 순서대로.
    assert.deepEqual(h.calls, [
      'paste:stuck',
      'key:enter',
      'key:enter',
      'key:enter',
      'key:enter',
      'key:enter',
      'write:1',
      'write:2',
      'write:3',
      'write:4',
      'write:5',
    ]);
  });

  test('Ctrl+C 는 모으지 않는다 — 앞선 키를 흘린 뒤 즉시 나가고 아직 안 보낸 Enter 를 취소한다', () => {
    const { h } = critHarness();
    h.q.enqueue(instruct('중단될 지시'));
    h.q.typeRaw('ab');
    assert.deepEqual(h.calls, ['paste:중단될 지시']);

    h.q.interrupt();
    // 사용자가 친 순서 그대로: ab → Ctrl+C. Enter 는 영영 안 나간다.
    assert.deepEqual(h.calls, ['paste:중단될 지시', 'write:ab', 'key:ctrl-c']);
    assert.equal(h.q.heldUserInput(), 0);
    assert.equal(h.q.pendingActions(), 0, '예약돼 있던 Enter 가 취소됐다');

    h.advance(TIMING.enterDelayMs + TIMING.submitCheckMs * 6);
    h.q.tick();
    assert.deepEqual(h.calls, ['paste:중단될 지시', 'write:ab', 'key:ctrl-c']);
    assert.deepEqual(h.flushed, [], '제출되지 않았으므로 flushed 도 없다');

    // 구간이 닫혔으니 그 뒤의 타이핑은 다시 바로 나간다.
    h.q.typeRaw('c');
    assert.equal(h.calls.at(-1), 'write:c');
  });

  test('Enter 가 이미 나간 뒤의 Ctrl+C 는 재시도만 멈춘다', () => {
    const { h } = critHarness();
    h.q.enqueue(instruct('x'));
    h.advance(TIMING.enterDelayMs + 1);
    h.q.tick();
    assert.deepEqual(h.calls, ['paste:x', 'key:enter']);
    h.q.interrupt();
    assert.deepEqual(h.calls, ['paste:x', 'key:enter', 'key:ctrl-c']);
    for (let i = 0; i < 6; i++) {
      h.advance(TIMING.submitCheckMs);
      h.q.tick();
    }
    assert.equal(h.calls.filter((c) => c === 'key:enter').length, 1, '중단 뒤에는 Enter 를 다시 보내지 않는다');
  });

  test('임계 구간 밖의 타이핑은 예전 그대로 즉시 나간다', () => {
    const { h } = critHarness();
    h.q.typeRaw('hello');
    assert.deepEqual(h.calls, ['write:hello']);
    assert.equal(h.q.heldUserInput(), 0);
  });
});
