// statusLine 명령으로 등록되는 작은 스크립트.
// Claude Code 가 stdin 으로 JSON 을 넣어 주면 그대로 out/statusline.jsonl 에 한 줄씩 적고,
// 화면에 뿌릴 한 줄을 stdout 으로 돌려준다(빈 문자열이면 statusLine 이 안 그려질 수 있어 짧게 출력).
const fs = require('fs');
const path = require('path');
const OUT = process.argv[2] || path.join(__dirname, 'out', 'statusline.jsonl');
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (body += c));
process.stdin.on('end', () => {
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.appendFileSync(OUT, JSON.stringify({ at: Date.now(), iso: new Date().toISOString(), raw: body }) + '\n');
  } catch {}
  process.stdout.write('PIXEL-STATUSLINE');
});
