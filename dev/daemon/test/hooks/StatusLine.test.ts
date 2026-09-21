// T43-1 — `POST /status/<memberToken>` 경로 + statusline.js 왕복.
// hook.js 테스트와 같은 방식으로 **실제 자식 프로세스**를 띄워 stdin → POST → stdout 을 본다.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HookReceiver, type StatusLineRequest } from '../../src/hooks/HookReceiver.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATUSLINE_JS = path.resolve(here, '../../src/hooks/statusline.js');
const fixtures = path.resolve(here, '../fixtures/usage');
const statusLinePayload = (n: number): unknown =>
  JSON.parse(fs.readFileSync(path.join(fixtures, 'claude-statusline.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)[n]!);

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
  elapsedMs: number;
}

/** `node statusline.js <port>` 를 PIXEL_MEMBER 와 함께 실행하고 stdout 을 모은다. */
function runStatusLine(port: number, payload: unknown, member = 'tok1'): Promise<Run> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [STATUSLINE_JS, String(port)], {
      env: { ...process.env, PIXEL_MEMBER: member },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code, elapsedMs: Date.now() - started }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

/** 지금 아무도 listen 하지 않는 포트 하나. */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/** 수신기에 직접 POST 한다(스크립트 없이 경로만 볼 때). */
function post(port: number, urlPath: string, body: string): Promise<{ status: number; text: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text, contentType: String(res.headers['content-type'] ?? '') }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('HookReceiver — POST /status/<memberToken>', () => {
  const receivers: HookReceiver[] = [];
  const make = async (opts?: ConstructorParameters<typeof HookReceiver>[0]) => {
    const r = new HookReceiver(opts);
    receivers.push(r);
    return { r, port: await r.listen(0) };
  };
  after(async () => {
    await Promise.all(receivers.map((r) => r.close()));
  });

  test('리스너가 돌려준 한 줄이 text/plain 으로 나간다', async () => {
    const { r, port } = await make();
    let seen: StatusLineRequest | undefined;
    r.on('status-line', (req) => {
      seen = req;
      req.respond('컨텍스트 4% · 주간 46% 남음');
    });
    const res = await post(port, '/status/tok1', JSON.stringify(statusLinePayload(1)));
    assert.equal(res.status, 200);
    assert.equal(res.text, '컨텍스트 4% · 주간 46% 남음');
    assert.match(res.contentType, /text\/plain/);
    assert.equal(seen?.memberToken, 'tok1');
    assert.equal(seen?.payload.session_id, '50cc7bea-750f-4e3f-8492-4c4595194b6d');
  });

  test('모르는 토큰은 404 + 빈 본문 (hook 과 달리 pass-through 로 감싸지 않는다)', async () => {
    const bad: Array<{ method: string; url: string; reason: string }> = [];
    const { r, port } = await make({ isKnownMember: (t) => t === 'tok1' });
    r.on('bad-request', (info) => bad.push(info));
    let called = false;
    r.on('status-line', () => {
      called = true;
    });
    const res = await post(port, '/status/nope', '{}');
    assert.equal(res.status, 404);
    assert.equal(res.text, '');
    assert.equal(called, false, '리스너까지 가지 않는다');
    assert.deepEqual(bad.map((b) => b.reason), ['unknown-member']);
  });

  test('리스너가 없으면 빈 줄로 닫는다(보류하지 않는다)', async () => {
    const { port } = await make();
    const res = await post(port, '/status/tok1', '{}');
    assert.equal(res.status, 200);
    assert.equal(res.text, '');
  });

  test('리스너가 던져도 응답은 나간다', async () => {
    const { r, port } = await make();
    const errors: unknown[] = [];
    r.on('handler-error', (err) => errors.push(err));
    r.on('status-line', () => {
      throw new Error('boom');
    });
    const res = await post(port, '/status/tok1', '{}');
    assert.equal(res.status, 200);
    assert.equal(res.text, '');
    assert.equal(errors.length, 1);
  });

  test('JSON 이 아닌 본문도 빈 줄로 닫는다', async () => {
    const { r, port } = await make();
    const bad: string[] = [];
    r.on('bad-payload', (info) => bad.push(info.event));
    const res = await post(port, '/status/tok1', 'not json');
    assert.equal(res.status, 200);
    assert.equal(res.text, '');
    assert.deepEqual(bad, ['StatusLine']);
  });

  test('GET · 다른 경로는 그대로 404', async () => {
    const { port } = await make();
    const res = await post(port, '/status/tok1/extra', '{}');
    assert.equal(res.status, 404);
  });

  test('hook 경로는 영향을 받지 않는다', async () => {
    const { r, port } = await make();
    r.on('hook', (req) => req.respond({ ok: true }));
    const res = await post(port, '/hook/tok1/Stop', '{}');
    assert.equal(res.status, 200);
    assert.equal(res.text, '{"ok":true}');
    assert.match(res.contentType, /application\/json/);
  });
});

describe('statusline.js 왕복', () => {
  const receivers: HookReceiver[] = [];
  after(async () => {
    await Promise.all(receivers.map((r) => r.close()));
  });

  test('stdin 페이로드를 보내고 응답 한 줄을 그대로 찍는다', async () => {
    const r = new HookReceiver();
    receivers.push(r);
    const port = await r.listen(0);
    let got: unknown;
    r.on('status-line', (req) => {
      got = req.payload;
      req.respond('컨텍스트 4% · 주간 46% 남음');
    });
    const run = await runStatusLine(port, statusLinePayload(1));
    assert.equal(run.code, 0);
    assert.equal(run.stdout, '컨텍스트 4% · 주간 46% 남음\n');
    assert.equal((got as { session_id?: string }).session_id, '50cc7bea-750f-4e3f-8492-4c4595194b6d');
  });

  test('데몬이 없으면 **빈 줄**을 찍고 바로 exit 0 (TUI 를 막지 않는다)', async () => {
    const port = await closedPort();
    const run = await runStatusLine(port, { session_id: 'x' });
    assert.equal(run.code, 0);
    assert.equal(run.stdout, '\n', '빈 줄 하나');
    assert.ok(run.elapsedMs < 4000, `너무 오래 걸린다: ${run.elapsedMs}ms`);
  });

  test('포트 인자가 잘못돼도 빈 줄 + exit 0', async () => {
    const run = await runStatusLine(0, { session_id: 'x' });
    assert.equal(run.code, 0);
    assert.equal(run.stdout, '\n');
  });

  test('404(모르는 토큰)면 빈 줄을 찍는다 — 상태줄에 오류 본문이 새지 않는다', async () => {
    const r = new HookReceiver({ isKnownMember: () => false });
    receivers.push(r);
    const port = await r.listen(0);
    const run = await runStatusLine(port, { session_id: 'x' }, 'ghost');
    assert.equal(run.code, 0);
    assert.equal(run.stdout, '\n');
  });

  test('응답에 줄바꿈이 섞여도 한 줄로 만든다', async () => {
    const r = new HookReceiver();
    receivers.push(r);
    const port = await r.listen(0);
    r.on('status-line', (req) => req.respond('한 줄\n'));
    const run = await runStatusLine(port, {});
    assert.equal(run.stdout, '한 줄\n');
  });
});
