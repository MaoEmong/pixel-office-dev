// Claude transcript 의 **줄 단위 usage 를 직접 누적**한다(T43-5).
//
// 왜 필요한가: `cost-state` 줄은 **CLI 프로세스가 끝날 때만** 적힌다(실측: 살아 있는 멤버의 transcript 에는 0개,
// 끝난 세션에는 1쌍씩). 우리 멤버 세션은 몇 시간씩 살아 있으므로 `parseClaudeCostState` 는 아무것도 못 찾고,
// 팝오버의 토큰 칸이 계속 "—" 였다. 그래서 **살아 있는 동안에는 `type:"assistant"` 줄의 `message.usage` 를 직접
// 더한다.** `cost-state` 가 나타나면(세션 종료) 그쪽이 최종값으로 이긴다 — CLI 자신의 계산이니까.
//
// 실측으로 확인한 규칙(`docs/worklog/T43-5-ClaudeTokens.md` 에 근거 전문):
//
//   1. **같은 `message.id` 가 여러 줄에 걸쳐 나온다**(내용 블록이 스트리밍되면서 줄이 여러 번 적힌다). 그냥 더하면
//      이중 계산이다. 게다가 **앞 줄과 뒤 줄의 usage 가 다를 수 있다** — 앞 줄은 `output_tokens:1` 같은 중간값이고
//      마지막 줄이 완성값이다(실측 481건 중 112건이 달랐다). 그래서 **id 마다 마지막 값 하나만** 센다.
//   2. `output_tokens` 에는 **사고 토큰이 이미 포함돼 있다.** `cost-state` 의 `outputTokens` 가 줄 합과 정확히
//      같고 `thinkingTokens` 는 그 안의 부분집합으로 따로 적힌다(실측). → **`output` 에 더하지 않는다.**
//   3. `usage` 를 들고 있는 줄은 **`type:"assistant"` 뿐이다**(88개 파일 전수 확인).
//   4. 누적은 **transcript 파일 하나가 단위**다. `--resume` 이 새 파일을 만들면 CLI 자신의 `/cost` 도 0 부터
//      다시 센다(실측) → 경로가 바뀌면 **리셋**한다.
//
// 이 모듈은 **순수**다(파일을 열지 않는다). 파일을 읽는 얇은 겉껍질은 `claudeTranscriptReader.ts`.
import { isRecord, type UsageTokens } from './types.js';

/** 기억할 `message.id` 최대 개수. 넘으면 오래된 것부터 버린다(메모리 상한). */
export const MAX_SEEN_IDS = 2000;

/** 한 모델이 쓴 양. `thinking` 은 `output` 의 **부분집합**이라 합계에 더하지 않는다(위 규칙 2). */
export interface ClaudeModelTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  thinking: number;
}

/**
 * 한 transcript 파일을 어디까지 읽었고 무엇을 세었는가. **불변**이다 —
 * `advanceClaudeTranscript` 는 새 객체를 돌려준다.
 */
export interface ClaudeTranscriptState {
  /** 이 상태가 따라가는 파일. 빈 문자열이면 아직 아무 파일도 안 붙었다. */
  readonly path: string;
  /** 다음에 읽기 시작할 바이트 위치(= 지금까지 소비한 바이트). */
  readonly offset: number;
  /** 청크가 줄 한가운데서 끝났을 때 남겨 둔 조각. 다음 청크 앞에 붙인다. */
  readonly partialLine: string;
  /** 이미 센 `message.id` — 오래된 것이 앞. 최대 `MAX_SEEN_IDS` 개. */
  readonly seenIds: readonly string[];
  /** id → 그 id 로 **마지막에 센** 값. 같은 id 가 또 오면 이만큼 빼고 새 값을 더한다. */
  readonly counted: Readonly<Record<string, ClaudeModelTotals & { model: string }>>;
  /** 모델(`message.model`)별 누적. */
  readonly byModel: Readonly<Record<string, ClaudeModelTotals>>;
  /** 파일 앞부분을 상한 때문에 못 읽었다 → 합계가 **모자란다**. 와이어에는 나가지 않는다(내부 표시). */
  readonly partial: boolean;
}

const ZERO: ClaudeModelTotals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0 };

/** 아무것도 안 읽은 상태. */
export function emptyClaudeTranscriptState(path = ''): ClaudeTranscriptState {
  return { path, offset: 0, partialLine: '', seenIds: [], counted: {}, byModel: {}, partial: false };
}

/** 음수가 아닌 정수만 센다. 문자열·null·NaN 은 0(합계가 통째로 깨지는 것보다 낫다). */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** `type:"assistant"` 한 줄에서 셀 값을 뽑는다. 셀 수 없는 줄이면 `null`. */
function readAssistantUsage(obj: unknown): { id: string; model: string; totals: ClaudeModelTotals } | null {
  if (!isRecord(obj) || obj.type !== 'assistant') return null;
  const message = obj.message;
  if (!isRecord(message)) return null;
  const id = message.id;
  // id 가 없으면 중복 제거를 할 수 없다 → 세지 않는다(합성 줄·모양이 바뀐 줄).
  if (typeof id !== 'string' || id === '') return null;
  const usage = message.usage;
  if (!isRecord(usage)) return null;
  const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  return {
    id,
    // 모델 이름이 없으면 한 바구니에 담는다(합계는 어차피 모델을 합친 값이다).
    model: typeof message.model === 'string' && message.model ? message.model : 'unknown',
    totals: {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheCreate: num(usage.cache_creation_input_tokens),
      thinking: num(details?.thinking_tokens),
    },
  };
}

function addInto(target: Record<string, ClaudeModelTotals>, model: string, t: ClaudeModelTotals, sign: 1 | -1): void {
  const prev = target[model] ?? ZERO;
  target[model] = {
    input: prev.input + sign * t.input,
    output: prev.output + sign * t.output,
    cacheRead: prev.cacheRead + sign * t.cacheRead,
    cacheCreate: prev.cacheCreate + sign * t.cacheCreate,
    thinking: prev.thinking + sign * t.thinking,
  };
}

/**
 * 새로 덧붙은 텍스트 `chunk` 를 반영한 **새 상태**를 돌려준다. 순수 함수 — 파일을 열지 않는다.
 *
 * `chunkBytes` 는 그 청크가 파일에서 차지한 바이트 수다(기본은 UTF-8 길이). 호출자가 줄 경계에서 잘라 읽었다면
 * 그 길이를 그대로 넘기면 offset 이 정확히 맞는다.
 */
export function advanceClaudeTranscript(
  prev: ClaudeTranscriptState,
  chunk: string,
  chunkBytes: number = Buffer.byteLength(chunk, 'utf8'),
): ClaudeTranscriptState {
  if (chunk === '') return prev;
  const text = prev.partialLine + chunk;
  // 마지막 줄바꿈 뒤는 아직 완성되지 않은 줄이다 — 다음 청크 앞에 붙인다.
  const cut = text.lastIndexOf('\n');
  const complete = cut < 0 ? '' : text.slice(0, cut);
  const partialLine = cut < 0 ? text : text.slice(cut + 1);

  const byModel: Record<string, ClaudeModelTotals> = { ...prev.byModel };
  const counted: Record<string, ClaudeModelTotals & { model: string }> = { ...prev.counted };
  const seenIds = [...prev.seenIds];

  for (const raw of complete.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    // 값싼 선별 — transcript 줄의 대부분은 attachment 라 통째로 파싱할 이유가 없다.
    if (line === '' || !line.includes('"assistant"')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 잘린 줄 · 모양이 바뀐 줄 — 조용히 건너뛴다
    }
    const row = readAssistantUsage(obj);
    if (!row) continue;
    const before = counted[row.id];
    if (before) {
      // 같은 id 가 또 왔다 = 스트리밍 중간값을 완성값으로 **교체**한다(더하지 않는다).
      addInto(byModel, before.model, before, -1);
    } else {
      seenIds.push(row.id);
    }
    addInto(byModel, row.model, row.totals, 1);
    counted[row.id] = { ...row.totals, model: row.model };
  }

  // 메모리 상한: 오래된 id 부터 잊는다. 잊은 id 가 **다시** 나오면 그때는 이중 계산이 되지만,
  // 중복 줄은 언제나 바로 뒤에 붙어 나오므로(실측) 2000줄 뒤에 다시 나올 일은 없다.
  while (seenIds.length > MAX_SEEN_IDS) {
    const gone = seenIds.shift();
    if (gone !== undefined) delete counted[gone];
  }

  return {
    path: prev.path,
    offset: prev.offset + chunkBytes,
    partialLine,
    seenIds,
    counted,
    byModel,
    partial: prev.partial,
  };
}

/** 모델별 누적을 합친 와이어 값. 한 줄도 못 셌으면 `null`(= 아직 모른다, 이전 값을 지우지 않는다). */
export function claudeTranscriptTotals(state: ClaudeTranscriptState): UsageTokens | null {
  const rows = Object.values(state.byModel);
  if (rows.length === 0) return null;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  for (const r of rows) {
    input += r.input;
    output += r.output;
    cacheRead += r.cacheRead;
    cacheCreate += r.cacheCreate;
  }
  // `thinking` 은 더하지 않는다 — `output` 안에 이미 들어 있다(위 규칙 2).
  return { input, output, cacheRead, cacheCreate, total: input + output + cacheRead + cacheCreate };
}

/** 모델별 내역(내부용 — 와이어에는 나가지 않는다). 디버깅·검증에 쓴다. */
export function claudeTranscriptByModel(state: ClaudeTranscriptState): Record<string, ClaudeModelTotals> {
  return { ...state.byModel };
}
