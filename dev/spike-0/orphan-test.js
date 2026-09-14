// 실측: 부모(node) 프로세스가 죽어도 ConPTY 자식(claude.exe)이 살아남는지
// 사용법: node orphan-test.js  → PID 출력 후 5초 뒤 부모가 process.exit(0) (kill 안 함). 이후 tasklist로 PID 확인.
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const CLAUDE = process.env.CLAUDE_EXE || path.join(process.env.APPDATA, 'Claude', 'claude-code', '2.1.270', 'claude.exe');
const SANDBOX = path.join(__dirname, 'sandbox');
const env = {}; for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE_?CODE|^CLAUDECODE|^CLAUDE_CONFIG_DIR$/i.test(k)) env[k] = v;
const p = pty.spawn(CLAUDE, ['--permission-mode', 'default'], { name: 'xterm-256color', cols: 100, rows: 30, cwd: SANDBOX, env });
fs.writeFileSync(path.join(__dirname, 'orphan.pid'), String(p.pid));
console.log('child pid', p.pid, '- parent exits in 5s without kill');
p.onData(() => {});
setTimeout(() => process.exit(0), 5000);
