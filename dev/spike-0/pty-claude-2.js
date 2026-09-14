// 실측 spike-2: AskUserQuestion 경로, 75초 허가 보류(hook timeout), 여러 줄 붙여넣기, Ctrl+C, 리사이즈, /clear 후 SessionStart(source)
const pty = require('node-pty');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Terminal } = require('@xterm/headless');

const CLAUDE = process.env.CLAUDE_EXE || path.join(process.env.APPDATA, 'Claude', 'claude-code', '2.1.270', 'claude.exe');
const SANDBOX = path.join(__dirname, 'sandbox');
const HOOK_PORT = 7421;
fs.mkdirSync(SANDBOX, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CR = String.fromCharCode(13);
const ESC = String.fromCharCode(27);

// ---- hook receiver -------------------------------------------------------
const hookLog = [];
let stopCount = 0;
let permHold = 3000; // 허가 보류 시간 (ms) — 단계별로 바꿈
let askSeen = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const ev = req.url.split('/').pop();
    let payload = null;
    try { payload = JSON.parse(body); } catch { payload = body; }
    hookLog.push({ ev, payload, at: Date.now() });
    if (ev === 'Stop') stopCount++;
    const brief = payload && typeof payload === 'object'
      ? { sid: (payload.session_id || '').slice(0, 8), source: payload.source, tool: payload.tool_name, input: payload.tool_input && JSON.stringify(payload.tool_input).slice(0, 160), resp: payload.tool_response && JSON.stringify(payload.tool_response).slice(0, 120), last: payload.last_assistant_message && String(payload.last_assistant_message).slice(0, 60), reason: payload.reason }
      : payload;
    log(`HOOK ${ev}`, JSON.stringify(brief));
    res.setHeader('content-type', 'application/json');
    if (ev === 'PermissionRequest' && payload.tool_name === 'AskUserQuestion') {
      askSeen = payload;
      // 실측: 질문 답을 hook 결정의 updatedInput으로 돌려줄 수 있는지 (SDK canUseTool 방식과 동일 가정)
      const q = payload.tool_input && payload.tool_input.questions && payload.tool_input.questions[0];
      const answers = q ? { [q.question]: (q.options && q.options[1] && q.options[1].label) || '파랑' } : {};
      const updatedInput = Object.assign({}, payload.tool_input, { answers });
      setTimeout(() => {
        res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput } } }));
        log('HOOK AskUserQuestion -> replied allow with answers', JSON.stringify(answers));
      }, 2000);
      return;
    }
    if (ev === 'PermissionRequest') {
      const hold = permHold;
      setTimeout(() => {
        res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }));
        log(`HOOK PermissionRequest -> replied allow after ${hold}ms`);
      }, hold);
      return;
    }
    if (ev === 'SessionStart') {
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `[ROLE] 너는 픽셀오피스 실측용 팀원 "테스트"다. 답변 첫 줄에 반드시 "[테스트 팀원 ${payload.source}]"을 붙여라.` } }));
      return;
    }
    res.end('{}');
  });
});
server.listen(HOOK_PORT, '127.0.0.1');

const curl = '/c/Windows/System32/curl.exe';
const hookCmd = (ev) => `${curl} -s -X POST --data-binary @- http://127.0.0.1:${HOOK_PORT}/hook/${ev}`;
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd'];
const hooks = {};
for (const ev of events) hooks[ev] = [{ hooks: [{ type: 'command', command: hookCmd(ev), timeout: 600 }] }];
const settingsPath = path.join(__dirname, 'session-settings.json');
fs.writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));

// ---- pty + screen ----------------------------------------------------------
let cols = 120, rows = 40;
const term = new Terminal({ cols, rows, allowProposedApi: true });
const screen = () => { const L = []; const b = term.buffer.active; for (let i = 0; i < rows; i++) L.push(b.getLine(i)?.translateToString(true) ?? ''); while (L.length && !L[L.length - 1].trim()) L.pop(); return L.join('\n'); };
const env = {}; for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE_?CODE|^CLAUDECODE|^CLAUDE_CONFIG_DIR$/i.test(k)) env[k] = v;
const p = pty.spawn(CLAUDE, ['--settings', settingsPath, '--permission-mode', 'default'], { name: 'xterm-256color', cols, rows, cwd: SANDBOX, env });
log('pid', p.pid);
let raw = 0; p.onData((d) => { raw += d.length; term.write(d); });
p.onExit((e) => { log('EXIT', JSON.stringify(e)); finish(); });
const type = (s) => { log('TYPE', JSON.stringify(s).slice(0, 100)); p.write(s); };
const dump = (tag) => { log(`--- SCREEN ${tag} (raw=${raw}) ---\n` + screen() + '\n--- END ---'); };
const READY_RE = /shift\+tab to cycle|\? for shortcuts/i;

async function waitReady(maxS = 60) {
  for (let k = 0; k < maxS / 2; k++) {
    await sleep(2000);
    const sc = screen();
    if (READY_RE.test(sc)) return true;
    if (/trust this folder/i.test(sc)) { type(ESC + '[B'); await sleep(300); type(CR); continue; }
    if (/Press Enter|Enter to continue|Enter to confirm/i.test(sc)) { type(CR); }
  }
  return false;
}
async function waitStop(prev, maxS = 120) { for (let i = 0; i < maxS && stopCount === prev; i++) await sleep(1000); return stopCount > prev; }

(async () => {
  log('ready?', await waitReady()); dump('READY');

  // (1) AskUserQuestion 경로
  let prev = stopCount;
  type('AskUserQuestion 도구를 써서 나에게 "좋아하는 색은?"이라고 물어봐. 옵션은 빨강, 파랑 두 개. 답을 받으면 그 색을 한 줄로 말해줘.'); await sleep(300); type(CR);
  await sleep(12000); dump('during AskUserQuestion (12s)');
  if (!askSeen) { log('AskUserQuestion PermissionRequest NOT seen — TUI 메뉴 키 입력 폴백 시도: ↓ Enter'); type(ESC + '[B'); await sleep(300); type(CR); }
  log('stop after ask?', await waitStop(prev, 60)); dump('after AskUserQuestion');

  // (2) 75초 허가 보류 (hook timeout 600 설정)
  permHold = 75000; prev = stopCount;
  type('셸 명령 "echo hold > hold.txt"를 실행해줘. 다른 건 하지 마.'); await sleep(300); type(CR);
  log('stop after 75s hold?', await waitStop(prev, 150)); dump('after 75s hold');
  log('hold.txt exists?', fs.existsSync(path.join(SANDBOX, 'hold.txt')));

  // (3) 여러 줄 붙여넣기 (bracketed paste)
  permHold = 1000; prev = stopCount;
  type(ESC + '[200~' + '다음 세 줄을 그대로 multi.txt에 저장해줘:\n첫째 줄\n둘째 줄\n셋째 줄' + ESC + '[201~'); await sleep(500); dump('after paste (before Enter)'); type(CR);
  log('stop after paste?', await waitStop(prev, 90));
  try { log('multi.txt =', JSON.stringify(fs.readFileSync(path.join(SANDBOX, 'multi.txt'), 'utf8'))); } catch (e) { log('multi.txt missing'); }

  // (4) Ctrl+C 중단
  prev = stopCount;
  type('셸 명령 "sleep 40"을 실행해줘.'); await sleep(300); type(CR);
  await sleep(8000); type(String.fromCharCode(3)); await sleep(3000); dump('after Ctrl+C');
  log('stop after ctrl-c?', await waitStop(prev, 30));

  // (5) 리사이즈
  cols = 80; rows = 30; p.resize(cols, rows); term.resize(cols, rows); await sleep(2000); dump('after resize 80x30');

  // (6) /clear → SessionStart(source=clear) + additionalContext 재주입 확인
  prev = stopCount;
  type('/clear' + CR); await sleep(4000);
  type('한 줄로 인사해줘.'); await sleep(300); type(CR);
  log('stop after clear?', await waitStop(prev, 60)); dump('after /clear + greeting');

  type('/exit' + CR); await sleep(2000); finish();
})();

function finish() {
  if (finish.done) return; finish.done = true;
  fs.writeFileSync(path.join(__dirname, 'hooklog-2.json'), JSON.stringify(hookLog, null, 2));
  log('hook events:', hookLog.map((h) => h.ev + (h.payload && h.payload.source ? ':' + h.payload.source : '')).join(','));
  try { p.kill(); } catch {}
  server.close(); setTimeout(() => process.exit(0), 500);
}
