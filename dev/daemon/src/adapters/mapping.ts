// Claude Code 도구 이름 → 오피스 이벤트 kind/detail 순수 매핑. 설계: 01 §2 오피스 이벤트 스키마 표.
//   reading : Read Glob Grep WebFetch WebSearch LS     detail.path ← file_path|pattern|path|url|query
//   editing : Edit Write NotebookEdit MultiEdit         detail.path ← file_path|notebook_path
//   running : Bash PowerShell                            detail.cmd ← command, detail.summary ← description
//   running : mcp__* / 그 외 알 수 없는 도구             detail.tool 만(+ description 이 있으면 summary)
//   (없음)  : AskUserQuestion                            PermissionRequest 에서 asking 으로 처리
import type { EventDetail, OfficeEventKind } from '../store/types.js';

export const READING_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'LS']);
export const EDITING_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);
export const ASK_USER_QUESTION = 'AskUserQuestion';

/** detail 문자열 상한. cmd 는 길 수 있어 조금 넉넉히. */
export const MAX_CMD_CHARS = 1000;
export const MAX_SUMMARY_CHARS = 300;
export const MAX_PATH_CHARS = 500;

export interface ToolMapping {
  kind: OfficeEventKind;
  detail: EventDetail;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 읽기/편집 도구 입력에서 대표 경로 하나. */
export function pathFromInput(input: unknown): string | undefined {
  const r = asRecord(input);
  const p = str(r.file_path) ?? str(r.notebook_path) ?? str(r.pattern) ?? str(r.path) ?? str(r.url) ?? str(r.query);
  return p === undefined ? undefined : truncate(p, MAX_PATH_CHARS);
}

/** 셸 도구 입력에서 cmd/summary. */
export function shellFromInput(input: unknown): { cmd?: string; summary?: string } {
  const r = asRecord(input);
  const out: { cmd?: string; summary?: string } = {};
  const cmd = str(r.command);
  const desc = str(r.description);
  if (cmd !== undefined) out.cmd = truncate(cmd, MAX_CMD_CHARS);
  if (desc !== undefined) out.summary = truncate(desc, MAX_SUMMARY_CHARS);
  return out;
}

/**
 * 도구 호출 하나의 표시용 detail(tool 은 항상 포함). PreToolUse 이벤트와 PermissionRequest 의
 * waiting_approval 이벤트가 같은 detail 을 쓴다.
 */
export function toolDetail(toolName: string, toolInput: unknown): EventDetail {
  const detail: EventDetail = { tool: toolName };
  if (READING_TOOLS.has(toolName) || EDITING_TOOLS.has(toolName)) {
    const path = pathFromInput(toolInput);
    if (path !== undefined) detail.path = path;
    return detail;
  }
  if (SHELL_TOOLS.has(toolName)) {
    Object.assign(detail, shellFromInput(toolInput));
    return detail;
  }
  // mcp__* 와 그 외: description 이 있으면 summary 로만 살린다(Agent, Task 등).
  const desc = str(asRecord(toolInput).description);
  if (desc !== undefined) detail.summary = truncate(desc, MAX_SUMMARY_CHARS);
  return detail;
}

/**
 * PreToolUse 의 tool_name → 오피스 이벤트. AskUserQuestion 은 null(여기서는 이벤트 없음).
 * 이름을 모르는 도구는 전부 `running`.
 */
export function mapPreToolUse(toolName: string, toolInput: unknown): ToolMapping | null {
  if (toolName === ASK_USER_QUESTION) return null;
  const detail = toolDetail(toolName, toolInput);
  if (READING_TOOLS.has(toolName)) return { kind: 'reading', detail };
  if (EDITING_TOOLS.has(toolName)) return { kind: 'editing', detail };
  return { kind: 'running', detail };
}

/** AskUserQuestion 의 questions[] 에서 말풍선용 요약("Q1 / Q2"). */
export function questionSummary(toolInput: unknown): string | undefined {
  const qs = asRecord(toolInput).questions;
  if (!Array.isArray(qs)) return undefined;
  const texts = qs.map((q) => str(asRecord(q).question)).filter((s): s is string => s !== undefined);
  return texts.length ? truncate(texts.join(' / '), MAX_SUMMARY_CHARS) : undefined;
}
