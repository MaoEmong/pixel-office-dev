import http from 'node:http';
import fs from 'node:fs';import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {WebSocket,WebSocketServer} from 'ws';
import QRCode from 'qrcode';
import {DeviceRegistry,hash,validProof,revokeMessage} from './DeviceRegistry.js';

type Reply={result?:unknown;error?:{code:number;message:string}};
const READ=new Set(['remote.snapshot','events.query','department.tree','workflow.get','member.instructions.get']);
const WRITE=new Set(['workflow.discuss','workflow.start','workflow.resume','workflow.cancel','workflow.complete','approval.respond','question.respond','member.interrupt','member.rehire']);
interface Connection {ws:WebSocket;upstream?:WebSocket;deviceId?:string;challenge?:{deviceId:string;message:string;expires:number};pending:Map<string,{resolve:(r:Reply)=>void;timer:NodeJS.Timeout}>;timer:NodeJS.Timeout;busy:boolean;}
export interface RemoteOptions {port:number;dataDir:string;upstreamUrl:()=>string;token:()=>string;assetsDir?:string;}

export class RemoteGateway {
  readonly registry:DeviceRegistry;
  private server:http.Server;
  private wss=new WebSocketServer({noServer:true,maxPayload:131072});
  private connections=new Set<Connection>();
  private inflight=new Map<string,{hash:string;promise:Promise<Reply>}>();
  private attempts=new Map<string,{count:number;reset:number}>();
  private closed=false;
  private heartbeat:NodeJS.Timeout;
  private assets:string;
  constructor(private options:RemoteOptions) {
    this.registry=new DeviceRegistry(path.join(options.dataDir,'remote-devices.db'));
    this.assets=options.assetsDir ?? path.resolve(import.meta.dirname,'../../remote-web');
    this.server=http.createServer((req,res)=>void this.http(req,res));
    this.server.on('upgrade',(req,socket,head)=>{
      if(req.url!=='/connect' || !this.originOK(req) || this.connections.size>=100){socket.destroy();return;}
      this.wss.handleUpgrade(req,socket,head,ws=>this.accept(ws));
    });
    this.heartbeat=setInterval(()=>{for(const c of this.connections)if(c.ws.readyState===WebSocket.OPEN)c.ws.ping();},25000);
    this.heartbeat.unref();
  }
  get port(){return (this.server.address() as import('node:net').AddressInfo|null)?.port ?? 0;}
  get localUrl(){return `http://127.0.0.1:${this.port}`;}
  get publicUrl(){return this.registry.getMeta('publicUrl') || this.localUrl;}
  async listen(){await new Promise<void>((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.options.port,'127.0.0.1',()=>resolve());});return this.port;}
  private originOK(req:http.IncomingMessage){
    const allowed=[new URL(this.localUrl),new URL(`http://localhost:${this.port}`),new URL(this.publicUrl)];
    const host=req.headers.host?.toLowerCase();
    if(!host || !allowed.some(u=>u.host.toLowerCase()===host))return false;
    const origin=req.headers.origin;
    return typeof origin==='string' && allowed.some(u=>u.origin===origin && u.host.toLowerCase()===host);
  }
  private rate(key:string,limit:number){
    const now=Date.now();for(const [k,v] of this.attempts)if(v.reset<=now)this.attempts.delete(k);
    const value=this.attempts.get(key)??{count:0,reset:now+60000};value.count++;this.attempts.set(key,value);
    if(value.count>limit)throw new Error('요청이 너무 많습니다. 잠시 후 다시 연결하세요.');
  }
  private async http(req:http.IncomingMessage,res:http.ServerResponse){
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host=req.headers.host?.toLowerCase();
      if(![new URL(this.localUrl),new URL(`http://localhost:${this.port}`),new URL(this.publicUrl)].some(u=>u.host.toLowerCase()===host)){res.writeHead(403);res.end();return;}
      if(req.method==='GET' && req.url==='/api/info'){
        this.rate(`info:${req.socket.remoteAddress}`,120);
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({workstationId:this.registry.workstationId,name:'픽셀 오피스 작업 PC'}));return;
      }
      if(req.method==='POST' && (req.url==='/api/pair' || req.url==='/api/revoke')){
        if(!this.originOK(req)){res.writeHead(403);res.end();return;}
        this.rate(`post:${req.socket.remoteAddress}`,30);
        let body='';for await(const chunk of req){body+=chunk.toString();if(body.length>4096)throw new Error('요청이 너무 큽니다.');}
        const p=JSON.parse(body);
        if(req.url==='/api/pair'){
          if(!['code','name','publicKey','signature'].every(k=>typeof p[k]==='string'))throw new Error('등록 정보를 확인하세요.');
          const d=this.registry.request(p.code,p.name,p.publicKey,p.signature);
          res.setHeader('Content-Type','application/json');res.end(JSON.stringify({deviceId:d.id,fingerprint:d.fingerprint}));return;
        }
        const d=typeof p.deviceId==='string'?this.registry.get(p.deviceId):undefined;
        if(!d || !validProof(d.publicKey,revokeMessage(this.registry.workstationId,d.id),p.signature))throw new Error('해제 서명을 확인할 수 없습니다.');
        this.revoke(d.id);res.setHeader('Content-Type','application/json');res.end('{"revoked":true}');return;
      }
      const files:Record<string,[string,string]>={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
      const entry=req.method==='GET'?files[(req.url??'').split('?')[0]!]:undefined;
      if(!entry){res.writeHead(404);res.end();return;}
      res.setHeader('Content-Type',entry[1]);res.end(fs.readFileSync(path.join(this.assets,entry[0])));
    }catch(err){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:err instanceof Error?err.message:'요청 실패'}));}
  }
  private send(c:Connection,value:unknown){if(c.ws.readyState===WebSocket.OPEN)c.ws.send(JSON.stringify(value,(key,item)=>['memberToken','member_token','token'].includes(key)?undefined:item));}
  private drop(c:Connection,reason='연결 종료'){
    clearTimeout(c.timer);c.upstream?.terminate();
    for(const p of c.pending.values()){clearTimeout(p.timer);p.resolve({error:{code:-32003,message:'연결이 끊겼습니다. 작업 상태를 확인하세요.'}});}c.pending.clear();
    if(c.ws.readyState===WebSocket.OPEN)c.ws.close(4001,reason);this.connections.delete(c);
  }
  private accept(ws:WebSocket){
    const c:Connection={ws,pending:new Map(),timer:setTimeout(()=>this.drop(c,'인증 시간 만료'),120000),busy:false};this.connections.add(c);
    ws.on('message',raw=>void this.message(c,raw.toString()).catch(()=>this.drop(c,'잘못된 요청')));
    ws.on('error',()=>this.drop(c));ws.on('close',()=>this.drop(c));
  }
  private async message(c:Connection,raw:string){
    let p:Record<string,any>;try{p=JSON.parse(raw);}catch{throw new Error('JSON');}
    if(!p || Array.isArray(p) || typeof p!=='object')throw new Error('request');
    if(!c.deviceId){
      this.rate('authentication',120);
      if(c.busy)return;
      if(p.type==='auth.begin' && typeof p.deviceId==='string'){
        const d=this.registry.get(p.deviceId);
        if(!d || d.status==='revoked'){this.send(c,{type:'auth.error',reason:'revoked',message:'등록이 없거나 연결이 해제되었습니다.'});this.drop(c);return;}
        if(d.status==='pending'){this.send(c,{type:'auth.pending',message:'작업 PC에서 이 기기를 승인해 주세요.'});return;}
        const message=`pixel-office auth v1\n${this.registry.workstationId}\n${d.id}\n${randomBytes(32).toString('base64url')}`;
        c.challenge={deviceId:d.id,message,expires:Date.now()+30000};this.send(c,{type:'auth.challenge',message});return;
      }
      if(p.type==='auth.prove'){
        const challenge=c.challenge;delete c.challenge;
        const d=challenge?this.registry.get(challenge.deviceId):undefined;
        if(!challenge || challenge.expires<=Date.now() || d?.status!=='approved' || !validProof(d.publicKey,challenge.message,p.signature)){
          this.send(c,{type:'auth.error',reason:'invalid',message:'기기 인증에 실패했습니다.'});this.drop(c);return;
        }
        c.busy=true;c.deviceId=d.id;this.registry.touch(d.id);clearTimeout(c.timer);
        const upstream=new WebSocket(this.options.upstreamUrl());c.upstream=upstream;
        c.timer=setTimeout(()=>this.drop(c,'PC 연결 시간 만료'),10000);
        upstream.on('open',()=>upstream.send(JSON.stringify({jsonrpc:'2.0',id:'bridge-hello',method:'hello',params:{token:this.options.token(),client:{name:`remote:${d.id}`,version:'1'}}})));
        upstream.on('message',data=>{
          let reply;try{reply=JSON.parse(data.toString());}catch{return;}
          if(reply.id==='bridge-hello'){
            clearTimeout(c.timer);if(reply.error){this.drop(c);return;}
            c.busy=false;this.send(c,{type:'auth.ready',workstationId:this.registry.workstationId,deviceId:d.id,...reply.result});return;
          }
          if(reply.id){const pending=c.pending.get(reply.id);if(pending){c.pending.delete(reply.id);clearTimeout(pending.timer);pending.resolve(reply.error?{error:reply.error}:{result:reply.result});}}
          else if(reply.method)this.send(c,reply);
        });
        upstream.on('close',()=>this.drop(c));upstream.on('error',()=>this.drop(c));return;
      }
      throw new Error('authentication');
    }
    if(this.registry.get(c.deviceId)?.status!=='approved'){this.drop(c);return;}
    if(c.busy || !c.upstream || c.upstream.readyState!==WebSocket.OPEN)return;
    this.rate(`rpc:${c.deviceId}`,300);
    if(p.jsonrpc!=='2.0' || typeof p.method!=='string' || !['string','number'].includes(typeof p.id))throw new Error('rpc');
    if(!READ.has(p.method) && !WRITE.has(p.method)){this.send(c,{jsonrpc:'2.0',id:p.id,error:{code:-32601,message:'원격에서 허용되지 않는 기능입니다.'}});return;}
    const params=p.params && typeof p.params==='object' && !Array.isArray(p.params)?p.params:{};
    if('force' in params || 'parentPid' in params || 'token' in params){this.send(c,{jsonrpc:'2.0',id:p.id,error:{code:-32602,message:'원격 요청에 허용되지 않는 인자입니다.'}});return;}
    let reply:Reply;
    if(WRITE.has(p.method)){
      if(typeof p.requestId!=='string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(p.requestId))throw new Error('requestId');
      const key=`${c.deviceId}:${p.requestId}`,inputHash=hash(JSON.stringify({method:p.method,params}));
      const running=this.inflight.get(key),saved=this.registry.remembered(c.deviceId,p.requestId);
      if(running && running.hash===inputHash)reply=await running.promise;
      else if(saved){
        reply=saved.hash!==inputHash?{error:{code:-32602,message:'같은 요청 ID를 다른 작업에 사용할 수 없습니다.'}}:saved.reply ?? {error:{code:-32003,message:'이 요청은 이미 전송됐습니다. 재시작 전 실행 결과를 작업 화면에서 확인하세요.'}};
      }else{
        this.registry.remember(c.deviceId,p.requestId,{hash:inputHash});
        const promise=this.forward(c,p.method,params);this.inflight.set(key,{hash:inputHash,promise});
        reply=await promise;this.inflight.delete(key);
        if(!this.closed)this.registry.remember(c.deviceId,p.requestId,{hash:inputHash,reply});
      }
    }else reply=await this.forward(c,p.method,params);
    if(!this.closed && this.registry.get(c.deviceId)?.status==='approved')this.send(c,{jsonrpc:'2.0',id:p.id,...reply});
  }
  private forward(c:Connection,method:string,params:unknown):Promise<Reply>{
    return new Promise(resolve=>{const id=randomUUID();const timer=setTimeout(()=>{c.pending.delete(id);resolve({error:{code:-32003,message:'PC 응답을 기다리는 중 연결이 끊겼습니다. 작업 상태를 확인하세요.'}});},30000);
      c.pending.set(id,{resolve,timer});c.upstream!.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));});
  }
  localHandlers(){return {
    'remote.status':()=>({localUrl:this.localUrl,publicUrl:this.publicUrl,workstationId:this.registry.workstationId,devices:this.registry.list().map(({publicKey,...d})=>d)}),
    'remote.configure':(p:Record<string,unknown>)=>{
      if(p.publicUrl===''){this.registry.setMeta('publicUrl','');return {publicUrl:this.localUrl};}
      const url=new URL(String(p.publicUrl));
      if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/')throw new Error('외부 접속 주소는 HTTPS 주소여야 합니다.');
      this.registry.setMeta('publicUrl',url.origin);return {publicUrl:url.origin};
    },
    'remote.pair.create':async()=>{const invitation=this.registry.invite();const url=`${this.publicUrl}/#pair=${invitation.code}`;return {...invitation,url,qrPngDataUrl:await QRCode.toDataURL(url,{width:240,margin:2})};},
    'remote.device.approve':(p:Record<string,unknown>)=>{this.registry.approve(String(p.deviceId));return {approved:true};},
    'remote.device.revoke':(p:Record<string,unknown>)=>{this.revoke(String(p.deviceId));return {revoked:true};},
  };}
  revoke(id:string){this.registry.revoke(id);for(const c of [...this.connections])if(c.deviceId===id || c.challenge?.deviceId===id)this.drop(c,'기기 연결이 해제되었습니다.');}
  async close(){
    if(this.closed)return;this.closed=true;clearInterval(this.heartbeat);for(const c of [...this.connections])this.drop(c);
    for(const ws of this.wss.clients)ws.terminate();
    await new Promise<void>(resolve=>this.server.close(()=>resolve()));this.wss.close();this.registry.close();
  }
}
