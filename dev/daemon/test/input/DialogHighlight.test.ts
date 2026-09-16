// T36 — 강조로 키가 갈리는 다이얼로그(신뢰 폴더)의 "이동 먼저, 확인은 다시 보고" 규칙.
//
// 실측(worklog/T36-TreeAfterCare.md): 브랜드 뉴 폴더에서 Claude 2.1 신뢰 다이얼로그는 뜬 직후 한 번 더 렌더되며
// 선택을 `❯ No, exit` 로 **되돌린다**. T34 까지처럼 ↓와 Enter 를 150ms 간격으로 붙여 보내면 Enter 가 되돌아온
// "No, exit" 에 떨어져 CLI 가 `exit 1` 로 죽었다(T34 "빈 폴더 함정").
//
// 고친 규칙: `highlightDriven` 다이얼로그는 ① 이동 키만 보내고 ② 다음 폴링에서 강조가 원하는 항목에 와 있는 것을
// (= 권장 키가 확인 키 하나로 줄어든 것을) 다시 본 뒤에야 Enter 를 보낸다. 반복 가드는 **같은 키**에만 걸리므로
// 되돌아가면 2초 뒤 다시 ↓를 보내고, 성공하면 Enter 는 곧바로 나간다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { InputQueue, TIMING } from '../../src/input/InputQueue.js';
import type { DialogKey } from '../../src/input/InputQueue.js';

interface Dialog {
  kind: string;
  suggestedKeys: DialogKey[];
  highlightDriven?: boolean;
}

function harness() {
  let t = 1_000_000;
  const calls: string[] = [];
  const state = { idle: true, ready: true, dialog: { kind: 'none', suggestedKeys: [] } as Dialog };
  const dialogs: string[] = [];
  const q = new InputQueue({
    session: { paste: (s) => calls.push(`paste:${s}`), write: (s) => calls.push(`write:${s}`), sendKeys: (k) => calls.push(`key:${k}`) },
    screen: { promptReady: () => state.ready, detectDialog: () => state.dialog },
    isIdle: () => state.idle,
    now: () => t,
  });
  q.on('dialogPassed', (k) => dialogs.push(k));
  return { q, calls, state, dialogs, advance: (ms: number) => (t += ms) };
}

/** 지금 강조된 항목에 따른 권장 키(tui-map claude-2.1 trust-folder 그대로). */
const TRUST_ON_NO: Dialog = { kind: 'trust-folder-claude', suggestedKeys: ['down', 'enter'], highlightDriven: true };
const TRUST_ON_YES: Dialog = { kind: 'trust-folder-claude', suggestedKeys: ['enter'], highlightDriven: true };
const NONE: Dialog = { kind: 'none', suggestedKeys: [] };

describe('강조 기반 다이얼로그: 이동 먼저, 확인은 다시 보고 (T36)', () => {
  test('↓만 먼저 보내고 Enter 는 붙여 보내지 않는다', () => {
    const h = harness();
    h.state.dialog = { ...TRUST_ON_NO };
    h.q.tick();

    assert.deepEqual(h.calls, ['key:down'], '이동 키 하나');
    assert.equal(h.q.pendingActions(), 0, 'Enter 를 예약해 두지 않는다 — 화면을 다시 보고 결정한다');

    // keySpacing 이 지나도 화면이 그대로면(아직 강조가 안 옮겨졌다) 아무것도 더 보내지 않는다.
    h.advance(TIMING.keySpacingMs + 1);
    h.q.tick();
    assert.deepEqual(h.calls, ['key:down']);
  });

  test('강조가 원하는 항목에 오면 Enter 는 가드를 기다리지 않고 바로 나간다', () => {
    const h = harness();
    h.state.dialog = { ...TRUST_ON_NO };
    h.q.tick();
    assert.deepEqual(h.calls, ['key:down']);

    h.advance(300); // 가드(2000ms) 안이지만 권장 키가 달라졌다 = 화면이 실제로 바뀌었다
    h.state.dialog = { ...TRUST_ON_YES };
    h.q.tick();
    assert.deepEqual(h.calls, ['key:down', 'key:enter']);
    assert.deepEqual(h.dialogs, ['trust-folder-claude', 'trust-folder-claude']);
  });

  test('되돌아간 강조(실측 함정): Enter 를 쏘지 않고 2초 뒤 ↓를 다시 보낸 다음 확인한다', () => {
    const h = harness();
    h.state.dialog = { ...TRUST_ON_NO };
    h.q.tick();
    assert.deepEqual(h.calls, ['key:down']);

    // ↓가 한 번 먹혔다가(YES) CLI 의 두 번째 렌더로 NO 로 되돌아온다.
    h.advance(100);
    h.state.dialog = { ...TRUST_ON_YES };
    // 아직 폴링 전이라 아무 일도 없다가…
    h.advance(100);
    h.state.dialog = { ...TRUST_ON_NO };
    h.q.tick();
    assert.deepEqual(h.calls, ['key:down'], '같은 키는 가드 안에 다시 보내지 않는다 — Enter 도 안 나간다');

    h.advance(TIMING.dialogRepeatGuardMs);
    h.q.tick();
    assert.deepEqual(h.calls, ['key:down', 'key:down'], '가드가 풀리면 이동을 한 번 더');

    h.state.dialog = { ...TRUST_ON_YES };
    h.advance(200);
    h.q.tick();
    assert.deepEqual(h.calls, ['key:down', 'key:down', 'key:enter'], '이번엔 강조가 남아 있으니 확인');

    h.state.dialog = { ...NONE };
    h.q.tick();
    assert.deepEqual(h.calls, ['key:down', 'key:down', 'key:enter'], '통과했으면 끝');
  });

  test('강조가 없는 다이얼로그는 예전처럼 키 시퀀스를 한 번에 보낸다(온보딩 Enter 등)', () => {
    const h = harness();
    h.state.dialog = { kind: 'onboarding-enter', suggestedKeys: ['enter'] };
    h.q.tick();
    assert.deepEqual(h.calls, ['key:enter']);

    // 강조는 없는데 키가 여럿인 가상의 맵도 그대로 이어 보낸다(확인할 강조 정보가 없으니 쪼갤 근거가 없다).
    const h2 = harness();
    h2.state.dialog = { kind: 'login-menu', suggestedKeys: ['down', 'enter'] };
    h2.q.tick();
    assert.deepEqual(h2.calls, ['key:down']);
    assert.equal(h2.q.pendingActions(), 1, '두 번째 키는 예약된다');
    h2.advance(TIMING.keySpacingMs);
    h2.q.tick();
    assert.deepEqual(h2.calls, ['key:down', 'key:enter']);
  });
});
