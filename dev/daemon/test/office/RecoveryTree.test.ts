// T36 — 재시작 복구의 트리 순서(D-32 rev 3). T09 의 단일 계층 복구는 Recovery.test.ts 그대로.
//   ① 되살리는 순서는 **부장 → 팀장 → 팀원** — 부하가 먼저 깨어나 보고하면 받을 상사가 아직 없다
//   ② 상위 직급의 `[RESUMED]` 에는 "맡긴 일(보고 대기)" 과 "직속 부하" 가 실린다. 잎은 배정 task 만
//   ③ 상사가 되살아나지 못하면 그 부하는 `error{summary:'restart: parent gone'}` 이고 재스폰하지 않는다
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office, buildResumedText } from '../../src/office/Office.js';
import type { OrphanOps } from '../../src/office/orphans.js';
import { Store } from '../../src/store/Store.js';
import type { Member, OfficeEvent, Task } from '../../src/store/types.js';
import { loadFixture } from '../screen/helpers.js';
import { FakePty, FakeReceiver, fakeReq, seedDeptTeam } from './fakes.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readyScreen = () => loadFixture('claude-ready.txt').join('\r\n');
/** paste + Enter 한 항목이 나가는 데 걸리는 시간(다른 office 테스트와 같은 값). */
const FLUSH_MS = 700;

interface Seed {
  head: Member;
  lead: Member;
  w1: Member;
  w2: Member;
  toLead: Task;
  toW1: Task;
}

/** 이전 기동이 남긴 트리(부장 → 팀장 → 팀원 둘). 전부 session_id 가 있어 되살아날 수 있다. */
function seedTree(store: Store, cwd: string): Seed {
  const { department, team } = seedDeptTeam(store, { name: 'alpha', cwd, maxMembers: 4 });
  const mk = (name: string, rank: Member['rank'], parentId: string | null, teamId: string | null, sessionId: string | null) =>
    store.createMember({
      departmentId: department.id,
      teamId,
      parentId,
      name,
      rank,
      engine: 'claude',
      cwd,
      hiredBy: parentId ? 'leader' : 'user',
      status: 'idle',
      sessionId,
    });
  // 일부러 **잎을 먼저** 넣는다 — listMembers 순서(rowid)를 그대로 쓰면 팀원이 먼저 깨어난다.
  const w1 = mk('이음', 'member', null, team.id, 'sess-w1');
  const w2 = mk('하루', 'member', null, team.id, 'sess-w2');
  const lead = mk('반장', 'lead', null, team.id, 'sess-lead');
  const head = mk('국장', 'head', null, null, 'sess-head');
  store.updateMember(lead.id, { parentId: head.id });
  store.updateMember(w1.id, { parentId: lead.id });
  store.updateMember(w2.id, { parentId: lead.id });
  const toLead = store.createTask({ departmentId: department.id, fromMember: head.id, toMember: lead.id, instruction: '설계', status: 'assigned' });
  const toW1 = store.createTask({ departmentId: department.id, fromMember: lead.id, toMember: w1.id, instruction: '빌드 돌려라', status: 'assigned' });
  return { head: store.getMember(head.id)!, lead: store.getMember(lead.id)!, w1: store.getMember(w1.id)!, w2: store.getMember(w2.id)!, toLead, toW1 };
}

describe('재시작 복구의 트리 순서 (T36)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let office: Office;
  let events: OfficeEvent[];
  let notices: string[];

  const noOrphans: OrphanOps = { alive: () => false, name: () => undefined, kill: () => {} };
  const newOffice = () => {
    office = new Office({
      config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 },
      store,
      pty,
      receiver,
      version: 't36',
      recovery: { orphanOps: noOrphans },
    });
    events = [];
    notices = [];
    office.on('event', (e) => events.push(e));
    office.on('notice', (l, m) => notices.push(`${l}: ${m}`));
    return office;
  };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t36r-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
  });
  afterEach(async () => {
    await office?.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const pastedTo = (m: Member) => pty.session(m.id).pastes;
  /** 되살아난 세션이 SessionStart + 준비 화면을 보내면 큐가 흐른다(= [RESUMED] 가 pty 로 나간다). */
  async function letQueuesFlow(...members: Member[]): Promise<void> {
    for (const m of members) {
      receiver.emit(
        'hook',
        fakeReq(m.memberToken, 'SessionStart', { session_id: m.sessionId ?? 'x', hook_event_name: 'SessionStart', cwd: m.cwd, source: 'resume' }).req,
      );
      pty.data(m.id, readyScreen());
    }
    await sleep(FLUSH_MS);
  }

  test('트리 순서: 행 순서가 잎부터여도 부장 → 팀장 → 팀원 순으로 재스폰한다', async () => {
    const s = seedTree(store, dataDir);
    newOffice();
    await office.start();

    assert.deepEqual(
      pty.spawns.map((o) => o.memberId),
      [s.head.id, s.lead.id, s.w1.id, s.w2.id],
      '부모가 먼저 떠 있어야 자식 보고를 받는다',
    );
    assert.deepEqual(office.recoveryResult!.failed, []);
    assert.equal(office.recoveryResult!.resumed.length, 4);
  });

  test('[RESUMED]: 상위는 "맡긴 일 + 직속 부하", 잎은 배정 task 만', async () => {
    const s = seedTree(store, dataDir);
    newOffice();
    await office.start();
    await letQueuesFlow(s.head, s.lead, s.w1);

    const headText = pastedTo(s.head)[0] ?? '';
    assert.match(headText, /맡긴 일\(보고 대기\): task#\d+ → 설계/, headText);
    assert.match(headText, /직속 부하: 반장\(팀장\)/, headText);

    const leadText = pastedTo(s.lead)[0] ?? '';
    assert.match(leadText, /진행 중이던 작업: task#\d+: 설계/, leadText);
    assert.match(leadText, /맡긴 일\(보고 대기\): task#\d+ → 빌드 돌려라/, leadText);
    assert.match(leadText, /직속 부하: 이음\(팀원\), 하루\(팀원\)/, leadText);

    const w1Text = pastedTo(s.w1)[0] ?? '';
    assert.match(w1Text, /진행 중이던 작업: task#\d+: 빌드 돌려라/, w1Text);
    assert.ok(!w1Text.includes('맡긴 일'), '잎에는 맡긴 일이 없다');
    assert.ok(!w1Text.includes('직속 부하'), '잎에는 직속 부하가 없다');
  });

  test('상사가 되살아나지 못하면 부하는 error{restart: parent gone} 이고 재스폰하지 않는다', async () => {
    const s = seedTree(store, dataDir);
    store.updateMember(s.lead.id, { sessionId: null }); // 팀장은 되살릴 세션이 없다 → error
    newOffice();
    await office.start();

    assert.equal(store.getMember(s.lead.id)!.status, 'error');
    for (const w of [s.w1, s.w2]) {
      assert.equal(store.getMember(w.id)!.status, 'error', `${w.name} 도 깨우지 않는다`);
      assert.ok(
        events.some((e) => e.memberId === w.id && e.kind === 'error' && e.detail.summary === 'restart: parent gone'),
        `${w.name} 에 parent gone 흔적`,
      );
    }
    assert.deepEqual(
      pty.spawns.map((o) => o.memberId),
      [s.head.id],
      '부장만 되살아난다',
    );
    assert.deepEqual(office.recoveryResult!.failed.sort(), [s.lead.id, s.w1.id, s.w2.id].sort());
  });

  test('부장이 살아 돌아오면 그 아래는 정상 복구된다(게이트가 부모 status 하나만 본다)', async () => {
    const s = seedTree(store, dataDir);
    newOffice();
    await office.start();
    assert.equal(store.getMember(s.w1.id)!.status, 'starting');
    assert.equal(store.getMember(s.lead.id)!.status, 'starting');
  });

  test('buildResumedText: issued/children 이 비면 문장이 T09 그대로다', () => {
    const base = buildResumedText({ assigned: [], events: [] });
    assert.equal(base, '[RESUMED] 데몬이 재시작됐다. 진행 중이던 작업: 없음. 마지막 확인된 행동: 없음. 현재 상태를 점검하고 이어서 진행하라.');
  });
});
