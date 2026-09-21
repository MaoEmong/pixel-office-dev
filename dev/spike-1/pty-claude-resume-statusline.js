// 이미 API 호출이 있었던 세션을 --resume 으로 다시 열면, 턴 없이도 statusLine 에 rate_limits 가 실리는가?
// (실려 있으면 "멤버 세션 재개만으로 주간 사용량을 알 수 있다" — 아니면 /usage 화면이 유일한 무턴 경로)
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const { Terminal } = require('@xterm/headless');

const OUT = path.join(__dirname, 'out');
const CLAUDE = require('./resolve-exe-lib').claudeExe();
const SANDBOX = path.resolve(path.join(__dirname, '..', 'spike-0', 'sandbox'));
const SESSION = process.argv[2];
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true, scrollback: 3000 });
const full = () => { const b = term.buffer.active; const L = []; for (let i = 0; i < b.length; i++) L.push(b.getLine(i)?.translateToString(true) ?? ''); while (L.length && !L[L.length - 1].trim()) L.pop(); return L.join('\n'); };
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE_?CODE|^CLAUDECODE|^CLAUDE_CONFIG_DIR$/i.test(k)) env[k] = v;
env.TERM = 'xterm-256color';

const fwd = (p) => p.split('\\').join('/');
const SL = path.join(OUT, 'statusline-resume.jsonl');
try { fs.unlinkSync(SL); } catch {}
const settings = path.join(__dirname, 'claude-resume-settings.json');
fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: `node ${fwd(path.join(__dirname, 'statusline-dump.js'))} ${fwd(SL)}`, padding: 0 } }, null, 2));

const p = pty.spawn(CLAUDE, ['--resume', SESSION, '--settings', settings, '--permission-mode', 'default'], { name: 'xterm-256color', cols: 120, rows: 40, cwd: SANDBOX, env });
let raw = 0;
p.onData((d) => { raw += d.length; term.write(d); });
p.onExit((e) => log('EXIT', JSON.stringify(e)));

(async () => {
  await sleep(75000);
  fs.writeFileSync(path.join(OUT, 'claude-resume-screen.txt'), full());
  try {
    const sl = fs.readFileSync(SL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(JSON.parse(l).raw));
    log('statusLine fires:', sl.length);
    sl.forEach((o, i) => log(i, 'rate_limits=', JSON.stringify(o.rate_limits), 'ctx=', JSON.stringify(o.context_window)));
  } catch (e) { log('no statusLine', e.message); }
  try { p.kill(); } catch {}
  setTimeout(() => process.exit(0), 1200);
})();
setTimeout(() => { try { p.kill(); } catch {} process.exit(0); }, 200000);
