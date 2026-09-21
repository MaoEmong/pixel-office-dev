// T43-0 실측: Claude Code 에서 사용량 데이터를 어디서 얻을 수 있는지.
//  - 세션 --settings 로 hooks + statusLine 을 같이 주입
//  - 짧은 프롬프트 1회(모델 턴 1회)
//  - /usage /status /context /cost 화면을 차례로 열어 렌더 텍스트와 소요 시간 기록
//  - transcript_path(hook 페이로드) 로 JSONL 사용량 집계
// 데몬 포트(7420-7422)는 건드리지 않는다 → 7440 사용.
const pty = require('node-pty');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Terminal } = require('@xterm/headless');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const CLAUDE = process.env.CLAUDE_EXE || require('./resolve-exe-lib').claudeExe();
const SANDBOX = path.join(__dirname, '..', 'spike-0', 'sandbox');
const HOOK_PORT = 7440;

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CR = String.fromCharCode(13);
const ESC = String.fromCharCode(27);

// ---- hook 수신 ------------------------------------------------------------
const hookLog = [];
let stopCount = 0;
let transcriptPath = null;
let sessionId = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const ev = req.url.split('/').pop();
    let payload = null;
    try { payload = JSON.parse(body); } catch { payload = body; }
    hookLog.push({ ev, at: Date.now(), payload });
    if (payload && payload.transcript_path) transcriptPath = payload.transcript_path;
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

// ---- 세션 settings: hooks + statusLine ------------------------------------
const probe = path.join(__dirname, 'hookprobe.js').split('\\').join('/');
const statusScript = path.join(__dirname, 'statusline-dump.js').split('\\').join('/');
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'PreCompact', 'SessionEnd'];
const hooks = {};
for (const ev of events) hooks[ev] = [{ hooks: [{ type: 'command', command: `node ${probe} ${HOOK_PORT} ${ev}`, timeout: 120 }] }];
const settingsPath = path.join(__dirname, 'claude-session-settings.json');
fs.writeFileSync(settingsPath, JSON.stringify({
  hooks,
  statusLine: { type: 'command', command: `node ${statusScript}`, padding: 0 },
}, null, 2));
try { fs.unlinkSync(path.join(OUT, 'statusline.jsonl')); } catch {}

// ---- pty + 화면 -----------------------------------------------------------
const cols = 120, rows = 40;
const term = new Terminal({ cols, rows, allowProposedApi: true });
const screen = () => {
  const L = [];
  const b = term.buffer.active;
  for (let i = 0; i < rows; i++) L.push(b.getLine(i)?.translateToString(true) ?? '');
  while (L.length && !L[L.length - 1].trim()) L.pop();
  return L.join('\n');
};
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE_?CODE|^CLAUDECODE|^CLAUDE_CONFIG_DIR$/i.test(k)) env[k] = v;
env.TERM = 'xterm-256color';

log('spawn', CLAUDE);
const p = pty.spawn(CLAUDE, ['--settings', settingsPath, '--permission-mode', 'default'], { name: 'xterm-256color', cols, rows, cwd: SANDBOX, env });
let raw = 0;
p.onData((d) => { raw += d.length; term.write(d); });
p.onExit((e) => { log('EXIT', JSON.stringify(e)); finish(); });
const type = (s) => { p.write(s); };

const dumps = {};
const dump = (tag) => {
  const s = screen();
  dumps[tag] = s;
  fs.writeFileSync(path.join(OUT, `claude-screen-${tag}.txt`), s);
  log(`--- SCREEN ${tag} ---\n${s}\n--- END ${tag} ---`);
  return s;
};

const READY_RE = /shift\+tab to cycle|\? for shortcuts/i;
async function waitReady(maxS = 90) {
  for (let k = 0; k < maxS / 2; k++) {
    await sleep(2000);
    const sc = screen();
    if (READY_RE.test(sc)) return true;
    if (/trust this folder|trust the files/i.test(sc)) { type(CR); }
  }
  return false;
}
async function waitStop(prev, maxS = 180) {
  for (let i = 0; i < maxS && stopCount === prev; i++) await sleep(1000);
  return stopCount > prev;
}

/** 화면이 조용해질 때까지 기다린다(raw 바이트가 멈춤). 렌더 소요 시간을 잰다. */
async function settle(maxMs = 20000) {
  const t0 = Date.now();
  let last = -1, stable = 0;
  while (Date.now() - t0 < maxMs) {
    await sleep(250);
    if (raw === last) { stable++; if (stable >= 4) break; } else { stable = 0; last = raw; }
  }
  return Date.now() - t0;
}

/** 슬래시 명령을 치고 화면이 멎을 때까지 기다린 뒤 덤프. */
async function slash(cmd, tag) {
  const slBefore = countStatusLine();
  const t0 = Date.now();
  type(cmd);
  await sleep(600);
  type(CR);
  const ms = await settle();
  const s = dump(tag);
  log(`SLASH ${cmd} settled in ${Date.now() - t0}ms (settle=${ms}ms) statusLine fires during=${countStatusLine() - slBefore}`);
  return { cmd, tag, ms: Date.now() - t0, screen: s };
}
function countStatusLine() {
  try { return fs.readFileSync(path.join(OUT, 'statusline.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}

const timings = [];

(async () => {
  const ready = await waitReady();
  log('ready?', ready);
  dump('00-ready');
  log('statusLine fires at startup:', countStatusLine());

  // idle 상태에서 statusLine 이 주기적으로 터지는지 20초 관찰
  const idleBefore = countStatusLine();
  await sleep(20000);
  log(`statusLine idle 20s: ${idleBefore} -> ${countStatusLine()}`);

  // (A) 모델 턴 1회 — 사용량 레코드 생성
  let prev = stopCount;
  const t0 = Date.now();
  type('1+1은?  숫자만 한 줄로 답해.');
  await sleep(400);
  type(CR);
  const stopped = await waitStop(prev, 180);
  log('turn done?', stopped, `${Date.now() - t0}ms`, 'statusLine total:', countStatusLine());
  dump('01-after-turn');

  // (B) 슬래시 화면들 — 각각 여는 데 걸리는 시간과 모델 턴 발생 여부(Stop 카운트)를 본다
  for (const [cmd, tag] of [['/context', '02-context'], ['/cost', '03-cost'], ['/status', '04-status'], ['/usage', '05-usage']]) {
    const before = stopCount;
    const r = await slash(cmd, tag);
    timings.push({ cmd, ms: r.ms, modelTurnTriggered: stopCount > before });
    log(`${cmd}: modelTurn=${stopCount > before}`);
    // 화면 닫기
    type(ESC);
    await sleep(1200);
  }

  // /usage 는 탭이 여러 개일 수 있다 — Tab/화살표로 넘겨 본다
  await slash('/usage', '06-usage-again');
  for (const [key, tag] of [['\t', '07-usage-tab1'], ['\t', '08-usage-tab2']]) {
    type(key);
    await settle(6000);
    dump(tag);
  }
  type(ESC);
  await sleep(1000);

  finish();
})();

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  fs.writeFileSync(path.join(OUT, 'claude-hooklog.json'), JSON.stringify({ sessionId, transcriptPath, timings, hookLog }, null, 2));
  log('sessionId', sessionId);
  log('transcriptPath', transcriptPath);
  log('timings', JSON.stringify(timings));
  try { p.kill(); } catch {}
  server.close();
  setTimeout(() => process.exit(0), 1500);
}
setTimeout(() => { log('WATCHDOG'); finish(); }, 600000);
