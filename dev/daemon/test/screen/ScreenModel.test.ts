// ScreenModel 핵심 API: feed/lines/viewport, resize, serialize 왕복, tui-map 로딩·검증.
import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenModel } from '../../src/screen/ScreenModel.js';
import { compileTuiMap, loadTuiMap } from '../../src/screen/tuiMap.js';
import type { TuiMapJson } from '../../src/screen/tuiMap.js';
import { screenFrom } from './helpers.js';

test('feed is async: lines() reflects data only after await', async () => {
  const sm = new ScreenModel({ engine: 'claude', cols: 20, rows: 3 });
  const p = sm.feed('hello');
  assert.equal(sm.lines()[0], '');
  await p;
  assert.equal(sm.lines()[0], 'hello');
  assert.deepEqual(sm.lines(), ['hello', '', '']);
  assert.equal(sm.text(), 'hello\n\n');
  assert.deepEqual(sm.lastLines(2), ['', '']);
  assert.deepEqual(sm.lastLines(0), []);
  sm.dispose();
});

test('lines() is the viewport (bottom rows), not the top of the scrollback', async () => {
  const sm = new ScreenModel({ engine: 'codex', cols: 40, rows: 5 });
  const all = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  await sm.feed(all.join('\r\n'));
  assert.deepEqual(sm.lines(), ['line 8', 'line 9', 'line 10', 'line 11', 'line 12']);
  assert.equal(sm.lastNonEmptyLine(), 'line 12');
  assert.equal(sm.lines().length, sm.rows);
  sm.dispose();
});

test('resize changes cols/rows and keeps the bottom of the screen visible', async () => {
  const sm = await screenFrom('claude', 'claude-ready.txt');
  assert.equal(sm.cols, 120);
  assert.equal(sm.rows, 40);
  assert.equal(sm.promptReady(), true);
  sm.resize(80, 30);
  assert.equal(sm.cols, 80);
  assert.equal(sm.rows, 30);
  assert.equal(sm.lines().length, 30);
  assert.match(sm.text(), /\? for shortcuts/);
  assert.equal(sm.promptReady(), true);
  sm.dispose();
});

test('serialize() roundtrip: ANSI colours + wide chars + cursor moves reproduce the same lines()', async () => {
  const a = new ScreenModel({ engine: 'claude', cols: 30, rows: 6 });
  await a.feed('\x1b[1;32mgreen\x1b[0m plain\r\n' + '\x1b[44m bg \x1b[0m tail\r\n' + '한글 wide ✻ box ─────\r\n' + 'fourth\r\n' + '\x1b[2;8HX' + '\x1b[6;1Hlast');
  const ansi = a.serialize();
  assert.match(ansi, /\x1b\[/);
  assert.match(ansi, /green/);
  const b = new ScreenModel({ engine: 'claude', cols: 30, rows: 6 });
  await b.feed(ansi);
  assert.deepEqual(b.lines(), a.lines());
  assert.equal(a.lines()[1], ' bg  taXl'); // CUP 2;8 = 1-based col 8 = 'i'
  assert.equal(a.lines()[2], '한글 wide ✻ box ─────');
  assert.equal(a.lines()[5], 'last');
  a.dispose();
  b.dispose();
});

test('serialize() roundtrip after resize', async () => {
  const a = await screenFrom('claude', 'claude-interrupted.txt');
  a.resize(80, 30);
  const b = new ScreenModel({ engine: 'claude', cols: 80, rows: 30 });
  await b.feed(a.serialize());
  assert.deepEqual(b.lines(), a.lines());
  assert.equal(b.interrupted(), true);
  a.dispose();
  b.dispose();
});

test('loadTuiMap compiles the built-in JSON maps once per engine', () => {
  const c = loadTuiMap('claude');
  assert.equal(c.engine, 'claude');
  assert.ok(c.dialogs.length >= 5);
  assert.equal(loadTuiMap('claude'), c);
  const x = loadTuiMap('codex');
  assert.equal(x.engine, 'codex');
  assert.ok(x.promptReady.inputLine);
});

test('compileTuiMap rejects bad regex / unknown key / unknown kind', () => {
  const base: TuiMapJson = {
    engine: 'claude',
    version: 't',
    promptReady: { anyOf: ['ready'] },
    busy: { anyOf: [] },
    interrupted: { anyOf: [] },
    skipLines: [],
    dialogs: [],
  };
  assert.throws(() => compileTuiMap({ ...base, promptReady: { anyOf: ['('] } }), /bad regex/);
  assert.throws(() => compileTuiMap({ ...base, dialogs: [{ id: 'd', kind: 'login-menu', all: ['x'], keys: ['tab' as never] }] }), /unknown key/);
  assert.throws(() => compileTuiMap({ ...base, dialogs: [{ id: 'd', kind: 'bogus' as never, all: ['x'], keys: ['enter'] }] }), /unknown kind/);
  assert.throws(() => new ScreenModel({ engine: 'codex', cols: 10, rows: 2, tuiMap: base }), /engine/);
});

test('a custom tuiMap (JSON or compiled) can be injected', async () => {
  const json: TuiMapJson = {
    engine: 'claude',
    version: 'custom',
    promptReady: { anyOf: ['READY>'] },
    busy: { anyOf: ['WORKING'] },
    interrupted: { anyOf: ['STOPPED'] },
    skipLines: ['^-+$'],
    dialogs: [{ id: 'q', kind: 'security-notes', all: ['^Continue\?'], keys: ['esc', 'enter'] }],
  };
  const sm = new ScreenModel({ engine: 'claude', cols: 20, rows: 4, tuiMap: json });
  await sm.feed('out\r\n----\r\nREADY>');
  assert.equal(sm.promptReady(), true);
  assert.equal(sm.lastNonEmptyLine(), 'READY>');
  await sm.feed('\x1b[2J\x1b[HContinue?');
  assert.deepEqual(sm.detectDialog(), { kind: 'security-notes', suggestedKeys: ['esc', 'enter'], highlightDriven: false });
  assert.equal(sm.promptReady(), false);
  const sm2 = new ScreenModel({ engine: 'claude', cols: 20, rows: 4, tuiMap: compileTuiMap(json) });
  await sm2.feed('WORKING');
  assert.equal(sm2.busyIndicator(), true);
  sm.dispose();
  sm2.dispose();
});

// ---- T21: approval-prompt / noneOf 스키마 검증 ---------------------------------------------------

function minimalMap(over: Partial<TuiMapJson>): TuiMapJson {
  return {
    engine: 'codex',
    version: 'test',
    promptReady: { anyOf: ['READY'] },
    busy: { anyOf: ['BUSY'] },
    interrupted: { anyOf: ['INTERRUPTED'] },
    skipLines: [],
    dialogs: [],
    ...over,
  };
}

test('compileTuiMap: approval-prompt needs allowKeys/denyKeys and must not carry keys/highlight', () => {
  assert.throws(
    () => compileTuiMap(minimalMap({ dialogs: [{ id: 'a', kind: 'approval-prompt', all: ['proceed'], keys: ['enter'] }] })),
    /approval-prompt must not have "keys"/,
  );
  assert.throws(
    () => compileTuiMap(minimalMap({ dialogs: [{ id: 'a', kind: 'approval-prompt', all: ['proceed'], allowKeys: ['enter'] }] })),
    /denyKeys: keys must be a non-empty array/,
  );
  assert.throws(
    () => compileTuiMap(minimalMap({ dialogs: [{ id: 'a', kind: 'approval-prompt', all: ['proceed'], allowKeys: ['enter'], denyKeys: ['bogus' as never] }] })),
    /unknown key "bogus"/,
  );
  const ok = compileTuiMap(minimalMap({ dialogs: [{ id: 'a', kind: 'approval-prompt', all: ['proceed'], allowKeys: ['enter'], denyKeys: ['esc'] }] }));
  assert.deepEqual(ok.dialogs[0].keys, []);
  assert.deepEqual(ok.dialogs[0].allowKeys, ['enter']);
  assert.deepEqual(ok.dialogs[0].denyKeys, ['esc']);
});

test('compileTuiMap: allowKeys/denyKeys are rejected on non-approval dialogs; plain dialogs still need keys', () => {
  assert.throws(
    () => compileTuiMap(minimalMap({ dialogs: [{ id: 'a', kind: 'onboarding-enter', all: ['x'], keys: ['enter'], allowKeys: ['enter'] }] })),
    /only for kind "approval-prompt"/,
  );
  assert.throws(() => compileTuiMap(minimalMap({ dialogs: [{ id: 'a', kind: 'onboarding-enter', all: ['x'] }] })), /keys must be a non-empty array/);
  assert.throws(() => compileTuiMap(minimalMap({ dialogs: [{ id: 'a', kind: 'model-switch-offer', all: ['x'], keys: [] }] })), /keys must be a non-empty array/);
});

test('promptReady.noneOf blocks readiness even when a ready phrase is on screen', async () => {
  const map = compileTuiMap(minimalMap({ promptReady: { anyOf: ['READY'], noneOf: ['LOADING'] } }));
  const sm = new ScreenModel({ engine: 'codex', cols: 20, rows: 4, tuiMap: map });
  await sm.feed('LOADING\r\n\r\nREADY');
  assert.equal(sm.promptReady(), false);
  await sm.feed('\x1b[1;1H\x1b[2Kloaded');
  assert.equal(sm.promptReady(), true);
  assert.deepEqual(sm.approvalPrompt(), { visible: false, allowKeys: [], denyKeys: [] });
  sm.dispose();
});

test('built-in maps: every verified pattern names a source; approval-prompt exists for both engines', () => {
  for (const engine of ['claude', 'codex'] as const) {
    const m = loadTuiMap(engine);
    assert.ok(m.dialogs.some((d) => d.kind === 'approval-prompt'), `${engine}: approval-prompt dialog`);
    assert.ok(m.promptReady.noneOf.length >= (engine === 'codex' ? 1 : 0));
  }
  const raw: TuiMapJson[] = [
    JSON.parse(fs.readFileSync(new URL('../../src/tui-maps/claude-2.1.json', import.meta.url), 'utf8')),
    JSON.parse(fs.readFileSync(new URL('../../src/tui-maps/codex-0.154.json', import.meta.url), 'utf8')),
  ];
  for (const j of raw) {
    for (const sec of [j.promptReady, j.busy, j.interrupted]) if (sec.verified) assert.ok(sec.source, `${j.engine}: verified section without source`);
    for (const d of j.dialogs) if (d.verified) assert.ok(d.source, `${j.engine} dialogs[${d.id}]: verified without source`);
  }
});
