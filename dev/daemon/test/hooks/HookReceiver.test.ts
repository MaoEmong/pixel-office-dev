// HookReceiver + hook.js 왕복 테스트. hook.js 를 실제 자식 프로세스로 띄워 stdin→POST→stdout 을 검증한다.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HookReceiver, type HookRequest, type PendingHold } from '../../src/hooks/HookReceiver.js';
import { allow, deny, askAnswers, sessionStartContext, PASS_THROUGH } from '../../src/hooks/decisions.js';
import type { HookEvent, HookPayload } from '../../src/hooks/types.js';

const HOOK_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/hooks/hook.js');

interface HookRun {
  stdout: string;
  stderr: string;
  code: number | null;
  elapsedMs: number;
}

/** `node hook.js <port> <event>` 를 PIXEL_MEMBER 와 함께 실행하고 stdout 을 모은다. */
function runHook(port: number, event: string, payload: unknown, member = 'tok1'): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK_JS, String(port), event], {
      env: { ...process.env, PIXEL_MEMBER: member },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code, elapsedMs: Date.now() - started }));
    child.stdin.end(JSON.stringify(payload));
  });
}

/** 지금 아무도 listen 하지 않는 포트 하나. */
async function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PAYLOAD: HookPayload = {
  session_id: 'sess-1',
  cwd: 'D:\\work',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo hi' },
  tool_use_id: 'tu-1',
  permission_mode: 'default',
};

describe('HookReceiver + hook.js', () => {
  const receivers: HookReceiver[] = [];
  const make = async (opts?: ConstructorParameters<typeof HookReceiver>[0]) => {
    const r = new HookReceiver(opts);
    receivers.push(r);
    const port = await r.listen(0);
    return { r, port };
  };
  after(async () => {
    for (const r of receivers) await r.close();
  });

  test('roundtrip: handler respond() → child stdout equals the response JSON', async () => {
    const { r, port } = await make();
    const seen: HookRequest[] = [];
    r.on('hook', (req) => {
      seen.push(req);
      req.respond(allow());
    });
    const run = await runHook(port, 'PreToolUse', PAYLOAD);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.memberToken, 'tok1');
    assert.equal(seen[0]!.event, 'PreToolUse');
    assert.deepEqual(seen[0]!.payload, PAYLOAD);
    assert.deepEqual(JSON.parse(run.stdout), allow());
  });

  test('no respond/hold during emit → child gets {} immediately', async () => {
    const { r, port } = await make();
    let late: HookRequest | undefined;
    r.on('hook', (req) => {
      late = req;
    });
    const run = await runHook(port, 'PostToolUse', { ...PAYLOAD, hook_event_name: 'PostToolUse' });
    assert.equal(run.stdout, '{}');
    assert.equal(run.code, 0);
    // 늦은 respond 는 무시된다
    assert.equal(late!.respond(allow()), false);
  });

  test('hold() + resolve after 300ms → child waits and gets the resolved JSON', async () => {
    const { r, port } = await make();
    let pendingDuringHold: PendingHold[] = [];
    r.on('hook', (req) => {
      const h = req.hold();
      pendingDuringHold = r.pendingHolds();
      setTimeout(() => {
        assert.equal(h.resolve(deny('nope')), true);
        assert.equal(h.settled, true);
        assert.equal(h.resolve(allow()), false); // 두 번째는 무효
      }, 300);
    });
    const run = await runHook(port, 'PermissionRequest', { ...PAYLOAD, hook_event_name: 'PermissionRequest' });
    assert.deepEqual(JSON.parse(run.stdout), deny('nope'));
    assert.ok(run.elapsedMs >= 280, `elapsed ${run.elapsedMs}ms`);
    assert.equal(pendingDuringHold.length, 1);
    assert.equal(pendingDuringHold[0]!.memberToken, 'tok1');
    assert.equal(pendingDuringHold[0]!.event, 'PermissionRequest');
    assert.equal(typeof pendingDuringHold[0]!.since, 'number');
    assert.equal(r.pendingHolds().length, 0);
  });

  test('hold-timeout (maxHoldMs=200) → child gets {} and hold-timeout is emitted', async () => {
    const { r, port } = await make({ maxHoldMs: 200 });
    const timeouts: PendingHold[] = [];
    r.on('hold-timeout', (info) => timeouts.push(info));
    r.on('hook', (req) => {
      req.hold();
    });
    const run = await runHook(port, 'PermissionRequest', { ...PAYLOAD, hook_event_name: 'PermissionRequest' });
    assert.equal(run.stdout, '{}');
    assert.ok(run.elapsedMs >= 180, `elapsed ${run.elapsedMs}ms`);
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0]!.memberToken, 'tok1');
    assert.equal(timeouts[0]!.event, 'PermissionRequest');
    assert.equal(r.pendingHolds().length, 0);
  });

  test('handle.cancel() → child gets {}', async () => {
    const { r, port } = await make();
    r.on('hook', (req) => {
      const h = req.hold();
      setTimeout(() => h.cancel(), 50);
    });
    const run = await runHook(port, 'Stop', { ...PAYLOAD, hook_event_name: 'Stop' });
    assert.equal(run.stdout, '{}');
  });

  test('hold() after respond() throws → handler-error emitted, first response stands', async () => {
    const { r, port } = await make();
    const errors: unknown[] = [];
    r.on('handler-error', (err) => errors.push(err));
    r.on('hook', (req) => {
      req.respond(allow());
      req.hold(); // 이미 응답했으므로 throw
    });
    const run = await runHook(port, 'PreToolUse', PAYLOAD);
    assert.deepEqual(JSON.parse(run.stdout), allow());
    assert.equal(errors.length, 1);
    assert.match(String((errors[0] as Error).message), /already responded/);
    assert.equal(r.pendingHolds().length, 0);
  });

  test('handler throws before responding → child gets {} and handler-error emitted', async () => {
    const { r, port } = await make();
    const errors: unknown[] = [];
    r.on('handler-error', (err) => errors.push(err));
    r.on('hook', () => {
      throw new Error('boom');
    });
    const run = await runHook(port, 'Notification', { ...PAYLOAD, hook_event_name: 'Notification' });
    assert.equal(run.stdout, '{}');
    assert.equal(errors.length, 1);
    assert.match(String((errors[0] as Error).message), /boom/);
  });

  test('unknown memberToken → {} and unknown-member emitted, no hook event', async () => {
    const { r, port } = await make({ isKnownMember: (t) => t === 'tok1' });
    let hooks = 0;
    const unknown: string[] = [];
    r.on('hook', () => hooks++);
    r.on('unknown-member', (info) => unknown.push(info.memberToken));
    const run = await runHook(port, 'PreToolUse', PAYLOAD, 'stranger');
    assert.equal(run.stdout, '{}');
    assert.equal(hooks, 0);
    assert.deepEqual(unknown, ['stranger']);
  });

  test('hold-closed: hook process disconnects before decision', async () => {
    const { r, port } = await make();
    const closed: PendingHold[] = [];
    r.on('hold-closed', (info) => closed.push(info));
    r.on('hook', (req) => {
      req.hold();
    });
    const child = spawn(process.execPath, [HOOK_JS, String(port), 'PreToolUse'], {
      env: { ...process.env, PIXEL_MEMBER: 'tok1' },
    });
    child.stdin.end(JSON.stringify(PAYLOAD));
    for (let i = 0; i < 50 && r.pendingHolds().length === 0; i++) await sleep(20);
    assert.equal(r.pendingHolds().length, 1);
    child.kill();
    for (let i = 0; i < 50 && closed.length === 0; i++) await sleep(20);
    assert.equal(closed.length, 1);
    assert.equal(r.pendingHolds().length, 0);
  });

  test('daemon down: hook.js prints {} and exits 0 within ~3s', async () => {
    const port = await closedPort();
    const run = await runHook(port, 'PreToolUse', PAYLOAD);
    assert.equal(run.stdout, '{}');
    assert.equal(run.code, 0);
    assert.ok(run.elapsedMs < 3000, `elapsed ${run.elapsedMs}ms`);
  });

  test('invalid JSON body → {} and bad-payload emitted, no hook event', async () => {
    const { r, port } = await make();
    const bad: Array<{ memberToken: string; event: string; bodyHead: string }> = [];
    let hooks = 0;
    r.on('hook', () => hooks++);
    r.on('bad-payload', (info) => bad.push(info));
    const child = spawn(process.execPath, [HOOK_JS, String(port), 'Stop'], {
      env: { ...process.env, PIXEL_MEMBER: 'tok1' },
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stdin.end('{not json');
    await new Promise((res) => child.on('close', res));
    assert.equal(out, '{}');
    assert.equal(hooks, 0);
    assert.equal(bad.length, 1);
    assert.equal(bad[0]!.memberToken, 'tok1');
    assert.equal(bad[0]!.event, 'Stop');
    assert.equal(bad[0]!.bodyHead, '{not json');
  });

  test('non-POST / unroutable URL → 404 {} and bad-request emitted', async () => {
    const { r, port } = await make();
    const bad: string[] = [];
    r.on('bad-request', (info) => bad.push(info.reason));
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), '{}');
    assert.deepEqual(bad, ['not-found']);
  });

  test('close() settles open holds with {}', async () => {
    const r = new HookReceiver();
    const port = await r.listen(0);
    r.on('hook', (req) => {
      req.hold();
    });
    const pending = runHook(port, 'PermissionRequest', { ...PAYLOAD, hook_event_name: 'PermissionRequest' });
    for (let i = 0; i < 50 && r.pendingHolds().length === 0; i++) await sleep(20);
    await r.close();
    const run = await pending;
    assert.equal(run.stdout, '{}');
  });
});

describe('decisions builders', () => {
  test('shapes match the spike-verified JSON', () => {
    assert.deepEqual(allow(), {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    assert.deepEqual(deny('why'), {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'why' } },
    });
    assert.deepEqual(sessionStartContext('[ROLE] x'), {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '[ROLE] x' },
    });
    const toolInput = { questions: [{ question: '좋아하는 색은?', options: [{ label: '빨강' }, { label: '파랑' }] }] };
    assert.deepEqual(askAnswers(toolInput, { '좋아하는 색은?': '파랑' }), {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { ...toolInput, answers: { '좋아하는 색은?': '파랑' } } },
      },
    });
    assert.deepEqual(PASS_THROUGH, {});
    const ev: HookEvent = 'PermissionRequest';
    assert.equal(ev, 'PermissionRequest');
  });
});
