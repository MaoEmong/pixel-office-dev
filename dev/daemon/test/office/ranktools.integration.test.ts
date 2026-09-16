// T35 통합 테스트(opt-in): 실제 데몬 + 실제 Claude **부장**이 team MCP 의 create_team → delegate 를 하고, 그 팀장이
// hire → delegate 를 해서 팀원이 파일을 쓰고, 보고가 팀원 → 팀장 → 부장 → 내 책상까지 올라오는 한 바퀴.
//   데몬(임시 포트·임시 dataDir) → department.create(sandbox, 부장 '부장') → 부장 idle
//   → instruct "team MCP로 팀 '개발'을 만들고(팀장 이름 '팀장A'), 팀장에게 delegate로
//      'hello35.txt에 hi 라고 쓰는 팀원을 하나 고용해서 시키고 결과를 보고해라'를 시켜라. 보고가 오면 나에게 report로 한 줄 요약해라."
//   → 팀장(rank lead, parent=부장) 출근 → 부장의 delegating → 팀장에게 [TASK#n from 부장(부장)]
//   → 팀장이 hire(rank member, parent=팀장) → 팀장의 delegating → 팀원이 파일을 쓰고 보고
//   → 팀장에게 [REPORTS …][ALL_REPORTS_IN] → 팀장 report → 부장에게 [REPORTS …] → 부장 report → reporting(내 책상)
//   → sandbox/hello35.txt 존재 확인 → 정리
// 실행: PIXEL_IT=1 npx tsx --test test/office/ranktools.integration.test.ts   (bash)
// 전제: dev/spike-0/sandbox 가 신뢰된 폴더이고 claude 로그인이 끝나 있다. 허가 요청(Bash 포함)은 전부 자동 allow.
// 주의: Claude 는 MCP 도구를 지연 로딩(ToolSearch)하므로 지시문에 도구 이름을 적어 둔다(D-22, 아래 TOOL_NAMES).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DaemonInfo } from '../../src/office/types.js';
import type { Department, Member, Snapshot, Task } from '../../src/store/types.js';
import { Client, IT, SANDBOX, freePort, killTree, pidAlive, sleep, startDaemon, sweepClaudeByDataDir, waitExit } from './it-helpers.js';

const FILE = 'hello35.txt';
const TOOL_NAMES =
  '도구 이름: mcp__team__create_team, mcp__team__dismiss_team, mcp__team__delegate, mcp__team__reply, mcp__team__report, mcp__team__ask_user (도구 목록에 없으면 ToolSearch로 찾아라).';
const INSTRUCT =
  `team MCP로 팀 '개발'을 만들고(팀장 이름 '팀장A'), 팀장에게 delegate로 '${FILE}에 hi 라고 쓰는 팀원을 하나 고용해서 시키고 결과를 보고해라'를 시켜라. ` +
  `보고가 오면 나에게 report로 한 줄 요약해라.\n${TOOL_NAMES}`;

test('real daemon + real Claude head: create_team → delegate → lead hire → member works → reports climb → head report', { skip: IT ? false : 'set PIXEL_IT=1 to run', timeout: 1_200_000 }, async () => {
  assert.ok(fs.existsSync(SANDBOX), `sandbox missing: ${SANDBOX}`);
  const target = path.join(SANDBOX, FILE);
  fs.rmSync(target, { force: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t35-it-'));
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
    client = await Client.connect(info.wsPort, 'c');
    await client.call('hello', { token: info.token, client: { name: 't35-it', version: '0' } });
    stopApprover = client.autoApproveAll(); // Bash·MCP 허가 전부 자동 allow

    const { department, head } = await client.call<{ department: Department; head: Member }>('department.create', {
      name: 'it35',
      cwd: SANDBOX,
      headEngine: 'claude',
      headName: '부장',
    });
    if (head.childPid) claudePids.push(head.childPid);
    console.log(`[IT] dept=${department.id} head=${head.id} pid=${head.childPid} (${el()})`);
    await client.waitStatus(head.id, 'idle', 120_000);
    console.log(`[IT] head idle (${el()})`);

    /** 부장이 죽으면(hook error·크래시) 몇 분씩 기다리지 않고 바로 실패시킨다. */
    const guard = (async () => {
      const n = await client!.waitFor(
        'head died',
        (x) => x.method === 'member.status' && x.params.memberId === head.id && (x.params.status === 'error' || x.params.status === 'exited'),
        1_200_000,
      ).catch(() => undefined);
      if (n) throw new Error(`head ${head.id} died: status=${String(n.params.status)}`);
      return undefined as never;
    })();
    const race = <T>(p: Promise<T>): Promise<T> => Promise.race([p, guard]) as Promise<T>;

    // ---- 지시 → create_team --------------------------------------------------------------------
    const seq0 = client.lastSeq;
    const { taskId } = await client.call<{ taskId: number }>('member.instruct', { memberId: head.id, text: INSTRUCT });
    console.log(`[IT] instruct task#${taskId} (${el()})`);

    const leadJoined = await race(client.waitFor(
      'lead spawned (create_team)',
      (n) => n.method === 'member.status' && (n.params.member as Member | null)?.rank === 'lead',
      480_000,
    ));
    const lead = leadJoined.params.member as Member;
    if (lead.childPid) claudePids.push(lead.childPid);
    console.log(`[IT] create_team → lead ${lead.name} (${lead.id}) team=${lead.teamId} parent=${lead.parentId} (${el()})`);
    assert.equal(lead.parentId, head.id, '팀장은 부장의 자식이다');
    assert.ok(lead.teamId, '팀장은 팀에 속한다');

    // ---- 부장 → 팀장 위임 -----------------------------------------------------------------------
    const headDelegating = await race(client.waitEvent(head.id, 'delegating', seq0, 480_000));
    const leadTaskId = headDelegating.ref.taskId!;
    console.log(`[IT] head delegating task#${leadTaskId} → ${String(headDelegating.detail.toName)} (${el()})`);
    const leadGot = await race(
      client.waitEvent(lead.id, 'thinking', seq0, 480_000, (e) => String(e.detail.text ?? '').startsWith(`[TASK#${leadTaskId} from `)),
    );
    console.log(`[IT] lead got: ${JSON.stringify(leadGot.detail.text)} (${el()})`);
    assert.match(String(leadGot.detail.text), new RegExp(`^\\[TASK#${leadTaskId} from ${head.name}\\(부장\\)\\]`));

    // ---- 팀장 hire → 팀원 위임 -------------------------------------------------------------------
    const memberJoined = await race(client.waitFor(
      'member hired by lead',
      (n) => n.method === 'member.status' && (n.params.member as Member | null)?.rank === 'member',
      600_000,
    ));
    const worker = memberJoined.params.member as Member;
    if (worker.childPid) claudePids.push(worker.childPid);
    console.log(`[IT] lead hired ${worker.name} (${worker.id}) parent=${worker.parentId} (${el()})`);
    assert.equal(worker.parentId, lead.id, '팀원은 팀장의 자식이다');

    const leadDelegating = await race(client.waitEvent(lead.id, 'delegating', leadGot.seq, 600_000));
    const workTaskId = leadDelegating.ref.taskId!;
    console.log(`[IT] lead delegating task#${workTaskId} → ${String(leadDelegating.detail.toName)} (${el()})`);

    // ---- 보고가 올라온다: 팀원 → 팀장 → 부장 ------------------------------------------------------
    const toLead = await race(client.waitEvent(lead.id, 'thinking', leadDelegating.seq, 600_000, (e) => String(e.detail.text ?? '').startsWith('[REPORTS ')));
    console.log(`[IT] lead got reports (${el()}):\n${String(toLead.detail.text)}`);
    assert.match(String(toLead.detail.text), new RegExp(`^\\[REPORTS task#${workTaskId} ${worker.name} status=(done|blocked|aborted)\\]`));

    const toHead = await race(client.waitEvent(head.id, 'thinking', toLead.seq, 600_000, (e) => String(e.detail.text ?? '').startsWith('[REPORTS ')));
    console.log(`[IT] head got reports (${el()}):\n${String(toHead.detail.text)}`);
    assert.match(String(toHead.detail.text), new RegExp(`^\\[REPORTS task#${leadTaskId} ${lead.name} status=(done|blocked|aborted)\\]`));
    // `[ALL_REPORTS_IN]` 은 여기서 단언하지 않는다 — `thinking.text` 는 MAX_THINKING_CHARS(200자)로 잘리므로
    // 긴 보고에서는 꼬리가 이벤트에 안 남는다(큐에 들어간 본문에는 있다). 그 규칙은 단위 테스트가 본다.

    // ---- 부장 report → 내 책상 ------------------------------------------------------------------
    const reporting = await race(client.waitEvent(head.id, 'reporting', toHead.seq, 420_000, (e) => e.ref.taskId === taskId));
    console.log(`[IT] head reported task#${taskId}: ${JSON.stringify(reporting.detail)} (${el()})`);

    const peek = await Client.connect(info.wsPort, 'peek');
    const snap = (await peek.call<{ snapshot: Snapshot }>('hello', { token: info.token, client: { name: 'peek', version: '0' } })).snapshot;
    peek.close();
    for (const id of [taskId, leadTaskId, workTaskId]) {
      assert.equal(snap.tasks.find((t: Task) => t.id === id), undefined, `task#${id} 는 닫혔다(열린 task 목록에 없다)`);
    }

    assert.ok(fs.existsSync(target), `${FILE} 이 만들어져야 한다: ${target}`);
    console.log(`[IT] ${FILE}: ${JSON.stringify(fs.readFileSync(target, 'utf8'))} (${el()})`);

    // ---- 정리 -----------------------------------------------------------------------------------
    stopApprover();
    stopApprover = undefined;
    await client.call('department.delete', { departmentId: department.id });
    await client.call('daemon.shutdown', {});
    const exited = await waitExit(d.child, 30_000);
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
