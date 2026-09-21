// 스파이크 로그(dev/spike-0/run*.log, run-codex*.log)에서 복사한 실제 화면(fixtures/*.txt)으로
// promptReady / detectDialog / lastNonEmptyLine / busyIndicator / interrupted 를 화면별로 검사한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenFrom } from './helpers.js';
import { ScreenModel } from '../../src/screen/ScreenModel.js';

// ---- Claude 온보딩·첫 실행 다이얼로그 (run3/run4/run5) ---------------------------------------

test('claude: onboarding theme picker → onboarding-enter, enter', async () => {
  const sm = await screenFrom('claude', 'claude-onboarding-theme.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'onboarding-enter', suggestedKeys: ['enter'], highlightDriven: false });
  assert.equal(sm.promptReady(), false);
  assert.equal(sm.interrupted(), false);
  assert.equal(sm.busyIndicator(), false);
  // 마지막 줄: 하단 괘선(╌)은 건너뛰고 미리보기 안내줄
  assert.equal(sm.lastNonEmptyLine(), 'Syntax theme: Monokai Extended (ctrl+t to disable)');
  sm.dispose();
});

test('claude: login method menu → login-menu, enter', async () => {
  const sm = await screenFrom('claude', 'claude-login-menu.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'login-menu', suggestedKeys: ['enter'], highlightDriven: false });
  assert.equal(sm.promptReady(), false);
  assert.equal(sm.lastNonEmptyLine(), '3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI');
  sm.dispose();
});

test('claude: security notes → security-notes, enter', async () => {
  const sm = await screenFrom('claude', 'claude-security-notes.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'security-notes', suggestedKeys: ['enter'], highlightDriven: false });
  assert.equal(sm.promptReady(), false);
  assert.equal(sm.lastNonEmptyLine(), 'Press Enter to continue…');
  sm.dispose();
});

test('claude: trust dialog with "No, exit" highlighted → trust-folder-claude, down+enter', async () => {
  const sm = await screenFrom('claude', 'claude-trust-dialog.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'trust-folder-claude', suggestedKeys: ['down', 'enter'], highlightDriven: true });
  assert.equal(sm.promptReady(), false);
  assert.equal(sm.busyIndicator(), false);
  // '❯ No, exit' 는 입력 상자가 아니다(윗줄이 괘선이 아님) → 마지막 줄은 안내문
  assert.equal(sm.lastNonEmptyLine(), 'Enter to confirm · Esc to cancel');
  sm.dispose();
});

test('claude: trust dialog with "Yes, I trust this folder" highlighted → enter only', async () => {
  const sm = await screenFrom('claude', 'claude-trust-dialog.txt');
  // 실제로 ↓ 를 누른 뒤의 화면: 강조 마커가 두 번째 항목으로 이동
  await sm.feed('\x1b[14;1H\x1b[2K   No, exit\x1b[15;1H\x1b[2K ❯ Yes, I trust this folder');
  assert.deepEqual(sm.detectDialog(), { kind: 'trust-folder-claude', suggestedKeys: ['enter'], highlightDriven: true });
  sm.dispose();
});

test('claude: fullscreen renderer offer → onboarding-enter, enter (run8)', async () => {
  const sm = await screenFrom('claude', 'claude-fullscreen-renderer.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'onboarding-enter', suggestedKeys: ['enter'], highlightDriven: false });
  assert.equal(sm.promptReady(), false);
  sm.dispose();
});

// ---- Claude READY / 작업 중 / 중단 (run8/run9) -------------------------------------------------

test('claude: READY screen → promptReady, no dialog, last line skips rule/effort/status lines', async () => {
  const sm = await screenFrom('claude', 'claude-ready.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [], highlightDriven: false });
  assert.equal(sm.promptReady(), true);
  assert.equal(sm.busyIndicator(), false);
  assert.equal(sm.interrupted(), false);
  // 아래에서부터: 상태줄 → 괘선 → 입력상자 '❯ ' → 괘선 → '● high · /effort' → 빈 줄들 → '+2 more · /status'
  assert.equal(sm.lastNonEmptyLine(), '+2 more · /status');
  sm.dispose();
});

test('claude: READY screen with grey autosuggest text in the input box is still ready and ignored', async () => {
  const sm = await screenFrom('claude', 'claude-ready.txt');
  // 입력 상자에 회색 자동 제안(예: 이전 프롬프트)이 들어 있는 경우
  await sm.feed('\x1b[38;1H\x1b[2K❯ \x1b[90m셸 명령 "echo hi"를 실행해줘\x1b[0m');
  assert.match(sm.lines()[37], /^❯ 셸 명령/);
  assert.equal(sm.promptReady(), true);
  assert.equal(sm.lastNonEmptyLine(), '+2 more · /status');
  sm.dispose();
});

test('claude: working screen → busy, not ready, last line is the spinner', async () => {
  const sm = await screenFrom('claude', 'claude-working.txt');
  assert.equal(sm.busyIndicator(), true);
  assert.equal(sm.promptReady(), false);
  assert.equal(sm.interrupted(), false);
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [], highlightDriven: false });
  assert.equal(sm.lastNonEmptyLine(), '✢ Newspapering… (6s · ↓ 250 tokens)');
  sm.dispose();
});

test('claude: busy is detected from the spinner line alone (status line may lag)', async () => {
  const sm = await screenFrom('claude', 'claude-ready.txt');
  await sm.feed('\x1b[35;1H\x1b[2K✻ Cogitating… (2s · ↓ 10 tokens)');
  assert.equal(sm.busyIndicator(), true);
  assert.equal(sm.promptReady(), false);
  sm.dispose();
});

test('claude: "✻ Cogitated for 9s · done" is a completion marker, not busy', async () => {
  const sm = await screenFrom('claude', 'claude-interrupted.txt');
  assert.match(sm.text(), /✻ Cogitated for 9s · done/);
  assert.equal(sm.busyIndicator(), false);
  sm.dispose();
});

test('claude: Interrupted screen after ctrl-c → interrupted AND promptReady (no Stop hook, idle by screen)', async () => {
  const sm = await screenFrom('claude', 'claude-interrupted.txt');
  assert.equal(sm.interrupted(), true);
  assert.equal(sm.promptReady(), true);
  assert.equal(sm.busyIndicator(), false);
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [], highlightDriven: false });
  // 실제 화면은 '⎿' 뒤에 NBSP(U+00A0)가 섞여 있다 → \s 로 맞춘다
  assert.match(sm.lastNonEmptyLine(), /^⎿\s+Interrupted · What should Claude do instead\?$/u);
  sm.dispose();
});

test('claude: Interrupted screen at 80x30 (after resize in the spike) behaves the same', async () => {
  const sm = await screenFrom('claude', 'claude-interrupted-80x30.txt', { cols: 80, rows: 30 });
  assert.equal(sm.interrupted(), true);
  assert.equal(sm.promptReady(), true);
  assert.match(sm.lastNonEmptyLine(), /^⎿\s+Interrupted · What should Claude do instead\?$/u);
  sm.dispose();
});

test('claude: after Stop the answer text is the last line and the prompt is ready', async () => {
  const sm = await screenFrom('claude', 'claude-after-stop.txt');
  assert.equal(sm.promptReady(), true);
  assert.equal(sm.busyIndicator(), false);
  const last = sm.lastNonEmptyLine();
  assert.ok(last.length > 0);
  assert.doesNotMatch(last, /^[─╌]+$/);
  assert.doesNotMatch(last, /\? for shortcuts|\/effort/);
  sm.dispose();
});

// ---- Codex (run-codex2/3/5) ------------------------------------------------------------------

test('codex: trust dialog with "Yes, continue" highlighted → trust-folder-codex, enter', async () => {
  const sm = await screenFrom('codex', 'codex-trust-dialog.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'trust-folder-codex', suggestedKeys: ['enter'], highlightDriven: true });
  assert.equal(sm.promptReady(), false);
  assert.equal(sm.interrupted(), false);
  assert.equal(sm.lastNonEmptyLine(), 'Press enter to continue');
  sm.dispose();
});

test('codex: trust dialog with "No, quit" highlighted → up+enter', async () => {
  const sm = await screenFrom('codex', 'codex-trust-dialog.txt');
  await sm.feed('\x1b[6;1H\x1b[2K  1. Yes, continue\x1b[7;1H\x1b[2K› 2. No, quit');
  assert.deepEqual(sm.detectDialog(), { kind: 'trust-folder-codex', suggestedKeys: ['up', 'enter'], highlightDriven: true });
  sm.dispose();
});

test('codex: READY screen → promptReady via placeholder, no dialog', async () => {
  const sm = await screenFrom('codex', 'codex-ready.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [], highlightDriven: false });
  assert.equal(sm.promptReady(), true);
  assert.equal(sm.busyIndicator(), false);
  assert.equal(sm.interrupted(), false);
  // 입력줄 '› Ask Codex…' 과 그 아래 상태줄은 제외 → 마지막 경고 배너
  assert.match(sm.lastNonEmptyLine(), /^⚠ clamping Interrupt hook timeout/);
  sm.dispose();
});

test('codex: READY screen without the placeholder still counts as ready ("› " line + status line with " · ")', async () => {
  const sm = await screenFrom('codex', 'codex-ready.txt');
  // 사용자가 무언가 입력해 placeholder 가 사라진 상태
  await sm.feed('\x1b[22;1H\x1b[2K› hello');
  assert.doesNotMatch(sm.text(), /Ask Codex to do anything/);
  assert.equal(sm.promptReady(), true);
  sm.dispose();
});

test('codex: boot screen (model loading) is NOT prompt-ready — Enter is swallowed until the model name appears (T21)', async () => {
  const sm = await screenFrom('codex', 'codex-boot.txt');
  assert.match(sm.text(), /model:\s+loading/);
  assert.equal(sm.promptReady(), false);
  assert.equal(sm.busyIndicator(), false);
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [], highlightDriven: false });
  sm.dispose();
});

test('codex: working screen (no input line at the bottom) is not ready', async () => {
  const sm = await screenFrom('codex', 'codex-working.txt');
  assert.equal(sm.promptReady(), false);
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [], highlightDriven: false });
  assert.equal(sm.lastNonEmptyLine(), '└ hook exited with code 1');
  sm.dispose();
});

test('codex: after Stop the prompt is ready again and the status line is skipped', async () => {
  const sm = await screenFrom('codex', 'codex-after-stop.txt');
  assert.equal(sm.promptReady(), true);
  // 맨 아래 '› Ask Codex to do anything'(입력 상자)과 괘선은 제외 → 마지막 답변 줄
  assert.equal(sm.lastNonEmptyLine(), '명령을 실행해 hello2.txt를 만들었습니다.');
  sm.dispose();
});

// ---- T21 실측 픽스처 (test/screen/tools/capture-*.ts 로 2026-09-16 캡처, 뷰포트 = baseY 기준) ---------------------

// Codex ------------------------------------------------------------------------------------------

test('codex(T21): boot-loading screen shows the prompt + status line but is not ready (model: loading)', async () => {
  const sm = await screenFrom('codex', 'codex/boot-loading.txt');
  assert.match(sm.text(), /│ model:\s+loading/);
  assert.match(sm.text(), /› Ask Codex to do anything/);
  assert.equal(sm.promptReady(), false);
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [], highlightDriven: false });
  assert.equal(sm.approvalPrompt().visible, false);
  sm.dispose();
});

test('codex(T21): READY screen (model loaded, "gpt-… high · cwd" status line) → promptReady', async () => {
  const sm = await screenFrom('codex', 'codex/ready.txt');
  assert.doesNotMatch(sm.text(), /model:\s+loading/);
  assert.equal(sm.promptReady(), true);
  assert.equal(sm.busyIndicator(), false);
  assert.equal(sm.interrupted(), false);
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [], highlightDriven: false });
  // 입력 상자·상태줄은 제외 → 마지막 경고 배너
  assert.match(sm.lastNonEmptyLine(), /^⚠ `--dangerously-bypass-hook-trust` is enabled/);
  sm.dispose();
});

test('codex(T21): working screen "• Working (0s • esc to interrupt)" → busy, not ready even though the input box is visible', async () => {
  const sm = await screenFrom('codex', 'codex/working.txt');
  assert.match(sm.text(), /› Ask Codex to do anything/); // 작업 중에도 입력 상자와 상태줄이 그대로 보인다
  assert.equal(sm.busyIndicator(), true);
  assert.equal(sm.promptReady(), false);
  assert.equal(sm.interrupted(), false);
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [], highlightDriven: false });
  // 'Working' 줄과 입력 상자·상태줄은 건너뛰고 제출한 프롬프트 줄
  assert.equal(sm.lastNonEmptyLine(), '› 셸 명령 sleep 8 을 실행해줘');
  sm.dispose();
});

test('codex(T21): the ◦ glyph frame of the spinner is busy too', async () => {
  const sm = await screenFrom('codex', 'codex/working.txt');
  const row = sm.lines().findIndex((l) => /^• Working \(/.test(l));
  assert.ok(row >= 0);
  await sm.feed(`\x1b[${row + 1};1H\x1b[2K◦ Working (1s • esc to interrupt)`);
  assert.equal(sm.busyIndicator(), true);
  assert.equal(sm.promptReady(), false);
  sm.dispose();
});

test('codex(T21): interrupted screen after ctrl-c → interrupted AND promptReady (prompt returns immediately)', async () => {
  const sm = await screenFrom('codex', 'codex/interrupted.txt');
  assert.equal(sm.interrupted(), true);
  assert.equal(sm.promptReady(), true);
  assert.equal(sm.busyIndicator(), false);
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [], highlightDriven: false });
  assert.match(sm.text(), /■ Conversation interrupted - tell the model what to do differently\./);
  sm.dispose();
});

test('codex(T21): usage-limit banner ends the turn → promptReady, not busy, not interrupted', async () => {
  const sm = await screenFrom('codex', 'codex/usage-limit.txt');
  assert.match(sm.text(), /■ You've hit your usage limit/);
  assert.equal(sm.promptReady(), true);
  assert.equal(sm.busyIndicator(), false);
  assert.equal(sm.interrupted(), false);
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [], highlightDriven: false });
  sm.dispose();
});

test('codex(T21): "Switch to gpt-5.6-luna for lower credit usage?" menu → model-switch-offer, esc; not ready', async () => {
  const sm = await screenFrom('codex', 'codex/model-switch-offer.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'model-switch-offer', suggestedKeys: ['esc'], highlightDriven: false });
  assert.equal(sm.promptReady(), false);
  assert.equal(sm.busyIndicator(), false);
  assert.equal(sm.approvalPrompt().visible, false);
  sm.dispose();
});

test('codex(T21): after esc on the model-switch offer the prompt is ready again', async () => {
  const sm = await screenFrom('codex', 'codex/model-switch-offer-after-esc.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [], highlightDriven: false });
  assert.equal(sm.promptReady(), true);
  sm.dispose();
});

test('codex(T21): exit screen after a single ctrl-c at an idle prompt ("codex resume <id>") is not ready', async () => {
  const sm = await screenFrom('codex', 'codex/exit.txt');
  assert.match(sm.text(), /To continue this session, run:\n\s+codex resume [0-9a-f-]{36}/);
  assert.equal(sm.promptReady(), false);
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [], highlightDriven: false });
  sm.dispose();
});

test('codex(T21): trust dialog fixture is still detected with the reworked map', async () => {
  const sm = await screenFrom('codex', 'codex-trust-dialog.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'trust-folder-codex', suggestedKeys: ['enter'], highlightDriven: true });
  assert.equal(sm.promptReady(), false);
  assert.equal(sm.approvalPrompt().visible, false);
  sm.dispose();
});

// Codex 승인 프롬프트 — **실물 캡처**(T42, 2026-09-21 한도 리셋 후 capture-codex.ts 4단계 `echo x > ../x.txt`).
// T21 이 바이너리 문자열로 추정했던 것과 제목은 같고 항목 문구는 달랐다(아래). allow=enter / deny=esc 는 맞았다.
test('codex(T42 실물): approval prompt → approval-prompt with NO suggested keys; allow=enter deny=esc', async () => {
  const sm = await screenFrom('codex', 'codex/approval-prompt.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'approval-prompt', suggestedKeys: [], highlightDriven: false });
  assert.deepEqual(sm.approvalPrompt(), { visible: true, id: 'approval-exec', allowKeys: ['enter'], denyKeys: ['esc'] });
  assert.equal(sm.promptReady(), false);
  assert.equal(sm.busyIndicator(), false);
  // 실물 문구: 제목은 추정과 같고, 항목은 `Yes, proceed (y)` / `…don't ask again for commands that start with …(p)` /
  // `No, and tell Codex what to do differently (esc)`. 첫 항목이 `›` 로 강조되고 푸터는 "…esc to cancel"(추정은 "go back").
  const text = sm.text();
  assert.match(text, /Would you like to run the following command\?/);
  assert.match(text, /^› 1\. Yes, proceed \(y\)$/m);
  assert.match(text, /Press enter to confirm or esc to cancel/);
  // `Reason:` 은 hook 의 tool_input.description 과 같은 한국어 승인 문구다(어댑터가 detail.summary 로 싣는 그것).
  assert.match(text, /Reason: .*허용하시겠습니까\?/);
  sm.dispose();
});

test('codex(T42 실물): esc 로 거부하면 "You canceled the request" 뒤 READY 로 돌아온다', async () => {
  const sm = await screenFrom('codex', 'codex/approval-after-esc-2.txt');
  assert.equal(sm.detectDialog().kind, 'none');
  assert.equal(sm.approvalPrompt().visible, false);
  assert.equal(sm.promptReady(), true);
  assert.equal(sm.busyIndicator(), false);
  sm.dispose();
});

test('codex(T42 실물): 도구가 실제로 도는 중 화면 — busy, 입력 상자는 그대로 보인다', async () => {
  const sm = await screenFrom('codex', 'codex/working-4.txt');
  assert.equal(sm.busyIndicator(), true);
  assert.equal(sm.promptReady(), false); // busy 가 promptReady 보다 우선
  assert.equal(sm.detectDialog().kind, 'none');
  sm.dispose();
});

test('codex: the other approval titles from the binary (edits / permissions / network / MCP) are approval-prompt too', async () => {
  for (const title of [
    'Would you like to make the following edits?',
    'Would you like to grant these permissions?',
    'Do you want to approve network access to "example.com"?',
    'team needs your approval.',
  ]) {
    const sm = new ScreenModel({ engine: 'codex', cols: 120, rows: 10 });
    await sm.feed(`  ${title}\r\n\r\n› 1. Yes, just this once\r\n  2. No\r\n`);
    assert.equal(sm.detectDialog().kind, 'approval-prompt', title);
    assert.deepEqual(sm.detectDialog().suggestedKeys, [], title);
    assert.equal(sm.approvalPrompt().visible, true, title);
    sm.dispose();
  }
});

// Claude -----------------------------------------------------------------------------------------

test('claude(T21): READY screen with placeholder text in the input box → promptReady', async () => {
  const sm = await screenFrom('claude', 'claude/ready.txt');
  assert.equal(sm.promptReady(), true);
  assert.equal(sm.busyIndicator(), false);
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [], highlightDriven: false });
  assert.equal(sm.approvalPrompt().visible, false);
  sm.dispose();
});

/**
 * T43-3 실기에서 잡은 회귀: **statusLine 을 주입하면 `? for shortcuts` 가 사라진다.**
 * T43-1 이 모든 Claude 멤버 세션에 statusLine 을 넣은 뒤로 이 화면이 `promptReady:false` 가 되어
 * 멤버는 `idle` 인데 지시가 `queued` 로 영영 남았다(실기에서 6분 넘게 안 나갔다).
 */
test('claude(T43-3): statusLine 이 주입된 멤버 화면(? for shortcuts 없음)도 준비 상태다', async () => {
  const sm = await screenFrom('claude', 'claude/ready-statusline.txt');
  const bottom = sm.trimmedLines().slice(-2);
  assert.equal(bottom[0], '  주간 38% 남음', '우리 상태 줄이 한 줄 차지한다');
  assert.equal(bottom[1], '  ⏸ manual mode on · ← for agents');
  assert.ok(!sm.text().includes('? for shortcuts'), '이 화면에는 그 힌트가 없다 — 옛 패턴만으로는 못 잡는다');
  assert.equal(sm.promptReady(), true);
  assert.equal(sm.busyIndicator(), false);
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [], highlightDriven: false });
  sm.dispose();
});

test('claude(T21): working screen right after submit → busy, not ready', async () => {
  const sm = await screenFrom('claude', 'claude/working.txt');
  assert.equal(sm.busyIndicator(), true);
  assert.equal(sm.promptReady(), false);
  assert.equal(sm.approvalPrompt().visible, false);
  sm.dispose();
});

test('claude(T21): Bash permission prompt "Do you want to proceed?" → approval-prompt, NO suggested keys, not ready, not busy', async () => {
  const sm = await screenFrom('claude', 'claude/approval-prompt.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'approval-prompt', suggestedKeys: [], highlightDriven: false });
  assert.deepEqual(sm.approvalPrompt(), { visible: true, id: 'permission-prompt', allowKeys: ['enter'], denyKeys: ['down', 'down', 'down', 'enter'] });
  assert.equal(sm.promptReady(), false);
  assert.equal(sm.busyIndicator(), false);
  assert.equal(sm.interrupted(), false);
  // 실물 문구·메뉴 확인
  assert.match(sm.text(), /^ Bash command$/m);
  assert.match(sm.text(), /^ Do you want to proceed\?$/m);
  assert.match(sm.text(), /^ ❯ 1\. Yes$/m);
  assert.match(sm.text(), /^   2\. Yes, and always allow access to .+ from this project$/m);
  assert.match(sm.text(), /^   3\. Yes, and switch to auto mode · auto mode handles these prompts for you$/m);
  assert.match(sm.text(), /^   4\. No$/m);
  assert.match(sm.text(), /^ Esc to cancel · Tab to amend$/m);
  sm.dispose();
});

test('claude(T21): after ↓×3 the highlight is on "4. No" and it is still the same approval-prompt', async () => {
  const sm = await screenFrom('claude', 'claude/approval-prompt-no-highlighted.txt');
  assert.match(sm.text(), /^ ❯ 4\. No$/m);
  assert.match(sm.text(), /^   1\. Yes$/m);
  assert.deepEqual(sm.detectDialog(), { kind: 'approval-prompt', suggestedKeys: [], highlightDriven: false });
  assert.equal(sm.approvalPrompt().visible, true);
  assert.equal(sm.promptReady(), false);
  sm.dispose();
});

test('claude(T21): after Enter on "4. No" → Interrupted line, prompt ready, no prompt text left on screen', async () => {
  const sm = await screenFrom('claude', 'claude/approval-after-deny.txt');
  assert.doesNotMatch(sm.text(), /Do you want to proceed\?/);
  assert.equal(sm.approvalPrompt().visible, false);
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [], highlightDriven: false });
  assert.equal(sm.interrupted(), true);
  assert.equal(sm.promptReady(), true);
  assert.match(sm.lastNonEmptyLine(), /^✻ Cogitated for \d+s · done/);
  sm.dispose();
});

test('claude(T21): "Press Ctrl-C again to exit" status line → not ready (transient), status line skipped for the monitor', async () => {
  const sm = await screenFrom('claude', 'claude/exit-hint.txt');
  assert.match(sm.text(), /Press Ctrl-C again to exit/);
  assert.equal(sm.promptReady(), false);
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [], highlightDriven: false });
  assert.doesNotMatch(sm.lastNonEmptyLine(), /Press Ctrl-C again to exit/);
  sm.dispose();
});

// InputQueue 계약: 다이얼로그 통과는 detectDialog().suggestedKeys 를 그대로 보낸다 → approval-prompt 는 빈 배열이어야 아무 키도 안 나간다.
test('approval-prompt never yields suggested keys (InputQueue pass-through sends nothing) for either engine', async () => {
  const claude = await screenFrom('claude', 'claude/approval-prompt.txt');
  const codex = new ScreenModel({ engine: 'codex', cols: 120, rows: 8 });
  await codex.feed('  Would you like to run the following command?\r\n\r\n› 1. Yes, just this once\r\n');
  for (const sm of [claude, codex]) {
    const d = sm.detectDialog();
    assert.equal(d.kind, 'approval-prompt');
    assert.deepEqual(d.suggestedKeys, []);
    assert.ok(sm.approvalPrompt().allowKeys.length > 0);
    assert.ok(sm.approvalPrompt().denyKeys.length > 0);
    sm.dispose();
  }
});
