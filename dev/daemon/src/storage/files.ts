import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';

export const storageHealth=new EventEmitter();
const failures=new Map<string,string>();
export function storageFailures(){return [...failures].map(([file,message])=>({file,message}));}
export function storageResult(file:string,error?:unknown){
  if(error!==undefined){
    const message=error instanceof Error ? error.message : String(error);
    if(failures.get(file)!==message){failures.set(file,message);storageHealth.emit('failure',file,message);}
  }else if(failures.delete(file))storageHealth.emit('recovered',file);
}

/** Bounded diagnostic history: current file plus three archives, 5 MiB each. */
export function appendLog(file:string,text:string,maxBytes=5*1024*1024,archives=3){
  if(Buffer.byteLength(text)>maxBytes){
    const preview=text.slice(0,Math.floor(maxBytes/8));
    text=file.endsWith('.jsonl') ? JSON.stringify({truncated:true,preview})+'\n' : preview+'\n[log entry truncated]\n';
  }
  if(fs.existsSync(file) && fs.statSync(file).size+Buffer.byteLength(text)>maxBytes){
    for(let n=archives;n>=1;n--){
      const destination=`${file}.${n}`,source=n===1 ? file : `${file}.${n-1}`;
      if(fs.existsSync(destination))fs.unlinkSync(destination);
      if(fs.existsSync(source))fs.renameSync(source,destination);
    }
  }
  fs.appendFileSync(file,text,'utf8');
}

/** A failed write must leave the previous complete JSON file intact. */
export function writeJson(file:string,value:unknown){
  const temporary=path.join(path.dirname(file),`.${path.basename(file)}.${randomUUID()}.tmp`);
  try{fs.writeFileSync(temporary,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
