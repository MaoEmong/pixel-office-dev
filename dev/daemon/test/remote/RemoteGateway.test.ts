import {test} from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';import {WebSocket,WebSocketServer} from 'ws';
import {RemoteGateway} from '../../src/remote/RemoteGateway.js';import {revokeMessage} from '../../src/remote/DeviceRegistry.js';

class Peer {
 messages:any[]=[];waiters:Array<{check:(m:any)=>boolean;done:(m:any)=>void}>=[];
 constructor(readonly ws:WebSocket){ws.on('message',raw=>{const m=JSON.parse(raw.toString());this.messages.push(m);for(const w of [...this.waiters])if(w.check(m)){this.waiters.splice(this.waiters.indexOf(w),1);w.done(m);}});}
 send(m:any){this.ws.send(JSON.stringify(m));}
 wait(check:(m:any)=>boolean){const hit=this.messages.find(check);if(hit)return Promise.resolve(hit);return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('remote wait timeout')),5000);this.waiters.push({check,done:m=>{clearTimeout(timer);resolve(m);}});});}
}
test('gateway approval, challenge replay, origin boundary, RPC filtering, duplicate execution, persistence and both-side revoke',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-gateway-'));const upstream=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise(r=>upstream.once('listening',r));
 let writes=0;upstream.on('connection',ws=>ws.on('message',raw=>{const p=JSON.parse(raw.toString());if(p.method==='hello'){assert.equal(p.params.token,'master-secret');assert.equal(p.params.parentPid,undefined);ws.send(JSON.stringify({jsonrpc:'2.0',id:p.id,result:{snapshot:{members:[{name:'head',memberToken:'hook-secret'}],departments:[],pending:[],tasks:[]}}}));}else{writes++;setTimeout(()=>ws.send(JSON.stringify({jsonrpc:'2.0',id:p.id,result:{count:writes}})),30);}}));
 const url=`ws://127.0.0.1:${(upstream.address() as any).port}`;
 const make=()=>new RemoteGateway({port:0,dataDir:dir,upstreamUrl:()=>url,token:()=> 'master-secret'});let gateway=make();await gateway.listen();
 const sockets:WebSocket[]=[];
 gateway.localHandlers()['remote.configure']({publicUrl:'https://office.example.ts.net'});
 assert.equal(gateway.publicUrl,'https://office.example.ts.net');
 gateway.localHandlers()['remote.configure']({publicUrl:''});assert.equal(gateway.publicUrl,gateway.localUrl);
 assert.equal(gateway.registry.getMeta('publicUrl'),'');
 t.after(async()=>{for(const s of sockets)s.terminate();await gateway.close();for(const s of upstream.clients)s.terminate();await new Promise<void>(r=>upstream.close(()=>r()));fs.rmSync(dir,{recursive:true,force:true});});
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),spki=publicKey.export({type:'spki',format:'der'}).toString('base64');
 const proof=(m:string)=>sign('sha256',Buffer.from(m),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
 const post=async(endpoint:string,p:any,origin=gateway.localUrl)=>fetch(`${gateway.localUrl}${endpoint}`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(p)});
 const invite=await gateway.localHandlers()['remote.pair.create']();assert.match(invite.qrPngDataUrl,/^data:image\/png;base64,/);
 const pair={name:'phone',code:invite.code,publicKey:spki,signature:proof(`pixel-office pair v1\n${gateway.registry.workstationId}\n${invite.code}\nphone`)};
 assert.equal((await post('/api/pair',pair,'https://evil.example')).status,403);
 const response=await post('/api/pair',pair);assert.equal(response.status,200);const {deviceId}=await response.json() as any;
 assert.equal((await post('/api/pair',pair)).status,400);
 const connect=async()=>{const ws=new WebSocket(`${gateway.localUrl.replace('http','ws')}/connect`,{origin:gateway.localUrl});sockets.push(ws);const p=new Peer(ws);await new Promise(r=>ws.once('open',r));return p;};
 const pending=await connect();pending.send({type:'auth.begin',deviceId});await pending.wait(m=>m.type==='auth.pending');assert.ok(!JSON.stringify(pending.messages).includes('hook-secret'));
 gateway.registry.approve(deviceId);
 const auth=async(p:Peer)=>{p.send({type:'auth.begin',deviceId});const q=await p.wait(m=>m.type==='auth.challenge');p.send({type:'auth.prove',signature:proof(q.message)});const ready=await p.wait(m=>m.type==='auth.ready');assert.equal(ready.snapshot.members[0].memberToken,undefined);return q;};
 const p=await connect();const challenge=await auth(p);
 p.send({jsonrpc:'2.0',id:1,method:'daemon.shutdown',params:{}});assert.equal((await p.wait(m=>m.id===1)).error.code,-32601);
 p.send({jsonrpc:'2.0',id:2,method:'workflow.start',params:{force:true},requestId:randomUUID()});assert.equal((await p.wait(m=>m.id===2)).error.code,-32602);
 const id=randomUUID();p.send({jsonrpc:'2.0',id:3,method:'workflow.start',params:{departmentId:'d'},requestId:id});p.send({jsonrpc:'2.0',id:4,method:'workflow.start',params:{departmentId:'d'},requestId:id});await p.wait(m=>m.id===4);assert.equal(writes,1);
 const replay=await connect();replay.send({type:'auth.begin',deviceId});await replay.wait(m=>m.type==='auth.challenge');replay.send({type:'auth.prove',signature:proof(challenge.message)});await replay.wait(m=>m.type==='auth.error');
 await gateway.close();gateway=make();await gateway.listen();assert.equal(gateway.registry.get(deviceId)?.status,'approved');
 const restored=await connect();await auth(restored);restored.send({jsonrpc:'2.0',id:5,method:'workflow.start',params:{departmentId:'d'},requestId:id});await restored.wait(m=>m.id===5);assert.equal(writes,1,'retry after gateway restart does not execute twice');
 const signature=proof(revokeMessage(gateway.registry.workstationId,deviceId));assert.equal((await post('/api/revoke',{deviceId,signature})).status,200);
 const rejected=await connect();rejected.send({type:'auth.begin',deviceId});await rejected.wait(m=>m.type==='auth.error');assert.equal(gateway.registry.get(deviceId)?.status,'revoked');
 const other=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),otherKey=other.publicKey.export({format:'der',type:'spki'}).toString('base64'),i=gateway.registry.invite();
 const d=gateway.registry.request(i.code,'PC',otherKey,sign('sha256',Buffer.from(`pixel-office pair v1\n${gateway.registry.workstationId}\n${i.code}\nPC`),{key:other.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64'));
 gateway.registry.approve(d.id);gateway.revoke(d.id);assert.equal(gateway.registry.get(d.id)?.status,'revoked');
});
