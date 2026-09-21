const fs=require('fs');
const file=process.argv[2];
const lines=fs.readFileSync(file,'utf8').split('\n').filter(Boolean);
const types={};const withUsage=[];
for(const l of lines){let o;try{o=JSON.parse(l)}catch{continue}
  types[o.type]=(types[o.type]||0)+1;
  const u=o.message&&o.message.usage;
  if(u)withUsage.push({ts:o.timestamp,model:o.message.model,uuid:(o.uuid||'').slice(0,8),isSidechain:o.isSidechain,usage:u});
}
console.log('LINES',lines.length,'TYPES',JSON.stringify(types));
console.log('--- top-level keys of first assistant line ---');
for(const l of lines){const o=JSON.parse(l);if(o.type==='assistant'){console.log(Object.keys(o).join(','));console.log('message keys:',Object.keys(o.message).join(','));break}}
console.log('--- first 2 usage ---');console.log(JSON.stringify(withUsage.slice(0,2),null,1));
console.log('--- last 3 usage ---');console.log(JSON.stringify(withUsage.slice(-3),null,1));
const sum=withUsage.reduce((a,x)=>{for(const k of ['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens'])a[k]=(a[k]||0)+(x.usage[k]||0);return a},{});
console.log('CUMULATIVE',JSON.stringify(sum));
const last=withUsage[withUsage.length-1].usage;
console.log('CONTEXT(last in+cc+cr)=',(last.input_tokens||0)+(last.cache_creation_input_tokens||0)+(last.cache_read_input_tokens||0));
// search for any line mentioning context window / limit
const hits=lines.filter(l=>/context_window|max_tokens|contextWindow|exceeds_200k/.test(l)).slice(0,3);
console.log('window mentions:',hits.length);hits.forEach(h=>console.log(h.slice(0,400)));
