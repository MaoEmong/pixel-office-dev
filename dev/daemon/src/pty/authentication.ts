import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {Engine} from './types.js';

export const authenticationHomes = () => ({claude:path.join(os.homedir(),'.claude'),codex:process.env.CODEX_HOME || path.join(os.homedir(),'.codex')});
const fileName = (engine:Engine) => engine==='claude' ? '.credentials.json' : 'auth.json';
type Credential = {text:string; expires:number; modified:number};
function read(file:string,engine:Engine):Credential|undefined {
  try {
    const text=fs.readFileSync(file,'utf8'),json=JSON.parse(text);
    let expires:number;
    if(engine==='claude') {
      if(typeof json.claudeAiOauth?.accessToken!=='string')return;
      expires=Number(json.claudeAiOauth.expiresAt);
    } else {
      if(json.OPENAI_API_KEY)expires=Number.MAX_SAFE_INTEGER;
      else {
        const token=json.tokens?.access_token;
        if(typeof token!=='string')return;
        try {expires=Number(JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).exp)*1000;}
        catch {return;}
      }
    }
    if(!Number.isFinite(expires) || expires<=Date.now())return;
    return {text,expires,modified:fs.statSync(file).mtimeMs};
  } catch {return;}
}
function write(file:string,text:string):void {
  if(fs.existsSync(file) && fs.readFileSync(file,'utf8')===text)return;
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  // Credentials never appear in logs, events or RPC responses.
  const temp=`${file}.pixel-office-${process.pid}.tmp`;
  try {fs.writeFileSync(temp,text,{mode:0o600});fs.renameSync(temp,file);}
  finally {if(fs.existsSync(temp))fs.unlinkSync(temp);}
}

/** Share only login files. Settings, histories, hooks and projects stay separate. */
export class AuthenticationBridge {
  onFailure?:(message:string)=>void;
  private failed=new Set<Engine>();
  private entries=new Map<string,{engine:Engine;file:string}>();
  private observed=new Map<string,string>();
  private timer?:NodeJS.Timeout;
  constructor(private homes=authenticationHomes(),private onError:(message:string)=>void=()=>{}){}
  sync(engine:Engine,localHome:string,preferTerminal=false):void {
    const global=path.join(this.homes[engine],fileName(engine)),local=path.join(localHome,fileName(engine));
    const shared=read(global,engine),project=read(local,engine);
    // Prefer a current terminal login; retain a newer app-side refresh.
    const best=shared && (preferTerminal || !project || shared.expires>=project.expires) ? shared : project;
    if(best) {
      write(local,best.text);
      if(best===project)write(global,best.text);
    }
  }
  register(id:string,engine:Engine,localHome:string):void {
    this.sync(engine,localHome);
    this.entries.set(id,{engine,file:path.join(localHome,fileName(engine))});
    this.tick();
    this.timer ??= setInterval(()=>this.tick(),1000);
    this.timer.unref();
  }
  unregister(id:string):void {
    this.entries.delete(id);
    if(!this.entries.size){clearInterval(this.timer);this.timer=undefined;this.observed.clear();}
  }
  private files(engine:Engine):string[] {return [...new Set([path.join(this.homes[engine],fileName(engine)),...Array.from(this.entries.values()).filter(e=>e.engine===engine).map(e=>e.file)])];}
  private remember(engine:Engine):void {for(const file of this.files(engine)){const c=read(file,engine);if(c)this.observed.set(file,c.text);}}
  tick():void {
    for(const engine of ['claude','codex'] as const)try {
      const files=this.files(engine);
      if(!Array.from(this.entries.values()).some(e=>e.engine===engine))continue;
      const changed=files.map(file=>({file,value:read(file,engine)})).filter(({file,value})=>value && value.text!==this.observed.get(file));
      // A fresh terminal login wins over simultaneous refreshes in old sessions.
      const winner=changed.find(c=>c.file===files[0]) ?? changed.sort((a,b)=>b.value!.expires-a.value!.expires || b.value!.modified-a.value!.modified)[0];
      if(winner?.value)for(const file of files)write(file,winner.value.text);
      this.remember(engine);
      this.failed.delete(engine);
    } catch {
      if(this.failed.has(engine))continue;
      this.failed.add(engine);
      const message=`${engine==='claude'?'Claude':'Codex'} 로그인 정보를 동기화하지 못했습니다. 파일 권한을 확인하고 로그인 연결을 다시 시도하세요.`;
      this.onError(message);this.onFailure?.(message);
    }
  }
}

export const authenticationBridge=new AuthenticationBridge(undefined,message=>console.warn(`[authentication] ${message}`));
