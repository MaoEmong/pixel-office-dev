// 스파이크 로그(dev/spike-0/run*.log, run-codex*.log)에서 복사한 실제 화면(fixtures/*.txt)으로
// promptReady / detectDialog / lastNonEmptyLine / busyIndicator / interrupted 를 화면별로 검사한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenFrom } from './helpers.js';

// ---- Claude 온보딩·첫 실행 다이얼로그 (run3/run4/run5) ---------------------------------------

test('claude: onboarding theme picker → onboarding-enter, enter', async () => {
  const sm = await screenFrom('claude', 'claude-onboarding-theme.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'onboarding-enter', suggestedKeys: ['enter'] });
  assert.equal(sm.promptReady(), false);
  assert.equal(sm.interrupted(), false);
  assert.equal(sm.busyIndicator(), false);
  // 마지막 줄: 하단 괘선(╌)은 건너뛰고 미리보기 안내줄
  assert.equal(sm.lastNonEmptyLine(), 'Syntax theme: Monokai Extended (ctrl+t to disable)');
  sm.dispose();
});

test('claude: login method menu → login-menu, enter', async () => {
  const sm = await screenFrom('claude', 'claude-login-menu.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'login-menu', suggestedKeys: ['enter'] });
  assert.equal(sm.promptReady(), false);
  assert.equal(sm.lastNonEmptyLine(), '3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI');
  sm.dispose();
});

test('claude: security notes → security-notes, enter', async () => {
  const sm = await screenFrom('claude', 'claude-security-notes.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'security-notes', suggestedKeys: ['enter'] });
  assert.equal(sm.promptReady(), false);
  assert.equal(sm.lastNonEmptyLine(), 'Press Enter to continue…');
  sm.dispose();
});

test('claude: trust dialog with "No, exit" highlighted → trust-folder-claude, down+enter', async () => {
  const sm = await screenFrom('claude', 'claude-trust-dialog.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'trust-folder-claude', suggestedKeys: ['down', 'enter'] });
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
  assert.deepEqual(sm.detectDialog(), { kind: 'trust-folder-claude', suggestedKeys: ['enter'] });
  sm.dispose();
});

test('claude: fullscreen renderer offer → onboarding-enter, enter (run8)', async () => {
  const sm = await screenFrom('claude', 'claude-fullscreen-renderer.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'onboarding-enter', suggestedKeys: ['enter'] });
  assert.equal(sm.promptReady(), false);
  sm.dispose();
});

// ---- Claude READY / 작업 중 / 중단 (run8/run9) -------------------------------------------------

test('claude: READY screen → promptReady, no dialog, last line skips rule/effort/status lines', async () => {
  const sm = await screenFrom('claude', 'claude-ready.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [] });
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
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [] });
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
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [] });
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
  assert.deepEqual(sm.detectDialog(), { kind: 'trust-folder-codex', suggestedKeys: ['enter'] });
  assert.equal(sm.promptReady(), false);
  assert.equal(sm.interrupted(), false);
  assert.equal(sm.lastNonEmptyLine(), 'Press enter to continue');
  sm.dispose();
});

test('codex: trust dialog with "No, quit" highlighted → up+enter', async () => {
  const sm = await screenFrom('codex', 'codex-trust-dialog.txt');
  await sm.feed('\x1b[6;1H\x1b[2K  1. Yes, continue\x1b[7;1H\x1b[2K› 2. No, quit');
  assert.deepEqual(sm.detectDialog(), { kind: 'trust-folder-codex', suggestedKeys: ['up', 'enter'] });
  sm.dispose();
});

test('codex: READY screen → promptReady via placeholder, no dialog', async () => {
  const sm = await screenFrom('codex', 'codex-ready.txt');
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [] });
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

test('codex: boot screen (model loading) is already prompt-ready', async () => {
  const sm = await screenFrom('codex', 'codex-boot.txt');
  assert.equal(sm.promptReady(), true);
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [] });
  sm.dispose();
});

test('codex: working screen (no input line at the bottom) is not ready', async () => {
  const sm = await screenFrom('codex', 'codex-working.txt');
  assert.equal(sm.promptReady(), false);
  assert.deepEqual(sm.detectDialog(), { kind: 'none', suggestedKeys: [] });
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
