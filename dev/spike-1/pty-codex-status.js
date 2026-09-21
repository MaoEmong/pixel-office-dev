// Codex /status 화면만 따로, 스크롤백까지 포함해서 캡처한다.
// (Codex TUI 는 인라인 렌더라 패널이 뷰포트 위로 흘러가 버려 viewport 40줄만 뜨면 잘린다)
// 1) 세션을 열자마자 /status  → 모델 턴 없이도 한도가 보이는가
// 2) 짧은 턴 1회 후 /status   → 값이 바뀌는가
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const { Terminal } = require('@xterm/headless');

const OUT = path.join(__dirname, 'out');
const CODEX = process.env.CODEX_EXE || require('./resolve-exe-lib').codexExe();
const SANDBOX = path.resolve(path.join(__dirname, '..', 'spike-0', 'sandbox'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CR = String.fromCharCode(13);
const ESC = String.fromCharCode(27);

const cols = 120, rows = 40;
const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
/** 스크롤백 포함 전체 버퍼. */
const fullBuffer = () => {
  const b = term.buffer.active;
  const L = [];
  for (let i = 0; i < b.length; i++) L.push(b.getLine(i)?.translateToString(true) ?? '');
  while (L.length && !L[L.length - 1].trim()) L.pop();
  return L.join('\n');
};

const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE_?CODE|^CLAUDECODE|^CLAUDE_CONFIG_DIR$/i.test(k)) env[k] = v;
env.TERM = 'xterm-256color';
const trustKey = 'projects."' + SANDBOX.split('\\').join('\\\\') + '".trust_level="trusted"';
// hooks 없이(순수 TUI) — /status 가 hooks 와 무관함을 보이려고
const p = pty.spawn(CODEX, ['-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"', '-c', trustKey], { name: 'xterm-256color', cols, rows, cwd: SANDBOX, env });
let raw = 0;
p.onData((d) => { raw += d.length; term.write(d); });
p.onExit((e) => { log('EXIT', JSON.stringify(e)); });

async function settle(maxMs = 20000) {
  const t0 = Date.now();
  let last = -1, stable = 0;
  while (Date.now() - t0 < maxMs) {
    await sleep(250);
    if (raw === last) { stable++; if (stable >= 6) break; } else { stable = 0; last = raw; }
  }
  return Date.now() - t0;
}
const dump = (tag) => {
  const s = fullBuffer();
  fs.writeFileSync(path.join(OUT, `codex-full-${tag}.txt`), s);
  log(`saved codex-full-${tag}.txt (${s.split('\n').length} lines)`);
  return s;
};

(async () => {
  for (let k = 0; k < 25; k++) {
    await sleep(2000);
    const sc = fullBuffer();
    if (/trust the contents|Yes, continue/i.test(sc)) { p.write(CR); continue; }
    if (/Ask Codex to do anything/i.test(sc)) break;
  }
  dump('00-ready');

  // (1) 턴 전에 /status
  let t0 = Date.now();
  p.write('/status'); await sleep(700); p.write(CR);
  await settle(20000);
  log('status(before turn) ms=', Date.now() - t0);
  dump('01-status-before-turn');
  p.write(ESC); await sleep(1000);

  // (2) 짧은 턴
  p.write('3+3은? 숫자만.'); await sleep(500); p.write(CR);
  await settle(90000);
  dump('02-after-turn');

  // (3) 턴 후 /status
  t0 = Date.now();
  p.write('/status'); await sleep(700); p.write(CR);
  await settle(20000);
  log('status(after turn) ms=', Date.now() - t0);
  dump('03-status-after-turn');

  try { p.kill(); } catch {}
  setTimeout(() => process.exit(0), 1500);
})();
setTimeout(() => { log('WATCHDOG'); try { p.kill(); } catch {} process.exit(0); }, 400000);
