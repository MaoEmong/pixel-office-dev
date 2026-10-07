// 설치된 CLI 버전 읽기(T49 · D-49).
//
// 왜 필요한가: 화면 패턴(tui-map)은 CLI 버전마다 다른데, 로더는 **내장 상수**가 가리키는 버전만 썼다. 이 맥에
// codex 0.159 가 깔려 있는데 상수는 0.154 를 가리켜, 0.159 에서 바뀐 신뢰 모달("Folder access / Trust this
// folder?")을 다이얼로그로 못 읽었다 → `promptReady()` 가 true 인 채로 모달 위에 지시를 붙여넣어 지시가 증발했다.
// 버전을 **물어보면** 그 종류의 드리프트가 조용히 지나가지 않는다.
//
// 운영체제에 닿는 부분은 platform.ts 의 주입구(`SpawnSyncLike`)만 쓴다(D-48 원칙 2·4) — 테스트는 가짜
// spawnSync 로 **인자와 출력 파싱**만 고정하고 이 PC 의 진짜 CLI 를 부르지 않는다.
import { config } from '../config.js';
import { realDeps, type SpawnSyncLike } from '../platform.js';
import { majorMinor, setInstalledCliVersion, type Engine } from './tuiMap.js';

/** `--version` 이 이 안에 안 끝나면 포기한다(폴백으로 간다). 기동을 붙들고 있을 값이 아니다. */
export const VERSION_TIMEOUT_MS = 5000;

export interface DetectedVersion {
  engine: Engine;
  /** 실행 파일 경로(config 에서 온 것). */
  exe: string;
  /** `--version` 원문 한 줄. 못 읽었으면 undefined. */
  raw?: string;
  /** `major.minor`. 못 읽었으면 undefined. */
  version?: string;
  /** 못 읽은 까닭(사람에게 보여 줄 한 줄). 읽었으면 undefined. */
  reason?: string;
}

/**
 * `<exe> --version` 을 한 번 돌려 `major.minor` 를 뽑는다. **절대 던지지 않는다** —
 * 버전을 못 읽는 것은 기동 실패가 아니고, 못 읽으면 폴백 맵으로 간다.
 */
export function detectCliVersion(engine: Engine, exe: string, spawnSync: SpawnSyncLike = realDeps.spawnSync): DetectedVersion {
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: VERSION_TIMEOUT_MS });
  if (r.error) return { engine, exe, reason: r.error.message };
  if (r.status !== 0) return { engine, exe, reason: `exit ${String(r.status)}${r.stderr ? `: ${r.stderr.trim().split('\n')[0]}` : ''}` };
  // claude 는 `2.1.284 (Claude Code)`, codex 는 `codex-cli 0.159.0` 을 찍는다 — 둘 다 첫 `<숫자>.<숫자>` 가 버전이다.
  const raw = `${r.stdout ?? ''}`.trim().split('\n')[0]?.trim() ?? '';
  const version = majorMinor(raw);
  if (!version) return { engine, exe, raw, reason: `버전을 못 알아봤습니다: ${JSON.stringify(raw)}` };
  return { engine, exe, raw, version };
}

/** 기본 실행 파일 경로(engine → config). */
export function exeFor(engine: Engine): string {
  return engine === 'claude' ? config.claudeExe : config.codexExe;
}

/**
 * 두 엔진의 설치 버전을 읽어 tui-map 로더에 넣는다. 데몬 기동 때 **한 번** 부른다.
 * 돌려주는 목록은 기동 로그에 한 줄씩 찍기 위한 것이다.
 */
export function detectAndApplyCliVersions(spawnSync: SpawnSyncLike = realDeps.spawnSync): DetectedVersion[] {
  const engines: Engine[] = ['claude', 'codex'];
  return engines.map((engine) => {
    const found = detectCliVersion(engine, exeFor(engine), spawnSync);
    setInstalledCliVersion(engine, found.version);
    return found;
  });
}
