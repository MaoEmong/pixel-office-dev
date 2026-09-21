// pixel-office statusLine 스크립트 (T43, D-45 ②).
// Claude 세션 설정의 `statusLine{type:'command'}` 에서 `node <슬래시경로>/statusline.js <port>` 로 실행된다.
//   stdin(JSON 페이로드) → POST http://127.0.0.1:<port>/status/<PIXEL_MEMBER> → 응답 본문을 stdout 에 그대로 출력.
// 응답이 곧 터미널 하단에 찍히는 한 줄이다(예: `컨텍스트 37% · 주간 45% 남음`).
//
// hook.js 와 같은 방식이지만 **실패 규약이 다르다**: 실패하면 `'{}'` 가 아니라 **빈 줄**을 찍고 곧바로 exit 0.
// 이건 CLI 가 화면을 다시 그릴 때마다 부르는 스크립트라 **절대 붙들고 있으면 안 된다** — 데몬이 죽었거나
// 느리면 상태줄이 아니라 TUI 전체가 멈춘 것처럼 보인다. 그래서 연결 타임아웃(1.5초)과 전체 상한(3초)을
// 둘 다 건다. 멤버 식별은 스폰 때 넣어 준 PIXEL_MEMBER(D-03).
//
// 주의: 데몬 패키지가 "type":"module" 이라 이 .js 는 ESM 으로 실행될 수 있다(require 없음).
'use strict';

const http = typeof require === 'function' ? require('http') : process.getBuiltinModule('http');

/** 데몬이 안 떠 있으면 이 안에 빈 줄을 찍고 나간다. */
const CONNECT_TIMEOUT_MS = 1500;
/** 연결이 됐어도 이 시간을 넘기면 포기한다 — 상태줄은 기다려 주는 자리가 아니다. */
const TOTAL_TIMEOUT_MS = 3000;

const port = Number(process.argv[2]);
const member = process.env.PIXEL_MEMBER || 'unknown';

let finished = false;
let overall;

/** 한 줄을 stdout 에 쓰고 종료. 어떤 경로로 와도 exit 0. */
function finish(out) {
  if (finished) return;
  finished = true;
  if (overall) clearTimeout(overall);
  const text = typeof out === 'string' ? out.replace(/[\r\n]+$/, '') : '';
  process.stdout.write(text + '\n', () => process.exit(0));
}

if (!Number.isInteger(port) || port <= 0) {
  finish('');
} else {
  overall = setTimeout(() => finish(''), TOTAL_TIMEOUT_MS);
  if (typeof overall.unref === 'function') overall.unref();
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
      path: `/status/${encodeURIComponent(member)}`,
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
      res.on('end', () => finish(res.statusCode === 200 ? out : ''));
      res.on('error', () => finish(''));
      res.on('aborted', () => finish(''));
    },
  );

  req.on('socket', (socket) => {
    if (!socket.connecting) return;
    const timer = setTimeout(() => req.destroy(new Error('connect timeout')), CONNECT_TIMEOUT_MS);
    socket.once('connect', () => clearTimeout(timer));
    socket.once('error', () => clearTimeout(timer));
    socket.once('close', () => clearTimeout(timer));
  });
  req.on('error', () => finish('')); // ECONNREFUSED · 타임아웃 · 소켓 끊김
  req.end(payload);
}
