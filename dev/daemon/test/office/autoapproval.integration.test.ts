// 통합 테스트(opt-in, PIXEL_IT=1) — **진짜 claude** 로 U-02(허가 방식) · U-05(세션 모델) · U-03(attach 의 마우스 인코딩)을 본다.
// 실행: PIXEL_IT=1 node --import tsx --test test/office/autoapproval.integration.test.ts
//
// 단위 테스트는 "우리가 생각한 페이로드" 로 돈다. 여기서 보는 것은 **CLI 가 실제로 보내는 것**이다:
//   - 편집 도구의 `tool_input.file_path` 가 절대 경로로 오는가, 그게 "폴더 안" 으로 판정되는가
//   - 자동 허가 응답(`allow`)을 CLI 가 받아들여 카드 없이 실행하는가
//   - statusLine·hook 의 `model` 이 멤버 사용량에 실리는가
//   - `member.attach` 의 화면에 `?1006h` 가 붙어 오는가(전체 화면 렌더러일 때)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonInfo } from '../../src/office/types.js';
import type { Department, Member, OfficeEvent, Snapshot } from '../../src/store/types.js';
import { Client, IT, SANDBOX, itEnv, killTree, pidAlive, sleep, startDaemon, sweepClaudeByDataDir, waitExit } from './it-helpers.js';

const FILE = path.join(SANDBOX, 't52-auto.txt');
const DIR = path.join(SANDBOX, 't52-auto-dir');
const DIRECT = '팀을 만들거나 위임하지 말고 네가 직접 해라. 그 외에는 아무것도 하지 마라.';

test(
  'real claude: edits → 폴더 안 Write 는 카드 없이 · trust → mkdir 는 카드 없이, rm -rf 는 카드 · 모델이 사용량에 실린다',
  { skip: IT ? false : 'set PIXEL_IT=1 to run', timeout: 600_000 },
  async () => {
    assert.ok(fs.existsSync(SANDBOX), `sandbox missing: ${SANDBOX}`);
    fs.rmSync(FILE, { force: true });
    fs.rmSync(DIR, { recursive: true, force: true });
    const { dataDir, env } = await itEnv('t52');
    const claudePids: number[] = [];
    let client: Client | undefined;
    const t0 = Date.now();
    const el = () => `${Date.now() - t0}ms`;
    const d = startDaemon('d', env);
    try {
      await d.waitLine('listening', (l) => l.includes('[daemon] listening'), 20_000);
      const info = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.json'), 'utf8')) as DaemonInfo;
      client = await Client.connect(info.wsPort, 'c');
      const c = client;
      const hello = await c.call<{ snapshot: Snapshot }>('hello', { token: info.token, client: { name: 't52-it', version: '0' } });
      const eventsOf = (memberId: string): OfficeEvent[] =>
        c.notifications.filter((n) => n.method === 'event' && n.params.memberId === memberId).map((n) => n.params as unknown as OfficeEvent);

      // ── ① edits 로 부서를 만든다 ────────────────────────────────────────────────
      const { department, head } = await c.call<{ department: Department; head: Member }>('department.create', {
        name: 'it52',
        cwd: SANDBOX,
        headEngine: 'claude',
        headName: '자동이',
        approvalPolicy: 'edits',
      });
      if (head.childPid) claudePids.push(head.childPid);
      assert.equal(department.approvalPolicy, 'edits');
      await c.waitStatus(head.id, 'idle', 90_000);
      console.log(`[IT] idle (${el()})`);

      // U-05: 첫 턴 전에도 모델을 안다(SessionStart hook · 첫 statusLine).
      let model: unknown;
      for (let i = 0; i < 50 && !model; i++) {
        model = c.notifications.filter((n) => n.method === 'usage.member' && n.params.memberId === head.id).at(-1)?.params.model;
        if (!model) await sleep(200);
      }
      console.log(`[IT] U-05 model = ${JSON.stringify(model)} (${el()})`);
      assert.ok(model && typeof (model as { label?: unknown }).label === 'string', '멤버 사용량에 model{label} 이 실려 온다');

      // ── ② 폴더 안 Write → 카드 없이 ──────────────────────────────────────────────
      let mark = hello.snapshot.seq;
      await c.call('member.instruct', { memberId: head.id, text: `${DIRECT} Write 도구로 t52-auto.txt 파일을 만들고 내용은 hello 한 줄로 해라. 셸은 쓰지 마라.` });
      const idle1 = await c.waitEvent(head.id, 'idle', mark, 240_000);
      const turn1 = eventsOf(head.id).filter((e) => e.seq > mark && e.seq <= idle1.seq);
      console.log(`[IT] turn1 kinds = ${turn1.map((e) => `${e.kind}${e.detail.auto ? `(auto:${String(e.detail.auto)})` : ''}`).join(' ')} (${el()})`);
      assert.ok(fs.existsSync(FILE), '파일이 만들어졌다');
      assert.equal(turn1.some((e) => e.kind === 'waiting_approval'), false, 'edits: 폴더 안 편집은 카드가 뜨지 않는다');
      const autoEdit = turn1.find((e) => e.detail.auto === 'edit-in-cwd');
      assert.ok(autoEdit, '자동 허가 기록(detail.auto = edit-in-cwd)이 남는다');
      console.log(`[IT] auto edit detail = ${JSON.stringify(autoEdit.detail)}`);

      // ── ③ trust 로 바꾼다 → 평범한 셸은 카드 없이 ─────────────────────────────────
      const upd = await c.call<{ department: Department }>('department.update', { departmentId: department.id, approvalPolicy: 'trust' });
      assert.equal(upd.department.approvalPolicy, 'trust');
      mark = idle1.seq;
      await c.call('member.instruct', { memberId: head.id, text: `${DIRECT} 셸 명령 "mkdir t52-auto-dir" 하나만 실행해라.` });
      const idle2 = await c.waitEvent(head.id, 'idle', mark, 240_000);
      const turn2 = eventsOf(head.id).filter((e) => e.seq > mark && e.seq <= idle2.seq);
      console.log(`[IT] turn2 kinds = ${turn2.map((e) => `${e.kind}${e.detail.auto ? `(auto:${String(e.detail.auto)})` : ''}`).join(' ')} (${el()})`);
      assert.ok(fs.existsSync(DIR), '폴더가 만들어졌다');
      assert.equal(turn2.some((e) => e.kind === 'waiting_approval'), false, 'trust: 평범한 셸은 카드가 뜨지 않는다');
      // claude 가 mkdir 을 스스로 허용 목록으로 넘기면 PermissionRequest 자체가 안 온다 — 그때는 auto 기록도 없다(정상).
      console.log(`[IT] turn2 auto records = ${turn2.filter((e) => e.detail.auto).length}`);

      // ── ④ trust 에서도 위험한 것은 묻는다 ────────────────────────────────────────
      mark = idle2.seq;
      await c.call('member.instruct', { memberId: head.id, text: `${DIRECT} 셸 명령 "rm -rf t52-auto-dir" 하나만 실행해라.` });
      const approval = await c.waitEvent(head.id, 'waiting_approval', mark, 240_000);
      console.log(`[IT] waiting_approval = ${JSON.stringify(approval.detail)} (${el()})`);
      assert.match(String(approval.detail.cmd ?? ''), /rm -rf/);
      assert.ok(approval.ref.approvalId, 'trust 에서도 rm -rf 는 카드가 뜬다');
      await c.call('approval.respond', { pendingId: approval.ref.approvalId, behavior: 'allow' });
      await c.waitEvent(head.id, 'idle', approval.seq, 240_000);
      assert.equal(fs.existsSync(DIR), false, '허가한 뒤에 지워졌다');

      // U-05: 턴이 돈 뒤에는 statusLine 이 준 표시 이름(`display_name`)으로 바뀌어 있다 — hook 은 id 만 안다.
      const finalModel = c.notifications.filter((n) => n.method === 'usage.member' && n.params.memberId === head.id).at(-1)?.params.model as
        | { id?: string; label?: string }
        | undefined;
      console.log(`[IT] U-05 model after turns = ${JSON.stringify(finalModel)}`);
      assert.ok(finalModel?.label, '턴 뒤에도 모델이 실려 있다');

      // ── U-03: attach 화면의 모드 ────────────────────────────────────────────────
      const attach = await c.call<{ screen: string }>('member.attach', { memberId: head.id, cols: 120, rows: 40 });
      const modes = [...new Set([...attach.screen.matchAll(/\x1b\[\?([0-9;]+)h/g)].map((m) => `?${m[1]}h`))];
      console.log(`[IT] U-03 attach modes = ${modes.join(' ')}`);
      if (modes.includes('?1049h')) {
        assert.ok(modes.includes('?1006h'), '전체 화면 렌더러면 마우스 인코딩(?1006h)이 attach 화면에 실려 온다');
      } else {
        console.log('[IT] U-03: 이 claude 는 전체 화면 렌더러가 아니다(alt 버퍼 없음) — 인코딩 검사를 건너뛴다');
      }

      await c.call('member.clockOut', { memberId: head.id });
      await c.waitStatus(head.id, 'exited', 20_000);
      await c.call('daemon.shutdown', {});
      assert.ok(await waitExit(d.child, 20_000), 'daemon did not exit');
    } finally {
      client?.close();
      if (d.child.exitCode === null) {
        killTree(d.child.pid!);
        await waitExit(d.child, 5000);
      }
      for (const pid of sweepClaudeByDataDir(dataDir, claudePids)) if (pidAlive(pid)) killTree(pid);
      fs.rmSync(FILE, { force: true });
      fs.rmSync(DIR, { recursive: true, force: true });
      await sleep(300);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  },
);
