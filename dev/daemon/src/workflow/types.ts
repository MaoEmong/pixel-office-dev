export type WorkflowPhase = 'clarifying' | 'meeting' | 'executing' | 'review' | 'completed' | 'blocked' | 'cancelled';
export interface WorkflowMessage { role: 'user' | 'head'; text: string; at: string; requestId?: string; followup?: boolean }
export interface MeetingContribution { memberId: string; round: number; text: string; at: string }
export interface WorkAssignment {
  leadId: string; task: string; acceptance: string[]; dependsOn?: string[];
  taskId?: number; status?: 'queued' | 'assigned' | 'done' | 'blocked' | 'aborted';
}
export interface Meeting {
  participantNames?: Record<string, string>;
  participantRoles?: Record<string, {rank: MemberRank; parentId: string | null}>;
  replacements?: Array<{previousMemberId: string; memberId: string; at: string}>;
  round: 1 | 2; state: 'collecting' | 'reviewing' | 'deciding';
  participants: string[]; contributions: MeetingContribution[]; minutes?: string;
}
import type {MemberRank} from '../store/types.js';
export interface MeetingReplacement { previousMemberId: string; memberId: string }
export interface Workflow {
  id: string; departmentId: string; phase: WorkflowPhase; brief: string;
  messages: WorkflowMessage[]; meeting?: Meeting; assignments: WorkAssignment[];
  rootTaskId?: number; result?: string; problem?: string; createdAt: string; updatedAt: string;
  startRequestId?: string;
}
