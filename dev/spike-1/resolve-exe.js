const fs=require('fs'),path=require('path'),os=require('os');
function isFile(p){try{return fs.statSync(p).isFile()}catch{return false}}
function onPath(exeName,pathVar){for(const dir of (pathVar??'').split(path.delimiter)){if(!dir)continue;const c=path.join(dir.replace(/^"|"$/g,''),exeName);if(isFile(c))return c}}
function cmpDesc(a,b){const pa=a.split('.').map(Number),pb=b.split('.').map(Number);for(let i=0;i<Math.max(pa.length,pb.length);i++){const d=(pb[i]??0)-(pa[i]??0);if(d!==0)return d}return 0}
function newestClaudeBundle(appData,exeName){const root=path.join(appData,'Claude','claude-code');let e;try{e=fs.readdirSync(root)}catch{return{root}}for(const v of e.filter(n=>/^\d+(\.\d+)*$/.test(n)).sort(cmpDesc)){const exe=path.join(root,v,exeName);if(isFile(exe))return{exe,root}}return{root}}
const env=process.env;
let claude=env.PIXEL_CLAUDE_EXE||onPath('claude.exe',env.PATH??env.Path);
const tried=[];
if(!claude){const ad=env.APPDATA||path.join(os.homedir(),'AppData','Roaming');const r=newestClaudeBundle(ad,'claude.exe');claude=r.exe;tried.push('bundle root '+r.root)}
const SCOPE=['node_modules','@openai','codex','node_modules','@openai'];
function codexVendorExe(npmRoot,exeName){const scope=path.join(npmRoot,...SCOPE);let pkgs;try{pkgs=fs.readdirSync(scope).filter(n=>n.startsWith('codex-'))}catch{return}for(const pkg of pkgs.sort()){const vendor=path.join(scope,pkg,'vendor');let t;try{t=fs.readdirSync(vendor)}catch{continue}for(const target of t.sort()){const exe=path.join(vendor,target,'bin',exeName);if(isFile(exe))return exe}}}
let codex=env.PIXEL_CODEX_EXE;
if(!codex){for(const root of [path.join(env.APPDATA,'npm'),path.join(env.LOCALAPPDATA,'npm'),path.join(env.ProgramFiles||'C:\Program Files','nodejs')]){const f=codexVendorExe(root,'codex.exe');if(f){codex=f;break}}}
if(!codex)codex=onPath('codex.exe',env.PATH??env.Path)||'codex';
console.log(JSON.stringify({claude,codex,tried},null,2));
