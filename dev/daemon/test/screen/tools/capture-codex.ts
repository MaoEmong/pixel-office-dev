// Codex 0.154 실측 캡처 시나리오(T21): READY → 작업 중 → Ctrl+C 중단 → 승인 프롬프트(거부) → Ctrl+C×2 종료.
// 실행: cd dev/daemon && npx tsx test/screen/tools/capture-codex.ts [cwd]
//   - cwd 는 이미 신뢰된(~/.codex/config.toml projects.*.trust_level) 폴더여야 하고 .codex/hooks.json 이 없어야
//     승인이 hook 이 아닌 TUI 프롬프트로 뜬다. 기본값은 $CODEX_CAPTURE_CWD 또는 인자.
//   - 산출물: test/screen/fixtures/codex/*.txt, 프레임 로그는 $CODEX_CAPTURE_LOG(기본 tools/.capture-codex.log).
import fs from 'node:fs';
import path from 'node:path';
import { Capture, CR, CTRL_C, ESC, sleep } from './capture.js';

const CODEX_EXE =
  process.env.PIXEL_CODEX_EXE ||
  'C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const cwd = path.resolve(process.argv[2] || process.env.CODEX_CAPTURE_CWD || process.cwd());
const frameLog = process.env.CODEX_CAPTURE_LOG || path.resolve(import.meta.dirname, '.capture-codex.log');
const outside = path.join(path.dirname(cwd), 'x.txt'); // 승인 프롬프트를 띄우기 위한 workspace 밖 파일

const model = process.env.CODEX_MODEL; // 예: gpt-5.6-luna (gpt-6-astra 사용량 한도에 걸렸을 때)
const cap = new Capture({
  engine: 'codex',
  file: CODEX_EXE,
  args: [
    '--dangerously-bypass-hook-trust',
    '-c',
    'approval_policy="on-request"',
    '-c',
    'sandbox_mode="workspace-write"',
    ...(model ? ['-c', `model="${model}"`] : []),
    // ChatGPT 계정 사용량 한도에 걸렸을 때 env 의 OPENAI_API_KEY 로 우회(이번 실행에만 적용, auth.json 은 안 건드림)
    ...(process.env.CODEX_AUTH === 'apikey' ? ['-c', 'preferred_auth_method="apikey"'] : []),
  ],
  cwd,
  frameLog,
});

const APPROVAL_RX = /approv|allow|permission|Yes|승인|허용|\(y\)|\by\b.*\bn\b/i;
const LOADING_RX = /model:\s+loading/;
const USAGE_LIMIT_RX = /hit your usage limit/;
const SWITCH_OFFER_RX = /Switch to gpt-\S+ for lower credit usage/;

/** 사용량 한도 안내 다이얼로그("Switch to gpt-5.6-luna…")가 뜨면 캡처하고 esc 로 닫는다. */
async function handleSwitchOffer(): Promise<boolean> {
  if (!SWITCH_OFFER_RX.test(cap.frame())) return false;
  cap.save('codex/model-switch-offer.txt');
  cap.type(ESC, 'esc (model switch offer → go back)');
  await sleep(1000);
  cap.save('codex/model-switch-offer-after-esc.txt');
  return true;
}

/** 작업이 끝나 READY 로 돌아올 때까지. 중간에 모델 전환 제안이 뜨면 esc 로 닫는다. */
async function waitReady(timeoutMs: number, label: string): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (cap.exited) return false;
    await handleSwitchOffer();
    if (cap.sm.promptReady()) {
      cap.log(`OK ${label}`);
      return true;
    }
    await sleep(200);
  }
  cap.log(`TIMEOUT ${label}`);
  return false;
}

async function main() {
  // 1. 부팅: 'model: loading' 동안은 프롬프트가 보여도 Enter 가 먹지 않는다(1차 실측) → 상태줄(model · cwd)이 뜰 때까지 기다린다.
  const booted = await cap.waitFor((sm, t) => LOADING_RX.test(t) || sm.promptReady() || sm.detectDialog().kind !== 'none', 60_000, 'boot');
  if (!booted) throw new Error('codex did not reach READY');
  if (LOADING_RX.test(cap.frame())) cap.save('codex/boot-loading.txt');
  if (cap.sm.detectDialog().kind !== 'none') {
    cap.save('codex/trust-dialog.txt');
    cap.log('trust dialog shown → choosing "No, quit" (this cwd is not trusted; pick a trusted cwd)');
    cap.type('\x1b[B' + CR, 'down+enter');
    await cap.waitExit(5000);
    return;
  }
  await cap.waitFor((sm, t) => sm.promptReady() && !LOADING_RX.test(t), 60_000, 'model loaded');
  await cap.settle(1500, 15_000);
  cap.save('codex/ready.txt');

  // 2. 작업 중: 몇 초 걸리는 셸 명령
  cap.type('셸 명령 sleep 8 을 실행해줘', 'prompt(sleep 8)');
  await sleep(300);
  cap.type(CR, 'enter');
  await cap.waitFor((sm) => !sm.promptReady(), 30_000, 'left READY after submit');
  await sleep(1500);
  cap.save('codex/working-1.txt');
  await sleep(2500);
  cap.save('codex/working-2.txt');
  await sleep(4000);
  cap.save('codex/working-3.txt');
  await waitReady(180_000, 'READY after sleep 8');
  await cap.settle(1500, 10_000);
  cap.save('codex/after-stop.txt');
  if (USAGE_LIMIT_RX.test(cap.frame())) {
    cap.log('usage limit hit → no real work possible with this model; trying a fast interrupt inside the ~1s "Working" window');
    cap.save('codex/usage-limit.txt');
    // "• Working (0s • esc to interrupt)" 는 요청이 서버에 가 있는 ~1초 동안 뜬다 → 그 안에 Ctrl+C 를 넣으면 진짜 중단 화면이 나온다.
    for (let attempt = 1; attempt <= 3; attempt++) {
      cap.type('셸 명령 sleep 60 을 실행해줘', `prompt(sleep 60) attempt ${attempt}`);
      await sleep(300);
      cap.type(CR, 'enter');
      const busy = await cap.waitFor((sm) => sm.busyIndicator(), 15_000, 'busy visible', 15);
      if (!busy) continue;
      cap.type(CTRL_C, 'ctrl+c (fast)');
      await sleep(400);
      cap.save('codex/interrupted-1.txt');
      await sleep(1500);
      cap.save('codex/interrupted-2.txt');
      await waitReady(30_000, 'READY after fast interrupt');
      await cap.settle(1500, 10_000);
      cap.save('codex/interrupted-3.txt');
      if (cap.sm.interrupted() || /interrupted/i.test(cap.frame())) break;
      cap.log(`attempt ${attempt}: no interrupted text on screen`);
    }
    // 종료 확인: 1차 실측에서 빈 프롬프트에 Ctrl+C 한 번으로 바로 종료(exit 0)됐다 → 다시 확인
    cap.type(CTRL_C, 'ctrl+c (1)');
    await sleep(600);
    cap.save('codex/exit-1.txt');
    const one = await cap.waitExit(4000);
    cap.log(`exited after single ctrl+c: ${one}`);
    if (!one) {
      cap.type(CTRL_C, 'ctrl+c (2)');
      cap.log(`exited after second ctrl+c: ${await cap.waitExit(10_000)}`);
    }
    cap.save('codex/exit-2.txt');
    return;
  }

  // 3. 중단: 긴 명령 도중 Ctrl+C
  cap.type('셸 명령 sleep 60 을 실행해줘', 'prompt(sleep 60)');
  await sleep(300);
  cap.type(CR, 'enter');
  await cap.waitFor((sm) => !sm.promptReady(), 30_000, 'left READY after submit');
  // 실제로 명령이 돌기 시작할 때까지(스피너/상태줄) 조금 기다린 뒤 끊는다
  await cap.waitFor((sm, t) => sm.busyIndicator() || /sleep 60/.test(t), 60_000, 'working visible');
  await sleep(4000);
  cap.save('codex/working-4.txt');
  cap.type(CTRL_C, 'ctrl+c');
  await sleep(1000);
  cap.save('codex/interrupted-1.txt');
  await sleep(3000);
  cap.save('codex/interrupted-2.txt');
  await waitReady(60_000, 'READY after interrupt');
  await cap.settle(1500, 10_000);
  cap.save('codex/interrupted-3.txt');

  // 4. 승인 프롬프트: workspace 밖 쓰기(hook 수신자 없음 → TUI 프롬프트)
  try {
    fs.unlinkSync(outside);
  } catch {}
  cap.type('셸 명령 "echo x > ../x.txt" 실행', 'prompt(echo outside)');
  await sleep(300);
  cap.type(CR, 'enter');
  const got = await cap.waitFor((sm, t) => !sm.promptReady() && !sm.busyIndicator() && APPROVAL_RX.test(t.split('\n').slice(-15).join('\n')), 180_000, 'approval prompt');
  await cap.settle(1500, 10_000);
  cap.save('codex/approval-prompt.txt');
  if (got) {
    cap.type(ESC, 'esc');
    await sleep(1500);
    cap.save('codex/approval-after-esc-1.txt');
    await waitReady(90_000, 'READY after decline');
    await cap.settle(1500, 10_000);
    cap.save('codex/approval-after-esc-2.txt');
  } else {
    await waitReady(60_000, 'READY (no approval prompt seen)');
  }
  if (fs.existsSync(outside)) {
    cap.log(`WARNING: ${outside} was created → deleting`);
    fs.unlinkSync(outside);
  }

  // 5. 종료: Ctrl+C ×2
  cap.type(CTRL_C, 'ctrl+c (1)');
  await sleep(1200);
  cap.save('codex/exit-1.txt');
  cap.type(CTRL_C, 'ctrl+c (2)');
  const exited = await cap.waitExit(15_000);
  cap.log(`exited=${exited}`);
  cap.save('codex/exit-2.txt');
}

main()
  .catch((e) => cap.log(`ERROR ${(e as Error).stack ?? e}`))
  .finally(async () => {
    await cap.close();
    try {
      if (fs.existsSync(outside)) fs.unlinkSync(outside);
    } catch {}
    process.exit(0);
  });
