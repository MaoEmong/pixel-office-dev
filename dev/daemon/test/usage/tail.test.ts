// T43-1 꼬리 읽기 — 64KB 경계(줄이 경계에 걸림)·실패 내성.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTail, TAIL_BYTES } from '../../src/usage/tail.js';
import { parseCodexTokenCounts } from '../../src/usage/parse/codexTokenCount.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../fixtures/usage');

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-tail-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const write = (name: string, text: string): string => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text);
  return p;
};

describe('readTail', () => {
  test('파일이 작으면 전부 돌려준다', async () => {
    const p = write('small.jsonl', 'a\nb\nc\n');
    assert.equal(await readTail(p), 'a\nb\nc\n');
  });

  test('없는 파일 · 폴더 · 빈 경로는 빈 문자열(던지지 않는다)', async () => {
    assert.equal(await readTail(path.join(tmp, 'nope.jsonl')), '');
    assert.equal(await readTail(tmp), '');
    assert.equal(await readTail(''), '');
  });

  test('빈 파일은 빈 문자열', async () => {
    assert.equal(await readTail(write('empty.jsonl', '')), '');
  });

  test('64KB 를 넘으면 마지막 64KB 만 읽고 **잘린 첫 줄은 버린다**', async () => {
    const filler = `${'x'.repeat(200)}\n`;
    const head = filler.repeat(Math.ceil(TAIL_BYTES / filler.length) + 20);
    const p = write('big.jsonl', head + 'LAST-LINE\n');
    const tail = await readTail(p);
    assert.ok(Buffer.byteLength(tail) <= TAIL_BYTES, `${Buffer.byteLength(tail)} <= ${TAIL_BYTES}`);
    assert.ok(tail.endsWith('LAST-LINE\n'));
    // 잘린 반쪽 줄이 없다 = 모든 줄이 온전한 filler 이거나 마지막 줄이다.
    for (const line of tail.split('\n').filter(Boolean)) {
      assert.ok(line === 'LAST-LINE' || line.length === 200, `반쪽 줄이 남았다: ${line.length}자`);
    }
  });

  test('경계에 걸친 token_count 이벤트: 잘린 앞줄은 버려지고 뒤의 온전한 이벤트가 파싱된다', async () => {
    const fixture = fs.readFileSync(path.join(fixtures, 'codex-rollout-tail.jsonl'), 'utf8');
    // 64KB 를 채운 뒤 실측 rollout 꼬리를 붙이되, 경계가 이벤트 한가운데에 오도록 패딩 길이를 맞춘다.
    const padLine = `{"type":"event_msg","payload":{"type":"noise","v":"${'p'.repeat(120)}"}}\n`;
    let pad = '';
    while (Buffer.byteLength(pad) + Buffer.byteLength(fixture) < TAIL_BYTES + 5000) pad += padLine;
    const p = write('rollout.jsonl', pad + fixture);
    const tail = await readTail(p);
    assert.ok(Buffer.byteLength(tail) <= TAIL_BYTES);
    assert.ok(tail.length < pad.length + fixture.length, '앞이 잘렸어야 한다');
    // 잘린 줄이 섞여 있어도 파서는 마지막 온전한 codex 이벤트를 찾아낸다.
    const got = parseCodexTokenCounts(tail);
    assert.equal(got.weekly?.usedPercent, 12);
    assert.equal(got.plan, 'pro');
    assert.equal(got.tokens?.total, 43726);
  });

  test('maxBytes 가 한 줄보다 작아 첫 줄바꿈이 없으면 빈 문자열', async () => {
    const p = write('one.jsonl', `${'z'.repeat(500)}\n`);
    assert.equal(await readTail(p, 10), '');
  });

  test('maxBytes 를 줄이면 그만큼만 읽는다', async () => {
    const p = write('lines.jsonl', 'aaaa\nbbbb\ncccc\n');
    assert.equal(await readTail(p, 10), 'cccc\n');
  });
});
