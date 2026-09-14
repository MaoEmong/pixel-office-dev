// pixel-office hook 스크립트.
// CLI(claude / codex)의 hooks 설정에서 `node <슬래시경로>/hook.js <port> <event>` 로 실행된다.
//   stdin(JSON 페이로드) → POST http://127.0.0.1:<port>/hook/<PIXEL_MEMBER>/<event> → 응답 본문을 stdout 에 그대로 출력.
// 실패·연결 타임아웃 시엔 '{}'(결정 없음 = pass-through) 를 출력하고 항상 exit 0. 외부 의존성 없음.
// 멤버 식별은 스폰 시 넣어 준 PIXEL_MEMBER 환경변수(hook 이 부모 env 를 상속 — 02 §④).
//
// 주의: 데몬 패키지가 "type":"module" 이라 이 .js 는 ESM 으로 실행될 수 있다(require 없음).
//       CommonJS 로 실행되든 ESM 으로 실행되든 돌아가도록 process.getBuiltinModule 로 폴백한다(Node 22.3+).
'use strict';

const http = typeof require === 'function' ? require('http') : process.getBuiltinModule('http');

const CONNECT_TIMEOUT_MS = 2000; // 데몬이 죽어 있으면 이 안에 '{}' 를 찍고 나간다
const [portArg, eventArg] = process.argv.slice(2);
const port = Number(portArg);
const event = eventArg || 'Unknown';
const member = process.env.PIXEL_MEMBER || 'unknown';

let finished = false;
// 응답을 stdout 에 쓰고 종료. 어떤 경로로 와도 exit 0 (hook 실패로 CLI 가 도구를 막는 일이 없게).
function finish(out) {
  if (finished) return;
  finished = true;
  const body = out && out.length ? out : '{}';
  process.stdout.write(body, () => process.exit(0));
}

if (!Number.isInteger(port) || port <= 0) {
  // 인자가 잘못됐어도 CLI 는 계속 가야 한다
  finish('{}');
} else {
  let body = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (body += c));
  process.stdin.on('error', () => send(body));
  process.stdin.on('end', () => send(body));
}

function send(payload) {
  if (finished) return;
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: `/hook/${encodeURIComponent(member)}/${encodeURIComponent(event)}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      agent: false, // keep-alive 없이 1회용 소켓
    },
    (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (out += c));
      res.on('end', () => finish(out));
      res.on('error', () => finish('{}'));
      res.on('aborted', () => finish('{}'));
    },
  );

  // 연결 단계에만 타임아웃. 연결된 뒤에는 데몬이 사용자 응답을 기다리며 오래(수 시간) 붙들 수 있으므로 idle 타임아웃을 두지 않는다.
  req.on('socket', (socket) => {
    if (!socket.connecting) return;
    const timer = setTimeout(() => req.destroy(new Error('connect timeout')), CONNECT_TIMEOUT_MS);
    socket.once('connect', () => clearTimeout(timer));
    socket.once('error', () => clearTimeout(timer));
    socket.once('close', () => clearTimeout(timer));
  });
  req.on('error', () => finish('{}')); // ECONNREFUSED, 타임아웃, 소켓 끊김 등 전부 pass-through
  req.end(payload);
}
