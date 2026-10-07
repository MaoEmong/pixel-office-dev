// Codex 0.159 실측 캡처(T49): **신뢰 안 된 폴더**의 "Folder access" 모달 + 그 뒤의 READY·작업 중·/status.
//
// 왜 별도 도구인가: `capture-codex.ts` 는 **이미 신뢰된 cwd** 를 전제한다(승인이 hook 이 아닌 TUI 로 뜨게 하려고).
// 0.159 의 신뢰 모달은 그 전제에서는 절대 뜨지 않는데, 이 모달이 T49 의 원인이었다(D-49) — 그래서 신뢰 안 된
// 폴더로 띄우는 시나리오를 따로 둔다.
//
// 실행: cd dev/daemon && npx tsx test/screen/tools/capture-codex-trust.ts [cwd]
//   - cwd 는 **아직 신뢰되지 않은** 새 폴더여야 한다(기본: 새 임시 폴더). 캡처가 끝나면 그 폴더는 신뢰 목록
//     (`~/.codex/config.toml` 의 `[projects."…"]`)에 남는다 — 같은 폴더로 두 번 돌리면 모달이 안 뜬다.
//   - 산출물: test/screen/fixtures/codex-0.159/*.txt, 프레임 로그는 $CODEX_CAPTURE_LOG.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Capture, CR, DOWN, ESC, FIXTURES_DIR, UP, sleep } from './capture.js';

const CODEX_EXE = process.env.PIXEL_CODEX_EXE || 'codex';
const cwd = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust-capture-')));
const frameLog = process.env.CODEX_CAPTURE_LOG || path.resolve(import.meta.dirname, '.capture-codex-trust.log');
const OUT = 'codex-0.159';

fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(cwd, 'README.md'), '# codex trust capture\n');

// 데몬이 실제로 쓰는 인자 그대로(dev/daemon/src/pty/args.ts) — hooks.json 은 일부러 두지 않는다.
const cap = new Capture({
  engine: 'codex',
  file: CODEX_EXE,
  args: ['--dangerously-bypass-hook-trust', '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"'],
  cwd,
  frameLog,
});

const TRUST_RX = /Trust this folder\?/;

/**
 * 스크롤백까지 담아 저장한다(/status 패널은 인라인 렌더라 뷰포트만 보면 잘린다 — T43-0 Q7).
 * 경로는 FIXTURES_DIR 기준이다 — 사용량 화면은 `test/fixtures/usage/screens/` 에 모여 있으므로 거기로 올라간다.
 */
function saveFull(name: string): void {
  const file = path.join(FIXTURES_DIR, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = cap.sm
    .fullText()
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
  fs.writeFileSync(file, text + '\n', 'utf8');
  cap.log(`SAVED(full) ${name} (${text.split('\n').length} lines)`);
}

async function main() {
  // 1. 모달은 **READY 뒤에 뒤늦게** 뜬다(D-49 ①) — promptReady 로는 기다릴 수 없다. 문구로 기다린다.
  const shown = await cap.waitFor((_sm, t) => TRUST_RX.test(t), 90_000, 'folder-access modal');
  if (!shown) throw new Error('신뢰 모달이 뜨지 않았다 — cwd 가 이미 신뢰된 폴더일 수 있다');
  await cap.settle(1000, 10_000);
  cap.save(`${OUT}/trust-dialog.txt`); // "1. Trust and continue" 강조

  cap.type(DOWN, 'down (→ 2번 항목 강조)');
  await sleep(800);
  cap.save(`${OUT}/trust-dialog-second.txt`);

  cap.type(UP, 'up (→ 1번 항목으로 되돌림)');
  await sleep(800);
  cap.type(CR, 'enter (Trust and continue)');

  // 2. 모달이 사라진 뒤의 READY
  const ready = await cap.waitFor((sm, t) => !TRUST_RX.test(t) && sm.promptReady(), 60_000, 'READY after trust');
  if (!ready) throw new Error('신뢰 뒤 READY 로 가지 않았다');
  await cap.settle(1500, 15_000);
  cap.save(`${OUT}/ready.txt`);

  // 3. 제출이 되는지 + 작업 중 화면
  cap.type('\x1b[200~Reply with exactly the word PONG and nothing else.\x1b[201~', 'paste(prompt)');
  await sleep(400);
  cap.type(CR, 'enter');
  const busy = await cap.waitFor((sm) => sm.busyIndicator(), 30_000, 'busy after submit');
  if (busy) cap.save(`${OUT}/working.txt`);
  else cap.log('WARNING 제출됐는데 busy 화면을 못 잡았다(너무 빨랐을 수 있다)');
  await cap.waitFor((sm) => sm.promptReady(), 120_000, 'READY after turn');
  await cap.settle(1500, 15_000);
  cap.save(`${OUT}/after-stop.txt`);

  // 4. /status 사용량 화면(붙여넣기 없이 그대로 타이핑 — usage 맵 규칙)
  cap.type('/status', 'type(/status)');
  await sleep(600);
  cap.type(CR, 'enter');
  await sleep(4000);
  await cap.settle(1500, 20_000);
  saveFull('../../fixtures/usage/screens/codex-0.159-status.txt'); // 사용량 화면은 usage 픽스처 쪽에 모은다
  cap.type(ESC, 'esc (close /status)');
  await sleep(1000);
}

main()
  .catch((e) => cap.log(`ERROR ${(e as Error).stack ?? e}`))
  .finally(async () => {
    cap.log(`cwd=${cwd} (신뢰 목록에 남는다)`); // close() 가 로그 fd 를 닫으므로 그 전에 적는다
    await cap.close();
    process.exit(0);
  });
