// 어댑터 공개 타입. 설계: 01 §구성 요소 1(ClaudeHooks 어댑터, 대기 정책, interrupt/fire/error 후처리), §2 오피스 이벤트 스키마.
import type { Store } from '../store/Store.js';
import type { MemberStatus, OfficeEvent, Pending } from '../store/types.js';

/** 어댑터가 밖에서 받는 의존성. Store 외에는 전부 선택. */
export interface AdapterDeps {
  store: Store;
  /** 멤버 INSTRUCTIONS.md 본문. SessionStart 의 additionalContext 로 나간다. 빈 문자열/undefined 면 주입 안 함. */
  getInstructions(memberId: string): string | undefined;
  /**
   * PreToolUse 응답 전에 await 되는 게이트(T27 팀 셸 뮤텍스 연결점). 주면 PreToolUse 를 hold() 하고
   * 프라미스가 settle 된 뒤 `{}` 로 푼다. reject 돼도 deny 하지 않는다(D-11: pass-through).
   * hook 도착 순서대로 **동기** 호출되므로(첫 await 전까지) 게이트는 그 순서를 획득 순서로 쓸 수 있다.
   */
  toolGate?(memberId: string, tool: string, input: unknown, ctx: ToolGateContext): Promise<void>;
  /** 이벤트 ts 용 시각(epoch ms). 테스트에서 고정. 기본 Date.now. */
  now?(): number;
}

/** toolGate 가 받는 그 hook 호출의 맥락(T27). */
export interface ToolGateContext {
  /** PreToolUse 의 `tool_use_id`. 뮤텍스 해제(PostToolUse/PostToolUseFailure)와 짝을 맞추는 키. 없으면 null. */
  toolUseId: string | null;
  /**
   * 이 PreToolUse 의 보류가 사라지면 abort 된다 — hook 보류 타임아웃·연결 끊김(D-11 pass-through) 또는
   * interrupt/fire/퇴근 후처리(`expireAllForMember`). 게이트는 이때 대기 줄에서 자기 자리를 빼야 한다
   * (아무도 안 기다리는 락을 넘겨받으면 팀 전체가 굳는다).
   */
  signal: AbortSignal;
}

/** `approval.respond` 가 넘기는 결정. */
export interface ApprovalDecisionInput {
  behavior: 'allow' | 'deny';
  /** allow 시 도구 입력을 이걸로 바꿔 실행(객체가 아니면 무시). */
  updatedInput?: unknown;
  /** deny 시 모델에게 보여줄 사유. 생략 시 기본 문구. */
  message?: string;
}

/** PostToolUse / PostToolUseFailure 에서 내부용으로 내는 도구 완료 알림(뮤텍스 해제 등). 오피스 이벤트는 아니다. */
export interface ToolDoneInfo {
  tool: string;
  /** PostToolUse=true, PostToolUseFailure=false. */
  ok: boolean;
  toolUseId: string | null;
  /** PostToolUseFailure 의 error 문자열(있을 때만). */
  error?: string;
}

/** 보류가 어댑터 결정 없이 닫힌 이유(HookReceiver 'hold-timeout' / 'hold-closed'). */
export type HoldLostReason = 'timeout' | 'closed';

/** 어댑터가 내는 이벤트(엔진 공통 — Claude/Codex 어댑터가 같은 이름·같은 인자로 낸다). */
export interface HooksAdapterEvents {
  /** store.appendEvent 를 거친 오피스 이벤트(seq 포함). */
  event: [event: OfficeEvent];
  /** 멤버 status 가 바뀜(store 반영 후). 같은 값이면 안 낸다. */
  status: [memberId: string, status: MemberStatus];
  /** SessionStart 마다(startup/resume/clear/compact 전부) 최신 session_id. */
  sessionId: [memberId: string, sessionId: string, source: string];
  pendingCreated: [pending: Pending];
  /** answered 또는 expired 로 닫힘(최종 행). */
  pendingSettled: [pending: Pending];
  toolDone: [memberId: string, info: ToolDoneInfo];
  /** handleHook 안에서 throw — 삼키고 여기로 낸다(응답은 '{}'). */
  'handler-error': [err: unknown, memberId: string, event: string];
}

/** T04 이름(호환용 별칭). 새 코드는 HooksAdapterEvents 를 쓴다. */
export type ClaudeHooksAdapterEvents = HooksAdapterEvents;
