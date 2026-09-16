// T25 통합 테스트(opt-in): 실제 데몬 + 실제 Claude 팀장이 team MCP 의 hire → delegate → (팀원 작업) → report 를 한 바퀴 돈다.
//   데몬(임시 포트·임시 dataDir) → team.create(sandbox, 팀장 '반장') → 팀장 idle
//   → instruct "team MCP 도구로 팀원 '보조'를 hire하고(역할: 파일 작성), 그 팀원에게 delegate 로 'hello25.txt에 hi 라고 써라'를
//      시키고, 보고가 오면 report 로 나에게 결과를 한 줄 요약해라."
//   → 새 멤버 출근(hiredBy leader) → delegating 이벤트 → 팀원에게 [TASK#n from 반장(팀장)] → 팀원이 파일을 쓰고 보고
//   → 팀장에게 [REPORTS task#n … status=done][ALL_REPORTS_IN] → 팀장이 report → reporting 이벤트(사용자 task 종료)
//   → sandbox/hello25.txt 존재 확인 → 정리
// 실행: PIXEL_IT=1 npx tsx --test test/office/teamtools.integration.test.ts   (bash)
// 전제: dev/spike-0/sandbox 가 신뢰된 폴더이고 claude 로그인이 끝나 있다. 허가 요청은 전부 자동 allow.
// 주의: Claude 2.1.270 은 MCP 도구를 지연 로딩(ToolSearch)하므로 지시문에 도구 이름을 적어 둔다(D-22 참고, 아래 TOOL_NAMES).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DaemonInfo } from '../../src/office/types.js';
import type { Member, OfficeEvent, Snapshot, Task, Team } from '../../src/store/types.js';
import { Client, IT, SANDBOX, freePort, killTree, pidAlive, sleep, startDaemon, sweepClaudeByDataDir, waitExit } from './it-helpers.js';

const FILE = 'hello25.txt';
// 도구 이름 줄: Claude 2.1.270 은 MCP 도구를 지연 로딩(ToolSearch)해서 "도구가 없다"고 답하는 경우가 있다(D-22 참고).
// 앱의 팀장 지시문 템플릿(T26a `leaderInstructionTemplate`)도 같은 줄을 들고 있다.
const TOOL_NAMES =
  '도구 이름: mcp__team__hire, mcp__team__dismiss, mcp__team__delegate, mcp__team__report, mcp__team__ask_user (도구 목록에 없으면 ToolSearch로 찾아라).';
const INSTRUCT =
  `team MCP 도구로 팀원 '보조'를 hire하고(역할: 파일 작성), 그 팀원에게 delegate로 '${FILE}에 hi 라고 써라'를 시키고, ` +
  `보고가 오면 report로 나에게 결과를 한 줄 요약해라.\n${TOOL_NAMES}`;

test('real daemon + real Claude leader: hire → delegate → member works → [ALL_REPORTS_IN] → leader report', { skip: IT ? false : 'set PIXEL_IT=1 to run', timeout: 900_000 }, async () => {
  assert.ok(fs.existsSync(SANDBOX), `sandbox missing: ${SANDBOX}`);
  const target = path.join(SANDBOX, FILE);
  fs.rmSync(target, { force: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t25-it-'));
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
    await client.call('hello', { token: info.token, client: { name: 't25-it', version: '0' } });
    stopApprover = client.autoApproveAll();

    const { team, leader } = await client.call<{ team: Team; leader: Member }>('team.create', {
      name: 'it25',
      cwd: SANDBOX,
      leaderEngine: 'claude',
      leaderName: '반장',
    });
    if (leader.childPid) claudePids.push(leader.childPid);
    console.log(`[IT] team=${team.id} leader=${leader.id} pid=${leader.childPid} (${el()})`);
    await client.waitStatus(leader.id, 'idle', 120_000);
    console.log(`[IT] leader idle (${el()})`);

    /** 팀장이 죽으면(hook error·크래시) 몇 분씩 기다리지 않고 바로 실패시킨다. */
    const guard = (async () => {
      const n = await client!.waitFor(
        'leader died',
        (x) => x.method === 'member.status' && x.params.memberId === leader.id && (x.params.status === 'error' || x.params.status === 'exited'),
        900_000,
      ).catch(() => undefined);
      if (n) throw new Error(`leader ${leader.id} died: status=${String(n.params.status)}`);
      return undefined as never;
    })();
    const race = <T>(p: Promise<T>): Promise<T> => Promise.race([p, guard]) as Promise<T>;

    // ---- 지시 → hire → delegate ---------------------------------------------------------------
    const seq0 = client.lastSeq;
    const { taskId } = await client.call<{ taskId: number }>('member.instruct', { memberId: leader.id, text: INSTRUCT });
    console.log(`[IT] instruct task#${taskId} (${el()})`);

    // hire: 새 멤버가 출근한다(member.status 알림에 member 행이 실려 온다).
    const joined = await race(client.waitFor(
      'new member (hired)',
      (n) => n.method === 'member.status' && typeof n.params.member === 'object' && (n.params.member as Member | null)?.hiredBy === 'leader',
      420_000,
    ));
    const worker = joined.params.member as Member;
    if (worker.childPid) claudePids.push(worker.childPid);
    console.log(`[IT] hired ${worker.name} (${worker.id}) engine=${worker.engine} hiredBy=${worker.hiredBy} (${el()})`);
    assert.equal(worker.rank, 'member');
    assert.equal(worker.teamId, team.id);
    const instr = await client.call<{ markdown: string }>('member.instructions.get', { memberId: worker.id });
    console.log(`[IT] worker INSTRUCTIONS.md: ${JSON.stringify(instr.markdown)}`);
    assert.ok(instr.markdown.startsWith('# 역할: '), 'hire 가 역할 줄을 넣는다');

    // delegate: 팀장에게 delegating 이벤트, 팀원에게 [TASK#n from 반장(팀장)]
    const delegating = await race(client.waitEvent(leader.id, 'delegating', seq0, 420_000));
    const subTaskId = delegating.ref.taskId!;
    console.log(`[IT] delegating #${delegating.seq} task#${subTaskId} → ${String(delegating.detail.toName)} (${String(delegating.detail.status)}) (${el()})`);
    const typed = await race(client.waitEvent(worker.id, 'thinking', delegating.seq - 1, 300_000, (e) => String(e.detail.text ?? '').startsWith(`[TASK#${subTaskId} from `)));
    console.log(`[IT] worker got: ${JSON.stringify(typed.detail.text)} (${el()})`);
    assert.match(String(typed.detail.text), new RegExp(`^\\[TASK#${subTaskId} from 반장\\(팀장\\)\\]`));

    // ---- 팀원 작업 → 보고 → [ALL_REPORTS_IN] ----------------------------------------------------
    const reports = await race(client.waitEvent(leader.id, 'thinking', delegating.seq, 480_000, (e) => String(e.detail.text ?? '').startsWith('[REPORTS ')));
    console.log(`[IT] leader got reports (${el()}):\n${String(reports.detail.text)}`);
    assert.match(String(reports.detail.text), new RegExp(`^\\[REPORTS task#${subTaskId} ${worker.name} status=(done|blocked|aborted)\\]`));
    assert.ok(String(reports.detail.text).includes('[ALL_REPORTS_IN]'), '마지막 보고이므로 [ALL_REPORTS_IN] 이 붙는다');

    // ---- 팀장 report → 내 책상 보고 --------------------------------------------------------------
    const reporting = await race(client.waitEvent(leader.id, 'reporting', reports.seq, 300_000, (e) => e.ref.taskId === taskId));
    console.log(`[IT] leader reported task#${taskId}: ${JSON.stringify(reporting.detail)} (${el()})`);

    const peek = await Client.connect(info.wsPort, 'peek');
    const snap = (await peek.call<{ snapshot: Snapshot }>('hello', { token: info.token, client: { name: 'peek', version: '0' } })).snapshot;
    peek.close();
    assert.equal(
      snap.tasks.find((t: Task) => t.id === taskId),
      undefined,
      '사용자 task 는 닫혀서(reported) 열린 task 목록에 없다',
    );
    assert.equal(snap.tasks.find((t: Task) => t.id === subTaskId), undefined, '위임 task 도 닫혔다');

    assert.ok(fs.existsSync(target), `${FILE} 이 만들어져야 한다: ${target}`);
    console.log(`[IT] ${FILE}: ${JSON.stringify(fs.readFileSync(target, 'utf8'))} (${el()})`);

    // ---- 정리 -----------------------------------------------------------------------------------
    stopApprover();
    stopApprover = undefined;
    await client.call('team.delete', { teamId: team.id });
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
