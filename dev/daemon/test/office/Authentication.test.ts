import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Office} from '../../src/office/Office.js';import {Store} from '../../src/store/Store.js';
import {FakePty,FakeReceiver,acknowledgeInputs,fakeReq} from './fakes.js';
import {loadFixture} from '../screen/helpers.js';
const base=(event:string)=>({session_id:'auth-session-test',hook_event_name:event,cwd:'D:\\x'});
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function setup(t:import('node:test').TestContext){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'po-auth-office-')),store=new Store(':memory:'),pty=new FakePty(),receiver=new FakeReceiver();
 const office=new Office({store,pty,receiver,config:{dataDir:root,hookPort:0,wsPort:0,mcpPort:0}});acknowledgeInputs(office);await office.start();
 t.after(async()=>{await office.shutdown();fs.rmSync(root,{recursive:true,force:true});});
 const {department,head}=office.createDepartment({name:'test',cwd:root,headEngine:'claude'});
 const ready=()=>{receiver.emit('hook',fakeReq(head.memberToken,'SessionStart',{...base('SessionStart'),source:'startup'}).req);pty.data(head.id,'\x1b[2J\x1b[H'+loadFixture('claude-ready.txt').join('\r\n'));};
 return {root,store,pty,receiver,office,head,department,ready};
}
test('expired login becomes an error, keeps terminal and pending conversation, and retries exactly once without duplicating records',async t=>{
 const f=await setup(t);f.ready();const w=f.office.workflowDiscuss(f.department.id,'다음 작업 진행해');
 await sleep(900);
 f.pty.data(f.head.id,'\x1b[2J\x1b[H● Login expired · Please run /login\r\n');await sleep(100);
 assert.equal(f.store.getMember(f.head.id)?.status,'error');assert.ok(f.pty.get(f.head.id)?.alive);
 assert.ok(f.office.eventsQuery({memberId:f.head.id}).some(e=>e.kind==='error' && e.detail.code==='authentication-required'));
 await f.office.reconnectAuthentication(f.head.id);assert.equal(f.pty.spawns.at(-1)?.memberId,f.head.id);f.ready();await sleep(900);
 assert.equal(f.office.workflowGet(f.department.id)?.id,w.id);assert.equal(f.office.workflowGet(f.department.id)?.messages.length,1);
 assert.equal(f.pty.session(f.head.id).pastes.filter(p=>p.includes('다음 작업 진행해')).length,1);
});
test('login runs the actual CLI login command inside the member terminal and can be followed by recovery',async t=>{
 const f=await setup(t);f.ready();await f.office.loginMember(f.head.id);
 assert.deepEqual(f.pty.bareSpawns[0]?.args,['auth','login']);
 assert.ok(f.pty.bareSpawns[0]?.env?.CLAUDE_CONFIG_DIR?.startsWith(f.root));
 f.office.typeRaw(f.head.id,'test-input');assert.ok(f.pty.session(f.head.id).writes.includes('test-input'));
 f.pty.exit(f.head.id,0);assert.equal(f.store.getMember(f.head.id)?.status,'idle');
 await f.office.reconnectAuthentication(f.head.id);assert.equal(f.pty.spawns.length,2);
});
test('CLI slash commands are not workflow messages; multiline and work interruption are rejected',async t=>{
 const f=await setup(t);f.ready();f.pty.data(f.head.id,'\x1b[2J\x1b[H❯ \r\n⏸ manual mode on · ← for agents\r\n');await sleep(100);
 f.office.terminalCommand(f.head.id,'/help');assert.ok(f.pty.session(f.head.id).writes.includes('\x15/help\r'));assert.equal(f.office.workflowGet(f.department.id),undefined);
 assert.throws(()=>f.office.terminalCommand(f.head.id,'/help\r\ndelete'),/한 줄/);
 f.store.updateMember(f.head.id,{status:'working'});await assert.rejects(f.office.loginMember(f.head.id),/진행 중/);
});
