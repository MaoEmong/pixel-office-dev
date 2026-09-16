// T09 재시작 복구: 이전 기동의 행이 남은 인메모리 Store 로 Office.start() 를 부르면
//   - session_id 있는 working 멤버(A) → `--resume` 재스폰 + [RESUMED](assigned task·최근 5 이벤트) + queued task 재큐잉,
//     approval expired + error 이벤트, TUI 질문(tool_input) expired, ask_user 질문은 유지
//   - session_id 없는 idle 멤버(B) → error(재고용 대상)
//   - exited 멤버(C) → 손대지 않음
//   - `--resume` 직후 비정상 종료 → 새 세션으로 한 번 폴백 + error 이벤트, 같은 [RESUMED]·queued 재큐잉
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office, buildResumedText } from '../../src/office/Office.js';
import { reapOrphan, type OrphanOps } from '../../src/office/orphans.js';
import { Store } from '../../src/store/Store.js';
import type { Member, OfficeEvent, Pending, Task, Team } from '../../src/store/types.js';
import { loadFixture } from '../screen/helpers.js';
import { FakePty, FakeReceiver, fakeReq, seedDeptTeam } from './fakes.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readyScreen = () => loadFixture('claude-ready.txt').join('\r\n');
const LONG_INSTRUCTION = '이 지시는 여든 글자를 넘기도록 일부러 길게 쓴 문장이다. 앞 80자만 [RESUMED] 에 실려야 하고 나머지는 말줄임표로 잘려야 한다. 뒤쪽 문장은 보이면 안 된다.';

interface Seed {
  team: Team;
  a: Member;
  b: Member;
  c: Member;
  assigned: Task;
  queued: Task;
  approval: Pending;
  tuiQuestion: Pending;
  eventsA: OfficeEvent[];
}

/** 이전 기동이 남긴 DB 모양. 멤버 행·task·pending·이벤트를 직접 심는다. */
function seed(store: Store, cwd: string): Seed {
  const team = seedDeptTeam(store, { name: 'alpha', cwd, maxMembers: 4 }).team;
  const a = store.createMember({ departmentId: team.departmentId, teamId: team.id, name: 'A', rank: 'member', engine: 'claude', cwd, hiredBy: 'user', status: 'working', sessionId: 'sess-A', childPid: 4242 });
  const b = store.createMember({ departmentId: team.departmentId, teamId: team.id, name: 'B', rank: 'member', engine: 'claude', cwd, hiredBy: 'user', status: 'idle', sessionId: null, childPid: 4343 });
  const c = store.createMember({ departmentId: team.departmentId, teamId: team.id, name: 'C', rank: 'member', engine: 'claude', cwd, hiredBy: 'user', status: 'exited', sessionId: 'sess-C' });
  const assigned = store.createTask({ departmentId: team.departmentId, fromMember: 'user', toMember: a.id, instruction: LONG_INSTRUCTION, status: 'assigned' });
  const queued = store.createTask({ departmentId: team.departmentId, fromMember: 'user', toMember: a.id, instruction: '두 번째: 아직 안 들어간 지시', status: 'queued' });
  const approval = store.createPending({ memberId: a.id, type: 'approval', payload: { tool_name: 'Bash', tool_input: { command: 'echo hi' } } });
  const tuiQuestion = store.createPending({
    memberId: a.id,
    type: 'question',
    payload: { questions: [{ question: '어느 걸로?', options: [] }], tool_input: { questions: [{ question: '어느 걸로?' }] } },
  });
  // A 의 이벤트 7건(오래된 것부터). [RESUMED] 에는 마지막 5건만 실려야 한다.
  const eventsA: OfficeEvent[] = [
    store.appendEvent({ departmentId: team.departmentId, teamId: team.id, memberId: a.id, kind: 'thinking', detail: { text: '오래된 생각 1' } }),
    store.appendEvent({ departmentId: team.departmentId, teamId: team.id, memberId: a.id, kind: 'reading', detail: { tool: 'Read', path: 'old/file.ts' } }),
    store.appendEvent({ departmentId: team.departmentId, teamId: team.id, memberId: a.id, kind: 'thinking', detail: { text: '[TASK#1 from user]\n이 지시는 여든 글자' } }),
    store.appendEvent({ departmentId: team.departmentId, teamId: team.id, memberId: a.id, kind: 'reading', detail: { tool: 'Grep', summary: 'grep foo' } }),
    store.appendEvent({ departmentId: team.departmentId, teamId: team.id, memberId: a.id, kind: 'editing', detail: { tool: 'Edit', path: 'src/a.ts' } }),
    store.appendEvent({ departmentId: team.departmentId, teamId: team.id, memberId: a.id, kind: 'running', detail: { tool: 'Bash', cmd: 'npm test' } }),
    store.appendEvent({ departmentId: team.departmentId, teamId: team.id, memberId: a.id, kind: 'waiting_approval', detail: { tool: 'Bash', cmd: 'echo hi' }, ref: { approvalId: approval.id } }),
  ];
  // C 에도 이벤트 하나(복구가 건드리지 않아야 한다)
  store.appendEvent({ departmentId: team.departmentId, teamId: team.id, memberId: c.id, kind: 'idle', detail: { summary: 'clocked out' } });
  return { team, a, b, c, assigned, queued, approval, tuiQuestion, eventsA };
}

describe('Office restart recovery (T09)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let office: Office;
  let events: OfficeEvent[];
  let statuses: Array<[string, string, string]>;
  let notices: string[];

  // 유령 자식 연산은 항상 가짜 — 실제 tasklist/taskkill 이 이 머신의 진짜 claude.exe 를 건드리면 안 된다.
  let orphans: { alive: Set<number>; names: Map<number, string>; kills: number[] };
  const fakeOrphanOps = (): OrphanOps => ({
    alive: (pid) => orphans.alive.has(pid),
    name: (pid) => orphans.names.get(pid),
    kill: (pid) => {
      orphans.kills.push(pid);
      orphans.alive.delete(pid);
    },
  });

  const newOffice = (opts: { fallbackWindowMs?: number } = {}) => {
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty, receiver, version: 't09', recovery: { ...opts, orphanOps: fakeOrphanOps() } });
    events = [];
    statuses = [];
    notices = [];
    office.on('event', (e) => events.push(e));
    office.on('status', (id, s, d) => statuses.push([id, s, d]));
    office.on('notice', (l, m) => notices.push(`${l}: ${m}`));
    return office;
  };
  const sessionStart = (m: Member, source: string, sessionId: string) =>
    receiver.emit('hook', fakeReq(m.memberToken, 'SessionStart', { session_id: sessionId, hook_event_name: 'SessionStart', cwd: m.cwd, source }).req);
  const feedReady = async (m: Member) => {
    pty.data(m.id, readyScreen());
    await sleep(60);
  };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t09-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    orphans = { alive: new Set(), names: new Map(), kills: [] };
  });
  afterEach(async () => {
    await office?.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('start(): A respawned with --resume, [RESUMED] then queued task; approval/TUI question expired; B → error; C untouched; notice', async () => {
    const s = seed(store, dataDir);
    newOffice();
    await office.start();

    // 결과 요약
    const r = office.recoveryResult!;
    assert.deepEqual(r.resumed, [s.a.id]);
    assert.deepEqual(r.failed, [s.b.id]);
    assert.deepEqual(r.expired.sort(), [s.approval.id, s.tuiQuestion.id].sort());
    assert.deepEqual(r.requeued, [s.queued.id]);
    assert.deepEqual(r.orphansKilled, []);
    assert.deepEqual(orphans.kills, []); // 4242/4343 은 살아 있지 않다(가짜) → 아무것도 죽이지 않음
    assert.ok(notices.includes('info: 복구: 1명 재개, 2건 만료, 1명 재개 불가'), notices.join('\n'));

    // A: --resume <sess-A> 로 한 번만 스폰, status starting, childPid 갱신
    assert.equal(pty.spawns.length, 1);
    const spawn = pty.spawns[0]!;
    assert.equal(spawn.memberId, s.a.id);
    assert.equal(spawn.resumeSessionId, 'sess-A');
    assert.equal(spawn.memberToken, s.a.memberToken);
    assert.equal(spawn.cwd, dataDir);
    const a = store.getMember(s.a.id)!;
    assert.equal(a.status, 'starting');
    assert.equal(a.childPid, 1000);
    assert.equal(a.sessionId, 'sess-A');

    // pending: approval expired + error 이벤트(pendingId), TUI 질문 expired
    assert.equal(store.getPending(s.approval.id)!.status, 'expired');
    assert.equal(store.getPending(s.tuiQuestion.id)!.status, 'expired');
    const approvalErr = events.find((e) => e.kind === 'error' && e.detail.pendingId === s.approval.id);
    assert.ok(approvalErr, 'approval expiry error event');
    assert.equal(approvalErr.memberId, s.a.id);
    assert.equal(approvalErr.detail.summary, '재지시 필요: 허가 요청이 재시작으로 만료됨');
    assert.equal(approvalErr.detail.pendingType, 'approval');
    assert.deepEqual(approvalErr.ref, { approvalId: s.approval.id });
    const questionErr = events.find((e) => e.kind === 'error' && e.detail.pendingId === s.tuiQuestion.id);
    assert.ok(questionErr, 'question expiry error event');
    assert.equal(questionErr.detail.summary, '재지시 필요: 질문이 재시작으로 만료됨');
    assert.deepEqual(questionErr.ref, { questionId: s.tuiQuestion.id });
    assert.equal(store.listOpenPending(s.a.id).length, 0);

    // tasks: assigned 그대로, queued 는 아직 queued(큐에만 들어감)
    assert.equal(store.getTask(s.assigned.id)!.status, 'assigned');
    assert.equal(store.getTask(s.queued.id)!.status, 'queued');

    // B: session_id 없음 → error 이벤트 + status error, 스폰 없음
    const b = store.getMember(s.b.id)!;
    assert.equal(b.status, 'error');
    assert.equal(b.childPid, null);
    const bErr = events.find((e) => e.memberId === s.b.id && e.kind === 'error');
    assert.ok(bErr, 'B error event');
    assert.equal(bErr.detail.summary, 'restart: no session id to resume');
    assert.ok(statuses.some(([id, st]) => id === s.b.id && st === 'error'));
    assert.ok(!pty.spawns.some((o) => o.memberId === s.b.id));

    // C: 손대지 않음
    const c = store.getMember(s.c.id)!;
    assert.equal(c.status, 'exited');
    assert.equal(c.sessionId, 'sess-C');
    assert.ok(!pty.spawns.some((o) => o.memberId === s.c.id));
    assert.ok(!events.some((e) => e.memberId === s.c.id));
    assert.ok(!statuses.some(([id]) => id === s.c.id));

    // 새 세션이 idle(SessionStart source=resume) + 준비 화면이 되면 [RESUMED] 가 먼저, 그 다음 queued task 가 붙여넣어진다
    const session = pty.session(s.a.id);
    assert.equal(session.pastes.length, 0);
    sessionStart(s.a, 'resume', 'sess-A');
    assert.ok(events.some((e) => e.memberId === s.a.id && e.kind === 'text' && e.detail.summary === 'resumed'));
    await feedReady(s.a);
    await sleep(600);
    assert.equal(session.pastes.length, 1, `pastes: ${JSON.stringify(session.pastes)}`);
    const resumed = session.pastes[0]!;
    console.log(`[T09] RESUMED text:\n${resumed}`);
    assert.ok(resumed.startsWith('[RESUMED] 데몬이 재시작됐다. 진행 중이던 작업: '), resumed);
    assert.ok(resumed.endsWith('현재 상태를 점검하고 이어서 진행하라.'), resumed);
    // assigned task 만, instruction 첫 80자(79자 + …)
    assert.ok(resumed.includes(`task#${s.assigned.id}: ${LONG_INSTRUCTION.slice(0, 79)}…`), resumed);
    assert.ok(!resumed.includes('뒤쪽 문장은 보이면 안 된다'), resumed);
    assert.ok(!resumed.includes(`task#${s.queued.id}`), 'queued task 는 진행 중이던 작업에 없다');
    // 마지막 5건(오래된 것부터), 처음 2건은 빠진다
    const behaviour = resumed.slice(resumed.indexOf('마지막 확인된 행동: ') + '마지막 확인된 행동: '.length, resumed.indexOf('. 만료된'));
    assert.equal(behaviour, 'thinking [TASK#1 from user] 이 지시는 여든 글자; reading grep foo; editing src/a.ts; running npm test; waiting_approval echo hi');
    assert.ok(!resumed.includes('오래된 생각 1'), resumed);
    assert.ok(!resumed.includes('old/file.ts'), resumed);
    assert.ok(resumed.includes('만료된 허가·질문: 2건'), resumed);
    // 복구가 새로 쓴 error 이벤트는 요약에 들어가지 않는다(죽기 직전 모습만)
    assert.ok(!resumed.includes('재지시 필요'), resumed);

    // queued task: [RESUMED] Enter 후 busy 창(1.5s)이 지나면 붙여넣어지고 assigned 가 된다
    await sleep(2400);
    assert.equal(session.pastes.length, 2, `pastes: ${JSON.stringify(session.pastes)}`);
    assert.equal(session.pastes[1], `[TASK#${s.queued.id} from user]\n두 번째: 아직 안 들어간 지시`);
    assert.equal(store.getTask(s.queued.id)!.status, 'assigned');
    assert.equal(store.getTask(s.assigned.id)!.status, 'assigned');
  });

  test('ask_user question (no tool_input) stays open; only TUI questions and approvals expire', async () => {
    const team = seedDeptTeam(store, { name: 'q', cwd: dataDir }).team;
    const m = store.createMember({ departmentId: team.departmentId, teamId: team.id, name: 'Q', rank: 'member', engine: 'claude', cwd: dataDir, hiredBy: 'user', status: 'waiting_answer', sessionId: 'sess-Q' });
    const askUser = store.createPending({ memberId: m.id, type: 'question', payload: { questions: [{ question: 'M2 ask_user?' }] } });
    const tui = store.createPending({ memberId: m.id, type: 'question', payload: { questions: [], tool_input: {} } });
    const approval = store.createPending({ memberId: m.id, type: 'approval', payload: { tool_name: 'Write', tool_input: {} } });
    newOffice();
    await office.start();
    assert.equal(store.getPending(askUser.id)!.status, 'open');
    assert.equal(store.getPending(tui.id)!.status, 'expired');
    assert.equal(store.getPending(approval.id)!.status, 'expired');
    assert.deepEqual(office.recoveryResult!.expired.sort(), [approval.id, tui.id].sort());
    assert.equal(pty.spawns.length, 1);
    assert.equal(pty.spawns[0]!.resumeSessionId, 'sess-Q');
    assert.ok(notices.includes('info: 복구: 1명 재개, 2건 만료'));
    const resumed = buildResumedText({ assigned: [], events: [], expiredCount: 0 });
    assert.equal(resumed, '[RESUMED] 데몬이 재시작됐다. 진행 중이던 작업: 없음. 마지막 확인된 행동: 없음. 현재 상태를 점검하고 이어서 진행하라.');
  });

  test('fallback: resumed process exits non-zero within the window → fresh spawn without --resume, error event, same [RESUMED] + queued requeued', async () => {
    const s = seed(store, dataDir);
    newOffice();
    await office.start();
    const first = pty.session(s.a.id);
    const eventsBefore = events.length;

    pty.exit(s.a.id, 1); // 세션 파일 없음 증상: 바로 죽는다
    assert.equal(first.alive, false);
    assert.equal(pty.spawns.length, 2);
    assert.equal(pty.spawns[1]!.memberId, s.a.id);
    assert.equal(pty.spawns[1]!.resumeSessionId, undefined, 'second spawn must not --resume');
    const a = store.getMember(s.a.id)!;
    assert.equal(a.status, 'starting');
    assert.equal(a.sessionId, null, 'stale session id cleared');
    assert.equal(a.childPid, 1001);
    const fresh = events.slice(eventsBefore).find((e) => e.kind === 'error');
    assert.ok(fresh, 'fallback error event');
    assert.equal(fresh.detail.summary, 'resume failed; started fresh session');
    assert.equal(fresh.detail.exitCode, 1);
    assert.equal(fresh.detail.sessionId, 'sess-A');
    assert.ok(!events.slice(eventsBefore).some((e) => e.detail.summary === 'process exited (code 1)'), 'no unexpected-exit event');
    assert.ok(notices.some((n) => n.startsWith('warn: 복구: A 세션 재개 실패(code 1)')), notices.join('\n'));
    // task 는 abort 되지 않는다
    assert.equal(store.getTask(s.assigned.id)!.status, 'assigned');
    assert.equal(store.getTask(s.queued.id)!.status, 'queued');

    // 새 세션이 뜨면 같은 [RESUMED] 와 queued task 가 다시 들어간다
    const second = pty.session(s.a.id);
    sessionStart(s.a, 'startup', 'sess-A2');
    assert.equal(store.getMember(s.a.id)!.sessionId, 'sess-A2');
    await feedReady(s.a);
    await sleep(600);
    assert.equal(second.pastes.length, 1, JSON.stringify(second.pastes));
    assert.ok(second.pastes[0]!.startsWith('[RESUMED] 데몬이 재시작됐다. 진행 중이던 작업: task#1: '), second.pastes[0]);
    await sleep(2400);
    assert.equal(second.pastes.length, 2, JSON.stringify(second.pastes));
    assert.equal(second.pastes[1], `[TASK#${s.queued.id} from user]\n두 번째: 아직 안 들어간 지시`);
    assert.equal(store.getTask(s.queued.id)!.status, 'assigned');

    // 폴백은 한 번뿐: 새 세션도 죽으면 일반 비정상 종료 처리(error + task aborted)
    pty.exit(s.a.id, 1);
    assert.equal(pty.spawns.length, 2);
    assert.equal(store.getMember(s.a.id)!.status, 'error');
    assert.equal([...events].reverse().find((e) => e.kind === 'error')!.detail.summary, 'process exited (code 1)'); // T25: 그 뒤에 aborted 보고 이벤트가 하나 더 붙는다
    assert.equal(store.getTask(s.assigned.id)!.status, 'aborted');
  });

  test('fallback does not apply after the window or on exit code 0', async () => {
    const s = seed(store, dataDir);
    newOffice({ fallbackWindowMs: 50 });
    await office.start();
    await sleep(120);
    pty.exit(s.a.id, 1);
    assert.equal(pty.spawns.length, 1, 'no second spawn after the window');
    assert.equal(store.getMember(s.a.id)!.status, 'error');
    assert.equal(store.getMember(s.a.id)!.sessionId, 'sess-A');
    assert.equal([...events].reverse().find((e) => e.kind === 'error')!.detail.summary, 'process exited (code 1)'); // T25: 그 뒤에 aborted 보고 이벤트가 하나 더 붙는다

    // code 0 안에서 죽으면(사용자 /exit) 일반 exited 처리
    await office.shutdown();
    const store2 = new Store(':memory:');
    store = store2;
    pty = new FakePty();
    receiver = new FakeReceiver();
    const s2 = seed(store2, dataDir);
    newOffice({ fallbackWindowMs: 60_000 });
    await office.start();
    pty.exit(s2.a.id, 0);
    assert.equal(pty.spawns.length, 1);
    assert.equal(store2.getMember(s2.a.id)!.status, 'exited');
  });

  test('recover() never throws: a member whose spawn fails becomes error, the rest are still recovered', async () => {
    const s = seed(store, dataDir);
    const d = store.createMember({ departmentId: s.team.departmentId, teamId: s.team.id, name: 'D', rank: 'member', engine: 'claude', cwd: dataDir, hiredBy: 'user', status: 'idle', sessionId: 'sess-D' });
    store.createTask({ departmentId: s.team.departmentId, fromMember: 'user', toMember: d.id, instruction: 'd queued', status: 'queued' });
    pty.failSpawnFor.add(s.a.id);
    newOffice();
    await office.start(); // throw 하지 않는다
    const r = office.recoveryResult!;
    assert.deepEqual(r.resumed, [d.id]);
    assert.deepEqual(r.failed.sort(), [s.a.id, s.b.id].sort());
    assert.equal(store.getMember(s.a.id)!.status, 'error');
    const aErr = events.find((e) => e.memberId === s.a.id && e.kind === 'error' && String(e.detail.summary).startsWith('restart: spawn failed'));
    assert.ok(aErr, 'spawn failure error event');
    assert.equal(store.getTask(s.assigned.id)!.status, 'aborted');
    assert.equal(store.getMember(d.id)!.status, 'starting');
    assert.deepEqual(pty.spawns.map((o) => o.memberId), [d.id]);
    assert.ok(notices.includes('info: 복구: 1명 재개, 2건 만료, 2명 재개 불가'), notices.join('\n'));
  });

  test('orphans: a surviving child whose image name matches the engine is killed before --resume; a recycled pid with another name is left alone', async () => {
    const s = seed(store, dataDir);
    orphans.alive.add(4242).add(4343);
    orphans.names.set(4242, 'claude.exe');
    orphans.names.set(4343, 'node.exe'); // B 의 pid 가 다른 프로세스에 재사용된 경우
    newOffice();
    await office.start();
    assert.deepEqual(orphans.kills, [4242]);
    assert.deepEqual(office.recoveryResult!.orphansKilled, [4242]);
    assert.ok(notices.includes(`warn: 복구: A 의 이전 프로세스(pid 4242)가 살아 있어 종료함`), notices.join('\n'));
    assert.ok(notices.includes(`warn: 복구: B 의 이전 pid 4343 를 건드리지 않음 — process name node.exe does not look like claude`), notices.join('\n'));
    assert.ok(notices.includes('info: 복구: 1명 재개, 2건 만료, 1명 재개 불가, 유령 1개 정리'), notices.join('\n'));
    // 종료는 스폰보다 먼저(같은 세션을 두 프로세스가 쥐지 않도록)
    assert.equal(pty.spawns.length, 1);
    assert.equal(store.getMember(s.a.id)!.childPid, 1000);
    // C(exited) 는 확인조차 하지 않는다
    assert.ok(!notices.some((n) => n.includes(' C ')));

    // reapOrphan 단독: 자기 자신·이름 모름·죽은 pid
    const ops: OrphanOps = { alive: () => true, name: () => undefined, kill: () => assert.fail('must not kill') };
    assert.deepEqual(reapOrphan(ops, process.pid, 'claude'), { action: 'skipped', reason: 'pid is the daemon itself' });
    assert.deepEqual(reapOrphan(ops, 99999, 'claude'), { action: 'skipped', reason: 'process name unknown' });
    assert.deepEqual(reapOrphan({ ...ops, alive: () => false }, 99999, 'claude'), { action: 'not-alive' });
  });

  test('fresh daemon (no rows): no notice, no spawn', async () => {
    newOffice();
    await office.start();
    assert.deepEqual(office.recoveryResult, { resumed: [], failed: [], expired: [], requeued: [], orphansKilled: [] });
    assert.equal(notices.length, 0);
    assert.equal(pty.spawns.length, 0);
  });
});
