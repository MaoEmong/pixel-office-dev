// hook 프로브: 어떤 셸/환경으로 실행되는지 기록하고, 페이로드를 데몬에 전달한 뒤 응답을 stdout으로 돌려준다
// 사용: node D:/.../hookprobe.js <PORT> <EVENT>
const fs = require('fs');
const path = require('path');
const http = require('http');
const [port, ev] = process.argv.slice(2);
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (body += c));
process.stdin.on('end', () => {
  const info = {
    ev, argv: process.argv.slice(2), cwd: process.cwd(), ppid: process.ppid,
    env: { PIXEL_MEMBER: process.env.PIXEL_MEMBER, COMSPEC: process.env.COMSPEC, SHELL: process.env.SHELL, PSModulePath: !!process.env.PSModulePath, MSYSTEM: process.env.MSYSTEM, TERM: process.env.TERM },
    bodyHead: body.slice(0, 200),
  };
  try { fs.appendFileSync(path.join(__dirname, 'probe.log'), JSON.stringify(info) + '\n'); } catch {}
  const member = process.env.PIXEL_MEMBER || 'unknown';
  const req = http.request({ host: '127.0.0.1', port: Number(port), path: `/hook/${member}/${ev}`, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    let out = ''; res.on('data', (c) => (out += c)); res.on('end', () => { process.stdout.write(out || '{}'); process.exit(0); });
  });
  req.on('error', () => { process.stdout.write('{}'); process.exit(0); });
  req.end(body);
});
