// T48-1: tui-map 파일 이름의 **플랫폼 접미사 규칙**(D-48 ⑦ · 설계 §화면 패턴).
// `claude-2.1-darwin.json` 이 있으면 맥에서 그것을 먼저 쓰고, 없으면 `claude-2.1.json` 으로 떨어진다.
// 지금 저장소에는 darwin 파일이 **없다** — 맥 실기(2단계 M3/M14)에서 줄바꿈이 다르면 그때 만든다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BUILTIN_FILES,
  FALLBACK_VERSION,
  availableMapVersions,
  clearInstalledCliVersions,
  loadTuiMap,
  majorMinor,
  resolveTuiMapFile,
  setInstalledCliVersion,
  tuiMapCandidates,
  type TuiMapJson,
} from '../../src/screen/tuiMap.js';

const claudeJson = BUILTIN_FILES['claude-2.1.json']!;

describe('tui-map 파일 이름 규칙', () => {
  test('후보는 플랫폼 접미사 먼저, 그다음 평범한 파일', () => {
    assert.deepEqual(tuiMapCandidates('claude', '2.1', 'darwin'), ['claude-2.1-darwin.json', 'claude-2.1.json']);
    assert.deepEqual(tuiMapCandidates('codex', '0.154', 'win32'), ['codex-0.154-win32.json', 'codex-0.154.json']);
    assert.deepEqual(tuiMapCandidates('claude', '2.1', 'linux'), ['claude-2.1-linux.json', 'claude-2.1.json']);
  });

  test('내장 표의 키는 실제로 있는 파일 이름이고 안의 engine/version 과 맞는다', () => {
    for (const [file, json] of Object.entries(BUILTIN_FILES)) {
      assert.ok(fs.existsSync(new URL(`../../src/tui-maps/${file}`, import.meta.url)), `${file} 이 없다`);
      const stem = file.replace(/\.json$/, '');
      // 엔진마다 맵이 여러 개일 수 있으므로(codex 0.154 · 0.159) 파일 이름은 **그 파일 자신의** version 과 맞춘다.
      // 폴백 상수와 맞추면 옛 맵을 함께 두는 순간 깨진다(T49 이전에는 엔진당 한 개뿐이었다).
      const own = majorMinor(json.version);
      assert.ok(own, `${file} 의 version(${json.version})을 major.minor 로 못 읽는다`);
      assert.ok(stem.startsWith(`${json.engine}-${own}`), `${file} 의 이름과 engine/version 이 어긋난다`);
    }
  });

  test('폴백 버전은 그 엔진이 실제로 가진 맵 중 가장 새 것이다', () => {
    for (const engine of ['claude', 'codex'] as const) {
      const versions = availableMapVersions(engine);
      assert.ok(versions.length > 0, `${engine} 맵이 하나도 없다`);
      assert.equal(FALLBACK_VERSION[engine], versions[versions.length - 1], `${engine} 폴백이 최신 맵이 아니다`);
    }
  });
});

describe('resolveTuiMapFile — 접미사 우선, 없으면 폴백', () => {
  /** darwin 전용 맵이 있는 가짜 표(패턴 하나만 바꿔 구분한다). */
  const withDarwin: Record<string, TuiMapJson> = {
    ...BUILTIN_FILES,
    'claude-2.1-darwin.json': { ...claudeJson, source: 'darwin-live' },
  };

  test('darwin 파일이 있으면 맥에서 그것을 고른다', () => {
    const { file, json } = resolveTuiMapFile('claude', 'darwin', withDarwin);
    assert.equal(file, 'claude-2.1-darwin.json');
    assert.equal(json.source, 'darwin-live');
  });

  test('darwin 파일이 있어도 다른 플랫폼은 평범한 파일을 쓴다', () => {
    for (const p of ['win32', 'linux'] as const) {
      assert.equal(resolveTuiMapFile('claude', p, withDarwin).file, 'claude-2.1.json');
    }
  });

  test('접미사 파일이 없으면 폴백 — 지금 저장소가 바로 이 상태다', () => {
    // 설치 버전을 고정해 둔다 — 안 하면 이 PC 에 깔린 CLI 에 따라 고르는 맵이 달라진다.
    setInstalledCliVersion('claude', '2.1.284');
    setInstalledCliVersion('codex', '0.154.0');
    try {
      for (const p of ['win32', 'darwin', 'linux'] as const) {
        assert.equal(resolveTuiMapFile('claude', p).file, 'claude-2.1.json');
        assert.equal(resolveTuiMapFile('codex', p).file, 'codex-0.154.json');
      }
    } finally {
      clearInstalledCliVersions();
    }
    assert.ok(!Object.keys(BUILTIN_FILES).some((f) => /-darwin\.json$/.test(f)), 'darwin 맵은 맥 실기 뒤에 들어온다');
  });

  test('둘 다 없으면 무엇을 찾아봤는지 말하고 던진다', () => {
    assert.throws(() => resolveTuiMapFile('claude', 'darwin', {}), /claude-2\.1-darwin\.json, claude-2\.1\.json/);
    assert.throws(() => resolveTuiMapFile('nope' as never, 'darwin'), /no tui-map for engine/);
  });
});

describe('loadTuiMap — 플랫폼별로 캐시한다', () => {
  test('같은 엔진·플랫폼은 같은 객체(컴파일 한 번), 플랫폼이 다르면 따로 컴파일', () => {
    const winMap = loadTuiMap('claude', 'win32');
    assert.equal(loadTuiMap('claude', 'win32'), winMap);
    const macMap = loadTuiMap('claude', 'darwin');
    assert.notEqual(macMap, winMap, '캐시 키에 플랫폼이 들어간다');
    assert.equal(macMap.version, winMap.version, '지금은 같은 파일에서 나온 같은 내용이다');
  });

  test('플랫폼을 생략하면 이 기계의 플랫폼(기존 호출처 그대로)', () => {
    assert.equal(loadTuiMap('codex'), loadTuiMap('codex', process.platform));
  });
});
