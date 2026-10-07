// tui-map 로더. CLI 버전별 화면 패턴(준비 문구·다이얼로그·키 시퀀스)은 src/tui-maps/*.json 에만 둔다.
// 여기서는 JSON 을 읽어 정규식으로 컴파일하고, kind/keys 값이 허용 집합에 있는지 검사한다.
//
// 파일 이름은 `<engine>-<major.minor>[-<platform>].json` 이고 **플랫폼 접미사가 먼저**다(T48-1 · D-48 ⑦):
// `claude-2.1-darwin.json` 이 있으면 맥에서 그것을, 없으면 `claude-2.1.json` 을 쓴다.
import claude21 from '../tui-maps/claude-2.1.json' with { type: 'json' };
import codex0154 from '../tui-maps/codex-0.154.json' with { type: 'json' };
import codex0159 from '../tui-maps/codex-0.159.json' with { type: 'json' };

export type Engine = 'claude' | 'codex';

export const DIALOG_KINDS = [
  'onboarding-enter',
  'trust-folder-claude',
  'trust-folder-codex',
  'login-menu',
  'security-notes',
  /** CLI 자체 허가 프롬프트(hook 이 없거나 만료된 뒤의 폴백, D-16). 자동 통과 대상이 아니다 → suggestedKeys 는 항상 []. approvalPrompt() 로 allow/deny 키를 따로 준다. */
  'approval-prompt',
  /** Codex 사용량 한도 근접 시 "Switch to gpt-… for lower credit usage?" 메뉴. esc 로 닫으면 현재 모델 유지. */
  'model-switch-offer',
  'none',
] as const;
export type DialogKind = (typeof DIALOG_KINDS)[number];

export const KEYS = ['enter', 'down', 'up', 'esc'] as const;
export type Key = (typeof KEYS)[number];

/** JSON 파일의 원본 형태(정규식은 문자열). */
export interface TuiMapJson {
  engine: Engine;
  version: string;
  source?: string;
  notes?: string[];
  promptReady: {
    /** 하단 몇 줄(뒤쪽 빈 줄 제외)을 볼지. 기본 4. */
    scanLines?: number;
    anyOf: string[];
    /** 화면 어디든 이 중 하나가 보이면 준비 문구가 있어도 false (예: Codex 'model: loading' — 프롬프트는 보이지만 Enter 가 먹지 않는다). */
    noneOf?: string[];
    /** 입력줄(prompt) 아래 statusWithin 줄 안에 status 가 보이면 준비. Codex 용. */
    inputLine?: { prompt: string; status: string; statusWithin?: number };
    verified?: boolean;
    source?: string;
  };
  busy: { anyOf: string[]; verified?: boolean; source?: string };
  interrupted: { anyOf: string[]; verified?: boolean; source?: string };
  /** 입력 상자 식별: 아래에 빈 줄·skipLines 만 있는 prompt 줄(ruleAbove 가 있으면 바로 윗줄이 괘선이어야 함) 이하는 "마지막 줄" 후보에서 뺀다. */
  inputBox?: { prompt: string; ruleAbove?: string | null };
  /** lastNonEmptyLine 에서 건너뛸 줄(괘선·상태줄 등). */
  skipLines: string[];
  dialogs: TuiDialogJson[];
  /** 확인용 세션(T43-4)이 여는 사용량 화면. 없으면 그 엔진은 확인용 세션을 띄우지 않는다. */
  usage?: TuiUsageJson;
}

/**
 * 사용량 화면(Claude `/usage` · Codex `/status`) 한 판의 패턴(T43-4, D-45).
 * **여기 있는 것이 전부다** — 파서(`src/usage/parse/usageScreen.ts`)에는 CLI 문구가 한 글자도 없다.
 */
export interface TuiUsageJson {
  /** 화면을 여는 슬래시 명령. 붙여넣기 없이 그대로 타이핑한 뒤 Enter. */
  command: string;
  /** 화면을 닫는 키 순서(보통 `["esc"]`). */
  closeKeys: Key[];
  /**
   * 뷰포트가 아니라 **스크롤백 전체**를 읽어야 하는가. Codex TUI 는 인라인 렌더라 패널이 위로 밀려
   * 40줄 뷰포트만 보면 잘린다(T43-0 Q7). Claude 는 전체 화면 패널이라 false.
   */
  scrollback?: boolean;
  /**
   * "패널이 다 그려졌다" 표지. **전부** 보여야 한다. 확인용 세션은 명령을 치기 **전의 등장 횟수**를 세 두고
   * 그보다 늘어났을 때만 읽는다 — 스크롤백에 남은 지난번 패널을 다시 읽지 않기 위해서다.
   */
  ready: string[];
  /** 한도 블록. 이름 있는 그룹(`percent`·`resets`·`label`·`model`)만 읽는다. */
  blocks: TuiUsageBlockJson[];
  /**
   * 요금제(선택). 이름 있는 그룹 **`plan` 하나만** 읽는다 — 같은 줄에 계정 이메일이 있어도 그 그룹은
   * 만들지 않는다(D-45 ②).
   */
  plan?: string;
  verified?: boolean;
  source?: string;
}

export interface TuiUsageBlockJson {
  /**
   * 이 블록이 채우는 칸.
   *   `weekly` · `session` — 그 칸에 바로 넣는다(Codex).
   *   `auto` — 한 정규식이 여러 블록을 잡는다(Claude). `label` 그룹을 `sessionLabel`/`weeklyLabel` 에
   *            대어 가르고, 둘 다 아니면 **모델별 한도**(`model` 그룹이 라벨)로 간다.
   */
  target: 'auto' | 'weekly' | 'session';
  /** 정규식(m·g·u 플래그로 컴파일). 여러 번 맞으면 **뒤의 것이 이긴다**(스크롤백에 옛 패널이 남아 있을 수 있다). */
  pattern: string;
  /** `percent` 그룹이 "쓴 비율" 인가 "남은 비율" 인가. Claude 는 `used`, Codex 화면은 `left`(데몬이 뒤집는다). */
  percentIs: 'used' | 'left';
  /** `auto` 에서 5시간(세션) 블록을 가르는 `label` 패턴. */
  sessionLabel?: string;
  /** `auto` 에서 주간 전체 블록을 가르는 `label` 패턴. */
  weeklyLabel?: string;
}

export interface TuiDialogJson {
  id: string;
  kind: Exclude<DialogKind, 'none'>;
  /** 전부 매치해야 함(화면 전체 텍스트, m 플래그). */
  all: string[];
  /** 통과 키. kind 가 'approval-prompt' 면 쓰지 않는다(대신 allowKeys/denyKeys). */
  keys?: Key[];
  /** 'approval-prompt' 전용: 허가 / 거부 키 순서. 데몬이 자동으로 보내지 않고 approvalPrompt() 로만 노출한다. */
  allowKeys?: Key[];
  denyKeys?: Key[];
  /** 현재 강조된 항목에 따라 키를 바꾼다. marker 로 시작하는 첫 줄에서 marker 를 떼고 choices 를 검사. */
  highlight?: { marker: string; choices: Array<{ match: string; keys: Key[] }> };
  verified?: boolean;
  /** 실물 출처(픽스처 파일명·로그). verified:true 면 반드시 적는다. */
  source?: string;
}

/** 컴파일된 형태. */
export interface TuiMap {
  engine: Engine;
  version: string;
  promptReady: {
    scanLines: number;
    anyOf: RegExp[];
    noneOf: RegExp[];
    inputLine?: { prompt: RegExp; status: RegExp; statusWithin: number };
  };
  busy: RegExp[];
  interrupted: RegExp[];
  inputBox?: { prompt: RegExp; ruleAbove?: RegExp };
  skipLines: RegExp[];
  dialogs: TuiDialog[];
  /** 확인용 세션(T43-4). 없으면 그 엔진은 화면에서 한도를 읽지 않는다. */
  usage?: TuiUsage;
}

/** 컴파일된 `usage` 절. */
export interface TuiUsage {
  command: string;
  closeKeys: Key[];
  scrollback: boolean;
  ready: RegExp[];
  blocks: TuiUsageBlock[];
  plan?: RegExp;
}

export interface TuiUsageBlock {
  target: 'auto' | 'weekly' | 'session';
  /** 항상 g 플래그로 컴파일된다(여러 번 맞으면 뒤의 것이 이긴다). */
  pattern: RegExp;
  percentIs: 'used' | 'left';
  sessionLabel?: RegExp;
  weeklyLabel?: RegExp;
}

export interface TuiDialog {
  id: string;
  kind: Exclude<DialogKind, 'none'>;
  all: RegExp[];
  /** 자동 통과 키. 'approval-prompt' 는 항상 []. */
  keys: Key[];
  /** 'approval-prompt' 전용. */
  allowKeys?: Key[];
  denyKeys?: Key[];
  highlight?: { marker: RegExp; choices: Array<{ match: RegExp; keys: Key[] }> };
}

const COMPILED = Symbol('compiledTuiMap');

function rx(where: string, pattern: string, flags = 'u'): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    throw new Error(`tui-map ${where}: bad regex ${JSON.stringify(pattern)}: ${(e as Error).message}`);
  }
}

function keys(where: string, ks: unknown): Key[] {
  if (!Array.isArray(ks) || ks.length === 0) throw new Error(`tui-map ${where}: keys must be a non-empty array`);
  for (const k of ks) if (!(KEYS as readonly string[]).includes(k)) throw new Error(`tui-map ${where}: unknown key ${JSON.stringify(k)}`);
  return [...(ks as Key[])];
}

export function isCompiledTuiMap(m: unknown): m is TuiMap {
  return typeof m === 'object' && m !== null && COMPILED in m;
}

/** JSON → 정규식 컴파일 + 값 검증. 잘못된 패턴은 여기서 바로 던진다(런타임 중 조용히 실패하지 않도록). */
export function compileTuiMap(json: TuiMapJson): TuiMap {
  const tag = `${json.engine}-${json.version}`;
  const dialogs: TuiDialog[] = json.dialogs.map((d) => {
    const where = `${tag} dialogs[${d.id}]`;
    const kind: string = d.kind; // JSON 에서 온 값이라 타입을 믿지 않고 검사
    if (kind === 'none' || !(DIALOG_KINDS as readonly string[]).includes(kind)) throw new Error(`${where}: unknown kind ${JSON.stringify(kind)}`);
    if (!d.all?.length) throw new Error(`${where}: "all" must be a non-empty array`);
    const isApproval = kind === 'approval-prompt';
    if (isApproval) {
      // 허가 프롬프트는 자동 통과 대상이 아니다: keys 가 있으면 맵 작성 실수로 보고 거부한다.
      if (d.keys !== undefined || d.highlight) throw new Error(`${where}: approval-prompt must not have "keys"/"highlight" (use allowKeys/denyKeys)`);
    } else if (d.allowKeys !== undefined || d.denyKeys !== undefined) {
      throw new Error(`${where}: allowKeys/denyKeys are only for kind "approval-prompt"`);
    }
    return {
      id: d.id,
      kind: d.kind,
      all: d.all.map((p) => rx(where, p, 'mu')),
      keys: isApproval ? [] : keys(where, d.keys),
      allowKeys: isApproval ? keys(`${where}.allowKeys`, d.allowKeys) : undefined,
      denyKeys: isApproval ? keys(`${where}.denyKeys`, d.denyKeys) : undefined,
      highlight: d.highlight && {
        marker: rx(`${where}.highlight`, d.highlight.marker),
        choices: d.highlight.choices.map((c) => ({ match: rx(`${where}.highlight`, c.match), keys: keys(`${where}.highlight`, c.keys) })),
      },
    };
  });
  const pr = json.promptReady;
  const map: TuiMap = {
    engine: json.engine,
    version: json.version,
    promptReady: {
      scanLines: pr.scanLines ?? 4,
      anyOf: pr.anyOf.map((p) => rx(`${tag} promptReady`, p)),
      noneOf: (pr.noneOf ?? []).map((p) => rx(`${tag} promptReady.noneOf`, p)),
      inputLine: pr.inputLine && {
        prompt: rx(`${tag} promptReady.inputLine`, pr.inputLine.prompt),
        status: rx(`${tag} promptReady.inputLine`, pr.inputLine.status),
        statusWithin: pr.inputLine.statusWithin ?? 3,
      },
    },
    busy: json.busy.anyOf.map((p) => rx(`${tag} busy`, p)),
    interrupted: json.interrupted.anyOf.map((p) => rx(`${tag} interrupted`, p)),
    inputBox: json.inputBox && {
      prompt: rx(`${tag} inputBox`, json.inputBox.prompt),
      ruleAbove: json.inputBox.ruleAbove ? rx(`${tag} inputBox`, json.inputBox.ruleAbove) : undefined,
    },
    skipLines: json.skipLines.map((p) => rx(`${tag} skipLines`, p)),
    dialogs,
    usage: json.usage && compileUsage(tag, json.usage),
  };
  Object.defineProperty(map, COMPILED, { value: true, enumerable: false });
  return map;
}

/** `usage` 절 컴파일 + 검증. 이름 있는 그룹이 빠졌으면 **로드 시점에** 던진다(런타임에 조용히 null 이 되지 않게). */
function compileUsage(tag: string, u: TuiUsageJson): TuiUsage {
  const where = `${tag} usage`;
  if (!u.command) throw new Error(`${where}: "command" is required`);
  if (!u.ready?.length) throw new Error(`${where}: "ready" must be a non-empty array`);
  if (!u.blocks?.length) throw new Error(`${where}: "blocks" must be a non-empty array`);
  const blocks = u.blocks.map((b, i) => {
    const bw = `${where}.blocks[${i}]`;
    if (b.target !== 'auto' && b.target !== 'weekly' && b.target !== 'session') throw new Error(`${bw}: unknown target ${JSON.stringify(b.target)}`);
    if (b.percentIs !== 'used' && b.percentIs !== 'left') throw new Error(`${bw}: percentIs must be "used" or "left"`);
    const pattern = rx(bw, b.pattern, 'gmu');
    if (!/\(\?<percent>/.test(b.pattern)) throw new Error(`${bw}: pattern must have a named group (?<percent>…)`);
    if (b.target === 'auto' && !/\(\?<label>/.test(b.pattern)) throw new Error(`${bw}: target "auto" needs a named group (?<label>…)`);
    return {
      target: b.target,
      pattern,
      percentIs: b.percentIs,
      sessionLabel: b.sessionLabel ? rx(`${bw}.sessionLabel`, b.sessionLabel) : undefined,
      weeklyLabel: b.weeklyLabel ? rx(`${bw}.weeklyLabel`, b.weeklyLabel) : undefined,
    };
  });
  if (u.plan !== undefined && !/\(\?<plan>/.test(u.plan)) throw new Error(`${where}.plan: pattern must have a named group (?<plan>…)`);
  return {
    command: u.command,
    closeKeys: keys(`${where}.closeKeys`, u.closeKeys),
    scrollback: u.scrollback === true,
    ready: u.ready.map((p) => rx(`${where}.ready`, p, 'gmu')),
    blocks,
    plan: u.plan ? rx(`${where}.plan`, u.plan, 'mu') : undefined,
  };
}

/**
 * **설치된 CLI 버전을 못 읽었을 때만** 쓰는 맵 버전(파일 이름의 `<major.minor>`).
 *
 * 원래는 이것이 유일한 기준이었고, 그래서 T49 가 터졌다 — 이 맥에 codex 0.159 가 깔려 있는데 상수는 0.154 를
 * 가리켜, 0.159 에서 바뀐 신뢰 모달을 못 읽고 지시를 잃었다(D-49). 지금은 `setInstalledCliVersion()` 으로
 * 넣어 준 **실제 설치 버전**이 우선이고, 이 표는 그것이 없을 때의 폴백이다.
 *
 * 값은 **우리가 가진 가장 새 맵**으로 둔다 — 버전을 못 읽는 상황에서 최신 CLI 를 가정하는 편이 낫다
 * (CLI 는 늘 앞으로만 간다). 낡은 CLI 를 쓰는 사람은 버전이 읽히는 한 아래 근접 규칙이 옛 맵을 골라 준다.
 */
export const FALLBACK_VERSION: Record<Engine, string> = {
  claude: '2.1',
  codex: '0.159',
};

/** 이전 이름. 뜻이 "고정 버전" 에서 "폴백" 으로 바뀌었다 — 새 코드는 `FALLBACK_VERSION` 을 쓴다. */
export const BUILTIN_VERSION = FALLBACK_VERSION;

/** `setInstalledCliVersion()` 이 넣어 준 실제 설치 버전(`major.minor`). 안 넣었으면 비어 있다. */
const installedVersion = new Map<Engine, string>();

/**
 * 그 엔진의 CLI 실제 설치 버전을 알려 준다. 데몬이 기동할 때 한 번 부른다(`cliVersion.ts` 가 읽는다).
 * `undefined`(못 읽음)를 주면 폴백으로 돌아간다. 맵 캐시는 버전이 바뀌면 비워진다.
 */
export function setInstalledCliVersion(engine: Engine, version: string | undefined): void {
  const norm = version ? majorMinor(version) : undefined;
  const prev = installedVersion.get(engine);
  if (norm === prev) return;
  if (norm) installedVersion.set(engine, norm);
  else installedVersion.delete(engine);
  for (const key of [...cache.keys()]) if (key.startsWith(`${engine}:`)) cache.delete(key);
}

/** 테스트용: 넣어 준 설치 버전을 모두 잊는다. */
export function clearInstalledCliVersions(): void {
  for (const engine of [...installedVersion.keys()]) setInstalledCliVersion(engine, undefined);
}

/** `"0.159.0"` · `"2.1.284 (Claude Code)"` → `"0.159"` · `"2.1"`. 못 읽으면 undefined. */
export function majorMinor(version: string): string | undefined {
  const m = /(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}` : undefined;
}

/** `"0.159"` → `[0, 159]`. 비교용. */
function versionKey(v: string): [number, number] {
  const m = /^(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : [-1, -1];
}

function compareVersions(a: string, b: string): number {
  const [am, an] = versionKey(a);
  const [bm, bn] = versionKey(b);
  return am !== bm ? am - bm : an - bn;
}

/** 그 엔진의 맵이 있는 버전들(파일 이름에서 뽑아 오름차순). 플랫폼 접미사는 떼고 중복을 없앤다. */
export function availableMapVersions(engine: Engine, files: Record<string, TuiMapJson> = BUILTIN_FILES): string[] {
  const versions = new Set<string>();
  for (const file of Object.keys(files)) {
    const m = new RegExp(`^${engine}-(\\d+\\.\\d+)(?:-[a-z0-9]+)?\\.json$`).exec(file);
    if (m) versions.add(m[1]);
  }
  return [...versions].sort(compareVersions);
}

export interface MapVersionChoice {
  /** 쓸 맵 버전. */
  version: string;
  /** 설치된 CLI 버전(`major.minor`). 못 읽었으면 undefined. */
  installed?: string;
  /** 설치 버전과 맵 버전이 **정확히 같은가**. false 면 근접한 맵으로 내려/올려 잡았다는 뜻이다. */
  exact: boolean;
}

/**
 * 설치된 CLI 버전에 **가장 가까운 맵**을 고른다.
 *   ① 같은 버전의 맵이 있으면 그것.
 *   ② 없으면 설치 버전보다 **낮은 중 가장 높은** 맵(아직 안 만든 새 CLI → 제일 최신 맵으로).
 *   ③ 그것도 없으면(설치 버전이 모든 맵보다 낮다) **가장 낮은** 맵.
 *   ④ 설치 버전을 못 읽었으면 `FALLBACK_VERSION`.
 */
export function chooseMapVersion(engine: Engine, files: Record<string, TuiMapJson> = BUILTIN_FILES): MapVersionChoice {
  const fallback = FALLBACK_VERSION[engine];
  const installed = installedVersion.get(engine);
  if (!installed) return { version: fallback, exact: false };
  const versions = availableMapVersions(engine, files);
  if (versions.includes(installed)) return { version: installed, installed, exact: true };
  const lower = versions.filter((v) => compareVersions(v, installed) < 0);
  const chosen = lower.length ? lower[lower.length - 1] : versions[0];
  return { version: chosen ?? fallback, installed, exact: false };
}

/**
 * 내장 맵 파일 표 — **키가 파일 이름**이다(`tui-maps/README.md` 의 이름 규칙).
 * 플랫폼별 맵(`claude-2.1-darwin.json`)이 생기면 import 한 줄과 이 표의 한 줄만 더하면 된다.
 * 지금은 darwin 파일이 **없다** — 맥 실기(2단계 M3/M14)에서 줄바꿈이 다르면 그때 뜬다(D-48 ⑦).
 */
export const BUILTIN_FILES: Record<string, TuiMapJson> = {
  'claude-2.1.json': claude21 as unknown as TuiMapJson,
  'codex-0.154.json': codex0154 as unknown as TuiMapJson,
  'codex-0.159.json': codex0159 as unknown as TuiMapJson,
};

/**
 * 찾을 파일 이름을 **우선순위 순으로**: `<engine>-<ver>-<platform>.json` → `<engine>-<ver>.json`.
 * 맥의 기본 터미널 크기·서체·유니코드 폭 때문에 줄바꿈 위치가 달라질 수 있어 플랫폼 접미사를 먼저 본다(설계 §화면 패턴).
 */
export function tuiMapCandidates(engine: Engine, version: string, platform: NodeJS.Platform): string[] {
  return [`${engine}-${version}-${platform}.json`, `${engine}-${version}.json`];
}

/**
 * 그 엔진·플랫폼이 쓸 맵 파일을 고른다(플랫폼 접미사 우선, 없으면 평범한 파일).
 * `files` 는 테스트가 가짜 표를 넣는 자리다.
 */
export function resolveTuiMapFile(
  engine: Engine,
  platform: NodeJS.Platform = process.platform,
  files: Record<string, TuiMapJson> = BUILTIN_FILES,
): { file: string; json: TuiMapJson; choice: MapVersionChoice } {
  const choice = chooseMapVersion(engine, files);
  const version = choice.version;
  if (!version) throw new Error(`no tui-map for engine ${JSON.stringify(engine)}`);
  for (const file of tuiMapCandidates(engine, version, platform)) {
    const json = files[file];
    if (json) return { file, json, choice };
  }
  throw new Error(`no tui-map file for engine ${JSON.stringify(engine)} on ${platform} (tried ${tuiMapCandidates(engine, version, platform).join(', ')})`);
}

const cache = new Map<string, TuiMap>();

/**
 * 엔진·플랫폼별 내장 tui-map. 한 번 컴파일해 재사용한다.
 * 캐시 키에 **고른 맵 버전**이 들어간다 — `setInstalledCliVersion()` 이 버전을 바꾸면 그 엔진 항목은 지워진다.
 */
export function loadTuiMap(engine: Engine, platform: NodeJS.Platform = process.platform): TuiMap {
  const key = `${engine}:${platform}:${chooseMapVersion(engine).version}`;
  let m = cache.get(key);
  if (!m) {
    m = compileTuiMap(resolveTuiMapFile(engine, platform).json);
    cache.set(key, m);
  }
  return m;
}
