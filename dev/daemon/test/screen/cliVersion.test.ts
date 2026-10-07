// T49 — 설치된 CLI 버전 읽기 + 그 버전으로 tui-map 고르기(D-49).
// 진짜 CLI 는 부르지 않는다. `spawnSync` 를 가짜로 넣어 **인자와 출력 파싱**만 고정한다(D-48 원칙 4).
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { detectCliVersion, detectAndApplyCliVersions, VERSION_TIMEOUT_MS } from '../../src/screen/cliVersion.js';
import {
  FALLBACK_VERSION,
  availableMapVersions,
  chooseMapVersion,
  clearInstalledCliVersions,
  loadTuiMap,
  majorMinor,
  setInstalledCliVersion,
} from '../../src/screen/tuiMap.js';
import type { SpawnSyncLike, SpawnSyncOptionsLike, SpawnSyncResultLike } from '../../src/platform.js';

afterEach(() => clearInstalledCliVersions());

/** 부른 인자를 적어 두는 가짜 spawnSync. */
function fakeSpawn(out: Record<string, SpawnSyncResultLike>): {
  spawnSync: (file: string, args: readonly string[], o: SpawnSyncOptionsLike) => SpawnSyncResultLike;
  calls: Array<{ file: string; args: string[]; o: SpawnSyncOptionsLike }>;
} {
  const calls: Array<{ file: string; args: string[]; o: SpawnSyncOptionsLike }> = [];
  return {
    calls,
    spawnSync: (file, args, o) => {
      calls.push({ file, args: [...args], o });
      return out[file] ?? { status: 0, stdout: '' };
    },
  };
}

describe('majorMinor — `--version` 한 줄에서 major.minor', () => {
  test('두 CLI 의 실제 출력 모양을 읽는다', () => {
    assert.equal(majorMinor('codex-cli 0.159.0'), '0.159');
    assert.equal(majorMinor('2.1.284 (Claude Code)'), '2.1');
    assert.equal(majorMinor('0.154.0'), '0.154');
  });

  test('숫자가 없으면 undefined — 폴백으로 간다', () => {
    assert.equal(majorMinor(''), undefined);
    assert.equal(majorMinor('unknown'), undefined);
  });
});

describe('detectCliVersion', () => {
  test('`<exe> --version` 을 한 번 부르고 타임아웃을 건다', () => {
    const f = fakeSpawn({ codex: { status: 0, stdout: 'codex-cli 0.159.0\n' } });
    const got = detectCliVersion('codex', 'codex', f.spawnSync);
    assert.deepEqual(got, { engine: 'codex', exe: 'codex', raw: 'codex-cli 0.159.0', version: '0.159' });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0]!.args, ['--version']);
    assert.equal(f.calls[0]!.o.timeout, VERSION_TIMEOUT_MS, '버전 하나 때문에 기동이 붙들리면 안 된다');
  });

  test('실행 파일이 없으면 까닭을 담아 돌려주고 **던지지 않는다**', () => {
    const f = fakeSpawn({ codex: { error: new Error('spawnSync codex ENOENT') } });
    const got = detectCliVersion('codex', 'codex', f.spawnSync);
    assert.equal(got.version, undefined);
    assert.match(got.reason!, /ENOENT/);
  });

  test('0 아닌 종료 코드도 까닭이 된다', () => {
    const f = fakeSpawn({ codex: { status: 1, stderr: 'boom\nmore' } });
    assert.match(detectCliVersion('codex', 'codex', f.spawnSync).reason!, /exit 1: boom/);
  });

  test('버전처럼 안 생긴 출력은 원문을 남겨 둔다(사람이 보고 판단하게)', () => {
    const f = fakeSpawn({ codex: { status: 0, stdout: 'hello\n' } });
    const got = detectCliVersion('codex', 'codex', f.spawnSync);
    assert.equal(got.version, undefined);
    assert.equal(got.raw, 'hello');
    assert.match(got.reason!, /못 알아봤습니다/);
  });
});

describe('chooseMapVersion — 설치 버전에 가장 가까운 맵', () => {
  test('같은 버전의 맵이 있으면 그것(exact)', () => {
    setInstalledCliVersion('codex', '0.159.0');
    assert.deepEqual(chooseMapVersion('codex'), { version: '0.159', installed: '0.159', exact: true });
    setInstalledCliVersion('codex', '0.154.0');
    assert.deepEqual(chooseMapVersion('codex'), { version: '0.154', installed: '0.154', exact: true });
  });

  test('맵이 없는 **새** CLI → 낮은 중 가장 높은 맵(= 최신 맵)으로, exact:false', () => {
    setInstalledCliVersion('codex', '0.170.0');
    assert.deepEqual(chooseMapVersion('codex'), { version: '0.159', installed: '0.170', exact: false });
  });

  test('맵 사이에 낀 버전 → 아래로 내려 잡는다(0.156 → 0.154)', () => {
    setInstalledCliVersion('codex', '0.156.0');
    assert.deepEqual(chooseMapVersion('codex'), { version: '0.154', installed: '0.156', exact: false });
  });

  test('모든 맵보다 **낮은** CLI → 가장 낮은 맵', () => {
    setInstalledCliVersion('codex', '0.100.0');
    assert.deepEqual(chooseMapVersion('codex'), { version: '0.154', installed: '0.100', exact: false });
  });

  test('버전을 못 읽으면 폴백(= 우리가 가진 최신 맵)', () => {
    assert.deepEqual(chooseMapVersion('codex'), { version: FALLBACK_VERSION.codex, exact: false });
    assert.equal(FALLBACK_VERSION.codex, '0.159');
  });

  test('availableMapVersions 는 오름차순이고 플랫폼 접미사를 겹쳐 세지 않는다', () => {
    assert.deepEqual(availableMapVersions('codex'), ['0.154', '0.159']);
    assert.deepEqual(availableMapVersions('claude'), ['2.1']);
    const withDarwin = { 'codex-0.159-darwin.json': {} as never, 'codex-0.159.json': {} as never };
    assert.deepEqual(availableMapVersions('codex', withDarwin), ['0.159']);
  });
});

describe('setInstalledCliVersion → loadTuiMap', () => {
  test('버전을 바꾸면 그 엔진의 맵 캐시가 비워지고 다른 맵이 나온다', () => {
    setInstalledCliVersion('codex', '0.154.0');
    const old = loadTuiMap('codex', 'darwin');
    assert.equal(old.version, '0.154.0');

    setInstalledCliVersion('codex', '0.159.0');
    const now = loadTuiMap('codex', 'darwin');
    assert.equal(now.version, '0.159.0');
    assert.notEqual(now, old, '캐시 키에 맵 버전이 들어간다');
  });

  test('한 엔진의 버전을 바꿔도 다른 엔진 캐시는 그대로다', () => {
    const claude = loadTuiMap('claude', 'darwin');
    setInstalledCliVersion('codex', '0.154.0');
    assert.equal(loadTuiMap('claude', 'darwin'), claude);
  });

  test('같은 값을 다시 넣으면 캐시를 버리지 않는다', () => {
    setInstalledCliVersion('codex', '0.159.0');
    const m = loadTuiMap('codex', 'darwin');
    setInstalledCliVersion('codex', '0.159.0');
    assert.equal(loadTuiMap('codex', 'darwin'), m);
  });
});

describe('detectAndApplyCliVersions', () => {
  test('두 엔진을 읽어 로더에 넣는다', () => {
    const f = fakeSpawn({});
    const spawnSync: SpawnSyncLike = ((file: string, args: readonly string[], o: SpawnSyncOptionsLike) => {
      f.calls.push({ file, args: [...args], o });
      if (/codex/.test(file)) return { status: 0, stdout: 'codex-cli 0.159.0\n' };
      return { status: 0, stdout: '2.1.284 (Claude Code)\n' };
    }) as unknown as SpawnSyncLike;

    const found = detectAndApplyCliVersions(spawnSync);
    assert.deepEqual(
      found.map((d) => [d.engine, d.version]),
      [
        ['claude', '2.1'],
        ['codex', '0.159'],
      ],
    );
    assert.equal(chooseMapVersion('codex').version, '0.159');
    assert.equal(chooseMapVersion('claude').version, '2.1');
  });

  test('한 엔진이 없어도 다른 엔진은 읽는다(부분 실패는 실패가 아니다)', () => {
    const spawnSync: SpawnSyncLike = ((file: string) =>
      /codex/.test(file) ? { error: new Error('ENOENT') } : { status: 0, stdout: '2.1.284 (Claude Code)\n' }) as unknown as SpawnSyncLike;
    const found = detectAndApplyCliVersions(spawnSync);
    assert.equal(found.find((d) => d.engine === 'claude')!.version, '2.1');
    assert.equal(found.find((d) => d.engine === 'codex')!.version, undefined);
    assert.equal(chooseMapVersion('codex').version, FALLBACK_VERSION.codex, '못 읽은 엔진은 폴백');
    assert.equal(chooseMapVersion('claude').exact, true);
  });
});
