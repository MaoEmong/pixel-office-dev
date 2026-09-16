// T22 실기동 진단(테스트 러너 대상 아님): 실제 데몬 + 실제 Codex 로 **TeamTools MCP 주입**을 눈으로 확인한다.
//   데몬(임시 포트·임시 dataDir) → team.create(sandbox) → clockIn(codex, PIXEL_CODEX_EXE 없이 자동 탐지)
//   → 부팅 idle → `/mcp` 슬래시 명령 → 화면 캡처(team 서버가 connected 로 보이고 ask_user 도구가 있어야 한다)
//   → `/status` 캡처 → 퇴근 → 데몬 종료.
// 모델 턴은 필요 없다(사용량 한도 2026-09-21 13:58 와 무관하게 돌아간다).
//
// 실행: cd dev/daemon && npx tsx test/office/tools/t22-live.ts [cwd]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScreenModel } from '../../../src/screen/ScreenModel.js';
import { resolveCodexExe } from '../../../src/config.js';
import type { DaemonInfo } from '../../../src/office/types.js';
import type { Member, Team } from '../../../src/store/types.js';
import { Client, SANDBOX, freePort, killTree, sleep, startDaemon, waitExit } from '../it-helpers.js';

const cwd = path.resolve(process.argv[2] || SANDBOX);
const COLS = 120;
const ROWS = 40;

function banner(title: string, body: string): void {
  console.log(`\n--- ${title} ---\n${body}\n--- END ${title} ---\n`);
}

async function main(): Promise<void> {
  console.log(`[T22] codex exe (resolveCodexExe): ${resolveCodexExe()}`);
  console.log(`[T22] cwd: ${cwd}`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t22-live-'));
  const [wsPort, hookPort, mcpPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const d = startDaemon('d', {
    PIXEL_WS_PORT: String(wsPort),
    PIXEL_HOOK_PORT: String(hookPort),
    PIXEL_MCP_PORT: String(mcpPort),
    PIXEL_DATA_DIR: dataDir,
  });
  let client: Client | undefined;
  let member: Member | undefined;
  let pid = 0;
  try {
    await d.waitLine('listening', (l) => l.includes('[daemon] listening'), 20_000);
    const info = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.json'), 'utf8')) as DaemonInfo;
    client = await Client.connect(info.wsPort, 'c');
    await client.call('hello', { token: info.token, client: { name: 't22-live', version: '0' } });
    const { team } = await client.call<{ team: Team }>('team.create', { name: 't22', cwd, leaderEngine: 'codex', allowedEngines: ['codex'] });
    const res = await client.call<{ member: Member }>('member.clockIn', { teamId: team.id, engine: 'codex', name: '코덱스' });
    member = res.member;
    pid = member.childPid ?? 0;
    console.log(`[T22] clockIn ${member.id} pid=${pid} token=${member.memberToken}`);
    console.log(`[T22] expected MCP url: http://127.0.0.1:${info.mcpPort}/mcp/${member.memberToken}`);

    // 화면은 attach 로 받아(직렬화 ANSI) 우리 ScreenModel 에 다시 넣는다 → 데몬이 보는 것과 같은 평문.
    const screen = new ScreenModel({ engine: 'codex', cols: COLS, rows: ROWS });
    const attached = await client.call<{ screen: string }>('member.attach', { memberId: member.id, cols: COLS, rows: ROWS });
    await screen.feed(attached.screen);
    client.ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as { method?: string; params?: { memberId: string; data: string } };
      if (msg.method === 'term' && msg.params?.memberId === member!.id) void screen.feed(msg.params.data);
    });
    const frame = () => screen.trimmedLines().join('\n');

    await client.waitStatus(member.id, 'idle', 180_000);
    console.log('[T22] boot idle');
    await sleep(1500);
    banner('BOOT SCREEN', frame());

    // /mcp — MCP 서버 목록. 슬래시 팝업이 뜬 뒤 Enter 로 실행.
    await client.call('member.type', { memberId: member.id, data: '/mcp' });
    await sleep(1200);
    banner('AFTER TYPING /mcp', frame());
    await client.call('member.type', { memberId: member.id, data: '\r' });
    for (const wait of [2000, 3000, 5000]) {
      await sleep(wait);
      banner(`/mcp +${wait}ms`, frame());
    }

    // /mcp verbose — 서버별 도구 이름까지(team 의 ask_user 확인).
    await client.call('member.type', { memberId: member.id, data: '/mcp verbose' });
    await sleep(1200);
    await client.call('member.type', { memberId: member.id, data: '\r' });
    await sleep(4000);
    banner('/mcp verbose', frame());

    // /status — 세션 요약(도구 수·MCP 상태가 보이는 경우가 있다).
    await client.call('member.type', { memberId: member.id, data: '/status' });
    await sleep(1000);
    await client.call('member.type', { memberId: member.id, data: '\r' });
    await sleep(3000);
    banner('/status', frame());

    await client.call('member.clockOut', { memberId: member.id });
    await sleep(1500);
    console.log(`[T22] clockOut done; codex alive=${pid ? isAlive(pid) : 'n/a'}`);
  } catch (err) {
    console.error('[T22] FAILED:', err);
  } finally {
    try {
      await client?.call('daemon.shutdown', {});
    } catch {
      /* 이미 죽었을 수 있다 */
    }
    client?.close();
    const ended = await waitExit(d.child, 10_000);
    if (!ended && d.child.pid) killTree(d.child.pid);
    if (pid && isAlive(pid)) killTree(pid);
    console.log(`[T22] daemon exited=${ended} code=${d.child.exitCode}`);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

await main();
process.exit(0);
