// ShellMutex — 팀 단위 셸 뮤텍스(T27). 같은 팀의 멤버 둘이 동시에 빌드·테스트·쓰기 명령을 돌리지 않게 **팀당 락 하나**를 둔다.
// 설계: 01 §구성 요소 1 "팀 단위 셸 뮤텍스"(해제 표), §4 "동시 편집·빌드 충돌". 실측: 02 §② (실패는 PostToolUseFailure 로 온다,
// 읽기 명령은 허가 없이 실행되므로 락은 PreToolUse 기준).
//
// 이 파일은 순수 자료구조다 — Store·Office 를 모르고, 시간(now)과 타이머만 쓴다. 배선은 Office 가 한다:
//   PreToolUse(셸·읽기 아님) → AdapterDeps.toolGate → acquire()  … 락이 잡혀 있으면 hook 응답을 **보류**한다(캐릭터 "대기 중")
//   PostToolUse / PostToolUseFailure(toolDone)                  → release(teamId, memberId, toolUseId)
//   Stop / interrupt / 퇴근 / fire / 프로세스 종료               → releaseAllFor(memberId)  (안전망)
//   보유 상한(기본 30분) 초과                                    → 'warn' + 강제 해제
//
// 해제 표에 없는 두 가지를 여기서 정한다(D-27):
//   1. **읽기 전용 명령은 락을 잡지 않는다.** 설계는 "허가 여부와 무관하게 PreToolUse 에서 잡는다" 였지만, 그러면 `ls`·`cat`
//      까지 팀 전체가 직렬화된다(읽기는 허가도 안 받고 지나가는, 서로 안 부딪히는 명령이다). 판정은 두 엔진 모두
//      codexMapping 의 `isReadOnlyCommand` 하나로 한다 — 애매하면 "쓰기"로 보고 락을 잡는 보수적 함수다.
//   2. **보류가 사라진 대기자는 줄에서 뺀다.** hook 이 먼저 끊기면(hold-timeout/hold-closed, D-11 pass-through) 그 명령은
//      데몬 허락 없이 실행된다 — 줄에 남겨 두면 아무도 안 기다리는 락을 넘겨받고 그대로 굳는다. acquire 의 `signal` 로 뺀다.
//      반대로 **락을 이미 쥔 쪽은 signal 로 풀지 않는다** — hook 이 끊겨도 명령은 계속 돌고 있다(해제는 toolDone/후처리).
import { EventEmitter } from 'node:events';
import { SHELL_TOOLS } from '../adapters/mapping.js';
import { CODEX_SHELL_TOOLS, isReadOnlyCommand, normalizeToolName } from '../adapters/codexMapping.js';

/** 보유 상한 기본값(01 §해제 표 "보유 상한(예: 30분) 초과"). 넘으면 경고 + 강제 해제. */
export const DEFAULT_MAX_HOLD_MS = 30 * 60 * 1000;

/** 락 하나(또는 대기 줄의 한 자리)의 공개 정보. */
export interface ShellLockInfo {
  teamId: string;
  memberId: string;
  /** PreToolUse 의 `tool_use_id`. 해제 짝을 맞추는 키(없는 엔진·이벤트가 있어 null 허용). */
  toolUseId: string | null;
  /** 표시용 명령 문자열(빈 문자열일 수 있다). */
  cmd: string;
  /** 줄에 선 시각(epoch ms). 락을 쥐면 grantedAt 이 따로 붙는다. */
  since: number;
}

/** 락이 풀린 이유. */
export type ShellReleaseReason =
  /** PostToolUse / PostToolUseFailure — 정상 해제. */
  | 'done'
  /** interrupt / fire / 퇴근 / 프로세스 종료 후처리(releaseAllFor). */
  | 'member-gone'
  /** 보유 상한 초과 강제 해제. */
  | 'max-hold';

export interface ShellMutexEvents {
  /** 락이 잡혀 있어 줄을 섰다. 대기자당 한 번(Office 가 `running{waiting:'shell-lock'}` 을 남긴다). */
  waiting: [info: ShellLockInfo, holder: ShellLockInfo];
  /** 락을 쥐었다(즉시 획득 포함). waitedMs 는 줄에서 기다린 시간. */
  granted: [info: ShellLockInfo, waitedMs: number];
  /** 락이 풀렸다. */
  released: [info: ShellLockInfo, reason: ShellReleaseReason, heldMs: number];
  /** 보유 상한 초과 — 강제 해제 직전(Office 가 daemon.notice{warn}). */
  warn: [info: ShellLockInfo, message: string];
}

export interface ShellMutexOptions {
  /** 보유 상한(ms). 기본 30분. 0 이하면 상한 없음. */
  maxHoldMs?: number;
  /** 시각(epoch ms). 테스트에서 고정. 기본 Date.now. */
  now?(): number;
}

export interface AcquireOptions {
  /**
   * hook 보류가 사라지면 abort 되는 신호(어댑터가 준다). 대기 줄에서 빼고 프라미스를 **그냥 resolve** 한다 —
   * 이미 pass-through 로 응답이 나갔으므로 여기서 할 수 있는 일은 "줄을 정리하는 것" 뿐이다.
   */
  signal?: AbortSignal;
}

interface Entry extends ShellLockInfo {
  resolve: () => void;
  grantedAt?: number;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface TeamState {
  holder?: Entry;
  queue: Entry[];
  timer?: NodeJS.Timeout;
}

/**
 * 팀당 락 하나 + FIFO 대기 줄. `acquire` 는 **절대 reject 하지 않는다**(D-11: 게이트가 깨져도 hook 응답은 pass-through).
 * 같은 멤버가 락을 쥔 채 또 `acquire` 하면(도구가 겹쳐 오는 엔진) 그냥 줄을 선다 — 한 CLI 는 도구를 하나씩 부르므로
 * 정상 흐름에서는 생기지 않고, 생기더라도 상한 타이머가 풀어 준다.
 */
export class ShellMutex extends EventEmitter<ShellMutexEvents> {
  readonly maxHoldMs: number;
  private readonly now: () => number;
  private readonly teams = new Map<string, TeamState>();

  constructor(opts: ShellMutexOptions = {}) {
    super();
    this.maxHoldMs = opts.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * 락을 잡는다. 비어 있으면 **동기적으로** 잡고 이미 resolve 된 프라미스를 돌려준다(호출 순서 = 획득 순서).
   * 잡혀 있으면 줄 끝에 서고, 앞 명령이 끝날 때까지 프라미스가 열려 있다(= hook 응답 보류).
   */
  acquire(teamId: string, memberId: string, toolUseId: string | null, cmd: string, opts: AcquireOptions = {}): Promise<void> {
    // 보류가 이미 사라졌으면 줄을 세우지 않는다(그 명령은 pass-through 로 곧 실행된다).
    if (opts.signal?.aborted) return Promise.resolve();

    const state = this.stateOf(teamId);
    let resolve!: () => void;
    const promise = new Promise<void>((res) => (resolve = res));
    const entry: Entry = { teamId, memberId, toolUseId, cmd, since: this.now(), resolve };

    if (!state.holder) {
      this.grant(state, entry);
      return promise;
    }

    if (opts.signal) {
      entry.signal = opts.signal;
      entry.onAbort = () => this.drop(teamId, entry);
      opts.signal.addEventListener('abort', entry.onAbort, { once: true });
    }
    state.queue.push(entry);
    this.emit('waiting', info(entry), info(state.holder));
    return promise;
  }

  /**
   * 락을 푼다. `toolUseId` 를 주면 그 도구 호출이 쥔 락일 때만(엔진이 id 를 안 주면 멤버만 맞으면 된다) —
   * 늦게 도착한 다른 도구의 PostToolUse 가 남의 락을 풀지 않게 한다. 푼 게 있으면 true.
   */
  release(teamId: string, memberId: string, toolUseId?: string | null): boolean {
    const state = this.teams.get(teamId);
    const holder = state?.holder;
    if (!state || !holder || holder.memberId !== memberId) return false;
    if (toolUseId != null && holder.toolUseId != null && holder.toolUseId !== toolUseId) return false;
    this.finish(state, 'done');
    return true;
  }

  /**
   * 그 멤버의 락·대기 자리를 모두 정리한다(interrupt / fire / 퇴근 / 프로세스 종료 / Stop 안전망).
   * 대기 자리를 **먼저** 버린다 — 나가는 멤버가 방금 푼 락을 자기 대기 자리로 다시 받으면 안 된다. 정리한 수를 돌려준다.
   */
  releaseAllFor(memberId: string): number {
    let n = 0;
    for (const [teamId, state] of [...this.teams]) {
      for (const entry of [...state.queue]) {
        if (entry.memberId !== memberId) continue;
        this.drop(teamId, entry);
        n++;
      }
      if (state.holder?.memberId === memberId) {
        this.finish(state, 'member-gone');
        n++;
      }
    }
    return n;
  }

  /** 지금 그 팀의 락을 쥔 쪽(없으면 undefined). */
  holder(teamId: string): ShellLockInfo | undefined {
    const h = this.teams.get(teamId)?.holder;
    return h ? info(h) : undefined;
  }

  /** 그 팀에서 기다리는 수. */
  queueLength(teamId: string): number {
    return this.teams.get(teamId)?.queue.length ?? 0;
  }

  /** 그 팀의 대기 줄(앞에서부터). 진단·테스트용. */
  waiters(teamId: string): ShellLockInfo[] {
    return (this.teams.get(teamId)?.queue ?? []).map(info);
  }

  /** 락을 쥔 팀 수(진단용). */
  get size(): number {
    return [...this.teams.values()].filter((s) => s.holder !== undefined).length;
  }

  /** 전부 정리(데몬 종료·테스트). 대기자는 전부 resolve 된다. */
  clear(): void {
    for (const [teamId, state] of [...this.teams]) {
      for (const entry of [...state.queue]) this.drop(teamId, entry);
      if (state.holder) this.finish(state, 'member-gone');
      this.teams.delete(teamId);
    }
  }

  // ---- 내부 ----------------------------------------------------------------

  private stateOf(teamId: string): TeamState {
    let state = this.teams.get(teamId);
    if (!state) this.teams.set(teamId, (state = { queue: [] }));
    return state;
  }

  /** 락을 넘긴다(타이머 시작 → granted → 대기자 깨우기). */
  private grant(state: TeamState, entry: Entry): void {
    const now = this.now();
    entry.grantedAt = now;
    state.holder = entry;
    this.detachAbort(entry);
    if (this.maxHoldMs > 0) {
      const timer = setTimeout(() => this.onMaxHold(entry.teamId), this.maxHoldMs);
      timer.unref?.();
      state.timer = timer;
    }
    this.emit('granted', info(entry), now - entry.since);
    entry.resolve();
  }

  /** 락을 풀고 다음 대기자에게 넘긴다. */
  private finish(state: TeamState, reason: ShellReleaseReason): void {
    const holder = state.holder;
    if (!holder) return;
    state.holder = undefined;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    this.emit('released', info(holder), reason, this.now() - (holder.grantedAt ?? holder.since));
    const next = state.queue.shift();
    if (next) this.grant(state, next);
    else if (state.queue.length === 0) this.teams.delete(holder.teamId);
  }

  /** 대기 자리 하나를 버린다(보류가 사라짐 / 멤버 후처리). 프라미스는 resolve — 게이트는 절대 reject 하지 않는다. */
  private drop(teamId: string, entry: Entry): void {
    const state = this.teams.get(teamId);
    if (!state) return;
    const i = state.queue.indexOf(entry);
    if (i < 0) return;
    state.queue.splice(i, 1);
    this.detachAbort(entry);
    entry.resolve();
    if (!state.holder && state.queue.length === 0) this.teams.delete(teamId);
  }

  private detachAbort(entry: Entry): void {
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    entry.onAbort = undefined;
  }

  private onMaxHold(teamId: string): void {
    const state = this.teams.get(teamId);
    const holder = state?.holder;
    if (!state || !holder) return;
    const heldMs = this.now() - (holder.grantedAt ?? holder.since);
    this.emit('warn', info(holder), `셸 락을 ${Math.round(heldMs / 1000)}초째 쥐고 있어 강제로 해제함`);
    this.finish(state, 'max-hold');
  }
}

function info(e: Entry): ShellLockInfo {
  return { teamId: e.teamId, memberId: e.memberId, toolUseId: e.toolUseId, cmd: e.cmd, since: e.since };
}

/**
 * 셸 실행 도구인가. Claude 는 이름표(`Bash`/`PowerShell`), Codex 는 정규화한 이름(`bash`/`shell`/`exec` …) —
 * 두 목록을 모두 본다(codexMapping 의 목록이 Claude 것을 포함한다).
 */
export function isShellTool(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName) || CODEX_SHELL_TOOLS.has(normalizeToolName(toolName));
}

/**
 * 이 도구 호출이 팀 셸 락을 잡아야 하는가. 잡아야 하면 표시용 명령 문자열(없으면 ''), 아니면 null.
 *   - 셸 도구가 아니면 null (Read/Edit/MCP … 는 서로 안 부딪힌다)
 *   - 읽기 전용 명령이면 null (D-27 — `isReadOnlyCommand`, 애매하면 "쓰기"로 본다)
 */
export function shellLockCommand(toolName: string, toolInput: unknown): string | null {
  if (!isShellTool(toolName)) return null;
  const raw = toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput) ? (toolInput as Record<string, unknown>).command : undefined;
  const cmd = typeof raw === 'string' ? raw : '';
  if (cmd && isReadOnlyCommand(cmd)) return null;
  return cmd;
}
