// ClaudeHooksAdapter — HookReceiver 'hook' 요청(Claude Code)을 오피스 이벤트·멤버 status·pending 으로 정규화한다.
// 공통 뼈대는 BaseHooksAdapter(T20) 에 있고 여기에는 **Claude 고유 차이**만 남는다.
// 설계: 01 §구성 요소 1(ClaudeHooks 어댑터, 대기 정책, interrupt/fire/error 후처리), §2 오피스 이벤트 스키마,
//       §실측 결과 반영. 실측: 02 §②③. 결정: D-04(허가·질문은 hook 결정 반환), D-05(additionalContext), D-11(타임아웃=pass-through).
//
// Claude 고유:
//   PreToolUse        도구 이름표 매핑(mapping.ts: Read/Glob/… = reading, Edit/Write/… = editing, 그 외 running)
//   AskUserQuestion   PreToolUse 에서는 이벤트 없음, PermissionRequest 에서 pending(question) + asking (D-04)
//   Interrupt hook 없음(Ctrl+C 중단은 ScreenModel 로 판정 — Office.watchInterrupted)
import { BaseHooksAdapter } from './BaseHooksAdapter.js';
import { ASK_USER_QUESTION, mapPreToolUse, type ToolMapping } from './mapping.js';

export { DEFAULT_DENY_MESSAGE, MAX_TEXT_CHARS, MAX_THINKING_CHARS, TEAM_TOOL_PREFIX } from './BaseHooksAdapter.js';
export type { AdapterDeps, ApprovalDecisionInput, ClaudeHooksAdapterEvents, HoldLostReason, HooksAdapterEvents, ToolDoneInfo } from './types.js';

export class ClaudeHooksAdapter extends BaseHooksAdapter {
  protected get label(): string {
    return 'ClaudeHooksAdapter';
  }

  /** mapping.ts 의 이름표 매핑. AskUserQuestion 은 null(PermissionRequest 에서 asking 으로 처리). */
  protected mapTool(toolName: string, toolInput: unknown): ToolMapping | null {
    return mapPreToolUse(toolName, toolInput);
  }

  /** Claude 의 TUI 질문 도구. Codex 에는 없다(질문은 TeamTools ask_user 로만 — T17/T22). */
  protected override isQuestionTool(toolName: string): boolean {
    return toolName === ASK_USER_QUESTION;
  }
}
