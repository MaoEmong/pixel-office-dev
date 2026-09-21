const fs=require('fs'),path=require('path'),os=require('os');
function isFile(p){try{return fs.statSync(p).isFile()}catch{return false}}
function onPath(exeName,pathVar){for(const dir of (pathVar??'').split(path.delimiter)){if(!dir)continue;const c=path.join(dir.replace(/^"|"$/g,''),exeName);if(isFile(c))return c}}
function cmpDesc(a,b){const pa=a.split('.').map(Number),pb=b.split('.').map(Number);for(let i=0;i<Math.max(pa.length,pb.length);i++){const d=(pb[i]??0)-(pa[i]??0);if(d!==0)return d}return 0}
exports.claudeExe=function(env=process.env){if(env.PIXEL_CLAUDE_EXE)return env.PIXEL_CLAUDE_EXE;
 const onP=onPath('claude.exe',env.PATH??env.Path);if(onP)return onP;
 const root=path.join(env.APPDATA||path.join(os.homedir(),'AppData','Roaming'),'Claude','claude-code');
 let e=[];try{e=fs.readdirSync(root)}catch{}
 for(const v of e.filter(n=>/^\d+(\.\d+)*$/.test(n)).sort(cmpDesc)){const exe=path.join(root,v,'claude.exe');if(isFile(exe))return exe}
 return 'claude';};
const SCOPE=['node_modules','@openai','codex','node_modules','@openai'];
function codexVendorExe(npmRoot,exeName){const scope=path.join(npmRoot,...SCOPE);let pkgs;try{pkgs=fs.readdirSync(scope).filter(n=>n.startsWith('codex-'))}catch{return}for(const pkg of pkgs.sort()){const vendor=path.join(scope,pkg,'vendor');let t;try{t=fs.readdirSync(vendor)}catch{continue}for(const target of t.sort()){const exe=path.join(vendor,target,'bin',exeName);if(isFile(exe))return exe}}}
exports.codexExe=function(env=process.env){if(env.PIXEL_CODEX_EXE)return env.PIXEL_CODEX_EXE;
 for(const root of [path.join(env.APPDATA,'npm'),path.join(env.LOCALAPPDATA,'npm'),path.join(env.ProgramFiles||'C:\Program Files','nodejs')]){const f=codexVendorExe(root,'codex.exe');if(f)return f}
 return onPath('codex.exe',env.PATH??env.Path)||'codex';};
