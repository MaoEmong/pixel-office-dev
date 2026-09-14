// hook 이벤트·페이로드 타입. 02-실측-체크리스트 ②③④ 에서 실제로 관측된 이름/필드만 싣는다.

/** Claude Code + Codex CLI hooks 이벤트 이름 (실측: 02 §②④). */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure', // 도구 실패 시 PostToolUse 대신 온다 (Claude)
  'PermissionRequest',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionEnd',
  'Interrupt', // Codex 전용 (Ctrl+C), timeout 3초 클램프
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** 응답 JSON 으로 CLI 동작을 바꿀 수 있어 데몬이 응답을 보류(hold)할 수 있는 이벤트. */
export const DECISION_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'PermissionRequest',
  'PreToolUse',
  'SessionStart',
  'Stop',
  'UserPromptSubmit',
]);

export function isHookEvent(name: string): name is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(name);
}

export function isDecisionEvent(name: string): boolean {
  return DECISION_EVENTS.has(name as HookEvent);
}

/**
 * hook 페이로드(느슨한 타입). 두 CLI 공통 필드만 이름을 붙이고 나머지는 인덱스 시그니처로 받는다.
 * 실측 필드 출처:
 *  - 공통: session_id, transcript_path, cwd, hook_event_name, model, permission_mode
 *  - SessionStart: source(startup|resume|clear|compact), scratchpad_dir(Claude)
 *  - UserPromptSubmit: prompt, prompt_id(Claude) / turn_id(Codex)
 *  - PreToolUse/PermissionRequest: tool_name, tool_input, tool_use_id, permission_suggestions, description(Codex)
 *  - PostToolUse: tool_response, duration_ms
 *  - Stop: last_assistant_message, stop_hook_active
 *  - SessionEnd: reason
 *  - Notification: message
 */
export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  model?: string;
  permission_mode?: string;
  source?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  last_assistant_message?: string;
  reason?: string;
  turn_id?: string;
  prompt?: string;
  prompt_id?: string;
  [key: string]: unknown;
}
