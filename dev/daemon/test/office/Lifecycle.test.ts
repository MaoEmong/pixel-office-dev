// T46-1 (D-47 · docs/design/수명주기.md) — 수명 주기의 데몬 쪽.
//   §5 정상 종료는 살아 있던 멤버를 `suspended` 로 접는다(사용자 퇴근 `exited` · 오류 `error` 와 구별),
//      하던 일(task)은 끊지 않고 `ask_*` 질문은 남기며 허가만 만료시킨다
//   §5 다음 기동은 `suspended` 를 **말없이** 되살린다(토큰 0) — 하던 일이 있던 캐릭터에게만 `[RESUMED]`
//   §5 부서 우선순위: 지금 보는 탭(`hello{activeDepartmentId}`) → 마지막 활동 부서 → 나머지
//   §2 종료는 자식 pid 가 정말 사라졌는지 확인하고(확인용 세션 포함) `daemon.json` 을 지운다
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office } from '../../src/office/Office.js';
import { needsResumedText, recoveryOrder, RECOVER_MAX_IN_FLIGHT } from '../../src/office/recovery.js';
import { looksLikeEngine, exeImageName, reapOrphan, type OrphanOps } from '../../src/office/orphans.js';
import { Store } from '../../src/store/Store.js';
import { derivedStatus } from '../../src/office/derived.js';
import type { Member, Pending, Task } from '../../src/store/types.js';
import { FakeMcp, FakePty, FakeReceiver, fakeReq, seedDeptTeam } from './fakes.js';
import { loadFixture } from '../screen/helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readyScreen = () => loadFixture('claude-ready.txt').join('\r\n');

// ---- 순수 규칙 ----------------------------------------------------------------------

describe('복구 순서 (T46-1 §5)', () => {
  const m = (id: string, rank: Member['rank'], departmentId: string): Member =>
    ({ id, departmentId, rank }) as Member;

  test('부서 안에서는 부장 → 팀장 → 팀원(T36 그대로)', () => {
    const rows = [m('w1', 'member', 'd1'), m('lead', 'lead', 'd1'), m('head', 'head', 'd1'), m('w2', 'member', 'd1')];
    assert.deepEqual(recoveryOrder(rows).map((x) => x.id), ['head', 'lead', 'w1', 'w2']);
  });

  test('힌트 부서가 맨 앞 — 부서 안의 트리 순서는 그대로', () => {
    const rows = [m('h1', 'head', 'd1'), m('w1', 'member', 'd1'), m('h2', 'head', 'd2'), m('w2', 'member', 'd2')];
    assert.deepEqual(recoveryOrder(rows, { hintDepartmentId: 'd2' }).map((x) => x.id), ['h2', 'w2', 'h1', 'w1']);
  });

  test('힌트가 없으면 마지막 활동 부서가 맨 앞', () => {
    const rows = [m('h1', 'head', 'd1'), m('h2', 'head', 'd2'), m('h3', 'head', 'd3')];
    assert.deepEqual(recoveryOrder(rows, { recentDepartmentId: 'd3' }).map((x) => x.id), ['h3', 'h1', 'h2']);
  });

  test('힌트가 마지막 활동 부서를 이긴다', () => {
    const rows = [m('h1', 'head', 'd1'), m('h2', 'head', 'd2'), m('h3', 'head', 'd3')];
    assert.deepEqual(
      recoveryOrder(rows, { hintDepartmentId: 'd2', recentDepartmentId: 'd3' }).map((x) => x.id),
      ['h2', 'h3', 'h1'],
    );
  });

  test('목록에 없는 부서를 가리켜도 순서가 깨지지 않는다', () => {
    const rows = [m('h1', 'head', 'd1'), m('h2', 'head', 'd2')];
    assert.deepEqual(recoveryOrder(rows, { hintDepartmentId: 'nope' }).map((x) => x.id), ['h1', 'h2']);
  });
});

describe('말없이 앉히기 규칙 (T46-1 원칙 4)', () => {
  const task = {} as Task;
  const pending = {} as Pending;
  const none = { assigned: [], queued: [], issued: [], openQuestions: [] };

  test('하던 일이 하나도 없으면 말을 걸지 않는다', () => {
    assert.equal(needsResumedText(none), false);
  });
  test('진행 중 task · 밀린 지시 · 맡긴 일 · 열린 질문 넷 중 하나면 말을 건다', () => {
    assert.equal(needsResumedText({ ...none, assigned: [task] }), true);
    assert.equal(needsResumedText({ ...none, queued: [task] }), true);
    assert.equal(needsResumedText({ ...none, issued: [task] }), true, '부장·팀장은 "맡긴 일" 이 하던 일이다(T36/D-20)');
    assert.equal(needsResumedText({ ...none, openQuestions: [pending] }), true);
  });
});

describe('유령 정리의 이미지 이름 확인 (T46-1 §4-1)', () => {
  const ops = (name: string, kills: number[]): OrphanOps => ({ alive: () => true, name: () => name, kill: (p) => kills.push(p) });

  test('기본은 D-17 그대로 — 엔진 이름이 들어 있을 때만', () => {
    assert.equal(looksLikeEngine('claude.exe', 'claude'), true);
    assert.equal(looksLikeEngine('codex', 'codex'), true);
    assert.equal(looksLikeEngine('node.exe', 'claude'), false, 'node 를 기본으로 받으면 재사용된 pid 로 엉뚱한 걸 죽인다');
    assert.equal(looksLikeEngine('notepad.exe', 'claude'), false);
  });

  test('데몬이 실제로 띄운 실행 파일 이름은 인정한다(node 래퍼)', () => {
    assert.equal(looksLikeEngine('node.exe', 'claude', 'node.exe'), true);
    assert.equal(looksLikeEngine('node', 'claude', 'node.exe'), true, '확장자 차이는 무시');
    assert.equal(looksLikeEngine('notepad.exe', 'claude', 'node.exe'), false, '그래도 아무거나는 아니다');
  });

  test('exeImageName 은 경로에서 이름만 뽑는다', () => {
    assert.equal(exeImageName('D:\\tools\\node.exe'), 'node.exe');
    assert.equal(exeImageName('/usr/local/bin/claude'), 'claude');
    assert.equal(exeImageName(undefined), undefined);
    assert.equal(exeImageName(''), undefined);
  });

  test('데몬 자신의 pid 는 절대 건드리지 않는다', () => {
    const kills: number[] = [];
    assert.deepEqual(reapOrphan(ops('node.exe', kills), process.pid, 'claude', { exeName: 'node.exe' }), {
      action: 'skipped',
      reason: 'pid is the daemon itself',
    });
    assert.deepEqual(kills, []);
  });
});

// ---- Office 배선 --------------------------------------------------------------------

describe('정상 종료 → suspended, 다시 켜면 말없이 출근 (T46-1 §5)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let office: Office | undefined;
  const noOrphans: OrphanOps = { alive: () => false, name: () => undefined, kill: () => {} };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t46lc-'));
    // 파일 DB — "데몬을 껐다 켠다" 를 흉내 내려면 같은 DB 를 두 번 열어야 한다.
    store = new Store(path.join(dataDir, 'pixel-office.db'));
    pty = new FakePty();
    receiver = new FakeReceiver();
  });
  afterEach(async () => {
    await office?.shutdown().catch(() => {});
    try {
      store.close(); // 파일 DB 라 열려 있으면 윈도우가 폴더를 못 지운다(shutdown 이 이미 닫았으면 여기서 던진다)
    } catch {
      /* 이미 닫힘 */
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const newOffice = (opts: { store?: Store; pty?: FakePty } = {}) =>
    new Office({
      config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 },
      store: opts.store ?? store,
      pty: opts.pty ?? pty,
      receiver,
      mcp: new FakeMcp(),
      version: 't46',
      recovery: { orphanOps: noOrphans },
    });

  /** 부장 하나 + 팀원 하나를 DB 에 심는다(이전 기동이 남긴 모양). */
  function seed(s: Store, cwd: string, deptName = 'alpha') {
    const { department, team } = seedDeptTeam(s, { name: deptName, cwd, departmentName: deptName });
    const head = s.createMember({ departmentId: department.id, teamId: null, parentId: null, name: `${deptName}장`, rank: 'head', engine: 'claude', cwd, hiredBy: 'user', status: 'idle', sessionId: `sess-${deptName}-head` });
    const worker = s.createMember({ departmentId: department.id, teamId: team.id, parentId: head.id, name: `${deptName}원`, rank: 'member', engine: 'claude', cwd, hiredBy: 'leader', status: 'idle', sessionId: `sess-${deptName}-w` });
    return { department, team, head, worker };
  }

  test('종료: 살아 있던 멤버는 suspended, task 는 그대로, 허가는 만료, ask_* 질문은 남는다', async () => {
    const s = seed(store, dataDir);
    office = newOffice();
    await office.start();
    await office.recoveryDone;
    const task = store.createTask({ departmentId: s.department.id, fromMember: 'user', toMember: s.head.id, instruction: '설계해라', status: 'assigned' });
    const approval = store.createPending({ memberId: s.head.id, type: 'approval', payload: { tool_name: 'Bash', tool_input: { command: 'ls' } } });
    const askUser = store.createPending({ memberId: s.head.id, type: 'question', payload: { source: 'ask_user', question: '어느 쪽?' } });

    await office.shutdown();
    const after = new Store(path.join(dataDir, 'pixel-office.db'));
    assert.equal(after.getMember(s.head.id)!.status, 'suspended');
    assert.equal(after.getMember(s.worker.id)!.status, 'suspended');
    assert.equal(after.getTask(task.id)!.status, 'assigned', '하던 일은 끊지 않는다(§5)');
    assert.equal(after.getPending(approval.id)!.status, 'expired', 'hook 프로세스가 같이 죽는다');
    assert.equal(after.getPending(askUser.id)!.status, 'open', '턴 종료 질문은 그대로');
    after.close();
    office = undefined;
  });

  // T46-3 실기 결함 ①. 가짜 pty 만 쓰던 T46-1 테스트에는 이 순간이 없었다 — 진짜 Claude 는 `/exit` 를 받고
  // 죽기 직전에 `SessionEnd{reason:'prompt_input_exit'}` hook 을 **한 번 더** 보내고, 그것이 방금 적은
  // `suspended` 를 `exited` 로 되돌려 놓았다. 그러면 다음 기동이 아무도 되살리지 않는다(앱을 닫았다 켜면 전원 "퇴근").
  test('/exit 가 마지막으로 보내는 SessionEnd hook 이 suspended 를 되돌리지 않는다', async () => {
    const s = seed(store, dataDir);
    office = newOffice();
    await office.start();
    await office.recoveryDone;
    pty.beforeExit = (memberId) => {
      const m = store.getMember(memberId);
      if (!m) return;
      receiver.emit(
        'hook',
        fakeReq(m.memberToken, 'SessionEnd', {
          session_id: m.sessionId!,
          hook_event_name: 'SessionEnd',
          cwd: m.cwd,
          reason: 'prompt_input_exit',
        }).req,
      );
    };

    await office.shutdown();
    office = undefined;
    const after = new Store(path.join(dataDir, 'pixel-office.db'));
    assert.equal(after.getMember(s.head.id)!.status, 'suspended', 'SessionEnd 가 덮으면 안 된다');
    assert.equal(after.getMember(s.worker.id)!.status, 'suspended');
    after.close();

    // 그래서 다음 기동이 둘 다 말없이 되살린다.
    const store2 = new Store(path.join(dataDir, 'pixel-office.db'));
    const pty2 = new FakePty();
    const office2 = newOffice({ store: store2, pty: pty2 });
    office = office2;
    await office2.start();
    await office2.recoveryDone;
    assert.deepEqual(pty2.spawns.map((o) => o.memberId), [s.head.id, s.worker.id]);
    assert.deepEqual(office2.recoveryResult!.silent.sort(), [s.head.id, s.worker.id].sort());
  });

  test('사용자 퇴근은 그대로 exited — suspended 와 구별된다', async () => {
    const s = seed(store, dataDir);
    office = newOffice();
    await office.start();
    await office.recoveryDone;
    await office.clockOut(s.worker.id);
    assert.equal(store.getMember(s.worker.id)!.status, 'exited');
    await office.shutdown();
    const after = new Store(path.join(dataDir, 'pixel-office.db'));
    assert.equal(after.getMember(s.worker.id)!.status, 'exited', '퇴근시킨 멤버를 종료가 되살리지 않는다');
    assert.equal(after.getMember(s.head.id)!.status, 'suspended');
    after.close();
    office = undefined;
  });

  test('다시 켜면 suspended 가 말없이 출근한다 — 타이핑 0, 토큰 0', async () => {
    const s = seed(store, dataDir);
    office = newOffice();
    await office.start();
    await office.recoveryDone;
    await office.shutdown();
    office = undefined;

    // 두 번째 기동(같은 DB, 새 pty).
    const store2 = new Store(path.join(dataDir, 'pixel-office.db'));
    const pty2 = new FakePty();
    const office2 = newOffice({ store: store2, pty: pty2 });
    office = office2;
    await office2.start();
    await office2.recoveryDone;

    assert.deepEqual(
      pty2.spawns.map((o) => o.memberId),
      [s.head.id, s.worker.id],
      '부장 → 팀원 순으로 그대로 출근',
    );
    assert.deepEqual(pty2.spawns.map((o) => o.resumeSessionId), [`sess-alpha-head`, `sess-alpha-w`], '같은 대화를 --resume');
    const r = office2.recoveryResult!;
    assert.deepEqual(r.silent.sort(), [s.head.id, s.worker.id].sort(), '둘 다 말없이');
    assert.deepEqual(pty2.session(s.head.id).pastes, [], '[RESUMED] 를 타이핑하지 않는다');
    assert.deepEqual(pty2.session(s.worker.id).pastes, []);
    assert.equal(store2.getMember(s.head.id)!.status, 'starting');
  });

  test('하던 일이 있던 멤버에게는 [RESUMED] 를 타이핑한다', async () => {
    const s = seed(store, dataDir);
    store.createTask({ departmentId: s.department.id, fromMember: 'user', toMember: s.worker.id, instruction: '빌드 돌려라', status: 'assigned' });
    office = newOffice();
    await office.start();
    await office.recoveryDone;
    // 되살아난 세션이 SessionStart + 준비 화면을 보내면 큐가 흐른다.
    for (const m of [s.head, s.worker]) {
      receiver.emit('hook', fakeReq(m.memberToken, 'SessionStart', { session_id: m.sessionId!, hook_event_name: 'SessionStart', cwd: m.cwd, source: 'resume' }).req);
      pty.data(m.id, readyScreen());
    }
    await sleep(800);
    assert.equal(pty.session(s.worker.id).pastes.length, 1, '진행 중 task 가 있으면 말을 건다');
    assert.ok(pty.session(s.worker.id).pastes[0]!.startsWith('[RESUMED]'));
    assert.deepEqual(pty.session(s.head.id).pastes, [], '쉬고 있던 부장은 말없이');
  });

  test('suspended 는 파생 상태가 덮지 않는다(회색 + 잠시 닫힘)', () => {
    const s = seed(store, dataDir);
    store.createPending({ memberId: s.head.id, type: 'question', payload: { source: 'ask_user', question: 'x' } });
    store.updateMember(s.head.id, { status: 'suspended' });
    const head = store.getMember(s.head.id)!;
    assert.equal(derivedStatus(head, store), 'suspended', '열린 질문이 있어도 "질문 대기" 로 보이지 않는다');
  });

  test('부서가 여럿이면 마지막 활동 부서부터, hello{activeDepartmentId} 가 오면 그쪽이 먼저', async () => {
    const a = seed(store, dataDir, 'alpha');
    const b = seed(store, dataDir, 'beta');
    // beta 에서 마지막 활동이 있었다.
    store.appendEvent({ departmentId: b.department.id, teamId: '', memberId: b.head.id, kind: 'idle', detail: { summary: 'last' } });
    office = newOffice();
    await office.start();
    assert.deepEqual(
      pty.spawns.map((o) => o.memberId).slice(0, 2),
      [b.head.id, b.worker.id],
      '마지막 활동 부서(beta)가 먼저',
    );

    // 두 번째 기동에서는 앱이 alpha 탭을 보고 있다고 알려 준다. 동시 상한 1 로 줄여 힌트가 먹을 틈을 만든다.
    await office.shutdown();
    const store2 = new Store(path.join(dataDir, 'pixel-office.db'));
    const pty2 = new FakePty();
    const receiver2 = new FakeReceiver(); // 첫 데몬의 store 는 닫혔다 — hook 은 새 데몬으로 간다
    const office2 = new Office({
      config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 },
      store: store2,
      pty: pty2,
      receiver: receiver2,
      mcp: new FakeMcp(),
      version: 't46',
      recovery: { orphanOps: noOrphans, maxInFlight: 1 },
    });
    office = office2;
    await office2.start();
    assert.deepEqual(pty2.spawns.map((o) => o.memberId), [b.head.id], '아직은 마지막 활동 부서');
    office2.prioritizeRecovery(a.department.id); // hello{activeDepartmentId}
    // beta 부장이 기동을 마치면 다음은 **alpha** 다.
    receiver2.emit('hook', fakeReq(b.head.memberToken, 'SessionStart', { session_id: b.head.sessionId!, hook_event_name: 'SessionStart', cwd: b.head.cwd, source: 'resume' }).req);
    await sleep(20);
    assert.deepEqual(pty2.spawns.map((o) => o.memberId), [b.head.id, a.head.id], '힌트가 오면 남은 줄이 다시 선다');
  });
});

describe('종료 완결성 (T46-1 §2 · 검증 2)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let office: Office | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t46sd-'));
    store = new Store(':memory:');
    pty = new FakePty();
  });
  afterEach(async () => {
    await office?.shutdown().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('closingSessions(): 멤버 세션 + 확인용 세션, 닫기 시작한 뒤에는 그때 센 수 그대로', async () => {
    const { department, team } = seedDeptTeam(store, { name: 'alpha', cwd: dataDir });
    const head = store.createMember({ departmentId: department.id, teamId: null, parentId: null, name: '국장', rank: 'head', engine: 'claude', cwd: dataDir, hiredBy: 'user', status: 'idle', sessionId: 'sess-h' });
    store.createMember({ departmentId: department.id, teamId: team.id, parentId: head.id, name: '이음', rank: 'member', engine: 'claude', cwd: dataDir, hiredBy: 'leader', status: 'idle', sessionId: 'sess-w' });
    office = new Office({
      config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 },
      store,
      pty,
      receiver: new FakeReceiver(),
      mcp: new FakeMcp(),
      version: 't46',
      recovery: { orphanOps: { alive: () => false, name: () => undefined, kill: () => {} } },
    });
    await office.start();
    await office.recoveryDone;
    assert.equal(office.closingSessions(), 2);
    assert.equal(office.isClosing, false);

    const closing = office.shutdown();
    assert.equal(office.isClosing, true);
    assert.equal(office.closingSessions(), 2, '닫는 중에도 같은 수(두 번째 daemon.shutdown 이 본다)');
    await closing;
    assert.equal(office.closingSessions(), 2);
    office = undefined;
  });

  test('daemon.json 을 지우기 전에 자식 pid 가 사라졌는지 확인하고, 안 닫힌 것은 트리째 종료한다', async () => {
    const { department } = seedDeptTeam(store, { name: 'alpha', cwd: dataDir });
    const head = store.createMember({ departmentId: department.id, teamId: null, parentId: null, name: '국장', rank: 'head', engine: 'claude', cwd: dataDir, hiredBy: 'user', status: 'exited', sessionId: 'sess-h' });
    const alive = new Set([4242, 4343]);
    const killed: number[] = [];
    const orphanOps: OrphanOps = {
      alive: (pid) => alive.has(pid),
      name: (pid) => (pid === 4242 ? 'claude.exe' : 'codex.exe'),
      kill: (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
    };
    office = new Office({
      config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 },
      store,
      pty,
      receiver: new FakeReceiver(),
      mcp: new FakeMcp(),
      version: 't46',
      recovery: { orphanOps },
      shutdownReapMs: 120, // 기본 4초를 기다리지 않는다 — 이 테스트의 자식들은 일부러 안 죽는다
    });
    await office.start();
    await office.recoveryDone;
    assert.deepEqual(killed, [], '복구는 exited 멤버를 건드리지 않는다');
    // 기동 뒤에 자식이 생긴 모양: 멤버 세션 pid + 확인용 세션 pid.
    store.updateMember(head.id, { childPid: 4242 });
    store.putUsageProbePid('codex', 4343);

    await office.shutdown();
    assert.deepEqual([...killed].sort(), [4242, 4343], '안 닫힌 자식(멤버 + 확인용)을 트리째 종료');
    assert.equal(fs.existsSync(path.join(dataDir, 'daemon.json')), false, '그 뒤에야 daemon.json 을 지운다');
    office = undefined;
  });

  test('이름이 다른 pid(재사용)는 강제 종료에서도 건드리지 않는다', async () => {
    const { department } = seedDeptTeam(store, { name: 'alpha', cwd: dataDir });
    const head = store.createMember({ departmentId: department.id, teamId: null, parentId: null, name: '국장', rank: 'head', engine: 'claude', cwd: dataDir, hiredBy: 'user', status: 'exited', sessionId: 'sess-h', childPid: 5555 });
    assert.ok(head);
    const killed: number[] = [];
    office = new Office({
      config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 },
      store,
      pty,
      receiver: new FakeReceiver(),
      mcp: new FakeMcp(),
      version: 't46',
      recovery: { orphanOps: { alive: () => true, name: () => 'notepad.exe', kill: (p) => killed.push(p) } },
      shutdownReapMs: 120,
    });
    await office.start();
    await office.recoveryDone;
    await office.shutdown();
    assert.deepEqual(killed, []);
    office = undefined;
  });

  test('두 번째 shutdown 은 아무것도 다시 하지 않는다', async () => {
    office = new Office({
      config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 },
      store,
      pty,
      receiver: new FakeReceiver(),
      mcp: new FakeMcp(),
      version: 't46',
      recovery: { orphanOps: { alive: () => false, name: () => undefined, kill: () => {} } },
    });
    let shut = 0;
    office.on('shutdown', () => shut++);
    await office.start();
    await office.shutdown();
    await office.shutdown();
    assert.equal(shut, 1);
    office = undefined;
  });

  test('한꺼번에 띄우는 CLI 상한은 3(§5 기동 부하)', () => {
    assert.equal(RECOVER_MAX_IN_FLIGHT, 3);
  });
});
