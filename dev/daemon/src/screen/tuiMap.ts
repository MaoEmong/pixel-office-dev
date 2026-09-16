// tui-map 로더. CLI 버전별 화면 패턴(준비 문구·다이얼로그·키 시퀀스)은 src/tui-maps/*.json 에만 둔다.
// 여기서는 JSON 을 읽어 정규식으로 컴파일하고, kind/keys 값이 허용 집합에 있는지 검사한다.
import claude21 from '../tui-maps/claude-2.1.json' with { type: 'json' };
import codex0154 from '../tui-maps/codex-0.154.json' with { type: 'json' };

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
  };
  Object.defineProperty(map, COMPILED, { value: true, enumerable: false });
  return map;
}

const BUILTIN: Record<Engine, TuiMapJson> = {
  claude: claude21 as unknown as TuiMapJson,
  codex: codex0154 as unknown as TuiMapJson,
};

const cache = new Map<Engine, TuiMap>();

/** 엔진별 내장 tui-map. 한 번 컴파일해 재사용. */
export function loadTuiMap(engine: Engine): TuiMap {
  let m = cache.get(engine);
  if (!m) {
    const json = BUILTIN[engine];
    if (!json) throw new Error(`no tui-map for engine ${JSON.stringify(engine)}`);
    m = compileTuiMap(json);
    cache.set(engine, m);
  }
  return m;
}
