import {test} from 'node:test';import assert from 'node:assert/strict';
import {EnvironmentDiagnostics} from '../../src/diagnostics/environment.js';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import type {Member} from '../../src/store/types.js';
test('known missing/logged-out engines block without executing; unknown does not falsely block; retry observes repaired auth',async()=>{
 let reason:'not-installed'|'logged-out'|'unknown'|null='not-installed';
 const d=new EnvironmentDiagnostics(async()=>({connected:reason===null,plan:null,reason}));
 await assert.rejects(d.require('claude'),/CLI를 설치/);
 reason='logged-out';await assert.rejects(d.require('codex'),/codex login/);
 const report=await d.check();assert.equal(report.engines.length,2);assert.ok(report.engines.every(e=>e.reason==='logged-out'));
 reason='unknown';await d.require('claude');assert.match((await d.check()).engines[0]!.message,/단정하지/);
 reason=null;await d.require('codex');assert.equal((await d.check()).engines[1]!.connected,true);
});
test('probe failure is unknown and does not expose raw command output',async()=>{
 const d=new EnvironmentDiagnostics(async()=>{throw Error('secret stdout');});
 await d.require('claude');const r=await d.check();assert.equal(r.engines[0]!.reason,'unknown');assert.ok(!JSON.stringify(r).includes('secret'));
});
test('existing project home is probed instead of global login, with a scoped repair command',async t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'office-auth-'));
 t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 const home=path.join(cwd,'.pixel-office','sessions','m','claude');fs.mkdirSync(home,{recursive:true});
 const m={id:'m',cwd,engine:'claude',name:'부장'} as Member;
 const d=new EnvironmentDiagnostics(async(_engine,env)=>{assert.equal(env?.CLAUDE_CONFIG_DIR,home);return {connected:false,plan:null,reason:'logged-out'};});
 await assert.rejects(d.require('claude',m),/프로젝트 세션 인증/);
 assert.ok((await d.check(m)).engines[0]!.message.includes(home));
});
