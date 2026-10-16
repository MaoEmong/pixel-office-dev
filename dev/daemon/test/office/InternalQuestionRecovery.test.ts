import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Office} from '../../src/office/Office.js';
import {Store} from '../../src/store/Store.js';
import type {Member} from '../../src/store/types.js';
import {FakePty,FakeReceiver,acknowledgeInputs,fakeReq,seedDeptTeam} from './fakes.js';
import {loadFixture} from '../screen/helpers.js';

const wait=async(check:()=>boolean)=>{
 const deadline=Date.now()+6000;
 while(!check()){if(Date.now()>deadline)assert.fail('internal message did not resume');await new Promise(r=>setTimeout(r,20));}
};
async function setup(t:import('node:test').TestContext){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'po-internal-recovery-'));
 const file=path.join(root,'office.db');
 let store=new Store(file);
 const {department,team}=seedDeptTeam(store,{cwd:root});
 const mk=(name:string,rank:Member['rank'],parentId:string|null)=>store.createMember({departmentId:department.id,teamId:rank==='head'?null:team.id,parentId,name,rank,engine:'claude',cwd:root,status:'idle',sessionId:`session-${name}`,hiredBy:parentId?'leader':'user'});
 const head=mk('head','head',null),lead=mk('lead','lead',head.id),child=mk('child','member',lead.id);
 let office:Office,pty:FakePty,receiver:FakeReceiver;
 async function start(){
  pty=new FakePty();receiver=new FakeReceiver();
  office=new Office({store,pty,receiver,config:{dataDir:root,hookPort:0,wsPort:0,mcpPort:0},recovery:{orphanOps:{alive:()=>false,name:()=>undefined,kill:()=>{}}}});
  acknowledgeInputs(office);await office.start();
 }
 function ready(m:Member){
  receiver.emit('hook',fakeReq(m.memberToken,'SessionStart',{session_id:m.sessionId!,hook_event_name:'SessionStart',cwd:root,source:'resume'}).req);
  pty.data(m.id,'\x1b[2J\x1b[H'+loadFixture('claude-ready.txt').join('\r\n'));
 }
 async function reboot(){await office.shutdown();store=new Store(file);await start();}
 t.after(async()=>{await office?.shutdown();fs.rmSync(root,{recursive:true,force:true});});
 return {head,lead,child,start,ready,reboot,get office(){return office;},get store(){return store;},get pty(){return pty;},get receiver(){return receiver;}};
}

test('restart redelivers a saved internal question once to its parent, without a user answer',async t=>{
 const f=await setup(t);
 const q=f.store.createPending({memberId:f.child.id,type:'question',payload:{source:'ask_parent',question:'화면 변경을 확인해 주세요.',options:[],from:f.child.id,to:f.lead.id}});
 const user=f.store.createPending({memberId:f.head.id,type:'question',payload:{source:'ask_user',question:'사용자만 결정하는 내용',options:[]}});
 await f.start();f.ready(f.lead);f.ready(f.head);f.ready(f.child);
 await wait(()=>f.pty.session(f.lead.id).pastes.some(p=>p.includes(`q#${q.id}`)));
 assert.ok(f.pty.session(f.lead.id).pastes[0]?.includes('reply로 답한 뒤 턴을 끝내라'),'question recovery must not restart completed business work');
 f.ready(f.lead);f.ready(f.child);
 await new Promise(r=>setTimeout(r,600));
 assert.equal(f.pty.session(f.lead.id).pastes.filter(p=>p.includes(`q#${q.id}`)).length,1);
 assert.equal(f.store.getPending(user.id)?.status,'open');
 f.office.teamReply(f.lead.id,{toMember:f.child.id,text:'확인했습니다. 반영한 내용으로 진행하세요.'});
 await wait(()=>f.pty.session(f.child.id).pastes.some(p=>p.includes(`[ANSWER q#${q.id}]`)));
 assert.equal(f.store.getPending(q.id)?.status,'answered');
 await new Promise(r=>setTimeout(r,1800));
 assert.equal(f.pty.session(f.child.id).pastes.length,1,'a redundant RESUMED prompt must not wake a finished AI after its answer');
});

test('an answered reply survives a shutdown before delivery and is not replayed after acceptance',async t=>{
 const f=await setup(t);
 const q=f.store.createPending({memberId:f.child.id,type:'question',payload:{source:'ask_parent',question:'확인 부탁드립니다.',options:[],from:f.child.id,to:f.lead.id}});
 const legacy=f.store.createPending({memberId:f.child.id,type:'question',payload:{source:'ask_parent',question:'예전에 끝난 질문',options:[],from:f.child.id,to:f.lead.id}});
 f.store.answerPending(legacy.id,{'예전에 끝난 질문':'이전 답변'});
 await f.start();
 // The child and parent exist but have not shown their input screen yet.
 f.office.teamReply(f.lead.id,{toMember:f.child.id,text:'확인 완료. 문서 내용으로 진행하세요.'});
 assert.equal(f.store.getPending(q.id)?.payload.answerDelivery,'pending');
 assert.equal(f.pty.session(f.child.id).pastes.length,0);
 await f.reboot();f.ready(f.head);f.ready(f.lead);f.ready(f.child);
 await wait(()=>f.store.getPending(q.id)?.payload.answerDelivery==='delivered');
 assert.equal(f.pty.session(f.child.id).pastes.filter(p=>p.includes(`[ANSWER q#${q.id}]`)).length,1);
 assert.ok(!f.pty.session(f.child.id).pastes.some(p=>p.includes(legacy.id)),'legacy answers are not replayed');
 assert.ok(!f.pty.session(f.lead.id).pastes.some(p=>p.includes(`q#${q.id}`)),'answered questions are not redelivered to the parent');
 await f.reboot();f.ready(f.head);f.ready(f.lead);f.ready(f.child);
 await new Promise(r=>setTimeout(r,700));
 assert.deepEqual(f.pty.session(f.child.id).pastes,[],'accepted answers remain accepted across another restart');
});

test('answer recovery retains RESUMED context when unfinished work remains',async t=>{
 const f=await setup(t);
 const task=f.store.createTask({departmentId:f.child.departmentId,fromMember:f.lead.id,toMember:f.child.id,instruction:'계속해야 할 실제 업무',status:'assigned'});
 const q=f.store.createPending({memberId:f.child.id,type:'question',payload:{source:'ask_parent',question:'남은 업무의 기준은?',options:[],from:f.child.id,to:f.lead.id}});
 await f.start();f.ready(f.head);f.ready(f.lead);f.ready(f.child);
 f.office.teamReply(f.lead.id,{toMember:f.child.id,text:'문서 기준대로 계속하세요.'});
 await wait(()=>f.pty.session(f.child.id).pastes.some(p=>p.startsWith('[RESUMED]')));
 const inputs=f.pty.session(f.child.id).pastes;
 assert.ok(inputs[0]?.startsWith(`[ANSWER q#${q.id}]`));
 assert.ok(inputs[1]?.includes(`task#${task.id}`),'real task recovery instructions must remain after the answer');
 assert.equal(f.store.getTask(task.id)?.status,'assigned');
});

test('restarting only the parent redelivers its lost queued question and keeps the child waiting for AI',async t=>{
 const f=await setup(t);await f.start();f.ready(f.head);f.ready(f.lead);f.ready(f.child);
 f.store.updateMember(f.lead.id,{status:'working'});
 const q=f.office.askParent(f.child.id,{question:'어느 안으로 진행할까요?',options:['A','B']});
 const old=f.pty.session(f.lead.id);
 assert.equal(old.pastes.length,0);
 await f.office.restart(f.lead.id);f.ready(f.lead);f.ready(f.child);
 await wait(()=>f.pty.session(f.lead.id).pastes.some(p=>p.includes(`q#${q.id}`)));
 assert.equal(f.pty.session(f.lead.id).pastes.filter(p=>p.includes(`q#${q.id}`)).length,1);
 assert.equal(f.store.getPending(q.id)?.status,'open');
 f.office.teamReply(f.lead.id,{toMember:f.child.id,text:'A로 진행하세요.'});
 await wait(()=>f.store.getPending(q.id)?.payload.answerDelivery==='delivered');
});

test('a parent that ends its turn without reply is reminded, without completing unrelated work',async t=>{
 const f=await setup(t);
 const q=f.store.createPending({memberId:f.child.id,type:'question',payload:{source:'ask_parent',question:'검토해주세요.',options:[],from:f.child.id,to:f.lead.id}});
 await f.start();f.ready(f.head);f.ready(f.lead);f.ready(f.child);
 await wait(()=>f.pty.session(f.lead.id).pastes.some(p=>p.includes(`q#${q.id}`)));
 const task=f.store.createTask({departmentId:f.lead.departmentId,fromMember:f.head.id,toMember:f.lead.id,instruction:'아직 끝나지 않은 별도 업무',status:'assigned'});
 await new Promise(r=>setTimeout(r,500));
 f.receiver.emit('hook',fakeReq(f.lead.memberToken,'Stop',{session_id:f.lead.sessionId!,hook_event_name:'Stop',cwd:f.lead.cwd,stop_hook_active:false}).req);
 await wait(()=>f.pty.session(f.lead.id).pastes.filter(p=>p.includes(`q#${q.id}`)).length===2);
 assert.equal(f.store.getTask(task.id)?.status,'assigned','answering an internal question is not task completion');
 assert.ok(f.pty.session(f.lead.id).pastes.at(-1)?.includes('reply 호출이 확인되지 않았다'));
 await new Promise(r=>setTimeout(r,500));
 f.receiver.emit('hook',fakeReq(f.lead.memberToken,'Stop',{session_id:f.lead.sessionId!,hook_event_name:'Stop',cwd:f.lead.cwd,stop_hook_active:false}).req);
 await wait(()=>f.pty.session(f.lead.id).pastes.filter(p=>p.includes(`q#${q.id}`)).length===3);
 await new Promise(r=>setTimeout(r,500));
 f.receiver.emit('hook',fakeReq(f.lead.memberToken,'Stop',{session_id:f.lead.sessionId!,hook_event_name:'Stop',cwd:f.lead.cwd,stop_hook_active:false}).req);
 await wait(()=>f.pty.session(f.head.id).pastes.some(p=>p.includes('[내부 질문 답변 누락 복구]')));
 assert.equal(f.store.getTask(task.id)?.status,'assigned');
 assert.equal(f.store.getPending(q.id)?.status,'open','an internal escalation must not fabricate a user answer');
 f.office.teamReply(f.lead.id,{toMember:f.child.id,text:'검토했습니다.'});
 await wait(()=>f.store.getPending(q.id)?.payload.answerDelivery==='delivered');
});
