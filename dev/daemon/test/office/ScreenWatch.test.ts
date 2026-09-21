// T23b: 화면으로 판정하는 두 가지 — ① 턴 종료 hook 없이 프롬프트로 돌아온 화면의 idle 폴백(D-25),
// ② 자동 통과할 수 없는 CLI 허가 프롬프트의 알림(D-26).
//
// 가짜 pty + 가짜 HookReceiver 위의 진짜 Office/Store/InputQueue 에 **진짜 ScreenModel** 을 쓴다 —
// 화면은 T21 실측 픽스처(`test/screen/fixtures/**`)를 pty 출력으로 흘려 넣는다(`\x1b[2J\x1b[H` 로 지우고 덮어쓴다).
// 두 감시 모두 실제 타이머(500ms 폴링)로 도는 코드라 시계를 주입하지 않고 실제로 기다린다.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office, SCREEN_IDLE_SUMMARY } from '../../src/office/Office.js';
import { TIMING } from '../../src/input/InputQueue.js';
import { Store } from '../../src/store/Store.js';
import type { Engine, Member, OfficeEvent, Team } from '../../src/store/types.js';
import type { HookEvent, HookPayload } from '../../src/hooks/types.js';
import { FakePty, FakeReceiver, fakeReq, seedDeptTeam } from './fakes.js';
import { loadFixture } from '../screen/helpers.js';

const SID = 'sess-t23b';
const base = (event: string) => ({ session_id: SID, hook_event_name: event, cwd: 'D:\\x' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 화면 전환: 지우고(2J) 커서를 맨 위로(H) 보낸 뒤 픽스처를 그대로 그린다. */
const screenOf = (fixture: string) => '\x1b[2J\x1b[H' + loadFixture(fixture).join('\r\n');

/** 화면 감시 창(IDLE_SCREEN_STABLE_MS 3000 + 폴링 500). 발화를 기다릴 때 / 발화하지 않음을 볼 때. */
const FIRE_WAIT = 4500;
const NO_FIRE_WAIT = 3800;
/** 막힌 다이얼로그 알림 창(InputQueue TIMING.dialogBlockedNoticeMs 3000 + 폴링 500, T45). */
const NOTICE_WAIT = TIMING.dialogBlockedNoticeMs + 1000;

describe('화면 기반 감시 (T23b)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let office: Office;
  let team: Team;
  let events: OfficeEvent[];
  let notices: string[];

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t23b-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty, receiver, version: '1.0.0' });
    events = [];
    notices = [];
    office.on('event', (e) => events.push(e));
    office.on('notice', (l, m) => notices.push(`${l}: ${m}`));
    await office.start();
    // 팀장 없는 팀(store 직접) — 화면 감시만 보므로 team.create 의 팀장 자동 출근(T24)은 끼우지 않는다.
    team = seedDeptTeam(store, { name: 'demo', cwd: dataDir, allowedEngines: ['claude', 'codex'], maxMembers: 6 }).team;
  });
  afterEach(async () => {
    await office.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const hire = (name: string, engine: Engine = 'claude') => office.clockIn({ teamId: team.id, engine, name });
  const send = (m: Member, ev: HookEvent, payload: HookPayload) => {
    const f = fakeReq(m.memberToken, ev, payload);
    receiver.emit('hook', f.req);
    return f;
  };
  /** 지시를 제출한 상태(working) 로 만든다. Codex 도 같은 hook 을 쓴다(엔진 공통 뼈대). */
  const submit = (m: Member, prompt = '[TASK#1 from user]') => send(m, 'UserPromptSubmit', { ...base('UserPromptSubmit'), prompt });
  /** 픽스처 화면을 흘려 넣고 xterm 파싱을 기다린다. */
  const paint = async (m: Member, fixture: string) => {
    pty.data(m.id, screenOf(fixture));
    await sleep(80);
  };
  const statusOf = (m: Member) => store.getMember(m.id)!.status;
  const screenIdles = (m: Member) => events.filter((e) => e.memberId === m.id && e.kind === 'idle' && e.detail.summary === SCREEN_IDLE_SUMMARY);

  // ---- ① 화면 기반 idle 폴백 (D-25) --------------------------------------------------

  test('Codex 사용량 한도 화면: Stop hook 없이 프롬프트로 돌아오면 3초 뒤 idle{screen-idle} 로 내려오고 막혀 있던 지시가 흐른다', async () => {
    const 코덱 = hire('코덱', 'codex');
    submit(코덱); // starting → working (부팅 감시도 여기서 멈춘다)
    assert.equal(statusOf(코덱), 'working');
    office.instruct(코덱.id, '다음 지시');
    await paint(코덱, 'codex/usage-limit.txt');

    // 화면은 준비됐지만 턴 종료 hook 이 없다 — 창이 차기 전에는 아무 일도 없다.
    await sleep(1000);
    assert.deepEqual(screenIdles(코덱), []);
    assert.equal(statusOf(코덱), 'working');

    await sleep(FIRE_WAIT);
    assert.equal(screenIdles(코덱).length, 1, 'idle{screen-idle} 한 번');
    assert.equal(statusOf(코덱), 'idle');

    // 부작용 ②(T23 함정 1): isIdle 게이트가 열려 큐에 머물던 지시가 나간다.
    await sleep(900);
    assert.deepEqual(pty.session(코덱.id).pastes, ['[TASK#1 from user]\n다음 지시']);
    // 이미 idle 이므로 두 번 발화하지 않는다.
    assert.equal(screenIdles(코덱).length, 1);
  });

  test('hook 이 계속 오는 동안에는 창이 다시 열리고, 조용해진 뒤에야 idle 로 내려온다 (Claude 준비 화면)', async () => {
    const m = hire('하루');
    send(m, 'SessionStart', { ...base('SessionStart'), source: 'startup' });
    submit(m);
    await paint(m, 'claude-ready.txt');

    // 화면은 내내 준비 상태지만 1.2초마다 hook 이 온다 → 창이 매번 다시 열린다.
    for (let i = 0; i < 2; i++) {
      await sleep(1200);
      submit(m, `[TASK#${i + 2} from user]`);
    }
    await sleep(1200);
    assert.deepEqual(screenIdles(m), [], '3.6초가 지났지만 중간에 hook 이 있었다');
    assert.equal(statusOf(m), 'working');

    await sleep(FIRE_WAIT);
    assert.equal(screenIdles(m).length, 1);
    assert.equal(statusOf(m), 'idle');
  });

  test('busy 표시 · 다이얼로그 · 열린 보류 중에는 발화하지 않는다; 보류가 닫히면 다음 창에서 내려온다', async () => {
    const busy = hire('작업중');
    const dialog = hire('다이얼로그');
    const held = hire('보류');
    for (const m of [busy, dialog, held]) {
      send(m, 'SessionStart', { ...base('SessionStart'), source: 'startup' });
      submit(m);
    }
    await paint(busy, 'claude/working.txt'); // 스피너·esc to interrupt → busyIndicator
    await paint(dialog, 'claude/approval-prompt.txt'); // CLI 허가 프롬프트 → promptReady false
    await paint(held, 'claude-ready.txt'); // 화면은 준비됐지만 허가 pending 이 열려 있다
    send(held, 'PermissionRequest', { ...base('PermissionRequest'), tool_name: 'Bash', tool_input: { command: 'echo 1' } });
    const pending = store.listOpenPending(held.id);
    assert.equal(pending.length, 1);
    assert.equal(statusOf(held), 'waiting_approval');

    await sleep(NO_FIRE_WAIT);
    assert.deepEqual(screenIdles(busy), [], 'busy 화면');
    assert.deepEqual(screenIdles(dialog), [], '다이얼로그가 떠 있음');
    assert.deepEqual(screenIdles(held), [], '허가 보류가 열려 있음');
    assert.deepEqual([statusOf(busy), statusOf(dialog), statusOf(held)], ['working', 'working', 'waiting_approval']);

    // 보류가 닫히면(만료·응답) waiting_* 라도 화면이 조용하면 내려온다.
    store.expirePending(pending[0]!.id);
    await sleep(FIRE_WAIT);
    assert.equal(screenIdles(held).length, 1);
    assert.equal(statusOf(held), 'idle');
    assert.deepEqual(screenIdles(busy), [], 'busy 는 여전히 그대로');
    assert.deepEqual(screenIdles(dialog), []);
  });

  test('퇴근하면 감시가 멈춘다 (죽은 세션의 마지막 화면으로 idle 을 만들지 않는다)', async () => {
    const m = hire('퇴근');
    send(m, 'SessionStart', { ...base('SessionStart'), source: 'startup' });
    submit(m);
    await paint(m, 'claude-ready.txt');
    await office.clockOut(m.id);
    assert.equal(statusOf(m), 'exited');
    await sleep(FIRE_WAIT);
    assert.deepEqual(screenIdles(m), []);
    assert.equal(statusOf(m), 'exited');
  });

  // ---- ② 자동 통과할 수 없는 다이얼로그 (D-26) ------------------------------------------

  test('CLI 허가 프롬프트: 키를 보내지 않고 "통과했다" 알림도 없다 — 계속 떠 있으면 경고 한 번(사라졌다 다시 뜨면 또 한 번)', async () => {
    const m = hire('하루');
    send(m, 'SessionStart', { ...base('SessionStart'), source: 'startup' });
    await paint(m, 'claude/approval-prompt.txt');

    // T45: 알림은 `dialogBlockedNoticeMs`(3초) 동안 계속 떠 있어야 나온다. 그 전에는 조용하다.
    await sleep(2000);
    assert.deepEqual(notices.filter((n) => n.includes('CLI 허가 프롬프트가 떠 있음')), [], '아직 창 안이다');

    // 계속 떠 있으면 한 번 알린다. 그 뒤로는 예전 재전송 가드(2초)·blocked 계량(5초)을 넘겨도 한 번뿐이다.
    await sleep(NOTICE_WAIT);
    const warns = notices.filter((n) => n.includes('CLI 허가 프롬프트가 떠 있음'));
    assert.deepEqual(warns, ['warn: 하루: CLI 허가 프롬프트가 떠 있음 — 카드로 답하거나 터미널에서 직접 답하세요']);
    assert.deepEqual(notices.filter((n) => n.includes('passed first-run dialog')), [], '허가 프롬프트는 "통과" 가 아니다');
    assert.deepEqual(pty.session(m.id).keys, [], '키는 한 개도 나가지 않는다');

    // 다이얼로그가 사라졌다가 다시 뜨면 새 사건이므로 다시 한 번 알린다(역시 계속 떠 있어야 한다).
    await paint(m, 'claude-ready.txt');
    await sleep(700);
    await paint(m, 'claude/approval-prompt.txt');
    await sleep(NOTICE_WAIT);
    assert.equal(notices.filter((n) => n.includes('CLI 허가 프롬프트가 떠 있음')).length, 2);
    assert.deepEqual(pty.session(m.id).keys, []);
  });

  // T45 (D-26 오탐 회귀): MCP 도구 구간에 CLI 가 진짜 허가 프롬프트를 한 프레임 그렸다가 `PermissionRequest`
  // hook 의 allow 로 지운다(실기 실측 502ms = 폴링 한 판). 화면은 **실제 캡처**(approval-prompt-mcp.txt)다.
  // 흐름이 그대로 이어졌는데 경고가 떴다 — 그게 D-26 오탐이었다.
  test('MCP 도구 프롬프트가 hook 으로 곧 사라지면 경고하지 않는다 (T45 — D-26 오탐)', async () => {
    const m = hire('부장');
    send(m, 'SessionStart', { ...base('SessionStart'), source: 'startup' });
    await paint(m, 'claude/approval-prompt-mcp.txt');
    await sleep(700); // 폴링 한 판 — 프롬프트를 확실히 한 번 본다
    await paint(m, 'claude-ready.txt'); // hook allow 가 화면을 지웠다
    await sleep(NOTICE_WAIT);
    assert.deepEqual(notices.filter((n) => n.includes('CLI 허가 프롬프트가 떠 있음')), []);
    assert.deepEqual(pty.session(m.id).keys, [], '키는 한 개도 나가지 않는다');
  });

  test('통과할 수 있는 첫 실행 다이얼로그는 그대로 통과한다 (폴더 신뢰 — 회귀 방지)', async () => {
    const m = hire('신뢰');
    await paint(m, 'claude-trust-dialog.txt');
    await sleep(700);
    assert.ok(
      notices.some((n) => n.includes('passed first-run dialog (trust-folder-claude)')),
      `통과 알림이 있어야 한다: ${notices.join(' | ')}`,
    );
    assert.ok(pty.session(m.id).keys.length > 0, '권장 키가 나간다');
    assert.deepEqual(notices.filter((n) => n.includes('CLI 허가 프롬프트가 떠 있음')), []);
  });
});
