// hook 응답(결정) JSON 빌더. 스파이크(02 §②③④)에서 실제로 먹힌 모양 그대로 만든다.
// - PermissionRequest: { hookSpecificOutput: { hookEventName:'PermissionRequest', decision:{ behavior, updatedInput?, message? } } }
// - AskUserQuestion : 위와 같되 updatedInput = { ...tool_input, answers: { [question]: label } }
// - SessionStart    : { hookSpecificOutput: { hookEventName:'SessionStart', additionalContext } }
// - pass-through(결정 없음) 는 빈 객체 {}.

export type PermissionBehavior = 'allow' | 'deny';

export interface PermissionDecision {
  behavior: PermissionBehavior;
  updatedInput?: Record<string, unknown>;
  message?: string;
}

export interface PermissionRequestOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: PermissionDecision;
  };
}

export interface SessionStartOutput {
  hookSpecificOutput: {
    hookEventName: 'SessionStart';
    additionalContext: string;
  };
}

/** 결정 없음(pass-through). CLI 는 평소처럼 동작한다. */
export const PASS_THROUGH: Readonly<Record<string, never>> = Object.freeze({});

/** 허가. `updatedInput` 을 주면 도구 입력을 그걸로 바꿔서 실행한다. */
export function allow(updatedInput?: Record<string, unknown>): PermissionRequestOutput {
  const decision: PermissionDecision = { behavior: 'allow' };
  if (updatedInput !== undefined) decision.updatedInput = updatedInput;
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

/** 거부. `reason` 은 CLI 가 모델에게 보여주는 메시지. */
export function deny(reason: string): PermissionRequestOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: reason },
    },
  };
}

/** SessionStart 에 멤버 지시문 주입. startup/resume/clear/compact 모두에서 다시 온다. */
export function sessionStartContext(text: string): SessionStartOutput {
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
}

/**
 * AskUserQuestion 답. PermissionRequest(tool_name=AskUserQuestion) 에 대해
 * 원래 tool_input 을 그대로 두고 `answers: { "<question>": "<label>" }` 만 얹어 allow 한다.
 * (실측: TUI 메뉴 없이 답이 전달됨 — 02 §③)
 */
export function askAnswers(
  toolInput: Record<string, unknown> | undefined,
  answers: Record<string, string>,
): PermissionRequestOutput {
  return allow({ ...(toolInput ?? {}), answers });
}
