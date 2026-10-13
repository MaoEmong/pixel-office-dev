import { strictReadOnlyVerdict } from '../adapters/autoApproval.js';
import { CODEX_SHELL_TOOLS, normalizeToolName } from '../adapters/codexMapping.js';
import type { Workflow } from './types.js';
import { WORKFLOW_PLANNING_MESSAGE } from './Coordinator.js';

export function workflowToolDenial(workflow: Workflow | undefined, tool: string, input: unknown): string | undefined {
  if (!workflow || ['executing','completed','cancelled'].includes(workflow.phase)) return;
  if (tool.startsWith('mcp__team__')) return; // MCP methods validate their own workflow stage.
  if (['Read','Glob','Grep','ToolSearch','AskUserQuestion','WebSearch','WebFetch'].includes(tool)) return;
  if (CODEX_SHELL_TOOLS.has(normalizeToolName(tool))) {
    const command = input && typeof input==='object' ? (input as {command?:unknown}).command : undefined;
    if (typeof command==='string' && strictReadOnlyVerdict(command).ok) return;
  }
  return WORKFLOW_PLANNING_MESSAGE;
}
