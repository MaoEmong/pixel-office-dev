// T43-1 순수 파서 — 픽스처는 **T43-0 스파이크 실측 캡처**(`dev/spike-1/out/`)를 가공 없이 옮긴 것이다
// (`test/fixtures/usage/`). 실물이 아닌 유일한 것은 Codex 의 **빈 `token_count`**(`limit_id:"premium"`,
// `info:null`, `primary:null`) 로, 원자료가 out/ 에 남지 않아 worklog T43-0 Q6 함정 2 에 적힌 모양으로 만들었다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaudeStatusLine } from '../../src/usage/parse/claudeStatusLine.js';
import { parseClaudeCostState } from '../../src/usage/parse/claudeCostState.js';
import { parseCodexTokenCounts, WEEKLY_WINDOW_MINUTES } from '../../src/usage/parse/codexTokenCount.js';
import { parseClaudeAuthStatus, parseCodexLoginStatus } from '../../src/usage/parse/connection.js';
import { isoFromUnixSeconds } from '../../src/usage/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../fixtures/usage');
const read = (f: string): string => fs.readFileSync(path.join(fixtures, f), 'utf8');
const readJson = <T>(f: string): T => JSON.parse(read(f)) as T;

/** statusline.jsonl 의 n 번째 발화(0 = 세션 시작 직후, 1 = 첫 턴 종료 직후). */
function statusLine(n: number): unknown {
  const lines = read('claude-statusline.jsonl').split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[n]!);
}

describe('parseClaudeStatusLine (실측 페이로드)', () => {
  test('턴 종료 직후: 주간·5시간 한도 + 컨텍스트 + 비용이 전부 온다', () => {
    const got = parseClaudeStatusLine(statusLine(1));
    assert.deepEqual(got.weekly, { usedPercent: 54, resetsAt: isoFromUnixSeconds(1790132400) });
    assert.deepEqual(got.session, { usedPercent: 17, resetsAt: isoFromUnixSeconds(1789992000) });
    assert.deepEqual(got.context, { used: 43910, window: 1_000_000, percent: 4 });
    assert.equal(got.costUsd, 0.16072150000000002);
    assert.equal(got.sessionId, '50cc7bea-750f-4e3f-8492-4c4595194b6d');
    assert.ok(got.transcriptPath?.endsWith('.jsonl'), got.transcriptPath ?? '(없음)');
  });

  test('used 는 current_usage 입력 세 값의 합 = total_input_tokens (실측 2+14495+29413=43910)', () => {
    assert.equal(parseClaudeStatusLine(statusLine(1)).context?.used, 2 + 14495 + 29413);
  });

  test('세션 시작 직후(첫 API 호출 전): rate_limits 키가 없다 → weekly/session 은 null', () => {
    const got = parseClaudeStatusLine(statusLine(0));
    assert.equal(got.weekly, null);
    assert.equal(got.session, null);
    // 컨텍스트 칸은 있지만 퍼센트는 null 이다(current_usage 도 null).
    assert.deepEqual(got.context, { used: 0, window: 1_000_000, percent: null });
  });

  test('갓 띄운 세션(statusline-fresh)도 같다 — 한도 없음, 비용 0', () => {
    const got = parseClaudeStatusLine(readJson('claude-statusline-fresh.json'));
    assert.equal(got.weekly, null);
    assert.equal(got.costUsd, 0);
  });

  test('--resume 직후: 컨텍스트는 복원되지만 rate_limits 는 여전히 없다(실측)', () => {
    const got = parseClaudeStatusLine(readJson('claude-statusline-resume.json'));
    assert.equal(got.weekly, null);
    assert.equal(got.session, null);
    assert.deepEqual(got.context, { used: 43910, window: 1_000_000, percent: 4 });
    assert.equal(got.costUsd, 0.16072150000000002);
  });

  test('원문 문자열도 받는다(statusline.js 가 보낸 body 그대로)', () => {
    const text = read('claude-statusline.jsonl').split(/\r?\n/).filter(Boolean)[1]!;
    assert.deepEqual(parseClaudeStatusLine(text), parseClaudeStatusLine(JSON.parse(text)));
  });

  test('필드가 사라져도 그 값만 null 이다 (CLI 업데이트 방어)', () => {
    const base = statusLine(1) as Record<string, unknown>;
    const noSevenDay = { ...base, rate_limits: { five_hour: { used_percentage: 17, resets_at: 1789992000 } } };
    const got = parseClaudeStatusLine(noSevenDay);
    assert.equal(got.weekly, null);
    assert.deepEqual(got.session, { usedPercent: 17, resetsAt: isoFromUnixSeconds(1789992000) });
    assert.equal(got.context?.percent, 4); // 나머지는 계속 돈다

    const renamed = { ...base, context_window: { used_pct: 4 } };
    assert.deepEqual(parseClaudeStatusLine(renamed).context, { used: null, window: null, percent: null });
    assert.equal(parseClaudeStatusLine(renamed).weekly?.usedPercent, 54);
  });

  test('쓰레기 입력에도 던지지 않는다', () => {
    for (const bad of ['', 'not json', '[]', 'null', 42, undefined, null, {}]) {
      const got = parseClaudeStatusLine(bad);
      assert.equal(got.weekly, null);
      assert.equal(got.costUsd, null);
    }
  });
});

describe('parseClaudeCostState (실측 transcript 꼬리)', () => {
  test('마지막 cost-state 의 모델별 합산 + 총비용', () => {
    const got = parseClaudeCostState(read('claude-transcript-tail.jsonl'));
    // 실측 modelUsage: haiku(910 in, 14 out) + opus(2 in, 3 out, 29413 cr, 14495 cc)
    assert.deepEqual(got.tokens, {
      input: 912,
      output: 17,
      cacheRead: 29413,
      cacheCreate: 14495,
      total: 912 + 17 + 29413 + 14495,
    });
    assert.equal(got.costUsd, 0.16072150000000002);
    assert.equal(got.sessionId, '50cc7bea-750f-4e3f-8492-4c4595194b6d');
  });

  test('앞선 cost-state 줄이 있어도 마지막 것이 이긴다', () => {
    const tail = read('claude-transcript-tail.jsonl');
    assert.ok(tail.split('cost-state').length - 1 >= 2, '픽스처에 cost-state 가 둘 이상 있어야 한다');
    assert.notEqual(parseClaudeCostState(tail).costUsd, 0.00098);
  });

  test('cost-state 가 없으면 전부 null (이전 값을 지우지 않게)', () => {
    const got = parseClaudeCostState('{"type":"assistant"}\n{"type":"user"}\n');
    assert.deepEqual(got, { costUsd: null, tokens: null, sessionId: null });
  });

  test('잘린 첫 줄은 건너뛴다', () => {
    const tail = read('claude-transcript-tail.jsonl');
    const broken = '"cost-state","totalCostUSD":999}\n' + tail;
    assert.equal(parseClaudeCostState(broken).costUsd, 0.16072150000000002);
  });
});

describe('parseCodexTokenCounts (실측 rollout 꼬리)', () => {
  const tail = read('codex-rollout-tail.jsonl');

  test('limit_id==="codex" ∧ primary!=null 인 마지막 이벤트를 고른다', () => {
    const got = parseCodexTokenCounts(tail);
    assert.deepEqual(got.weekly, { usedPercent: 12, resetsAt: isoFromUnixSeconds(1790571738) });
    assert.equal(got.session, null, 'Pro 계정 실측에서 secondary 는 null');
    assert.equal(got.plan, 'pro');
  });

  test('빈 premium 이벤트(info:null, primary:null)가 앞뒤로 섞여도 무시된다', () => {
    assert.ok(tail.includes('"premium"'), '픽스처에 빈 이벤트가 있어야 한다');
    const got = parseCodexTokenCounts(tail);
    assert.equal(got.plan, 'pro');
    assert.equal(got.weekly?.usedPercent, 12);
  });

  test('컨텍스트·누적 토큰은 같은 이벤트의 info 에서', () => {
    const got = parseCodexTokenCounts(tail);
    assert.deepEqual(got.context, { used: 21868, window: 258400, percent: 8 });
    assert.deepEqual(got.tokens, { input: 43716, output: 10, cacheRead: 21632, cacheCreate: 0, total: 43726 });
  });

  test('주간 창은 window_minutes 10080(7일)이다', () => {
    const last = tail
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { payload?: { rate_limits?: { primary?: { window_minutes?: number } } } })
      .filter((o) => o.payload?.rate_limits?.primary)
      .pop();
    assert.equal(last?.payload?.rate_limits?.primary?.window_minutes, WEEKLY_WINDOW_MINUTES);
  });

  test('token_count 가 없는 rollout(턴 0회 세션)은 전부 null', () => {
    const meta = '{"timestamp":"2026-09-21T07:17:46.000Z","type":"session_meta","payload":{"id":"x"}}\n';
    assert.deepEqual(parseCodexTokenCounts(meta), { weekly: null, session: null, plan: null, context: null, tokens: null });
  });

  test('secondary 가 있는 요금제(미확인)면 session 으로 실린다', () => {
    const line = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: null,
        rate_limits: { limit_id: 'codex', primary: { used_percent: 5, window_minutes: 10080, resets_at: 1790571738 }, secondary: { used_percent: 30, window_minutes: 300, resets_at: 1789992000 }, plan_type: 'plus' },
      },
    });
    const got = parseCodexTokenCounts(line + '\n');
    assert.deepEqual(got.session, { usedPercent: 30, resetsAt: isoFromUnixSeconds(1789992000) });
    assert.equal(got.plan, 'plus');
  });

  test('쓰레기·빈 입력에도 던지지 않는다', () => {
    for (const bad of ['', 'nope', '{', '{"payload":{"type":"token_count"}}']) {
      assert.doesNotThrow(() => parseCodexTokenCounts(bad));
    }
  });
});

describe('parseClaudeAuthStatus / parseCodexLoginStatus (실측 출력)', () => {
  test('claude 연결됨: loggedIn + 요금제', () => {
    assert.deepEqual(parseClaudeAuthStatus(read('claude-auth-status.json')), { loggedIn: true, plan: 'max' });
  });

  test('claude 로그아웃: subscriptionType 키가 사라진다 → plan null', () => {
    assert.deepEqual(parseClaudeAuthStatus(read('claude-auth-status-logged-out.json')), { loggedIn: false, plan: null });
  });

  test('이메일·orgId 가 들어 있어도 결과에 그런 키가 없다 (D-45 ②)', () => {
    // 캡처는 이메일을 가려 뒀으므로 진짜처럼 생긴 값을 되돌려 넣고 본다.
    const withEmail = read('claude-auth-status.json')
      .replace('<이메일>', 'someone@example.com')
      .replace('<orgId>', 'org_0123456789');
    assert.ok(withEmail.includes('someone@example.com'));
    const got = parseClaudeAuthStatus(withEmail);
    assert.deepEqual(Object.keys(got).sort(), ['loggedIn', 'plan']);
    assert.ok(!JSON.stringify(got).includes('@'), JSON.stringify(got));
    assert.ok(!JSON.stringify(got).includes('org_'), JSON.stringify(got));
  });

  test('codex 연결됨 / 안 됨', () => {
    assert.deepEqual(parseCodexLoginStatus(read('codex-login-status.txt'), 0), { loggedIn: true, plan: null });
    assert.deepEqual(parseCodexLoginStatus(read('codex-login-status-logged-out.txt'), 1), { loggedIn: false, plan: null });
  });

  test('codex: PATH 별칭 경고가 섞여도 판정은 그대로', () => {
    const merged = read('codex-login-status-warning.txt') + read('codex-login-status-logged-out.txt');
    assert.equal(parseCodexLoginStatus(merged, 1).loggedIn, false);
  });

  test('codex: 문구가 바뀌면 종료 코드로 판단한다', () => {
    assert.equal(parseCodexLoginStatus('something else', 0).loggedIn, true);
    assert.equal(parseCodexLoginStatus('something else', 1).loggedIn, false);
    assert.equal(parseCodexLoginStatus('', -1).loggedIn, null);
  });

  test('claude: JSON 이 아니면 둘 다 null', () => {
    for (const bad of ['', 'Usage: claude auth status', '{']) assert.deepEqual(parseClaudeAuthStatus(bad), { loggedIn: null, plan: null });
  });
});
