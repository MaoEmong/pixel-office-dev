// 공통 후처리 한 곳(T28, 01 §"interrupt / fire / error 공통 후처리").
//
// 중단·퇴근·비정상 종료·재시작·팀 삭제·데몬 복구는 **같은 일**을 조금씩 다르게 한다:
// 미종료 task 를 끊고 발행자에게 알리고, 열린 허가·질문을 만료시키고, 셸 락을 돌려주고, 팀장이면 자기가 낸 일을 거두고,
// 필요하면 MCP 연결을 끊는다. T25·T27 까지는 이 조각들이 interrupt/clockOut/restart/onPtyExit/recover/deleteTeam 에
// 흩어져 있었고 "퇴근은 락을 푸는데 팀 삭제는 안 푼다" 같은 구멍이 생겼다 — 그 표를 여기 하나로 모은다.
//
// `settleMember` 는 Store 와 콜백(SettleCtx)만 본다 — Office 를 import 하지 않는다(순환 방지 + 테스트 용이).
// 이유별로 무엇을 하는지는 SETTLE_MATRIX 표가 전부다.
import type { Member, OfficeEvent, Pending, Task } from '../store/types.js';
import type { NoticeLevel, ReportLine } from './types.js';
import { GONE_STATUSES, OPEN_TASKS, isTurnEndingQuestion, type DerivedStore } from './derived.js';

/** 후처리를 부르는 이유. 표(SETTLE_MATRIX)의 행 이름이다. */
export type SettleReason =
  | 'interrupt'
  | 'clockOut'
  | 'error'
  | 'restart'
  | 'teamDelete'
  | 'departmentDelete'
  | 'parentGone'
  | 'recover';

/** 이유 하나의 정책(= 표의 한 행). */
export interface SettlePolicy {
  /** 그 멤버에게 배정된 미종료 task 를 끊는가. `restart`·`recover` 는 같은 세션을 이어서 하므로 두 번째 칸이 'keep'. */
  ownTasks: 'abort' | 'keep';
  /**
   * 열린 pending 처리. 'all' = 전부 만료, 'keep-ask' = 턴 종료 질문(`ask_user`/`ask_parent`)만 남기고
   * 나머지(허가 + TUI AskUserQuestion)를 만료(D-19).
   */
  pending: 'all' | 'keep-ask';
  /**
   * 어댑터의 **열린 hook 보류**(PermissionRequest 등 응답을 아직 안 돌려준 요청)를 취소하는가.
   * 살아 있는 프로세스를 건드리는 경로는 전부 true — 보류를 안 끊으면 CLI 가 응답을 기다리며 멈춘다.
   * 데몬 재시작 복구(`recover`)만 false 다(이전 기동의 보류는 프로세스와 함께 이미 사라졌다).
   * T36/D-36: `pending` 과 갈라놓은 덕에 `restart` 가 "보류만 끊고 `ask_*` 질문은 남긴다" 를 할 수 있게 됐다.
   */
  cancelHolds: boolean;
  /**
   * 살아 있는 **하위 트리 전체**를 잎부터 정리하는가(01 §"직무 체계 rev 3": 상위가 퇴근하면 하위 트리 전체 정리).
   * 자식은 각자 `parentGone` 으로 후처리되고 세션이 끝난다. `interrupt`(턴만 끊음)·`restart`(자식은 되살아난 세션에
   * 그대로 보고한다)는 false.
   */
  subtree: boolean;
  /**
   * 내 task 를 끊을 때 발행자(상위)에게 `[REPORTS … aborted]` 를 보내는가. `parentGone` 은 false —
   * 그 상위가 바로 지금 사라지는 중이라 받을 사람이 없다(사용자 발행 task 의 `reporting` 이벤트는 그대로 남긴다).
   */
  reportToIssuer: boolean;
  /** 만료마다 `error{summary, pendingId}` 이벤트를 남기는가(D-15 모양). 'all' 경로는 어댑터가 담당하므로 false. */
  pendingEvent: boolean;
  /** 그가 발행(delegate)한 미종료 task 를 끊는가(직급 무관 — 부장·팀장 모두 부하에게 일을 낸다). */
  issuedTasks: 'abort' | 'keep';
  /** 그가 낸 task 를 맡고 있던 부하를 중단시키는가(01 §"상위 fire 시 하위 정리"). */
  interruptTargets: boolean;
  /** TeamTools MCP 연결을 끊는가. */
  disposeMcp: boolean;
  /** 내 task 를 끊을 때 발행자에게 가는 사유. */
  why: string;
  /** 팀장이 낸 task 를 끊을 때의 사유. */
  issuedWhy: string;
  /** 알림 문구에 쓰는 사람 말. */
  label: string;
}

/**
 * 후처리 표(01 §공통 후처리 + §"직무 체계 rev 3" 후처리 + T25·T27·T36 의 실제 동작).
 *
 * | 이유 | 내 task | 보류 | 열린 허가·질문 | 셸 락 | 발행 task | 그 task 의 대상 | 하위 트리 | MCP |
 * |---|---|---|---|---|---|---|---|---|
 * | interrupt        | aborted | 취소 | 전부 만료 | 해제 | **유지** | — | 그대로 | 유지 |
 * | clockOut         | aborted | 취소 | 전부 만료 | 해제 | aborted | interrupt | **잎부터 정리** | 끊음 |
 * | error            | aborted | 취소 | 전부 만료 | 해제 | aborted | interrupt | **잎부터 정리** | 끊음 |
 * | teamDelete       | aborted | 취소 | 전부 만료 | 해제 | aborted | interrupt | **잎부터 정리** | 끊음 |
 * | departmentDelete | aborted | 취소 | 전부 만료 | 해제 | aborted | interrupt | **잎부터 정리** | 끊음 |
 * | parentGone       | aborted(보고 없음) | 취소 | 전부 만료 | 해제 | aborted | — | (호출자가 이미 잎부터 내려왔다) | 끊음 |
 * | restart          | 유지 | 취소 | 허가·TUI 질문만 만료, **`ask_*` 질문 유지**(D-36) | 해제 | 유지 | — | 그대로 | 유지 |
 * | recover          | 유지 | — | 허가·TUI 질문만 만료(D-19) + error 이벤트 | 해제 | 유지 | — | 그대로 | 유지 |
 *
 * `interrupt` 만 상위의 발행 task 를 그대로 둔다 — Ctrl+C 는 **그 사람의 턴**을 끊는 것이지 아래에 내린 지시를 거두는 게 아니다.
 * 반대로 퇴근·종료·팀/부서 삭제는 상위가 사라지는 것이라 받을 사람이 없는 task 를 남기면 하위가 영원히 보고하게 된다.
 * `restart` 는 하위를 건드리지 않는다 — 같은 세션이 되살아나 그 보고를 그대로 받는다.
 */
export const SETTLE_MATRIX: Readonly<Record<SettleReason, SettlePolicy>> = {
  interrupt: {
    ownTasks: 'abort',
    pending: 'all',
    cancelHolds: true,
    subtree: false,
    reportToIssuer: true,
    pendingEvent: false,
    issuedTasks: 'keep',
    interruptTargets: false,
    disposeMcp: false,
    why: '중단(interrupt)',
    issuedWhy: '상위 중단',
    label: '중단',
  },
  clockOut: {
    ownTasks: 'abort',
    pending: 'all',
    cancelHolds: true,
    subtree: true,
    reportToIssuer: true,
    pendingEvent: false,
    issuedTasks: 'abort',
    interruptTargets: true,
    disposeMcp: true,
    why: '퇴근',
    issuedWhy: '상위 퇴근',
    label: '퇴근',
  },
  error: {
    ownTasks: 'abort',
    pending: 'all',
    cancelHolds: true,
    subtree: true,
    reportToIssuer: true,
    pendingEvent: false,
    issuedTasks: 'abort',
    interruptTargets: true,
    disposeMcp: true,
    why: '세션 종료',
    issuedWhy: '상위 종료',
    label: '세션 종료',
  },
  teamDelete: {
    ownTasks: 'abort',
    pending: 'all',
    cancelHolds: true,
    subtree: true,
    reportToIssuer: true,
    pendingEvent: false,
    issuedTasks: 'abort',
    interruptTargets: true,
    disposeMcp: true,
    why: '팀 삭제',
    issuedWhy: '팀 삭제',
    label: '팀 삭제',
  },
  departmentDelete: {
    ownTasks: 'abort',
    pending: 'all',
    cancelHolds: true,
    subtree: true,
    reportToIssuer: true,
    pendingEvent: false,
    issuedTasks: 'abort',
    interruptTargets: true,
    disposeMcp: true,
    why: '부서 삭제',
    issuedWhy: '부서 삭제',
    label: '부서 삭제',
  },
  parentGone: {
    ownTasks: 'abort',
    pending: 'all',
    cancelHolds: true,
    subtree: false, // 호출자(subtree 정리)가 이미 잎부터 내려오고 있다 — 다시 내려가면 같은 멤버를 두 번 훑는다.
    reportToIssuer: false, // 받을 상위가 바로 지금 사라지는 중이다.
    pendingEvent: false,
    issuedTasks: 'abort',
    interruptTargets: false, // 내 자식은 나보다 먼저 정리됐다(잎부터).
    disposeMcp: true,
    why: '상위 정리',
    issuedWhy: '상위 정리',
    label: '상위 정리',
  },
  restart: {
    ownTasks: 'keep',
    pending: 'keep-ask', // D-36: 턴 종료 질문(`ask_user`/`ask_parent`)은 프로세스가 죽어도 유효하다.
    cancelHolds: true,
    subtree: false,
    reportToIssuer: true,
    pendingEvent: false,
    issuedTasks: 'keep',
    interruptTargets: false,
    disposeMcp: false,
    why: '재시작',
    issuedWhy: '재시작',
    label: '재시작',
  },
  recover: {
    ownTasks: 'keep',
    pending: 'keep-ask',
    cancelHolds: false,
    subtree: false,
    reportToIssuer: true,
    pendingEvent: true,
    issuedTasks: 'keep',
    interruptTargets: false,
    disposeMcp: false,
    why: '데몬 재시작',
    issuedWhy: '데몬 재시작',
    label: '데몬 재시작',
  },
};

/** 후처리 결과 요약(알림·로그·테스트용). */
export interface SettleSummary {
  memberId: string;
  reason: SettleReason;
  /** 이 후처리로 `aborted` 가 된 task(내 것 + 팀장이면 발행한 것). */
  abortedTasks: Task[];
  /** 이 후처리로 `expired` 가 된 pending. */
  expiredPending: Pending[];
  /** 팀장 정리로 중단시킨 팀원 id. */
  interruptedMembers: string[];
  /** 하위 트리 정리로 함께 내보낸 부하 id(잎부터 순서대로, T36). */
  settledChildren: string[];
}

/** `settleMember` 가 쓰는 Store 의 부분. */
export interface SettleStore extends DerivedStore {
  getMember(memberId: string): Member | undefined;
  /** 그 멤버를 뿌리로 한 하위 트리(깊이 우선, 자기 자신 먼저). 뒤에서부터 훑으면 잎부터다. */
  subtreeOf(memberId: string): Member[];
  getTask(taskId: number): Task | undefined;
  updateTask(taskId: number, patch: { status?: Task['status']; reportStatus?: Task['reportStatus'] }): Task | undefined;
  abortTasksFor(memberId: string): Task[];
  getPending(pendingId: string): Pending | undefined;
  expirePending(pendingId: string): Pending | undefined;
}

/** Office 가 넘겨주는 부작용들. 후처리 자체는 이 콜백 밖으로 나가지 않는다. */
export interface SettleCtx {
  /** 어댑터: 열린 hook 보류를 취소하고 그 멤버의 pending 을 **전부** 만료시킨다(pending:'all' 에서만). */
  expireAllPending(memberId: string): void;
  /**
   * 어댑터: 열린 hook 보류(응답을 아직 안 돌려준 요청 + 셸 게이트)만 '{}' 로 끊는다. pending 행은 건드리지 않는다.
   * `restart` 처럼 "프로세스는 죽이지만 턴 종료 질문은 살려 둔다" 를 하려면 이 둘이 갈라져 있어야 한다(D-36).
   */
  cancelHolds(memberId: string): void;
  /**
   * 하위 트리 정리에서 부하 하나의 CLI 세션을 끝낸다(pty 종료 + status exited). 후처리 자체는 `settleMember` 가
   * 이미 `parentGone` 으로 마쳤다 — 여기서는 프로세스만 거둔다.
   */
  endSession(memberId: string): void;
  /** 셸 뮤텍스 해제(T27 — 락 + 대기 줄). */
  releaseShellLocks(memberId: string): void;
  /** TeamTools MCP 연결 끊기. */
  disposeMcp(memberId: string): void;
  /** 그 멤버의 pty 가 살아 있는가(중단을 보낼 수 있는가). */
  isAlive(memberId: string): boolean;
  /** 그 멤버를 중단(Ctrl+C). 다시 이 후처리(reason 'interrupt')를 태운다. */
  interrupt(memberId: string): void;
  appendEvent(member: Member, kind: OfficeEvent['kind'], detail: OfficeEvent['detail'], ref?: OfficeEvent['ref']): void;
  /** 발행자(팀장)에게 보고 덩어리 전달. */
  deliverReports(leaderId: string, lines: ReportLine[], allIn: boolean): void;
  /** 그 팀장의 보고 버퍼를 버린다(받을 사람이 없어졌다). */
  dropReportBuffer(leaderId: string): void;
  /** 입력 큐에 실려 있던 task 표시를 지운다(Office.inFlight). */
  forgetInFlight(taskId: number): void;
  /** raw status 는 그대로여도 파생이 바뀌었으면 `member.status` 를 한 번 더 내보낸다. */
  syncDerived(memberId: string): void;
  notice(level: NoticeLevel, message: string): void;
}

/** 사용자 지시 task 의 발행자 표식(store/types.ts USER_ACTOR 와 같은 값). */
const USER = 'user';

/**
 * 후처리 한 번. 어떤 이유로 불려도 순서는 같다:
 *   ⓪ (상위가 사라지는 이유면) 하위 트리를 **잎부터** 정리 → ① 셸 락 해제 → ② 발행 task 정리 + 대상 중단
 *   → ③ 내 task 정리 + 발행자에게 보고 → ④ 열린 pending 만료 → ⑤ MCP 정리
 *   → ⑥ 파생 상태 알림 + (할 일이 있었으면) daemon.notice
 *
 * 절대 throw 하지 않는다 — 퇴근·종료 경로에서 후처리가 터지면 멤버가 어중간하게 남는다.
 */
export function settleMember(
  store: SettleStore,
  ctx: SettleCtx,
  memberId: string,
  reason: SettleReason,
  opts: { expireQuestions?: boolean } = {},
): SettleSummary {
  const policy = SETTLE_MATRIX[reason];
  const summary: SettleSummary = { memberId, reason, abortedTasks: [], expiredPending: [], interruptedMembers: [], settledChildren: [] };
  const member = store.getMember(memberId);
  if (!member) return summary;

  // ⓪ 상위가 사라지면 하위 트리 전체가 따라 정리된다(01 §"직무 체계 rev 3" 후처리). **잎부터** 인 이유는 T28 과 같다 —
  //    위를 먼저 내보내면 그 후처리가 아래를 interrupt 하고, 아래 후처리가 다시 (아직 살아 있는) 위 큐에
  //    `[REPORTS … aborted]` 를 밀어 넣어 어차피 사라질 상위에 왕복만 는다.
  if (policy.subtree) {
    for (const child of leavesFirst(store.subtreeOf(memberId), memberId)) {
      if (GONE_STATUSES.has(child.status) && !ctx.isAlive(child.id)) continue; // 이미 나간 행 — 두 번 치우지 않는다
      const childSummary = settleMember(store, ctx, child.id, 'parentGone', opts);
      summary.abortedTasks.push(...childSummary.abortedTasks);
      summary.expiredPending.push(...childSummary.expiredPending);
      summary.settledChildren.push(child.id);
      try {
        ctx.endSession(child.id);
      } catch (err) {
        ctx.notice('warn', `${child.name} 세션 종료 실패(${policy.label}): ${errMsg(err)}`);
      }
    }
  }

  // ① 셸 락은 이유와 무관하게 먼저 돌려준다(01 §해제 표: interrupt·fire·error·퇴근·상한).
  ctx.releaseShellLocks(memberId);

  // ② 상위가 사라지거나 일을 거둘 때: 그가 발행한 미종료 task 를 끊고(받을 사람이 없다) 맡고 있던 부하를 중단시킨다.
  //    T34: 직급을 보지 않는다 — 부장도 팀장에게 일을 낸다. 하위 트리 전체를 따라 내려가는 정리는 T36.
  if (policy.issuedTasks === 'abort') {
    ctx.dropReportBuffer(memberId);
    for (const task of store.openTasksIssuedBy(memberId)) {
      store.updateTask(task.id, { status: 'aborted', reportStatus: 'aborted' });
      ctx.forgetInFlight(task.id);
      summary.abortedTasks.push(store.getTask(task.id) ?? task);
      const target = store.getMember(task.toMember);
      if (target) ctx.appendEvent(target, 'idle', { summary: `task#${task.id} aborted (${policy.issuedWhy})` }, { taskId: task.id });
      if (policy.interruptTargets && ctx.isAlive(task.toMember)) {
        try {
          ctx.interrupt(task.toMember);
          if (!summary.interruptedMembers.includes(task.toMember)) summary.interruptedMembers.push(task.toMember);
        } catch (err) {
          ctx.notice('warn', `${target?.name ?? task.toMember} 중단 실패(${policy.issuedWhy}): ${errMsg(err)}`);
        }
      }
      ctx.syncDerived(task.toMember);
    }
  }

  // ③ 내가 맡고 있던 미종료 task → aborted + 발행자에게 즉시 `[REPORTS … status=aborted]`(사용자면 reporting 이벤트).
  if (policy.ownTasks === 'abort') {
    for (const task of store.abortTasksFor(memberId)) {
      ctx.forgetInFlight(task.id);
      summary.abortedTasks.push(task);
      const body = `${member.name} 의 작업이 중단됐습니다 (${policy.why}).`;
      if (task.fromMember === USER) ctx.appendEvent(member, 'reporting', { summary: body, status: 'aborted' }, { taskId: task.id });
      // `parentGone` 은 발행자(상위)가 바로 지금 사라지는 중이라 보고를 버린다 — 나가는 큐에 밀어 넣어 봐야 왕복만 는다.
      // 대신 그 멤버 이력에 왜 끊겼는지는 남긴다(위가 살아 있을 때 발행자 정리가 남기는 것과 같은 모양).
      else if (policy.reportToIssuer) ctx.deliverReports(task.fromMember, [{ taskId: task.id, name: member.name, status: 'aborted', body }], false);
      else ctx.appendEvent(member, 'idle', { summary: `task#${task.id} aborted (${policy.why})` }, { taskId: task.id });
    }
  }

  // ④ 열린 허가·질문.
  summary.expiredPending.push(...expirePending(store, ctx, member, policy, opts.expireQuestions === true));

  // ⑤ MCP.
  if (policy.disposeMcp) ctx.disposeMcp(memberId);

  // ⑥ 파생 상태(배정 task 0 → free, 팀장의 발행 task 0 → waiting_reports 해제)는 raw status 가 안 바뀌어도 알려야 한다.
  ctx.syncDerived(memberId);
  const parts: string[] = [];
  if (summary.abortedTasks.length > 0) parts.push(`task ${summary.abortedTasks.length}건 중단`);
  if (summary.interruptedMembers.length > 0) parts.push(`팀원 ${summary.interruptedMembers.length}명 중단`);
  if (summary.settledChildren.length > 0) parts.push(`하위 ${summary.settledChildren.length}명 정리`);
  if (parts.length > 0) {
    if (summary.expiredPending.length > 0) parts.push(`허가·질문 ${summary.expiredPending.length}건 만료`);
    ctx.notice('info', `${member.name} 후처리(${policy.label}): ${parts.join(', ')}`);
  }
  return summary;
}

/**
 * 열린 pending 만료.
 *
 * - `'all'` 은 어댑터의 `expireAllForMember` 하나에 맡긴다(보류 취소 + 만료 + waiting_* → working 이 한 묶음).
 * - `'keep-ask'` 는 D-19: `tool_input` 이 있는 질문(TUI AskUserQuestion 메뉴)은 프로세스와 함께 사라지므로 만료하고,
 *   턴 종료 질문(TeamTools `ask_user`/`ask_parent`, Codex 폴백)은 살아남는다. 보류를 끊어야 하는 경로(`restart`)는
 *   그 전에 `cancelHolds` 로 hook 응답만 돌려준다(D-36) — 안 끊으면 CLI 가 응답을 기다리며 멈춘다.
 *
 * `expireQuestions` 는 그 예외까지 지운다(되살릴 세션이 아예 없는 멤버).
 */
function expirePending(store: SettleStore, ctx: SettleCtx, member: Member, policy: SettlePolicy, expireQuestions: boolean): Pending[] {
  const out: Pending[] = [];
  if (policy.pending === 'keep-ask' && policy.cancelHolds) ctx.cancelHolds(member.id);
  const open = store.listOpenPending(member.id);
  if (open.length === 0) return out;
  if (policy.pending === 'all') {
    ctx.expireAllPending(member.id);
    for (const p of open) {
      const final = store.getPending(p.id);
      if (final?.status === 'expired') out.push(final);
    }
    return out;
  }
  for (const p of open) {
    if (!expireQuestions && keepsQuestion(p)) continue;
    const final = store.expirePending(p.id);
    if (final?.status !== 'expired') continue;
    out.push(final);
    if (!policy.pendingEvent) continue;
    const summary = p.type === 'approval' ? '재지시 필요: 허가 요청이 재시작으로 만료됨' : '재지시 필요: 질문이 재시작으로 만료됨';
    const ref = p.type === 'approval' ? { approvalId: p.id } : { questionId: p.id };
    ctx.appendEvent(member, 'error', { summary, pendingId: p.id, pendingType: p.type }, ref);
  }
  return out;
}

/**
 * D-19: 프로세스가 죽어도 살아남는 질문 = 턴 종료 질문(TeamTools `ask_user`/`ask_parent`, Codex 폴백).
 * 판정은 `derived.ts` 의 `isTurnEndingQuestion` 하나(= `payload.tool_input` 이 없거나 `source` 가 `ask_*`).
 */
export const keepsQuestion = isTurnEndingQuestion;

/**
 * 하위 트리를 **깊은 쪽부터**(자기 자신은 빼고) 준다. `subtreeOf` 의 깊이 우선 배열을 그대로 뒤집으면 형제 순서까지
 * 뒤집히므로(이음·하루 → 하루·이음) 깊이만 뒤집고 같은 깊이 안에서는 원래 순서를 지킨다 — 로그·테스트가 읽기 쉽다.
 */
export function leavesFirst(subtree: readonly Member[], rootId: string): Member[] {
  const depth = new Map<string, number>([[rootId, 0]]);
  for (const m of subtree) {
    if (m.id === rootId) continue;
    depth.set(m.id, (m.parentId !== null ? (depth.get(m.parentId) ?? 0) : 0) + 1);
  }
  return subtree
    .filter((m) => m.id !== rootId)
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (depth.get(b.m.id) ?? 0) - (depth.get(a.m.id) ?? 0) || a.i - b.i)
    .map(({ m }) => m);
}

/** 미종료 task 집합을 후처리 쪽에서도 같은 이름으로 쓴다. */
export { OPEN_TASKS };

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
