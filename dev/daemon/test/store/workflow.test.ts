import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/store/Store.js';
import type { Workflow } from '../../src/workflow/types.js';

test('workflow survives reopening the existing database and department deletion removes its history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'pixel-workflow-store-'));
  const file = path.join(dir,'office.db');
  let store = new Store(file);
  try {
    const department = store.createDepartment({name:'workflow',cwd:dir});
    const w: Workflow = {id:'w1',departmentId:department.id,phase:'clarifying',brief:'goal',messages:[],assignments:[],createdAt:'2026-10-13',updatedAt:'2026-10-13'};
    store.saveWorkflow(w);
    store.saveWorkflow({...w,phase:'meeting',meeting:{round:2,state:'reviewing',participants:['m1'],contributions:[{memberId:'m1',round:1,text:'opinion',at:'now'}]}});
    store.close(); store = new Store(file);
    assert.equal(store.currentWorkflow(department.id)!.meeting!.contributions[0]!.text,'opinion');
    store.saveWorkflow({...w,id:'w2'});
    assert.equal(store.currentWorkflow(department.id)!.id,'w2');
    assert.equal(store.listWorkflows().length,2);
    store.deleteDepartment(department.id);
    assert.equal(store.listWorkflows().length,0);
  } finally { store.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});
