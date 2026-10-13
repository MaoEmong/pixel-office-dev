import {randomBytes, randomUUID, createHash, createPublicKey, verify, type KeyObject} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export interface Device {id:string;name:string;publicKey:string;fingerprint:string;status:'pending'|'approved'|'revoked';createdAt:number;lastSeenAt?:number;}
export const revokeMessage=(pc:string,id:string)=>`pixel-office revoke v1\n${pc}\n${id}`;
export const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function publicKey(value:string):KeyObject {
  if (typeof value!=='string' || value.length>400) throw new Error('잘못된 공개키입니다.');
  const key=createPublicKey({key:Buffer.from(value,'base64'),type:'spki',format:'der'});
  if(key.export({type:'spki',format:'der'}).toString('base64')!==value)throw new Error('공개키 인코딩이 잘못되었습니다.');
  if (key.asymmetricKeyType!=='ec' || key.asymmetricKeyDetails?.namedCurve!=='prime256v1') throw new Error('P-256 공개키가 필요합니다.');
  return key;
}
export function validProof(key:string,message:string,signature:string):boolean {
  try {return typeof signature==='string' && signature.length<=180 && verify('sha256',Buffer.from(message),{key:publicKey(key),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64'));}
  catch {return false;}
}

export class DeviceRegistry {
  private db:DatabaseSync;
  private invitations=new Map<string,{expires:number}>();
  readonly workstationId:string;
  constructor(file:string,private now=()=>Date.now()) {
    if (file!==':memory:') fs.mkdirSync(path.dirname(file),{recursive:true});
    this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mutations(device TEXT NOT NULL,request TEXT NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(device,request));`);
    this.workstationId=this.getMeta('workstationId') ?? randomUUID();
    this.setMeta('workstationId',this.workstationId);
  }
  close(){this.db.close();}
  getMeta(key:string):string|undefined {return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value:string}|undefined)?.value;}
  setMeta(key:string,value:string){this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  list():Device[]{return this.db.prepare('SELECT payload FROM devices ORDER BY rowid DESC').all().map(r=>JSON.parse(r.payload as string) as Device);}
  get(id:string):Device|undefined {const r=this.db.prepare('SELECT payload FROM devices WHERE id=?').get(id);return r ? JSON.parse(r.payload as string) : undefined;}
  private save(d:Device){this.db.prepare('INSERT INTO devices VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(d.id,JSON.stringify(d));return d;}
  invite(){
    const time=this.now();for(const [key,value] of this.invitations) if(value.expires<=time)this.invitations.delete(key);
    if(this.invitations.size>=10)throw new Error('열린 연결 키가 너무 많습니다. 만료 후 다시 발급하세요.');
    const code=randomBytes(32).toString('hex'),expiresAt=time+5*60_000;
    this.invitations.set(hash(code),{expires:expiresAt});return {code,expiresAt};
  }
  request(code:string,name:string,spki:string,signature:string):Device {
    const key=hash(code),invite=this.invitations.get(key);
    if(!invite || invite.expires<=this.now())throw new Error('연결 키가 틀렸거나 만료되었습니다.');
    if(typeof name!=='string' || !name.trim() || name.length>80)throw new Error('기기 이름은 1~80자여야 합니다.');
    publicKey(spki);
    if(!validProof(spki,`pixel-office pair v1\n${this.workstationId}\n${code}\n${name.trim()}`,signature))throw new Error('기기 서명을 확인할 수 없습니다.');
    const fingerprint=hash(spki);
    if(this.list().some(d=>d.fingerprint===fingerprint))throw new Error('이미 등록했거나 해제한 키입니다. 새 기기 키를 만드세요.');
    if(this.list().filter(d=>d.status==='pending').length>=10)throw new Error('승인을 기다리는 기기가 너무 많습니다.');
    this.invitations.delete(key);
    return this.save({id:randomUUID(),name:name.trim(),publicKey:spki,fingerprint,status:'pending',createdAt:this.now()});
  }
  approve(id:string){const d=this.get(id);if(d?.status!=='pending')throw new Error('승인 대기 중인 기기가 아닙니다.');return this.save({...d,status:'approved'});}
  revoke(id:string){const d=this.get(id);if(!d)throw new Error('기기를 찾을 수 없습니다.');return this.save({...d,status:'revoked'});}
  touch(id:string){const d=this.get(id);if(d?.status==='approved')this.save({...d,lastSeenAt:this.now()});}
  remembered(device:string,request:string){const r=this.db.prepare('SELECT payload FROM mutations WHERE device=? AND request=?').get(device,request);return r ? JSON.parse(r.payload as string) : undefined;}
  remember(device:string,request:string,result:unknown){
    this.db.prepare('INSERT OR REPLACE INTO mutations VALUES(?,?,?,?)').run(device,request,JSON.stringify(result),this.now());
    this.db.prepare('DELETE FROM mutations WHERE created < ?').run(this.now()-7*86400_000);
  }
}
