// T25 TeamTools 오케스트레이션: Office + 가짜 pty/receiver(+ 한 건은 진짜 TeamToolsServer 왕복).
//   - hire: 역할 줄이 들어간 INSTRUCTIONS.md, hiredBy leader, 엔진 기본값·정원
//   - delegate: 유휴 팀원 → 즉시 assigned + `[TASK#n from <팀장>(팀장)]` 타이핑 / 바쁜 팀원 → queued 후 idle 이 되면 전달
//   - report: 팀원 둘의 보고가 버퍼링됐다가 마지막 보고에서 `[REPORTS …][ALL_REPORTS_IN]` 한 덩어리로,
//             blocked 는 버퍼를 건너뛰고 즉시, 팀장의 report 는 `reporting` 이벤트 + 사용자 task 종료
//   - dismiss 규칙(사용자 출근 팀원 거부·바쁜 팀원 거부·미종료 task 거부)
//   - 사용자 출근/퇴근 → 팀장 큐에 `[TEAM] 팀원 변경: ±…`
//   - 후처리: 팀원 interrupt → 팀장에게 aborted 보고 / 팀장 퇴근 → 발행 task 전부 aborted + 팀원 interrupt
//   - 파생 상태 waiting_reports
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Office, buildReportsText, buildRoleInstructions, reportBody, roleOf, taskMessage, teamJoinText, teamLeaveText } from '../../src/office/Office.js';
import { RPC_ERROR } from '../../src/office/errors.js';
import { Store } from '../../src/store/Store.js';
import type { Member, OfficeEvent, Team } from '../../src/store/types.js';
import { loadFixture } from '../screen/helpers.js';
import { FakePty, FakeReceiver, fakeReq, seedDeptTeam } from './fakes.js';

const SID = 'sess-0001';
const base = (event: string) => ({ session_id: SID, hook_event_name: event, cwd: 'D:\\x' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readyScreen = () => loadFixture('claude-ready.txt').join('\r\n');
/** 큐가 한 항목을 paste + Enter 로 밀어 넣는 데 걸리는 시간(enterDelayMs 300 + 여유). */
const FLUSH_MS = 700;
/** 연달아 두 항목이 나가려면 busyAfterFlushMs(1500) 를 더 기다려야 한다. */
const NEXT_FLUSH_MS = 2400;

describe('TeamTools 오케스트레이션 (T25)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let office: Office;
  let team: Team;
  let events: OfficeEvent[];
  let statuses: Array<[string, string, string]>;
  let notices: string[];
  const clients: Client[] = [];

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t25-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty, receiver, version: 't25' });
    events = [];
    statuses = [];
    notices = [];
    office.on('event', (e) => events.push(e));
    office.on('status', (id, s, d) => statuses.push([id, s, d]));
    office.on('notice', (l, m) => notices.push(`${l}: ${m}`));
    await office.start();
    // 팀장은 아래 leaderIn() 으로 직접 출근시킨다(team.create 는 TeamRank.test.ts 담당).
    team = seedDeptTeam(store, { name: 'alpha', cwd: dataDir, maxMembers: 4, allowedEngines: ['claude'] }).team;
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
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
  const busy = (m: Member) => hook(m, 'UserPromptSubmit', { prompt: 'x' });
  const stop = (m: Member, lastText?: string) => hook(m, 'Stop', lastText === undefined ? {} : { last_assistant_message: lastText });

  const leaderIn = async (name = '반장') => ready(office.clockIn({ teamId: team.id, engine: 'claude', name, rank: 'lead' }));
  const memberIn = async (name: string, instructions?: string) =>
    ready(office.clockIn({ teamId: team.id, engine: 'claude', name, instructions }));
  const hired = async (leader: Member, name: string, role = '파일 작성') =>
    ready(office.teamHire(leader.id, { name, role }));

  const pastesOf = (m: Member) => pty.session(m.id).pastes;
  const derivedOf = (id: string) => [...statuses].reverse().find((s) => s[0] === id)?.[2];

  // ---- hire ------------------------------------------------------------------------------

  test('hire: hiredBy leader / rank member, INSTRUCTIONS.md 첫 줄이 "# 역할: …", 엔진 기본은 팀장과 같다', async () => {
    const leader = await leaderIn();
    const m = office.teamHire(leader.id, { name: '이음', role: '파일 작성', instructions: '반말로 답한다.' });
    assert.equal(m.hiredBy, 'leader');
    assert.equal(m.rank, 'member');
    assert.equal(m.engine, 'claude');
    assert.equal(office.getInstructions(m.id), '# 역할: 파일 작성\n\n반말로 답한다.\n');
    assert.equal(roleOf(office.getInstructions(m.id)), '파일 작성');
    // 팀장 자신이 한 일이므로 [TEAM] 알림은 오지 않는다.
    assert.deepEqual(pastesOf(leader), []);
    assert.equal(pty.spawns.at(-1)!.memberId, m.id);
  });

  test('hire: 팀원이 부르면 -32004, 정원이 차면 -32003, 허용 안 된 엔진은 -32602', async () => {
    const leader = await leaderIn();
    const worker = await hired(leader, '이음');
    assert.throws(
      () => office.teamHire(worker.id, { name: 'x', role: 'y' }),
      (e: { code: number; message: string }) => e.code === RPC_ERROR.RANK_RULE && /팀원이\(가\) 쓸 수 있는 도구가 아닙니다/.test(e.message),
    );
    assert.throws(
      () => office.teamHire(leader.id, { name: 'x', role: '' }),
      (e: { code: number }) => e.code === RPC_ERROR.INVALID_PARAMS,
    );
    assert.throws(
      () => office.teamHire(leader.id, { name: 'x', role: 'y', engine: 'codex' }),
      (e: { code: number; message: string }) => e.code === RPC_ERROR.INVALID_PARAMS && /허용되지 않은 엔진/.test(e.message),
    );
    office.teamHire(leader.id, { name: '두울', role: 'y' });
    office.teamHire(leader.id, { name: '세엣', role: 'y' }); // 팀장 포함 4/4
    assert.throws(
      () => office.teamHire(leader.id, { name: '네엣', role: 'y' }),
      (e: { code: number; message: string }) => e.code === RPC_ERROR.BAD_STATE && /is full \(4\/4\)/.test(e.message),
    );
  });

  // ---- delegate ---------------------------------------------------------------------------

  test('delegate: 유휴 팀원에게는 즉시 assigned + [TASK#n from <팀장>(팀장)] 이 타이핑된다', async () => {
    const leader = await leaderIn();
    const worker = await hired(leader, '이음');
    const r = office.teamDelegate(leader.id, worker.id, 'hello.txt 에 hi 라고 써라');
    assert.equal(r.assigned, true);
    assert.equal(store.getTask(r.task.id)!.status, 'assigned');
    assert.equal(store.getTask(r.task.id)!.fromMember, leader.id);

    const del = [...events].reverse().find((e) => e.kind === 'delegating')!;
    assert.equal(del.memberId, leader.id);
    assert.equal(del.ref.taskId, r.task.id);
    assert.equal(del.detail.to, worker.id);

    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(worker), [`[TASK#${r.task.id} from 반장(팀장)]\nhello.txt 에 hi 라고 써라`]);
  });

  test('delegate: 바쁜 팀원에게는 queued 로 남고, 그 팀원이 idle 이 되는 순간 전달된다(유휴 감시)', async () => {
    const leader = await leaderIn();
    const worker = await hired(leader, '이음');
    busy(worker);
    const r = office.teamDelegate(leader.id, worker.id, '두 번째 일');
    assert.equal(r.assigned, false);
    assert.equal(store.getTask(r.task.id)!.status, 'queued');
    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(worker), [], '바쁜 동안엔 아무것도 안 들어간다');

    stop(worker); // 턴 종료 → idle → 유휴 감시가 전달
    assert.equal(store.getTask(r.task.id)!.status, 'assigned');
    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(worker), [`[TASK#${r.task.id} from 반장(팀장)]\n두 번째 일`]);
    // 같은 task 가 두 번 들어가지 않는다(inFlight 가드).
    stop(worker);
    await sleep(NEXT_FLUSH_MS);
    assert.equal(pastesOf(worker).length, 1);
  });

  test('delegate: 같은 팀이 아니거나 팀장·자기 자신이면 -32004, 팀원이 부르면 -32004', async () => {
    const leader = await leaderIn();
    const worker = await hired(leader, '이음');
    const other = seedDeptTeam(store, { name: 'beta', cwd: dataDir, departmentName: 'beta-dept' }).team;
    const stranger = await ready(office.clockIn({ teamId: other.id, engine: 'claude', name: '남' }));

    const rank = (e: { code: number }) => e.code === RPC_ERROR.RANK_RULE;
    assert.throws(() => office.teamDelegate(leader.id, stranger.id, 'x'), rank);
    assert.throws(() => office.teamDelegate(leader.id, leader.id, 'x'), rank);
    assert.throws(() => office.teamDelegate(worker.id, worker.id, 'x'), rank);
    assert.throws(() => office.teamDelegate(leader.id, 'm_nope', 'x'), (e: { code: number }) => e.code === RPC_ERROR.NOT_FOUND);
    assert.throws(() => office.teamDelegate(leader.id, worker.id, '   '), (e: { code: number }) => e.code === RPC_ERROR.INVALID_PARAMS);
    assert.equal(store.listTasks({ departmentId: team.departmentId }).length, 0);
  });

  // ---- report -----------------------------------------------------------------------------

  test('report: 팀원 둘의 보고가 버퍼링됐다가 마지막 보고에서 한 덩어리 + [ALL_REPORTS_IN] 으로 팀장에게 간다', async () => {
    const leader = await leaderIn();
    const a = await hired(leader, '하루');
    const b = await hired(leader, '이음');
    const t1 = office.teamDelegate(leader.id, a.id, 'A 일').task;
    const t2 = office.teamDelegate(leader.id, b.id, 'B 일').task;
    await sleep(FLUSH_MS);

    office.teamReport(a.id, { taskId: t1.id, summary: 'A 끝', status: 'done', files: ['a.txt'] });
    assert.equal(store.getTask(t1.id)!.status, 'reported');
    assert.equal(store.getTask(t1.id)!.reportText, 'A 끝\n파일: a.txt');
    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(leader), [], '아직 B 가 남았으므로 팀장에게 아무것도 안 간다');

    office.teamReport(b.id, { taskId: t2.id, summary: 'B 끝', status: 'done' });
    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(leader), [
      `[REPORTS task#${t1.id} 하루 status=done]\nA 끝\n파일: a.txt\n\n[REPORTS task#${t2.id} 이음 status=done]\nB 끝\n\n[ALL_REPORTS_IN]`,
    ]);
    // 보고자 쪽에는 reporting 이벤트가 남는다(사무실 말풍선).
    const rep = events.filter((e) => e.kind === 'reporting');
    assert.deepEqual(
      rep.map((e) => [e.memberId, e.ref.taskId]),
      [
        [a.id, t1.id],
        [b.id, t2.id],
      ],
    );
  });

  test('report(blocked): 버퍼를 건너뛰고 즉시 단독으로 전달된다([ALL_REPORTS_IN] 없음)', async () => {
    const leader = await leaderIn();
    const a = await hired(leader, '하루');
    const b = await hired(leader, '이음');
    const t1 = office.teamDelegate(leader.id, a.id, 'A 일').task;
    office.teamDelegate(leader.id, b.id, 'B 일');
    await sleep(FLUSH_MS);

    office.teamReport(a.id, { taskId: t1.id, summary: '권한이 없어 못 함', status: 'blocked' });
    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(leader), [`[REPORTS task#${t1.id} 하루 status=blocked]\n권한이 없어 못 함`]);
  });

  test('report: 남의 task 는 -32004, 이미 보고된 task 는 -32003, 팀장의 report 는 사용자 task 를 닫는다', async () => {
    const leader = await leaderIn();
    const worker = await hired(leader, '이음');
    const taskId = office.instruct(leader.id, '보고서 써 줘'); // 사용자 → 팀장 (T24)
    await sleep(FLUSH_MS);
    busy(leader);

    assert.throws(
      () => office.teamReport(worker.id, { taskId, summary: 'x', status: 'done' }),
      (e: { code: number; message: string }) => e.code === RPC_ERROR.RANK_RULE && /배정된 작업이 아닙니다/.test(e.message),
    );
    assert.throws(
      () => office.teamReport(leader.id, { taskId: 9999, summary: 'x', status: 'done' }),
      (e: { code: number }) => e.code === RPC_ERROR.NOT_FOUND,
    );

    const r = office.teamReport(leader.id, { taskId, summary: '다 했습니다', status: 'done' });
    assert.equal(r.to, 'user');
    const task = store.getTask(taskId)!;
    assert.equal(task.status, 'reported');
    assert.equal(task.reportStatus, 'done');
    assert.equal(task.reportText, '다 했습니다');
    const rep = [...events].reverse().find((e) => e.kind === 'reporting')!;
    assert.equal(rep.memberId, leader.id);
    assert.equal(rep.ref.taskId, taskId);
    assert.equal(rep.detail.summary, '다 했습니다');
    assert.throws(
      () => office.teamReport(leader.id, { taskId, summary: 'x', status: 'done' }),
      (e: { code: number; message: string }) => e.code === RPC_ERROR.BAD_STATE && /이미 보고/.test(e.message),
    );

    // 턴 종료의 v1a 보고 승격이 같은 task 를 두 번 보고하지 않는다.
    const before = events.filter((e) => e.kind === 'reporting').length;
    stop(leader, '다 했습니다');
    assert.equal(events.filter((e) => e.kind === 'reporting').length, before);
  });

  test('보고를 기다리는 팀장의 턴 종료는 사용자 task 를 닫지 않는다(실기 함정) — report 가 "이미 보고됨"으로 거절되면 안 된다', async () => {
    const leader = await leaderIn();
    const worker = await hired(leader, '이음');
    const userTask = office.instruct(leader.id, '보고서 써 줘');
    await sleep(FLUSH_MS);
    busy(leader);
    const sub = office.teamDelegate(leader.id, worker.id, '자료 모아 줘').task;

    // 팀장이 "맡겼고 기다리는 중" 이라고 말하며 턴을 끝낸다 → 아직 끝난 게 아니다.
    stop(leader, '보조에게 맡겼고 보고를 기다리는 중이에요.');
    assert.equal(store.getTask(userTask)!.status, 'assigned', '승격되지 않는다');
    assert.equal(derivedOf(leader.id), 'waiting_reports');

    // 보고가 다 들어온 뒤의 턴에서 팀장이 report 로 닫는다(거절 없이).
    await sleep(FLUSH_MS);
    office.teamReport(worker.id, { taskId: sub.id, summary: '모았습니다', status: 'done' });
    busy(leader);
    const r = office.teamReport(leader.id, { taskId: userTask, summary: '취합 결과', status: 'done' });
    assert.equal(r.to, 'user');
    assert.equal(store.getTask(userTask)!.reportText, '취합 결과');
  });

  test('report 없이 턴만 끝내도(v1a 승격) 팀장 버퍼를 탄다 — [ALL_REPORTS_IN] 이 영영 안 오는 것을 막는다', async () => {
    const leader = await leaderIn();
    const a = await hired(leader, '하루');
    const t1 = office.teamDelegate(leader.id, a.id, 'A 일').task;
    await sleep(FLUSH_MS);
    busy(a);
    stop(a, '다 썼습니다');
    assert.equal(store.getTask(t1.id)!.status, 'reported');
    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(leader), [`[REPORTS task#${t1.id} 하루 status=done]\n다 썼습니다\n\n[ALL_REPORTS_IN]`]);
  });

  // ---- dismiss ----------------------------------------------------------------------------

  test('dismiss: 팀장이 hire 한 유휴 팀원만 — 사용자 출근 팀원·바쁜 팀원·미종료 task 는 거절', async () => {
    const leader = await leaderIn();
    const byUser = await memberIn('사용자팀원');
    const byLeader = await hired(leader, '이음');

    await assert.rejects(
      office.teamDismiss(leader.id, byUser.id),
      (e: { code: number; message: string }) => e.code === RPC_ERROR.RANK_RULE && /퇴근 버튼으로만/.test(e.message),
    );
    await assert.rejects(office.teamDismiss(byLeader.id, byUser.id), (e: { code: number }) => e.code === RPC_ERROR.RANK_RULE);
    await assert.rejects(office.teamDismiss(leader.id, leader.id), (e: { code: number }) => e.code === RPC_ERROR.RANK_RULE);

    const t = office.teamDelegate(leader.id, byLeader.id, '일').task;
    await assert.rejects(
      office.teamDismiss(leader.id, byLeader.id),
      (e: { code: number; message: string }) => e.code === RPC_ERROR.BAD_STATE && /미종료 task 가 1건/.test(e.message),
    );
    office.teamReport(byLeader.id, { taskId: t.id, summary: '끝', status: 'done' });

    busy(byLeader);
    await assert.rejects(
      office.teamDismiss(leader.id, byLeader.id),
      (e: { code: number; message: string }) => e.code === RPC_ERROR.BAD_STATE && /아직 working/.test(e.message),
    );
    stop(byLeader);

    const gone = await office.teamDismiss(leader.id, byLeader.id);
    assert.equal(gone.status, 'exited');
    assert.deepEqual(pty.kills.at(-1), { memberId: byLeader.id, graceful: true });
  });

  // ---- 사용자 개입 · [TEAM] 알림 -------------------------------------------------------------

  test('사용자 출근/퇴근 → 팀장 큐에 [TEAM] 팀원 변경: +이름(엔진, 역할 …) / -이름', async () => {
    const leader = await leaderIn();
    const m = office.clockIn({ teamId: team.id, engine: 'claude', name: '이음', instructions: '# 역할: 테스트\n\n본문' });
    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(leader), ['[TEAM] 팀원 변경: +이음(claude, 역할: 테스트)']);
    await ready(m);

    await office.clockOut(m.id);
    await sleep(NEXT_FLUSH_MS);
    assert.deepEqual(pastesOf(leader), ['[TEAM] 팀원 변경: +이음(claude, 역할: 테스트)', '[TEAM] 팀원 변경: -이음']);
    // 팀장이 dismiss 한 경우에는 자기에게 알림이 돌아오지 않는다.
    const byLeader = await hired(leader, '두울');
    await office.teamDismiss(leader.id, byLeader.id);
    await sleep(NEXT_FLUSH_MS);
    assert.equal(pastesOf(leader).length, 2);
  });

  // ---- 후처리 -----------------------------------------------------------------------------

  test('팀원 interrupt → 그 task 가 aborted 되고 팀장에게 [REPORTS … status=aborted] 가 즉시 간다', async () => {
    const leader = await leaderIn();
    const worker = await hired(leader, '이음');
    const t = office.teamDelegate(leader.id, worker.id, '오래 걸리는 일').task;
    await sleep(FLUSH_MS);
    busy(worker);

    office.interrupt(worker.id);
    assert.equal(store.getTask(t.id)!.status, 'aborted');
    assert.equal(store.getTask(t.id)!.reportStatus, 'aborted');
    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(leader), [`[REPORTS task#${t.id} 이음 status=aborted]\n이음 의 작업이 중단됐습니다 (중단(interrupt)).`]);
  });

  // T36: 팀장이 나가면 그 **하위 트리 전체**가 따라 정리된다(01 §rev 3 후처리). T25 때는 팀원을 interrupt 만 하고
  // 세션을 남겼는데, 트리에서는 받을 사람이 없는 세션이 남는 쪽이 더 이상하다(행은 exited 로 남아 rehire 가능).
  test('팀장 퇴근 → 발행한 task 전부 aborted + 하위 팀원도 함께 정리(행은 남는다)', async () => {
    const leader = await leaderIn();
    const worker = await hired(leader, '이음');
    const byUser = await memberIn('사용자팀원');
    const t = office.teamDelegate(leader.id, worker.id, '일').task;
    await sleep(FLUSH_MS);
    busy(worker);

    await office.clockOut(leader.id);
    assert.equal(store.getTask(t.id)!.status, 'aborted');
    assert.equal(store.getMember(worker.id)!.status, 'exited', '맡고 있던 팀원도 함께 나간다');
    assert.equal(store.getMember(byUser.id)!.status, 'exited', '사용자가 출근시킨 팀원도 트리 아래라면 같이 나간다');
    assert.ok(store.getMember(worker.id), '행 자체는 남는다(rehire 가능)');
    assert.equal(store.liveLeader(team.id), undefined);
  });

  // ---- 파생 상태 ---------------------------------------------------------------------------

  test('derived waiting_reports: 팀장이 idle 이어도 발행한 미종료 task 가 있으면 보고 대기로 보인다', async () => {
    const leader = await leaderIn();
    const worker = await hired(leader, '이음');
    assert.equal(derivedOf(leader.id), 'free');

    const t = office.teamDelegate(leader.id, worker.id, '일').task;
    assert.equal(derivedOf(leader.id), 'waiting_reports');
    await sleep(FLUSH_MS);

    office.teamReport(worker.id, { taskId: t.id, summary: '끝', status: 'done' });
    assert.equal(derivedOf(leader.id), 'free');
    // 팀원 쪽은 배정 task 가 있으면 idle, 없으면 free (기존 규칙 그대로)
    assert.equal(derivedOf(worker.id), 'free');
  });

  // ---- MCP 왕복 --------------------------------------------------------------------------

  test('MCP 왕복: 팀장 토큰으로 hire → delegate → 팀원 토큰으로 report 까지 실제 HTTP 로 돈다', async () => {
    const leader = await leaderIn();
    const client = new Client({ name: 't25-test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${office.mcp.port}/mcp/${leader.memberToken}`)));
    clients.push(client);

    const h = await client.callTool({ name: 'hire', arguments: { name: '이음', role: '파일 작성' } });
    assert.equal(h.isError ?? false, false);
    const worker = store.listMembers(team.id).find((m) => m.name === '이음')!;
    assert.equal((h.content as Array<{ text: string }>)[0]!.text, `팀원 이음 (${worker.id}) 출근. 엔진 claude.`);
    await ready(worker);

    const d = await client.callTool({ name: 'delegate', arguments: { to_member: worker.id, task: 'hello25.txt 에 hi' } });
    const taskId = store.listTasks({ fromMember: leader.id })[0]!.id;
    assert.equal((d.content as Array<{ text: string }>)[0]!.text.startsWith(`task#${taskId} → 이음 (assigned)`), true);

    const wc = new Client({ name: 't25-worker', version: '0' });
    await wc.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${office.mcp.port}/mcp/${worker.memberToken}`)));
    clients.push(wc);
    assert.deepEqual((await wc.listTools()).tools.map((t) => t.name).sort(), ['ask_parent', 'report']);
    const rep = await wc.callTool({ name: 'report', arguments: { taskId, summary: '썼습니다', status: 'done' } });
    assert.equal(rep.isError ?? false, false);
    assert.equal(store.getTask(taskId)!.status, 'reported');
    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(leader), [`[REPORTS task#${taskId} 이음 status=done]\n썼습니다\n\n[ALL_REPORTS_IN]`]);
  });

  // ---- 문구 빌더 ---------------------------------------------------------------------------

  test('문구 빌더: taskMessage / buildReportsText / reportBody / buildRoleInstructions / teamJoinText', () => {
    const t = store.createTask({ departmentId: team.departmentId, fromMember: 'user', toMember: 'm1', instruction: '해라' });
    assert.equal(taskMessage(t, 'user'), `[TASK#${t.id} from user]\n해라`);
    const t2 = store.createTask({ departmentId: team.departmentId, fromMember: 'm_lead', toMember: 'm1', instruction: '해라' });
    assert.equal(taskMessage(t2, '반장'), `[TASK#${t2.id} from 반장(팀장)]\n해라`);

    assert.equal(buildReportsText([{ taskId: 1, name: '하루', status: 'blocked', body: '막힘' }], false), '[REPORTS task#1 하루 status=blocked]\n막힘');
    assert.equal(
      buildReportsText(
        [
          { taskId: 1, name: '하루', status: 'done', body: 'A' },
          { taskId: 2, name: '이음', status: 'done', body: 'B' },
        ],
        true,
      ),
      '[REPORTS task#1 하루 status=done]\nA\n\n[REPORTS task#2 이음 status=done]\nB\n\n[ALL_REPORTS_IN]',
    );
    assert.equal(reportBody('끝', []), '끝');
    assert.equal(reportBody('끝', ['a.ts', 'b.ts']), '끝\n파일: a.ts, b.ts');
    assert.equal(buildRoleInstructions('역할', undefined), '# 역할: 역할\n');
    assert.equal(roleOf('# 역할: 파일 작성\n본문'), '파일 작성');
    assert.equal(roleOf('본문만'), undefined);
    assert.equal(teamJoinText('이음', 'codex'), '[TEAM] 팀원 변경: +이음(codex)');
    assert.equal(teamLeaveText('이음'), '[TEAM] 팀원 변경: -이음');
    assert.equal(notices.filter((n) => n.startsWith('error')).length, 0);
  });
});
