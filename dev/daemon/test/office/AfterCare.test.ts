// T28 공통 후처리(afterCare.ts)·파생 상태(derived.ts).
//   - 표(SETTLE_MATRIX)를 이유별로 한 번씩: interrupt / clockOut / error / teamDelete / restart / recover
//   - interrupt 만 팀장의 발행 task 를 남긴다(턴을 끊는 것이지 팀 지시를 거두는 게 아니다)
//   - 퇴근·종료·팀 삭제는 발행 task aborted + 대상 interrupt + MCP 토큰 정리 + 셸 락 해제
//   - team.delete 는 팀원 먼저, 팀장 마지막
//   - 파생 상태: 열린 허가·질문은 raw 가 무엇이든 waiting_*, 팀장 idle + 발행 task = waiting_reports,
//     "raw 는 그대로인데 파생만 바뀐" 경우에도 member.status 가 한 번 더 나간다
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office } from '../../src/office/Office.js';
import { SETTLE_MATRIX, keepsQuestion, settleMember, type SettleCtx, type SettleSummary } from '../../src/office/afterCare.js';
import { derivedStatus } from '../../src/office/derived.js';
import { Store } from '../../src/store/Store.js';
import type { Member, OfficeEvent, Team } from '../../src/store/types.js';
import { loadFixture } from '../screen/helpers.js';
import { FakeMcp, FakePty, FakeReceiver, fakeReq, seedDeptTeam } from './fakes.js';

const SID = 'sess-t28';
const base = (event: string) => ({ session_id: SID, hook_event_name: event, cwd: 'D:\\x' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readyScreen = () => loadFixture('claude-ready.txt').join('\r\n');
/** 큐가 한 항목을 paste + Enter 로 밀어 넣는 데 걸리는 시간(TeamTools.test.ts 와 같은 값). */
const FLUSH_MS = 700;

describe('공통 후처리·파생 상태 (T28)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let mcp: FakeMcp;
  let office: Office;
  let team: Team;
  let events: OfficeEvent[];
  let statuses: Array<[string, string, string]>;
  let notices: string[];

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t28-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    mcp = new FakeMcp();
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty, receiver, mcp, version: 't28' });
    events = [];
    statuses = [];
    notices = [];
    office.on('event', (e) => events.push(e));
    office.on('status', (id, s, d) => statuses.push([id, s, d]));
    office.on('notice', (l, m) => notices.push(`${l}: ${m}`));
    await office.start();
    team = seedDeptTeam(store, { name: 'alpha', cwd: dataDir, maxMembers: 5, allowedEngines: ['claude'] }).team;
  });
  afterEach(async () => {
    await office.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const hook = (m: Member, event: 'SessionStart' | 'UserPromptSubmit' | 'Stop', extra: Record<string, unknown> = {}) => {
    const r = fakeReq(m.memberToken, event, { ...base(event), ...extra });
    receiver.emit('hook', r.req);
    return r;
  };
  /** SessionStart + 준비 화면 — 이 뒤로 큐가 흐른다. */
  const ready = async (m: Member): Promise<Member> => {
    hook(m, 'SessionStart', { source: 'startup' });
    pty.data(m.id, readyScreen());
    await sleep(60);
    return store.getMember(m.id)!;
  };
  const leaderIn = async (name = '반장') => ready(office.clockIn({ teamId: team.id, engine: 'claude', name, rank: 'lead' }));
  const memberIn = async (name: string) => ready(office.clockIn({ teamId: team.id, engine: 'claude', name }));
  const busy = (m: Member) => hook(m, 'UserPromptSubmit', { prompt: 'x' });
  const pastesOf = (m: Member) => pty.session(m.id).pastes;
  const keysOf = (m: Member) => pty.session(m.id).keys;
  const derivedOf = (id: string) => [...statuses].reverse().find((s) => s[0] === id)?.[2];
  const statusCount = (id: string) => statuses.filter((s) => s[0] === id).length;
  const taskOf = (id: number) => store.getTask(id)!;

  // ---- interrupt -------------------------------------------------------------------

  test('interrupt: 내 미종료 task 는 aborted + 발행자에게 즉시 보고, 열린 보류 만료, 셸 락 해제', async () => {
    const leader = await leaderIn();
    // 팀장이 직접 고용한 팀원 — `[TEAM] 팀원 변경` 알림이 팀장 큐에 끼어들지 않아 보고가 바로 다음 항목이 된다.
    const worker = await ready(office.teamHire(leader.id, { name: '이음', role: '빌드' }));
    const { task } = office.teamDelegate(leader.id, worker.id, '빌드 돌려라');
    assert.equal(taskOf(task.id).status, 'assigned');
    busy(worker);
    // 팀원이 셸 락을 쥐고 허가를 기다리는 중
    void office.shell.acquire(team.id, worker.id, 'tu1', 'npm test');
    const pending = store.createPending({ memberId: worker.id, type: 'approval', payload: { tool_name: 'Bash' } });
    assert.equal(office.shell.holder(team.id)?.memberId, worker.id);

    office.interrupt(worker.id);

    assert.equal(taskOf(task.id).status, 'aborted');
    assert.equal(store.getPending(pending.id)?.status, 'expired');
    assert.equal(office.shell.holder(team.id), undefined, '중단한 명령이 쥔 락은 팀에 돌아간다');
    await sleep(FLUSH_MS);
    assert.ok(
      pastesOf(leader).some((p) => p.includes(`[REPORTS task#${task.id}`) && p.includes('status=aborted')),
      `팀장에게 aborted 보고: ${JSON.stringify(pastesOf(leader))}`,
    );
    assert.ok(notices.some((n) => n.startsWith('info: 이음 후처리(중단)')), notices.join('\n'));
  });

  test('interrupt(팀장): 자기 턴만 끊는다 — 발행한 task 와 팀원은 건드리지 않는다', async () => {
    const leader = await leaderIn();
    const worker = await memberIn('이음');
    const { task } = office.teamDelegate(leader.id, worker.id, '문서 써라');
    busy(leader);

    office.interrupt(leader.id);

    assert.equal(taskOf(task.id).status, 'assigned', '팀 지시는 남는다');
    assert.deepEqual(keysOf(worker), [], '팀원에게 Ctrl+C 가 가지 않는다');
  });

  test('사용자 지시를 중단하면 내 책상에 reporting(aborted) 이벤트가 남는다', async () => {
    const worker = await memberIn('하루'); // 팀장이 없는 팀 → 사용자가 직접 지시
    const taskId = office.instruct(worker.id, '테스트 돌려라');
    busy(worker);

    office.interrupt(worker.id);

    assert.equal(taskOf(taskId).status, 'aborted');
    const ev = events.filter((e) => e.kind === 'reporting' && e.ref.taskId === taskId);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.detail.status, 'aborted');
  });

  // ---- 퇴근 / 종료 / 팀 삭제 ----------------------------------------------------------

  // T36 부터 상위 퇴근은 **하위 트리 전체**를 잎부터 정리한다(01 §"직무 체계 rev 3": 상위가 퇴근하면 하위 트리 전체 정리).
  // T28 때는 팀원을 interrupt 만 하고 세션은 남겼다 — 트리에서는 받을 사람이 없는 세션을 남기는 쪽이 더 이상하다.
  test('퇴근(팀장): 발행 task 전부 aborted + 하위 트리 전체 정리 + MCP 토큰 정리', async () => {
    const leader = await leaderIn();
    const a = await memberIn('이음');
    const b = await memberIn('하루');
    const t1 = office.teamDelegate(leader.id, a.id, '가').task;
    const t2 = office.teamDelegate(leader.id, b.id, '나').task;

    await office.clockOut(leader.id);

    assert.equal(taskOf(t1.id).status, 'aborted');
    assert.equal(taskOf(t2.id).status, 'aborted');
    for (const m of [a, b]) {
      assert.equal(store.getMember(m.id)!.status, 'exited', `${m.name} 도 함께 퇴근한다`);
      assert.ok(mcp.disposed.includes(m.memberToken), `${m.name} 토큰 정리`);
      assert.ok(
        events.some((e) => e.memberId === m.id && e.kind === 'idle' && String(e.detail.summary).includes('상위 정리')),
        `${m.name} 에게 aborted 흔적`,
      );
    }
    assert.deepEqual(
      pty.kills.map((k) => k.memberId),
      [a.id, b.id, leader.id],
      '잎부터: 팀원 둘이 먼저 나가고 팀장이 마지막',
    );
    assert.ok(mcp.disposed.includes(leader.memberToken), 'MCP 연결이 끊긴다');
    assert.equal(store.getMember(leader.id)!.status, 'exited');
    assert.ok(notices.some((n) => n.includes('반장 후처리(퇴근)') && n.includes('하위 2명 정리')), notices.join('\n'));
  });

  test('퇴근(팀장): 하위의 aborted 보고는 나가는 팀장 큐에 밀어 넣지 않는다', async () => {
    const leader = await leaderIn();
    const worker = await ready(office.teamHire(leader.id, { name: '이음', role: '빌드' }));
    const { task } = office.teamDelegate(leader.id, worker.id, '빌드 돌려라');
    busy(worker);
    const leaderSession = pty.session(leader.id); // 퇴근하면 FakePty 맵에서 빠지므로 미리 잡아 둔다
    const before = leaderSession.pastes.length;

    await office.clockOut(leader.id);
    await sleep(FLUSH_MS);

    assert.equal(taskOf(task.id).status, 'aborted');
    assert.equal(
      leaderSession.pastes.slice(before).filter((p) => p.includes('[REPORTS')).length,
      0,
      '받을 팀장이 바로 지금 사라지는 중 — 보고는 버린다',
    );
  });

  test('프로세스 비정상 종료(error): 퇴근과 같은 표로 정리된다(하위 트리 포함)', async () => {
    const leader = await leaderIn();
    const worker = await memberIn('이음');
    const { task } = office.teamDelegate(leader.id, worker.id, '가');
    busy(leader);

    pty.exit(leader.id, 1); // 크래시
    await sleep(20);

    assert.equal(store.getMember(leader.id)!.status, 'error');
    assert.equal(taskOf(task.id).status, 'aborted');
    assert.equal(store.getMember(worker.id)!.status, 'exited', '팀원도 따라 정리된다');
    assert.ok(mcp.disposed.includes(leader.memberToken));
    assert.ok(mcp.disposed.includes(worker.memberToken));
  });

  test('team.delete: 팀원 먼저 · 팀장 마지막으로 퇴근시키고 토큰·셸 락을 전부 정리한다', async () => {
    const leader = await leaderIn();
    const a = await memberIn('이음');
    const b = await memberIn('하루');
    office.teamDelegate(leader.id, a.id, '가');
    void office.shell.acquire(team.id, b.id, 'tu9', 'npm run build');
    const tokens = [leader.memberToken, a.memberToken, b.memberToken];

    await office.deleteTeam(team.id);

    assert.deepEqual(
      pty.kills.map((k) => k.memberId),
      [a.id, b.id, leader.id],
      '팀장이 마지막이어야 한다(먼저 나가면 남은 팀원을 중단시키느라 왕복이 는다)',
    );
    for (const t of tokens) assert.ok(mcp.disposed.includes(t), `토큰 정리: ${t}`);
    assert.equal(office.shell.holder(team.id), undefined);
    assert.equal(office.shell.queueLength(team.id), 0);
    assert.equal(store.getTeam(team.id), undefined);
    assert.equal(store.getMember(leader.id), undefined);
  });

  // ---- 재시작 / 복구 -----------------------------------------------------------------

  test('restart: 열린 허가는 만료되지만 배정된 task 는 같은 세션이 이어 하므로 남는다', async () => {
    const worker = await memberIn('하루');
    const taskId = office.instruct(worker.id, '문서 정리');
    await sleep(FLUSH_MS);
    const pending = store.createPending({ memberId: worker.id, type: 'approval', payload: { tool_name: 'Bash' } });

    await office.restart(worker.id);

    assert.equal(store.getPending(pending.id)?.status, 'expired');
    assert.equal(taskOf(taskId).status, 'assigned');
  });

  // D-36(T36) — D-31 의 남은 한계를 푼다: `member.restart` 도 턴 종료 질문을 살린다.
  test('restart: ask_user·ask_parent 질문은 살아남고 허가·TUI 질문만 만료된다(D-36)', async () => {
    const worker = await memberIn('하루');
    const askUser = store.createPending({ memberId: worker.id, type: 'question', payload: { source: 'ask_user', question: '어디에 둘까?' } });
    const askParent = store.createPending({ memberId: worker.id, type: 'question', payload: { source: 'ask_parent', question: '이어서 할까요?' } });
    const approval = store.createPending({ memberId: worker.id, type: 'approval', payload: { tool_name: 'Bash' } });
    const tui = store.createPending({ memberId: worker.id, type: 'question', payload: { tool_input: { questions: [] } } });

    await office.restart(worker.id);

    assert.equal(store.getPending(askUser.id)?.status, 'open', 'ask_user 는 턴 종료 상태라 프로세스가 죽어도 유효하다');
    assert.equal(store.getPending(askParent.id)?.status, 'open', 'ask_parent 도 같다');
    assert.equal(store.getPending(approval.id)?.status, 'expired');
    assert.equal(store.getPending(tui.id)?.status, 'expired', 'TUI 메뉴는 프로세스와 함께 사라진다');
  });

  test('restart: 살아 있는 hook 보류는 끊는다 — 안 끊으면 죽는 CLI 가 응답을 기다리며 멈춘다(D-36)', async () => {
    const worker = await memberIn('하루');
    // PermissionRequest(AskUserQuestion) → 어댑터가 hold 하고 question pending 을 연다.
    const held = fakeReq(worker.memberToken, 'PermissionRequest', {
      ...base('PermissionRequest'),
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: '어느 걸로?', options: [{ label: 'A' }] }] },
    } as never);
    receiver.emit('hook', held.req);
    await sleep(20);
    const pending = store.listOpenPending(worker.id)[0]!;
    assert.equal(held.handle()?.settled, false, '아직 사용자 답을 기다리는 중');

    await office.restart(worker.id);

    assert.deepEqual(held.sent, [{}], '보류는 취소된다');
    // 이 질문은 TUI 메뉴(tool_input 있음)라 만료된다 — 살아남는 것은 ask_* 뿐(위 테스트).
    assert.equal(store.getPending(pending.id)?.status, 'expired');
  });

  test('표(SETTLE_MATRIX): recover 는 ask_user 질문만 남기고 나머지를 만료 + error 이벤트(D-19·D-15)', () => {
    const m = store.createMember({ departmentId: team.departmentId, teamId: team.id, name: '하루', rank: 'member', engine: 'claude', cwd: dataDir, hiredBy: 'user' });
    const approval = store.createPending({ memberId: m.id, type: 'approval', payload: { tool_name: 'Bash' } });
    const tui = store.createPending({ memberId: m.id, type: 'question', payload: { tool_input: { questions: [] } } });
    const ask = store.createPending({ memberId: m.id, type: 'question', payload: { source: 'ask_user', question: '어디에 둘까?' } });
    const { ctx, appended } = recordingCtx();

    const summary: SettleSummary = settleMember(store, ctx, m.id, 'recover');

    assert.deepEqual(
      summary.expiredPending.map((p) => p.id).sort(),
      [approval.id, tui.id].sort(),
    );
    assert.equal(store.getPending(ask.id)?.status, 'open', 'ask_user 질문은 살아남는다');
    assert.equal(appended.filter((a) => a.kind === 'error').length, 2, '만료마다 "재지시 필요" 흔적');
    // 되살릴 세션이 없는 멤버는 예외까지 지운다.
    settleMember(store, ctx, m.id, 'recover', { expireQuestions: true });
    assert.equal(store.getPending(ask.id)?.status, 'expired');
  });

  test('표(SETTLE_MATRIX): 이유별 정책이 설계(01 §공통 후처리 · rev 3 후처리)와 같다', () => {
    assert.equal(SETTLE_MATRIX.interrupt.issuedTasks, 'keep');
    assert.equal(SETTLE_MATRIX.interrupt.disposeMcp, false);
    assert.equal(SETTLE_MATRIX.interrupt.subtree, false, 'Ctrl+C 는 그 사람의 턴만 끊는다');
    for (const reason of ['clockOut', 'error', 'teamDelete', 'departmentDelete'] as const) {
      assert.equal(SETTLE_MATRIX[reason].ownTasks, 'abort');
      assert.equal(SETTLE_MATRIX[reason].issuedTasks, 'abort');
      assert.equal(SETTLE_MATRIX[reason].interruptTargets, true);
      assert.equal(SETTLE_MATRIX[reason].disposeMcp, true);
      assert.equal(SETTLE_MATRIX[reason].subtree, true, `${reason}: 하위 트리를 잎부터 정리한다`);
    }
    for (const reason of ['restart', 'recover'] as const) {
      assert.equal(SETTLE_MATRIX[reason].ownTasks, 'keep');
      assert.equal(SETTLE_MATRIX[reason].issuedTasks, 'keep');
      assert.equal(SETTLE_MATRIX[reason].subtree, false, `${reason}: 하위는 되살아난 세션에 그대로 보고한다`);
      assert.equal(SETTLE_MATRIX[reason].pending, 'keep-ask', `${reason}: 턴 종료 질문은 살아남는다(D-19·D-36)`);
    }
    // 보류 취소와 pending 만료가 갈라졌다(D-36): 복구만 보류를 안 끊는다(이전 기동의 보류는 이미 없다).
    assert.equal(SETTLE_MATRIX.restart.cancelHolds, true);
    assert.equal(SETTLE_MATRIX.recover.cancelHolds, false);
    // parentGone: 내 것은 거두되 사라지는 상위에 보고하지 않고, 다시 아래로 내려가지도 않는다(호출자가 이미 잎부터다).
    assert.equal(SETTLE_MATRIX.parentGone.ownTasks, 'abort');
    assert.equal(SETTLE_MATRIX.parentGone.reportToIssuer, false);
    assert.equal(SETTLE_MATRIX.parentGone.subtree, false);
    assert.equal(SETTLE_MATRIX.parentGone.disposeMcp, true);
  });

  // ---- 파생 상태 --------------------------------------------------------------------

  test('파생: 열린 허가·질문은 raw 가 무엇이든 waiting_* 로 보인다', async () => {
    const worker = await memberIn('하루');
    assert.equal(derivedStatus(store.getMember(worker.id)!, store), 'free');
    const approval = store.createPending({ memberId: worker.id, type: 'approval', payload: { tool_name: 'Bash' } });
    // raw 는 아직 idle(hook 이 status 를 올리기 전) — 그래도 파생은 허가 대기다.
    assert.equal(derivedStatus(store.getMember(worker.id)!, store), 'waiting_approval');
    store.expirePending(approval.id);
    store.createPending({ memberId: worker.id, type: 'question', payload: { source: 'ask_user', question: '어디?' } });
    assert.equal(derivedStatus(store.getMember(worker.id)!, store), 'waiting_answer');
  });

  test('파생: ask_parent 질문도 waiting_answer 다(부장 전용 ask_user 와 같은 자리, D-32)', async () => {
    const leader = await leaderIn();
    const worker = await memberIn('하루');
    assert.equal(derivedStatus(store.getMember(worker.id)!, store), 'free');

    const q = store.createPending({ memberId: worker.id, type: 'question', payload: { source: 'ask_parent', question: '이어서 할까요?' } });
    assert.equal(derivedStatus(store.getMember(worker.id)!, store), 'waiting_answer');
    assert.equal(derivedStatus(store.getMember(leader.id)!, store), 'free', '상사는 질문 때문에 대기 상태가 되지 않는다');
    // 턴 종료 질문이라 프로세스가 죽어도 유효하다(D-19 → D-36 에서 ask_parent 까지).
    assert.equal(keepsQuestion(store.getPending(q.id)!), true);
    store.answerPending(q.id, { '이어서 할까요?': '응' });
    assert.equal(derivedStatus(store.getMember(worker.id)!, store), 'free');
  });

  test('파생: waiting_reports 는 직급을 가리지 않는다 — 부장도 자식이 있으면 같은 상태(T34 검증)', async () => {
    const leader = await leaderIn();
    const worker = await memberIn('하루');
    const head = store.liveHead(team.departmentId);
    assert.equal(head, undefined, '이 픽스처에는 부장이 없다 — 팀장이 루트다');

    office.teamDelegate(leader.id, worker.id, '가');
    assert.equal(derivedStatus(store.getMember(leader.id)!, store), 'waiting_reports');
    assert.equal(derivedStatus(store.getMember(worker.id)!, store), 'idle', '배정 task 가 있으면 free 가 아니다');
  });

  test('파생: 나간 멤버(exited/error)는 덮지 않는다', async () => {
    const worker = await memberIn('하루');
    store.createPending({ memberId: worker.id, type: 'question', payload: { source: 'ask_user', question: '어디?' } });
    store.updateMember(worker.id, { status: 'exited' });
    assert.equal(derivedStatus(store.getMember(worker.id)!, store), 'exited');
  });

  test('파생: raw 는 idle 그대로인데 파생만 바뀌면 member.status 가 한 번 더 나간다', async () => {
    const leader = await leaderIn();
    const worker = await memberIn('이음');
    assert.equal(derivedOf(leader.id), 'free');
    const before = statusCount(leader.id);

    const { task } = office.teamDelegate(leader.id, worker.id, '가'); // 팀장 raw 는 idle 그대로
    assert.equal(store.getMember(leader.id)!.status, 'idle');
    assert.equal(derivedOf(leader.id), 'waiting_reports');
    assert.ok(statusCount(leader.id) > before, 'raw 가 안 바뀌어도 알림이 나간다');

    // 팀원이 중단되면 팀장의 발행 task 가 0 → 다시 free(역시 raw 는 idle 그대로)
    office.interrupt(worker.id);
    assert.equal(taskOf(task.id).status, 'aborted');
    assert.equal(store.getMember(leader.id)!.status, 'idle');
    assert.equal(derivedOf(leader.id), 'free');
  });

  test('파생: 후처리로 배정 task 가 사라지면 idle → free 알림이 나간다(같은 값이면 안 나간다)', async () => {
    const worker = await memberIn('하루');
    office.instruct(worker.id, '가');
    await sleep(FLUSH_MS);
    office.interrupt(worker.id);
    assert.deepEqual(statuses.at(-1), [worker.id, 'idle', 'free']);
    const count = statusCount(worker.id);
    hook(worker, 'Stop'); // 같은 raw(idle) · 같은 파생(free) → 알림이 더 나가지 않는다
    await sleep(30);
    assert.equal(statusCount(worker.id), count, '파생이 그대로면 알림이 더 나가지 않는다');
  });

  test('snapshot 의 멤버 행에 파생 상태가 실린다', async () => {
    const leader = await leaderIn();
    const worker = await memberIn('이음');
    office.teamDelegate(leader.id, worker.id, '가');
    const snap = office.snapshot();
    const row = (id: string) => snap.members.find((m) => m.id === id)!;
    assert.equal(row(leader.id).derived, 'waiting_reports');
    assert.equal(row(worker.id).status, 'idle');
    assert.equal(row(worker.id).derived, 'idle', '배정 task 가 있으면 한가한 게 아니다');
  });
});

/** settleMember 를 직접 부를 때 쓰는 기록용 ctx(부작용은 전부 여기서 멈춘다). */
function recordingCtx(): { ctx: SettleCtx; appended: Array<{ memberId: string; kind: string }>; notices: string[] } {
  const appended: Array<{ memberId: string; kind: string }> = [];
  const notices: string[] = [];
  const ctx: SettleCtx = {
    expireAllPending: () => {},
    cancelHolds: () => {},
    endSession: () => {},
    releaseShellLocks: () => {},
    disposeMcp: () => {},
    isAlive: () => false,
    interrupt: () => {},
    appendEvent: (member, kind) => appended.push({ memberId: member.id, kind }),
    deliverReports: () => {},
    dropReportBuffer: () => {},
    forgetInFlight: () => {},
    syncDerived: () => {},
    notice: (level, message) => notices.push(`${level}: ${message}`),
  };
  return { ctx, appended, notices };
}
