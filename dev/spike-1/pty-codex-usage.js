// T43-0 실측: Codex CLI 에서 사용량 데이터를 어디서 얻을 수 있는지.
//  - TUI 를 pty 로 띄우고 hooks 주입(포트 7441 — 데몬 7420-7422 는 건드리지 않는다)
//  - 짧은 프롬프트 2회(턴마다 token_count 가 찍히는지 확인)
//  - /status 화면 캡처
//  - rollout JSONL 을 세션 id 로 찾아 token_count / token_usage_record 추출
const pty = require('node-pty');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Terminal } = require('@xterm/headless');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const CODEX = process.env.CODEX_EXE || require('./resolve-exe-lib').codexExe();
const SANDBOX = path.join(__dirname, '..', 'spike-0', 'sandbox');
const HOOK_PORT = 7441;

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CR = String.fromCharCode(13);
const ESC = String.fromCharCode(27);

// ---- hook 수신 -------------------------------------------------------------
const hookLog = [];
let stopCount = 0;
let sessionId = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parts = req.url.split('/'); // /hook/<member>/<event>
    const ev = parts[parts.length - 1];
    let payload = null;
    try { payload = JSON.parse(body); } catch { payload = body; }
    hookLog.push({ ev, at: Date.now(), payload });
    if (payload && payload.session_id) sessionId = payload.session_id;
    if (ev === 'Stop') stopCount++;
    log(`HOOK ${ev} keys=${payload && typeof payload === 'object' ? Object.keys(payload).join(',') : ''}`);
    res.setHeader('content-type', 'application/json');
    if (ev === 'PermissionRequest') {
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }));
      return;
    }
    res.end('{}');
  });
});
server.listen(HOOK_PORT, '127.0.0.1');

const probe = path.join(__dirname, 'hookprobe.js').split('\\').join('/');
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd'];
const hooks = {};
for (const ev of events) hooks[ev] = [{ hooks: [{ type: 'command', command: `node ${probe} ${HOOK_PORT} ${ev}`, timeout: 120 }] }];
fs.mkdirSync(path.join(SANDBOX, '.codex'), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, '.codex', 'hooks.json'), JSON.stringify({ description: 'pixel-office spike-1', hooks }, null, 2));

// ---- pty -------------------------------------------------------------------
const cols = 120, rows = 40;
const term = new Terminal({ cols, rows, allowProposedApi: true });
const screen = () => {
  const L = [];
  const b = term.buffer.active;
  for (let i = 0; i < rows; i++) L.push(b.getLine(i)?.translateToString(true) ?? '');
  while (L.length && !L[L.length - 1].trim()) L.pop();
  return L.join('\n');
};
const env = { PIXEL_MEMBER: 'spike1-codex' };
for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE_?CODE|^CLAUDECODE|^CLAUDE_CONFIG_DIR$/i.test(k)) env[k] = v;
env.TERM = 'xterm-256color';

const trustKey = 'projects."' + path.resolve(SANDBOX).split('\\').join('\\\\') + '".trust_level="trusted"';
const args = ['--dangerously-bypass-hook-trust', '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"', '-c', trustKey];
log('spawn', CODEX, args.join(' '));
const p = pty.spawn(CODEX, args, { name: 'xterm-256color', cols, rows, cwd: path.resolve(SANDBOX), env });
let raw = 0;
p.onData((d) => { raw += d.length; term.write(d); });
p.onExit((e) => { log('EXIT', JSON.stringify(e)); finish(); });
const type = (s) => { p.write(s); };
const dump = (tag) => {
  const s = screen();
  fs.writeFileSync(path.join(OUT, `codex-screen-${tag}.txt`), s);
  log(`--- SCREEN ${tag} ---\n${s}\n--- END ${tag} ---`);
  return s;
};

async function settle(maxMs = 20000) {
  const t0 = Date.now();
  let last = -1, stable = 0;
  while (Date.now() - t0 < maxMs) {
    await sleep(250);
    if (raw === last) { stable++; if (stable >= 4) break; } else { stable = 0; last = raw; }
  }
  return Date.now() - t0;
}

/** rollout 파일을 세션 id 로 찾는다. 못 찾으면 가장 최근 것. */
function findRollout(id) {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const out = [];
  (function walk(d) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const q = path.join(d, e.name); if (e.isDirectory()) walk(q); else if (/^rollout-.*\.jsonl$/.test(e.name)) out.push(q); }
  })(root);
  if (id) { const hit = out.find((f) => f.includes(id)); if (hit) return hit; }
  return out.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}
function rolloutTokenEvents(file) {
  const res = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.type === 'event_msg' && o.payload && o.payload.type === 'token_count') res.push({ kind: 'token_count', ts: o.timestamp, payload: o.payload });
    if (o.type === 'token_usage_record') res.push({ kind: 'token_usage_record', ts: o.timestamp, payload: o.payload });
  }
  return res;
}

const marks = [];

(async () => {
  // 신뢰 프롬프트 처리 + 준비 대기
  for (let k = 0; k < 25; k++) {
    await sleep(2000);
    const sc = screen();
    if (/trust the contents|Yes, continue|trust this folder/i.test(sc)) { type(CR); continue; }
    if (/\bEsc\b.*interrupt|Ctrl\+.|▌|to send|send a message/i.test(sc)) break;
  }
  dump('00-ready');

  // 턴 1
  let prev = stopCount;
  type('1+1은? 숫자만 한 줄로 답해.');
  await sleep(500); type(CR);
  for (let i = 0; i < 120 && stopCount === prev; i++) await sleep(1000);
  await settle(8000);
  dump('01-after-turn1');
  marks.push({ mark: 'turn1', at: Date.now() });

  // 턴 2 — 턴마다 token_count 가 찍히는지 확인
  prev = stopCount;
  type('2+2는? 숫자만.');
  await sleep(500); type(CR);
  for (let i = 0; i < 120 && stopCount === prev; i++) await sleep(1000);
  await settle(8000);
  dump('02-after-turn2');
  marks.push({ mark: 'turn2', at: Date.now() });

  // /status
  const beforeStop = stopCount;
  const t0 = Date.now();
  type('/status');
  await sleep(700); type(CR);
  const ms = await settle(20000);
  dump('03-status');
  log(`/status settled in ${Date.now() - t0}ms (settle=${ms}) modelTurn=${stopCount > beforeStop}`);
  marks.push({ mark: 'status', ms: Date.now() - t0, modelTurn: stopCount > beforeStop });

  // /limits 같은 게 있는지 슬래시 목록도 캡처
  type(ESC); await sleep(800);
  type('/');
  await settle(6000);
  dump('04-slash-menu');
  type(ESC); await sleep(500);

  finish();
})();

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  const file = findRollout(sessionId);
  let tokens = [];
  try { tokens = rolloutTokenEvents(file); } catch (e) { log('rollout read fail', e.message); }
  fs.writeFileSync(path.join(OUT, 'codex-usage.json'), JSON.stringify({ sessionId, rollout: file, marks, tokenEvents: tokens, hookLog }, null, 2));
  log('sessionId', sessionId);
  log('rollout', file);
  log('token events', tokens.length, tokens.map((t) => `${t.kind}@${t.ts}`).join(' | '));
  try { p.kill(); } catch {}
  server.close();
  setTimeout(() => process.exit(0), 1500);
}
setTimeout(() => { log('WATCHDOG'); finish(); }, 600000);
