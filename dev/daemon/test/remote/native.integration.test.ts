import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';import {WebSocket} from 'ws';
import {Client,itEnv,startDaemon,waitExit,killTree,SANDBOX} from '../office/it-helpers.js';
import type {DaemonInfo} from '../../src/office/types.js';

class RemoteClient {
 messages:any[]=[];waiters:Array<{test:(m:any)=>boolean;done:(m:any)=>void}>=[];
 constructor(readonly ws:WebSocket){ws.on('message',raw=>{const m=JSON.parse(raw.toString());this.messages.push(m);if(m.method==='event')console.log('[remote]',m.params.kind,JSON.stringify(m.params.detail).slice(0,110));for(const w of [...this.waiters])if(w.test(m)){this.waiters.splice(this.waiters.indexOf(w),1);w.done(m);}});}
 wait(pred:(m:any)=>boolean,timeout=240000){const hit=this.messages.find(pred);if(hit)return Promise.resolve(hit);return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('remote wait timed out')),timeout);timer.unref();this.waiters.push({test:pred,done:m=>{clearTimeout(timer);resolve(m);}});});}
 send(m:any){this.ws.send(JSON.stringify(m));}
 async call(method:string,params={}){const id=randomUUID();this.send({jsonrpc:'2.0',id,method,params,requestId:randomUUID()});const r=await this.wait(m=>m.id===id,40000);if(r.error)throw new Error(r.error.message);return r.result;}
}

test('real remote device: pair → Claude meeting → remote approval → report → restart authentication → revoke',
 {skip:process.env.PIXEL_REMOTE_IT!=='1'?'set PIXEL_REMOTE_IT=1':false,timeout:600000},async()=>{
 const {dataDir,env}=await itEnv('remote-native');const daemons:ReturnType<typeof startDaemon>[]=[];
 const filename=`remote-native-${Date.now()}.txt`,target=path.join(SANDBOX,filename);
 let local:Client|undefined,remote:RemoteClient|undefined;
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),spki=publicKey.export({format:'der',type:'spki'}).toString('base64');
 const proof=(m:string)=>sign('sha256',Buffer.from(m),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
 async function launch(){const d=startDaemon('remote-native',env);daemons.push(d);await d.waitLine('listening',l=>l.includes('[daemon] listening'),20000);const info=JSON.parse(fs.readFileSync(path.join(dataDir,'daemon.json'),'utf8')) as DaemonInfo;local=await Client.connect(info.wsPort,'remote-local');await local.call('hello',{token:info.token,client:{name:'remote-native',version:'1'}});return {d,info};}
 async function authenticate(info:DaemonInfo,deviceId:string){const url=`http://127.0.0.1:${info.remotePort}`,ws=new WebSocket(`${url.replace('http','ws')}/connect`,{origin:url});remote=new RemoteClient(ws);await new Promise(r=>ws.once('open',r));remote.send({type:'auth.begin',deviceId});const challenge=await remote.wait(m=>m.type==='auth.challenge',10000);remote.send({type:'auth.prove',signature:proof(challenge.message)});return await remote.wait(m=>m.type==='auth.ready',10000);}
 try {
  let {d,info}=await launch();const {department,head}=await local!.call<any>('department.create',{name:'원격 통합 테스트',cwd:SANDBOX,headEngine:'claude',headName:'RemoteChair'});await local!.waitStatus(head.id,'idle',120000);
  const invitation=await local!.call<any>('remote.pair.create',{}),base=`http://127.0.0.1:${info.remotePort}`,pc=await (await fetch(`${base}/api/info`)).json() as any;
  const response=await fetch(`${base}/api/pair`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({code:invitation.code,name:'통합 테스트 기기',publicKey:spki,signature:proof(`pixel-office pair v1\n${pc.workstationId}\n${invitation.code}\n통합 테스트 기기`)})});assert.equal(response.status,200);const {deviceId}=await response.json() as any;
  await local!.call('remote.device.approve',{deviceId});const ready=await authenticate(info,deviceId);assert.equal(ready.snapshot.members.find((m:any)=>m.id===head.id).memberToken,undefined);
  await remote!.call('workflow.discuss',{departmentId:department.id,text:`Plan creating only ${filename} using Write with exactly REMOTE_NATIVE_OK. Two Claude leads: Writer writes directly; Reviewer reads after Writer reports done. No workers or shell. Scope is final, no questions needed. Reply briefly then wait for Start.`});
  const answer=await remote!.wait(m=>m.method==='event' && m.params.memberId===head.id && m.params.kind==='text');await remote!.wait(m=>m.method==='event' && m.params.memberId===head.id && m.params.kind==='idle' && m.params.seq>answer.params.seq);assert.equal(fs.existsSync(target),false);
  await remote!.call('workflow.start',{departmentId:department.id});const approval=await remote!.wait(m=>m.method==='event' && m.params.kind==='waiting_approval',360000);
  const workflow=(await remote!.call('workflow.get',{departmentId:department.id})).workflow;assert.equal(workflow.phase,'executing');assert.equal(workflow.meeting.contributions.length,4);assert.equal(fs.existsSync(target),false);
  await remote!.call('approval.respond',{pendingId:approval.params.ref.approvalId,behavior:'allow'});
  await remote!.wait(m=>m.method==='workflow.changed' && m.params.phase==='review');assert.equal(fs.readFileSync(target,'utf8'),'REMOTE_NATIVE_OK');
  remote!.ws.close();await local!.call('daemon.shutdown',{});assert.ok(await waitExit(d.child,40000));assert.equal(d.child.exitCode,0);local!.close();
  ({d,info}=await launch());const restored=await authenticate(info,deviceId);assert.equal(restored.workstationId,pc.workstationId);assert.equal((await remote!.call('workflow.get',{departmentId:department.id})).workflow.phase,'review');
  await remote!.call('workflow.complete',{departmentId:department.id});const disconnected=new Promise(r=>remote!.ws.once('close',r));await local!.call('remote.device.revoke',{deviceId});await disconnected;
  const ws=new WebSocket(`ws://127.0.0.1:${info.remotePort}/connect`,{origin:`http://127.0.0.1:${info.remotePort}`}),rejected=new RemoteClient(ws);await new Promise(r=>ws.once('open',r));rejected.send({type:'auth.begin',deviceId});assert.equal((await rejected.wait(m=>m.type==='auth.error',10000)).reason,'revoked');ws.close();
  await local!.call('daemon.shutdown',{});assert.ok(await waitExit(d.child,40000));assert.equal(d.child.exitCode,0);
 } finally {remote?.ws.terminate();local?.close();for(const d of daemons)if(d.child.exitCode===null&&d.child.pid)killTree(d.child.pid);fs.rmSync(target,{force:true});}
});
