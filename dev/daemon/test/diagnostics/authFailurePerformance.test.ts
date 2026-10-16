import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {authenticationFailed} from '../../src/diagnostics/authFailure.js';

test('blank terminal padding cannot block authentication detection',()=>{
  // A separate process gives this regression a real timeout, even if a future
  // regular expression blocks its JavaScript thread as the original one did.
  const moduleUrl=new URL('../../src/diagnostics/authFailure.ts',import.meta.url).href;
  const script=`const {authenticationFailed}=await import(${JSON.stringify(moduleUrl)});if(authenticationFailed(' \\r\\n'.repeat(3500)))process.exit(1);`;
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],
    {timeout:5000,encoding:'utf8',windowsHide:true});
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr);
});

test('real login failures after padded lines remain visible',()=>{
  assert.equal(authenticationFailed(' '.repeat(12000)+'\r\n● Login expired · Please run /login'),true);
  assert.equal(authenticationFailed(' '.repeat(12000)+'\r\nEverything completed successfully'),false);
  assert.equal(authenticationFailed('An explanation about Authentication failed is not an error'),false);
});
