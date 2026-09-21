// Claude statusLine 페이로드 파서(T43, D-45 ②). 순수 함수 — 파일·네트워크를 건드리지 않는다.
//
// 세션 `--settings` 에 넣은 `statusLine{type:'command'}` 이 **상태줄을 다시 그릴 때마다** stdin 으로 주는 JSON 이다
// (실측 T43-0 Q2, 원자료 `dev/spike-1/out/statusline.jsonl`). 폴링 채널이 아니라 이벤트 채널이라 데몬은
// **마지막 값만** 들고 있으면 된다.
//
// 함정(실측):
//   - **첫 API 호출 전에는 `rate_limits` 키가 아예 없다.** `--resume` 직후에도 없다 → weekly/session 은 null 이 되고
//     데몬은 DB 에 남은 마지막 값을 계속 보여 준다("첫 작업 후 표시").
//   - 그때 `context_window.current_usage` 와 `used_percentage` 도 `null` 이다(키는 있다).
//   - `resets_at` 은 **유닉스 초**다(화면의 사람 표기가 아니다).
import { isoFromUnixSeconds, isRecord, toCount, toPercent, type UsageContext, type UsageWindow } from '../types.js';

/** statusLine 페이로드에서 뽑아내는 것. 없는 값은 전부 null(필드별 방어). */
export interface ClaudeStatusLineInfo {
  sessionId: string | null;
  /** 같은 세션의 transcript 경로 — `cost-state` 꼬리 읽기에 쓴다(hook 이 주는 것과 같은 값). */
  transcriptPath: string | null;
  /** 컨텍스트. `context_window` 자체가 없으면 null. */
  context: UsageContext | null;
  /** 누적 비용(USD). `cost.total_cost_usd`. */
  costUsd: number | null;
  /** 주간 한도 = `rate_limits.seven_day`. 첫 턴 전에는 null. */
  weekly: UsageWindow | null;
  /** 5시간 한도 = `rate_limits.five_hour`. */
  session: UsageWindow | null;
}

const EMPTY: ClaudeStatusLineInfo = {
  sessionId: null,
  transcriptPath: null,
  context: null,
  costUsd: null,
  weekly: null,
  session: null,
};

/** `{used_percentage, resets_at}` → UsageWindow. 둘 다 없으면 null(= 이 창을 못 봤다). */
function windowOf(raw: unknown): UsageWindow | null {
  if (!isRecord(raw)) return null;
  const usedPercent = toPercent(raw.used_percentage);
  const resetsAt = isoFromUnixSeconds(raw.resets_at);
  if (usedPercent === null && resetsAt === null) return null;
  return { usedPercent, resetsAt };
}

/**
 * `context_window` → UsageContext.
 * `used` 는 `current_usage` 네 값의 합(= 실측에서 `total_input_tokens` 와 정확히 같았다),
 * `current_usage` 가 null 이면 `total_input_tokens` 로 폴백한다.
 */
function contextOf(raw: unknown): UsageContext | null {
  if (!isRecord(raw)) return null;
  let used: number | null = null;
  const cur = raw.current_usage;
  if (isRecord(cur)) {
    // 입력 쪽 세 값만 더한다(output 은 컨텍스트가 아니라 생성분). 실측: 2 + 14495 + 29413 = 43910 = total_input_tokens.
    const input = [cur.input_tokens, cur.cache_creation_input_tokens, cur.cache_read_input_tokens]
      .map(toCount)
      .filter((n): n is number => n !== null);
    if (input.length > 0) used = input.reduce((a, b) => a + b, 0);
  }
  if (used === null) used = toCount(raw.total_input_tokens);
  return { used, window: toCount(raw.context_window_size), percent: toPercent(raw.used_percentage) };
}

/**
 * statusLine 이 stdin 으로 준 JSON(이미 파싱된 객체 또는 원문 문자열) → 사용량.
 * 객체가 아니거나 JSON 이 아니면 전부 null 인 결과를 돌려준다(절대 throw 하지 않는다).
 */
export function parseClaudeStatusLine(payload: unknown): ClaudeStatusLineInfo {
  let obj: unknown = payload;
  if (typeof payload === 'string') {
    try {
      obj = JSON.parse(payload);
    } catch {
      return { ...EMPTY };
    }
  }
  if (!isRecord(obj)) return { ...EMPTY };

  const limits = isRecord(obj.rate_limits) ? obj.rate_limits : undefined;
  const cost = isRecord(obj.cost) ? obj.cost : undefined;
  return {
    sessionId: typeof obj.session_id === 'string' && obj.session_id ? obj.session_id : null,
    transcriptPath: typeof obj.transcript_path === 'string' && obj.transcript_path ? obj.transcript_path : null,
    context: contextOf(obj.context_window),
    costUsd: cost ? toCount(cost.total_cost_usd) : null,
    weekly: limits ? windowOf(limits.seven_day) : null,
    session: limits ? windowOf(limits.five_hour) : null,
  };
}
