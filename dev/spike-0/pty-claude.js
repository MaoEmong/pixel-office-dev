// 실측 ①②③: node-pty로 claude.exe 띄우기 + --settings로 세션 단위 hooks 주입 + headless xterm 화면 재구성
// 실행: node pty-claude.js [prompt]
const pty = require('node-pty');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const CLAUDE = process.env.CLAUDE_EXE || path.join(process.env.APPDATA, 'Claude', 'claude-code', '2.1.270', 'claude.exe');
const SANDBOX = path.join(__dirname, 'sandbox');
const HOOK_PORT = 7421;
const PROMPT = process.argv[2] || '셸 명령 "rm hello.txt"를 실행해서 hello.txt를 지워줘. 그 다음 "echo hi > hello.txt"로 다시 만들어줘. 다른 건 하지 마.';
fs.mkdirSync(SANDBOX, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- hook receiver -------------------------------------------------------
const hookLog = [];
let stopSeen = false;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const ev = req.url.split('/').pop();
    let payload = null;
    try { payload = JSON.parse(body); } catch { payload = body; }
    hookLog.push({ ev, payload, at: Date.now() });
    if (ev === 'Stop') stopSeen = true;
    const brief = payload && typeof payload === 'object'
      ? { session_id: payload.session_id, source: payload.source, tool: payload.tool_name, input: payload.tool_input && JSON.stringify(payload.tool_input).slice(0, 80), msg: payload.message, last: payload.last_assistant_message && String(payload.last_assistant_message).slice(0, 80), keys: Object.keys(payload).join(',') }
      : payload;
    log(`HOOK ${ev}`, JSON.stringify(brief));
    res.setHeader('content-type', 'application/json');
    if (ev === 'PermissionRequest') {
      // 실측: hook 결정 반환이 TUI 프롬프트를 대체하는지. 3초 보류 후 allow.
      setTimeout(() => {
        res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }));
        log('HOOK PermissionRequest -> replied allow after 3s');
      }, 3000);
      return;
    }
    if (ev === 'SessionStart') {
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '[ROLE] 너는 픽셀오피스 실측용 팀원 "테스트"다. 답변 첫 줄에 반드시 "[테스트 팀원]"을 붙여라.' } }));
      return;
    }
    res.end('{}');
  });
});
server.listen(HOOK_PORT, '127.0.0.1');

// ---- session settings (hooks only for this session) -----------------------
// 실측 결과: Windows에서 hook 명령은 /usr/bin/bash(git bash)로 실행된다 → POSIX 경로 사용
const curl = '/c/Windows/System32/curl.exe';
const hookCmd = (ev) => `${curl} -s -X POST --data-binary @- http://127.0.0.1:${HOOK_PORT}/hook/${ev}`;
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification', 'Stop', 'SubagentStop', 'PreCompact', 'SessionEnd'];
const hooks = {};
for (const ev of events) hooks[ev] = [{ hooks: [{ type: 'command', command: hookCmd(ev), timeout: 600 }] }];
const settingsPath = path.join(__dirname, 'session-settings.json');
fs.writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));

// ---- pty + headless screen -------------------------------------------------
const cols = 120, rows = 40;
const term = new Terminal({ cols, rows, allowProposedApi: true });
const ser = new SerializeAddon();
term.loadAddon(ser);
const screen = () => {
  const lines = [];
  const buf = term.buffer.active;
  for (let i = 0; i < rows; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
};

log('spawn', CLAUDE, 'cwd', SANDBOX);
// 실측 결과: 부모(이 Claude Code 세션)의 CLAUDE_CODE_* 환경변수가 상속되면 "/rc active", "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION" 이 뜬다 → 데몬은 env를 정리해야 한다
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE_?CODE|^CLAUDECODE|^CLAUDE_CONFIG_DIR$/i.test(k)) env[k] = v;
const args = ['--settings', settingsPath, '--permission-mode', process.env.PERM_MODE || 'default', ...JSON.parse(process.env.CLAUDE_ARGS_EXTRA || '[]')];
const p = pty.spawn(CLAUDE, args, { name: 'xterm-256color', cols, rows, cwd: SANDBOX, env });
log('pid', p.pid);
let raw = 0;
p.onData((d) => { raw += d.length; term.write(d); });
p.onExit((e) => { log('EXIT', JSON.stringify(e)); finish(); });

const CR = String.fromCharCode(13);
const type = (s) => { log('TYPE', JSON.stringify(s)); p.write(s); };
const dump = (tag) => { log(`--- SCREEN ${tag} (raw=${raw}) ---\n` + screen() + '\n--- END ---'); };

// 실측 결과: 준비된 입력 프롬프트 화면의 하단에는 "(shift+tab to cycle)" 또는 "? for shortcuts" 가 있다
const READY_RE = /shift\+tab to cycle|\? for shortcuts|Try "|\/help for help/i;
const ENTER_RE = /❯|Press Enter|Enter to continue|Enter to confirm/i;

(async () => {
  // 온보딩/로그인/신뢰 화면을 Enter로 통과하고, 입력 프롬프트가 보일 때까지 대기 (최대 60s)
  let ready = false;
  for (let k = 0; k < 30; k++) {
    await sleep(2000);
    const sc = screen();
    if (READY_RE.test(sc)) { ready = true; dump('READY'); break; }
    if (/trust this folder/i.test(sc)) { const b = raw; type('\x1b[B'); await sleep(300); type(CR); await sleep(1500); dump(`after Down+Enter on trust dialog (k=${k}, raw delta=${raw - b})`); continue; }
    if (ENTER_RE.test(sc)) { const b = raw; type(CR); await sleep(1500); dump(`after Enter (k=${k}, raw delta=${raw - b})`); }
    else if (k % 3 === 2) dump(`waiting k=${k}`);
  }
  if (!ready) dump('NOT READY after 60s');
  type(PROMPT); await sleep(500); type(CR);
  for (let i = 0; i < 90 && !stopSeen; i++) { await sleep(1000); if (i % 10 === 9) dump(`t+${i + 1}s`); }
  await sleep(2000); dump('after Stop');
  log('hello.txt exists?', fs.existsSync(path.join(SANDBOX, 'hello.txt')));
  type('/exit' + CR); await sleep(2000);
  finish();
})();

function finish() {
  if (finish.done) return; finish.done = true;
  fs.writeFileSync(path.join(__dirname, 'hooklog.json'), JSON.stringify(hookLog, null, 2));
  fs.writeFileSync(path.join(__dirname, 'screen.serialized.txt'), ser.serialize());
  log('hook events:', hookLog.map((h) => h.ev).join(','));
  try { p.kill(); } catch {}
  server.close();
  setTimeout(() => process.exit(0), 500);
}
