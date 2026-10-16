import {test} from 'node:test';import assert from 'node:assert/strict';
import {EnvironmentDiagnostics,probeCodexExecution} from '../../src/diagnostics/environment.js';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import type {Member} from '../../src/store/types.js';
import {Store} from '../../src/store/Store.js';
import {Office} from '../../src/office/Office.js';
import {FakePty,FakeReceiver} from '../office/fakes.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
test('known missing/logged-out engines block without executing; unknown does not falsely block; retry observes repaired auth',async()=>{
 let reason:'not-installed'|'logged-out'|'unknown'|null='not-installed';
 const d=new EnvironmentDiagnostics(async()=>({connected:reason===null,plan:null,reason}));
 await assert.rejects(d.require('claude'),/CLI를 설치/);
 reason='logged-out';await assert.rejects(d.require('codex'),/codex login/);
 const report=await d.check();assert.equal(report.engines.length,2);assert.ok(report.engines.every(e=>e.reason==='logged-out'));
 reason='unknown';await d.require('claude');assert.match((await d.check()).engines[0]!.message,/단정하지/);
 reason=null;await d.require('codex');assert.equal((await d.check()).engines[1]!.connected,true);
});
test('probe failure is unknown and does not expose raw command output',async()=>{
 const d=new EnvironmentDiagnostics(async()=>{throw Error('secret stdout');});
 await d.require('claude');const r=await d.check();assert.equal(r.engines[0]!.reason,'unknown');assert.ok(!JSON.stringify(r).includes('secret'));
});
test('existing project home is probed instead of global login, with a scoped repair command',async t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'office-auth-'));
 t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 const home=path.join(cwd,'.pixel-office','sessions','m','claude');fs.mkdirSync(home,{recursive:true});
 const m={id:'m',cwd,engine:'claude',name:'부장'} as Member;
 const d=new EnvironmentDiagnostics(async(_engine,env)=>{assert.equal(env?.CLAUDE_CONFIG_DIR,home);return {connected:false,plan:null,reason:'logged-out'};});
 await assert.rejects(d.require('claude',m),/프로젝트 세션 인증/);
 assert.ok((await d.check(m)).engines[0]!.message.includes(home));
});

function executionMember(t:{after(fn:()=>void):void}):Member{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'office-execution-'));
 t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 fs.mkdirSync(path.join(cwd,'.pixel-office','sessions','m','codex'),{recursive:true});
 return {id:'m',cwd,engine:'codex',name:'프론트팀장'} as Member;
}

test('execution check runs a fixed no-op in the member workspace with approvals and isolation intact',async t=>{
 const member=executionMember(t);let calls=0;
 const result=await probeCodexExecution(member,{platform:'win32',run:async(_file,args,timeout)=>{
  calls++;assert.equal(timeout,5000);
  assert.deepEqual(args.slice(args.indexOf('--')+1),['cmd.exe','/d','/c','echo','PIXEL_OFFICE_EXECUTION_OK']);
  assert.equal(args[args.indexOf('-C')+1],member.cwd);
  assert.ok(args.includes('features.prefer_mxc=true'));assert.ok(args.includes('sandbox_mode="workspace-write"'));
  assert.ok(!args.some(arg=>arg.includes('danger-full-access')||arg.includes('bypass-approvals')));
  return {exitCode:0,stdout:'PIXEL_OFFICE_EXECUTION_OK\r\n',stderr:''};
 }});
 assert.equal(result.ok,true);assert.equal(result.checked,true);assert.equal(calls,1);
});

test('known permission failure is reported before work, never retried or exposed as a login problem',async t=>{
 const member=executionMember(t);let calls=0;
 const result=await probeCodexExecution(member,{platform:'win32',run:async()=>{
  calls++;return {exitCode:1,stdout:'',stderr:'requesting user must be permitted to write and modify sandbox directory ACL; private-output-secret'};
 }});
 assert.equal(result.ok,false);assert.equal(result.reason,'permissions');assert.equal(calls,1);
 assert.match(result.message,/Windows 실행 권한/);
 assert.ok(!result.message.includes('private-output-secret'));assert.ok(!result.message.includes('codex login'));
 const missing=await probeCodexExecution({...member,id:'not-prepared'},{platform:'win32',run:async()=>{throw Error('must not run a global fallback');}});
 assert.equal(missing.reason,'unprepared');
});

test('only a timed out no-op is retried once; successful exit without its marker is not readiness',async t=>{
 const member=executionMember(t);let calls=0;
 const recovered=await probeCodexExecution(member,{platform:'win32',run:async()=>++calls===1
  ? {exitCode:null,stdout:'',stderr:'',timedOut:true}
  : {exitCode:0,stdout:'PIXEL_OFFICE_EXECUTION_OK\n',stderr:''}});
 assert.equal(recovered.ok,true);assert.equal(calls,2);
 calls=0;
 const timeout=await probeCodexExecution(member,{platform:'win32',run:async()=>{calls++;return {exitCode:null,stdout:'',stderr:'',timedOut:true};}});
 assert.equal(timeout.reason,'timeout');assert.equal(calls,2);
 const empty=await probeCodexExecution(member,{platform:'win32',run:async()=>({exitCode:0,stdout:'',stderr:''})});
 assert.equal(empty.ok,false);
 const unsupported=await probeCodexExecution(member,{platform:'win32',run:async()=>({exitCode:2,stdout:'',stderr:'error: unexpected argument --permission-profile'})});
 assert.equal(unsupported.reason,'unavailable');assert.match(unsupported.message,/Codex CLI를 업데이트/);
 const skipped=await probeCodexExecution(member,{platform:'linux',run:async()=>{throw Error('must not launch Windows command');}});
 assert.equal(skipped.checked,false);
});

test('concurrent checks share a probe, repaired environments are rechecked, and login success cannot hide execution failure',async t=>{
 const member=executionMember(t);let calls=0,ready=false;
 const diagnostics=new EnvironmentDiagnostics(async()=>({connected:true,plan:null,reason:null}),async()=>{
  calls++;await new Promise(resolve=>setImmediate(resolve));
  return {ok:ready,checked:true,message:ready?'실제 명령 실행 확인됨':'Windows 실행 권한을 준비하지 못했습니다.'};
 });
 const results=await Promise.allSettled([diagnostics.requireExecution(member),diagnostics.requireExecution(member)]);
 assert.equal(calls,1);assert.ok(results.every(r=>r.status==='rejected'));
 const failure=(results[0] as PromiseRejectedResult).reason;
 assert.match(failure.message,/프론트팀장: 작업 시작 전/);assert.match(failure.message,/업무는 보내지 않았/);
 const report=await diagnostics.check(member);
 assert.equal(report.engines[0]!.connected,true);assert.equal(report.engines[0]!.execution!.ok,false);
 assert.match(report.engines[0]!.message,/Windows 실행 권한/);
 ready=true;await diagnostics.requireExecution(member);assert.equal(calls,3);
 assert.equal((await diagnostics.check(member)).engines[0]!.execution!.ok,true);
});

test('MCP planning, delegation and resume wait for checks; failure keeps work unsent and opens one notice', {timeout:15000},async t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'office-preflight-'));
 const store=new Store(':memory:');let fail=true,failureDetail='프론트팀장: 작업 시작 전 Windows 실행 권한 점검에 실패했습니다.';
 let entered!:()=>void,release!:()=>void;
 const waiting=new Promise<void>(resolve=>{entered=resolve;});
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const checked:string[][]=[],notices:string[]=[];
 const office=new Office({config:{dataDir:cwd,hookPort:0,wsPort:0,mcpPort:0},store,pty:new FakePty(),receiver:new FakeReceiver(),beforeWork:async members=>{
  checked.push(members.map(m=>m.id));entered();await gate;if(fail)throw Error(failureDetail);
 }});
 const clients:Client[]=[];
 t.after(async()=>{for(const client of clients)await client.close();await office.shutdown();fs.rmSync(cwd,{recursive:true,force:true});});
 office.on('notice',(level,message)=>{if(level==='error')notices.push(message);});
 const info=await office.start();store.setEnginePolicy(['claude','codex']);
 const {department,head}=office.createDepartment({name:'preflight',cwd,headName:'head',headEngine:'claude'});
 office.workflowDiscuss(department.id,'implement and verify');office.workflowStart(department.id);
 const {lead}=office.teamCreateTeam(head.id,{name:'front',leadName:'프론트팀장',engine:'codex'});
 const coord=office['workflows'];const w=coord.open(head,[lead.id]);
 for(const round of [1,2])coord.speak(lead,w.id,round,'agreed');
 const client=new Client({name:'preflight-test',version:'1'});clients.push(client);
 await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${info.mcpPort}/mcp/${head.memberToken}`)));
 const input={workflowId:w.id,minutes:'approved work',assignments:[{leadId:lead.id,task:'implement',acceptance:['verified']}]};
 const call=client.callTool({name:'meeting_decide',arguments:input});
 await waiting;
 const count=store.listTasks().length;
 assert.equal(count,1);assert.equal(office.workflowGet(department.id)!.phase,'meeting');
 release();const rejected=await call;
 assert.equal(rejected.isError,true);assert.match(JSON.stringify(rejected),/실행 권한/);
 assert.equal(store.listTasks().length,count);assert.equal(notices.length,1);assert.ok(checked[0]!.includes(lead.id));
 await client.callTool({name:'meeting_decide',arguments:input});assert.equal(notices.length,1,'repeated failures do not flood popups');
 fail=false;const accepted=await client.callTool({name:'meeting_decide',arguments:input});
 assert.ok(!accepted.isError);assert.match(JSON.stringify(accepted),/executing/);
 assert.equal(store.listTasks().length,count+1);
 fail=true;
 const refused=await client.callTool({name:'delegate',arguments:{to_member:lead.id,task:'next approved item'}});
 assert.equal(refused.isError,true);assert.equal(store.listTasks().length,count+1);
 const taskId=office.workflowGet(department.id)!.assignments[0]!.taskId!;
 office.teamReport(lead.id,{taskId,status:'blocked',summary:'environment unavailable'});
 failureDetail='프론트팀장: 재개 전 실행 권한 점검에 실패했습니다.';
 const noticeCount=notices.length;
 await assert.rejects(office.workflowResume(department.id),/실행 권한/);
 assert.equal(notices.length,noticeCount,'user RPC owns its popup; do not emit a duplicate notice');
 assert.equal(office.workflowGet(department.id)!.phase,'blocked');assert.equal(store.listTasks().length,count+1);
 const aiResume=await client.callTool({name:'meeting_resume',arguments:{workflowId:w.id}});
 assert.equal(aiResume.isError,true);assert.equal(notices.length,noticeCount+1,'AI-side failure still reaches the user');
 fail=false;await office.workflowResume(department.id);
 assert.equal(office.workflowGet(department.id)!.phase,'executing');assert.equal(store.listTasks().length,count+2);
});
