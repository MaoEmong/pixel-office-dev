const fs=require('fs'),path=require('path'),os=require('os');
const root=path.join(os.homedir(),'.codex','sessions');
function walk(d,out=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p,out);else if(/^rollout-.*\.jsonl$/.test(e.name))out.push(p)}return out}
const files=walk(root).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs).slice(0,12);
for(const f of files){
  const lines=fs.readFileSync(f,'utf8').split('\n').filter(Boolean);
  const tc=[],tur=[];
  let meta=null;
  for(const l of lines){let o;try{o=JSON.parse(l)}catch{continue}
    if(o.type==='session_meta')meta=o.payload;
    if(o.type==='event_msg'&&o.payload&&o.payload.type==='token_count')tc.push(o);
    if(o.type==='token_usage_record')tur.push(o);
  }
  console.log('###',path.basename(f),'lines',lines.length,'token_count',tc.length,'token_usage_record',tur.length,'| id',meta&&meta.session_id,'| cli',meta&&meta.cli_version,'| src',meta&&meta.source);
  if(tc.length){
    const last=tc[tc.length-1].payload;
    console.log('   last rate_limits:',JSON.stringify(last.rate_limits));
    console.log('   last info:',JSON.stringify(last.info));
    console.log('   timestamps:',tc.map(x=>x.timestamp.slice(11,19)).join(','));
  }
  if(tur.length){console.log('   token_usage_record[0]:',JSON.stringify(tur[0]).slice(0,800));}
}
