import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {AuthenticationBridge} from '../../src/pty/authentication.js';
import {authenticationFailed} from '../../src/diagnostics/authFailure.js';
const claude=(name:string,expires=Date.now()+3600000)=>JSON.stringify({claudeAiOauth:{accessToken:name,refreshToken:`refresh-${name}`,expiresAt:expires}});
function fixture(t:import('node:test').TestContext){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'po-auth-test-'));
 const homes={claude:path.join(root,'global-claude'),codex:path.join(root,'global-codex')};
 const local=path.join(root,'member');fs.mkdirSync(homes.claude,{recursive:true});fs.mkdirSync(local);
 const bridge=new AuthenticationBridge(homes);t.after(()=>{bridge.unregister('m');bridge.unregister('n');fs.rmSync(root,{recursive:true,force:true});});
 return {homes,local,bridge,global:path.join(homes.claude,'.credentials.json'),file:path.join(local,'.credentials.json')};
}
test('valid terminal login replaces expired app credentials without touching histories',t=>{
 const f=fixture(t),valid=claude('terminal');fs.writeFileSync(f.global,valid);fs.writeFileSync(f.file,claude('old',0));fs.writeFileSync(path.join(f.local,'history.jsonl'),'history');
 f.bridge.sync('claude',f.local);assert.equal(fs.readFileSync(f.file,'utf8'),valid);assert.equal(fs.readFileSync(path.join(f.local,'history.jsonl'),'utf8'),'history');
});
test('terminal re-login and app refresh both reach other active sessions; invalid partial writes never propagate',t=>{
 const f=fixture(t),second=path.join(f.local,'second');fs.mkdirSync(second);
 fs.writeFileSync(f.global,claude('first'));f.bridge.register('m','claude',f.local);f.bridge.register('n','claude',second);
 const fresh=claude('new-terminal');fs.writeFileSync(f.global,fresh);f.bridge.tick();assert.equal(fs.readFileSync(f.file,'utf8'),fresh);
 const refreshed=claude('app-refresh',Date.now()+7200000);fs.writeFileSync(f.file,refreshed);f.bridge.tick();assert.equal(fs.readFileSync(f.global,'utf8'),refreshed);assert.equal(fs.readFileSync(path.join(second,'.credentials.json'),'utf8'),refreshed);
 fs.writeFileSync(f.file,'{"partial":');f.bridge.tick();assert.equal(fs.readFileSync(f.global,'utf8'),refreshed);
 fs.writeFileSync(f.file,claude('expired',0));f.bridge.tick();assert.equal(fs.readFileSync(f.global,'utf8'),refreshed);
});
test('newer local refresh survives startup and Codex login files also synchronize',t=>{
 const f=fixture(t),fresh=claude('new',Date.now()+7200000);fs.writeFileSync(f.global,claude('old'));fs.writeFileSync(f.file,fresh);f.bridge.sync('claude',f.local);assert.equal(fs.readFileSync(f.global,'utf8'),fresh);
 fs.mkdirSync(f.homes.codex);const jwt=`header.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.signature`;
 const auth=JSON.stringify({tokens:{access_token:jwt,refresh_token:'fake-test-only'}});fs.writeFileSync(path.join(f.homes.codex,'auth.json'),auth);
 f.bridge.sync('codex',f.local);assert.equal(fs.readFileSync(path.join(f.local,'auth.json'),'utf8'),auth);
 const terminal=claude('terminal-relogin');fs.writeFileSync(f.global,terminal);fs.writeFileSync(f.file,claude('rejected-local',Date.now()+99999999));
 f.bridge.sync('claude',f.local,true);assert.equal(fs.readFileSync(f.file,'utf8'),terminal);assert.equal(fs.readFileSync(f.global,'utf8'),terminal);
});
test('actual login expiry, split ANSI output and 401 errors match; ordinary discussion does not',()=>{
 assert.ok(authenticationFailed('\x1b[31m● Login expired · Please run /login\x1b[0m'));
 assert.ok(authenticationFailed('Error: Your access token could not be refreshed'));
 assert.ok(authenticationFailed('■ {"status":401,"error":{"message":"unauthorized"}}'));
 assert.ok(!authenticationFailed('로그인 오류가 나면 Login expired · Please run /login이라고 표시합니다.'));
 assert.ok(!authenticationFailed('● Login successful'));
});
