import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, IT, SANDBOX, itEnv, startDaemon, waitExit, killTree, pidAlive, sleep, unwrapPasted } from './it-helpers.js';
import { projectMemberDir } from '../../src/pty/projectSessions.js';
import type { DaemonInfo } from '../../src/office/types.js';
import type { Member, Snapshot } from '../../src/store/types.js';

test('real Codex project storage: clean daemon restart resumes the same session and recalls its prior marker', {skip: !IT, timeout: 600_000}, async () => {
  const {dataDir, env} = await itEnv('codex-recovery');
  const marker = `PIXEL-MEMORY-${randomUUID()}`;
  let daemon: ReturnType<typeof startDaemon> | undefined;
  let client: Client | undefined;
  const pids = new Set<number>();
  async function connect(tag: string): Promise<Snapshot> {
    daemon = startDaemon(tag, env);
    await daemon.waitLine('listening', line=>line.includes('[daemon] listening'), 30_000);
    const info: DaemonInfo = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.json'), 'utf8'));
    client = await Client.connect(info.wsPort, tag);
    return (await client.call<{snapshot: Snapshot}>('hello', {token: info.token, client:{name:tag,version:'1'}})).snapshot;
  }
  async function finishDaemon(): Promise<void> {
    await client!.call('daemon.shutdown', {});
    assert.ok(await waitExit(daemon!.child, 30_000));
    assert.equal(daemon!.child.exitCode, 0);
    client!.close(); client=undefined;
  }
  try {
    await connect('codex-storage-1');
    const {head} = await client!.call<{head: Member}>('department.create', {name:'codex-recovery',cwd:SANDBOX,headEngine:'codex',headName:'복구검증'});
    if (head.childPid) pids.add(head.childPid);
    await client!.waitStatus(head.id, 'idle', 120_000);
    const seq = client!.lastSeq;
    await client!.call('member.instruct', {memberId:head.id,text:`Remember this exact marker for this conversation: ${marker}. Reply with the marker only. Do not use tools.`});
    const thinking = await client!.waitEvent(head.id, 'thinking', seq, 120_000);
    await client!.waitEvent(head.id, 'idle', thinking.seq, 180_000);
    assert.ok(client!.events().some(e=>e.kind==='text' && e.seq>thinking.seq && String(e.detail.text).includes(marker)));
    const identityFile = path.join(projectMemberDir(SANDBOX, head.id), 'session.json');
    const sid = JSON.parse(fs.readFileSync(identityFile,'utf8')).sessionId;
    assert.ok(sid, 'SessionStart persisted the native session ID');
    const localHome = path.join(projectMemberDir(SANDBOX,head.id),'codex');
    const localFiles = fs.readdirSync(path.join(localHome,'sessions'), {recursive:true,encoding:'utf8'});
    assert.ok(localFiles.some(file=>file.endsWith(`${sid}.jsonl`)), 'native rollout is inside the project');
    assert.ok(fs.readdirSync(localHome).some(file=>/^state_\d+\.sqlite$/.test(file)), 'native session index is project-local');
    console.log(`[recovery] session ${sid}: project-local rollout and state confirmed`);
    await finishDaemon();
    const snapshot = await connect('codex-storage-2');
    const restored = snapshot.members.find(m=>m.id===head.id)!;
    assert.ok(restored, 'member restored from office database');
    assert.equal(restored.sessionId,sid);
    if (restored.childPid) pids.add(restored.childPid);
    if (restored.status!=='idle') await client!.waitStatus(head.id,'idle',120_000);
    const before = client!.lastSeq;
    await client!.call('member.instruct',{memberId:head.id,text:'Recall the exact PIXEL-MEMORY marker I told you earlier. Reply with that marker only. Do not use tools.'});
    const recalledTurn = await client!.waitEvent(head.id,'thinking',before,180_000,e=>unwrapPasted(e.detail.text).includes('Recall the exact'));
    await client!.waitEvent(head.id,'idle',recalledTurn.seq,180_000);
    const replies = client!.events().filter(e=>e.kind==='text' && e.seq>recalledTurn.seq).map(e=>String(e.detail.text));
    assert.ok(replies.some(reply=>reply.includes(marker)), `resumed conversation recalls prior marker: ${JSON.stringify(replies)}`);
    assert.equal(JSON.parse(fs.readFileSync(identityFile,'utf8')).sessionId,sid,'resume preserves the session ID');
    console.log('[recovery] same session resumed and recalled prior marker');
    await finishDaemon();
  } finally {
    client?.close();
    if (daemon && daemon.child.exitCode===null) { killTree(daemon.child.pid!); await waitExit(daemon.child,5000); }
    for (const pid of pids) if (pidAlive(pid)) killTree(pid);
    await sleep(500);
    fs.rmSync(dataDir,{recursive:true,force:true});
  }
});
