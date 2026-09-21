// 모델 턴 없이(세션 열자마자) /usage 를 열면 주간 한도가 보이는가
// — "숨은 유틸리티 세션" 으로 한도만 읽어 오는 설계가 가능한지 판정한다.
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const { Terminal } = require('@xterm/headless');

const OUT = path.join(__dirname, 'out');
const CLAUDE = require('./resolve-exe-lib').claudeExe();
const SANDBOX = path.resolve(path.join(__dirname, '..', 'spike-0', 'sandbox'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CR = '\r';

const term = new Terminal({ cols: 120, rows: 44, allowProposedApi: true, scrollback: 4000 });
const full = () => {
  const b = term.buffer.active; const L = [];
  for (let i = 0; i < b.length; i++) L.push(b.getLine(i)?.translateToString(true) ?? '');
  while (L.length && !L[L.length - 1].trim()) L.pop();
  return L.join('\n');
};
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE_?CODE|^CLAUDECODE|^CLAUDE_CONFIG_DIR$/i.test(k)) env[k] = v;
env.TERM = 'xterm-256color';

const fwd = (p) => p.split('\\').join('/');
const statusScript = fwd(path.join(__dirname, 'statusline-dump.js'));
const SL = path.join(OUT, 'statusline-fresh.jsonl');
try { fs.unlinkSync(SL); } catch {}
const settings = path.join(__dirname, 'claude-utility-settings.json');
// statusLine 만 주입(hooks 없음) — 유틸리티 세션 최소 구성
fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: `node ${statusScript} ${fwd(SL)}`, padding: 0 } }, null, 2));

const t00 = Date.now();
const p = pty.spawn(CLAUDE, ['--settings', settings, '--permission-mode', 'default'], { name: 'xterm-256color', cols: 120, rows: 44, cwd: SANDBOX, env });
let raw = 0;
p.onData((d) => { raw += d.length; term.write(d); });
p.onExit((e) => log('EXIT', JSON.stringify(e)));
async function settle(max = 20000) {
  const t0 = Date.now(); let last = -1, st = 0;
  while (Date.now() - t0 < max) { await sleep(250); if (raw === last) { st++; if (st >= 6) break; } else { st = 0; last = raw; } }
  return Date.now() - t0;
}

(async () => {
  let ready = false;
  for (let k = 0; k < 60; k++) {
    await sleep(1000);
    const sc = full();
    if (/shift\+tab to cycle|\? for shortcuts/i.test(sc)) { ready = true; break; }
    if (/trust this folder|trust the files/i.test(sc)) p.write(CR);
  }
  log('ready', ready, 'after', Date.now() - t00, 'ms');
  const t0 = Date.now();
  p.write('/usage'); await sleep(600); p.write(CR);
  await settle(20000);
  log('usage(no turn) ms=', Date.now() - t0, 'total from spawn=', Date.now() - t00);
  const s = full();
  fs.writeFileSync(path.join(OUT, 'claude-full-usage-fresh.txt'), s);
  console.log(s.split('\n').slice(-42).join('\n'));
  try {
    const sl = fs.readFileSync(SL, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    log('statusLine fires:', sl.length);
    log('last statusLine rate_limits:', JSON.stringify(JSON.parse(sl[sl.length - 1].raw).rate_limits));
  } catch (e) { log('statusLine read fail', e.message); }
  try { p.kill(); } catch {}
  setTimeout(() => process.exit(0), 1200);
})();
setTimeout(() => { try { p.kill(); } catch {} process.exit(0); }, 240000);
