// T17 통합 테스트(opt-in): 실제 데몬 + 실제 Claude 가 `--mcp-config` 로 붙은 team MCP 의 ask_user 를 부르고, 사용자가
// question.respond 로 답하면 `[ANSWER q#<id>]` 가 주입돼 모델이 그 답을 말하는지 본다.
//   데몬(임시 포트·임시 dataDir) → team.create(sandbox) → clockIn(claude) → idle
//   → instruct "team MCP 서버의 ask_user 도구로 …'좋아하는 색은?'… (옵션: 빨강, 파랑) … 그 색을 한 줄로 말해줘."
//   → asking 이벤트(detail.tool=ask_user) + 스냅샷 pending.payload.source==='ask_user' → 턴 종료(idle)
//   → question.respond {answers:{'좋아하는 색은?':'파랑'}} → thinking '[ANSWER q#…]' → text 에 '파랑' → idle
//   → clockOut → daemon.shutdown
// 실행: PIXEL_IT=1 npx tsx --test test/office/askuser.integration.test.ts   (bash)
// 전제: dev/spike-0/sandbox 가 신뢰된 폴더이고 claude 로그인이 끝나 있다. MCP 도구 허가 요청은 자동 allow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DaemonInfo } from '../../src/office/types.js';
import type { Member, OfficeEvent, Pending, Snapshot, Team } from '../../src/store/types.js';
import { Client, IT, SANDBOX, freePort, killTree, pidAlive, sleep, startDaemon, sweepClaudeByDataDir, waitExit } from './it-helpers.js';

/** 그 멤버의 마지막 member.status 알림이 조건을 만족할 때까지 폴링(최대 timeoutMs). */
async function lastStatusWhen(client: Client, memberId: string, pred: (s: { status: string; derived: string }) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = client.notifications.filter((x) => x.method === 'member.status' && x.params.memberId === memberId).at(-1);
    const s = n ? { status: String(n.params.status), derived: String(n.params.derived) } : undefined;
    if (s && pred(s)) return s;
    if (Date.now() > deadline) throw new Error(`timeout: last status = ${JSON.stringify(s)}`);
    await sleep(100);
  }
}

const QUESTION = '좋아하는 색은?';
const INSTRUCT = `team MCP 서버의 ask_user 도구로 나에게 '${QUESTION}' 하고 물어봐 (옵션: 빨강, 파랑). 답이 오면 그 색을 한 줄로 말해줘.`;
const ANSWER = '파랑';

test('real daemon + real Claude: ask_user via --mcp-config → question.respond → [ANSWER] → model says the color', { skip: IT ? false : 'set PIXEL_IT=1 to run', timeout: 480_000 }, async () => {
  assert.ok(fs.existsSync(SANDBOX), `sandbox missing: ${SANDBOX}`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t17-it-'));
  const [wsPort, hookPort, mcpPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const env = { PIXEL_WS_PORT: String(wsPort), PIXEL_HOOK_PORT: String(hookPort), PIXEL_MCP_PORT: String(mcpPort), PIXEL_DATA_DIR: dataDir };
  const claudePids: number[] = [];
  let client: Client | undefined;
  let stopApprover: (() => void) | undefined;
  const t0 = Date.now();
  const el = () => `${Date.now() - t0}ms`;

  const d = startDaemon('d', env);
  try {
    await d.waitLine('listening', (l) => l.includes('[daemon] listening'), 20_000);
    const info = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.json'), 'utf8')) as DaemonInfo;
    assert.equal(info.mcpPort, mcpPort, 'daemon.json records the MCP port');
    client = await Client.connect(info.wsPort, 'c');
    const hello = await client.call<{ daemon: { pid: number }; snapshot: Snapshot }>('hello', { token: info.token, client: { name: 't17-it', version: '0' } });
    assert.equal(hello.daemon.pid, d.child.pid);

    const { team } = await client.call<{ team: Team }>('team.create', { name: 'it', cwd: SANDBOX, leaderEngine: 'claude' });
    const { member } = await client.call<{ member: Member }>('member.clockIn', { teamId: team.id, engine: 'claude', name: 'asker' });
    if (member.childPid) claudePids.push(member.childPid);
    stopApprover = client.autoApprove(member.id);
    console.log(`[IT] clockIn member=${member.id} pid=${member.childPid} (${el()})`);

    // mcp.json 이 실제로 쓰였고 스폰 인자에 들어갔는지
    const mcpJson = path.join(dataDir, 'sessions', member.id, 'mcp.json');
    assert.ok(fs.existsSync(mcpJson), 'mcp.json written');
    const mcpCfg = JSON.parse(fs.readFileSync(mcpJson, 'utf8')) as { mcpServers: { team: { type: string; url: string } } };
    assert.equal(mcpCfg.mcpServers.team.type, 'http');
    assert.equal(mcpCfg.mcpServers.team.url, `http://127.0.0.1:${mcpPort}/mcp/${member.memberToken}`);
    console.log(`[IT] mcp.json: ${JSON.stringify(mcpCfg)}`);

    await client.waitStatus(member.id, 'idle', 90_000);
    console.log(`[IT] idle (SessionStart) ${el()}`);

    // ---- 지시 → ask_user ------------------------------------------------------------------------
    const seq0 = client.lastSeq;
    const { taskId } = await client.call<{ taskId: number }>('member.instruct', { memberId: member.id, text: INSTRUCT });
    console.log(`[IT] instruct task#${taskId} (${el()})`);
    const asking = await client.waitEvent(member.id, 'asking', seq0, 240_000, (e) => e.detail.tool === 'ask_user');
    const questionId = asking.ref.questionId!;
    console.log(`[IT] asking #${asking.seq} q=${questionId} summary=${JSON.stringify(asking.detail.summary)} options=${JSON.stringify(asking.detail.options)} (${el()})`);
    assert.ok(questionId, 'asking event carries ref.questionId');
    assert.ok(String(asking.detail.summary).includes('색'), `question mentions 색: ${String(asking.detail.summary)}`);

    // 스냅샷의 pending: ask_user 출처, tool_input 없음
    const peek = await Client.connect(info.wsPort, 'peek');
    const snap = (await peek.call<{ snapshot: Snapshot }>('hello', { token: info.token, client: { name: 'peek', version: '0' } })).snapshot;
    peek.close();
    const pending = snap.pending.find((p) => p.id === questionId) as Pending | undefined;
    assert.ok(pending, 'open pending in snapshot');
    console.log(`[IT] pending ${pending.id}: ${JSON.stringify(pending.payload)}`);
    assert.equal(pending.type, 'question');
    assert.equal(pending.payload.source, 'ask_user');
    assert.equal(pending.payload.tool_input, undefined);
    assert.equal(pending.payload.question, asking.detail.summary);

    // 모델이 턴을 끝내고 기다린다(비블로킹): asking 뒤 idle. 파생 상태는 waiting_answer
    // (status 알림은 이벤트 직후에 오므로 마지막 알림이 idle 이 될 때까지 잠깐 기다린다)
    const idle1 = await client.waitEvent(member.id, 'idle', asking.seq, 180_000);
    const st = await lastStatusWhen(client, member.id, (s) => s.status === 'idle', 10_000);
    console.log(`[IT] turn ended after asking: idle #${idle1.seq}, status=${st.status} derived=${st.derived} (${el()})`);
    assert.equal(st.status, 'idle');
    assert.equal(st.derived, 'waiting_answer');
    const askReply = client
      .events()
      .filter((e) => e.kind === 'text' && e.seq > asking.seq && e.seq < idle1.seq && typeof e.detail.text === 'string')
      .map((e) => String(e.detail.text));
    console.log(`[IT] model text while waiting: ${JSON.stringify(askReply)}`);

    // ---- 답 → [ANSWER q#id] 주입 → 모델이 색을 말한다 -----------------------------------------------
    await client.call('question.respond', { pendingId: questionId, answers: { [String(pending.payload.question)]: ANSWER } });
    console.log(`[IT] question.respond → ${ANSWER} (${el()})`);
    const answerTurn = await client.waitEvent(member.id, 'thinking', idle1.seq, 120_000, (e) => String(e.detail.text ?? '').startsWith(`[ANSWER q#${questionId}]`));
    console.log(`[IT] [ANSWER] typed #${answerTurn.seq} (${el()}): ${JSON.stringify(answerTurn.detail.text)}`);
    assert.equal(answerTurn.detail.text, `[ANSWER q#${questionId}]\n${ANSWER}`);
    const idle2 = await client.waitEvent(member.id, 'idle', answerTurn.seq, 180_000);
    const reply = client
      .events()
      .filter((e) => e.kind === 'text' && e.seq > answerTurn.seq && e.seq < idle2.seq && typeof e.detail.text === 'string')
      .map((e) => String(e.detail.text));
    console.log(`[IT] reply to [ANSWER] (${el()}): ${JSON.stringify(reply)}`);
    assert.ok(
      reply.some((t) => t.includes(ANSWER)),
      `model should mention ${ANSWER}: ${JSON.stringify(reply)}`,
    );
    const st2 = await lastStatusWhen(client, member.id, (s) => s.status === 'idle', 10_000);
    console.log(`[IT] final status=${st2.status} derived=${st2.derived}`);
    assert.equal(st2.status, 'idle');
    assert.notEqual(st2.derived, 'waiting_answer');

    // ---- 정리 ------------------------------------------------------------------------------------
    stopApprover();
    stopApprover = undefined;
    await client.call('member.clockOut', { memberId: member.id });
    await client.waitStatus(member.id, 'exited', 20_000);
    console.log(`[IT] clockOut done (${el()}); claude alive=${member.childPid ? pidAlive(member.childPid) : 'n/a'}`);
    await client.call('daemon.shutdown', {});
    const exited = await waitExit(d.child, 20_000);
    console.log(`[IT] daemon exited=${exited} code=${d.child.exitCode} (${el()})`);
    assert.ok(exited, 'daemon did not exit after daemon.shutdown');
  } finally {
    stopApprover?.();
    client?.close();
    if (d.child.exitCode === null) {
      console.log(`[IT] daemon pid ${d.child.pid} still running — killing`);
      killTree(d.child.pid!);
      await waitExit(d.child, 5000);
    }
    await sleep(500);
    const swept = sweepClaudeByDataDir(dataDir, claudePids);
    if (swept.length > 0) console.log(`[IT] leftover claude pids killed: ${swept.join(', ')}`);
    await sleep(500);
    console.log(`[IT] leftover check: ${[...new Set([...claudePids, ...swept])].map((p) => `${p}=${pidAlive(p) ? 'ALIVE' : 'dead'}`).join(' ') || 'none'}`);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
