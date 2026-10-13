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

test('two-round meeting, expert participation, dependent work, final report and user review',t=> {
  const f=setup(); t.after(()=>f.store.close());
  const w=f.begin();
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
