// T20 통합 테스트(opt-in): 실제 데몬 + 실제 Codex CLI 로 "출근 → 지시 → 허가 → 파일 → 보고 → 퇴근" 한 바퀴.
//   데몬(임시 포트·임시 dataDir) → department.create(sandbox, headEngine:'codex')  [신뢰 다이얼로그는 InputQueue 가 Enter 로 통과]
//   → idle(화면 부팅 감시, Codex 의 SessionStart 는 첫 프롬프트 때 온다 — D-24)
//   → instruct "셸 명령 \"echo t20 > ../t20.txt\" …"  [workspace 밖 쓰기 → PermissionRequest]
//   → waiting_approval → approval.respond allow → idle → ../t20.txt 존재 확인 → task reported(보고 폴백, T22) → 파일 삭제
//   → clockOut(Ctrl+C) → status exited + codex 프로세스 종료 확인 → daemon.shutdown
// 실행: PIXEL_IT=1 npx tsx --test test/office/codex.integration.test.ts   (bash)
// 전제: dev/spike-0/sandbox 가 Codex 에서 신뢰된 폴더이고 codex 로그인이 끝나 있다.
//       node-pty 는 .ps1/.cmd 셰임을 못 띄우므로 실제 codex.exe 경로를 PIXEL_CODEX_EXE 로 넘긴다.
//
// T42(2026-09-21, 한도 리셋 후) 갱신 — 두 가지를 고쳤다:
//   ① rev 3(T34, D-34) 이후 `team.create`/`member.clockIn` 은 디버그 전용이고 `team.create` 는 `departmentId` 를 요구한다.
//      옛 경로 그대로여서 이 테스트는 한도와 무관하게 -32004 로 죽고 있었다. 지금은 **사용자의 정식 경로**인
//      `department.create{headEngine:'codex'}` 로 Codex 멤버(부장)를 세운다 — 프로세스도 하나뿐이고 `instruct` 에 force 도 필요 없다.
//   ② 보고 폴백(T22 F) 확인을 뒤에 붙였다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexExe } from '../../src/config.js';
import type { DaemonInfo } from '../../src/office/types.js';
import type { Department } from '../../src/store/types.js';
import type { Member, OfficeEvent, Snapshot } from '../../src/store/types.js';
import { Client, IT, SANDBOX, freePort, killTree, pidAlive, sleep, startDaemon, waitExit } from './it-helpers.js';

const TARGET = path.resolve(SANDBOX, '..', 't20.txt'); // workspace(sandbox) 밖 → 승인 필요
const INSTRUCTION = '셸 명령 "echo t20 > ../t20.txt"를 실행해서 상위 폴더에 파일을 만들어줘. 다른 건 하지 마.';

/** npm 전역 설치의 실제 codex.exe. T22 부터 데몬이 스스로 찾으므로(config.resolveCodexExe) 같은 함수를 쓴다. */
function codexExe(): string {
  return resolveCodexExe();
}

test('real daemon + real Codex: clockIn → instruct → waiting_approval → allow → file → clockOut (Ctrl+C×2)', { skip: IT ? false : 'set PIXEL_IT=1 to run', timeout: 600_000 }, async () => {
  assert.ok(fs.existsSync(SANDBOX), `sandbox missing: ${SANDBOX}`);
  const exe = codexExe();
  console.log(`[IT] codex exe: ${exe}`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t20-it-'));
  const [wsPort, hookPort, mcpPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const env = {
    PIXEL_WS_PORT: String(wsPort),
    PIXEL_HOOK_PORT: String(hookPort),
    PIXEL_MCP_PORT: String(mcpPort),
    PIXEL_DATA_DIR: dataDir,
    PIXEL_CODEX_EXE: exe,
  };
  const codexPids: number[] = [];
  let client: Client | undefined;
  const t0 = Date.now();
  const el = () => `${Date.now() - t0}ms`;
  fs.rmSync(TARGET, { force: true });

  const d = startDaemon('d', env);
  try {
    await d.waitLine('listening', (l) => l.includes('[daemon] listening'), 20_000);
    const info = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.json'), 'utf8')) as DaemonInfo;
    client = await Client.connect(info.wsPort, 'c');
    await client.call('hello', { token: info.token, client: { name: 't20-it', version: '0' } });

    // rev 3(T34, D-32/D-34): 사용자가 하는 유일한 생성은 부서다. 부장 엔진을 codex 로 주면 Codex 멤버가 하나 선다.
    const { department, head: member } = await client.call<{ department: Department; head: Member }>('department.create', {
      name: 'it',
      cwd: SANDBOX,
      headEngine: 'codex',
      headName: '코덱스',
    });
    if (member.childPid) codexPids.push(member.childPid);
    console.log(`[IT] department=${department.id} head=${member.id} rank=${member.rank} engine=${member.engine} pid=${member.childPid} (${el()})`);
    assert.equal(member.engine, 'codex');

    // .codex/hooks.json 이 우리 것으로 쓰였는지(Interrupt 포함)
    const hooksFile = path.join(SANDBOX, '.codex', 'hooks.json');
    const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as { description: string; hooks: Record<string, unknown> };
    console.log(`[IT] hooks.json: ${hooks.description} events=${Object.keys(hooks.hooks).join(',')}`);
    assert.equal(hooks.description, 'pixel-office');
    assert.ok(hooks.hooks.Interrupt, 'Codex hooks.json 에 Interrupt 가 있다');

    // 첫 idle 은 **화면 부팅 감시**로 온다 — Codex 의 SessionStart 는 기동이 아니라 첫 프롬프트 제출 때다(T20 함정 1, D-24).
    // 그래서 이 시점의 session_id 는 아직 null 인 것이 정상이다.
    await client.waitStatus(member.id, 'idle', 180_000);
    const snapshotNow = async (tag: string): Promise<Snapshot> => {
      const peek = await Client.connect(info.wsPort, tag);
      const s = (await peek.call<{ snapshot: Snapshot }>('hello', { token: info.token, client: { name: tag, version: '0' } })).snapshot;
      peek.close();
      return s;
    };
    const sidAtBoot = (await snapshotNow('peek0')).members.find((m) => m.id === member.id)!.sessionId;
    console.log(`[IT] boot idle, session_id=${String(sidAtBoot)} (${el()})  ← Codex 는 여기서 null 이 정상(D-24)`);

    // ---- 지시 → workspace 밖 쓰기 → 허가 요청 -------------------------------------------------
    const seq0 = client.lastSeq;
    const { taskId } = await client.call<{ taskId: number }>('member.instruct', { memberId: member.id, text: INSTRUCTION });
    console.log(`[IT] instruct task#${taskId} (${el()})`);
    const approval = await client.waitEvent(member.id, 'waiting_approval', seq0, 300_000);
    const pendingId = approval.ref.approvalId!;
    console.log(`[IT] waiting_approval #${approval.seq} detail=${JSON.stringify(approval.detail)} (${el()})`);
    assert.ok(pendingId, 'waiting_approval 이벤트가 approvalId 를 싣는다');
    assert.match(String(approval.detail.cmd ?? ''), /t20\.txt/);

    await client.call('approval.respond', { pendingId, behavior: 'allow' });
    console.log(`[IT] allow → ${pendingId} (${el()})`);
    const idle = await client.waitEvent(member.id, 'idle', approval.seq, 300_000);
    const said = client
      .events()
      .filter((e: OfficeEvent) => e.kind === 'text' && e.seq > approval.seq && e.seq <= idle.seq)
      .map((e) => String(e.detail.text ?? '').slice(0, 120));
    console.log(`[IT] turn ended (${el()}): ${JSON.stringify(said)}`);
    assert.ok(fs.existsSync(TARGET), `${TARGET} 가 만들어졌다`);
    console.log(`[IT] ${TARGET} = ${JSON.stringify(fs.readFileSync(TARGET, 'utf8'))}`);
    fs.rmSync(TARGET, { force: true });

    // ---- 보고 폴백(T22 / 목록 F): Codex 가 report 도구를 안 불러도 턴 종료 메시지가 task 보고로 승격된다 -------
    const reporting = await client.waitEvent(member.id, 'reporting', approval.seq, 30_000);
    console.log(`[IT] reporting #${reporting.seq} task#${String(reporting.ref.taskId)} ${JSON.stringify(reporting.detail).slice(0, 200)}`);
    assert.equal(reporting.ref.taskId, taskId, '보고가 이 지시의 task 에 달린다');

    // 첫 턴을 돌고 나면 SessionStart 가 와 있다(= `codex resume <id>` 로 복구할 수 있다).
    const sidAfterTurn = (await snapshotNow('peek1')).members.find((m) => m.id === member.id)!.sessionId;
    console.log(`[IT] session_id after first turn = ${String(sidAfterTurn)}`);
    assert.ok(sidAfterTurn, '첫 턴의 SessionStart 로 session_id 를 받았다');

    // ---- 퇴근: Ctrl+C ×2 -------------------------------------------------------------------
    await client.call('member.clockOut', { memberId: member.id });
    await client.waitStatus(member.id, 'exited', 30_000);
    await sleep(1000);
    const alive = member.childPid ? pidAlive(member.childPid) : false;
    console.log(`[IT] clockOut done (${el()}); codex pid ${member.childPid} alive=${alive}`);
    assert.equal(alive, false, 'Ctrl+C ×2 로 codex 가 종료됐다');

    await client.call('daemon.shutdown', {});
    const exited = await waitExit(d.child, 20_000);
    console.log(`[IT] daemon exited=${exited} code=${d.child.exitCode} (${el()})`);
    assert.ok(exited, 'daemon did not exit after daemon.shutdown');
  } finally {
    client?.close();
    if (d.child.exitCode === null) {
      console.log(`[IT] daemon pid ${d.child.pid} still running — killing`);
      killTree(d.child.pid!);
      await waitExit(d.child, 5000);
    }
    await sleep(500);
    // 이 테스트가 띄운 codex 만(멤버 child_pid) 정리한다.
    for (const pid of codexPids) {
      if (pidAlive(pid)) {
        console.log(`[IT] leftover codex pid ${pid} — killing`);
        killTree(pid);
      }
    }
    await sleep(500);
    console.log(`[IT] leftover check: ${codexPids.map((p) => `${p}=${pidAlive(p) ? 'ALIVE' : 'dead'}`).join(' ') || 'none'}`);
    fs.rmSync(TARGET, { force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
