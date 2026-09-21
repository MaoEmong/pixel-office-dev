// /status 를 "턴 이전"에 열었을 때 한도가 보이는지(hook 검토 패널에 가로채이지 않게 bypass 플래그 사용)
const pty=require('node-pty'),fs=require('fs'),path=require('path');
const {Terminal}=require('@xterm/headless');
const OUT=path.join(__dirname,'out');
const CODEX=require('./resolve-exe-lib').codexExe();
const SANDBOX=path.resolve(path.join(__dirname,'..','spike-0','sandbox'));
const log=(...a)=>console.log(new Date().toISOString().slice(11,23),...a);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const CR='\r',ESC='\x1b';
const term=new Terminal({cols:120,rows:40,allowProposedApi:true,scrollback:5000});
const full=()=>{const b=term.buffer.active,L=[];for(let i=0;i<b.length;i++)L.push(b.getLine(i)?.translateToString(true)??'');while(L.length&&!L[L.length-1].trim())L.pop();return L.join('\n')};
const env={};for(const[k,v]of Object.entries(process.env))if(!/^CLAUDE_?CODE|^CLAUDECODE|^CLAUDE_CONFIG_DIR$/i.test(k))env[k]=v;env.TERM='xterm-256color';
const trust='projects."'+SANDBOX.replace(/\\/g,'\\\\')+'".trust_level="trusted"';
const p=pty.spawn(CODEX,['--dangerously-bypass-hook-trust','-c','approval_policy="on-request"','-c','sandbox_mode="workspace-write"','-c',trust],{name:'xterm-256color',cols:120,rows:40,cwd:SANDBOX,env});
let raw=0;p.onData(d=>{raw+=d.length;term.write(d)});p.onExit(e=>log('EXIT',JSON.stringify(e)));
async function settle(max=20000){const t0=Date.now();let last=-1,st=0;while(Date.now()-t0<max){await sleep(250);if(raw===last){st++;if(st>=6)break}else{st=0;last=raw}}return Date.now()-t0}
(async()=>{
 for(let k=0;k<40;k++){await sleep(1500);log('poll',k,'raw',raw);const sc=full();if(/trust the contents|Yes, continue/i.test(sc)){p.write(CR);continue}if(/Ask Codex to do anything/i.test(sc))break}
 const t0=Date.now();p.write('/status');await sleep(700);p.write(CR);await settle(20000);
 log('status-before-any-turn ms=',Date.now()-t0);
 fs.writeFileSync(path.join(OUT,'codex-full-05-status-fresh.txt'),full());
 console.log(full());
 try{p.kill()}catch{}
 setTimeout(()=>process.exit(0),1200);
})();
setTimeout(()=>{try{p.kill()}catch{};process.exit(0)},180000);
