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

function harness(opts: Partial<{ store: Store; probeClaude: () => Promise<EngineConnection>; probeCodex: () => Promise<EngineConnection>; readTail: (f: string) => Promise<string>; refreshMs: number }> = {}): Harness {
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

  test('확인용 세션이 준 요금제는 그대로 실린다(Codex 는 화면이 유일한 출처일 수 있다)', () => {
    h = harness();
    h.tracker.applyProbe('codex', { weekly: probeWeekly(12), plan: 'Pro' });
    assert.equal(h.tracker.engineUsage('codex').plan, 'Pro');
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
