import { randomUUID } from 'node:crypto';
import type { Store } from '../store/Store.js';
import type { Member, Task } from '../store/types.js';
import type { Workflow, WorkAssignment } from './types.js';

export interface WorkflowHost {
  head(departmentId: string): Member;
  member(id: string): Member | undefined;
  busy(departmentId: string): boolean;
  send(memberId: string, text: string): void;
  startTask(memberId: string, text: string): number;
  delegate(headId: string, leadId: string, text: string): number;
  task(id: number): Task | undefined;
  interrupt(memberId: string): void;
  changed(workflow: Workflow): void;
}

const now = () => new Date().toISOString();
const live = (m: Member | undefined): m is Member => !!m && !['error','exited','suspended'].includes(m.status);
export const WORKFLOW_PLANNING_MESSAGE = '지금은 작업 구체화·회의·검수 단계입니다. 계획 확정 전에는 구현하지 말고 의견을 제시하세요.';

export class WorkflowCoordinator {
  constructor(private readonly store: Store, private readonly host: WorkflowHost) {}
  current(departmentId: string): Workflow | undefined { return this.store.currentWorkflow(departmentId); }
  private save(w: Workflow): Workflow {
    w.updatedAt = now(); this.store.saveWorkflow(w); this.host.changed(w); return w;
  }
  private text(text: string): string {
    if (typeof text !== 'string' || !text.trim() || text.length > 30_000) throw new Error('내용은 1~30000자여야 합니다.');
    return text.trim();
  }
  private active(departmentId: string, phase?: Workflow['phase']): Workflow {
    const w = this.current(departmentId);
    if (!w || (phase && w.phase !== phase)) throw new Error(`현재 ${phase ?? '작업'} 단계가 아닙니다.`);
    return w;
  }
  discuss(departmentId: string, text: string, notify = true): Workflow {
    const head = this.host.head(departmentId);
    const message = this.text(text);
    let w = this.current(departmentId);
    if (!w || ['completed','cancelled'].includes(w.phase)) {
      if (this.host.busy(departmentId)) throw new Error('진행 중인 작업을 마친 뒤 새 논의를 시작하세요.');
      w = {id:`w_${randomUUID()}`,departmentId,phase:'clarifying',brief:'',messages:[],assignments:[],createdAt:now(),updatedAt:now()};
    }
    if (w.phase !== 'clarifying') throw new Error('진행 중인 회의·작업을 마치거나 취소한 뒤 논의하세요.');
    if (w.messages.length >= 100) throw new Error('대화가 길어졌습니다. 작업안을 정리하고 시작하세요.');
    w.messages.push({role:'user',text:message,at:now()});
    w.brief = w.messages.filter(m=>m.role==='user').map(m=>m.text).join('\n').slice(-30_000);
    this.save(w);
    if (notify) this.host.send(head.id, `[WORKFLOW DISCUSS ${w.id}]\n사용자와 목표, 범위, 제약, 완료 기준을 구체화하는 대화다. 구현·위임·채용은 하지 마라. 부족한 정보는 사용자에게 질문하고 작업안을 요약해라.\n${message}`);
    return w;
  }
  headText(member: Member, text: string): void {
    const w = this.current(member.departmentId);
    if (member.rank==='head' && w?.phase==='clarifying' && w.messages.length<100) {
      w.messages.push({role:'head',text:text.slice(0,30_000),at:now()}); this.save(w);
    }
  }
  start(departmentId: string, brief?: string): Workflow {
    const w = this.active(departmentId,'clarifying');
    const head = this.host.head(departmentId);
    if (this.host.busy(departmentId)) throw new Error('열린 작업·질문·승인을 마친 뒤 시작하세요.');
    const outline=w.messages.filter(m=>m.role==='head').at(-1)?.text;
    w.brief = this.text(brief ?? [w.brief,outline ? `부장이 정리한 작업안:\n${outline}` : ''].filter(Boolean).join('\n'));
    w.phase='meeting'; this.save(w);
    w.rootTaskId = this.host.startTask(head.id, `[WORKFLOW START ${w.id}]\n${w.brief}\n먼저 필요한 팀장들을 create_team으로 구성하라. 전문가가 필요하면 팀장이 hire하게 협의하라. 살아 있는 팀장·전문가 ID로 meeting_open을 호출하고 결과를 기다려라. 회의 중 구현하거나 delegate하지 마라. 의견 두 차례가 끝나면 meeting_decide로 회의록, 담당 팀장, 업무, acceptance(완료 기준), dependsOn(선행 팀장 ID)을 확정하라. 도구 이름: mcp__team__meeting_open, mcp__team__meeting_speak, mcp__team__meeting_decide. 도구가 안 보이면 ToolSearch로 찾아라.`);
    return this.save(w);
  }
  open(head: Member, participants: string[]): Workflow {
    const w = this.active(head.departmentId,'meeting');
    if (head.rank!=='head' || this.host.head(head.departmentId).id!==head.id) throw new Error('부장만 회의를 소집할 수 있습니다.');
    if (w.meeting) throw new Error('이미 소집된 회의가 있습니다.');
    if (!Array.isArray(participants) || participants.length<1 || participants.length>12 || new Set(participants).size!==participants.length) throw new Error('참석자는 중복 없이 1~12명이어야 합니다.');
    for (const id of participants) {
      const m = this.host.member(id);
      if (!live(m) || m.departmentId!==head.departmentId || m.rank==='head') throw new Error('같은 부서의 살아 있는 팀장·팀원만 초대할 수 있습니다.');
    }
    if (!participants.some(id=>this.host.member(id)!.rank==='lead')) throw new Error('최소 한 명의 팀장이 참석해야 합니다.');
    w.meeting={round:1,state:'collecting',participants,contributions:[]}; this.save(w);
    this.requestMissing(w); return w;
  }
  private requestMissing(w: Workflow): void {
    const meeting=w.meeting!;
    const history=meeting.contributions.map(c=>`${this.host.member(c.memberId)?.name ?? c.memberId} (${c.round}차): ${c.text}`).join('\n');
    if (meeting.state==='deciding') {
      this.host.send(this.host.head(w.departmentId).id, `[MEETING DECIDE ${w.id}]\n작업안: ${w.brief}\n${history}\n두 차례 의견이 모두 모였다. 쟁점을 조정하고 meeting_decide로 minutes와 팀장별 assignments를 확정하라. 아직 실행·delegate하지 마라.`);
      return;
    }
    for (const id of meeting.participants) {
      if (meeting.contributions.some(c=>c.memberId===id && c.round===meeting.round)) continue;
      this.host.send(id, `[MEETING ${w.id} ROUND ${meeting.round}]\n작업안: ${w.brief}\n${meeting.round===2 ? `다른 참가자의 의견:\n${history}\n다른 의견과 충돌·의존성·위험을 검토하라.` : '접근 방법, 담당 범위, 위험, 완료 기준에 대한 의견을 제시하라.'}\n구현·delegate하지 마라. mcp__team__meeting_speak(workflowId="${w.id}",round=${meeting.round},text=의견)으로 한 번 제출하고 턴을 끝내라. 도구가 안 보이면 ToolSearch로 찾아라.`);
    }
  }
  speak(member: Member, workflowId: string, round: number, text: string): Workflow {
    const w=this.active(member.departmentId,'meeting');
    if (w.id!==workflowId || !w.meeting || w.meeting.state==='deciding' || w.meeting.round!==round || !w.meeting.participants.includes(member.id)) throw new Error('초대된 참석자의 현재 회의 차례만 제출할 수 있습니다.');
    if (!live(member)) throw new Error('퇴근한 참석자는 의견을 제출할 수 없습니다.');
    if (w.meeting.contributions.some(c=>c.memberId===member.id && c.round===round)) throw new Error('이미 이 차례의 의견을 제출했습니다.');
    w.meeting.contributions.push({memberId:member.id,round,text:this.text(text),at:now()});
    const complete=w.meeting.participants.every(id=>w.meeting!.contributions.some(c=>c.memberId===id && c.round===round));
    if (complete) {
      if (round===1) { w.meeting.round=2; w.meeting.state='reviewing'; }
      else w.meeting.state='deciding';
    }
    this.save(w); if (complete) this.requestMissing(w); return w;
  }
  decide(head: Member, workflowId: string, minutes: string, assignments: WorkAssignment[]): Workflow {
    const w=this.active(head.departmentId,'meeting');
    if (head.rank!=='head' || this.host.head(w.departmentId).id!==head.id || w.id!==workflowId || w.meeting?.state!=='deciding') throw new Error('두 차례 의견을 마친 뒤 부장이 계획을 확정해야 합니다.');
    if (!Array.isArray(assignments) || !assignments.length || assignments.length>12) throw new Error('팀장별 업무가 필요합니다.');
    const ids=new Set(assignments.map(a=>a.leadId));
    if (ids.size!==assignments.length) throw new Error('팀장별 업무를 중복 배정할 수 없습니다.');
    if (w.meeting.participants.some(id=>this.host.member(id)?.rank==='lead' && !ids.has(id))) throw new Error('참석한 각 팀장의 담당 업무를 정해주세요.');
    const clean=assignments.map(a=> {
      const lead=this.host.member(a.leadId);
      if (!live(lead) || lead.rank!=='lead' || lead.departmentId!==w.departmentId || lead.parentId!==head.id || !w.meeting!.participants.includes(lead.id)) throw new Error('회의에 참석한 직속 팀장에게만 업무를 배정하세요.');
      if (!Array.isArray(a.acceptance) || !a.acceptance.length || a.acceptance.length>20) throw new Error('각 업무에 완료 기준이 필요합니다.');
      const dependsOn=[...new Set(a.dependsOn ?? [])];
      if (dependsOn.some(id=>!ids.has(id) || id===a.leadId)) throw new Error('선행 업무의 팀장 ID가 잘못됐습니다.');
      return {leadId:a.leadId,task:this.text(a.task),acceptance:a.acceptance.map(s=>this.text(s)),dependsOn,status:'queued' as const};
    });
    // Validate the entire dependency graph before storing or issuing any task.
    const settled=new Set<string>();
    while (settled.size<clean.length) {
      const ready=clean.filter(a=>!settled.has(a.leadId) && a.dependsOn.every(id=>settled.has(id)));
      if (!ready.length) throw new Error('업무 의존성이 순환합니다.');
      ready.forEach(a=>settled.add(a.leadId));
    }
    w.meeting!.minutes=this.text(minutes); w.assignments=clean; w.phase='executing'; this.save(w);
    this.dispatch(w); return w;
  }
  private dispatch(w: Workflow): void {
    for (const a of w.assignments) {
      if (a.taskId || !(a.dependsOn ?? []).every(id=>w.assignments.find(other=>other.leadId===id)?.status==='done')) continue;
      const lead=this.host.member(a.leadId);
      if (!live(lead)) { w.phase='blocked'; w.problem='담당 팀장이 퇴근하거나 오류 상태입니다.'; this.save(w); return; }
      a.taskId=this.host.delegate(this.host.head(w.departmentId).id,a.leadId,`${a.task}\n완료 기준:\n${a.acceptance.join('\n')}\n회의 결정:\n${w.meeting!.minutes}`);
      a.status='assigned'; this.save(w);
    }
  }
  report(member: Member, taskId: number | undefined, status: string, summary: string): void {
    const w=this.current(member.departmentId);
    if (!w || w.phase!=='executing' || !taskId) return;
    const a=w.assignments.find(a=>a.taskId===taskId);
    if (a) {
      a.status=status==='done' ? 'done' : 'blocked';
      if (a.status==='blocked') { w.phase='blocked'; w.problem=summary || '담당 업무가 막혔습니다.'; }
      this.save(w); if (w.phase==='executing') this.dispatch(w);
    }
    if (taskId===w.rootTaskId) {
      const done=status==='done' && w.assignments.length>0 && w.assignments.every(a=>a.status==='done');
      w.phase=done ? 'review' : 'blocked'; w.result=summary;
      if (!done) w.problem='모든 담당 업무가 완료되지 않았습니다.';
      this.save(w);
    }
  }
  memberGone(member: Member): void {
    const w=this.current(member.departmentId);
    if (!w || !['meeting','executing'].includes(w.phase)) return;
    const required = w.phase==='meeting' ? w.meeting?.participants.includes(member.id)
      : w.assignments.some(a=>a.leadId===member.id && a.status!=='done');
    if (member.rank==='head' || required) {
      w.phase='blocked'; w.problem=`${member.name} 세션이 종료됐습니다. 재고용 후 회의를 재개하거나 취소하세요.`; this.save(w);
    }
  }
  resume(departmentId: string): Workflow {
    const w=this.active(departmentId);
    if (!w.meeting || !['meeting','blocked'].includes(w.phase)) throw new Error('재개할 회의가 없습니다.');
    if (w.assignments.length) throw new Error('실행 중 문제가 생겼습니다. 작업을 취소하고 보완 논의를 시작하세요.');
    this.host.head(departmentId);
    if (w.meeting.participants.some(id=>!live(this.host.member(id)))) throw new Error('퇴근·오류 참석자를 먼저 재고용하세요.');
    w.phase='meeting'; delete w.problem; this.save(w); this.requestMissing(w); return w;
  }
  cancel(departmentId: string): Workflow {
    const w=this.active(departmentId);
    if (['completed','cancelled'].includes(w.phase)) throw new Error('이미 종료된 작업입니다.');
    w.phase='cancelled'; this.save(w);
    for (const m of this.store.listMembers().filter(m=>m.departmentId===departmentId && live(m))) this.host.interrupt(m.id);
    return w;
  }
  complete(departmentId: string): Workflow { const w=this.active(departmentId,'review'); w.phase='completed'; return this.save(w); }
}
