// Opt-in: real Claude chair + two leads, meeting → approved Write → dependent review → restart.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type {Workflow} from '../../src/workflow/types.js';
import type {DaemonInfo} from '../../src/office/types.js';
import type {Department, Member} from '../../src/store/types.js';
import {Client, IT, SANDBOX, itEnv, startDaemon, waitExit, killTree, sweepClaudeByDataDir, snapshotOnce, pidAlive} from './it-helpers.js';

test('real meeting: clarify → two rounds → approved write → dependent verification → report → restart → complete',
  {skip: IT ? false : 'set PIXEL_IT=1 to run', timeout:900_000}, async()=> {
  const filename=`workflow-it-${Date.now()}.txt`, target=path.join(SANDBOX,filename);
  const {dataDir,env}=await itEnv('workflow');
  const daemons:ReturnType<typeof startDaemon>[]=[];
  let c:Client|undefined;
  const connect=async()=> {
    const d=startDaemon('workflow',env);daemons.push(d);
    await d.waitLine('listening',l=>l.includes('[daemon] listening'),20000);
    const info=JSON.parse(fs.readFileSync(path.join(dataDir,'daemon.json'),'utf8')) as DaemonInfo;
    c=await Client.connect(info.wsPort,'workflow');
    await c.call('hello',{token:info.token,client:{name:'workflow-it',version:'0'}});
    return {d,info};
  };
  try {
    let {d,info}=await connect();
    const {department,head}=await c!.call<{department:Department;head:Member}>('department.create',{
      name:'workflow-it',cwd:SANDBOX,headName:'MeetingChair',headEngine:process.env.PIXEL_WORKFLOW_ENGINE==='codex' ? 'codex' : 'claude'});
    await c!.waitStatus(head.id,'idle',120000);
    const seq=c!.lastSeq;
    await c!.call('workflow.discuss',{departmentId:department.id,text:
      `Plan a tiny acceptance test: create only ${filename} using Write with exactly MEETING_OK. Two Claude leads only: Writer performs Write directly, Reviewer reads and verifies after Writer reports done. No workers. No shell commands. No implementation until the meeting decision. No questions needed; scope and acceptance are fully specified. Reply briefly with the outline.`});
    const answer=await c!.waitEvent(head.id,'text',seq,180000);
    await c!.waitEvent(head.id,'idle',answer.seq,60000);
    assert.equal(fs.existsSync(target),false,'discussion must not implement');
    await c!.call('workflow.start',{departmentId:department.id});
    const approval=await c!.waitFor('Write approval after meeting',n=>n.method==='event' && n.params.kind==='waiting_approval',480000);
    const before=(await c!.call<{workflow:Workflow}>('workflow.get',{departmentId:department.id})).workflow;
    assert.equal(before.phase,'executing');
    assert.equal(before.meeting!.contributions.length,before.meeting!.participants.length*2);
    assert.ok(before.meeting!.minutes);
    assert.equal(before.assignments.length,2);
    assert.ok(before.assignments.some(a=>a.dependsOn?.length===1));
    assert.equal(fs.existsSync(target),false,'Write waits for explicit approval');
    assert.equal((approval.params.detail as Record<string,unknown>).tool,'Write');
    await c!.call('approval.respond',{pendingId:(approval.params.ref as Record<string,unknown>).approvalId,behavior:'allow'});
    const final=await c!.waitFor('final review',n=>n.method==='workflow.changed' && n.params.id===before.id && n.params.phase==='review',300000);
    const completed=final.params as unknown as Workflow;
    assert.ok(completed.assignments.every(a=>a.status==='done'));
    assert.equal(fs.readFileSync(target,'utf8').trim(),'MEETING_OK');
    assert.ok(completed.result);
    const snap=await snapshotOnce(info.wsPort,info.token,'workflow-before-restart');
    const sessionId=snap.members.find(m=>m.id===head.id)!.sessionId;
    assert.ok(sessionId);
    await c!.call('daemon.shutdown',{});
    assert.ok(await waitExit(d.child,30000));c!.close();c=undefined;
    assert.equal(d.child.exitCode,0,'original daemon exits cleanly');
    assert.ok(snap.members.every(m=>!m.childPid || !pidAlive(m.childPid)),'original sessions exited before restart');
    ({d,info}=await connect());
    const restored=(await c!.call<{workflow:Workflow}>('workflow.get',{departmentId:department.id})).workflow;
    assert.deepEqual(restored,completed,'final report and entire meeting persist across restart');
    await c!.waitStatus(head.id,'idle',180000);
    const recovered=await snapshotOnce(info.wsPort,info.token,'workflow-recovered');
    assert.equal(recovered.members.find(m=>m.id===head.id)!.sessionId,sessionId);
    const checked=await c!.call<{workflow:Workflow}>('workflow.complete',{departmentId:department.id});
    assert.equal(checked.workflow.phase,'completed');
    const exported=JSON.parse(fs.readFileSync(path.join(SANDBOX,'.pixel-office','workflows',`${before.id}.json`),'utf8'));
    assert.equal(exported.phase,'completed');
    await c!.call('daemon.shutdown',{});
    assert.ok(await waitExit(d.child,60000),'recovered daemon finishes its shutdown');
    assert.equal(d.child.exitCode,0,'recovered daemon exits cleanly');
    const pids=recovered.members.map(m=>m.childPid).filter((p):p is number=>!!p);
    assert.ok(pids.every(p=>!pidAlive(p)),'all test sessions exit without orphan CLI processes');
  } finally {
    c?.close();
    for(const d of daemons) if(d.child.exitCode===null && d.child.pid) killTree(d.child.pid);
    sweepClaudeByDataDir(dataDir,[]);
    fs.rmSync(target,{force:true});
  }
});
