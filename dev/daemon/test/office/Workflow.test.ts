import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../../src/store/Store.js';
import {WorkflowCoordinator, type WorkflowHost} from '../../src/workflow/Coordinator.js';
import {workflowToolDenial} from '../../src/workflow/guards.js';
import type {Member} from '../../src/store/types.js';
import type {Workflow} from '../../src/workflow/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Office} from '../../src/office/Office.js';
import {FakePty, FakeReceiver, fakeReq} from './fakes.js';
import {loadFixture} from '../screen/helpers.js';

function setup() {
  const store=new Store(':memory:');
  const d=store.createDepartment({name:'workflow',cwd:process.cwd()});
  const head=store.createMember({departmentId:d.id,teamId:null,parentId:null,name:'head',rank:'head',engine:'claude',cwd:d.cwd,hiredBy:'user',status:'idle'});
  store.updateDepartment(d.id,{headId:head.id});
  const leads=[1,2].map(n=> {
    const team=store.createTeam({departmentId:d.id,name:`team${n}`,cwd:d.cwd});
    return store.createMember({departmentId:d.id,teamId:team.id,parentId:head.id,name:`lead${n}`,rank:'lead',engine:'claude',cwd:d.cwd,hiredBy:'leader',status:'idle'});
  });
  const expert=store.createMember({departmentId:d.id,teamId:leads[0]!.teamId,parentId:leads[0]!.id,name:'expert',rank:'member',engine:'codex',cwd:d.cwd,hiredBy:'leader',status:'idle'});
  const sent:Array<{id:string;text:string}>=[];
  const host:WorkflowHost={
    head:()=>store.getMember(head.id)!,member:id=>store.getMember(id),busy:()=>false,
    send:(id,text)=>{sent.push({id,text});},
    startTask:(id,text)=>store.createTask({departmentId:d.id,fromMember:'user',toMember:id,instruction:text,status:'assigned'}).id,
    delegate:(id,to,text)=>store.createTask({departmentId:d.id,fromMember:id,toMember:to,instruction:text,status:'assigned'}).id,
    task:id=>store.getTask(id),interrupt:()=>{},changed:()=>{},
  };
  const coord=new WorkflowCoordinator(store,host);
  const begin=()=> { coord.discuss(d.id,'Write a file and verify it'); coord.start(d.id); return coord.open(head,[leads[0]!.id,leads[1]!.id,expert.id]); };
  const round=(w:Workflow,n:number)=> { for(const m of [...leads,expert])coord.speak(m,w.id,n,`${m.name} round ${n}`); };
  const plan=()=>[{leadId:leads[0]!.id,task:'write',acceptance:['file exists']},{leadId:leads[1]!.id,task:'verify',acceptance:['content matches'],dependsOn:[leads[0]!.id]}];
  return {store,d,head,leads,expert,sent,host,coord,begin,round,plan};
}

test('head starts autonomously, records two verified stages and completes without user transitions',t=>{
  const f=setup();t.after(()=>f.store.close());
  let w=f.coord.discuss(f.d.id,'Build and verify the whole product');
  assert.match(f.sent.at(-1)!.text,/workflow_start/);
  assert.throws(()=>f.coord.startByHead(f.leads[0]!,w.id),/부장/);
  w=f.coord.startByHead(f.head,w.id);
  const root=w.rootTaskId;
  assert.equal(f.coord.startByHead(f.head,w.id).rootTaskId,root);
  assert.equal(f.store.listTasks().length,1);
  const finish=(w:Workflow)=>{
    for(const leadId of w.assignments.map(a=>a.leadId)){
      const a=f.coord.current(f.d.id)!.assignments.find(a=>a.leadId===leadId)!;
      f.store.updateTask(a.taskId!,{status:'reported',reportStatus:'done',reportText:`verified ${a.task}`});
      f.coord.report(f.store.getMember(a.leadId)!,a.taskId,'done',`verified ${a.task}`);
    }
  };
  w=f.coord.open(f.head,[...f.leads.map(m=>m.id),f.expert.id]);f.round(w,1);f.round(w,2);
  w=f.coord.decide(f.head,w.id,'first meeting',f.plan());finish(w);
  assert.equal(f.sent.filter(s=>s.text.includes('[STAGE REVIEW')).length,1);
  const decision={workflowId:w.id,stage:1,summary:'Foundation complete',verification:['Unit tests passed'],complete:false,nextStage:{title:'Integration',brief:'Connect and test the remaining features'}};
  w=f.coord.stageComplete(f.head,decision);
  assert.equal(w.stage,2);assert.equal(w.phase,'meeting');assert.equal(w.rootTaskId,root);
  assert.equal(w.brief,'Build and verify the whole product');
  assert.equal(w.stages!.length,1);assert.equal(w.stages![0]!.meeting!.minutes,'first meeting');
  assert.equal(w.stages![0]!.assignments[0]!.report,'verified write');
  const sent=f.sent.length;
  f.coord.stageComplete(f.head,decision);
  assert.equal(f.sent.length,sent,'retry cannot repeat the next-stage delivery');
  assert.throws(()=>f.coord.stageComplete(f.head,{...decision,summary:'changed'}),/이미 기록/);
  const recovered=new WorkflowCoordinator(f.store,f.host);
  assert.equal(recovered.current(f.d.id)!.stages![0]!.summary,'Foundation complete');
  w=recovered.open(f.head,[...f.leads.map(m=>m.id),f.expert.id]);f.round(w,1);f.round(w,2);
  assert.match(f.sent.at(-1)!.text,/Connect and test the remaining features/);
  w=recovered.decide(f.head,w.id,'second meeting',f.plan());
  assert.throws(()=>recovered.stageComplete(f.head,{...decision,stage:2,complete:true,nextStage:undefined}),/모든 담당/);
  finish(w);
  w=recovered.stageComplete(f.head,{workflowId:w.id,stage:2,summary:'Whole product verified',verification:['Integration tests passed'],complete:true});
  assert.equal(w.phase,'completed');assert.equal(w.stages!.length,2);
  assert.equal(f.store.getTask(root!)!.status,'reported');
  assert.equal(f.store.getTask(root!)!.reportText,'Whole product verified');
  assert.equal(w.stages![0]!.summary,'Foundation complete','later work cannot overwrite an earlier checkpoint');
});

test('stage validation and failed next-stage delivery preserve the existing work',t=>{
  const f=setup();t.after(()=>f.store.close());let w=f.begin();f.round(w,1);f.round(w,2);
  w=f.coord.decide(f.head,w.id,'plan',f.plan());
  const input={workflowId:w.id,stage:1,summary:'summary',verification:['tests'],complete:false,nextStage:{title:'next',brief:'remaining goal'}};
  assert.throws(()=>f.coord.stageComplete(f.leads[0]!,input),/부장/);
  assert.throws(()=>f.coord.stageComplete(f.head,{...input,verification:[]}),/검증/);
  assert.throws(()=>f.coord.stageComplete(f.head,{...input,complete:true}),/하나/);
  assert.throws(()=>f.coord.stageComplete(f.head,input),/모든 담당/);
  for(const leadId of w.assignments.map(a=>a.leadId)){
    const a=f.coord.current(f.d.id)!.assignments.find(a=>a.leadId===leadId)!;
    f.coord.report(f.store.getMember(leadId)!,a.taskId,'done','verified');
  }
  const before=structuredClone(f.coord.current(f.d.id));
  f.host.send=()=>{throw new Error('delivery failed');};
  assert.throws(()=>f.coord.stageComplete(f.head,input),/delivery failed/);
  assert.deepEqual(f.coord.current(f.d.id),before);
  f.store.updateMember(f.head.id,{status:'idle'});
  w=f.coord.current(f.d.id)!;w.phase='blocked';f.store.saveWorkflow(w);
  assert.throws(()=>f.coord.stageComplete(f.head,input),/현재 실행/);
});

test('an older reviewed workflow can continue automatically with a new root and preserved history',t=>{
  const f=setup();t.after(()=>f.store.close());let w=f.begin();f.round(w,1);f.round(w,2);
  w=f.coord.decide(f.head,w.id,'legacy plan',f.plan());
  for(const leadId of w.assignments.map(a=>a.leadId)){
    const a=f.coord.current(f.d.id)!.assignments.find(a=>a.leadId===leadId)!;
    f.coord.report(f.store.getMember(leadId)!,a.taskId,'done','verified');
  }
  const oldRoot=w.rootTaskId!;f.store.updateTask(oldRoot,{status:'reported',reportStatus:'done'});
  f.coord.report(f.head,oldRoot,'done','first phase done');
  w=f.coord.current(f.d.id)!;delete w.stage;delete w.stages;f.store.saveWorkflow(w);
  w=f.coord.stageComplete(f.head,{workflowId:w.id,stage:1,summary:'legacy phase done',verification:['verified'],complete:false,nextStage:{title:'remaining work',brief:'finish original goal'}});
  assert.equal(w.phase,'meeting');assert.equal(w.stage,2);assert.notEqual(w.rootTaskId,oldRoot);
  assert.equal(f.store.getTask(oldRoot)!.status,'reported');assert.equal(w.stages!.length,1);
});

test('a restored head resumes pending verification instead of waiting for a user review button',t=>{
  const f=setup();t.after(()=>f.store.close());let w=f.begin();f.round(w,1);f.round(w,2);
  w=f.coord.decide(f.head,w.id,'plan',f.plan());
  for(const leadId of w.assignments.map(a=>a.leadId)){
    const a=f.coord.current(f.d.id)!.assignments.find(a=>a.leadId===leadId)!;
    f.coord.report(f.store.getMember(leadId)!,a.taskId,'done','verified');
  }
  assert.equal(f.coord.current(f.d.id)!.stageReviewRequested,1);
  f.sent.length=0;
  const restored=new WorkflowCoordinator(f.store,f.host);
  restored.resumeStageReview(f.head);
  assert.match(f.sent[0]!.text,/STAGE REVIEW/);
  assert.match(f.sent[0]!.text,/stage_complete/);
});

test('deleted meeting participants reconnect to current leads, preserving opinions and recording replacements',t=>{
  const f=setup();t.after(()=>f.store.close());f.coord.discuss(f.d.id,'work');f.coord.start(f.d.id);const w=f.coord.open(f.head,f.leads.map(m=>m.id));
  f.coord.speak(f.leads[0]!,w.id,1,'keep this opinion');
  f.store.updateMember(f.leads[0]!.id,{status:'exited'});
  f.coord.memberGone(f.store.getMember(f.leads[0]!.id)!);
  const old=f.leads[0]!;f.store.deleteMember(old.id);
  const replacement=f.store.createMember({departmentId:f.d.id,teamId:old.teamId,parentId:f.head.id,name:old.name,rank:'lead',engine:'codex',cwd:f.d.cwd,hiredBy:'leader',status:'idle'});
  f.sent.length=0;const resumed=f.coord.resume(f.d.id);
  assert.equal(resumed.phase,'meeting');assert.equal(resumed.meeting!.participants[0],replacement.id);
  assert.equal(resumed.meeting!.contributions[0]!.text,'keep this opinion');
  assert.equal(resumed.meeting!.contributions[0]!.memberId,replacement.id);
  assert.equal(resumed.meeting!.replacements![0]!.previousMemberId,old.id);
  assert.ok(!f.sent.some(s=>s.id===replacement.id),'already submitted opinion is not requested twice');
  assert.equal(resumed.id,w.id);assert.equal(resumed.rootTaskId,w.rootTaskId);assert.equal(resumed.problem,undefined);
});

test('legacy meeting with only saved names reconnects all three current leaders',t=>{
  const f=setup();t.after(()=>f.store.close());const w=f.begin();
  w.phase='blocked';delete w.meeting!.participantRoles;
  const ids=w.meeting!.participants;
  // The legacy fixture used an expert: convert its current seat to a head-owned lead.
  for(const id of ids){const old=f.store.getMember(id)!;f.store.deleteMember(id);f.store.createMember({departmentId:f.d.id,teamId:old.teamId,parentId:f.head.id,name:old.name,rank:'lead',engine:'codex',cwd:f.d.cwd,hiredBy:'leader',status:'idle'});}
  f.store.saveWorkflow(w);const resumed=f.coord.resume(f.d.id);
  assert.equal(resumed.phase,'meeting');assert.equal(resumed.meeting!.replacements!.length,3);
  assert.ok(resumed.meeting!.participants.every(id=>!ids.includes(id)));
});

test('ambiguous or invalid replacement plans cannot change the meeting or redirect a live attendee',t=>{
  const f=setup();t.after(()=>f.store.close());f.coord.discuss(f.d.id,'work');f.coord.start(f.d.id);const w=f.coord.open(f.head,f.leads.map(m=>m.id));const old=f.leads[0]!;
  f.store.deleteMember(old.id);w.phase='blocked';f.store.saveWorkflow(w);
  const create=()=>f.store.createMember({departmentId:f.d.id,teamId:old.teamId,parentId:f.head.id,name:old.name,rank:'lead',engine:'claude',cwd:f.d.cwd,hiredBy:'leader',status:'idle'});
  const a=create();create();const before=structuredClone(f.coord.current(f.d.id));
  assert.throws(()=>f.coord.resume(f.d.id),/한 명/);assert.deepEqual(f.coord.current(f.d.id),before);
  assert.throws(()=>f.coord.resume(f.d.id,[{previousMemberId:old.id,memberId:'missing'}]),/참석자가 없습니다/);
  assert.throws(()=>f.coord.resume(f.d.id,[{previousMemberId:old.id,memberId:a.id},{previousMemberId:f.leads[1]!.id,memberId:a.id}]),/활동 중/);
  assert.throws(()=>f.coord.resume(f.d.id,[], 'stale-workflow'),/다른 회의/);
  assert.equal(f.coord.resume(f.d.id,[{previousMemberId:old.id,memberId:a.id}]).phase,'meeting');
});

test('failed discussion delivery rolls back, and a successful request ID is never sent twice',t=> {
  const f=setup();t.after(()=>f.store.close());
  const send=f.host.send;let changes=0;
  f.host.changed=()=>{changes++;};
  f.host.send=()=>{throw new Error('injected send failure');};
  assert.throws(()=>f.coord.discuss(f.d.id,'request',true,'retry-1'),/injected/);
  assert.equal(f.coord.current(f.d.id),undefined);assert.equal(changes,0);
  f.host.send=send;
  f.coord.discuss(f.d.id,'request',true,'retry-1');
  f.coord.discuss(f.d.id,'request',true,'retry-1');
  assert.equal(f.sent.length,1);assert.equal(f.coord.current(f.d.id)?.messages.length,1);
  assert.throws(()=>f.coord.discuss(f.d.id,'different',true,'retry-1'),/다른 내용/);
});

for (const phase of ['meeting','executing','blocked','review'] as const) test(`user can talk to the head during ${phase} without replacing the plan`,t=> {
  const f=setup();t.after(()=>f.store.close());const w=f.begin();
  w.phase=phase;if(phase==='blocked')w.problem='CLI failed';f.store.saveWorkflow(w);
  const before=structuredClone(w);f.sent.length=0;
  const updated=f.coord.discuss(f.d.id,'현재 상황을 설명하고 다음 지시를 확인해 줘',true,'followup-1');
  assert.equal(updated.id,before.id);assert.equal(updated.phase,phase);assert.equal(updated.brief,before.brief);
  assert.deepEqual(updated.meeting,before.meeting);assert.deepEqual(updated.assignments,before.assignments);
  assert.equal(updated.problem,before.problem);assert.equal(updated.rootTaskId,before.rootTaskId);
  assert.match(f.sent[0]!.text,/WORKFLOW FOLLOWUP/);
  f.coord.discuss(f.d.id,'현재 상황을 설명하고 다음 지시를 확인해 줘',true,'followup-1');
  assert.equal(f.sent.length,1);
  f.coord.headText(f.head,'현재 상황에 대한 답변',true);
  assert.equal(f.coord.current(f.d.id)!.messages.at(-1)!.text,'현재 상황에 대한 답변');
  assert.equal(f.coord.current(f.d.id)!.phase,phase);
});

test('partial task creation rolls back meeting and task; retry succeeds exactly once',t=> {
  const f=setup();t.after(()=>f.store.close());f.coord.discuss(f.d.id,'request');
  const start=f.host.startTask;
  f.host.startTask=(id,text)=>{start(id,text);throw new Error('injected start failure');};
  assert.throws(()=>f.coord.start(f.d.id,undefined,'start-1'),/injected/);
  assert.equal(f.coord.current(f.d.id)?.phase,'clarifying');assert.equal(f.store.listTasks().length,0);
  f.host.startTask=start;
  const first=f.coord.start(f.d.id,undefined,'start-1');
  const retry=f.coord.start(f.d.id,undefined,'start-1');
  assert.equal(first.rootTaskId,retry.rootTaskId);assert.equal(f.store.listTasks().length,1);
});

test('workflow save failure after task creation rolls back both records',t=> {
  const f=setup();t.after(()=>f.store.close());f.coord.discuss(f.d.id,'request');
  const save=f.store.saveWorkflow.bind(f.store);let count=0;
  f.store.saveWorkflow=w=>{if(++count===2)throw new Error('injected disk failure');save(w);};
  assert.throws(()=>f.coord.start(f.d.id),/injected disk/);
  assert.equal(f.store.listTasks().length,0);assert.equal(f.coord.current(f.d.id)?.phase,'clarifying');
});

test('meeting delivery failure rolls back open and the last opinion; retries remain possible',t=>{
  const f=setup();t.after(()=>f.store.close());f.coord.discuss(f.d.id,'audit');f.coord.start(f.d.id);
  const send=f.host.send;f.host.send=()=>{throw new Error('delivery failed');};
  assert.throws(()=>f.coord.open(f.head,[f.leads[0]!.id]),/delivery failed/);assert.equal(f.coord.current(f.d.id)?.meeting,undefined);
  f.host.send=send;const w=f.coord.open(f.head,[f.leads[0]!.id]);
  f.host.send=()=>{throw new Error('round delivery failed');};
  assert.throws(()=>f.coord.speak(f.leads[0]!,w.id,1,'opinion'),/round delivery failed/);
  assert.equal(f.coord.current(f.d.id)?.meeting?.round,1);assert.equal(f.coord.current(f.d.id)?.meeting?.contributions.length,0);
  f.host.send=send;assert.equal(f.coord.speak(f.leads[0]!,w.id,1,'opinion').meeting?.round,2);
});

test('dispatch failure blocks the plan and retry assigns once; failed save leaves no orphan task',t=>{
  const f=setup();t.after(()=>f.store.close());const w=f.begin();f.round(w,1);f.round(w,2);
  const delegate=f.host.delegate;f.host.delegate=()=>{throw new Error('CLI unavailable');};
  const blocked=f.coord.decide(f.head,w.id,'minutes',f.plan());assert.equal(blocked.phase,'blocked');assert.match(blocked.problem!,/CLI unavailable/);
  assert.equal(f.store.listTasks().length,1);
  f.host.delegate=delegate;const save=f.store.saveWorkflow.bind(f.store);let writes=0;
  f.store.saveWorkflow=w=>{if(++writes===2)throw new Error('disk write failed');save(w);};
  assert.equal(f.coord.resume(f.d.id).phase,'blocked');assert.equal(f.store.listTasks().length,1);assert.equal(f.coord.current(f.d.id)?.assignments[0]?.taskId,undefined);
  f.store.saveWorkflow=save;const resumed=f.coord.resume(f.d.id);assert.equal(resumed.phase,'executing');assert.ok(resumed.assignments[0]?.taskId);
  f.coord.resume(f.d.id);assert.equal(f.store.listTasks().length,2);
});

test('two-round meeting, expert participation, dependent work, final report and user review',t=> {
  const f=setup(); t.after(()=>f.store.close());
  const w=f.begin();
  assert.equal(w.meeting!.participantNames![f.leads[0]!.id],'lead1','meeting names survive dismissal');
  assert.equal(f.store.listTasks().length,1,'meeting opinions are not implementation tasks');
  assert.throws(()=>f.coord.decide(f.head,w.id,'early',f.plan()),/두 차례/);
  f.round(w,1);
  assert.equal(f.coord.current(f.d.id)!.meeting!.round,2);
  assert.ok(f.sent.some(m=>m.text.includes('다른 참가자의 의견') && m.text.includes('expert round 1')));
  f.round(w,2);
  const executing=f.coord.decide(f.head,w.id,'write then verify',f.plan());
  assert.equal(executing.assignments[0]!.status,'assigned');
  assert.equal(executing.assignments[1]!.taskId,undefined,'dependent work waits');
  const done=(member:Member,id:number)=>{f.store.updateTask(id,{status:'reported',reportStatus:'done'});f.coord.report(member,id,'done','finished');};
  done(f.leads[0]!,executing.assignments[0]!.taskId!);
  const next=f.coord.current(f.d.id)!;
  assert.ok(next.assignments[1]!.taskId);
  done(f.leads[1]!,next.assignments[1]!.taskId!);
  done(f.head,next.rootTaskId!);
  assert.equal(f.coord.current(f.d.id)!.phase,'review');
  assert.equal(f.coord.complete(f.d.id).phase,'completed');
});

test('membership, duplicate rounds, plan validation and dependency cycles cannot dispatch work',t=> {
  const f=setup();t.after(()=>f.store.close()); const w=f.begin();
  assert.throws(()=>f.coord.speak(f.head,w.id,1,'chair'),/초대/);
  assert.throws(()=>f.coord.speak(f.expert,'other',1,'wrong'),/초대/);
  f.coord.speak(f.leads[0]!,w.id,1,'first');
  assert.throws(()=>f.coord.speak(f.leads[0]!,w.id,1,'again'),/이미/);
  f.coord.speak(f.leads[1]!,w.id,1,'second');f.coord.speak(f.expert,w.id,1,'expert');f.round(w,2);
  const before=f.store.listTasks().length;
  assert.throws(()=>f.coord.decide(f.head,w.id,'missing',[]),/업무/);
  assert.throws(()=>f.coord.decide(f.head,w.id,'missing lead',f.plan().slice(0,1)),/각 팀장/);
  assert.throws(()=>f.coord.decide(f.head,w.id,'cycle',[{...f.plan()[0]!,dependsOn:[f.leads[1]!.id]},f.plan()[1]!]),/순환/);
  assert.throws(()=>f.coord.decide(f.head,w.id,'wrong',[{...f.plan()[0]!,leadId:f.expert.id},f.plan()[1]!]),/팀장/);
  assert.equal(f.store.listTasks().length,before);
  assert.equal(f.coord.current(f.d.id)!.phase,'meeting');
});

test('meeting recovery requests only missing opinions and can cancel without a live chair',t=> {
  const f=setup();t.after(()=>f.store.close()); const w=f.begin();f.coord.speak(f.leads[0]!,w.id,1,'first');
  f.sent.length=0;
  const recovered=new WorkflowCoordinator(f.store,f.host);
  recovered.resume(f.d.id);
  assert.deepEqual(f.sent.map(m=>m.id).sort(),[f.leads[1]!.id,f.expert.id].sort());
  f.store.updateMember(f.head.id,{status:'error'});
  recovered.memberGone(f.store.getMember(f.head.id)!);
  assert.equal(recovered.current(f.d.id)!.phase,'blocked');
  assert.equal(recovered.cancel(f.d.id).phase,'cancelled');
});

test('planning hooks allow reading and meeting tools, never writes or disguised shell execution',t=> {
  const f=setup();t.after(()=>f.store.close());const w=f.coord.discuss(f.d.id,'Plan only');
  assert.equal(workflowToolDenial(w,'Read',{file_path:'source.ts'}),undefined);
  assert.equal(workflowToolDenial(w,'Bash',{command:'git status'}),undefined);
  assert.ok(workflowToolDenial(w,'Write',{file_path:'source.ts'}));
  assert.ok(workflowToolDenial(w,'Bash',{command:'touch source.ts'}));
  assert.ok(workflowToolDenial(w,'Bash',{command:'c\\at source.ts'}));
  assert.equal(workflowToolDenial(w,'mcp__team__meeting_speak',{}),undefined);
  assert.equal(workflowToolDenial({...w,phase:'executing'},'Write',{}),undefined);
});

test('one blocked team does not revoke the approved work of another team',t=> {
  const f=setup();t.after(()=>f.store.close());let w=f.begin();f.round(w,1);f.round(w,2);
  w=f.coord.decide(f.head,w.id,'approved plan',f.plan().map(a=>({...a,dependsOn:[]})));
  f.coord.report(f.leads[1]!,w.assignments[1]!.taskId,'blocked','Windows sandbox setup failed');
  w=f.coord.current(f.d.id)!;
  assert.equal(w.phase,'blocked');
  assert.equal(f.coord.canContinueAssignedWork(f.leads[0]!),true);
  assert.equal(f.coord.canContinueAssignedWork(f.expert),true);
  assert.equal(f.coord.canContinueAssignedWork(f.leads[1]!),false,'the blocked team cannot silently resume');
  assert.equal(f.coord.canContinueAssignedWork(f.head),false,'a blocked workflow is not permission for new work');
  assert.equal(w.assignments[0]!.status,'assigned');
  assert.equal(w.assignments[1]!.status,'blocked');
  f.store.saveWorkflow({...w,phase:'meeting'});
  assert.equal(f.coord.canContinueAssignedWork(f.leads[0]!),false);
  f.store.saveWorkflow({...w,assignments:[]});
  assert.equal(f.coord.canContinueAssignedWork(f.leads[0]!),false);
});

test('reported failures resume the same plan without duplicating running or completed work',t=> {
  const f=setup();t.after(()=>f.store.close());let w=f.begin();f.round(w,1);f.round(w,2);
  w=f.coord.decide(f.head,w.id,'keep approved plan',f.plan().map(a=>({...a,dependsOn:[]})));
  const root=w.rootTaskId,active=w.assignments[0]!.taskId!,failed=w.assignments[1]!.taskId!;
  f.store.updateTask(failed,{status:'reported',reportStatus:'blocked',reportText:'sandbox ACL denied'});
  f.coord.report(f.leads[1]!,failed,'blocked','sandbox ACL denied');
  const blocked=structuredClone(f.coord.current(f.d.id));
  assert.throws(()=>f.coord.resume(f.d.id,undefined,'stale-workflow'),/다른 회의 또는 작업/);
  f.store.updateMember(f.leads[1]!.id,{status:'error'});
  assert.throws(()=>f.coord.resume(f.d.id),/재고용/);
  assert.deepEqual(f.coord.current(f.d.id),blocked);
  f.store.updateMember(f.leads[1]!.id,{status:'idle'});
  w=new WorkflowCoordinator(f.store,f.host).resume(f.d.id);
  assert.equal(w.phase,'executing');assert.equal(w.problem,undefined);
  assert.equal(w.id,blocked!.id);assert.equal(w.rootTaskId,root);
  assert.equal(w.meeting!.minutes,'keep approved plan');
  assert.equal(w.assignments[0]!.taskId,active);
  assert.notEqual(w.assignments[1]!.taskId,failed);
  assert.equal(f.store.getTask(failed)!.reportText,'sandbox ACL denied');
  assert.match(f.store.getTask(w.assignments[1]!.taskId!)!.instruction,/sandbox ACL denied/);
  assert.match(f.store.getTask(w.assignments[1]!.taskId!)!.instruction,/미완료/);
  const count=f.store.listTasks().length;
  f.coord.resume(f.d.id);assert.equal(f.store.listTasks().length,count);
  f.store.updateTask(active,{status:'reported',reportStatus:'done'});
  f.coord.report(f.leads[0]!,active,'done','verified');
  const second=w.assignments[1]!.taskId!;
  f.store.updateTask(second,{status:'reported',reportStatus:'blocked'});
  f.coord.report(f.leads[1]!,second,'blocked','another recoverable failure');
  w=f.coord.resume(f.d.id);
  assert.equal(w.assignments[0]!.status,'done');assert.equal(w.assignments[0]!.taskId,active);
});

test('Office keeps an independent team hook open after a failure and resumes only failed deliveries',async t=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-branch-failure-'));
  const store=new Store(':memory:'),pty=new FakePty(),receiver=new FakeReceiver();
  const office=new Office({config:{dataDir:dir,hookPort:0,wsPort:0,mcpPort:0},store,pty,receiver});
  t.after(async()=>{await office.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
  await office.start();
  const {department,head}=office.createDepartment({name:'branches',cwd:dir,headName:'head',headEngine:'claude'});
  office.workflowDiscuss(department.id,'finish the approved work');office.workflowStart(department.id);
  const a=office.teamCreateTeam(head.id,{name:'healthy',leadName:'healthy lead'}).lead;
  const b=office.teamCreateTeam(head.id,{name:'failed',leadName:'failed lead'}).lead;
  const worker=office.teamHire(a.id,{name:'healthy worker',role:'implement assigned part'});
  const coord=office['workflows'];let w=coord.open(head,[a.id,b.id]);
  for(const round of [1,2])for(const lead of [a,b])coord.speak(lead,w.id,round,'agreed');
  w=coord.decide(head,w.id,'approved work',[a,b].map(lead=>({leadId:lead.id,task:'implement',acceptance:['verified']})));
  const active=w.assignments[0]!.taskId,failed=w.assignments[1]!.taskId!;
  office.teamReport(b.id,{taskId:failed,status:'blocked',summary:'sandbox initialization failed'});
  const hook=(lead:Member)=>fakeReq(lead.memberToken,'PreToolUse',{session_id:'session',hook_event_name:'PreToolUse',cwd:dir,tool_name:'Write',tool_input:{file_path:path.join(dir,'output.txt'),content:'work'}});
  const allowed=hook(a);receiver.emit('hook',allowed.req);await new Promise(r=>setTimeout(r,0));
  assert.deepEqual(allowed.sent,[{}],'a healthy assigned team still passes the actual tool hook');
  const denied=hook(b);receiver.emit('hook',denied.req);
  assert.match(JSON.stringify(denied.sent),/deny/);
  const delegated=office.teamDelegate(a.id,worker.id,'implement remaining approved part');
  assert.equal(delegated.to.id,worker.id);
  assert.throws(()=>office.teamDelegate(head.id,a.id,'new head assignment'),/확정/);
  store.updateTask(delegated.task.id,{status:'assigned'});
  store.updateTask(active!,{status:'assigned'});
  for(const member of [worker,a]){
    receiver.emit('hook',fakeReq(member.memberToken,'UserPromptSubmit',{session_id:`session-${member.id}`,hook_event_name:'UserPromptSubmit',cwd:dir,prompt:'assigned work'}).req);
    receiver.emit('hook',fakeReq(member.memberToken,'Stop',{session_id:`session-${member.id}`,hook_event_name:'Stop',cwd:dir,last_assistant_message:'Assigned work finished and verified.'}).req);
  }
  assert.equal(store.getTask(delegated.task.id)!.status,'reported');
  assert.equal(store.getTask(active!)!.status,'reported');
  assert.equal(office.workflowGet(department.id)!.phase,'blocked');
  w=await office.workflowResume(department.id,w.id);
  assert.equal(w.phase,'executing');assert.equal(w.assignments[0]!.taskId,active);
  assert.notEqual(w.assignments[1]!.taskId,failed);
  assert.equal(store.getTask(failed)!.reportStatus,'blocked');
});

test('Office gates actual hooks, direct instructions, hiring and early root report; shutdown preserves meeting',async t=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-office-'));
  const db=path.join(dir,'test.db');
  const store=new Store(db),pty=new FakePty(),receiver=new FakeReceiver();
  const office=new Office({config:{dataDir:dir,hookPort:0,wsPort:0,mcpPort:0},store,pty,receiver});
  t.after(async()=>{await office.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
  await office.start();
  const {department,head}=office.createDepartment({name:'planning',cwd:dir,headName:'chair',headEngine:'claude'});
  const w=office.workflowDiscuss(department.id,'Plan a file');
  assert.throws(()=>office.instruct(head.id,'write now'),/회의를 먼저/);
  assert.throws(()=>office.teamCreateTeam(head.id,{name:'early',leadName:'lead'}),/작업 시작 전/);
  for(const event of ['PreToolUse','PermissionRequest'] as const) {
    const req=fakeReq(head.memberToken,event,{session_id:'session',hook_event_name:event,cwd:dir,tool_name:'Write',tool_input:{file_path:path.join(dir,'bad.txt'),content:'bad'}});
    receiver.emit('hook',req.req);
    assert.match(JSON.stringify(req.sent),/deny/);
    assert.equal(store.snapshot().pending.length,0,'planning denial cannot become an approvable write');
  }
  office.workflowStart(department.id);
  const root=office.workflowGet(department.id)!.rootTaskId!;
  assert.throws(()=>office.teamReport(head.id,{taskId:root,summary:'done early',status:'done'}),/모두 마친/);
  const {lead}=office.teamCreateTeam(head.id,{name:'allowed',leadName:'lead'});
  assert.throws(()=>office.teamDelegate(head.id,lead.id,'implement now'),/확정/);
  office['workflows'].open(head,[lead.id]);
  const persisted=office.workflowGet(department.id)!;
  assert.equal(persisted.phase,'meeting');
  await office.shutdown();
  const reopened=new Store(db);
  assert.equal(reopened.currentWorkflow(department.id)!.phase,'meeting','normal exit must not block recovery');
  reopened.close();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'.pixel-office','workflows',`${w.id}.json`),'utf8')).phase,'meeting');
});

test('a real queued follow-up reaches the head and its reply cannot finish the root task',async t=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-followup-'));
  const store=new Store(':memory:'),pty=new FakePty(),receiver=new FakeReceiver();
  const office=new Office({config:{dataDir:dir,hookPort:0,wsPort:0,mcpPort:0},store,pty,receiver});
  t.after(async()=>{await office.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
  await office.start();const {department,head}=office.createDepartment({name:'followup',cwd:dir,headName:'head',headEngine:'claude'});
  office.workflowDiscuss(department.id,'Original plan');office.workflowStart(department.id);
  const {lead}=office.teamCreateTeam(head.id,{name:'team',leadName:'lead'});
  const w=office.workflowGet(department.id)!;w.phase='executing';w.assignments=[{leadId:lead.id,task:'work',acceptance:['done'],status:'done'}];store.saveWorkflow(w);
  store.updateTask(w.rootTaskId!,{status:'assigned'});
  const rt=office['runtimes'].get(head.id)!;
  rt.queue.clear();
  pty.data(head.id,'\x1b[2J\x1b[H'+loadFixture('claude-ready.txt').join('\r\n'));
  await new Promise(r=>setTimeout(r,50));
  const hook=(event:'UserPromptSubmit'|'Stop',extra:Record<string,string>)=>receiver.emit('hook',fakeReq(head.memberToken,event,{session_id:'session',hook_event_name:event,cwd:dir,...extra}).req);
  hook('UserPromptSubmit',{prompt:'Existing task still running'});
  office.workflowDiscuss(department.id,'진행 상황을 설명해 줘');
  assert.ok(!pty.sessions.get(head.id)!.pastes.some(p=>p.includes('WORKFLOW FOLLOWUP')),'a busy model must not receive pasted input in the middle of its response');
  store.updateMember(head.id,{status:'idle'});rt.queue.tick();
  await new Promise(r=>setTimeout(r,350));rt.queue.tick();
  assert.ok(pty.sessions.get(head.id)!.pastes.some(p=>p.includes('WORKFLOW FOLLOWUP') && p.includes('진행 상황을 설명해 줘')));
  hook('UserPromptSubmit',{prompt:'followup'});rt.queue.tick();
  assert.throws(()=>office.teamReport(head.id,{taskId:w.rootTaskId!,summary:'현재 상황 설명',status:'done'}),/대화 답변/);
  hook('Stop',{last_assistant_message:'현재 상태와 다음 조치를 설명합니다.'});
  assert.equal(store.getTask(w.rootTaskId!)!.status,'assigned');
  assert.equal(office.workflowGet(department.id)!.phase,'executing');
  assert.equal(office.workflowGet(department.id)!.messages.at(-1)!.role,'head');
  assert.equal(office.workflowGet(department.id)!.messages.at(-1)!.followup,true);
  hook('Stop',{});
  assert.equal(store.getTask(w.rootTaskId!)!.status,'assigned','a duplicate idle event cannot finish the task either');
  rt.queue.clear();
  rt.queue.emit('flushed',{kind:'system',text:'[ALL_REPORTS_IN]'});
  office['workflows'].stageComplete(head,{workflowId:w.id,stage:1,summary:'실제 작업 최종 보고',verification:['완료 기준 확인'],complete:true});
  assert.equal(store.getTask(w.rootTaskId!)!.status,'reported','the head can complete verified work without another user button');
  assert.equal(office.workflowGet(department.id)!.phase,'completed');
});

test('Office recovery reconnects deleted seats and restarts only stopped participants without losing the workflow',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'meeting-reconnect-'));
  const store=new Store(':memory:'),pty=new FakePty(),receiver=new FakeReceiver();
  const office=new Office({config:{dataDir:dir,hookPort:0,wsPort:0,mcpPort:0},store,pty,receiver});
  t.after(async()=>{await office.shutdown();fs.rmSync(dir,{recursive:true,force:true});});await office.start();
  const {department,head}=office.createDepartment({name:'reconnect',cwd:dir,headName:'head',headEngine:'claude'});
  office.workflowDiscuss(department.id,'keep the original plan');office.workflowStart(department.id);
  const a=office.teamCreateTeam(head.id,{name:'backend',leadName:'backend lead'});
  const b=office.teamCreateTeam(head.id,{name:'front',leadName:'front lead'});
  const w=office['workflows'].open(head,[a.lead.id,b.lead.id]);
  await office.clockOut(a.lead.id,{byLeader:true});await office.deleteTeam(a.team.id);
  const replacement=office.teamCreateTeam(head.id,{name:'backend',leadName:'backend lead'});
  await office.clockOut(b.lead.id,{byLeader:true});const spawns=pty.spawns.length;
  const first=office.workflowResume(department.id,w.id),second=office.workflowResume(department.id,w.id);
  assert.equal(first,second,'concurrent recovery shares one attempt');const recovered=await first;
  assert.equal(recovered.phase,'meeting');assert.equal(recovered.id,w.id);assert.equal(recovered.rootTaskId,w.rootTaskId);
  assert.deepEqual(recovered.meeting!.participants,[replacement.lead.id,b.lead.id]);assert.equal(pty.spawns.length,spawns+1);
  const visible=JSON.stringify(office.teamOfficeStatus(head.id));assert.ok(!visible.includes(head.memberToken));
  assert.throws(()=>office.teamOfficeStatus(b.lead.id),/쓸 수 있는 도구/);
});

test('startup creates a fresh Codex session when no first-turn session ID exists and keeps a blocked head quiet',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'meeting-cold-start-'));const store=new Store(':memory:');
  const department=store.createDepartment({name:'cold',cwd:dir});
  const head=store.createMember({departmentId:department.id,teamId:null,parentId:null,name:'head',rank:'head',engine:'claude',cwd:dir,hiredBy:'user',status:'suspended',sessionId:'head-session'});store.updateDepartment(department.id,{headId:head.id});
  const team=store.createTeam({departmentId:department.id,name:'team',cwd:dir});
  const lead=store.createMember({departmentId:department.id,teamId:team.id,parentId:head.id,name:'lead',rank:'lead',engine:'codex',cwd:dir,hiredBy:'leader',status:'suspended'});
  const root=store.createTask({departmentId:department.id,fromMember:'user',toMember:head.id,instruction:'original',status:'assigned'});
  store.setEnginePolicy(['claude','codex']);
  const date=new Date().toISOString();store.saveWorkflow({id:'blocked-w',departmentId:department.id,phase:'blocked',brief:'original',messages:[],assignments:[],rootTaskId:root.id,meeting:{round:1,state:'collecting',participants:[lead.id],participantNames:{[lead.id]:'lead'},contributions:[]},createdAt:date,updatedAt:date});
  const pty=new FakePty(),receiver=new FakeReceiver();const office=new Office({config:{dataDir:dir,hookPort:0,wsPort:0,mcpPort:0},store,pty,receiver});
  t.after(async()=>{await office.shutdown();fs.rmSync(dir,{recursive:true,force:true});});await office.start();
  assert.ok(pty.spawns.some(p=>p.memberId===lead.id && !p.resumeSessionId));assert.notEqual(store.getMember(lead.id)!.status,'error');
  assert.equal(office['runtimes'].get(head.id)!.queue.size(),0,'a blocked workflow does not trigger the head to recreate teams');
  receiver.emit('hook',fakeReq(lead.memberToken,'SessionStart',{session_id:'first-session',hook_event_name:'SessionStart',cwd:dir,source:'startup'}).req);
  await new Promise(r=>setTimeout(r,10));assert.equal(office.workflowGet(department.id)!.phase,'meeting','ready participants reconnect automatically');
});
