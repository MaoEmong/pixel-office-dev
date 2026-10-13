import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {WebSocketServer} from 'ws';import {RemoteGateway} from '../../src/remote/RemoteGateway.js';

test('real mobile-width browser: pairing, persistent non-exportable key, approval, report, offline revoke and no work storage',
 {skip:process.env.PIXEL_BROWSER_IT!=='1'?'set PIXEL_BROWSER_IT=1':false,timeout:120000},async t=>{
 const {chromium}=await import('playwright');const browser=await chromium.launch({channel:process.env.PIXEL_BROWSER_CHANNEL??'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-browser-')),target=path.join(dir,'result.txt');
 const upstream=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise(r=>upstream.once('listening',r));
 const snapshot:any={seq:0,departments:[{id:'d',name:'모바일 테스트'}],members:[{id:'h',departmentId:'d',rank:'head',name:'부장',status:'idle',memberToken:'secret'}],pending:[],tasks:[]};
 let workflow:any=null,writes=0;
 upstream.on('connection',ws=>ws.on('message',raw=>{
  const p=JSON.parse(raw.toString());let result:any={};
  if(p.method==='hello' || p.method==='remote.snapshot')result={snapshot};
  if(p.method==='events.query')result={events:[]};
  if(p.method==='workflow.get')result={workflow};
  if(p.method==='workflow.discuss'){workflow={id:'w',departmentId:'d',phase:'clarifying',brief:p.params.text,messages:[{role:'user',text:p.params.text}],assignments:[]};result={workflow};}
  if(p.method==='workflow.start'){
   workflow={...workflow,phase:'executing',meeting:{participants:['lead'],participantNames:{lead:'작성팀장'},contributions:[{memberId:'lead',round:1,text:'쓰기 제안'},{memberId:'lead',round:2,text:'검토 완료'}],minutes:'파일 생성'},assignments:[{leadId:'lead',task:'파일 생성',acceptance:['REMOTE_OK'],status:'assigned'}]};
   snapshot.pending=[{id:'a',memberId:'h',status:'open',type:'approval',payload:{tool_name:'Write',tool_input:{file_path:target,content:'REMOTE_OK'}}}];result={workflow};
  }
  if(p.method==='approval.respond'){assert.equal(p.params.pendingId,'a');assert.equal(p.params.behavior,'allow');writes++;fs.writeFileSync(target,'REMOTE_OK');snapshot.pending=[];workflow={...workflow,phase:'review',result:'REMOTE_OK 완료 보고',assignments:workflow.assignments.map((a:any)=>({...a,status:'done'}))};}
  if(p.method==='workflow.complete'){workflow={...workflow,phase:'completed'};result={workflow};}
  ws.send(JSON.stringify({jsonrpc:'2.0',id:p.id,result}));
 }));
 const gateway=new RemoteGateway({port:0,dataDir:dir,upstreamUrl:()=>`ws://127.0.0.1:${(upstream.address() as any).port}`,token:()=> 'secret'});await gateway.listen();
 t.after(async()=>{await browser.close();await gateway.close();for(const c of upstream.clients)c.terminate();await new Promise<void>(r=>upstream.close(()=>r()));fs.rmSync(dir,{recursive:true,force:true});});
 const invitation=await gateway.localHandlers()['remote.pair.create']();
 await page.goto(invitation.url);await page.getByLabel('이 기기 이름').fill('브라우저 테스트');await page.getByRole('button',{name:'등록 요청',exact:true}).click();
 await page.getByText('작업 PC에서 이 기기를 승인해 주세요.',{exact:true}).waitFor();const d=gateway.registry.list().find(d=>d.status==='pending')!;assert.ok(d);
 gateway.registry.approve(d.id);await page.locator('#workspace').waitFor({state:'visible'});
 await page.reload();await page.locator('#workspace').waitFor({state:'visible'});assert.equal(gateway.registry.list().length,1,'refresh reuses approved device');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'390px viewport has no horizontal overflow');
 await page.getByLabel('부장에게 이야기하기').fill('파일 한 개를 작성하고 검토해 주세요');await page.getByRole('button',{name:'대화 보내기',exact:true}).click();
 await page.getByRole('button',{name:'작업 시작 · 회의 소집'}).waitFor();assert.equal(writes,0);
 await page.getByRole('button',{name:'작업 시작 · 회의 소집'}).click();await page.getByRole('button',{name:'허가',exact:true}).waitFor();assert.equal(fs.existsSync(target),false);
 await page.getByRole('button',{name:'허가',exact:true}).click();await page.getByRole('button',{name:'검수 완료',exact:true}).waitFor();assert.equal(fs.readFileSync(target,'utf8'),'REMOTE_OK');assert.equal(writes,1);
 await page.getByRole('button',{name:'검수 완료',exact:true}).click();await page.locator('#phase').filter({hasText:'검수 완료'}).waitFor();
 const storage=await page.evaluate(async()=>{
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('pixel-office-device',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const rows=await new Promise<any[]>((resolve,reject)=>{const r=db.transaction('identity').objectStore('identity').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  let exportable=true;try{await crypto.subtle.exportKey('pkcs8',rows[0].privateKey);}catch{exportable=false;}db.close();
  return {rows:rows.map(r=>Object.keys(r)),exportable,localStorage:localStorage.length,sessionStorage:sessionStorage.length};
 });
 assert.equal(storage.exportable,false);assert.equal(storage.localStorage,0);assert.equal(storage.sessionStorage,0);assert.ok(!storage.rows.flat().some(k=>['snapshot','events','workflow','messages'].includes(k)));
 await page.getByRole('button',{name:'이 기기',exact:true}).click();await context.setOffline(true);
 await page.getByRole('button',{name:'이 기기 연결 해제',exact:true}).click();await page.getByRole('button',{name:'확인 · 연결 해제',exact:true}).click();await page.locator('#pairing').waitFor({state:'visible'});
 assert.equal(gateway.registry.get(d.id)?.status,'approved','offline peer cannot inform PC immediately');
 await context.setOffline(false);await page.reload();await page.getByRole('button',{name:'등록 요청',exact:true}).waitFor();
 for(let i=0;i<30 && gateway.registry.get(d.id)?.status!=='revoked';i++)await new Promise(r=>setTimeout(r,100));
 assert.equal(gateway.registry.get(d.id)?.status,'revoked','signed offline revocation syncs on next connection');
 // A fresh registration can be revoked from the PC; hidden work DOM and identity must disappear too.
 const next=await gateway.localHandlers()['remote.pair.create']();await page.goto(next.url);
 await page.getByLabel('이 기기 이름').fill('재등록 테스트');await page.getByRole('button',{name:'등록 요청',exact:true}).click();
 await page.getByText('작업 PC에서 이 기기를 승인해 주세요.',{exact:true}).waitFor();
 const second=gateway.registry.list().find(row=>row.status==='pending')!;gateway.registry.approve(second.id);
 await page.locator('#workspace').waitFor({state:'visible'});await page.locator('#workflow-body').filter({hasText:'REMOTE_OK 완료 보고'}).waitFor();
 await gateway.localHandlers()['remote.device.revoke']({deviceId:second.id});
 await page.locator('#pairing').waitFor({state:'visible'});
 assert.equal(await page.locator('#workflow-body').innerText(),'부장과 목표·완료 기준을 정리한 뒤 작업을 시작하세요.');
 assert.equal(await page.locator('#fingerprint').innerText(),'');assert.equal(await page.locator('#device-details').innerText(),'');
 await page.reload();await page.locator('#pairing').waitFor({state:'visible'});
 assert.equal(await page.getByRole('button',{name:'등록 요청',exact:true}).isEnabled(),true);
 assert.deepEqual(errors,[]);
});
