export type WorkflowPhase = 'clarifying' | 'meeting' | 'executing' | 'review' | 'completed' | 'blocked' | 'cancelled';
export interface WorkflowMessage { role: 'user' | 'head'; text: string; at: string }
export interface MeetingContribution { memberId: string; round: number; text: string; at: string }
export interface WorkAssignment {
  leadId: string; task: string; acceptance: string[]; dependsOn?: string[];
  taskId?: number; status?: 'queued' | 'assigned' | 'done' | 'blocked' | 'aborted';
}
export interface Meeting {
  round: 1 | 2; state: 'collecting' | 'reviewing' | 'deciding';
  participants: string[]; contributions: MeetingContribution[]; minutes?: string;
}
export interface Workflow {
  id: string; departmentId: string; phase: WorkflowPhase; brief: string;
  messages: WorkflowMessage[]; meeting?: Meeting; assignments: WorkAssignment[];
  rootTaskId?: number; result?: string; problem?: string; createdAt: string; updatedAt: string;
}
