// Claude transcript 의 `cost-state` 줄 파서(T43, D-45 ②). 순수 함수.
//
// transcript(JSONL)에는 `type:"cost-state"` 줄이 주기적으로 append 된다 — **CLI 자신이 계산한 세션 누적**이다
// (실측 T43-0 Q1). assistant 줄의 `usage` 를 직접 합산하면 같은 응답이 여러 줄로 기록돼 **이중 계산**되므로
// 이 줄을 쓴다. 모델별(`modelUsage`)로 나뉘어 있어 서브에이전트가 쓴 haiku 도 함께 잡힌다.
//
// 꼬리 64KB 만 읽으므로 첫 줄은 잘려 있을 수 있다 → JSON 파싱 실패한 줄은 그냥 건너뛴다.
import { isRecord, toCount, type UsageTokens } from '../types.js';

export interface ClaudeCostState {
  /** 누적 비용(USD). */
  costUsd: number | null;
  /** 모델별 합산 누적 토큰. */
  tokens: UsageTokens | null;
  sessionId: string | null;
}

const EMPTY: ClaudeCostState = { costUsd: null, tokens: null, sessionId: null };

/** `modelUsage` 의 모델별 행을 전부 더한다. 행이 하나도 없으면 null. */
function sumModelUsage(raw: unknown): UsageTokens | null {
  if (!isRecord(raw)) return null;
  let seen = false;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  for (const row of Object.values(raw)) {
    if (!isRecord(row)) continue;
    seen = true;
    input += toCount(row.inputTokens) ?? 0;
    output += toCount(row.outputTokens) ?? 0;
    cacheRead += toCount(row.cacheReadInputTokens) ?? 0;
    cacheCreate += toCount(row.cacheCreationInputTokens) ?? 0;
  }
  if (!seen) return null;
  return { input, output, cacheRead, cacheCreate, total: input + output + cacheRead + cacheCreate };
}

/**
 * transcript 꼬리 텍스트에서 **마지막** `cost-state` 줄을 골라 누적 토큰·비용을 돌려준다.
 * 줄이 하나도 없으면 전부 null(= 아직 모른다. 이전 값을 지우면 안 된다).
 */
export function parseClaudeCostState(tailText: string): ClaudeCostState {
  if (typeof tailText !== 'string' || tailText === '') return { ...EMPTY };
  let last: Record<string, unknown> | undefined;
  for (const line of tailText.split(/\r?\n/)) {
    if (line === '' || !line.includes('cost-state')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 꼬리 경계에서 잘린 줄 · 다른 형식
    }
    if (isRecord(obj) && obj.type === 'cost-state') last = obj;
  }
  if (!last) return { ...EMPTY };
  return {
    costUsd: toCount(last.totalCostUSD),
    tokens: sumModelUsage(last.modelUsage),
    sessionId: typeof last.sessionId === 'string' && last.sessionId ? last.sessionId : null,
  };
}
