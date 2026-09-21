// T09 통합 테스트(opt-in): 실제 데몬을 죽였다 켜서 Claude 멤버가 `--resume` 으로 이어지는지 본다.
//   데몬#1(임시 dataDir·빈 포트 3개): department.create(sandbox, 부장 '기억이') → instruct "한 줄로 인사해줘" → idle
//   process.kill(데몬#1) (하드 킬 — daemon.json 이 남고 멤버 status 는 idle 그대로)
//   데몬#2(같은 dataDir): stdout 의 "[office] 복구: …" → hello{since} → 멤버 재스폰 확인 → [RESUMED] 턴 종료 대기
//   → member.attach 화면에 이전 대화가 보이는지 → instruct "아까 뭐라고 인사했는지 한 줄로" → text 이벤트가 앞 인사를 언급하는지
//   → clockOut → daemon.shutdown
// 실행: PIXEL_IT=1 npx tsx --test test/office/restart.integration.test.ts   (bash)
// 전제: dev/spike-0/sandbox(또는 `PIXEL_IT_SANDBOX`)가 신뢰된 폴더이고 claude 로그인이 끝나 있다.
//
// T44(2026-09-21) 갱신 — rev 3(T34, D-32/D-34) 이후 낡아 있던 것을 codex IT(T42-1)와 같은 방식으로 고쳤다:
//   ① `team.create`+`member.clockIn` 은 디버그 전용이 됐다(-32004) → 멤버 하나면 되므로 **정식 경로**
//      `department.create` 로 부장 하나를 세운다(force 를 한 군데도 안 쓴다).
//   ② 스냅샷은 `hello` 응답으로만 온다(`snapshotOnce`).
//   ③ 인라인으로 복사돼 있던 도우미(Client/startDaemon/freePort/sweep…)를 `it-helpers.ts` 하나로 합쳤다 —
//      IT 마다 임시 dataDir + 빈 포트 3개라는 격리 규칙이 한 곳에만 있게.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonInfo } from '../../src/office/types.js';
import type { Department, Member, OfficeEvent, Snapshot } from '../../src/store/types.js';
import {
  Client,
  type Daemon,
  IT,
  SANDBOX,
  itEnv,
  killTree,
  pidAlive,
  sleep,
  snapshotOnce,
  startDaemon,
  sweepClaudeByDataDir,
  waitExit,
} from './it-helpers.js';

const GREET = '한 줄로 인사해줘';
const RECALL = '아까 뭐라고 인사했는지 한 줄로';

/** ANSI/제어 시퀀스를 걷어낸 화면 평문. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** 두 문장이 같은 인사를 가리키는지: 인사말의 2글자 이상 토큰 중 하나라도 회상문에 있으면 참. */
function sharesToken(greeting: string, recall: string): { ok: boolean; tokens: string[]; hits: string[] } {
  const tokens = greeting
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const hits = tokens.filter((t) => recall.includes(t));
  return { ok: hits.length > 0, tokens, hits };
}

test('real daemon restart: greet → kill daemon → new daemon resumes member → screen shows prior chat → recalls greeting → clockOut → shutdown', { skip: IT ? false : 'set PIXEL_IT=1 to run', timeout: 480_000 }, async () => {
  assert.ok(fs.existsSync(SANDBOX), `sandbox missing: ${SANDBOX}`);
  // 세 포트 다 빈 포트로 — 기본 7420-7422 에 진짜 데몬이 떠 있어도 부딪히지 않는다(D-40).
  const { dataDir, env } = await itEnv('t09');
  const claudePids: number[] = [];
  const daemons: Daemon[] = [];
  let client1: Client | undefined;
  let client2: Client | undefined;
  const t0 = Date.now();
  const el = () => `${Date.now() - t0}ms`;

  try {
    // ---- 데몬 #1: 출근 → 인사 ----------------------------------------------------------------
    const d1 = startDaemon('d1', env);
    daemons.push(d1);
    await d1.waitLine('listening', (l) => l.includes('[daemon] listening'), 20_000);
    const info1 = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.json'), 'utf8')) as DaemonInfo;
    assert.equal(info1.pid, d1.child.pid);
    client1 = await Client.connect(info1.wsPort, 'c1');
    const hello1 = await client1.call<{ daemon: { pid: number }; snapshot: Snapshot }>('hello', { token: info1.token, client: { name: 't09-it', version: '0' } });
    assert.equal(hello1.daemon.pid, d1.child.pid);
    console.log(`[IT] d1 hello ok (${el()}) snapshot.seq=${hello1.snapshot.seq}`);

    // rev 3(D-32): 사용자가 만드는 것은 부서뿐이고 부장이 자동 출근한다. 복구가 되살리는 것도 이 한 명이다.
    const { department, head: member } = await client1.call<{ department: Department; head: Member }>('department.create', {
      name: 'it09',
      cwd: SANDBOX,
      headEngine: 'claude',
      headName: '기억이',
    });
    if (member.childPid) claudePids.push(member.childPid);
    console.log(`[IT] department=${department.id} head=${member.id} rank=${member.rank} pid=${member.childPid} (${el()})`);
    await client1.waitStatus(member.id, 'idle', 90_000);
    console.log(`[IT] idle (SessionStart) ${el()}`);

    const seqBeforeGreet = client1.lastSeq;
    const { taskId: greetTask } = await client1.call<{ taskId: number }>('member.instruct', { memberId: member.id, text: GREET });
    const greetText = await client1.waitEvent(member.id, 'text', seqBeforeGreet, 180_000, (e) => typeof e.detail.text === 'string');
    const greeting = String(greetText.detail.text);
    await client1.waitEvent(member.id, 'idle', greetText.seq, 60_000);
    console.log(`[IT] greeting (task#${greetTask}) ${el()}: ${JSON.stringify(greeting)}`);
    assert.ok(greeting.trim().length > 0, 'greeting text');

    // 죽기 직전의 멤버 행(session_id·child_pid)
    const snap1 = await snapshotOnce(info1.wsPort, info1.token, 'peek');
    const before = snap1.members.find((m) => m.id === member.id)!;
    console.log(`[IT] before kill: status=${before.status} session_id=${before.sessionId} child_pid=${before.childPid}`);
    assert.equal(before.status, 'idle');
    // Claude 는 기동 SessionStart 로 session_id 가 벌써 있다 — `--resume` 이 이것을 쓴다(Codex 는 첫 턴 뒤에야 생긴다, D-24).
    assert.ok(before.sessionId, 'session_id recorded by SessionStart');
    const seqBeforeKill = client1.lastSeq;

    // ---- 데몬 #1 하드 킬 -------------------------------------------------------------------------
    client1.close();
    client1 = undefined;
    process.kill(d1.child.pid!);
    const d1Exited = await waitExit(d1.child, 10_000);
    console.log(`[IT] d1 killed: exited=${d1Exited} code=${d1.child.exitCode} signal=${d1.child.signalCode} (${el()})`);
    assert.ok(d1Exited, 'daemon #1 did not die');
    await sleep(1500);
    // 설계 전제(데몬이 죽으면 ConPTY 자식도 죽는다)는 하드 킬에서 깨진다(T09 실측: 살아남음) → 데몬#2 의 복구가 유령을 정리해야 한다.
    const claude1Alive = before.childPid ? pidAlive(before.childPid) : false;
    console.log(`[IT] claude#1 pid ${before.childPid} alive after daemon death: ${claude1Alive}`);
    assert.ok(fs.existsSync(path.join(dataDir, 'daemon.json')), 'hard kill leaves daemon.json behind');

    // ---- 데몬 #2: 복구 -------------------------------------------------------------------------
    const d2 = startDaemon('d2', env);
    daemons.push(d2);
    const recoveryLine = await d2.waitLine('recovery notice', (l) => /\[office\] 복구: \d+명 재개/.test(l), 30_000);
    console.log(`[IT] recovery notice (${el()}): ${recoveryLine}`);
    assert.match(recoveryLine, /복구: 1명 재개, 0건 만료/);
    if (claude1Alive) {
      assert.match(recoveryLine, /유령 1개 정리/);
      await sleep(500);
      assert.ok(!pidAlive(before.childPid!), `orphan claude pid ${before.childPid} must be dead after recovery`);
      console.log(`[IT] orphan claude#1 pid ${before.childPid} killed by recovery: ${!pidAlive(before.childPid!)}`);
    }
    await d2.waitLine('listening', (l) => l.includes('[daemon] listening'), 20_000);
    const info2 = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.json'), 'utf8')) as DaemonInfo;
    assert.equal(info2.pid, d2.child.pid);
    assert.notEqual(info2.token, info1.token);

    client2 = await Client.connect(info2.wsPort, 'c2');
    const hello2 = await client2.call<{ daemon: { pid: number }; snapshot: Snapshot }>('hello', { token: info2.token, since: seqBeforeKill, client: { name: 't09-it', version: '0' } });
    assert.equal(hello2.daemon.pid, d2.child.pid);
    const after = hello2.snapshot.members.find((m) => m.id === member.id)!;
    console.log(`[IT] after restart: status=${after.status} session_id=${after.sessionId} child_pid=${after.childPid} (${el()})`);
    assert.ok(['starting', 'idle', 'working'].includes(after.status), `member respawned, status=${after.status}`);
    assert.ok(after.childPid && after.childPid !== before.childPid, 'new child pid');
    assert.ok(pidAlive(after.childPid!), 'resumed claude is alive');
    claudePids.push(after.childPid!);
    assert.equal(after.sessionId, before.sessionId, 'session_id kept for --resume');
    assert.equal(hello2.snapshot.pending.length, 0);
    assert.deepEqual(hello2.snapshot.tasks, [], 'no open tasks (greeting task was reported before the kill)');

    // SessionStart(source=resume) → text{summary:'resumed'} (replay 또는 실시간)
    const resumedEv = await client2.waitEvent(member.id, 'text', seqBeforeKill, 90_000, (e) => e.detail.summary === 'resumed');
    console.log(`[IT] resumed event #${resumedEv.seq} (${el()})`);

    // [RESUMED] 턴: thinking 이 [RESUMED] 로 시작 → idle
    const resumedTurn = await client2.waitEvent(member.id, 'thinking', resumedEv.seq, 120_000, (e) => String(e.detail.text ?? '').startsWith('[RESUMED]'));
    console.log(`[IT] [RESUMED] typed (${el()}): ${String(resumedTurn.detail.text)}`);
    const resumedIdle = await client2.waitEvent(member.id, 'idle', resumedTurn.seq, 180_000);
    const resumedReply = client2.notifications
      .map((n) => n.params as unknown as OfficeEvent)
      .find((e) => e.kind === 'text' && e.seq > resumedTurn.seq && e.seq < resumedIdle.seq && typeof e.detail.text === 'string');
    console.log(`[IT] reply to [RESUMED] (${el()}): ${JSON.stringify(resumedReply?.detail.text ?? null)}`);

    // 터미널 화면에 이전 대화가 보인다
    const attach = await client2.call<{ screen: string; cols: number; rows: number }>('member.attach', { memberId: member.id, cols: 120, rows: 40 });
    const plain = stripAnsi(attach.screen);
    const greetingTokens = sharesToken(greeting, plain);
    console.log(`[IT] attach screen=${attach.screen.length} bytes; has instruction=${plain.includes(GREET)} greeting tokens hit=${JSON.stringify(greetingTokens.hits)}`);
    console.log(`[IT] screen tail:\n${plain.split('\n').filter((l) => l.trim()).slice(-25).join('\n')}`);
    assert.ok(plain.includes(GREET) || greetingTokens.ok, 'screen shows the conversation from before the restart');

    // 회상: 앞 인사를 언급해야 한다
    const seqBeforeRecall = client2.lastSeq;
    await client2.call('member.instruct', { memberId: member.id, text: RECALL });
    const recallText = await client2.waitEvent(member.id, 'text', seqBeforeRecall, 180_000, (e) => typeof e.detail.text === 'string');
    await client2.waitEvent(member.id, 'idle', recallText.seq, 60_000);
    const recall = String(recallText.detail.text);
    const cmp = sharesToken(greeting, recall);
    console.log(`[IT] recall (${el()}): ${JSON.stringify(recall)}\n[IT] greeting tokens=${JSON.stringify(cmp.tokens)} hits=${JSON.stringify(cmp.hits)}`);
    assert.ok(cmp.ok, `recall should reference the earlier greeting\n greeting: ${greeting}\n recall: ${recall}`);

    // ---- 정리 ------------------------------------------------------------------------------------
    await client2.call('member.clockOut', { memberId: member.id });
    await client2.waitStatus(member.id, 'exited', 20_000);
    console.log(`[IT] clockOut done (${el()}); claude#2 alive=${pidAlive(after.childPid!)}`);
    await client2.call('daemon.shutdown', {});
    const d2Exited = await waitExit(d2.child, 20_000);
    console.log(`[IT] d2 exited=${d2Exited} code=${d2.child.exitCode} (${el()})`);
    assert.ok(d2Exited, 'daemon #2 did not exit after daemon.shutdown');
    assert.equal(fs.existsSync(path.join(dataDir, 'daemon.json')), false, 'daemon.json removed on clean shutdown');
  } finally {
    client1?.close();
    client2?.close();
    for (const d of daemons) {
      if (d.child.exitCode === null) {
        console.log(`[IT] daemon pid ${d.child.pid} still running — killing`);
        killTree(d.child.pid!);
        await waitExit(d.child, 5000);
      }
    }
    await sleep(500);
    const swept = sweepClaudeByDataDir(dataDir, claudePids);
    if (swept.length > 0) console.log(`[IT] leftover claude pids killed: ${swept.join(', ')}`);
    await sleep(500);
    console.log(`[IT] leftover check: ${[...new Set([...claudePids, ...swept])].map((p) => `${p}=${pidAlive(p) ? 'ALIVE' : 'dead'}`).join(' ') || 'none'}`);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
