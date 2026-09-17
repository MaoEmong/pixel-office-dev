// T30 ④: 프로세스 비정상 종료(우리가 시킨 게 아닌 종료) → status error + `error{summary:'process exited (code N)'}`,
// 그 뒤 `member.rehire` 는 **이전 세션을 이어서**(`--resume <sessionId>`) 다시 띄운다. 앱은 이 status 로 오류 포즈와
// 재고용 배너를 그린다(dev/app/lib/panel/member_gone_banner.dart).
// T30 ⑤: 보존 정리 일일 타이머(D-39) — 기동 때 한 번 + 주기마다, unref 라 데몬을 붙잡지 않는다.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office } from '../../src/office/Office.js';
import { RPC_ERROR } from '../../src/office/errors.js';
import { Store } from '../../src/store/Store.js';
import type { Member, OfficeEvent } from '../../src/store/types.js';
import { FakeMcp, FakePty, FakeReceiver, fakeReq, seedDeptTeam } from './fakes.js';

const SID = 'sess-crash-1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('T30 크래시 → 오류 상태 → 재고용', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let office: Office;
  let teamId: string;
  let events: OfficeEvent[];
  let member: Member;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-t30-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    office = new Office({
      config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 },
      store,
      pty,
      receiver,
      mcp: new FakeMcp(),
      retentionIntervalMs: 0,
    });
    events = [];
    office.on('event', (e) => events.push(e));
    await office.start();
    teamId = seedDeptTeam(store, { name: 'alpha', cwd: dataDir, maxMembers: 3 }).team.id;
    member = office.clockIn({ teamId, engine: 'claude', name: '이음' });
    // SessionStart 로 session_id 를 남긴다 — 재고용이 --resume 할 수 있게.
    receiver.emit(
      'hook',
      fakeReq(member.memberToken, 'SessionStart', { session_id: SID, hook_event_name: 'SessionStart', source: 'startup' }).req,
    );
  });
  afterEach(async () => {
    await office.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('taskkill 모양의 강제 종료(code 1) → status error + error 이벤트', async () => {
    assert.equal(store.getMember(member.id)!.sessionId, SID);
    pty.exit(member.id, 1);
    await sleep(20);

    const m = store.getMember(member.id)!;
    assert.equal(m.status, 'error');
    assert.equal(m.childPid, null);
    const err = events.filter((e) => e.kind === 'error');
    assert.equal(err.length, 1);
    assert.equal(err[0]!.detail.summary, 'process exited (code 1)');
    assert.equal(err[0]!.detail.exitCode, 1);
  });

  test('오류 상태에서 재고용 → 같은 멤버 토큰 + --resume <sessionId>', async () => {
    pty.exit(member.id, 1);
    await sleep(20);
    assert.equal(store.getMember(member.id)!.status, 'error');

    const re = await office.rehire(member.id);
    assert.equal(re.status, 'starting');
    const spawn = pty.spawns.at(-1)!;
    assert.equal(spawn.memberId, member.id);
    assert.equal(spawn.resumeSessionId, SID, '이전 대화를 이어받는다');
    assert.equal(spawn.memberToken, member.memberToken, 'hook·MCP 토큰은 그대로');
    assert.equal(spawn.cwd, member.cwd);

    // 살아 있는 멤버를 또 재고용하려 하면 -32003(재시작은 member.restart).
    await assert.rejects(office.rehire(member.id), (e: { code: number }) => e.code === RPC_ERROR.BAD_STATE);
  });

  test('session_id 가 없으면 재고용은 새 세션으로 시작한다', async () => {
    const fresh = office.clockIn({ teamId, engine: 'claude', name: '새싹' });
    pty.exit(fresh.id, 3221225786); // Ctrl+C 로 죽은 Windows 프로세스
    await sleep(20);
    assert.equal(store.getMember(fresh.id)!.status, 'error');
    await office.rehire(fresh.id);
    assert.equal(pty.spawns.at(-1)!.resumeSessionId, undefined);
  });

  test('정상 종료(code 0)는 exited — 오류가 아니다', async () => {
    const other = office.clockIn({ teamId, engine: 'claude', name: '퇴근' });
    pty.exit(other.id, 0);
    await sleep(20);
    assert.equal(store.getMember(other.id)!.status, 'exited');
  });
});

describe('T30 보존 정리 타이머 (D-39)', () => {
  let dataDir: string;
  let office: Office;
  let store: Store;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-t30r-'));
    store = new Store(':memory:');
  });
  afterEach(async () => {
    await office.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('start() 가 한 번 돌리고, 주기마다 다시 돈다 — 타이머는 unref', async () => {
    let calls = 0;
    store.pruneRetention = () => {
      calls++;
      return { events: 0, pending: 0, tasks: 0 };
    };
    office = new Office({
      config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 },
      store,
      pty: new FakePty(),
      receiver: new FakeReceiver(),
      mcp: new FakeMcp(),
      retentionIntervalMs: 20,
    });
    await office.start();
    assert.equal(calls, 1, '기동 때 한 번');
    await sleep(70);
    assert.ok(calls >= 3, `주기마다 다시 돈다 (calls=${calls})`);
  });

  test('정리가 던져도 기동은 막히지 않는다', async () => {
    store.pruneRetention = () => {
      throw new Error('디스크 이상');
    };
    office = new Office({
      config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 },
      store,
      pty: new FakePty(),
      receiver: new FakeReceiver(),
      mcp: new FakeMcp(),
      retentionIntervalMs: 0,
    });
    const notices: string[] = [];
    office.on('notice', (l, m) => notices.push(`${l}: ${m}`));
    const warn = console.warn;
    console.warn = () => {};
    try {
      await office.start();
    } finally {
      console.warn = warn;
    }
    assert.ok(office.daemonInfo, '데몬은 떴다');
    assert.ok(
      notices.some((n) => n.startsWith('warn: 보존 정리 실패')),
      notices.join(' | '),
    );
  });
});
