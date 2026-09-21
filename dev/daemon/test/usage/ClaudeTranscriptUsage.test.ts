// T43-5 Claude transcript 증분 누적 — 실측 transcript 를 잘라 만든 픽스처로.
//
// 픽스처는 `~/.claude/projects/D--myproject-pixel-office-dev-spike-0-sandbox/` 의 실제 파일에서
// **`type:"attachment"` 줄만 빼고**(usage 를 들고 있지 않다 — 88개 파일 전수 확인) 그대로 옮긴 것이다.
// 숫자를 손대지 않았으므로 아래 기댓값은 전부 CLI 가 실제로 적은 값이다.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addUsageTokens,
  advanceClaudeTranscript,
  claudeTotalsOf,
  claudeTranscriptTotals,
  emptyClaudeTranscriptState,
  MAX_SEEN_IDS,
  type ClaudeTranscriptState,
} from '../../src/usage/ClaudeTranscriptUsage.js';
import {
  claudeSubagentsDir,
  listClaudeSubagentFiles,
  MAX_SUBAGENT_FILES,
  readClaudeTranscriptUsage,
} from '../../src/usage/claudeTranscriptReader.js';
import { parseClaudeCostState } from '../../src/usage/parse/claudeCostState.js';
import { isRecord, type UsageTokens } from '../../src/usage/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../fixtures/usage');
const fixture = (name: string): string => fs.readFileSync(path.join(fixtures, name), 'utf8');

/** 픽스처 전체를 한 번에 먹인 상태. */
const scan = (name: string): ClaudeTranscriptState =>
  advanceClaudeTranscript(emptyClaudeTranscriptState(name), fixture(name));

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-tx-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const write = (name: string, text: string): string => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text);
  return p;
};

/**
 * 그 파일의 마지막 `cost-state` 를 **transcript 에 줄로 남은 모델**과 **배경 모델**로 갈라 더한다.
 * 배경 모델(제목 생성용 haiku 등)은 API 호출은 했지만 transcript 에 줄을 남기지 않는다 —
 * 우리 누적기가 구조적으로 셀 수 없는 부분이 정확히 이것뿐임을 이 테스트가 못 박는다.
 */
function splitCostState(text: string): { visible: UsageTokens; background: UsageTokens; keys: string[] } {
  const seenModels = new Set<string>();
  let last: Record<string, unknown> | undefined;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(obj)) continue;
    if (obj.type === 'cost-state') last = obj;
    if (obj.type === 'assistant' && isRecord(obj.message) && typeof obj.message.model === 'string') {
      seenModels.add(obj.message.model);
    }
  }
  const zero = (): UsageTokens => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 });
  const visible = zero();
  const background = zero();
  const keys: string[] = [];
  const modelUsage = last && isRecord(last.modelUsage) ? last.modelUsage : {};
  for (const [key, row] of Object.entries(modelUsage)) {
    if (!isRecord(row)) continue;
    // `claude-opus-5[1m]` 는 assistant 줄에 `claude-opus-5` 로 적힌다 — 창 크기 접미사를 떼고 견준다.
    const bare = key.replace(/\[[^\]]*\]$/, '');
    const target = seenModels.has(key) || seenModels.has(bare) ? visible : background;
    if (target === background) keys.push(key);
    target.input! += row.inputTokens as number;
    target.output! += row.outputTokens as number;
    target.cacheRead! += row.cacheReadInputTokens as number;
    target.cacheCreate! += row.cacheCreationInputTokens as number;
  }
  for (const t of [visible, background]) t.total = t.input! + t.output! + t.cacheRead! + t.cacheCreate!;
  return { visible, background, keys };
}

describe('ClaudeTranscriptUsage — 실측 종료 세션과 cost-state 대조', () => {
  // 이 둘이 T43-5 의 근거다: **줄 합이 CLI 자신의 계산과 토큰 단위로 정확히 같다**(배경 모델 제외).
  for (const name of ['claude-transcript-ended-a.jsonl', 'claude-transcript-ended-b.jsonl']) {
    test(`${name}: 누적 == cost-state 의 transcript 모델 버킷(차이는 배경 haiku 뿐)`, () => {
      const text = fixture(name);
      const totals = claudeTranscriptTotals(scan(name));
      const { visible, background, keys } = splitCostState(text);
      assert.deepEqual(totals, visible, '줄 합과 cost-state 가 어긋났다');
      // 못 세는 부분은 **배경 모델 하나**뿐이고, 그것도 입력·출력만 있다(캐시가 0 = 짧은 단발 호출).
      assert.deepEqual(keys, ['claude-haiku-4-5-20251001']);
      assert.ok(background.input! > 0 && background.cacheRead === 0 && background.cacheCreate === 0);
      // 배경 호출은 세션당 거의 고정(제목 생성 한두 번)이라 **짧은 세션일수록 비중이 크다**.
      // 실측 분포는 0.02%~2% — 그래도 몇 % 안쪽임을 못 박아 둔다.
      const all = visible.total! + background.total!;
      assert.ok(background.total! / all < 0.03, `배경 비중 ${(background.total! / all) * 100}%`);
    });
  }

  test('살아 있는 세션의 transcript 에는 cost-state 가 **한 줄도 없다** — 이게 T43-5 의 뿌리', () => {
    // 실측 그대로 옮긴 파일이다(끝나지 않은 세션). 예전 코드는 여기서 아무것도 못 찾아 토큰 칸이 "—" 였다.
    const text = fixture('claude-transcript-live.jsonl');
    assert.equal(parseClaudeCostState(text).tokens, null);
    assert.equal(parseClaudeCostState(text).costUsd, null);
    // 그런데 assistant 줄은 있다 — 그래서 직접 더하면 숫자가 나온다.
    assert.deepEqual(claudeTranscriptTotals(scan('claude-transcript-live.jsonl')), {
      input: 8,
      output: 1207,
      cacheRead: 177389,
      cacheCreate: 18852,
      total: 197456,
    });
  });

  test('cost-state 의 costUsd 는 그대로 살아 있다(누적기와 별개 경로)', () => {
    const cs = parseClaudeCostState(fixture('claude-transcript-ended-a.jsonl'));
    assert.equal(cs.costUsd, 0.16072150000000002);
    assert.equal(cs.tokens?.total, 44837);
  });

  test('사고 토큰은 output 에 **이미 들어 있다** — 더하면 안 된다', () => {
    // 실측 근거: cost-state 의 `outputTokens` 가 줄 합 output 과 정확히 같고, `thinkingTokens` 는
    // 그 안의 부분집합으로 따로 적힌다. 더했다면 output 이 thinking 만큼 커야 한다.
    const name = 'claude-transcript-ended-b.jsonl';
    const state = scan(name);
    const { visible } = splitCostState(fixture(name));
    assert.equal(claudeTranscriptTotals(state)!.output, visible.output);
    const dupes = scan('claude-transcript-dupes.jsonl');
    const thinking = Object.values(dupes.byModel).reduce((s, m) => s + m.thinking, 0);
    assert.equal(thinking, 509, '실측 사고 토큰');
    assert.equal(claudeTranscriptTotals(dupes)!.output, 1255, 'output 에 509 가 또 더해지지 않았다');
  });
});

describe('ClaudeTranscriptUsage — 중복 message.id', () => {
  test('같은 id 가 여러 줄에 나와도 한 번만 센다(마지막 값)', () => {
    const state = scan('claude-transcript-dupes.jsonl');
    assert.equal(state.seenIds.length, 4, '실측: assistant 줄 8개 · 고유 id 4개');
    assert.deepEqual(claudeTranscriptTotals(state), {
      input: 8,
      output: 1255,
      cacheRead: 178533,
      cacheCreate: 18675,
      total: 198471,
    });
  });

  test('앞 줄이 중간값이면 뒤 줄로 **교체**한다(빼고 더한다)', () => {
    const id = 'msg_test';
    const line = (out: number): string =>
      `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } } })}\n`;
    const state = advanceClaudeTranscript(emptyClaudeTranscriptState('x'), line(1) + line(206));
    assert.equal(state.seenIds.length, 1);
    assert.deepEqual(claudeTranscriptTotals(state), { input: 5, output: 206, cacheRead: 100, cacheCreate: 7, total: 318 });
  });

  test('기억하는 id 는 상한이 있다(오래된 것부터 버린다)', () => {
    let state = emptyClaudeTranscriptState('x');
    let text = '';
    for (let i = 0; i < MAX_SEEN_IDS + 50; i++) {
      text += `${JSON.stringify({ type: 'assistant', message: { id: `msg_${i}`, model: 'm', usage: { output_tokens: 1 } } })}\n`;
    }
    state = advanceClaudeTranscript(state, text);
    assert.equal(state.seenIds.length, MAX_SEEN_IDS);
    assert.equal(Object.keys(state.counted).length, MAX_SEEN_IDS);
    // 잊었어도 **합계는 줄지 않는다** — 뺀 것은 기억일 뿐이다.
    assert.equal(claudeTranscriptTotals(state)!.output, MAX_SEEN_IDS + 50);
  });
});

describe('ClaudeTranscriptUsage — 청크 경계', () => {
  test('어떻게 잘라 먹여도 결과가 같다', () => {
    const name = 'claude-transcript-dupes.jsonl';
    const text = fixture(name);
    const once = claudeTranscriptTotals(scan(name));
    for (const size of [1, 7, 64, 997, 5000]) {
      let state = emptyClaudeTranscriptState(name);
      for (let i = 0; i < text.length; i += size) state = advanceClaudeTranscript(state, text.slice(i, i + size));
      assert.deepEqual(claudeTranscriptTotals(state), once, `${size}자씩 나눠 먹였을 때`);
      assert.equal(state.offset, Buffer.byteLength(text, 'utf8'));
    }
  });

  test('줄 한가운데서 끊기면 그 조각을 들고 있다가 다음 청크에 이어 붙인다', () => {
    const line = `${JSON.stringify({ type: 'assistant', message: { id: 'msg_a', model: 'm', usage: { output_tokens: 42 } } })}\n`;
    const cut = Math.floor(line.length / 2);
    let state = advanceClaudeTranscript(emptyClaudeTranscriptState('x'), line.slice(0, cut));
    assert.equal(claudeTranscriptTotals(state), null, '반쪽 줄은 세지 않는다');
    assert.equal(state.partialLine, line.slice(0, cut));
    state = advanceClaudeTranscript(state, line.slice(cut));
    assert.equal(claudeTranscriptTotals(state)!.output, 42);
    assert.equal(state.partialLine, '');
  });

  test('깨진 JSON · usage 없는 줄 · 합성 줄은 조용히 건너뛴다', () => {
    const good = `${JSON.stringify({ type: 'assistant', message: { id: 'msg_g', model: 'm', usage: { output_tokens: 3 } } })}\n`;
    const text =
      '{"type":"assistant","mess\n' + // 잘린 JSON
      `${JSON.stringify({ type: 'assistant', message: { id: 'msg_x', model: '<synthetic>' } })}\n` + // usage 없음
      `${JSON.stringify({ type: 'assistant', message: { model: 'm', usage: { output_tokens: 99 } } })}\n` + // id 없음
      `${JSON.stringify({ type: 'assistant', message: { id: 'msg_z', model: 'm', usage: { output_tokens: 0, input_tokens: 0 } } })}\n` + // 전부 0
      good;
    const state = advanceClaudeTranscript(emptyClaudeTranscriptState('x'), text);
    assert.deepEqual(claudeTranscriptTotals(state), { input: 0, output: 3, cacheRead: 0, cacheCreate: 0, total: 3 });
    assert.deepEqual([...state.seenIds], ['msg_z', 'msg_g']);
  });
});

describe('ClaudeTranscriptUsage — 서브에이전트 · 빈 transcript', () => {
  test('`isSidechain:true` 줄도 센다(id 가 달라 이중 계산이 아니다)', () => {
    // 실측 픽스처는 CLI 2.1.275 가 `<sessionId>/subagents/agent-*.jsonl` 에 따로 쓴 진짜 서브에이전트 줄이다.
    const state = scan('claude-transcript-sidechain.jsonl');
    assert.equal(state.seenIds.length, 5, '줄 8개 · 고유 id 5개');
    assert.deepEqual(claudeTranscriptTotals(state), {
      input: 8,
      output: 642,
      cacheRead: 78948,
      cacheCreate: 6897,
      total: 86495,
    });
  });

  test('assistant 줄이 하나도 없는 transcript → null(0 이 아니다)', () => {
    const state = scan('claude-transcript-noassistant.jsonl');
    assert.equal(claudeTranscriptTotals(state), null, '"아직 모른다" 와 "0 을 썼다" 는 다르다');
    assert.ok(state.offset > 0, '읽기는 했다');
  });
});

describe('readClaudeTranscriptUsage — 증분 · 회전 · 상한', () => {
  test('덧붙은 부분만 읽는다(결과는 한 번에 읽은 것과 같다)', async () => {
    const text = fixture('claude-transcript-dupes.jsonl');
    const half = text.slice(0, text.lastIndexOf('\n', Math.floor(text.length / 2)) + 1);
    const p = write('t.jsonl', half);
    const first = (await readClaudeTranscriptUsage(p))!;
    assert.equal(first.offset, Buffer.byteLength(half, 'utf8'));

    fs.appendFileSync(p, text.slice(half.length));
    const second = (await readClaudeTranscriptUsage(p, first))!;
    assert.equal(second.offset, Buffer.byteLength(text, 'utf8'));
    assert.deepEqual(claudeTranscriptTotals(second), claudeTranscriptTotals(scan('claude-transcript-dupes.jsonl')));
  });

  test('새로 붙은 것이 없으면 같은 상태를 그대로 돌려준다', async () => {
    const p = write('t.jsonl', fixture('claude-transcript-ended-a.jsonl'));
    const first = (await readClaudeTranscriptUsage(p))!;
    const again = (await readClaudeTranscriptUsage(p, first))!;
    assert.equal(again, first, '같은 객체 — 아무 일도 하지 않았다');
  });

  test('파일이 줄면(잘림·회전) 처음부터 다시 센다', async () => {
    const text = fixture('claude-transcript-ended-a.jsonl');
    const p = write('t.jsonl', text);
    const first = (await readClaudeTranscriptUsage(p))!;
    assert.ok((claudeTranscriptTotals(first)!.total ?? 0) > 0);

    // 같은 경로에 짧은 내용으로 다시 쓴다 = 회전.
    const short = `${JSON.stringify({ type: 'assistant', message: { id: 'msg_new', model: 'm', usage: { output_tokens: 11 } } })}\n`;
    fs.writeFileSync(p, short);
    const after = (await readClaudeTranscriptUsage(p, first))!;
    assert.equal(after.offset, Buffer.byteLength(short, 'utf8'));
    assert.deepEqual(claudeTranscriptTotals(after), { input: 0, output: 11, cacheRead: 0, cacheCreate: 0, total: 11 });
  });

  test('transcript 경로가 바뀌면(`--resume` 이 새 파일을 팠다) 0 부터 다시 센다', async () => {
    // 근거: 실측에서 `--resume` 이 만든 새 파일의 cost-state 는 이전 세션 금액을 **이어받지 않았다**
    // ($0.335 로 끝난 세션을 resume 하니 새 파일의 totalCostUSD 가 $0.125 로 다시 시작). CLI 자신의
    // `/cost` 가 파일 단위로 리셋되므로 우리도 리셋해야 숫자가 화면과 맞는다.
    const a = write('a.jsonl', fixture('claude-transcript-ended-a.jsonl'));
    const state = (await readClaudeTranscriptUsage(a))!;
    const b = write('b.jsonl', `${JSON.stringify({ type: 'assistant', message: { id: 'msg_b', model: 'm', usage: { output_tokens: 7 } } })}\n`);
    const after = (await readClaudeTranscriptUsage(b, state))!;
    assert.equal(after.path, b);
    assert.deepEqual(claudeTranscriptTotals(after), { input: 0, output: 7, cacheRead: 0, cacheCreate: 0, total: 7 });
  });

  test('파일이 상한보다 크면 뒤쪽만 읽고 partial 로 표시한다(잘린 첫 줄은 버린다)', async () => {
    const real = fixture('claude-transcript-ended-b.jsonl');
    const filler = `${JSON.stringify({ type: 'user', pad: 'y'.repeat(500) })}\n`;
    let head = '';
    while (head.length < 40_000) head += filler;
    const p = write('big.jsonl', head + real);
    const cap = Buffer.byteLength(real, 'utf8') + 137; // 경계가 filler 줄 한가운데 오도록
    const state = (await readClaudeTranscriptUsage(p, undefined, cap))!;
    assert.equal(state.partial, true);
    assert.equal(state.offset, Buffer.byteLength(head + real, 'utf8'), '끝까지 소비했다');
    // 앞을 건너뛰었지만 실제 usage 줄은 전부 뒤쪽에 있으므로 합계는 온전하다.
    assert.deepEqual(claudeTranscriptTotals(state), claudeTranscriptTotals(scan('claude-transcript-ended-b.jsonl')));
  });

  test('상한 안에 줄바꿈이 하나도 없으면 그 구간을 포기한다(같은 자리를 영원히 다시 읽지 않는다)', async () => {
    const p = write('oneline.jsonl', 'z'.repeat(5000));
    const state = (await readClaudeTranscriptUsage(p, undefined, 100))!;
    assert.equal(state.partial, true);
    assert.ok(state.offset > 0);
  });

  test('줄이 아직 완성되지 않았으면 소비하지 않는다(다음 판에 다시 본다)', async () => {
    const p = write('half.jsonl', '{"type":"assistant","message":{"id":"msg_a"');
    const state = (await readClaudeTranscriptUsage(p))!;
    assert.equal(state.offset, 0);
    assert.equal(claudeTranscriptTotals(state), null);
  });

  test('없는 파일 · 폴더 · 빈 경로는 null(이전 값을 유지하라는 뜻)', async () => {
    assert.equal(await readClaudeTranscriptUsage(path.join(tmp, 'nope.jsonl')), null);
    assert.equal(await readClaudeTranscriptUsage(tmp), null);
    assert.equal(await readClaudeTranscriptUsage(''), null);
  });

  test('빈 파일은 오프셋 0 짜리 빈 상태', async () => {
    const state = (await readClaudeTranscriptUsage(write('empty.jsonl', '')))!;
    assert.equal(state.offset, 0);
    assert.equal(claudeTranscriptTotals(state), null);
  });
});

// ---- T45: 서브에이전트 transcript ------------------------------------------------------------
//
// CLI 2.1.275 는 서브에이전트(Task 도구) 줄을 본 transcript 에 섞지 않고
// `<sessionId>/subagents/agent-*.jsonl` 로 따로 쓴다(T43-5 §남은 것).
//
// 아래 픽스처 5개는 **이번 태스크에서 직접 돌린 실기 세션 2개**를 그대로 옮긴 것이다(`attachment` 줄만 뺐다 —
// usage 를 들고 있지 않다). 세션은 sandbox 에서 `claude.exe` 2.1.275 를 pty 로 띄워 Task 도구를 쓰게 한 뒤
// `/exit` 로 끝냈다. `-p`(print) 모드는 **cost-state 를 안 남긴다** — 그래서 대화형으로 돌렸다.
//
//   claude-transcript-agents-main.jsonl   f56e74cf-… (서브에이전트 1개)
//   claude-transcript-agents2-main.jsonl  a2281b58-… (서브에이전트 2개)

/** 그 픽스처들의 세션 묶음. main 은 끝난 세션이라 cost-state 를 들고 있다. */
const SESSIONS = [
  { main: 'claude-transcript-agents-main.jsonl', subs: ['claude-transcript-agents-sub1.jsonl'] },
  { main: 'claude-transcript-agents2-main.jsonl', subs: ['claude-transcript-agents2-sub1.jsonl', 'claude-transcript-agents2-sub2.jsonl'] },
] as const;

describe('ClaudeTranscriptUsage — 서브에이전트 몫은 cost-state 에 **들어 있다**(T45)', () => {
  // 이것이 T45 의 판정 근거다. cost-state 가 서브에이전트를 포함하지 **않는다면** 본 파일만으로 맞아떨어져야
  // 하는데, 실측은 정반대다: 본 파일만으로는 `cacheCreate` 가 절반 가까이 모자라고, 서브에이전트 파일을 더하면
  // 0.2% 안으로 들어온다. → 살아 있는 동안에도 더해야 세션이 끝날 때 값이 튀지 않고 수렴한다.
  for (const { main, subs } of SESSIONS) {
    test(`${main}: 본 파일만 < cost-state, 본+서브 ≈ cost-state`, () => {
      const { visible } = splitCostState(fixture(main));
      const mainOnly = claudeTranscriptTotals(scan(main))!;
      const withSubs = claudeTotalsOf([scan(main), ...subs.map((s) => scan(s))])!;

      // `cacheCreate` 로 가른다 — 세션 끝의 숨은 호출(T43-5)은 캐시를 **읽기만** 하므로 이 칸을 흐리지 않는다.
      const off = (got: number, want: number): number => Math.abs(got - want) / want;
      assert.ok(off(mainOnly.cacheCreate!, visible.cacheCreate!) > 0.4, `본 파일만: ${mainOnly.cacheCreate} vs ${visible.cacheCreate}`);
      assert.ok(off(withSubs.cacheCreate!, visible.cacheCreate!) < 0.002, `본+서브: ${withSubs.cacheCreate} vs ${visible.cacheCreate}`);
      // 출력 토큰도 같은 방향으로 움직인다(숨은 호출 몫 몇십 개만 남는다).
      assert.ok(withSubs.output! > mainOnly.output!);
      assert.ok(off(withSubs.output!, visible.output!) < 0.03, `output ${withSubs.output} vs ${visible.output}`);
      // 총합은 여전히 모자란다 — 남은 차이는 T43-5 가 밝힌 숨은 호출의 `cacheRead` 다(못 세는 게 맞다).
      assert.ok(withSubs.total! < visible.total!);
      assert.ok(withSubs.cacheRead! < visible.cacheRead!);
    });
  }

  test('실측 숫자 그대로(픽스처가 바뀌면 여기서 깨진다)', () => {
    assert.deepEqual(claudeTranscriptTotals(scan('claude-transcript-agents-main.jsonl')), {
      input: 4, output: 445, cacheRead: 75311, cacheCreate: 14769, total: 90529,
    });
    assert.deepEqual(claudeTranscriptTotals(scan('claude-transcript-agents-sub1.jsonl')), {
      input: 4, output: 132, cacheRead: 54222, cacheCreate: 13720, total: 68078,
    });
    assert.deepEqual(claudeTotalsOf([scan('claude-transcript-agents-main.jsonl'), scan('claude-transcript-agents-sub1.jsonl')]), {
      input: 8, output: 577, cacheRead: 129533, cacheCreate: 28489, total: 158607,
    });
    assert.deepEqual(claudeTotalsOf(SESSIONS[1].subs.map((s) => scan(s))), {
      input: 10, output: 1234, cacheRead: 147500, cacheCreate: 27582, total: 176326,
    });
  });

  test('본 파일과 서브에이전트 파일의 message.id 는 겹치지 않는다(더해도 이중 계산이 아니다)', () => {
    for (const { main, subs } of SESSIONS) {
      const mainIds = new Set(scan(main).seenIds);
      for (const s of subs) {
        for (const id of scan(s).seenIds) assert.ok(!mainIds.has(id), `${s} 의 ${id} 가 본 파일에도 있다`);
      }
    }
  });

  test('claudeTotalsOf: 빈 목록·셀 것 없는 상태는 null(0 이 아니다)', () => {
    assert.equal(claudeTotalsOf([]), null);
    assert.equal(claudeTotalsOf([emptyClaudeTranscriptState('a'), emptyClaudeTranscriptState('b')]), null);
    assert.deepEqual(claudeTotalsOf([emptyClaudeTranscriptState('a'), scan('claude-transcript-agents-sub1.jsonl')]), {
      input: 4, output: 132, cacheRead: 54222, cacheCreate: 13720, total: 68078,
    });
  });

  test('addUsageTokens: null 은 건너뛰고, 모르는 칸(null)만 null 로 남는다', () => {
    const a = { input: 1, output: 2, cacheRead: 3, cacheCreate: 4, total: 10 };
    assert.equal(addUsageTokens(null, null), null);
    assert.deepEqual(addUsageTokens(a, null), a);
    assert.deepEqual(addUsageTokens(null, a), a);
    assert.deepEqual(addUsageTokens(a, a), { input: 2, output: 4, cacheRead: 6, cacheCreate: 8, total: 20 });
    // Codex 파서는 모르는 칸을 null 로 준다 — 아는 쪽을 버리지 않는다.
    const partial = { input: null, output: 5, cacheRead: null, cacheCreate: null, total: 5 };
    assert.deepEqual(addUsageTokens(partial, partial), { input: null, output: 10, cacheRead: null, cacheCreate: null, total: 10 });
    assert.deepEqual(addUsageTokens(a, partial), { input: 1, output: 7, cacheRead: 3, cacheCreate: 4, total: 15 });
  });
});

describe('listClaudeSubagentFiles — 폴더 규칙 · 새것부터 · 상한', () => {
  /** 실측 배치: `<dir>/<sessionId>.jsonl` 옆에 `<dir>/<sessionId>/subagents/agent-*.jsonl`. */
  const layout = (session: string, agents: { name: string; text?: string; mtime?: number }[]): string => {
    const main = path.join(tmp, `${session}.jsonl`);
    fs.writeFileSync(main, '');
    const dir = path.join(tmp, session, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    for (const a of agents) {
      const p = path.join(dir, a.name);
      fs.writeFileSync(p, a.text ?? '');
      if (a.mtime !== undefined) fs.utimesSync(p, a.mtime / 1000, a.mtime / 1000);
    }
    return main;
  };

  test('경로 규칙: `<sessionId>.jsonl` → `<sessionId>/subagents`', () => {
    const p = path.join('C:', 'p', 'D--x', 'abc.jsonl');
    assert.equal(claudeSubagentsDir(p), path.join('C:', 'p', 'D--x', 'abc', 'subagents'));
    assert.equal(claudeSubagentsDir('rollout.jsonl'), path.join('rollout', 'subagents'));
    assert.equal(claudeSubagentsDir('t.log'), null, '.jsonl 이 아니면 서브에이전트 폴더를 짐작하지 않는다');
    assert.equal(claudeSubagentsDir(''), null);
  });

  test('`agent-*.jsonl` 만 센다(`.meta.json` 은 usage 를 안 들고 있다)', async () => {
    const main = layout('s1', [
      { name: 'agent-a1.jsonl' },
      { name: 'agent-a1.meta.json' },
      { name: 'agent-a2.jsonl' },
      { name: 'notes.txt' },
      { name: 'agent-.jsonl' }, // id 가 비었다 — agent-<id> 모양이 아니다
    ]);
    const got = await listClaudeSubagentFiles(main);
    assert.deepEqual(got.map((p) => path.basename(p)).sort(), ['agent-a1.jsonl', 'agent-a2.jsonl']);
  });

  test('새것부터 `cap` 개까지', async () => {
    const base = Date.parse('2026-09-21T00:00:00.000Z');
    const main = layout('s2', [
      { name: 'agent-old.jsonl', mtime: base },
      { name: 'agent-mid.jsonl', mtime: base + 10_000 },
      { name: 'agent-new.jsonl', mtime: base + 20_000 },
    ]);
    assert.deepEqual((await listClaudeSubagentFiles(main)).map((p) => path.basename(p)), ['agent-new.jsonl', 'agent-mid.jsonl', 'agent-old.jsonl']);
    assert.deepEqual((await listClaudeSubagentFiles(main, 2)).map((p) => path.basename(p)), ['agent-new.jsonl', 'agent-mid.jsonl']);
    assert.deepEqual(await listClaudeSubagentFiles(main, 0), [], '상한 0 이면 아무것도 안 따라간다');
  });

  test('폴더가 없으면 빈 배열(Task 를 한 번도 안 쓴 세션 — 정상)', async () => {
    const main = path.join(tmp, 'lonely.jsonl');
    fs.writeFileSync(main, '');
    assert.deepEqual(await listClaudeSubagentFiles(main), []);
    assert.deepEqual(await listClaudeSubagentFiles(path.join(tmp, 'nope.jsonl')), []);
    assert.deepEqual(await listClaudeSubagentFiles(''), []);
  });

  test('기본 상한은 50', () => {
    assert.equal(MAX_SUBAGENT_FILES, 50);
  });

  test('실측 파일을 그대로 읽어도 같은 합이 나온다(증분 읽기 경로)', async () => {
    const main = layout('s3', [
      { name: 'agent-a6a406eca7a21eed3.jsonl', text: fixture('claude-transcript-agents-sub1.jsonl') },
    ]);
    const [file] = await listClaudeSubagentFiles(main);
    const state = (await readClaudeTranscriptUsage(file!))!;
    assert.deepEqual(claudeTranscriptTotals(state), {
      input: 4, output: 132, cacheRead: 54222, cacheCreate: 13720, total: 68078,
    });
  });
});
