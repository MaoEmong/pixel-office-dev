// PtyManager 의 "정중한 종료"(T20). 실측: Claude 는 `/exit`+Enter, Codex 는 Ctrl+C —
// idle 프롬프트에서는 **한 번**이면 exit 0(T20/T21 실측, `codex resume <id>` 안내가 찍힌다).
// 턴이 도는 중이면 첫 Ctrl+C 는 그 턴만 끊으므로 2초 안에 안 죽었을 때만 한 번 더 보낸다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_SECOND_CTRL_C_WAIT_MS, gracefulQuit, KEY_BYTES, type QuitTarget } from '../../src/pty/PtyManager.js';

function target(engine: 'claude' | 'codex', opts: { throwOnWrite?: boolean } = {}) {
  const writes: string[] = [];
  const keys: string[] = [];
  const t: QuitTarget & { writes: string[]; keys: string[]; alive: boolean } = {
    engine,
    alive: true,
    writes,
    keys,
    write(text: string) {
      if (opts.throwOnWrite) throw new Error('not alive');
      writes.push(text);
    },
    sendKeys(k) {
      if (opts.throwOnWrite) throw new Error('not alive');
      keys.push(k);
    },
  };
  return t;
}

/** waitExit 호출을 기록하고 answers 순서대로 답하는 가짜(그 다음부터는 마지막 답을 반복). */
function waiter(answers: boolean[]) {
  const calls: number[] = [];
  let i = 0;
  return {
    calls,
    fn: async (ms: number) => {
      calls.push(ms);
      const v = answers[Math.min(i, answers.length - 1)] ?? false;
      i++;
      return v;
    },
  };
}

describe('gracefulQuit', () => {
  test('claude: /exit + Enter 한 번, 그리고 timeoutMs 만큼 대기', async () => {
    const s = target('claude');
    const w = waiter([true]);
    assert.equal(await gracefulQuit(s, w.fn, { timeoutMs: 4000 }), true);
    assert.deepEqual(s.writes, ['/exit' + KEY_BYTES.enter]);
    assert.deepEqual(s.keys, []);
    assert.deepEqual(w.calls, [4000]);
  });

  test('codex: 첫 Ctrl+C 로 죽으면 두 번째는 안 보낸다(실측: idle 프롬프트에서 한 번이면 끝)', async () => {
    const s = target('codex');
    const w = waiter([true]);
    assert.equal(await gracefulQuit(s, w.fn, { timeoutMs: 5000 }), true);
    assert.deepEqual(s.keys, ['ctrl-c']);
    assert.deepEqual(s.writes, [], 'codex 는 /exit 를 쓰지 않는다');
    assert.deepEqual(w.calls, [CODEX_SECOND_CTRL_C_WAIT_MS]);
  });

  test('codex: 2초 안에 안 죽으면(턴 진행 중) Ctrl+C 를 한 번 더, 남은 시간만큼 대기', async () => {
    const s = target('codex');
    const w = waiter([false, true]);
    assert.equal(await gracefulQuit(s, w.fn, { timeoutMs: 5000 }), true);
    assert.deepEqual(s.keys, ['ctrl-c', 'ctrl-c']);
    assert.deepEqual(w.calls, [2000, 3000]);
  });

  test('codex: 끝까지 안 죽으면 false(호출자가 강제 종료)', async () => {
    const s = target('codex');
    const w = waiter([false]);
    assert.equal(await gracefulQuit(s, w.fn, { timeoutMs: 5000 }), false);
    assert.deepEqual(s.keys, ['ctrl-c', 'ctrl-c']);
  });

  test('codex: 첫 Ctrl+C 뒤 세션이 죽었으면(alive=false) 두 번째를 안 보낸다', async () => {
    const s = target('codex');
    const w = { calls: [] as number[], fn: async (ms: number) => { w.calls.push(ms); s.alive = false; return false; } };
    await gracefulQuit(s, w.fn, { timeoutMs: 5000 });
    assert.deepEqual(s.keys, ['ctrl-c']);
  });

  test('timeoutMs 가 짧으면 첫 대기도 그만큼만', async () => {
    const s = target('codex');
    const w = waiter([false, false]);
    await gracefulQuit(s, w.fn, { timeoutMs: 1000 });
    assert.deepEqual(w.calls, [1000, 0]);
  });

  test('이미 죽은 세션에 써서 나는 예외는 삼킨다(강제 종료로 이어진다)', async () => {
    const w = waiter([false]);
    await assert.doesNotReject(() => gracefulQuit(target('codex', { throwOnWrite: true }), w.fn, { timeoutMs: 10 }));
    await assert.doesNotReject(() => gracefulQuit(target('claude', { throwOnWrite: true }), w.fn, { timeoutMs: 10 }));
  });
});
