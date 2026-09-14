// ScreenModel 핵심 API: feed/lines/viewport, resize, serialize 왕복, tui-map 로딩·검증.
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
  assert.deepEqual(sm.detectDialog(), { kind: 'security-notes', suggestedKeys: ['esc', 'enter'] });
  assert.equal(sm.promptReady(), false);
  const sm2 = new ScreenModel({ engine: 'claude', cols: 20, rows: 4, tuiMap: compileTuiMap(json) });
  await sm2.feed('WORKING');
  assert.equal(sm2.busyIndicator(), true);
  sm.dispose();
  sm2.dispose();
});
