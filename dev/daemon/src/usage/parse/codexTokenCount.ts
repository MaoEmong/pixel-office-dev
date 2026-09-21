// Codex rollout(JSONL)의 `token_count` 이벤트 파서(T43, D-45 ③). 순수 함수.
//
// hook 페이로드의 `transcript_path` 가 rollout 파일을 가리킨다(경로를 조립할 필요가 없다). 턴마다 정확히 하나씩
// `event_msg/token_count` 가 append 되고 `Stop` hook 과 밀리초 차이다(실측 T43-0 Q6).
//
// **빈 이벤트 함정:** `limit_id:"premium"` + `info:null` + `primary:null` 인 이벤트가 섞인다. 그래서
// **`rate_limits.limit_id === "codex"` 이고 `primary != null` 인 마지막 이벤트**를 고른다(설계 문서 그대로).
// 컨텍스트·누적 토큰은 그 이벤트의 `info` 에서 읽되, 고른 이벤트의 `info` 가 비어 있으면(있을 수 있다)
// **`info` 가 있는 마지막 이벤트**로 떨어진다 — 값을 통째로 잃는 것보다 낫고, 정상 캡처에서는 같은 이벤트다.
import { isoFromUnixSeconds, isRecord, toCount, toPercent, type UsageContext, type UsageTokens, type UsageWindow } from '../types.js';

/** 주간 한도 창 길이(분). `primary.window_minutes` 가 이 값이면 7일 창이다. */
export const WEEKLY_WINDOW_MINUTES = 10080;

export interface CodexTokenCount {
  /** 주간 한도 = `rate_limits.primary`. */
  weekly: UsageWindow | null;
  /** 5시간 한도 = `rate_limits.secondary`. Pro 계정 실측에서는 전수 null(정상). */
  session: UsageWindow | null;
  /** `rate_limits.plan_type`. */
  plan: string | null;
  context: UsageContext | null;
  tokens: UsageTokens | null;
}

const EMPTY: CodexTokenCount = { weekly: null, session: null, plan: null, context: null, tokens: null };

function windowOf(raw: unknown): UsageWindow | null {
  if (!isRecord(raw)) return null;
  const usedPercent = toPercent(raw.used_percent);
  const resetsAt = isoFromUnixSeconds(raw.resets_at);
  if (usedPercent === null && resetsAt === null) return null;
  return { usedPercent, resetsAt };
}

/** `info` → 컨텍스트(마지막 요청의 입력 토큰 / 모델 컨텍스트 창). */
function contextOf(info: Record<string, unknown>): UsageContext | null {
  const last = isRecord(info.last_token_usage) ? info.last_token_usage : undefined;
  const used = last ? toCount(last.input_tokens) : null;
  const window = toCount(info.model_context_window);
  if (used === null && window === null) return null;
  const percent = used !== null && window !== null && window > 0 ? toPercent((used / window) * 100) : null;
  return { used, window, percent };
}

/** `info.total_token_usage` → 누적 토큰. `total_tokens` 는 CLI 가 직접 합산해 준다(직접 더하지 않는다). */
function tokensOf(info: Record<string, unknown>): UsageTokens | null {
  const t = info.total_token_usage;
  if (!isRecord(t)) return null;
  const input = toCount(t.input_tokens);
  const output = toCount(t.output_tokens);
  const total = toCount(t.total_tokens) ?? (input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null);
  return {
    input,
    output,
    cacheRead: toCount(t.cached_input_tokens),
    cacheCreate: toCount(t.cache_write_input_tokens),
    total,
  };
}

/** rollout 한 줄이 `token_count` 이벤트면 그 payload 를 돌려준다. */
function tokenCountPayload(line: string): Record<string, unknown> | undefined {
  if (line === '' || !line.includes('token_count')) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined; // 꼬리 경계에서 잘린 줄
  }
  if (!isRecord(obj)) return undefined;
  const payload = obj.payload;
  if (!isRecord(payload) || payload.type !== 'token_count') return undefined;
  return payload;
}

/**
 * rollout 꼬리 텍스트 → 주간·5시간 한도 + 요금제 + 컨텍스트 + 누적 토큰.
 * 조건에 맞는 이벤트가 없으면 전부 null(= 아직 모른다).
 */
export function parseCodexTokenCounts(tailText: string): CodexTokenCount {
  if (typeof tailText !== 'string' || tailText === '') return { ...EMPTY };
  let chosen: Record<string, unknown> | undefined; // limit_id==='codex' ∧ primary!=null 인 마지막 것
  let lastWithInfo: Record<string, unknown> | undefined;
  for (const line of tailText.split(/\r?\n/)) {
    const payload = tokenCountPayload(line);
    if (!payload) continue;
    if (isRecord(payload.info)) lastWithInfo = payload;
    const limits = payload.rate_limits;
    if (!isRecord(limits)) continue;
    if (limits.limit_id !== 'codex') continue; // 빈 'premium' 이벤트를 거른다
    if (!isRecord(limits.primary)) continue; // primary 가 null 인 것도 거른다
    chosen = payload;
  }
  if (!chosen && !lastWithInfo) return { ...EMPTY };

  const limits = chosen && isRecord(chosen.rate_limits) ? chosen.rate_limits : undefined;
  const info = chosen && isRecord(chosen.info) ? chosen.info : lastWithInfo && isRecord(lastWithInfo.info) ? lastWithInfo.info : undefined;
  return {
    weekly: limits ? windowOf(limits.primary) : null,
    session: limits ? windowOf(limits.secondary) : null,
    plan: limits && typeof limits.plan_type === 'string' && limits.plan_type ? limits.plan_type : null,
    context: info ? contextOf(info) : null,
    tokens: info ? tokensOf(info) : null,
  };
}
