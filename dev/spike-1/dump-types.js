const fs=require('fs');
const file=process.argv[2];const want=process.argv.slice(3);
const lines=fs.readFileSync(file,'utf8').split('\n').filter(Boolean);
for(const l of lines){let o;try{o=JSON.parse(l)}catch{continue}
  if(want.includes(o.type)){console.log('===',o.type,'===');console.log(JSON.stringify(o,null,1).slice(0,2500))}
}
