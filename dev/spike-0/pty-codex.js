// 실측 ④: codex CLI(TUI)를 pty로 띄우고 프로젝트 .codex/hooks.json + env로 멤버 식별, 승인 hook 결정 반환, 세션 id
const pty = require('node-pty');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Terminal } = require('@xterm/headless');

const CODEX = process.env.CODEX_EXE || 'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const SANDBOX = path.join(__dirname, 'sandbox');
const HOOK_PORT = 7422;
const PROMPT = process.argv[2] || '셸 명령 "echo hi > hello2.txt"를 실행해서 hello2.txt를 만들어줘. 다른 건 하지 마.';
fs.mkdirSync(path.join(SANDBOX, '.codex'), { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CR = String.fromCharCode(13);
const ESC = String.fromCharCode(27);

// ---- hook receiver: URL에 멤버 토큰 (hook 명령이 $PIXEL_MEMBER 환경변수를 씀) --------------
const hookLog = [];
let stopCount = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const [, , member, ev] = req.url.split('/'); // /hook/<member>/<event>
    let payload = null; try { payload = JSON.parse(body); } catch { payload = body; }
    hookLog.push({ ev, member, payload, at: Date.now() });
    if (ev === 'Stop') stopCount++;
    const brief = payload && typeof payload === 'object'
      ? { member, sid: payload.session_id, source: payload.source, tool: payload.tool_name, input: payload.tool_input && JSON.stringify(payload.tool_input).slice(0, 120), last: payload.last_assistant_message && String(payload.last_assistant_message).slice(0, 60), keys: Object.keys(payload).join(',') }
      : { member, payload };
    log(`HOOK ${ev}`, JSON.stringify(brief));
    res.setHeader('content-type', 'application/json');
    if (ev === 'PermissionRequest') {
      setTimeout(() => { res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })); log('HOOK PermissionRequest -> allow after 3s'); }, 3000);
      return;
    }
    if (ev === 'SessionStart') {
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '[ROLE] 너는 픽셀오피스 실측용 팀원 "코덱스"다. 답변 첫 줄에 반드시 "[코덱스 팀원]"을 붙여라.' } }));
      return;
    }
    res.end('{}');
  });
});
server.listen(HOOK_PORT, '127.0.0.1');

// 실측 2회차: bash 경로(/c/Windows/...)+$VAR 형식은 "hook exited with code 1" → Codex는 bash가 아닌 셸로 실행하는 듯.
// 어느 셸인지 알기 위해 같은 이벤트에 세 가지 문법을 동시에 건다: plain / cmd(%VAR%) / powershell($env:VAR)
// 3회차: curl.exe 세 문법 전부 exit 1 → 셸 문제가 아니라 curl 자체가 실패. 어떤 환경인지 node 프로브 스크립트로 기록한다 (경로는 슬래시: cmd/ps/bash 공통)
const probe = path.join(__dirname, 'hookprobe.js').split('\\').join('/');
try { fs.unlinkSync(path.join(__dirname, 'probe.log')); } catch {}
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd'];
const hooks = {};
for (const ev of events) hooks[ev] = [{ hooks: [{ type: 'command', command: `node ${probe} ${HOOK_PORT} ${ev}`, timeout: 600 }] }];
fs.writeFileSync(path.join(SANDBOX, '.codex', 'hooks.json'), JSON.stringify({ description: 'pixel-office spike', hooks }, null, 2));

// ---- pty ----------------------------------------------------------------------
const cols = 120, rows = 40;
const term = new Terminal({ cols, rows, allowProposedApi: true });
const screen = () => { const L = []; const b = term.buffer.active; for (let i = 0; i < rows; i++) L.push(b.getLine(i)?.translateToString(true) ?? ''); while (L.length && !L[L.length - 1].trim()) L.pop(); return L.join('\n'); };
const env = { PIXEL_MEMBER: 'm-codex-1' };
for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE_?CODE|^CLAUDECODE|^CLAUDE_CONFIG_DIR$/i.test(k)) env[k] = v;
// 실측: approval_policy="untrusted" 는 0.154.0에서 제거됨("no longer supported") → on-request 사용
// 실측: exec 스모크에서 "Not inside a trusted directory" → 프로젝트 신뢰를 -c 로 주입 (TOML 문자열 안의 백슬래시는 이스케이프)
const trustKey = 'projects."' + SANDBOX.split('\\').join('\\\\') + '".trust_level="trusted"';
const args = ['--dangerously-bypass-hook-trust', '-c', `approval_policy="${process.env.APPROVAL || 'on-request'}"`, '-c', 'sandbox_mode="workspace-write"', '-c', trustKey];
if (process.env.RESUME_ID) args.unshift('resume', process.env.RESUME_ID); // 실측: codex resume <id> 로 재개 → SessionStart(source=resume)?
log('spawn', CODEX, args.join(' '));
const p = pty.spawn(CODEX, args, { name: 'xterm-256color', cols, rows, cwd: SANDBOX, env });
log('pid', p.pid);
let raw = 0; p.onData((d) => { raw += d.length; term.write(d); });
p.onExit((e) => { log('EXIT', JSON.stringify(e)); dump('at exit'); finish(); });
const type = (s) => { log('TYPE', JSON.stringify(s).slice(0, 120)); p.write(s); };
const dump = (tag) => { log(`--- SCREEN ${tag} (raw=${raw}) ---\n` + screen() + '\n--- END ---'); };

(async () => {
  // 실측: 첫 실행에 "Do you trust the contents of this directory?" (› 1. Yes, continue) → Enter. -c projects.*.trust_level 주입은 효과 없었음.
  let lastRaw = -1;
  for (let k = 0; k < 20; k++) {
    await sleep(2000); const sc = screen();
    if (/Do you trust|Press enter to continue/i.test(sc)) { type(CR); await sleep(1500); dump('after trust Enter'); continue; }
    if (/\? for shortcuts|Ctrl\+C|\/status|›\s*$|›\s+\S/m.test(sc) && raw === lastRaw) { dump('READY?'); break; }
    lastRaw = raw; if (k % 3 === 0) dump(`boot k=${k}`);
  }
  type(PROMPT); await sleep(300); type(CR);
  for (let i = 0; i < 120 && stopCount === 0; i++) { await sleep(1000); if (i % 15 === 14) dump(`t+${i + 1}s`); }
  await sleep(2000); dump('after Stop');
  log('hello2.txt exists?', fs.existsSync(path.join(SANDBOX, 'hello2.txt')));
  type('/quit' + CR); await sleep(2000); type(String.fromCharCode(3)); type(String.fromCharCode(3)); await sleep(1500);
  finish();
})();

function finish() {
  if (finish.done) return; finish.done = true;
  fs.writeFileSync(path.join(__dirname, 'hooklog-codex.json'), JSON.stringify(hookLog, null, 2));
  log('hook events:', hookLog.map((h) => h.ev + (h.payload && h.payload.source ? ':' + h.payload.source : '')).join(','));
  try { p.kill(); } catch {}
  server.close(); setTimeout(() => process.exit(0), 500);
}
