import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Office} from '../../src/office/Office.js';
import {Store} from '../../src/store/Store.js';
import {FakePty, FakeReceiver, makeTree} from './fakes.js';

test('engine policy persists across DB reopen', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'office-policy-'));
  try {
    let store=new Store(path.join(dir,'office.db'));
    assert.equal(store.enginePolicy(),null);
    store.setEnginePolicy(['claude']);store.close();
    store=new Store(path.join(dir,'office.db'));
    assert.deepEqual(store.enginePolicy(),['claude']);store.close();
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('default blocks cross-engine hiring; explicit selection permits it; disabled restart preserves live CLI', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'office-policy-'));
  const store=new Store(':memory:');const pty=new FakePty();
  const office=new Office({config:{dataDir:dir,hookPort:0,mcpPort:0,wsPort:0},store,pty,receiver:new FakeReceiver()});
  try {
    await office.start();const tree=makeTree(office,{cwd:dir});
    const n=store.snapshot().members.length;
    assert.throws(()=>office.teamCreateTeam(tree.head.id,{name:'other',leadName:'other',engine:'codex'}),/허용되지/);
    assert.throws(()=>office.teamHire(tree.lead.id,{name:'worker',role:'test',engine:'codex'}),/허용되지/);
    assert.equal(store.snapshot().members.length,n);
    assert.match(office.effectiveInstructions(tree.lead.id),/쓸 수 있는 엔진은 claude\./);
    office.setEnginePolicy(['claude','codex']);
    const worker=office.teamHire(tree.lead.id,{name:'worker',role:'test',engine:'codex'});
    office.setEnginePolicy(['claude']);
    await assert.rejects(office.restart(worker.id),/허용되지/);
    assert.equal(pty.get(worker.id)?.alive,true);
    assert.throws(()=>office.instruct(worker.id,'new task',{force:true}),/허용되지/);
    await office.clockOut(worker.id);
    await assert.rejects(office.rehire(worker.id),/허용되지/);
  } finally {await office.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});

test('spawn failure leaves a recoverable error member, no starting row or open task', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'office-spawn-'));
  const store=new Store(':memory:');const pty=new FakePty();
  const office=new Office({config:{dataDir:dir,hookPort:0,mcpPort:0,wsPort:0},store,pty,receiver:new FakeReceiver()});
  try {
    await office.start();const tree=makeTree(office,{cwd:dir});
    const spawn=pty.spawn.bind(pty);
    pty.spawn=()=>{throw new Error('injected spawn failure');};
    assert.throws(()=>office.teamHire(tree.lead.id,{name:'failed',role:'test'}),/injected/);
    const member=store.snapshot().members.find(m=>m.name==='failed')!;
    assert.equal(member.status,'error');assert.equal(member.childPid,null);
    assert.equal(store.listTasks({toMember:member.id,status:['queued','assigned']}).length,0);
    assert.equal(pty.get(member.id),undefined);
    pty.spawn=spawn;await office.rehire(member.id);
    assert.equal(pty.get(member.id)?.alive,true);
  } finally {await office.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});

test('instruction write failure marks error before any CLI spawn', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'office-instructions-'));
  const store=new Store(':memory:');const pty=new FakePty();
  const office=new Office({config:{dataDir:dir,hookPort:0,mcpPort:0,wsPort:0},store,pty,receiver:new FakeReceiver()});
  try {
    await office.start();const tree=makeTree(office,{cwd:dir});
    const blocked=path.join(dir,'teams',tree.team.id);
    fs.mkdirSync(path.dirname(blocked),{recursive:true});fs.writeFileSync(blocked,'file');
    const n=pty.spawns.length;
    assert.throws(()=>office.teamHire(tree.lead.id,{name:'write failed',role:'test'}));
    assert.equal(store.snapshot().members.find(m=>m.name==='write failed')?.status,'error');
    assert.equal(pty.spawns.length,n);
  } finally {await office.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});

test('disabled engine recovery aborts open tasks without spawning CLI', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'office-recover-policy-'));
  const store=new Store(':memory:');const pty=new FakePty();
  const dept=store.createDepartment({name:'dept',cwd:dir});
  const member=store.createMember({departmentId:dept.id,name:'head',rank:'head',engine:'codex',cwd:dir,hiredBy:'user',status:'suspended',sessionId:'old-session'});
  const task=store.createTask({departmentId:dept.id,fromMember:'user',toMember:member.id,instruction:'old task',status:'assigned'});
  store.setEnginePolicy(['claude']);
  const office=new Office({config:{dataDir:dir,hookPort:0,mcpPort:0,wsPort:0},store,pty,receiver:new FakeReceiver()});
  try {
    await office.start();await office.recoveryDone;
    assert.equal(pty.spawns.length,0);assert.equal(store.getMember(member.id)?.status,'error');
    assert.equal(store.getTask(task.id)?.status,'aborted');
    assert.ok(office.recoveryResult?.failed.includes(member.id));
  } finally {await office.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});

test('MCP create_team and hire await auth failure without creating rows, then succeed after repair', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'office-mcp-auth-'));
  const store=new Store(':memory:');let blocked=true;let checks=0;
  const office=new Office({config:{dataDir:dir,hookPort:0,mcpPort:0,wsPort:0},store,pty:new FakePty(),receiver:new FakeReceiver(),beforeHire:async()=>{checks++;await Promise.resolve();if(blocked)throw new Error('로그인 필요');}});
  const clients:Client[]=[];
  try {
    const info=await office.start();const tree=makeTree(office,{cwd:dir});
    for(const [member,name,args] of [
      [tree.head,'create_team',{name:'new',leadName:'new'}],
      [tree.lead,'hire',{name:'new worker',role:'test'}],
    ] as const) {
      const client=new Client({name:'test',version:'1'});clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${info.mcpPort}/mcp/${member.memberToken}`)));
      const n=store.snapshot().members.length;
      const failure=await client.callTool({name,arguments:args});
      assert.equal(failure.isError,true);assert.match(JSON.stringify(failure.content),/로그인 필요/);
      assert.equal(store.snapshot().members.length,n);
      blocked=false;const success=await client.callTool({name,arguments:args});
      assert.notEqual(success.isError,true);blocked=true;
    }
    assert.equal(checks,4);
  } finally {for(const c of clients)await c.close();await office.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});
