import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveCodexExe} from '../config.js';
import {stripDaemonEnv} from '../pty/env.js';

export interface CodexModel { model:string; isDefault?:boolean }

/** Ask the installed CLI for this account's catalog. Does not run a model turn. */
export function listCodexModels():Promise<CodexModel[]> {
  return new Promise((resolve,reject)=>{
    const child=spawn(resolveCodexExe(),['app-server'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:stripDaemonEnv(process.env)});
    let buffer='',settled=false;
    const finish=(error?:Error,models?:CodexModel[])=>{
      if(settled)return;settled=true;clearTimeout(timer);child.stdin.destroy();child.kill();
      if(error)reject(error);else resolve(models!);
    };
    const timer=setTimeout(()=>finish(new Error('Codex의 사용 가능한 모델 목록을 확인하지 못했습니다. 로그인·인터넷 연결을 확인하고 다시 시도하세요.')),10_000);
    child.on('error',()=>finish(new Error('Codex를 실행하지 못했습니다. 설치 상태를 확인하세요.')));
    child.on('exit',()=>{if(!settled)finish(new Error('Codex 모델 목록 확인이 중단됐습니다. 로그인 상태를 확인하세요.'));});
    child.stdin.on('error',()=>{});
    child.stderr.on('data',()=>{});
    child.stdout.on('data',chunk=>{
      buffer+=String(chunk);
      if(buffer.length>1024*1024)return finish(new Error('Codex 모델 목록 응답이 너무 큽니다.'));
      for(let end;(end=buffer.indexOf('\n'))>=0;){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        let message:any;try{message=JSON.parse(line);}catch{continue;}
        if(message.id===1){
          if(message.error)return finish(new Error('Codex 모델 확인을 시작하지 못했습니다.'));
          child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
          child.stdin.write(JSON.stringify({id:2,method:'model/list',params:{includeHidden:false}})+'\n');
        }
        if(message.id===2){
          if(message.error || !Array.isArray(message.result?.data))return finish(new Error('Codex 모델 목록을 읽지 못했습니다.'));
          const models=message.result.data.filter((m:any)=>typeof m.model==='string' && m.model.trim()).map((m:any)=>({model:m.model,isDefault:m.isDefault===true}));
          if(!models.length)return finish(new Error('현재 계정에서 사용할 수 있는 Codex 모델이 없습니다.'));
          finish(undefined,models);
        }
      }
    });
    child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'pixel-office-model-check',version:'1'}}})+'\n');
  });
}

export function chooseCodexModel(models:CodexModel[],preferred?:string):string {
  const choice=models.find(m=>m.model===preferred) ?? models.find(m=>m.isDefault) ?? models[0];
  if(!choice)throw new Error('현재 계정에서 사용할 수 있는 Codex 모델이 없습니다.');
  return choice.model;
}

export function preferredCodexModel():string|undefined {
  if(process.env.PIXEL_CODEX_MODEL)return process.env.PIXEL_CODEX_MODEL;
  try{
    const file=fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),'config.toml'),'utf8');
    return /^\s*model\s*=\s*["']([^"']+)["']/m.exec(file.split(/^\s*\[/m)[0]!)?.[1];
  }catch{return undefined;}
}

export class CodexModelGuard {
  private model?:string;
  private pending?:Promise<string>;
  constructor(private list= listCodexModels,private preferred=preferredCodexModel){}
  async prepare():Promise<string>{
    if(this.model)return this.model;
    this.pending ??= this.list().then(models=>this.model=chooseCodexModel(models,this.preferred())).finally(()=>{this.pending=undefined;});
    return this.pending;
  }
  selected():string {
    if(!this.model)throw new Error('Codex의 사용 가능한 모델을 확인하지 못했습니다. 로그인·인터넷 연결을 확인한 뒤 다시 시도하세요.');
    return this.model;
  }
}

/** Only recognize a rendered API error, not a model name in ordinary conversation. */
export function isUnsupportedCodexModel(text:string):boolean {
  return /^\s*■\s*\{\s*"type"\s*:\s*"error"/m.test(text)
    && /"status"\s*:\s*400/.test(text)
    && /model\s+is\s+not\s+supported\s+when\s+using\s+Codex\s+with\s+a\s+ChatGPT\s+account/i.test(text);
}
