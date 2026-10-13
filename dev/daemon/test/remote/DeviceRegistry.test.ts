import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DeviceRegistry,validProof,revokeMessage} from '../../src/remote/DeviceRegistry.js';
const keys=()=>{const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});return {spki:publicKey.export({format:'der',type:'spki'}).toString('base64'),proof:(m:string)=>sign('sha256',Buffer.from(m),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')};};
test('single-use expiring invitation, ownership proof, durable approval, revocation and request deduplication',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'device-registry-'));
 let now=1000;const file=path.join(dir,'devices.db');let r=new DeviceRegistry(file,()=>now);const pc=r.workstationId,k=keys();
 const expired=r.invite();now+=300001;assert.throws(()=>r.request(expired.code,'phone',k.spki,'bad'),/만료/);
 const i=r.invite(),message=`pixel-office pair v1\n${pc}\n${i.code}\nphone`;
 assert.throws(()=>r.request(i.code,'phone',k.spki,'bad'),/서명/);
 const d=r.request(i.code,'phone',k.spki,k.proof(message));assert.equal(d.status,'pending');
 assert.throws(()=>r.request(i.code,'phone',k.spki,k.proof(message)),/만료/);r.approve(d.id);
 r.remember(d.id,'request-id',{result:42});r.close();r=new DeviceRegistry(file);t.after(()=>{r.close();fs.rmSync(dir,{recursive:true,force:true});});
 assert.equal(r.workstationId,pc);assert.equal(r.get(d.id)?.status,'approved');assert.deepEqual(r.remembered(d.id,'request-id'),{result:42});
 assert.ok(validProof(k.spki,revokeMessage(pc,d.id),k.proof(revokeMessage(pc,d.id))));
 assert.equal(r.revoke(d.id).status,'revoked');assert.throws(()=>r.approve(d.id),/승인 대기/);
});
