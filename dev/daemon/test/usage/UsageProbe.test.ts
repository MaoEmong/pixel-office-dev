// T43-4 — 확인용 세션(UsageProbe). 진짜 CLI 를 띄우지 않고 **가짜 세션**에 실측 화면 텍스트를 먹여
// 상태 기계를 돌린다. 시계는 주입하고 `tick()` 을 직접 부르므로 타이머가 필요 없다(InputQueue 와 같은 규칙).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/store/Store.js';
import { UsageTracker } from '../../src/usage/UsageTracker.js';
import { backoffMs, probeCwd, PROBE_TIMING, UsageProbe, type ProbeSession } from '../../src/usage/UsageProbe.js';
import type { Engine } from '../../src/store/types.js';
import { clearInstalledCliVersions, setInstalledCliVersion } from '../../src/screen/tuiMap.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const screens = path.resolve(here, '../fixtures/usage/screens');
const read = (f: string): string => fs.readFileSync(path.join(screens, f), 'utf8');

/** 준비된 프롬프트 화면(tui-map 의 promptReady 패턴). */
const CLAUDE_READY = '\r\n  ❯ \r\n  ? for shortcuts\r\n';
const CODEX_READY = '\r\n› Ask Codex to do anything\r\n\r\n  gpt-6-astra high · D:\\x · 답하기\r\n';

class FakeSession implements ProbeSession {
  static nextPid = 5000;
  readonly pid = FakeSession.nextPid++;
  alive = true;
  readonly writes: string[] = [];
  readonly keys: string[] = [];
  killed = 0;
  private data?: (chunk: string) => void;
  private exit?: () => void;

  write(text: string): void {
    this.writes.push(text);
  }
  sendKeys(key: string): void {
    this.keys.push(key);
  }
  kill(): void {
    this.killed += 1;
    this.die();
  }
  onData(cb: (chunk: string) => void): void {
    this.data = cb;
  }
  onExit(cb: () => void): void {
    this.exit = cb;
  }
  /** 화면에 글자를 흘린다(테스트에서 부른다). */
  feed(chunk: string): void {
    this.data?.(chunk);
  }
  /** 프로세스가 죽었다. */
  die(): void {
    if (!this.alive) return;
    this.alive = false;
    this.exit?.();
  }
}

interface Harness {
  probe: UsageProbe;
  tracker: UsageTracker;
  store: Store;
  spawned: FakeSession[];
  warns: Array<[Engine, string]>;
  now: number;
  /** ms 만큼 시간을 밀고 tick 을 n 번 돌린다(비동기 화면 반영을 기다린다). */
  advance(ms: number, ticks?: number): Promise<void>;
  dir: string;
}

function harness(opts: { enabled?: boolean; intervalMs?: number; connected?: Engine[] } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-probe-'));
  const store = new Store(path.join(dir, 'db.sqlite'));
  const tracker = new UsageTracker({ store, pollIntervalMs: 0 });
  for (const engine of opts.connected ?? (['claude', 'codex'] as Engine[])) {
    tracker.setConnection(engine, { connected: true, plan: null, reason: null });
  }
  for (const engine of (['claude', 'codex'] as Engine[]).filter((e) => !(opts.connected ?? ['claude', 'codex']).includes(e))) {
    tracker.setConnection(engine, { connected: false, plan: null, reason: 'not-installed' });
  }
  const spawned: FakeSession[] = [];
  const warns: Array<[Engine, string]> = [];
  const h: Harness = {
    store,
    tracker,
    spawned,
    warns,
    dir,
    now: Date.parse('2026-09-20T22:20:00.000Z'),
    probe: undefined as unknown as UsageProbe,
    advance: undefined as unknown as Harness['advance'],
  };
  h.probe = new UsageProbe({
    tracker,
    dataDir: dir,
    enabled: opts.enabled,
    intervalMs: opts.intervalMs ?? 300_000,
    now: () => h.now,
    recordPid: (engine, pid) => store.putUsageProbePid(engine, pid),
    spawn: (engine) => {
      const s = new FakeSession();
      spawned.push(s);
      void engine;
      return s;
    },
  });
  h.probe.on('warn', (engine, message) => warns.push([engine, message]));
  h.advance = async (ms, ticks = 1) => {
    h.now += ms;
    for (let i = 0; i < ticks; i++) {
      // ScreenModel.feed 는 비동기(xterm write)고 큰 화면은 여러 틱에 걸쳐 파싱된다 — 보기 전에 넉넉히 양보한다.
      for (let k = 0; k < 6; k++) await new Promise((r) => setTimeout(r, 0));
      h.probe.tick();
    }
  };
  return h;
}

let h: Harness | undefined;
afterEach(() => {
  h?.probe.stop();
  h?.store.close();
  if (h) fs.rmSync(h.dir, { recursive: true, force: true });
  h = undefined;
});

/** spawn → ready → 첫 판 전송까지 몰아서. 돌려주는 것은 그 엔진의 가짜 세션. */
async function boot(hh: Harness, index: number, ready: string): Promise<FakeSession> {
  hh.probe.start();
  const s = hh.spawned[index]!;
  s.feed(ready);
  await hh.advance(0, 2); // booting → idle → (즉시) 첫 판: 명령 타이핑
  await hh.advance(PROBE_TIMING.enterDelayMs, 1); // typing → Enter
  return s;
}

describe('UsageProbe — 한 판', () => {
  beforeEach(() => {
    h = harness({ connected: ['claude'] });
  });

  test('연결된 엔진에만 세션을 띄우고, 프롬프트가 준비되면 바로 첫 판을 친다', async () => {
    const s = await boot(h!, 0, CLAUDE_READY);
    assert.equal(h!.spawned.length, 1, 'codex 는 연결 안 됨 → 세션 없음');
    assert.deepEqual(s.writes, ['/usage']);
    assert.deepEqual(s.keys, ['enter']);
    assert.equal(h!.probe.phaseOf('claude'), 'sent');
  });

  test('패널을 읽어 tracker 에 source:"probe" 로 넣고 Esc 로 닫는다', async () => {
    const s = await boot(h!, 0, CLAUDE_READY);
    s.feed(read('claude-screen-05-usage.txt').replace(/\n/g, '\r\n'));
    await h!.advance(1000, 2);

    const u = h!.tracker.engineUsage('claude');
    assert.equal(u.weekly?.usedPercent, 55);
    assert.equal(u.session?.usedPercent, 17);
    assert.deepEqual(u.models.map((m) => m.label), ['Fable']);
    assert.equal(u.source, 'probe');
    assert.ok(s.keys.includes('esc'), s.keys.join(','));

    // 프롬프트가 돌아오면 다음 판까지 대기.
    s.feed(CLAUDE_READY);
    await h!.advance(500, 2);
    assert.equal(h!.probe.phaseOf('claude'), 'idle');
  });

  test('주기가 지나야 다음 판을 친다', async () => {
    const s = await boot(h!, 0, CLAUDE_READY);
    s.feed(read('claude-screen-05-usage.txt').replace(/\n/g, '\r\n'));
    await h!.advance(1000, 2);
    s.feed(CLAUDE_READY);
    await h!.advance(500, 2);
    const writesAfterFirst = s.writes.length;
    assert.equal(h!.probe.phaseOf('claude'), 'idle');

    await h!.advance(200_000, 2);
    assert.equal(s.writes.length, writesAfterFirst, '5분 전에는 안 친다');
    await h!.advance(200_000, 2);
    assert.equal(s.writes.length, writesAfterFirst + 1, '5분이 지나면 한 번 더');
  });

  test('전혀 다른 화면이 뜨면 값을 버리고 경고는 **한 번만** 낸다', async () => {
    const s = await boot(h!, 0, CLAUDE_READY);
    // 패널 대기 시간을 넘긴다(패널이 끝내 안 뜬다).
    await h!.advance(PROBE_TIMING.panelMs + 1000, 2);
    assert.equal(h!.tracker.engineUsage('claude').weekly, null, '값을 만들지 않는다');
    assert.equal(h!.warns.length, 1, h!.warns.map((w) => w[1]).join(' / '));
    assert.match(h!.warns[0]![1], /usage/);

    // 두 번째 판도 실패 — 경고는 늘지 않는다.
    s.feed(CLAUDE_READY);
    await h!.advance(500, 2);
    await h!.advance(400_000, 2);
    await h!.advance(PROBE_TIMING.enterDelayMs, 1);
    await h!.advance(PROBE_TIMING.panelMs + 1000, 1);
    assert.equal(s.writes.length, 2, '두 번째 판은 실제로 쳤다');
    assert.equal(h!.warns.length, 1, '엔진당 데몬 수명에 한 번');
  });

  test('패널은 떴는데 한도 문구가 바뀌었으면 경고 + 이전 값 유지', async () => {
    const s = await boot(h!, 0, CLAUDE_READY);
    // ready 패턴(제목)은 그대로인데 `NN% used` 줄이 사라진 화면.
    const broken = read('claude-screen-05-usage.txt').replace(/\d+% used/g, 'unknown');
    s.feed(broken.replace(/\n/g, '\r\n'));
    await h!.advance(1000, 2);
    assert.equal(h!.tracker.engineUsage('claude').weekly, null);
    assert.equal(h!.warns.length, 1);
    assert.match(h!.warns[0]![1], /한도를 읽지 못했습니다/);
  });
});

describe('UsageProbe — Codex(스크롤백)', () => {
  beforeEach(() => {
    h = harness({ connected: ['codex'] });
  });
  // 확인용 세션은 **내장 맵**을 쓴다 → 어느 맵을 고르는지는 설치된 CLI 버전에 달렸다(T49). 그래서 버전을
  // 테스트마다 고정한다. 안 고정하면 이 PC 에 깔린 codex 에 따라 결과가 갈린다.
  afterEach(() => clearInstalledCliVersions());

  test('패널이 뷰포트 위로 밀려도 스크롤백 전체에서 읽는다 (0.154)', async () => {
    setInstalledCliVersion('codex', '0.154.0');
    const s = await boot(h!, 0, CODEX_READY);
    assert.deepEqual(s.writes, ['/status']);
    // 패널을 흘린 뒤 40줄 넘게 더 흘려 뷰포트 밖으로 밀어낸다.
    s.feed(read('codex-full-03-status-after-turn.txt').replace(/\n/g, '\r\n'));
    s.feed('\r\n'.repeat(60) + CODEX_READY);
    await h!.advance(1000, 2);

    const u = h!.tracker.engineUsage('codex');
    assert.equal(u.weekly?.usedPercent, 12, '88% left → 12% used');
    assert.equal(u.plan, 'pro', '화면은 "Pro" 지만 tracker 가 소문자로 눕힌다');
    assert.equal(u.source, 'probe');
  });

  // T49 회귀: 0.159 화면은 괘선이 없고 `Account:` 줄 모양이 다르다. 설치 버전이 0.159 면 0.159 맵이 골라져
  // **같은 결과**가 나와야 한다 — 이 테스트가 로더의 버전 선택까지 한 줄로 묶어 준다.
  test('0.159 화면도 같은 값으로 읽는다 — 로더가 0.159 맵을 고른다', async () => {
    setInstalledCliVersion('codex', '0.159.0');
    const s = await boot(h!, 0, CODEX_READY);
    assert.deepEqual(s.writes, ['/status']);
    s.feed(read('codex-0.159-status.txt').replace(/\n/g, '\r\n'));
    s.feed('\r\n'.repeat(60) + CODEX_READY);
    await h!.advance(1000, 2);

    const u = h!.tracker.engineUsage('codex');
    assert.equal(u.weekly?.usedPercent, 45, '55% left → 45% used');
    assert.equal(u.plan, 'pro');
    assert.equal(u.source, 'probe');
  });
});

describe('UsageProbe — 수명', () => {
  test('PIXEL_USAGE_PROBE=0(enabled:false)이면 아무것도 띄우지 않는다', async () => {
    h = harness({ enabled: false });
    h.probe.start();
    await h.advance(600_000, 3);
    assert.equal(h.spawned.length, 0);
    assert.equal(h.probe.isEnabled, false);
  });

  test('연결 안 된 엔진은 건너뛰고, 나중에 붙으면 그때 띄운다', async () => {
    h = harness({ connected: [] });
    h.probe.start();
    await h.advance(1000, 2);
    assert.equal(h.spawned.length, 0);

    h.tracker.setConnection('codex', { connected: true, plan: null, reason: null });
    await h.advance(1000, 2);
    assert.equal(h.spawned.length, 1);
  });

  test('붙어 있다가 끊기면 세션을 내린다', async () => {
    h = harness({ connected: ['claude'] });
    h.probe.start();
    await h.advance(600, 1);
    const s = h.spawned[0]!;
    assert.equal(s.alive, true);
    h.tracker.setConnection('claude', { connected: false, plan: null, reason: 'logged-out' });
    await h.advance(600, 1);
    assert.equal(s.killed, 1);
    assert.equal(h.probe.phaseOf('claude'), 'off');
  });

  test('프로세스가 죽으면 백오프 1분 → 2 → 4 → 8 → 10분(상한) 으로 다시 띄운다', async () => {
    h = harness({ connected: ['claude'] });
    h.probe.start();
    await h.advance(600, 1);
    assert.equal(h.spawned.length, 1);

    h.spawned[0]!.die();
    await h.advance(1000, 1);
    assert.equal(h.probe.phaseOf('claude'), 'backoff');
    assert.equal(h.spawned.length, 1, '바로 다시 띄우지 않는다');

    await h.advance(58_000, 1);
    assert.equal(h.spawned.length, 1, '1분 전에는 안 띄운다');
    await h.advance(2_000, 1);
    assert.equal(h.spawned.length, 2, '1분 뒤 재시도');

    // 두 번째도 죽으면 2분.
    h.spawned[1]!.die();
    await h.advance(1000, 1);
    await h.advance(61_000, 1);
    assert.equal(h.spawned.length, 2, '2분 백오프 — 1분으로는 부족');
    await h.advance(60_000, 1);
    assert.equal(h.spawned.length, 3);
  });

  test('backoffMs: 1 → 2 → 4 → 8 → 10분에서 멈춘다', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map(backoffMs), [60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
    assert.equal(backoffMs(0), 0);
    assert.equal(backoffMs(5), PROBE_TIMING.backoffMaxMs);
  });

  test('stop() 은 세션을 죽이고 다시 띄우지 않는다(데몬 종료 경로)', async () => {
    h = harness();
    h.probe.start();
    await h.advance(600, 1);
    assert.equal(h.spawned.length, 2, '엔진 둘 다');
    h.probe.stop();
    assert.deepEqual(h.spawned.map((s) => s.killed), [1, 1]);
    assert.deepEqual(h.probe.pids(), []);
    // stop 뒤에는 tick 이 아무 일도 하지 않는다.
    await h.advance(600_000, 2);
    assert.equal(h.spawned.length, 2);
  });

  test('pid 를 DB 에 적고 세션이 사라지면 지운다(다음 기동의 유령 정리용)', async () => {
    h = harness({ connected: ['claude'] });
    h.probe.start();
    await h.advance(600, 1);
    const rows = h.store.listUsageProbePids();
    assert.deepEqual(rows.map((r) => r.engine), ['claude']);
    assert.equal(rows[0]!.childPid, h.spawned[0]!.pid);

    h.probe.stop();
    assert.deepEqual(h.store.listUsageProbePids(), []);
  });

  test('cwd 는 데이터 폴더 아래 전용 빈 폴더다(프로젝트 폴더를 건드리지 않는다)', async () => {
    h = harness({ connected: ['claude'] });
    h.probe.start();
    await h.advance(600, 1);
    const cwd = probeCwd(h.dir, 'claude');
    assert.ok(fs.existsSync(cwd), cwd);
    assert.deepEqual(fs.readdirSync(cwd), [], '빈 폴더');
  });
});
