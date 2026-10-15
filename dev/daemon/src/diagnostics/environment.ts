import {probeClaudeConnection,probeCodexConnection} from '../usage/connection.js';
import type {EngineConnection} from '../usage/types.js';
import type {Engine} from '../store/types.js';
import {OfficeError,RPC_ERROR} from '../office/errors.js';
import fs from 'node:fs';import path from 'node:path';
import {projectMemberDir} from '../pty/projectSessions.js';
import type {Member} from '../store/types.js';
import {authenticationBridge} from '../pty/authentication.js';

export type ConnectionProbe=(engine:Engine,sessionEnv?:Record<string,string>)=>Promise<EngineConnection>;
const defaultProbe:ConnectionProbe=(engine,sessionEnv)=>engine==='claude'?probeClaudeConnection({sessionEnv}):probeCodexConnection({sessionEnv});
function memberEnvironment(member?:Pick<Member,'cwd'|'id'|'engine'>):Record<string,string>|undefined{
 if(!member)return undefined;
 const home=path.join(projectMemberDir(member.cwd,member.id),member.engine);
 if(!fs.existsSync(home))return undefined; // New members initialize their home at spawn.
 authenticationBridge.sync(member.engine,home);
 return member.engine==='claude'?{CLAUDE_CONFIG_DIR:home}:{CODEX_HOME:home,CODEX_SQLITE_HOME:home};
}
function sessionRepair(member:Pick<Member,'cwd'|'id'|'engine'>){
 const variable=member.engine==='claude'?'CLAUDE_CONFIG_DIR':'CODEX_HOME',home=path.join(projectMemberDir(member.cwd,member.id),member.engine);
 const prefix=process.platform==='win32'?`$env:${variable}='${home.replaceAll("'","''")}';`:`${variable}='${home.replaceAll("'","'\\''")}'`;
 return `프로젝트 세션 인증을 확인하세요. 새 터미널에서 실행: ${prefix} ${member.engine==='claude'?'claude auth login':'codex login'}`;
}
export function engineRepair(engine:Engine,reason:EngineConnection['reason']):string {
 const name=engine==='claude'?'Claude Code':'Codex';
 if(reason==='not-installed')return `${name} 실행 파일을 찾지 못했습니다. CLI를 설치하고 PATH 또는 PIXEL_${engine.toUpperCase()}_EXE를 확인한 뒤 앱을 다시 열어 주세요.`;
 if(reason==='logged-out')return `${name} 로그인이 필요합니다. 터미널에서 ${engine==='claude'?'claude auth login':'codex login'}을 실행한 뒤 환경 점검에서 다시 검사하세요.`;
 return `${name} 인증 상태를 확인하지 못했습니다. 인터넷 연결·CLI 버전·실행 권한을 확인하세요. 확인 실패를 로그아웃으로 단정하지 않습니다.`;
}
export class EnvironmentDiagnostics {
 constructor(private probe:ConnectionProbe=defaultProbe){}
 async check(member?:Member){
  const engines=await Promise.all((member?[member.engine]:['claude','codex'] as const).map(async engine=>{
   const connection=await this.probe(engine,memberEnvironment(member)).catch(()=>({connected:false,plan:null,reason:'unknown'} as EngineConnection));
   return {engine,...connection,message:connection.connected?'설치·로그인 확인됨':member&&connection.reason==='logged-out'?sessionRepair(member):engineRepair(engine,connection.reason)};
  }));
  return {checkedAt:new Date().toISOString(),nodeVersion:process.versions.node,memberName:member?.name,engines};
 }
 async require(engine:Engine,member?:Member){
  const c=await this.probe(engine,memberEnvironment(member)).catch(()=>({connected:false,plan:null,reason:'unknown'} as EngineConnection));
  // Unknown output may be a newer CLI format; never falsely block a logged-in user.
  if(!c.connected && (c.reason==='not-installed'||c.reason==='logged-out'))throw new OfficeError(RPC_ERROR.BAD_STATE,member&&c.reason==='logged-out'?sessionRepair(member):engineRepair(engine,c.reason),{reason:c.reason,engine});
 }
}
