const fs=require('fs'),path=require('path'),os=require('os');
const file=process.argv[2];
const lines=fs.readFileSync(file,'utf8').split('\n').filter(Boolean);
const types={};
let tokenEvents=[];
for(const l of lines){let o;try{o=JSON.parse(l)}catch{continue}
  const t=o.type+(o.payload&&o.payload.type?'/'+o.payload.type:'');
  types[t]=(types[t]||0)+1;
  if(/token_count/.test(t))tokenEvents.push(o);
}
console.log('FILE',file);
console.log('LINES',lines.length);
console.log('TYPES',JSON.stringify(types,null,1));
console.log('--- first line ---');console.log(lines[0].slice(0,2000));
if(tokenEvents.length){
console.log('--- token_count count:',tokenEvents.length);
console.log('--- FIRST token_count ---');console.log(JSON.stringify(tokenEvents[0],null,2));
console.log('--- LAST token_count ---');console.log(JSON.stringify(tokenEvents[tokenEvents.length-1],null,2));
}
