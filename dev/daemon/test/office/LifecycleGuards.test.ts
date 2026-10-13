import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Office} from '../../src/office/Office.js';
import {Store} from '../../src/store/Store.js';
import {FakePty,FakeReceiver,FakeMcp} from './fakes.js';

async function setup(engine:'claude'|'codex'='claude') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'office-guards-'));const cwd=path.join(root,'project');fs.mkdirSync(cwd);
  const store=new Store(':memory:');const pty=new FakePty();
  const office=new Office({config:{dataDir:path.join(root,'data'),hookPort:0,wsPort:0,mcpPort:0},store,pty,receiver:new FakeReceiver(),mcp:new FakeMcp()});
  await office.start();const {department,head}=office.createDepartment({name:'test',cwd,headEngine:engine});
  return {root,cwd,store,pty,office,department,head,async close(){await office.shutdown();fs.rmSync(root,{recursive:true,force:true});}};
}

test('moved folder blocks restart before live CLI is killed; reconnect updates the entire retired tree', async t=> {
  const f=await setup();t.after(()=>f.close());
  const {team,lead}=f.office.createTeam({departmentId:f.department.id,name:'team'});
  const moved=path.join(f.root,'moved');fs.renameSync(f.cwd,moved);
  await assert.rejects(f.office.restart(f.head.id),/프로젝트 폴더/);
  assert.throws(()=>f.office.instruct(f.head.id,'new task'),/프로젝트 폴더/);
  assert.throws(()=>f.office.workflowDiscuss(f.department.id,'new discussion'),/프로젝트 폴더/);
  assert.equal(f.office.workflowGet(f.department.id),undefined);
  assert.equal(fs.existsSync(f.cwd),false);assert.equal(f.pty.get(f.head.id)?.alive,true);
  assert.throws(()=>f.office.updateDepartment({departmentId:f.department.id,cwd:moved}),/퇴근/);
  await f.office.clockOut(f.head.id);
  f.office.updateDepartment({departmentId:f.department.id,cwd:moved});
  assert.equal(f.store.getDepartment(f.department.id)?.cwd,moved);
  assert.equal(f.store.getTeam(team.id)?.cwd,moved);assert.equal(f.store.getMember(lead.id)?.cwd,moved);
  await f.office.rehire(f.head.id);assert.equal(f.pty.spawns.at(-1)?.cwd,moved);
});

test('session and team limits reject before adding rows; retirement frees capacity', async t=> {
  const f=await setup();t.after(()=>f.close());
  f.office.setResourceLimits({maxLiveSessions:2,maxTeamsPerDepartment:1});
  const {team,lead}=f.office.createTeam({departmentId:f.department.id,name:'one'});
  assert.throws(()=>f.office.createTeam({departmentId:f.department.id,name:'two'}),/팀 수 제한/);
  assert.throws(()=>f.office.teamHire(lead.id,{name:'extra',role:'test'}),/세션 수 제한/);
  assert.equal(f.store.snapshot().members.length,2);assert.equal(f.store.snapshot().teams.length,1);
  f.office.setResourceLimits({maxLiveSessions:1,maxTeamsPerDepartment:1});
  await assert.rejects(f.office.restart(f.head.id),/세션 수 제한/);
  assert.equal(f.pty.get(f.head.id)?.alive,true);
  f.office.setResourceLimits({maxLiveSessions:2,maxTeamsPerDepartment:1});
  await f.office.clockOut(lead.id);
  await f.office.rehire(lead.id);assert.equal(f.pty.get(lead.id)?.alive,true);
  assert.throws(()=>f.office.setResourceLimits({maxLiveSessions:1.5,maxTeamsPerDepartment:1}),/정수/);
  assert.ok(f.store.getTeam(team.id));
});

test('event logging never recreates a moved project and resumes when the folder returns',async t=>{
  const f=await setup();t.after(()=>f.close());
  const moved=path.join(f.root,'moved');fs.renameSync(f.cwd,moved);
  const event={seq:1,memberId:f.head.id,kind:'running',detail:{},ref:{},ts:new Date().toISOString(),teamId:'',departmentId:f.department.id} as const;
  f.office.emit('event',event);f.office.emit('event',event);
  assert.equal(fs.existsSync(f.cwd),false);
  fs.renameSync(moved,f.cwd);f.office.emit('event',event);
  assert.ok(fs.existsSync(path.join(f.cwd,'.pixel-office','sessions',f.head.id,'events.jsonl')));
});

test('boot timeout becomes error, aborts waiting task and kills CLI; rehire can recover', async t=> {
  const f=await setup('codex');t.after(()=>f.close());
  const task=f.office.instruct(f.head.id,'pending task');
  const clock=Date.now;const base=clock();
  try {Date.now=()=>base+181000;await new Promise(r=>setTimeout(r,750));}finally{Date.now=clock;}
  assert.equal(f.store.getMember(f.head.id)?.status,'error');assert.equal(f.store.getTask(task)?.status,'aborted');
  assert.equal(f.pty.get(f.head.id)?.alive ?? false,false);
  await f.office.rehire(f.head.id);assert.equal(f.pty.get(f.head.id)?.alive,true);
});

test('failed workflow final save never queues a rolled back task to a real Office input queue', async t=> {
  const f=await setup();t.after(()=>f.close());f.office.workflowDiscuss(f.department.id,'request');
  const save=f.store.saveWorkflow.bind(f.store);let calls=0;
  f.store.saveWorkflow=w=>{if(++calls===2)throw new Error('injected final save');save(w);};
  const runtimes=(f.office as unknown as {runtimes:Map<string,{queue:{size():number}}>}).runtimes;
  const n=runtimes.get(f.head.id)!.queue.size();
  assert.throws(()=>f.office.workflowStart(f.department.id),/injected final save/);
  assert.equal(runtimes.get(f.head.id)!.queue.size(),n);assert.equal(f.store.listTasks().length,0);
  assert.equal(f.office.workflowGet(f.department.id)?.phase,'clarifying');
});

test('report and workflow completion roll back together; failed reports publish no completion event',async t=>{
  const f=await setup();t.after(()=>f.close());const {lead}=f.office.createTeam({departmentId:f.department.id,name:'lead'});
  const task=f.store.createTask({departmentId:f.department.id,fromMember:f.head.id,toMember:lead.id,instruction:'work',status:'assigned'});
  f.store.saveWorkflow({id:'w_report',departmentId:f.department.id,phase:'executing',brief:'work',messages:[],assignments:[{leadId:lead.id,task:'work',acceptance:['done'],taskId:task.id,status:'assigned'}],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  let reports=0;f.office.on('event',ev=>{if(ev.kind==='reporting')reports++;});
  const save=f.store.saveWorkflow.bind(f.store);f.store.saveWorkflow=()=>{throw new Error('workflow disk failure');};
  assert.throws(()=>f.office.teamReport(lead.id,{taskId:task.id,status:'done',summary:'result'}),/workflow disk failure/);
  assert.equal(f.store.getTask(task.id)?.status,'assigned');assert.equal(f.office.workflowGet(f.department.id)?.assignments[0]?.status,'assigned');assert.equal(reports,0);
  f.store.saveWorkflow=save;f.office.teamReport(lead.id,{taskId:task.id,status:'done',summary:'result'});
  assert.equal(f.store.getTask(task.id)?.status,'reported');assert.equal(f.office.workflowGet(f.department.id)?.assignments[0]?.status,'done');assert.equal(reports,1);
});
