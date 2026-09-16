// CodexHooksAdapter — HookReceiver 'hook' 요청(Codex CLI 0.154.0)을 오피스 이벤트·멤버 status·pending 으로 정규화한다.
// 공개 API·이벤트는 ClaudeHooksAdapter 와 같다(BaseHooksAdapter). 실측: 02 §④, dev/spike-0/{pty-codex.js, hooklog-codex.json,
// run-codex5~7.log}. 설계: 01 §2 표의 Codex 열.
//
// Claude 와 다른 점(그 외는 전부 같다):
//   PreToolUse      tool_name="Bash", tool_input.command → 명령 문자열 휴리스틱으로 reading/editing/running (codexMapping.ts).
//                   이름표(Read/Edit/…)가 없으므로 도구 이름만으로는 못 가른다.
//   PermissionRequest 결정 JSON 은 Claude 와 완전히 같다(스파이크에서 allow/deny 둘 다 먹힘). tool_input 에 한국어
//                   `description`(승인 문구)이 따라와 detail.summary 로 싣는다. tool_use_id 는 없다.
//   질문           AskUserQuestion 도구가 없다 → isQuestionTool 은 항상 false. 질문은 TeamTools ask_user(T22 주입) 또는
//                  턴 종료 메시지 승격(Office 의 Codex 질문 폴백, T22)으로만 온다.
//   MCP 도구       Claude 의 `mcp__team__*` 이름 규칙이 아니라서 isTeamTool 을 넓게 잡는다(아래).
//   Interrupt      Codex 에만 있는 hook(Ctrl+C, timeout 3초 클램프). 보류 정리 후 idle{summary:'interrupted'}.
//                  (Claude 는 이 hook 이 없어 ScreenModel 로 판정한다 — Office.watchInterrupted)
//   SessionEnd     실측 reason 은 'other'. clear/resume 이 오면 Claude 처럼 비종료로 본다(공통 처리).
import type { HookRequest } from '../hooks/HookReceiver.js';
import { PASS_THROUGH } from '../hooks/decisions.js';
import type { Member } from '../store/types.js';
import { BaseHooksAdapter } from './BaseHooksAdapter.js';
import { mapCodexTool } from './codexMapping.js';
import type { ToolMapping } from './mapping.js';

export { DEFAULT_DENY_MESSAGE, MAX_TEXT_CHARS, MAX_THINKING_CHARS, TEAM_TOOL_PREFIX } from './BaseHooksAdapter.js';
export type { AdapterDeps, ApprovalDecisionInput, HoldLostReason, HooksAdapterEvents, ToolDoneInfo } from './types.js';

/** Codex 가 Ctrl+C 때 보내는 hook 이름. */
export const INTERRUPT_EVENT = 'Interrupt';
/**
 * TeamTools 가 노출하는 도구 이름(지금은 ask_user 하나). Codex 가 MCP 도구의 `tool_name` 을 어떤 모양으로 보내는지
 * 아직 모른다(모델 턴이 돌아야 확인 가능 — 사용량 한도 2026-09-21 13:58). 그래서 "team 이 들어가고 이 목록 중 하나가
 * 들어가면" 우리 도구로 보고 자동 allow 한다(D-22). TODO(2026-09-21 이후): 실제 tool_name 을 캡처해 이 휴리스틱을 좁힌다.
 */
export const TEAM_TOOL_NAMES: readonly string[] = ['ask_user', 'askuser'];
/** Interrupt 로 남기는 idle 이벤트의 summary. Office.watchInterrupted(화면 판정)와 같은 문구. */
export const INTERRUPT_SUMMARY = 'interrupted';

export class CodexHooksAdapter extends BaseHooksAdapter {
  protected get label(): string {
    return 'CodexHooksAdapter';
  }

  /** 명령 문자열 휴리스틱(codexMapping.ts). 항상 이벤트가 있다. */
  protected mapTool(toolName: string, toolInput: unknown): ToolMapping {
    return mapCodexTool(toolName, toolInput);
  }

  /**
   * D-22 를 Codex 이름 규칙에 맞춰 넓힌다. Claude 는 `mcp__team__ask_user` 로 고정이지만 Codex 가 MCP 도구를 어떤
   * `tool_name` 으로 보내는지는 미확인(`team.ask_user`? `team/ask_user`? `ask_user`?) — 서버 이름(`team`)과 도구 이름이
   * 둘 다 들어 있으면 우리 도구로 본다. 남의 MCP 서버 도구를 잘못 자동 허가하지 않도록 **둘 다** 요구한다.
   */
  protected override isTeamTool(toolName: string): boolean {
    if (super.isTeamTool(toolName)) return true;
    const name = toolName.toLowerCase();
    return name.includes('team') && TEAM_TOOL_NAMES.some((t) => name.includes(t));
  }

  /** waiting_approval 카드도 PreToolUse 와 같은 detail(cmd + description → summary)을 쓴다. */
  protected override approvalDetail(toolName: string, toolInput: unknown): ToolMapping['detail'] {
    return mapCodexTool(toolName, toolInput).detail;
  }

  /**
   * Codex 전용 Interrupt hook. 응답은 바로 '{}'(3초 클램프라 붙잡고 있으면 안 된다) → 보류 hook·pending 정리
   * (01 §공통 후처리: interrupt/fire/error) → idle{summary:'interrupted'} + status idle.
   */
  protected override onEngineEvent(req: HookRequest, member: Member): void {
    if (req.event !== INTERRUPT_EVENT) {
      req.respond(PASS_THROUGH);
      return;
    }
    req.respond(PASS_THROUGH);
    this.expireAllForMember(member.id);
    this.appendEvent(member, 'idle', { summary: INTERRUPT_SUMMARY });
    this.setStatus(member.id, 'idle');
  }
}
