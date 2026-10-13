import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {appendLog,writeJson,storageFailures} from '../../src/storage/files.js';
import {fileSink} from '../../src/log.js';
import {Store} from '../../src/store/Store.js';

test('bounded log rotation and recovery after a temporary write failure',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'office-log-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'bounded.log');for(let i=0;i<20;i++)appendLog(file,`line ${i}\n`,20,3);
 assert.ok(fs.statSync(file).size<=20);assert.equal(fs.readdirSync(root).length,4);assert.match(fs.readFileSync(file,'utf8'),/line 19/);
 let clock=0;const unavailable=path.join(root,'missing','log');const sink=fileSink(unavailable,()=>clock);
 sink(['failed']);assert.ok(storageFailures().some(f=>f.file===unavailable));
 fs.mkdirSync(path.dirname(unavailable));clock=30001;sink(['recovered']);assert.equal(fs.readFileSync(unavailable,'utf8'),'recovered\n');assert.ok(!storageFailures().some(f=>f.file===unavailable));
});

test('failed JSON replacement preserves the previous complete file',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'office-json-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'data.json');writeJson(file,{old:true});const original=fs.writeFileSync;
 try{fs.writeFileSync=((file,...args)=>{if(String(file).endsWith('.tmp'))throw new Error('disk full');return original(file,...args);}) as typeof fs.writeFileSync;
 assert.throws(()=>writeJson(file,{old:false}),/disk full/);}finally{fs.writeFileSync=original;}
 assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{old:true});assert.deepEqual(fs.readdirSync(root),['data.json']);
});

test('SQLite backup includes committed WAL state and receipts survive reopen',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'office-backup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'office.db');const store=new Store(file);store.createDepartment({name:'saved',cwd:root});store.reserveRequest('request','hash');store.finishRequest('request',{result:{id:1}});
 const backup=store.backup(true)!;const copy=new DatabaseSync(backup);assert.equal(copy.prepare('SELECT name FROM departments').get()?.name,'saved');copy.close();store.close();
 const reopened=new Store(file);assert.deepEqual(reopened.requestRecord('request'),{hash:'hash',reply:{result:{id:1}}});reopened.close();
});

test('retention expires old RPC receipts but preserves reports referenced by an active plan',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const department=store.createDepartment({name:'retention',cwd:process.cwd()});
 const kept=store.createTask({departmentId:department.id,fromMember:'user',toMember:'lead',instruction:'kept',status:'reported'});
 store.createTask({departmentId:department.id,fromMember:'user',toMember:'lead',instruction:'old',status:'reported'});
 store.saveWorkflow({id:'w_active',departmentId:department.id,phase:'executing',brief:'active',messages:[],assignments:[{leadId:'lead',task:'kept',acceptance:['done'],taskId:kept.id,status:'done'}],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
 assert.equal(store.pruneTasks(1,Date.now()+2*86400000),1);assert.ok(store.getTask(kept.id));
 store.reserveRequest('old','hash');store.finishRequest('old',{result:{}});store.pruneRetention({now:Date.now()+91*86400000});assert.equal(store.requestRecord('old'),undefined);assert.ok(store.getTask(kept.id));
});
