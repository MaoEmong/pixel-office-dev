// 사용량 표시(T43, D-45)의 와이어 타입. 모양은 `docs/design/사용량-표시.md` 의 "와이어" 절이 계약이다.
//
// 단위 규칙(D-45 ③): 데몬 안에서는 **전부 `usedPercent`(쓴 비율 0~100)** 다. Codex 화면이 말하는 "남은 %"는
// 데몬이 뒤집어서 넣고, "남음 N%" 표기는 앱이 `100 - usedPercent` 로 만든다.
// 시각은 **ISO 8601(UTC)** 문자열 — CLI 가 주는 유닉스 초는 여기서 ISO 로 바꾼다.
//
// 방어 규칙: **필드 하나가 없거나 이름이 바뀌면 그 값만 `null`** 이고 나머지는 계속 돈다(T43-0 "CLI 업데이트에
// 무엇이 깨지는가"). 그래서 거의 모든 숫자가 `number | null` 이다.
import type { Engine } from '../store/types.js';

/** 엔진이 안 붙어 있는 이유. `connected:false` 일 때만 값이 있다. */
export type NotConnectedReason = 'not-installed' | 'logged-out' | 'unknown';

/** 한도 창 하나(주간 = 7일, session = 5시간). */
export interface UsageWindow {
  /** 쓴 비율 0~100(정수). 모르면 null. */
  usedPercent: number | null;
  /** 리셋 시각(ISO UTC). 모르면 null. */
  resetsAt: string | null;
}

/** 엔진(= 구독) 단위 사용량. `snapshot.usage.engines[]` 와 `usage.engine` 알림의 모양. */
export interface EngineUsage {
  engine: Engine;
  connected: boolean;
  /** 요금제 이름(claude `subscriptionType`, codex `plan_type`). **이메일·계정 식별자는 절대 담지 않는다**(D-45 ②). */
  plan: string | null;
  /** 주간(7일) 한도. 한 번도 못 봤으면 null — "첫 작업 후 표시". */
  weekly: UsageWindow | null;
  /** 5시간 한도. Claude 는 보통 있고 Codex 는 요금제에 따라 없다(null 이 정상). */
  session: UsageWindow | null;
  /** 이 한도 숫자를 마지막으로 확인한 시각(ISO). 한 번도 못 봤으면 null. */
  updatedAt: string | null;
  /** connected=false 일 때의 이유. 붙어 있으면 null. */
  reason: NotConnectedReason | null;
}

/** 멤버 세션의 컨텍스트 사용량. */
export interface UsageContext {
  used: number | null;
  window: number | null;
  percent: number | null;
}

/** 멤버 세션의 누적 토큰. `total` 은 CLI 가 준 값(없으면 합산). */
export interface UsageTokens {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheCreate: number | null;
  total: number | null;
}

/** 멤버(= 캐릭터 세션) 단위 사용량. `snapshot.usage.members[]` 와 `usage.member` 알림의 모양. */
export interface MemberUsage {
  memberId: string;
  engine: Engine;
  context: UsageContext | null;
  tokens: UsageTokens | null;
  /** 누적 비용(USD). **Codex 는 언제나 null**(토큰만 준다). */
  costUsd: number | null;
  /** 이 값을 마지막으로 갱신한 시각(ISO). */
  updatedAt: string;
}

/** `snapshot.usage`. */
export interface UsageSnapshot {
  engines: EngineUsage[];
  members: MemberUsage[];
}

/** 연결 폴링(`claude auth status` / `codex login status`) 한 번의 결과. */
export interface EngineConnection {
  connected: boolean;
  plan: string | null;
  reason: NotConnectedReason | null;
}

/** 유닉스 초 → ISO(UTC). 숫자가 아니거나 말이 안 되는 값이면 null. */
export function isoFromUnixSeconds(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  const ms = v * 1000;
  if (ms > 8.64e15) return null; // Date 범위 밖
  return new Date(ms).toISOString();
}

/** 0~100 정수 퍼센트로 다듬는다. 숫자가 아니면 null. */
export function toPercent(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** 음수가 아닌 유한 숫자만. 아니면 null. */
export function toCount(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
