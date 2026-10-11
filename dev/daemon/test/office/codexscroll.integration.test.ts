// 통합 테스트(opt-in, PIXEL_IT=1) — **진짜 codex** 가 휠을 어떻게 받는지(U-07).
// 실행: PIXEL_IT=1 node --import tsx --test test/office/codexscroll.integration.test.ts
//
// 앱의 터미널 탭이 기대는 사실 둘을 못 박아 둔다. CLI 가 바뀌어 이게 깨지면 터미널 스크롤이 다시 죽는다:
//   1. codex 는 전체 화면(alt 버퍼)이고 마우스를 켠다 — attach 화면에 `?1049h ?1003h ?1006h` 가 온다.
//   2. codex 는 **포인터가 대화 영역 위에 있을 때만** 휠로 대화를 넘긴다. 입력창·바닥줄 행에 대고 굴린 휠은 무시한다.
//      (claude 는 위치를 안 본다 — 그래서 앱이 위치를 틀리게 보내도 claude 에서는 드러나지 않았다.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonInfo } from '../../src/office/types.js';
import type { Department, Member, Snapshot } from '../../src/store/types.js';
import { Client, IT, SANDBOX, itEnv, killTree, sleep, startDaemon, waitExit } from './it-helpers.js';

const COLS = 100;
const ROWS = 30;
const visible = (s: string) => s.replace(/\x1b\[[0-9;?<>=]*[a-zA-Z]/g, '').replace(/\x1b[()][0-9A-B]/g, '');
const lineRange = (s: string) => {
  const m = visible(s).match(/LINE-\d+/g) ?? [];
  return `${m[0] ?? '-'}…${m.at(-1) ?? '-'}`;
};

test('real codex: 휠은 대화 영역 위에서만 대화를 넘긴다 — 바닥 행에서는 무시', { skip: IT ? false : 'set PIXEL_IT=1 to run', timeout: 600_000 }, async () => {
  assert.ok(fs.existsSync(SANDBOX), `sandbox missing: ${SANDBOX}`);
  const { dataDir, env } = await itEnv('u07');
  const d = startDaemon('d', env);
  let client: Client | undefined;
  try {
    await d.waitLine('listening', (l) => l.includes('[daemon] listening'), 20_000);
    const info = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.json'), 'utf8')) as DaemonInfo;
    client = await Client.connect(info.wsPort, 'c');
    const c = client;
    await c.call<{ snapshot: Snapshot }>('hello', { token: info.token, client: { name: 'u07-it', version: '0' } });
    const { head } = await c.call<{ department: Department; head: Member }>('department.create', { name: 'it-u07', cwd: SANDBOX, headEngine: 'codex', headName: '코덱' });
    await c.waitStatus(head.id, 'idle', 120_000);
    const mark = c.lastSeq;
    await c.call('member.instruct', {
      memberId: head.id,
      text: '팀을 만들거나 위임하지 말고, 도구도 쓰지 말고, 1부터 70까지 숫자를 한 줄에 하나씩 "LINE-숫자" 형태로 출력해. 다른 말은 하지 마.',
    });
    await c.waitEvent(head.id, 'idle', mark, 240_000);
    await sleep(1500);

    const screen = async () => (await c.call<{ screen: string }>('member.attach', { memberId: head.id, cols: COLS, rows: ROWS })).screen;
    await screen(); // 첫 attach 가 크기를 맞춘다
    await sleep(1500);
    const first = await screen();
    const modes = [...new Set([...first.matchAll(/\x1b\[\?([0-9;]+)h/g)].map((m) => `?${m[1]}h`))];
    console.log(`[IT] attach modes = ${modes.join(' ')}`);
    for (const m of ['?1049h', '?1003h', '?1006h']) assert.ok(modes.includes(m), `codex 전체 화면 · 마우스: ${m}`);

    const wheel = async (x: number, y: number, up: boolean, n = 8) => {
      for (let i = 0; i < n; i++) {
        await c.call('member.type', { memberId: head.id, data: `\x1b[<${up ? 64 : 65};${x};${y}M` });
        await sleep(40);
      }
      await sleep(1200);
      return screen();
    };

    // "맨 아래를 보고 있는가" 는 **보이는 마지막 줄**로 판단한다 — 첫 줄은 화면을 다시 그릴 때(바닥줄 높이 등) 달라질 수 있다.
    const lastLine = (s: string) => Number((visible(s).match(/LINE-(\d+)/g) ?? []).at(-1)?.slice(5) ?? -1);
    console.log(`[IT] 처음 = ${lineRange(first)}`);
    assert.equal(lastLine(first), 70, '턴이 끝난 화면은 맨 아래를 보고 있다');

    // 바닥 행(입력창·상태줄)에 대고 굴린 휠 — 앱이 예전에 보내던 위치다. 넘어가지 않는다.
    const atBottomRow = await wheel(COLS, ROWS, true);
    console.log(`[IT] 휠업 @ 바닥 행(${COLS},${ROWS}) → ${lineRange(atBottomRow)}`);
    assert.equal(lastLine(atBottomRow), 70, '바닥 행에 대고 굴린 휠은 codex 가 무시한다');
    // 첫 행(트랙패드가 예전에 보내던 1;1)도 마찬가지다.
    const atTopRow = await wheel(1, 1, true);
    console.log(`[IT] 휠업 @ (1,1) → ${lineRange(atTopRow)}`);
    assert.equal(lastLine(atTopRow), 70, '(1,1) 에 대고 굴린 휠도 무시한다');

    // 대화 영역 위에서 굴리면 넘어간다.
    const scrolled = await wheel(20, 10, true);
    console.log(`[IT] 휠업 @ 대화 영역(20,10) → ${lineRange(scrolled)}`);
    assert.ok(lastLine(scrolled) < 70, '대화 영역 위의 휠은 대화를 위로 넘긴다');
    const back = await wheel(20, 10, false, 16);
    console.log(`[IT] 휠다운 @ 대화 영역 → ${lineRange(back)}`);
    assert.equal(lastLine(back), 70, '아래로 굴리면 돌아온다');

    await c.call('member.clockOut', { memberId: head.id });
    await c.call('daemon.shutdown', {});
    assert.ok(await waitExit(d.child, 30_000), 'daemon did not exit');
  } finally {
    client?.close();
    if (d.child.exitCode === null) {
      killTree(d.child.pid!);
      await waitExit(d.child, 5000);
    }
    await sleep(300);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
