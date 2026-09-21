// UsageTracker — 엔진(구독) 사용량과 멤버(캐릭터 세션) 사용량의 메모리 상태 + 영속(T43, D-45).
// 설계 전문: `docs/design/사용량-표시.md`.
//
// 입력은 세 갈래다:
//   1. **statusLine**(Claude) — `HookReceiver` 의 `POST /status/<memberToken>` 으로 들어온다. 턴이 끝날 때와
//      화면을 다시 그릴 때마다 오는 **이벤트 채널**이라(폴링이 아니다) 마지막 값만 들고 있으면 된다.
//   2. **턴 종료**(`Stop`, Codex 는 화면 idle 폴백 포함) — Claude 는 transcript 의 `cost-state` 꼬리,
//      Codex 는 rollout 의 `token_count` 꼬리를 읽는다.
//   3. **연결 폴링**(기동 시 + 60초) — `claude auth status` / `codex login status`.
//
// 규칙:
//   - **바뀔 때만 알린다.** 값이 그대로면 아무 일도 하지 않는다. 다만 값이 같아도 마지막 갱신이
//     `refreshMs`(기본 60초)보다 오래됐으면 `updatedAt` 만 올려 한 번 민다 — 앱이 "N분 전 기준" 을 말하는데
//     방금 다시 확인한 값을 10분 전 것처럼 보여 주면 거짓말이 된다. 상한이 있으니 분당 한 번을 넘지 않는다.
//   - **연결 폴링은 `updatedAt` 을 건드리지 않는다.** 그건 "한도 숫자를 마지막으로 확인한 시각" 이다.
//   - **이메일·계정 식별자는 들어오지도 않는다**(파서가 읽지 않는다, D-45 ②).
//   - 파일 읽기는 전부 비동기·64KB 상한·실패 내성. 못 읽으면 **이전 값을 그대로 둔다**(지우지 않는다).
import { EventEmitter } from 'node:events';
import type { Store } from '../store/Store.js';
import type { Engine } from '../store/types.js';
import { probeClaudeConnection, probeCodexConnection } from './connection.js';
import { parseClaudeCostState } from './parse/claudeCostState.js';
import { parseClaudeStatusLine } from './parse/claudeStatusLine.js';
import { parseCodexTokenCounts } from './parse/codexTokenCount.js';
import { readTail as defaultReadTail } from './tail.js';
import type {
  EngineConnection,
  EngineUsage,
  MemberUsage,
  UsageContext,
  UsageModel,
  UsageSnapshot,
  UsageSource,
  UsageTokens,
  UsageWindow,
} from './types.js';

export const ENGINES: readonly Engine[] = ['claude', 'codex'];

/** 값이 그대로여도 이만큼 지나면 `updatedAt` 만 올려 한 번 더 민다. */
export const DEFAULT_REFRESH_MS = 60_000;
/** 연결 폴링 주기 기본값. */
export const DEFAULT_POLL_MS = 60_000;

export interface UsageTrackerEvents {
  /** 엔진 사용량이 바뀌었다 → `usage.engine` 알림. */
  engine: [usage: EngineUsage];
  /** 멤버 사용량이 바뀌었다 → `usage.member` 알림. */
  member: [usage: MemberUsage];
}

export interface UsageTrackerOptions {
  store: Store;
  /** 지금(epoch ms). 테스트에서 고정. */
  now?: () => number;
  /** 연결 폴링 주기(ms). 0 이하면 타이머를 걸지 않는다(테스트·수동 호출). */
  pollIntervalMs?: number;
  /** 같은 값일 때 `updatedAt` 을 다시 미는 간격(ms). */
  refreshMs?: number;
  probeClaude?: () => Promise<EngineConnection>;
  probeCodex?: () => Promise<EngineConnection>;
  /** 기록 파일 꼬리 읽기(테스트 대체용). */
  readTail?: (file: string) => Promise<string>;
}

/** `applyStatusLine` · 턴 종료가 받는 멤버 최소 정보. */
export interface UsageMemberRef {
  id: string;
  engine: Engine;
}

interface LimitPatch {
  weekly?: UsageWindow | null;
  session?: UsageWindow | null;
  /** 모델별 주간 한도(확인용 세션 전용). 빈 배열도 "봤는데 없더라" 가 아니라 **안 준 것**으로 친다. */
  models?: UsageModel[] | null;
  plan?: string | null;
}

/** 한도 칸별 "이 값을 언제 읽었나"(epoch ms). 더 최근 것이 이긴다(T43-4). */
interface LimitStamps {
  weekly: number;
  session: number;
  models: number;
}

function emptyStamps(): LimitStamps {
  return { weekly: Number.NEGATIVE_INFINITY, session: Number.NEGATIVE_INFINITY, models: Number.NEGATIVE_INFINITY };
}

interface MemberPatch {
  context?: UsageContext | null;
  tokens?: UsageTokens | null;
  costUsd?: number | null;
}

function emptyEngine(engine: Engine): EngineUsage {
  // 폴링 전에는 "물어보지 않았다" 다. 앱은 회색 칩으로 그린다.
  return { engine, connected: false, plan: null, weekly: null, session: null, models: [], updatedAt: null, source: null, reason: 'unknown' };
}

/** `updatedAt` 을 뺀 나머지가 같은가(변화 감지). 값이 작아 JSON 비교로 충분하다. */
function sameExceptUpdatedAt(a: object, b: object): boolean {
  const strip = (o: object) => JSON.stringify({ ...(o as Record<string, unknown>), updatedAt: null });
  return strip(a) === strip(b);
}

/** ISO 문자열 사이 경과(ms). 못 읽으면 Infinity(= 오래됐다). */
function ageMs(iso: string | null, now: number): number {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? now - t : Infinity;
}

export class UsageTracker extends EventEmitter<UsageTrackerEvents> {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly refreshMs: number;
  private readonly probeClaude: () => Promise<EngineConnection>;
  private readonly probeCodex: () => Promise<EngineConnection>;
  private readonly readTail: (file: string) => Promise<string>;
  private readonly engines = new Map<Engine, EngineUsage>();
  private readonly stamps = new Map<Engine, LimitStamps>();
  private readonly members = new Map<string, MemberUsage>();
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;

  constructor(opts: UsageTrackerOptions) {
    super();
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
    this.probeClaude = opts.probeClaude ?? (() => probeClaudeConnection());
    this.probeCodex = opts.probeCodex ?? (() => probeCodexConnection());
    this.readTail = opts.readTail ?? ((file) => defaultReadTail(file));
    this.load();
  }

  // ---- 조회 ------------------------------------------------------------------

  /** `snapshot.usage`. 엔진은 항상 둘 다 실린다(한 번도 못 본 엔진은 reason:'unknown'). */
  snapshotUsage(): UsageSnapshot {
    return {
      engines: ENGINES.map((e) => ({ ...this.engineUsage(e) })),
      members: [...this.members.values()].map((m) => ({ ...m })),
    };
  }

  engineUsage(engine: Engine): EngineUsage {
    return this.engines.get(engine) ?? emptyEngine(engine);
  }

  memberUsage(memberId: string): MemberUsage | undefined {
    const m = this.members.get(memberId);
    return m ? { ...m } : undefined;
  }

  /**
   * 터미널 상태 줄에 찍을 한 줄: `컨텍스트 37% · 주간 45% 남음`.
   * **모르는 칸은 뺀다** — 둘 다 모르면 빈 문자열(그러면 statusline.js 가 빈 줄을 찍는다).
   * 주간은 사용자 표현대로 "남음"(= 100 − usedPercent), 컨텍스트는 쓴 비율이다.
   */
  statusLineText(memberId: string, engine: Engine): string {
    const parts: string[] = [];
    const ctx = this.members.get(memberId)?.context?.percent;
    if (typeof ctx === 'number') parts.push(`컨텍스트 ${ctx}%`);
    const weekly = this.engines.get(engine)?.weekly?.usedPercent;
    if (typeof weekly === 'number') parts.push(`주간 ${100 - weekly}% 남음`);
    return parts.join(' · ');
  }

  // ---- 입력 ① statusLine (Claude) ---------------------------------------------

  /**
   * statusLine 페이로드 한 장을 반영하고 **상태 줄 텍스트**를 돌려준다.
   * 첫 턴 전·`--resume` 직후에는 `rate_limits` 가 없어 엔진 한도는 건드리지 않는다(마지막 값 유지).
   */
  applyStatusLine(member: UsageMemberRef, payload: unknown): string {
    const info = parseClaudeStatusLine(payload);
    if (info.weekly || info.session) {
      this.recordEngineLimits(member.engine, { weekly: info.weekly, session: info.session }, 'turn');
    }
    if (info.context || info.costUsd !== null) {
      this.recordMemberUsage(member, { context: info.context, costUsd: info.costUsd });
    }
    return this.statusLineText(member.id, member.engine);
  }

  // ---- 입력 ② 턴 종료 ----------------------------------------------------------

  /** 엔진에 맞는 꼬리 읽기. `transcriptPath` 가 없으면 아무 일도 하지 않는다. */
  async applyTurnEnd(member: UsageMemberRef, transcriptPath: string | null | undefined): Promise<void> {
    if (!transcriptPath) return;
    if (member.engine === 'codex') return this.applyCodexTurnEnd(member, transcriptPath);
    return this.applyClaudeTurnEnd(member, transcriptPath);
  }

  /** Claude: transcript 꼬리의 마지막 `cost-state` → 누적 토큰·비용. */
  async applyClaudeTurnEnd(member: UsageMemberRef, transcriptPath: string): Promise<void> {
    const tail = await this.readTailSafe(transcriptPath);
    if (tail === '') return;
    const cs = parseClaudeCostState(tail);
    if (!cs.tokens && cs.costUsd === null) return;
    this.recordMemberUsage(member, { tokens: cs.tokens, costUsd: cs.costUsd });
  }

  /** Codex: rollout 꼬리의 마지막 `token_count` → 엔진 한도 + 멤버 컨텍스트·누적 토큰(비용은 없다). */
  async applyCodexTurnEnd(member: UsageMemberRef, transcriptPath: string): Promise<void> {
    const tail = await this.readTailSafe(transcriptPath);
    if (tail === '') return;
    const tc = parseCodexTokenCounts(tail);
    if (tc.weekly || tc.session || tc.plan) {
      this.recordEngineLimits(member.engine, { weekly: tc.weekly, session: tc.session, plan: tc.plan }, 'turn');
    }
    if (tc.context || tc.tokens) {
      this.recordMemberUsage(member, { context: tc.context, tokens: tc.tokens, costUsd: null });
    }
  }

  // ---- 입력 ③ 확인용 세션 화면 (T43-4) ------------------------------------------

  /**
   * 확인용 세션(`UsageProbe`)이 `/usage`·`/status` 화면에서 읽은 한도를 반영한다.
   *
   * 턴이 한 번도 없어도(= statusLine·rollout 이 아무 말도 안 해도) 숫자가 들어오는 유일한 길이다.
   * 턴 종료 값과 **칸마다 더 최근 것이 이긴다** — `measuredAt` 은 화면을 실제로 읽은 시각이다.
   */
  applyProbe(engine: Engine, patch: { weekly?: UsageWindow | null; session?: UsageWindow | null; models?: UsageModel[]; plan?: string | null }, measuredAt: number = this.now()): void {
    this.recordEngineLimits(engine, patch, 'probe', measuredAt);
  }

  // ---- 입력 ④ 연결 폴링 --------------------------------------------------------

  /** 기동 시 한 번 + 주기 타이머. 두 번 불러도 타이머는 하나. */
  start(): void {
    void this.pollConnections();
    if (this.timer || !(this.pollIntervalMs > 0)) return;
    this.timer = setInterval(() => void this.pollConnections(), this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 두 엔진을 병렬로 확인. 절대 던지지 않는다(폴링이 데몬을 죽이면 안 된다). 겹쳐 부르면 앞의 것을 기다린다. */
  pollConnections(): Promise<void> {
    if (this.polling) return this.polling;
    const done = (async () => {
      const [claude, codex] = await Promise.all([
        this.probeClaude().catch((err) => {
          console.warn('[usage] claude 연결 확인 실패:', err);
          return { connected: false, plan: null, reason: 'unknown' } as EngineConnection;
        }),
        this.probeCodex().catch((err) => {
          console.warn('[usage] codex 연결 확인 실패:', err);
          return { connected: false, plan: null, reason: 'unknown' } as EngineConnection;
        }),
      ]);
      this.setConnection('claude', claude);
      this.setConnection('codex', codex);
    })().finally(() => {
      this.polling = undefined;
    });
    this.polling = done;
    return done;
  }

  /**
   * 연결 상태만 갈아 끼운다. `updatedAt`(한도를 마지막으로 확인한 시각)은 건드리지 않는다.
   * 요금제는 **덮어쓰지 않는다** — Codex 는 `login status` 가 요금제를 주지 않고 rollout 이 준다.
   */
  setConnection(engine: Engine, conn: EngineConnection): void {
    const prev = this.engineUsage(engine);
    const next: EngineUsage = {
      ...prev,
      connected: conn.connected,
      plan: conn.plan ?? prev.plan,
      reason: conn.connected ? null : (conn.reason ?? 'unknown'),
    };
    this.writeEngine(next, prev);
  }

  // ---- 멤버 정리 ---------------------------------------------------------------

  /** 멤버가 사라졌다(부서·팀 삭제). 행은 FK cascade 로도 지워지지만 메모리 상태는 여기서 비운다. */
  removeMember(memberId: string): void {
    this.members.delete(memberId);
    try {
      this.store.deleteMemberUsage(memberId);
    } catch (err) {
      console.warn(`[usage] member_usage 삭제 실패(${memberId}):`, err);
    }
  }

  /** 지금 DB 에 없는 멤버의 사용량 행을 메모리에서 지운다(기동 복구용). */
  pruneMissingMembers(): void {
    for (const memberId of [...this.members.keys()]) {
      if (!this.store.getMember(memberId)) this.members.delete(memberId);
    }
  }

  // ---- 내부 --------------------------------------------------------------------

  /** DB 에 남아 있는 마지막 값을 메모리로. 깨진 행은 조용히 버린다. */
  private load(): void {
    for (const row of this.store.listEngineUsage()) {
      const value = row.value as Partial<EngineUsage> | null;
      if (!value || typeof value !== 'object') continue;
      // 옛 데몬(v3)이 쓴 행에는 `models`·`source` 가 없다 — 기본값으로 채운다.
      const models = Array.isArray(value.models) ? value.models : [];
      const source = value.source === 'probe' || value.source === 'turn' ? value.source : null;
      const usage: EngineUsage = { ...emptyEngine(row.engine), ...value, models, source, engine: row.engine };
      this.engines.set(row.engine, usage);
      // 재기동 뒤에도 "언제 읽은 값인가" 를 알아야 새 측정과 나이를 견줄 수 있다.
      const at = usage.updatedAt ? Date.parse(usage.updatedAt) : Number.NaN;
      if (Number.isFinite(at)) {
        this.stamps.set(row.engine, {
          weekly: usage.weekly ? at : Number.NEGATIVE_INFINITY,
          session: usage.session ? at : Number.NEGATIVE_INFINITY,
          models: usage.models.length ? at : Number.NEGATIVE_INFINITY,
        });
      }
    }
    for (const row of this.store.listMemberUsage()) {
      const value = row.value as Partial<MemberUsage> | null;
      if (!value || typeof value !== 'object' || !value.engine) continue;
      this.members.set(row.memberId, {
        memberId: row.memberId,
        engine: value.engine,
        context: value.context ?? null,
        tokens: value.tokens ?? null,
        costUsd: value.costUsd ?? null,
        updatedAt: value.updatedAt ?? row.updatedAt,
      });
    }
  }

  private async readTailSafe(file: string): Promise<string> {
    try {
      return await this.readTail(file);
    } catch (err) {
      // tail.readTail 은 던지지 않지만 주입된 가짜는 던질 수 있다. 값을 잃는 것보다 조용히 넘기는 게 낫다.
      console.warn(`[usage] 꼬리 읽기 실패(${file}):`, err);
      return '';
    }
  }

  /**
   * 한도 값 갱신. 주어지지 않은 칸은 이전 값을 유지한다.
   *
   * **칸마다 더 최근 측정이 이긴다**(T43-4): 확인용 세션(5분 주기)과 턴 종료 이벤트가 같은 값을 서로 다른
   * 시각에 읽어 오므로, 늦게 **도착한** 것이 아니라 늦게 **측정된** 것을 남긴다. `measuredAt` 은 화면을
   * 실제로 읽은 시각이고(기본은 지금), 그 칸의 직전 측정보다 오래됐으면 조용히 버린다.
   */
  private recordEngineLimits(engine: Engine, patch: LimitPatch, source: UsageSource, measuredAt: number = this.now()): void {
    const prev = this.engineUsage(engine);
    const stamps = this.stamps.get(engine) ?? emptyStamps();
    const next: EngineUsage = { ...prev };
    let accepted = false;

    if (patch.weekly != null && measuredAt >= stamps.weekly) {
      next.weekly = patch.weekly;
      stamps.weekly = measuredAt;
      accepted = true;
    }
    if (patch.session != null && measuredAt >= stamps.session) {
      next.session = patch.session;
      stamps.session = measuredAt;
      accepted = true;
    }
    if (patch.models != null && patch.models.length > 0 && measuredAt >= stamps.models) {
      next.models = patch.models;
      stamps.models = measuredAt;
      accepted = true;
    }
    // 요금제는 시각을 따지지 않는다 — 한도 숫자가 아니라 계정 속성이라 자주 바뀌지 않는다.
    if (patch.plan) next.plan = patch.plan;
    if (!accepted && !patch.plan) return;
    this.stamps.set(engine, stamps);

    // `updatedAt`/`source` 는 **가장 최근 측정**을 가리킨다. 옛 측정이 빈 칸을 채우기만 했으면 건드리지 않는다.
    if (accepted && measuredAt >= (prev.updatedAt ? Date.parse(prev.updatedAt) : Number.NEGATIVE_INFINITY)) {
      next.updatedAt = new Date(measuredAt).toISOString();
      next.source = source;
    }
    this.writeEngine(next, prev);
  }

  /** 변화가 있을 때만 저장·emit. 값이 같아도 refreshMs 가 지났으면 updatedAt 만 올려 한 번 민다. */
  private writeEngine(next: EngineUsage, prev: EngineUsage): void {
    const known = this.engines.has(next.engine);
    const same = known && sameExceptUpdatedAt(prev, next);
    if (same) {
      const movedForward = next.updatedAt !== null && next.updatedAt !== prev.updatedAt;
      if (!movedForward || ageMs(prev.updatedAt, this.now()) < this.refreshMs) return;
    }
    this.engines.set(next.engine, next);
    try {
      this.store.putEngineUsage(next.engine, next, next.updatedAt ?? new Date(this.now()).toISOString());
    } catch (err) {
      console.warn(`[usage] engine_usage 저장 실패(${next.engine}):`, err);
    }
    this.emit('engine', { ...next });
  }

  /** 멤버 사용량 갱신. 주어지지 않은(=undefined) 칸은 이전 값을 유지한다(null 은 "값 없음" 으로 덮어쓴다). */
  private recordMemberUsage(member: UsageMemberRef, patch: MemberPatch): void {
    const prev = this.members.get(member.id);
    const nowIso = new Date(this.now()).toISOString();
    const next: MemberUsage = {
      memberId: member.id,
      engine: member.engine,
      context: patch.context !== undefined && patch.context !== null ? patch.context : (prev?.context ?? null),
      tokens: patch.tokens !== undefined && patch.tokens !== null ? patch.tokens : (prev?.tokens ?? null),
      costUsd: patch.costUsd !== undefined && patch.costUsd !== null ? patch.costUsd : (prev?.costUsd ?? null),
      updatedAt: nowIso,
    };
    if (prev && sameExceptUpdatedAt(prev, next) && ageMs(prev.updatedAt, this.now()) < this.refreshMs) return;
    this.members.set(member.id, next);
    try {
      this.store.putMemberUsage(member.id, next, nowIso);
    } catch (err) {
      // 멤버 행이 방금 사라졌을 수 있다(FK). 메모리 값은 두고 다음 정리에서 빠진다.
      console.warn(`[usage] member_usage 저장 실패(${member.id}):`, err);
    }
    this.emit('member', { ...next });
  }
}
