// T20 통합 테스트(opt-in): 실제 데몬 + 실제 Codex CLI 로 "출근 → 지시 → 허가 → 파일 → 퇴근(Ctrl+C×2)" 한 바퀴.
//   데몬(임시 포트·임시 dataDir) → team.create(sandbox) → clockIn(codex)  [신뢰 다이얼로그는 InputQueue 가 Enter 로 통과]
//   → idle → instruct "셸 명령 \"echo t20 > ../t20.txt\" …"  [workspace 밖 쓰기 → PermissionRequest]
//   → waiting_approval → approval.respond allow → idle → ../t20.txt 존재 확인 → 파일 삭제
//   → clockOut(Ctrl+C ×2) → status exited + codex 프로세스 종료 확인 → daemon.shutdown
// 실행: PIXEL_IT=1 npx tsx --test test/office/codex.integration.test.ts   (bash)
// 전제: dev/spike-0/sandbox 가 Codex 에서 신뢰된 폴더이고 codex 로그인이 끝나 있다.
//       node-pty 는 .ps1/.cmd 셰임을 못 띄우므로 실제 codex.exe 경로를 PIXEL_CODEX_EXE 로 넘긴다.
//
// ⚠ 2026-09-16 현재 ChatGPT 계정이 **사용량 한도**에 걸려 모델 턴이 안 돈다("You've hit your usage limit … try again at
// Sep 21st, 2026 1:58 PM"). 그래서 이 테스트는 waiting_approval 에서 타임아웃한다 — 실기동 확인은 2026-09-21 이후로 미룬다.
// (한도와 무관한 부분: 출근·hooks.json·부팅 idle·지시 주입·SessionEnd·Ctrl+C 종료는 T20 worklog 에 실행 로그로 남겼다.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexExe } from '../../src/config.js';
import type { DaemonInfo } from '../../src/office/types.js';
import type { Member, OfficeEvent, Snapshot, Team } from '../../src/store/types.js';
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

    const { team } = await client.call<{ team: Team }>('team.create', { name: 'it', cwd: SANDBOX, leaderEngine: 'codex', allowedEngines: ['claude', 'codex'] });
    const { member } = await client.call<{ member: Member }>('member.clockIn', { teamId: team.id, engine: 'codex', name: '코덱스' });
    if (member.childPid) codexPids.push(member.childPid);
    console.log(`[IT] clockIn member=${member.id} pid=${member.childPid} (${el()})`);

    // .codex/hooks.json 이 우리 것으로 쓰였는지(Interrupt 포함)
    const hooksFile = path.join(SANDBOX, '.codex', 'hooks.json');
    const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as { description: string; hooks: Record<string, unknown> };
    console.log(`[IT] hooks.json: ${hooks.description} events=${Object.keys(hooks.hooks).join(',')}`);
    assert.equal(hooks.description, 'pixel-office');
    assert.ok(hooks.hooks.Interrupt, 'Codex hooks.json 에 Interrupt 가 있다');

    // SessionStart → idle (신뢰 다이얼로그가 뜨면 InputQueue 가 Enter 로 통과)
    await client.waitStatus(member.id, 'idle', 180_000);
    const snap0 = (await client.call<{ snapshot: Snapshot }>('snapshot', {})).snapshot;
    const sid = snap0.members.find((m) => m.id === member.id)!.sessionId;
    console.log(`[IT] idle, session_id=${sid} (${el()})`);
    assert.ok(sid, 'SessionStart 로 session_id 를 받았다');

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
