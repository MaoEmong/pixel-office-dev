// T43-1 UsageTracker — 변화 감지 · 영속 · 상태 줄 · 턴 종료 꼬리 읽기 · 연결 폴링.
// 입력은 실측 픽스처(`test/fixtures/usage/`)를 그대로 쓴다.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/store/Store.js';
import { UsageTracker } from '../../src/usage/UsageTracker.js';
import type { ClaudeTranscriptState } from '../../src/usage/ClaudeTranscriptUsage.js';
import type { EngineConnection, EngineUsage, MemberUsage } from '../../src/usage/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../fixtures/usage');
const read = (f: string): string => fs.readFileSync(path.join(fixtures, f), 'utf8');
const statusLine = (n: number): unknown => JSON.parse(read('claude-statusline.jsonl').split(/\r?\n/).filter(Boolean)[n]!);

const CLAUDE = { id: 'm_claude', engine: 'claude' as const };
const CODEX = { id: 'm_codex', engine: 'codex' as const };

/** store 없이 쓰는 최소 가짜(영속 경로를 안 타는 테스트용). */
function memStore(): Store {
  const store = new Store(':memory:');
  const dept = store.createDepartment({ name: 'alpha', cwd: 'D:/a' });
  store.createMember({ id: CLAUDE.id, departmentId: dept.id, name: '반장', rank: 'head', engine: 'claude', cwd: 'D:/a', hiredBy: 'user' });
  store.createMember({ id: CODEX.id, departmentId: dept.id, name: '이음', rank: 'head', engine: 'codex', cwd: 'D:/a', hiredBy: 'user' });
  return store;
}

interface Harness {
  store: Store;
  tracker: UsageTracker;
  engines: EngineUsage[];
  members: MemberUsage[];
  tick(ms: number): void;
  now(): number;
}

function harness(opts: Partial<{ store: Store; probeClaude: () => Promise<EngineConnection>; probeCodex: () => Promise<EngineConnection>; readTail: (f: string) => Promise<string>; readClaudeTranscript: (f: string, prev?: ClaudeTranscriptState) => Promise<ClaudeTranscriptState | null>; listClaudeSubagents: (f: string) => Promise<string[]>; refreshMs: number }> = {}): Harness {
  let clock = Date.parse('2026-09-21T10:00:00.000Z');
  const store = opts.store ?? memStore();
  const engines: EngineUsage[] = [];
  const members: MemberUsage[] = [];
  const tracker = new UsageTracker({
    store,
    now: () => clock,
    pollIntervalMs: 0,
    refreshMs: opts.refreshMs ?? 60_000,
    probeClaude: opts.probeClaude ?? (async () => ({ connected: true, plan: 'max', reason: null })),
    probeCodex: opts.probeCodex ?? (async () => ({ connected: true, plan: null, reason: null })),
    ...(opts.readTail ? { readTail: opts.readTail } : {}),
    ...(opts.readClaudeTranscript ? { readClaudeTranscript: opts.readClaudeTranscript } : {}),
    ...(opts.listClaudeSubagents ? { listClaudeSubagents: opts.listClaudeSubagents } : {}),
  });
  tracker.on('engine', (u) => engines.push(u));
  tracker.on('member', (u) => members.push(u));
  return { store, tracker, engines, members, tick: (ms) => { clock += ms; }, now: () => clock };
}

let h: Harness;
afterEach(() => {
  h?.tracker.stop();
  h?.store.close();
});

describe('UsageTracker — statusLine', () => {
  beforeEach(() => {
    h = harness();
  });

  test('턴 종료 직후 페이로드: 엔진 한도 + 멤버 컨텍스트·비용이 한 번에 들어온다', () => {
    const line = h.tracker.applyStatusLine(CLAUDE, statusLine(1));
    const engine = h.tracker.engineUsage('claude');
    // 1790132400 = 2026-09-23 12pm (Asia/Seoul) — 실측 /usage 화면의 "Resets Sep 23, 12pm" 과 같은 시각.
    assert.deepEqual(engine.weekly, { usedPercent: 54, resetsAt: '2026-09-23T03:00:00.000Z' });
    assert.equal(engine.session?.usedPercent, 17);
    assert.equal(engine.updatedAt, '2026-09-21T10:00:00.000Z');

    const member = h.tracker.memberUsage(CLAUDE.id)!;
    assert.deepEqual(member.context, { used: 43910, window: 1_000_000, percent: 4 });
    assert.equal(member.costUsd, 0.16072150000000002);
    assert.equal(member.tokens, null, 'statusLine 은 누적 토큰을 주지 않는다');

    assert.equal(line, '컨텍스트 4% · 주간 46% 남음', '상태 줄은 주간을 "남음" 으로 말한다');
    assert.equal(h.engines.length, 1);
    assert.equal(h.members.length, 1);
  });

  test('첫 턴 전 페이로드: rate_limits 가 없어 엔진 한도를 건드리지 않는다(마지막 값 유지)', () => {
    h.tracker.applyStatusLine(CLAUDE, statusLine(1));
    h.engines.length = 0;
    h.tracker.applyStatusLine(CLAUDE, statusLine(0)); // 한도 없음 · 컨텍스트 0
    assert.equal(h.engines.length, 0, '엔진 알림이 나가면 안 된다');
    assert.equal(h.tracker.engineUsage('claude').weekly?.usedPercent, 54);
  });

  test('--resume 직후 페이로드도 한도를 지우지 않는다', () => {
    h.tracker.applyStatusLine(CLAUDE, statusLine(1));
    h.engines.length = 0;
    h.tracker.applyStatusLine(CLAUDE, JSON.parse(read('claude-statusline-resume.json')));
    assert.equal(h.engines.length, 0);
    assert.equal(h.tracker.engineUsage('claude').weekly?.usedPercent, 54);
  });

  test('상태 줄: 모르는 칸은 뺀다 / 둘 다 모르면 빈 문자열', () => {
    assert.equal(h.tracker.statusLineText('없는멤버', 'claude'), '');
    // 컨텍스트만 아는 상태(한도 없는 페이로드)
    const text = h.tracker.applyStatusLine(CLAUDE, JSON.parse(read('claude-statusline-resume.json')));
    assert.equal(text, '컨텍스트 4%');
  });
});

describe('UsageTracker — 변화 감지', () => {
  beforeEach(() => {
    h = harness();
  });

  test('같은 페이로드를 다시 주면 알림이 나가지 않는다', () => {
    h.tracker.applyStatusLine(CLAUDE, statusLine(1));
    assert.equal(h.engines.length, 1);
    assert.equal(h.members.length, 1);
    for (const n of [2, 3, 4, 5]) h.tracker.applyStatusLine(CLAUDE, statusLine(n)); // 실측: 값이 같은 연속 발화
    assert.equal(h.engines.length, 1, '값이 같으면 조용하다');
    assert.equal(h.members.length, 1);
  });

  test('값이 같아도 refreshMs 가 지나면 updatedAt 만 올려 한 번 민다', () => {
    h.tracker.applyStatusLine(CLAUDE, statusLine(1));
    h.tick(59_000);
    h.tracker.applyStatusLine(CLAUDE, statusLine(2));
    assert.equal(h.engines.length, 1, '아직 60초 전');
    h.tick(2_000);
    h.tracker.applyStatusLine(CLAUDE, statusLine(3));
    assert.equal(h.engines.length, 2, '60초가 지나면 신선도를 갱신한다');
    assert.equal(h.engines[1]!.weekly?.usedPercent, 54, '값은 그대로');
    assert.equal(h.engines[1]!.updatedAt, '2026-09-21T10:01:01.000Z');
  });

  test('값이 바뀌면 refreshMs 와 무관하게 바로 민다', () => {
    h.tracker.applyStatusLine(CLAUDE, statusLine(1));
    const changed = { ...(statusLine(1) as Record<string, unknown>), rate_limits: { seven_day: { used_percentage: 55, resets_at: 1790132400 } } };
    h.tick(10);
    h.tracker.applyStatusLine(CLAUDE, changed);
    assert.equal(h.engines.length, 2);
    assert.equal(h.engines[1]!.weekly?.usedPercent, 55);
    assert.equal(h.engines[1]!.session?.usedPercent, 17, '주지 않은 칸은 유지된다');
  });

  test('연결 상태만 바뀌면 updatedAt(한도 확인 시각)은 그대로다', async () => {
    h.tracker.applyStatusLine(CLAUDE, statusLine(1));
    const at = h.tracker.engineUsage('claude').updatedAt;
    h.tick(10 * 60_000);
    await h.tracker.pollConnections();
    const after = h.tracker.engineUsage('claude');
    assert.equal(after.connected, true);
    assert.equal(after.plan, 'max');
    assert.equal(after.updatedAt, at, '한도를 다시 확인한 게 아니다');
  });

  test('같은 연결 결과를 다시 받으면 조용하다', async () => {
    await h.tracker.pollConnections();
    const n = h.engines.length;
    await h.tracker.pollConnections();
    assert.equal(h.engines.length, n);
  });
});

describe('UsageTracker — 턴 종료(꼬리 읽기)', () => {
  test('Claude Stop: transcript 의 마지막 cost-state 로 누적 토큰·비용', async () => {
    h = harness({ readTail: async () => read('claude-transcript-tail.jsonl') });
    h.tracker.applyStatusLine(CLAUDE, statusLine(1)); // 먼저 컨텍스트가 들어와 있다
    await h.tracker.applyTurnEnd(CLAUDE, 'C:/x/transcript.jsonl');
    const m = h.tracker.memberUsage(CLAUDE.id)!;
    assert.deepEqual(m.tokens, { input: 912, output: 17, cacheRead: 29413, cacheCreate: 14495, total: 44837 });
    assert.deepEqual(m.context, { used: 43910, window: 1_000_000, percent: 4 }, '컨텍스트는 유지된다');
    assert.equal(m.costUsd, 0.16072150000000002);
  });

  test('Codex Stop: rollout 의 token_count 로 엔진 한도 + 멤버 컨텍스트·토큰(비용은 null)', async () => {
    h = harness({ readTail: async () => read('codex-rollout-tail.jsonl') });
    await h.tracker.applyTurnEnd(CODEX, 'C:/x/rollout.jsonl');
    const e = h.tracker.engineUsage('codex');
    assert.deepEqual(e.weekly, { usedPercent: 12, resetsAt: '2026-09-28T05:02:18.000Z' });
    assert.equal(e.session, null, 'Pro 계정은 secondary 가 없다');
    assert.equal(e.plan, 'pro');
    const m = h.tracker.memberUsage(CODEX.id)!;
    assert.deepEqual(m.context, { used: 21868, window: 258400, percent: 8 });
    assert.equal(m.tokens?.total, 43726);
    assert.equal(m.costUsd, null, 'Codex 는 비용을 주지 않는다');
  });

  test('파일이 없거나(꼬리 빈 문자열) 경로가 없으면 이전 값을 그대로 둔다', async () => {
    h = harness({ readTail: async () => read('codex-rollout-tail.jsonl') });
    await h.tracker.applyTurnEnd(CODEX, 'C:/x/rollout.jsonl');
    const before = h.tracker.memberUsage(CODEX.id)!;
    h.tracker.stop();
    h.store.close();

    h = harness({ readTail: async () => '' });
    await h.tracker.applyTurnEnd(CODEX, 'C:/x/gone.jsonl');
    assert.equal(h.tracker.memberUsage(CODEX.id), undefined, '값이 없던 멤버는 그대로 없음');
    await h.tracker.applyTurnEnd(CODEX, null);
    await h.tracker.applyTurnEnd(CODEX, undefined);
    assert.equal(h.members.length, 0);
    assert.ok(before.tokens, '(앞 harness 에서는 값이 들어왔었다)');
  });

  test('꼬리 읽기가 던져도 삼킨다', async () => {
    h = harness({
      readTail: async () => {
        throw new Error('locked');
      },
    });
    await assert.doesNotReject(() => h.tracker.applyTurnEnd(CLAUDE, 'C:/x/t.jsonl'));
    assert.equal(h.members.length, 0);
  });
});

describe('UsageTracker — 연결 폴링', () => {
  test('exe 없음 / 로그아웃 / 오류가 reason 으로 들어온다', async () => {
    h = harness({
      probeClaude: async () => ({ connected: false, plan: null, reason: 'not-installed' }),
      probeCodex: async () => ({ connected: false, plan: null, reason: 'logged-out' }),
    });
    await h.tracker.pollConnections();
    assert.equal(h.tracker.engineUsage('claude').reason, 'not-installed');
    assert.equal(h.tracker.engineUsage('codex').reason, 'logged-out');
    assert.equal(h.tracker.engineUsage('codex').connected, false);
  });

  test('폴링이 던져도 unknown 으로 떨어지고 데몬은 산다', async () => {
    h = harness({
      probeClaude: async () => {
        throw new Error('boom');
      },
    });
    await assert.doesNotReject(() => h.tracker.pollConnections());
    assert.equal(h.tracker.engineUsage('claude').reason, 'unknown');
  });

  test('요금제는 덮어쓰지 않는다 — codex 요금제는 rollout 에서 온다', async () => {
    h = harness({ readTail: async () => read('codex-rollout-tail.jsonl') });
    await h.tracker.applyTurnEnd(CODEX, 'C:/x/rollout.jsonl');
    assert.equal(h.tracker.engineUsage('codex').plan, 'pro');
    await h.tracker.pollConnections(); // login status 는 요금제를 주지 않는다(plan:null)
    assert.equal(h.tracker.engineUsage('codex').plan, 'pro');
  });

  test('연결 결과에 이메일·계정 식별자가 섞여 들어올 길이 없다', async () => {
    // 프로브가 (있을 수 없는) 여분 키를 돌려줘도 EngineUsage 에는 정해진 칸만 실린다.
    h = harness({
      probeClaude: async () => ({ connected: true, plan: 'max', reason: null, email: 'someone@example.com', orgId: 'org_1' } as EngineConnection),
    });
    await h.tracker.pollConnections();
    const e = h.tracker.engineUsage('claude');
    assert.deepEqual(Object.keys(e).sort(), ['connected', 'engine', 'models', 'plan', 'reason', 'session', 'source', 'updatedAt', 'weekly']);
    assert.ok(!JSON.stringify(e).includes('@'), JSON.stringify(e));
    assert.ok(!JSON.stringify(e).includes('org_'), JSON.stringify(e));
    // 스냅샷 전체에도 없다.
    assert.ok(!JSON.stringify(h.tracker.snapshotUsage()).includes('@'));
  });
});

describe('UsageTracker — 스냅샷·영속', () => {
  test('스냅샷에는 엔진 둘이 항상 실리고, 한 번도 못 본 엔진은 reason:unknown', () => {
    h = harness();
    const snap = h.tracker.snapshotUsage();
    assert.deepEqual(snap.engines.map((e) => e.engine), ['claude', 'codex']);
    assert.deepEqual(snap.engines.map((e) => e.reason), ['unknown', 'unknown']);
    assert.deepEqual(snap.engines.map((e) => e.weekly), [null, null]);
    assert.deepEqual(snap.members, []);
  });

  test('DB 에 남긴 값을 새 tracker 가 그대로 읽는다(엔진은 남고 멤버는 멤버와 함께 사라진다)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-usage-'));
    try {
      const dbPath = path.join(dir, 'u.db');
      const store = new Store(dbPath);
      const dept = store.createDepartment({ name: 'alpha', cwd: 'D:/a' });
      store.createMember({ id: CLAUDE.id, departmentId: dept.id, name: '반장', rank: 'head', engine: 'claude', cwd: 'D:/a', hiredBy: 'user' });
      h = harness({ store });
      h.tracker.applyStatusLine(CLAUDE, statusLine(1));
      h.tracker.stop();
      store.close();

      const reopened = new Store(dbPath);
      const again = new UsageTracker({ store: reopened, pollIntervalMs: 0 });
      assert.equal(again.engineUsage('claude').weekly?.usedPercent, 54);
      assert.equal(again.memberUsage(CLAUDE.id)?.context?.percent, 4);
      assert.equal(again.snapshotUsage().members.length, 1);

      // 멤버가 사라지면(부서 삭제) 행도 사라진다.
      reopened.deleteDepartment(dept.id);
      const third = new UsageTracker({ store: reopened, pollIntervalMs: 0 });
      assert.deepEqual(third.snapshotUsage().members, []);
      assert.equal(third.engineUsage('claude').weekly?.usedPercent, 54, '엔진 값은 남는다');
      reopened.close();
      h = harness(); // afterEach 가 닫을 것
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('removeMember: 메모리와 DB 행을 함께 지운다', () => {
    h = harness();
    h.tracker.applyStatusLine(CLAUDE, statusLine(1));
    assert.equal(h.tracker.snapshotUsage().members.length, 1);
    h.tracker.removeMember(CLAUDE.id);
    assert.deepEqual(h.tracker.snapshotUsage().members, []);
    assert.deepEqual(h.store.listMemberUsage(), []);
  });

  test('DB 에 없는 멤버의 값은 pruneMissingMembers 로 정리된다', () => {
    h = harness();
    h.tracker.applyStatusLine({ id: 'm_ghost', engine: 'claude' }, statusLine(1));
    assert.equal(h.tracker.memberUsage('m_ghost')?.engine, 'claude', 'FK 로 저장은 실패해도 메모리에는 남는다');
    h.tracker.pruneMissingMembers();
    assert.equal(h.tracker.memberUsage('m_ghost'), undefined);
  });
});

// ---- T43-4: 확인용 세션과 턴 종료 값의 합류 ------------------------------------------------

describe('UsageTracker — 출처 병합(probe ↔ turn)', () => {
  const probeWeekly = (p: number) => ({ usedPercent: p, resetsAt: '2026-09-23T03:00:00.000Z' });

  test('확인용 세션이 읽은 값은 source:"probe" 로 실리고 models 도 같이 온다', () => {
    h = harness();
    h.tracker.applyProbe('claude', { weekly: probeWeekly(40), session: probeWeekly(10), models: [{ label: 'Fable', usedPercent: 40, resetsAt: null }] });
    const u = h.tracker.engineUsage('claude');
    assert.equal(u.weekly?.usedPercent, 40);
    assert.equal(u.source, 'probe');
    assert.deepEqual(u.models.map((m) => m.label), ['Fable']);
  });

  test('턴 종료가 더 최근이면 턴이 이긴다', () => {
    h = harness();
    const t0 = h.now();
    h.tracker.applyProbe('claude', { weekly: probeWeekly(40) }, t0);
    h.tick(30_000);
    h.tracker.applyStatusLine(CLAUDE, statusLine(1)); // 실측 주간 54%
    const u = h.tracker.engineUsage('claude');
    assert.equal(u.weekly?.usedPercent, 54);
    assert.equal(u.source, 'turn');
  });

  test('확인용 세션이 더 최근이면 확인용 세션이 이긴다', () => {
    h = harness();
    h.tracker.applyStatusLine(CLAUDE, statusLine(1)); // 54%
    h.tick(30_000);
    h.tracker.applyProbe('claude', { weekly: probeWeekly(40) });
    const u = h.tracker.engineUsage('claude');
    assert.equal(u.weekly?.usedPercent, 40);
    assert.equal(u.source, 'probe');
  });

  test('**늦게 도착한 옛 측정**은 버린다(화면을 읽은 시각 기준)', () => {
    h = harness();
    const t0 = h.now();
    h.tick(60_000);
    h.tracker.applyStatusLine(CLAUDE, statusLine(1)); // 지금(= t0+60초) 읽은 54%
    // 확인용 세션이 t0 에 읽은 화면이 파싱을 마치고 이제야 들어온다.
    h.tracker.applyProbe('claude', { weekly: probeWeekly(40) }, t0);
    const u = h.tracker.engineUsage('claude');
    assert.equal(u.weekly?.usedPercent, 54, '더 최근 측정이 남는다');
    assert.equal(u.source, 'turn');
  });

  test('칸마다 따로 견준다 — 옛 확인용 세션 값도 비어 있던 칸은 채운다', () => {
    h = harness();
    const t0 = h.now();
    h.tick(60_000);
    // 턴 종료는 주간·5시간만 준다(모델별은 화면에만 있다).
    h.tracker.applyStatusLine(CLAUDE, statusLine(1));
    h.tracker.applyProbe('claude', { weekly: probeWeekly(40), models: [{ label: 'Fable', usedPercent: 40, resetsAt: null }] }, t0);
    const u = h.tracker.engineUsage('claude');
    assert.equal(u.weekly?.usedPercent, 54, '주간은 더 최근(turn)');
    assert.deepEqual(u.models.map((m) => m.label), ['Fable'], '모델별은 아무도 안 채운 칸이라 옛 값도 들어간다');
    assert.equal(u.source, 'turn', '가장 최근 측정의 출처는 그대로');
  });

  test('확인용 세션이 준 요금제도 실린다(Codex 는 화면이 유일한 출처일 수 있다) — 소문자로', () => {
    h = harness();
    h.tracker.applyProbe('codex', { weekly: probeWeekly(12), plan: 'Pro' });
    assert.equal(h.tracker.engineUsage('codex').plan, 'pro');
  });

  test('models 는 DB 에 남고 재기동 뒤에도 그대로다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-usage4-'));
    try {
      const dbPath = path.join(dir, 'pixel-office.db');
      const store = new Store(dbPath);
      h = harness({ store });
      h.tracker.applyProbe('claude', { weekly: probeWeekly(40), models: [{ label: 'Fable', usedPercent: 40, resetsAt: null }] });
      h.tracker.stop();
      store.close();

      const reopened = new Store(dbPath);
      const again = new UsageTracker({ store: reopened, pollIntervalMs: 0 });
      const u = again.engineUsage('claude');
      assert.deepEqual(u.models.map((m) => m.label), ['Fable']);
      assert.equal(u.source, 'probe');
      reopened.close();
      h = harness();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('옛 데몬(v3)이 쓴 행에는 models·source 가 없다 — 기본값으로 읽는다', () => {
    const store = memStore();
    store.putEngineUsage('claude', { engine: 'claude', connected: true, plan: 'max', weekly: { usedPercent: 54, resetsAt: null }, session: null, updatedAt: '2026-09-21T10:00:00.000Z', reason: null });
    const tracker = new UsageTracker({ store, pollIntervalMs: 0 });
    const u = tracker.engineUsage('claude');
    assert.deepEqual(u.models, []);
    assert.equal(u.source, null);
    assert.equal(u.weekly?.usedPercent, 54);
    store.close();
    h = harness();
  });
});

// ---- 요금제 대소문자: 전선 값은 언제나 소문자 -----------------------------------------------

describe('UsageTracker — 요금제 대소문자', () => {
  const probeWeekly = (p: number) => ({ usedPercent: p, resetsAt: '2026-09-23T03:00:00.000Z' });
  const stored = (store: Store, engine: 'claude' | 'codex') =>
    store.listEngineUsage().find((r) => r.engine === engine)?.value as EngineUsage | undefined;

  test('화면 "Pro" 와 rollout "pro" 는 같은 값이다 — 소문자로 실리고 대소문자만으로는 다시 밀지 않는다', () => {
    h = harness();
    h.tracker.applyProbe('codex', { weekly: probeWeekly(12), plan: 'Pro' }); // /status 화면은 "Pro"
    assert.equal(h.tracker.engineUsage('codex').plan, 'pro', '전선에 나가는 값은 언제나 소문자');
    assert.equal(h.engines.length, 1);
    assert.equal(stored(h.store, 'codex')?.plan, 'pro', 'DB 에도 소문자로 남는다');

    // 턴 종료(rollout `plan_type`)가 같은 요금제를 다른 대소문자로 들고 온다.
    h.tracker.applyProbe('codex', { weekly: probeWeekly(12), plan: 'pro' });
    assert.equal(h.tracker.engineUsage('codex').plan, 'pro');
    assert.equal(h.engines.length, 1, '대소문자만 다른 값은 변화가 아니다 — 알림도 저장도 없다');

    // 공백뿐인 요금제는 "값 없음" 이라 한도 변화가 없으면 아무 일도 하지 않는다.
    h.tracker.applyProbe('codex', { plan: '   ' });
    assert.equal(h.tracker.engineUsage('codex').plan, 'pro');
    assert.equal(h.engines.length, 1);
  });

  test('연결 폴링이 준 요금제도 소문자로 — "Max" 가 "max" 로 실린다', () => {
    h = harness();
    h.tracker.setConnection('claude', { connected: true, plan: 'Max', reason: null });
    assert.equal(h.tracker.engineUsage('claude').plan, 'max');
    assert.equal(stored(h.store, 'claude')?.plan, 'max');
  });

  test('DB 에 남은 옛 대문자 요금제는 읽을 때 고친다(다음 측정을 기다리지 않는다)', () => {
    const store = memStore();
    store.putEngineUsage('codex', { engine: 'codex', connected: true, plan: 'Pro', weekly: { usedPercent: 12, resetsAt: null }, session: null, models: [], source: 'probe', updatedAt: '2026-09-21T10:00:00.000Z', reason: null });
    // 모양이 깨진 행(요금제가 문자열이 아니다)도 죽지 않고 "모른다" 로 떨어진다.
    store.putEngineUsage('claude', { engine: 'claude', connected: true, plan: 42, weekly: null, session: null, models: [], source: null, updatedAt: null, reason: null });
    const tracker = new UsageTracker({ store, pollIntervalMs: 0 });
    assert.equal(tracker.engineUsage('codex').plan, 'pro');
    assert.equal(tracker.engineUsage('codex').weekly?.usedPercent, 12, '나머지 값은 그대로');
    assert.equal(tracker.engineUsage('claude').plan, null);
    store.close();
    h = harness();
  });
});

// ---- T43-5: Claude 캐릭터의 누적 토큰 -------------------------------------------------------
//
// `cost-state` 는 **CLI 가 끝날 때만** 적힌다 — 살아 있는 멤버에게는 0개다(실측). 그래서 살아 있는 동안에는
// transcript 의 assistant 줄을 증분으로 더하고, `cost-state` 가 나타나면 그쪽이 최종값으로 이긴다.
// 여기서는 **진짜 파일**을 쓴다(꼬리 읽기·증분 읽기를 둘 다 실제로 태운다).

describe('UsageTracker — Claude 누적 토큰(T43-5)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-usage-tx-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 실측 픽스처에서 `cost-state` 줄만 뺀 것 = "아직 살아 있는 세션" 의 모양. */
  const live = (name: string): string =>
    read(name)
      .split('\n')
      .filter((l) => l !== '' && !l.includes('"cost-state"'))
      .join('\n') + '\n';

  const file = (name: string, text: string): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text);
    return p;
  };

  test('살아 있는 세션(cost-state 0개)에서도 토큰이 들어온다 — 이게 T43-5 의 결함이었다', async () => {
    h = harness();
    const p = file('t.jsonl', live('claude-transcript-ended-a.jsonl'));
    await h.tracker.applyTurnEnd(CLAUDE, p);
    const m = h.tracker.memberUsage(CLAUDE.id)!;
    // 실측 assistant 줄 하나(in 2 · out 3 · cacheRead 29413 · cacheCreate 14495).
    assert.deepEqual(m.tokens, { input: 2, output: 3, cacheRead: 29413, cacheCreate: 14495, total: 43913 });
    assert.equal(m.costUsd, null, '비용은 statusLine 몫 — 여기서 만들어 내지 않는다');
  });

  test('턴이 이어지면 증분으로 늘어난다(같은 파일을 다시 처음부터 읽지 않는다)', async () => {
    const full = live('claude-transcript-ended-b.jsonl');
    const cut = full.lastIndexOf('\n', Math.floor(full.length / 2)) + 1;
    h = harness();
    const p = file('t.jsonl', full.slice(0, cut));
    await h.tracker.applyTurnEnd(CLAUDE, p);
    const first = h.tracker.memberUsage(CLAUDE.id)!.tokens!;
    assert.ok((first.total ?? 0) > 0);

    fs.appendFileSync(p, full.slice(cut));
    h.tick(60_000);
    await h.tracker.applyTurnEnd(CLAUDE, p);
    const second = h.tracker.memberUsage(CLAUDE.id)!.tokens!;
    assert.deepEqual(second, { input: 8, output: 670, cacheRead: 186663, cacheCreate: 12536, total: 199877 });
    assert.ok((second.total ?? 0) > (first.total ?? 0), '늘어났다');
  });

  test('세션이 끝나 cost-state 가 생기면 **그쪽이 이긴다**(배경 haiku 까지 들어간 CLI 자신의 값)', async () => {
    h = harness();
    const p = file('t.jsonl', live('claude-transcript-ended-a.jsonl'));
    await h.tracker.applyTurnEnd(CLAUDE, p);
    assert.equal(h.tracker.memberUsage(CLAUDE.id)!.tokens!.total, 43913, '줄 합');

    fs.writeFileSync(p, read('claude-transcript-ended-a.jsonl')); // 같은 파일 + cost-state
    h.tick(60_000);
    await h.tracker.applyTurnEnd(CLAUDE, p);
    const m = h.tracker.memberUsage(CLAUDE.id)!;
    assert.deepEqual(m.tokens, { input: 912, output: 17, cacheRead: 29413, cacheCreate: 14495, total: 44837 });
    assert.equal(m.costUsd, 0.16072150000000002, 'cost-state 의 totalCostUSD 가 최종 비용');
  });

  test('statusLine 비용은 살아 있는 동안 유지되고, cost-state 가 오면 덮인다', async () => {
    h = harness();
    h.tracker.applyStatusLine(CLAUDE, statusLine(1)); // cost.total_cost_usd
    const p = file('t.jsonl', live('claude-transcript-ended-b.jsonl'));
    await h.tracker.applyTurnEnd(CLAUDE, p);
    assert.equal(h.tracker.memberUsage(CLAUDE.id)!.costUsd, 0.16072150000000002, 'statusLine 값 그대로');

    fs.writeFileSync(p, read('claude-transcript-ended-b.jsonl'));
    h.tick(60_000);
    await h.tracker.applyTurnEnd(CLAUDE, p);
    assert.equal(h.tracker.memberUsage(CLAUDE.id)!.costUsd, 0.23663849999999997, 'cost-state 가 최종값');
  });

  test('`--resume` 이 새 transcript 를 파면 리셋한다(CLI 의 /cost 와 같게)', async () => {
    h = harness();
    const a = file('a.jsonl', live('claude-transcript-ended-b.jsonl'));
    await h.tracker.applyTurnEnd(CLAUDE, a);
    assert.equal(h.tracker.memberUsage(CLAUDE.id)!.tokens!.total, 199877);

    const b = file('b.jsonl', live('claude-transcript-ended-a.jsonl'));
    h.tick(60_000);
    await h.tracker.applyTurnEnd(CLAUDE, b);
    assert.equal(h.tracker.memberUsage(CLAUDE.id)!.tokens!.total, 43913, '더하지 않고 새로 센다');
  });

  test('데몬을 재시작해도 0 이 되지 않는다 — DB 값으로 살아 있다가 첫 Stop 에 다시 훑는다', async () => {
    const store = memStore();
    h = harness({ store });
    const p = file('t.jsonl', live('claude-transcript-ended-b.jsonl'));
    await h.tracker.applyTurnEnd(CLAUDE, p);
    assert.equal(h.tracker.memberUsage(CLAUDE.id)!.tokens!.total, 199877);
    h.tracker.stop();

    // 같은 DB 로 새 tracker = 재기동. 오프셋 기억은 사라졌지만 합계는 남아 있다.
    const restarted = new UsageTracker({ store, pollIntervalMs: 0, now: h.now });
    assert.equal(restarted.memberUsage(CLAUDE.id)!.tokens!.total, 199877, '재기동 직후에도 화면이 비지 않는다');
    // 첫 Stop 에 파일을 0 부터 한 번 다시 훑어 같은 값을 되찾는다(이중 계산 없음).
    await restarted.applyTurnEnd(CLAUDE, p);
    assert.equal(restarted.memberUsage(CLAUDE.id)!.tokens!.total, 199877);
    restarted.stop();
    store.close();
    h = harness();
  });

  test('멤버가 사라지면 누적 상태도 같이 버린다(다음 멤버가 남의 숫자를 물려받지 않게)', async () => {
    h = harness();
    const p = file('t.jsonl', live('claude-transcript-ended-b.jsonl'));
    await h.tracker.applyTurnEnd(CLAUDE, p);
    assert.ok(h.tracker.memberUsage(CLAUDE.id)!.tokens);
    h.tracker.removeMember(CLAUDE.id);
    assert.equal(h.tracker.memberUsage(CLAUDE.id), undefined);

    // 같은 id 가 다시 생겨 같은 파일을 봐도 0 부터 센다(값은 같지만 오프셋이 리셋됐다는 뜻).
    await h.tracker.applyTurnEnd(CLAUDE, p);
    assert.equal(h.tracker.memberUsage(CLAUDE.id)!.tokens!.total, 199877);
  });

  test('증분 읽기가 던져도 삼키고, 꼬리의 cost-state 만으로도 값이 들어온다', async () => {
    h = harness({
      readTail: async () => read('claude-transcript-tail.jsonl'),
      readClaudeTranscript: async () => {
        throw new Error('locked');
      },
    });
    await assert.doesNotReject(() => h.tracker.applyTurnEnd(CLAUDE, 'C:/x/t.jsonl'));
    assert.equal(h.tracker.memberUsage(CLAUDE.id)!.tokens!.total, 44837);
  });

  test('Codex 는 이 길을 타지 않는다(rollout 에 assistant 줄이 없다)', async () => {
    let called = 0;
    h = harness({
      readTail: async () => read('codex-rollout-tail.jsonl'),
      readClaudeTranscript: async () => {
        called++;
        return null;
      },
    });
    await h.tracker.applyTurnEnd(CODEX, 'C:/x/rollout.jsonl');
    assert.equal(called, 0);
    assert.equal(h.tracker.memberUsage(CODEX.id)!.tokens!.total, 43726);
  });
});

// ---- T45: 서브에이전트 토큰도 더한다 ---------------------------------------------------------
//
// 근거(실측 3세션, `docs/worklog/T45-UsageAndNotice.md`): 끝난 세션의 `cost-state.modelUsage` 는
// **서브에이전트 몫을 포함한다.** 본 transcript 만 세면 `cacheCreate` 가 절반 가까이 모자라고, 서브에이전트
// 파일을 더하면 0.1% 안으로 들어온다. 그래서 살아 있는 동안에도 더해야 세션이 끝나 cost-state 가 이길 때
// 숫자가 **튀지 않고 수렴**한다.
//
// 여기서도 **진짜 파일**을 실측 배치 그대로(`<sessionId>/subagents/agent-*.jsonl`) 깔고 진짜 reader 를 태운다.

describe('UsageTracker — 서브에이전트 누적 토큰(T45)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-usage-sub-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const noCostState = (name: string): string =>
    read(name)
      .split('\n')
      .filter((l) => l !== '' && !l.includes('"cost-state"'))
      .join('\n') + '\n';

  /** `<dir>/<session>.jsonl` + `<dir>/<session>/subagents/<name>` 를 깐다. 본 transcript 경로를 준다. */
  const session = (name: string, mainText: string, subs: Record<string, string> = {}): string => {
    const main = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(main, mainText);
    const sdir = path.join(dir, name, 'subagents');
    fs.mkdirSync(sdir, { recursive: true });
    for (const [file, text] of Object.entries(subs)) fs.writeFileSync(path.join(sdir, file), text);
    return main;
  };

  const subFile = (main: string, file: string): string =>
    path.join(path.dirname(main), path.basename(main).slice(0, -'.jsonl'.length), 'subagents', file);

  test('살아 있는 동안 서브에이전트 몫이 더해진다(실측 세션 그대로)', async () => {
    h = harness();
    const p = session('s', noCostState('claude-transcript-agents-main.jsonl'), {
      'agent-a6a406eca7a21eed3.jsonl': read('claude-transcript-agents-sub1.jsonl'),
    });
    await h.tracker.applyTurnEnd(CLAUDE, p);
    // 본 파일만이면 90,529 였다. 실측 서브에이전트 68,078 이 더해져야 한다.
    assert.deepEqual(h.tracker.memberUsage(CLAUDE.id)!.tokens, {
      input: 8, output: 577, cacheRead: 129533, cacheCreate: 28489, total: 158607,
    });
  });

  test('서브에이전트가 둘이면 둘 다 더한다', async () => {
    h = harness();
    const p = session('s2', noCostState('claude-transcript-agents2-main.jsonl'), {
      'agent-a149a5109a042ff6d.jsonl': read('claude-transcript-agents2-sub1.jsonl'),
      'agent-aea6225c1b7e8c839.jsonl': read('claude-transcript-agents2-sub2.jsonl'),
    });
    await h.tracker.applyTurnEnd(CLAUDE, p);
    assert.deepEqual(h.tracker.memberUsage(CLAUDE.id)!.tokens, {
      input: 16, output: 1655, cacheRead: 270281, cacheCreate: 43285, total: 315237,
    });
  });

  test('서브에이전트 폴더가 없으면 예전 그대로다(Task 를 안 쓰는 세션은 값이 안 변한다)', async () => {
    h = harness();
    const main = path.join(dir, 'plain.jsonl');
    fs.writeFileSync(main, noCostState('claude-transcript-agents-main.jsonl'));
    await h.tracker.applyTurnEnd(CLAUDE, main);
    assert.deepEqual(h.tracker.memberUsage(CLAUDE.id)!.tokens, {
      input: 4, output: 445, cacheRead: 75311, cacheCreate: 14769, total: 90529,
    });
  });

  test('서브에이전트 파일도 **증분**으로 읽는다(자라면 늘고, 안 자라면 그대로)', async () => {
    h = harness();
    const subText = read('claude-transcript-agents2-sub1.jsonl');
    const cut = subText.lastIndexOf('\n', Math.floor(subText.length / 2)) + 1;
    const p = session('s3', noCostState('claude-transcript-agents2-main.jsonl'), {
      'agent-a149a5109a042ff6d.jsonl': subText.slice(0, cut),
    });
    await h.tracker.applyTurnEnd(CLAUDE, p);
    const first = h.tracker.memberUsage(CLAUDE.id)!.tokens!.total!;

    fs.appendFileSync(subFile(p, 'agent-a149a5109a042ff6d.jsonl'), subText.slice(cut));
    h.tick(60_000);
    await h.tracker.applyTurnEnd(CLAUDE, p);
    const second = h.tracker.memberUsage(CLAUDE.id)!.tokens!;
    assert.ok(second.total! > first, `${second.total} > ${first}`);
    // 본 파일(138,911) + 서브1(143,459). 한 번에 읽은 것과 같다 = 이중 계산도, 빠뜨림도 없다.
    assert.deepEqual(second, { input: 14, output: 1643, cacheRead: 248974, cacheCreate: 31739, total: 282370 });
  });

  test('새 서브에이전트가 생기면 다음 턴 종료에 잡힌다', async () => {
    h = harness();
    const p = session('s4', noCostState('claude-transcript-agents2-main.jsonl'), {
      'agent-a149a5109a042ff6d.jsonl': read('claude-transcript-agents2-sub1.jsonl'),
    });
    await h.tracker.applyTurnEnd(CLAUDE, p);
    assert.equal(h.tracker.memberUsage(CLAUDE.id)!.tokens!.total, 282370);

    fs.writeFileSync(subFile(p, 'agent-aea6225c1b7e8c839.jsonl'), read('claude-transcript-agents2-sub2.jsonl'));
    h.tick(60_000);
    await h.tracker.applyTurnEnd(CLAUDE, p);
    assert.equal(h.tracker.memberUsage(CLAUDE.id)!.tokens!.total, 315237);
  });

  test('상한을 넘으면 오래된 파일을 놓아 주되 **합계는 줄지 않는다**', async () => {
    // 상한 2 로 좁혀 재현한다(실제 기본값은 50). 셋째 파일이 생기면 첫째가 목록에서 밀린다.
    const files: string[] = [];
    h = harness({ listClaudeSubagents: async () => files.slice(-2).reverse() });
    const line = (id: string, out: number): string =>
      `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5', usage: { output_tokens: out } } })}\n`;
    const main = path.join(dir, 'cap.jsonl');
    fs.writeFileSync(main, line('msg_main', 100));
    const sdir = path.join(dir, 'cap', 'subagents');
    fs.mkdirSync(sdir, { recursive: true });
    const add = (n: number, out: number): void => {
      const p = path.join(sdir, `agent-${n}.jsonl`);
      fs.writeFileSync(p, line(`msg_a${n}`, out));
      files.push(p);
    };

    add(1, 10);
    add(2, 20);
    await h.tracker.applyTurnEnd(CLAUDE, main);
    assert.equal(h.tracker.memberUsage(CLAUDE.id)!.tokens!.output, 130);

    add(3, 30); // agent-1 이 상한 밖으로 밀린다 — 그 몫(10)은 접어 둔 채로 남아야 한다
    h.tick(60_000);
    await h.tracker.applyTurnEnd(CLAUDE, main);
    assert.equal(h.tracker.memberUsage(CLAUDE.id)!.tokens!.output, 160, '놓아 준 파일의 10 이 사라지지 않았다');

    // 밀려났던 파일이 목록에 다시 나타나도 **다시 세지 않는다**(0 부터 읽으면 이중 계산이다).
    h.tick(60_000);
    const shrunk = files.slice();
    h.tracker.stop();
    h = harness({ listClaudeSubagents: async () => [shrunk[0]!, shrunk[2]!] });
    await h.tracker.applyTurnEnd(CLAUDE, main);
    // 새 tracker 라 상태가 비어 있다 → 두 파일을 처음부터 센다(10+30) + 본 파일 100.
    assert.equal(h.tracker.memberUsage(CLAUDE.id)!.tokens!.output, 140);
  });

  test('본 transcript 경로가 바뀌면(resume) 서브에이전트 상태도 같이 버린다', async () => {
    h = harness();
    const a = session('a', noCostState('claude-transcript-agents-main.jsonl'), {
      'agent-x.jsonl': read('claude-transcript-agents-sub1.jsonl'),
    });
    await h.tracker.applyTurnEnd(CLAUDE, a);
    assert.equal(h.tracker.memberUsage(CLAUDE.id)!.tokens!.total, 158607);

    // resume 이 판 새 세션 파일 + 그쪽의 서브에이전트 하나.
    const b = session('b', `${JSON.stringify({ type: 'assistant', message: { id: 'msg_b', model: 'm', usage: { output_tokens: 7 } } })}\n`, {
      'agent-y.jsonl': `${JSON.stringify({ type: 'assistant', message: { id: 'msg_y', model: 'm', usage: { output_tokens: 5 } } })}\n`,
    });
    h.tick(60_000);
    await h.tracker.applyTurnEnd(CLAUDE, b);
    assert.deepEqual(h.tracker.memberUsage(CLAUDE.id)!.tokens, { input: 0, output: 12, cacheRead: 0, cacheCreate: 0, total: 12 }, '이전 세션 몫을 이어받지 않는다');
  });

  test('cost-state 가 나타나면 여전히 그쪽이 이긴다(서브에이전트 합을 덮어쓴다)', async () => {
    h = harness();
    // 픽스처 그대로 = 끝난 세션(cost-state 두 줄 포함).
    const p = session('done', read('claude-transcript-agents-main.jsonl'), {
      'agent-x.jsonl': read('claude-transcript-agents-sub1.jsonl'),
    });
    await h.tracker.applyTurnEnd(CLAUDE, p);
    const m = h.tracker.memberUsage(CLAUDE.id)!;
    // cost-state 의 두 모델 합(haiku 940/17 + opus 512/588/176548/28519).
    assert.equal(m.tokens!.total, 207124);
    assert.equal(m.costUsd, 0.340299);
    // 우리 합(158,607)보다 크다 — 서브에이전트를 더해도 숨은 호출 몫은 여전히 cost-state 만 안다.
    assert.ok(m.tokens!.total! > 158607);
  });

  test('멤버가 사라지면 서브에이전트 상태도 같이 버린다', async () => {
    h = harness();
    const p = session('gone', noCostState('claude-transcript-agents-main.jsonl'), {
      'agent-x.jsonl': read('claude-transcript-agents-sub1.jsonl'),
    });
    await h.tracker.applyTurnEnd(CLAUDE, p);
    assert.equal(h.tracker.memberUsage(CLAUDE.id)!.tokens!.total, 158607);
    h.tracker.removeMember(CLAUDE.id);
    await h.tracker.applyTurnEnd(CLAUDE, p);
    assert.equal(h.tracker.memberUsage(CLAUDE.id)!.tokens!.total, 158607, '0 부터 다시 세도 같은 값(이중 계산 없음)');
  });

  test('목록 읽기가 던져도 삼킨다 — 본 transcript 값은 그대로 들어온다', async () => {
    h = harness({
      listClaudeSubagents: async () => {
        throw new Error('EPERM');
      },
    });
    const main = path.join(dir, 'boom.jsonl');
    fs.writeFileSync(main, noCostState('claude-transcript-agents-main.jsonl'));
    await assert.doesNotReject(() => h.tracker.applyTurnEnd(CLAUDE, main));
    assert.equal(h.tracker.memberUsage(CLAUDE.id)!.tokens!.total, 90529);
  });

  test('Codex 는 서브에이전트 목록을 아예 안 본다', async () => {
    let called = 0;
    h = harness({
      readTail: async () => read('codex-rollout-tail.jsonl'),
      listClaudeSubagents: async () => {
        called++;
        return [];
      },
    });
    await h.tracker.applyTurnEnd(CODEX, 'C:/x/rollout.jsonl');
    assert.equal(called, 0);
  });
});
