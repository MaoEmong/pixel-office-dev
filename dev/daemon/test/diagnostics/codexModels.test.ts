import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chooseCodexModel,CodexModelGuard,isUnsupportedCodexModel} from '../../src/diagnostics/codexModels.js';

test('use a supported preference, or the account default instead of an unsupported app model',()=>{
  const models=[{model:'account-default',isDefault:true},{model:'account-small'}];
  assert.equal(chooseCodexModel(models,'account-small'),'account-small');
  assert.equal(chooseCodexModel(models,'desktop-only-model'),'account-default');
  assert.throws(()=>chooseCodexModel([]),/모델이 없습니다/);
});

test('model checking does not guess on failure and retries after repair',async()=>{
  let calls=0;
  const guard=new CodexModelGuard(async()=>{calls++;if(calls===1)throw new Error('offline');return [{model:'account-default',isDefault:true}];},()=> 'unsupported');
  assert.throws(()=>guard.selected(),/확인하지 못했습니다/);
  await assert.rejects(guard.prepare(),/offline/);
  assert.equal(await guard.prepare(),'account-default');
  assert.equal(guard.selected(),'account-default');
  await guard.prepare();assert.equal(calls,2);
});

test('recognize the rendered unsupported-model API error, including wrapped lines, without flagging ordinary model names',()=>{
  const error='■ {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The model is not supported when using\nCodex with a ChatGPT account."}}';
  assert.equal(isUnsupportedCodexModel(error),true);
  assert.equal(isUnsupportedCodexModel('We should use a different model.'),false);
  assert.equal(isUnsupportedCodexModel(error.replace('■','사용자:')),false);
});

test('concurrent team creation shares one account catalog check',async()=>{
  let calls=0;
  const guard=new CodexModelGuard(async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,10));return [{model:'account-model',isDefault:true}];},()=>undefined);
  assert.deepEqual(await Promise.all([guard.prepare(),guard.prepare(),guard.prepare()]),['account-model','account-model','account-model']);
  assert.equal(calls,1);
});
