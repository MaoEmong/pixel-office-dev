// Claude Code 2.1 실측 캡처 시나리오(T21): READY → 허가 프롬프트(Bash, hook 미등록 → TUI) → ↓×3+Enter 로 거부 → Ctrl+C×2 종료.
// 실행: cd dev/daemon && npx tsx test/screen/tools/capture-claude.ts [cwd]
//   - cwd 는 이미 신뢰된(~/.claude.json projects.<cwd>.hasTrustDialogAccepted) 폴더. 기본 dev/spike-0/sandbox.
//   - `--settings` 를 주지 않으므로 세션 hooks 가 없다 → 허가는 CLI 자체 TUI 프롬프트로 뜬다(D-16 폴백 화면).
//   - 산출물: test/screen/fixtures/claude/*.txt, 프레임 로그는 $CLAUDE_CAPTURE_LOG(기본 tools/.capture-claude.log).
import fs from 'node:fs';
import path from 'node:path';
import { Capture, CR, CTRL_C, DOWN, sleep } from './capture.js';

const CLAUDE_EXE = process.env.PIXEL_CLAUDE_EXE || path.join(process.env.APPDATA ?? '', 'Claude', 'claude-code', '2.1.270', 'claude.exe');
const cwd = path.resolve(process.argv[2] || process.env.CLAUDE_CAPTURE_CWD || path.resolve(import.meta.dirname, '..', '..', '..', '..', 'spike-0', 'sandbox'));
const frameLog = process.env.CLAUDE_CAPTURE_LOG || path.resolve(import.meta.dirname, '.capture-claude.log');
const target = path.join(cwd, 't21-approval.txt');

const cap = new Capture({ engine: 'claude', file: CLAUDE_EXE, args: ['--permission-mode', 'default'], cwd, frameLog });

const APPROVAL_RX = /Do you want to proceed\?/;

/** 온보딩·신뢰 다이얼로그가 뜨면 ScreenModel 이 권하는 키로 통과(데몬과 같은 경로). */
async function passDialogs(timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && !cap.exited) {
    const d = cap.sm.detectDialog();
    if (d.kind === 'none') {
      if (cap.sm.promptReady()) return;
    } else if (d.suggestedKeys.length) {
      cap.save(`claude/dialog-${d.kind}.txt`);
      const seq = d.suggestedKeys.map((k) => ({ enter: CR, down: DOWN, up: '\x1b[A', esc: '\x1b' })[k]).join('');
      cap.type(seq, `dialog ${d.kind} → ${d.suggestedKeys.join('+')}`);
      await sleep(1500);
    }
    await sleep(300);
  }
}

async function main() {
  await passDialogs(90_000);
  if (!cap.sm.promptReady()) throw new Error('claude did not reach READY');
  await cap.settle(1500, 15_000);
  cap.save('claude/ready.txt');

  // 허가 프롬프트: default 모드에서 Bash 는 허가가 필요하다. hook 이 없으니 TUI 프롬프트가 뜬다.
  try {
    fs.unlinkSync(target);
  } catch {}
  cap.type('셸 명령 "echo x > t21-approval.txt" 를 실행해줘. 다른 건 하지 마.', 'prompt(bash needs approval)');
  await sleep(300);
  cap.type(CR, 'enter');
  await cap.waitFor((sm) => !sm.promptReady(), 30_000, 'left READY after submit');
  await sleep(2000);
  cap.save('claude/working.txt');
  const got = await cap.waitFor((sm, t) => APPROVAL_RX.test(t), 180_000, 'approval prompt');
  await cap.settle(1500, 10_000);
  cap.save('claude/approval-prompt.txt');
  if (got) {
    // ↓×3 → 'No' 강조 확인용 프레임 → Enter 로 거부
    cap.type(DOWN + DOWN + DOWN, 'down x3');
    await sleep(800);
    cap.save('claude/approval-prompt-no-highlighted.txt');
    cap.type(CR, 'enter (deny)');
    await sleep(2000);
    cap.save('claude/approval-after-deny-1.txt');
    await cap.waitFor((sm) => sm.promptReady(), 120_000, 'READY after deny');
    await cap.settle(2000, 15_000);
    cap.save('claude/approval-after-deny-2.txt');
  } else {
    await cap.waitFor((sm) => sm.promptReady(), 60_000, 'READY (no approval prompt seen)');
  }
  if (fs.existsSync(target)) {
    cap.log(`WARNING: ${target} was created → deleting`);
    fs.unlinkSync(target);
  }

  // 종료: Ctrl+C ×2
  cap.type(CTRL_C, 'ctrl+c (1)');
  await sleep(1200);
  cap.save('claude/exit-1.txt');
  cap.type(CTRL_C, 'ctrl+c (2)');
  const exited = await cap.waitExit(15_000);
  cap.log(`exited=${exited}`);
  cap.save('claude/exit-2.txt');
}

main()
  .catch((e) => cap.log(`ERROR ${(e as Error).stack ?? e}`))
  .finally(async () => {
    await cap.close();
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } catch {}
    process.exit(0);
  });
