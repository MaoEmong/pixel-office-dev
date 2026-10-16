import {probeClaudeConnection,probeCodexConnection,commandRunner,type ProbeOptions} from '../usage/connection.js';
import type {EngineConnection} from '../usage/types.js';
import type {Engine} from '../store/types.js';
import {OfficeError,RPC_ERROR} from '../office/errors.js';
import fs from 'node:fs';import path from 'node:path';
import {projectMemberDir} from '../pty/projectSessions.js';
import type {Member} from '../store/types.js';
import {authenticationBridge} from '../pty/authentication.js';
import {resolveCodexExe} from '../config.js';

export interface ExecutionCheck {ok:boolean;checked:boolean;reason?:'permissions'|'timeout'|'unavailable'|'unprepared'|'failed';message:string}
export type ExecutionProbe=(member:Member)=>Promise<ExecutionCheck>;
const EXECUTION_MARKER='PIXEL_OFFICE_EXECUTION_OK';
export const EXECUTION_CHECK_TIMEOUT_MS=5_000;

/** A local, fixed no-op checks the real member home without asking a model or running project commands. */
export async function probeCodexExecution(member:Member,opts:ProbeOptions={}):Promise<ExecutionCheck>{
 if(member.engine!=='codex'||(opts.platform??process.platform)!=='win32')return {ok:true,checked:false,message:'이 환경에서는 Windows 명령 실행 점검이 필요하지 않습니다.'};
 const home=path.join(projectMemberDir(member.cwd,member.id),'codex');
 if(!fs.existsSync(member.cwd)||!fs.existsSync(home))return {ok:false,checked:true,reason:'unprepared',message:'작업 폴더 또는 AI 세션 폴더를 찾지 못했습니다. 폴더 위치를 확인하고 해당 멤버를 다시 시작한 뒤 검사하세요.'};
 const env={CODEX_HOME:home,CODEX_SQLITE_HOME:home};
 const run=opts.run??commandRunner(env);
 const args=['-c','features.prefer_mxc=true','-c','sandbox_mode="workspace-write"','sandbox','--include-managed-config','--permission-profile',':workspace','-C',member.cwd,'--','cmd.exe','/d','/c','echo',EXECUTION_MARKER];
 for(let attempt=0;attempt<2;attempt++){
  const result=await run(resolveCodexExe(opts.env??process.env,opts.platform??process.platform),args,opts.timeoutMs??EXECUTION_CHECK_TIMEOUT_MS);
  if(result.timedOut){
   if(attempt===0)continue; // Only the fixed no-op is retried; never a user's command.
   return {ok:false,checked:true,reason:'timeout',message:'Codex의 명령 실행 준비가 두 차례 모두 응답하지 않았습니다. 잠시 뒤 환경 점검에서 선택 멤버를 다시 검사하세요.'};
  }
  if(result.exitCode===0&&result.stdout.split(/\r?\n/).some(line=>line.trim()===EXECUTION_MARKER))return {ok:true,checked:true,message:'실제 명령 실행 확인됨'};
  if(result.errorCode==='ENOENT'||result.errorCode==='ENOTDIR')return {ok:false,checked:true,reason:'unavailable',message:engineRepair('codex','not-installed')};
  const output=`${result.stderr}\n${result.stdout}`.slice(0,16000);
  if(/unexpected argument|unrecognized (?:option|subcommand)|unknown (?:option|subcommand)/i.test(output))return {ok:false,checked:true,reason:'unavailable',message:'현재 Codex 버전이 앱의 명령 실행 점검 방식을 지원하지 않습니다. Codex CLI를 업데이트한 뒤 해당 멤버를 다시 시작하고 검사하세요.'};
  if(/sandbox directory ACL|helper_sandbox_lock_failed|NtCreateFile|access (?:is )?denied|액세스가 거부/i.test(output))return {ok:false,checked:true,reason:'permissions',message:'Codex가 Windows 실행 권한을 준비하지 못했습니다. 로그인이 되어 있어도 명령을 실행할 수 없는 상태입니다. 해당 멤버를 다시 시작하고 환경 점검의 선택 멤버 검사로 확인하세요. 같은 오류가 계속되면 Codex의 Windows 실행 환경 설정을 복구해야 합니다.'};
  return {ok:false,checked:true,reason:'failed',message:'Codex의 명령 실행 확인에 실패했습니다. 환경 점검에서 선택 멤버를 다시 검사하세요. 계속 실패하면 해당 멤버의 터미널에서 Windows 실행 환경 안내를 확인하세요.'};
 }
 throw new Error('unreachable execution check');
}

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
 private readonly executionChecks=new Map<string,Promise<ExecutionCheck>>();
 constructor(private probe:ConnectionProbe=defaultProbe,private executionProbe:ExecutionProbe=probeCodexExecution){}
 private execution(member:Member):Promise<ExecutionCheck>{
  const key=JSON.stringify([member.id,member.cwd,member.engine]);
  const pending=this.executionChecks.get(key);if(pending)return pending;
  const check=Promise.resolve().then(()=>this.executionProbe(member)).catch(()=>({ok:false,checked:true,reason:'failed' as const,message:'명령 실행 상태를 확인하지 못했습니다. 환경 점검에서 선택 멤버를 다시 검사하세요.'})).finally(()=>this.executionChecks.delete(key));
  this.executionChecks.set(key,check);return check;
 }
 async requireExecution(member:Member):Promise<void>{
  if(member.engine!=='codex')return;
  const result=await this.execution(member);
  if(!result.ok)throw new OfficeError(RPC_ERROR.BAD_STATE,`${member.name}: 작업 시작 전 점검에 실패했습니다.\n${result.message}\n업무는 보내지 않았으며 기존 계획과 기록은 유지됩니다.`,{reason:'execution-unavailable',executionReason:result.reason,memberId:member.id});
 }
 async check(member?:Member){
  const engines=await Promise.all((member?[member.engine]:['claude','codex'] as const).map(async engine=>{
   const connection=await this.probe(engine,memberEnvironment(member)).catch(()=>({connected:false,plan:null,reason:'unknown'} as EngineConnection));
   const execution=member&&engine==='codex'&&connection.connected ? await this.execution(member) : undefined;
   return {engine,...connection,...(execution?{execution}:{}),message:execution?.checked ? `설치·로그인 확인됨\n${execution.message}` : connection.connected?'설치·로그인 확인됨':member&&connection.reason==='logged-out'?sessionRepair(member):engineRepair(engine,connection.reason)};
  }));
  return {checkedAt:new Date().toISOString(),nodeVersion:process.versions.node,memberName:member?.name,engines};
 }
 async require(engine:Engine,member?:Member){
  const c=await this.probe(engine,memberEnvironment(member)).catch(()=>({connected:false,plan:null,reason:'unknown'} as EngineConnection));
  // Unknown output may be a newer CLI format; never falsely block a logged-in user.
  if(!c.connected && (c.reason==='not-installed'||c.reason==='logged-out'))throw new OfficeError(RPC_ERROR.BAD_STATE,member&&c.reason==='logged-out'?sessionRepair(member):engineRepair(engine,c.reason),{reason:c.reason,engine});
 }
}
