import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {IPty} from 'node-pty';
import {releaseConptyResources} from '../../src/pty/PtyManager.js';

test('Windows forced exit never closes a native pseudoconsole handle twice', {skip:process.platform!=='win32'},()=> {
  let nativeClosed=0,workerDisposed=0,inputClosed=0;
  const proc={_agent:{_pty:42,_useConptyDll:false,_inSocket:{destroy(){inputClosed++;}},_conoutSocketWorker:{dispose(){workerDisposed++;}},_ptyNative:{kill(){nativeClosed++;}}}} as unknown as IPty;
  // A forced node-pty kill has already freed both native resources before its onExit callback arrives.
  releaseConptyResources(proc,true);
  assert.equal(nativeClosed,0);
  assert.equal(workerDisposed,0);
  assert.equal(inputClosed,1);
  // Natural exit still needs explicit native cleanup to let the daemon's event loop finish.
  releaseConptyResources(proc,false);
  assert.equal(nativeClosed,1);
  assert.equal(workerDisposed,1);
});
