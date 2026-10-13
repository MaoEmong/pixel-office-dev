import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {OptionalRemote} from '../../src/remote/OptionalRemote.js';

test('occupied remote port reports failure and can recover after release', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'office-remote-'));
  const server=http.createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as import('node:net').AddressInfo).port;
  const remote=new OptionalRemote({port,dataDir:dir,upstreamUrl:()=>'',token:()=>''});
  try {
    assert.equal(await remote.start(),undefined);
    assert.equal(remote.status().available,false);
    assert.throws(()=>remote.localHandlers()['remote.pair.create']({}),/원격 연결/);
    await new Promise<void>(r=>server.close(()=>r()));
    await remote.localHandlers()['remote.retry']({});
    assert.equal(remote.status().available,true);
    const res=await fetch(`http://127.0.0.1:${port}/`);assert.equal(res.status,200);
  } finally {await remote.close();if(server.listening)await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(dir,{recursive:true,force:true});}
});

test('remote database open error is contained', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'office-remote-db-'));
  fs.mkdirSync(path.join(dir,'remote-devices.db'));
  const remote=new OptionalRemote({port:0,dataDir:dir,upstreamUrl:()=>'',token:()=>''});
  try {assert.equal(await remote.start(),undefined);assert.equal(remote.status().available,false);}
  finally {await remote.close();fs.rmSync(dir,{recursive:true,force:true});}
});
