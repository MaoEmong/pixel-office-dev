// T35 직급별 도구(rev 3, D-32): Office + 가짜 pty/receiver 로 트리 전체를 한 번 돌린다.
//   - 부장 create_team → 팀장이 **부장의 자식**으로 출근 / 팀장 hire → 팀원이 팀장의 자식
//   - delegate 사슬 사용자 → 부장 → 팀장 → 팀원, 봉투가 `[TASK#n from <이름>(<직급>)]`
//   - 보고 사슬 팀원 report → 팀장 버퍼([REPORTS][ALL_REPORTS_IN]) → 팀장 report → 부장 버퍼 → 부장 report → 사용자(reporting)
//   - ask_parent → 상사 큐에 `[QUESTION from <이름> q#n]`, reply → 자식 큐에 `[ANSWER q#n]`, 열린 질문이 없으면 `[MESSAGE from …]`
//   - 직급 게이트: 팀장·팀원의 ask_user, 팀원의 delegate/hire, 남의 부하에게 delegate, 부장의 팀원 직접 지시
//   - dismiss_team: 팀장이 유휴 ∧ 미종료 task 0 일 때만 팀 해산
//   - **T29 결함 ②**: 열린 질문(ask_user/ask_parent)으로 끝낸 턴은 v1a 승격이 사용자 task 를 닫지 않는다
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office, buildMessageText, buildQuestionText, isAskParentPayload, taskMessage } from '../../src/office/Office.js';
import { RPC_ERROR } from '../../src/office/errors.js';
import { ASK_USER_HEAD_ONLY_MESSAGE } from '../../src/mcp/TeamToolsServer.js';
import { Store } from '../../src/store/Store.js';
import type { Department, Member, OfficeEvent, Team } from '../../src/store/types.js';
import { loadFixture } from '../screen/helpers.js';
import { FakePty, FakeReceiver, fakeReq } from './fakes.js';

const SID = 'sess-t35';
const base = (event: string) => ({ session_id: SID, hook_event_name: event, cwd: 'D:\\x' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readyScreen = () => loadFixture('claude-ready.txt').join('\r\n');
/** 큐가 한 항목을 paste + Enter 로 밀어 넣는 데 걸리는 시간(enterDelayMs 300 + 여유). */
const FLUSH_MS = 700;
/** 연달아 두 항목이 나가려면 busyAfterFlushMs(1500) 를 더 기다려야 한다. */
const NEXT_FLUSH_MS = 2400;

describe('직급별 도구 (T35 rev 3)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let office: Office;
  let department: Department;
  let head: Member;
  let events: OfficeEvent[];
  let statuses: Array<[string, string, string]>;
  let notices: string[];

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t35-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty, receiver, version: 't35' });
    events = [];
    statuses = [];
    notices = [];
    office.on('event', (e) => events.push(e));
    office.on('status', (id, s, d) => statuses.push([id, s, d]));
    office.on('notice', (l, m) => notices.push(`${l}: ${m}`));
    await office.start();
    const created = office.createDepartment({ name: 'alpha', cwd: dataDir, headEngine: 'claude', headName: '국장' });
    department = created.department;
    head = await ready(created.head);
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
  async function ready(m: Member): Promise<Member> {
    hook(m, 'SessionStart', { source: 'startup' });
    pty.data(m.id, readyScreen());
    await sleep(60);
    return store.getMember(m.id)!;
  }
  const busy = (m: Member) => hook(m, 'UserPromptSubmit', { prompt: 'x' });
  const stop = (m: Member, lastText?: string) => hook(m, 'Stop', lastText === undefined ? {} : { last_assistant_message: lastText });
  const pastesOf = (m: Member) => pty.session(m.id).pastes;
  const derivedOf = (id: string) => [...statuses].reverse().find((s) => s[0] === id)?.[2];

  /** 부장이 팀을 만들고 팀장을 준비 상태로 만든다. */
  const makeTeam = async (name = '개발', leadName = '팀장A'): Promise<{ team: Team; lead: Member }> => {
    const r = office.teamCreateTeam(head.id, { name, leadName });
    return { team: r.team, lead: await ready(r.lead) };
  };
  /** 팀장이 팀원을 고용하고 준비 상태로 만든다. */
  const makeWorker = async (lead: Member, name = '이음', role = '파일 작성'): Promise<Member> =>
    ready(office.teamHire(lead.id, { name, role }));

  // ---- 트리 구성 ---------------------------------------------------------------------------

  test('create_team(부장): 팀 + 팀장이 부장의 자식으로 출근한다. 팀원은 팀장의 자식', async () => {
    const { team, lead } = await makeTeam();
    assert.equal(team.departmentId, department.id);
    assert.equal(team.cwd, department.cwd, '팀 cwd = 부서 cwd (D-32)');
    assert.equal(lead.rank, 'lead');
    assert.equal(lead.parentId, head.id);
    assert.equal(lead.teamId, team.id);
    assert.equal(lead.engine, head.engine, '엔진을 안 주면 부장과 같다');
    assert.equal(store.getTeam(team.id)!.leaderId, lead.id);

    const worker = await makeWorker(lead);
    assert.equal(worker.rank, 'member');
    assert.equal(worker.parentId, lead.id);
    assert.equal(worker.teamId, team.id);
    assert.equal(worker.hiredBy, 'leader');
    assert.equal(office.getInstructions(worker.id), '# 역할: 파일 작성\n');
    // 부장이 스스로 한 일이므로 [TEAM] 알림은 오지 않는다.
    assert.deepEqual(pastesOf(head), []);
  });

  test('create_team: 팀장 지시문 초안·엔진을 줄 수 있고, 팀원·팀장은 부를 수 없다(-32004)', async () => {
    const r = office.teamCreateTeam(head.id, { name: '문서', leadName: '반장', instructions: '반말로 답한다.' });
    assert.equal(office.getInstructions(r.lead.id), '반말로 답한다.');
    const lead = await ready(r.lead);
    const worker = await makeWorker(lead);

    const rank = (e: { code: number; message: string }) => e.code === RPC_ERROR.RANK_RULE && /쓸 수 있는 도구가 아닙니다/.test(e.message);
    assert.throws(() => office.teamCreateTeam(lead.id, { name: 'x', leadName: 'y' }), rank);
    assert.throws(() => office.teamCreateTeam(worker.id, { name: 'x', leadName: 'y' }), rank);
    assert.throws(() => office.teamHire(head.id, { name: 'x', role: 'y' }), rank);
    assert.throws(() => office.teamCreateTeam(head.id, { name: ' ', leadName: 'y' }), (e: { code: number }) => e.code === RPC_ERROR.INVALID_PARAMS);
    assert.throws(() => office.teamCreateTeam(head.id, { name: 'x', leadName: ' ' }), (e: { code: number }) => e.code === RPC_ERROR.INVALID_PARAMS);
  });

  // ---- delegate 사슬 ----------------------------------------------------------------------

  test('delegate 사슬: 사용자 → 부장 → 팀장 → 팀원, 봉투가 [TASK#n from <이름>(<직급>)]', async () => {
    const { lead } = await makeTeam();
    const worker = await makeWorker(lead);

    const userTask = office.instruct(head.id, '개발 팀에 hello35.txt 를 시켜라');
    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(head), [`[TASK#${userTask} from user]\n개발 팀에 hello35.txt 를 시켜라`]);
    busy(head);

    const toLead = office.teamDelegate(head.id, lead.id, 'hello35.txt 를 쓰게 하라').task;
    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(lead), [`[TASK#${toLead.id} from 국장(부장)]\nhello35.txt 를 쓰게 하라`]);
    busy(lead);

    const toWorker = office.teamDelegate(lead.id, worker.id, 'hello35.txt 에 hi').task;
    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(worker), [`[TASK#${toWorker.id} from 팀장A(팀장)]\nhello35.txt 에 hi`]);

    // 파생 상태: 턴이 끝나면 부장도 팀장도 "보고 대기"(raw idle + 내가 낸 미종료 task)
    stop(lead);
    stop(head);
    assert.equal(derivedOf(head.id), 'waiting_reports');
    assert.equal(derivedOf(lead.id), 'waiting_reports');
    assert.equal(store.getTask(userTask)!.status, 'assigned', '보고를 기다리는 턴 종료는 승격하지 않는다(D-29)');
  });

  test('delegate 대상 규칙: 직속 부하에게만 — 부장이 팀원에게, 팀장이 부장에게, 남의 부하에게는 -32004', async () => {
    const { lead } = await makeTeam();
    const worker = await makeWorker(lead);
    const other = await makeTeam('영업', '팀장B');
    const otherWorker = await makeWorker(other.lead, '남');

    const rank = (e: { code: number }) => e.code === RPC_ERROR.RANK_RULE;
    assert.throws(() => office.teamDelegate(head.id, worker.id, 'x'), rank, '부장 → 팀원(손자)');
    assert.throws(() => office.teamDelegate(lead.id, head.id, 'x'), rank, '팀장 → 부장(상사)');
    assert.throws(() => office.teamDelegate(lead.id, otherWorker.id, 'x'), rank, '남의 팀 팀원');
    assert.throws(() => office.teamDelegate(lead.id, lead.id, 'x'), rank, '자기 자신');
    assert.throws(() => office.teamDelegate(worker.id, worker.id, 'x'), rank, '팀원에게는 delegate 가 없다');
    assert.equal(store.listTasks({ departmentId: department.id }).length, 0);
  });

  // ---- 보고 사슬 --------------------------------------------------------------------------

  test('보고 사슬: 팀원 report → 팀장 [REPORTS][ALL_REPORTS_IN] → 팀장 report → 부장 → 부장 report → 사용자(reporting)', async () => {
    const { lead } = await makeTeam();
    const worker = await makeWorker(lead);

    const userTask = office.instruct(head.id, '보고서');
    await sleep(FLUSH_MS);
    busy(head);
    const toLead = office.teamDelegate(head.id, lead.id, '자료').task;
    await sleep(FLUSH_MS);
    busy(lead);
    const toWorker = office.teamDelegate(lead.id, worker.id, '초안').task;
    await sleep(FLUSH_MS);
    // 둘 다 "맡기고 기다리려고" 턴을 끝낸다 — 그래야 보고가 큐로 흐른다(그리고 승격되지 않는다, D-29).
    stop(lead);
    stop(head);

    // ① 팀원 → 팀장
    const r1 = office.teamReport(worker.id, { taskId: toWorker.id, summary: '초안 끝', status: 'done', files: ['a.txt'] });
    assert.equal(r1.to, 'parent');
    await sleep(NEXT_FLUSH_MS);
    assert.deepEqual(pastesOf(lead).slice(1), [`[REPORTS task#${toWorker.id} 이음 status=done]\n초안 끝\n파일: a.txt\n\n[ALL_REPORTS_IN]`]);

    // ② 팀장 → 부장 (같은 버퍼 규칙이 한 단계 위에서 그대로 돈다)
    const r2 = office.teamReport(lead.id, { taskId: toLead.id, summary: '자료 모았습니다', status: 'done' });
    assert.equal(r2.to, 'parent');
    await sleep(NEXT_FLUSH_MS);
    assert.deepEqual(pastesOf(head).slice(1), [`[REPORTS task#${toLead.id} 팀장A status=done]\n자료 모았습니다\n\n[ALL_REPORTS_IN]`]);

    // ③ 부장 → 사용자 (내 책상 보고: reporting 이벤트 + report_text, 큐 주입은 없다)
    const r3 = office.teamReport(head.id, { taskId: userTask, summary: '완료했습니다', status: 'done' });
    assert.equal(r3.to, 'user');
    const task = store.getTask(userTask)!;
    assert.equal(task.status, 'reported');
    assert.equal(task.reportText, '완료했습니다');
    const rep = [...events].reverse().find((e) => e.kind === 'reporting')!;
    assert.equal(rep.memberId, head.id);
    assert.equal(rep.ref.taskId, userTask);
    await sleep(FLUSH_MS);
    assert.equal(pastesOf(head).length, 2, '사용자 보고는 큐에 아무것도 넣지 않는다');
  });

  test('보고 버퍼는 부모 단위다: 팀장이 낸 두 task 중 하나만 끝나면 아직 안 올라간다(blocked 는 즉시)', async () => {
    const { lead } = await makeTeam();
    const a = await makeWorker(lead, '하루');
    const b = await makeWorker(lead, '이음');
    const t1 = office.teamDelegate(lead.id, a.id, 'A').task;
    const t2 = office.teamDelegate(lead.id, b.id, 'B').task;
    await sleep(FLUSH_MS);

    office.teamReport(a.id, { taskId: t1.id, summary: 'A 끝', status: 'done' });
    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(lead), [], 'B 가 남아 있어 아직 아무것도 안 간다');
    office.teamReport(b.id, { taskId: t2.id, summary: 'B 막힘', status: 'blocked' });
    await sleep(NEXT_FLUSH_MS);
    // blocked 는 버퍼를 건너뛰고 즉시 단독으로 나가고([ALL_REPORTS_IN] 없음), 그것이 마지막 미종료 task 였으므로
    // 버퍼에 남아 있던 A 도 곧바로 뒤따라 나간다(T35: blocked 가 버퍼를 굶기던 T25 의 구멍).
    assert.equal(pastesOf(lead)[0], `[REPORTS task#${t2.id} 이음 status=blocked]\nB 막힘`);
    assert.equal(pastesOf(lead)[1], `[REPORTS task#${t1.id} 하루 status=done]\nA 끝\n\n[ALL_REPORTS_IN]`);
  });

  // ---- ask_parent / reply -------------------------------------------------------------------

  test('ask_parent → 상사 큐에 [QUESTION from …], reply → 자식 큐에 [ANSWER q#n] (열린 질문이 없으면 [MESSAGE from …])', async () => {
    const { lead } = await makeTeam();
    const worker = await makeWorker(lead);
    const task = office.teamDelegate(lead.id, worker.id, '초안').task;
    await sleep(FLUSH_MS);
    busy(worker);

    const p = office.askParent(worker.id, { question: '어느 폴더에 쓸까요?', options: ['src', 'docs'] });
    assert.equal(p.type, 'question');
    assert.ok(isAskParentPayload(p.payload));
    assert.deepEqual(p.payload, {
      source: 'ask_parent',
      question: '어느 폴더에 쓸까요?',
      options: ['src', 'docs'],
      from: worker.id,
      to: lead.id,
    });
    const asking = [...events].reverse().find((e) => e.kind === 'asking')!;
    assert.equal(asking.memberId, worker.id);
    assert.equal(asking.detail.tool, 'ask_parent');
    assert.equal(asking.detail.to, lead.id);
    assert.equal(asking.detail.toName, '팀장A');
    assert.equal(asking.ref.questionId, p.id);
    assert.equal(store.getMember(worker.id)!.status, 'waiting_answer');
    assert.equal(derivedOf(worker.id), 'waiting_answer');

    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(lead), [buildQuestionText(p.id, '이음', '어느 폴더에 쓸까요?', ['src', 'docs'])]);
    assert.equal(pastesOf(lead)[0], `[QUESTION from 이음 q#${p.id}]\n어느 폴더에 쓸까요?\n(옵션: src | docs)`);

    // 팀장이 답한다 → 그 질문이 닫히고 팀원 큐에 [ANSWER]
    stop(worker);
    const replied = office.teamReply(lead.id, { toMember: worker.id, text: 'docs 에 써라' });
    assert.equal(replied.questionId, p.id);
    assert.equal(store.getPending(p.id)!.status, 'answered');
    await sleep(NEXT_FLUSH_MS);
    assert.deepEqual(pastesOf(worker).slice(1), [`[ANSWER q#${p.id}]\ndocs 에 써라`]);

    // 열린 질문이 없으면 그냥 메시지
    const again = office.teamReply(lead.id, { toMember: worker.id, text: '서두르지 마라' });
    assert.equal(again.questionId, undefined);
    await sleep(NEXT_FLUSH_MS);
    assert.deepEqual(pastesOf(worker).slice(2), [buildMessageText('팀장A', '서두르지 마라')]);
    assert.equal(store.getTask(task.id)!.status, 'assigned', '질문·답으로 task 가 닫히지는 않는다');
  });

  test('ask_parent 는 팀장도 쓴다(→ 부장). 부장은 못 쓰고, 팀장·팀원의 ask_user 는 부장 전용 안내로 거절된다', async () => {
    const { lead } = await makeTeam();
    const worker = await makeWorker(lead);

    const p = office.askParent(lead.id, { question: '예산을 더 쓸까요?' });
    await sleep(FLUSH_MS);
    assert.equal(pastesOf(head)[0], `[QUESTION from 팀장A q#${p.id}]\n예산을 더 쓸까요?`);
    office.teamReply(head.id, { toMember: lead.id, text: '아니, 지금 인원으로' });
    assert.equal(store.getPending(p.id)!.status, 'answered');

    const headOnly = (e: { code: number; message: string }) => e.code === RPC_ERROR.RANK_RULE && e.message === ASK_USER_HEAD_ONLY_MESSAGE;
    assert.throws(() => office.teamAskUser(lead.id, { question: 'x' }), headOnly);
    assert.throws(() => office.teamAskUser(worker.id, { question: 'x' }), headOnly);
    assert.equal(ASK_USER_HEAD_ONLY_MESSAGE, '부장만 사용자에게 질문할 수 있습니다. ask_parent를 쓰세요.');
    // 부장은 ask_parent 가 없다(상사가 사용자다).
    assert.throws(
      () => office.askParent(head.id, { question: 'x' }),
      (e: { code: number; message: string }) => e.code === RPC_ERROR.RANK_RULE && /쓸 수 있는 도구가 아닙니다/.test(e.message),
    );
    // reply 는 직속 부하에게만.
    assert.throws(() => office.teamReply(head.id, { toMember: worker.id, text: 'x' }), (e: { code: number }) => e.code === RPC_ERROR.RANK_RULE);
    assert.throws(() => office.teamReply(worker.id, { toMember: lead.id, text: 'x' }), (e: { code: number }) => e.code === RPC_ERROR.RANK_RULE);
  });

  test('사용자가 ask_parent 질문을 앱에서 대신 답해도(question.respond) 같은 [ANSWER] 가 들어간다', async () => {
    const { lead } = await makeTeam();
    const worker = await makeWorker(lead);
    const p = office.askParent(worker.id, { question: '계속할까요?' });
    stop(worker); // 도구를 부른 턴이 끝난다(그래야 큐가 흐른다)
    await sleep(FLUSH_MS);
    office.respondQuestion(p.id, { '계속할까요?': '계속해' });
    assert.equal(store.getPending(p.id)!.status, 'answered');
    await sleep(FLUSH_MS);
    assert.deepEqual(pastesOf(worker), [`[ANSWER q#${p.id}]\n계속해`]);
  });

  // ---- dismiss_team ------------------------------------------------------------------------

  test('dismiss_team: 팀장이 유휴이고 미종료 task 가 없을 때만 — 해산하면 팀원까지 퇴근하고 팀 행이 사라진다', async () => {
    const { team, lead } = await makeTeam();
    const worker = await makeWorker(lead);
    const t = office.teamDelegate(lead.id, worker.id, '초안').task;
    await sleep(FLUSH_MS);

    await assert.rejects(
      office.teamDismissTeam(head.id, team.id),
      (e: { code: number; message: string }) => e.code === RPC_ERROR.BAD_STATE && /미종료 task 가 1건/.test(e.message),
    );
    office.teamReport(worker.id, { taskId: t.id, summary: '끝', status: 'done' });
    busy(lead);
    await assert.rejects(
      office.teamDismissTeam(head.id, team.id),
      (e: { code: number; message: string }) => e.code === RPC_ERROR.BAD_STATE && /아직 working/.test(e.message),
    );
    stop(lead);
    // 팀장·팀원이 아닌 사람은 못 해산한다.
    await assert.rejects(office.teamDismissTeam(lead.id, team.id), (e: { code: number }) => e.code === RPC_ERROR.RANK_RULE);

    const gone = await office.teamDismissTeam(head.id, team.id);
    assert.deepEqual(gone.dismissed.map((m) => m.name).sort(), ['이음', '팀장A']);
    assert.equal(store.getTeam(team.id), undefined);
    assert.equal(store.getMember(lead.id), undefined);
    assert.equal(store.getMember(worker.id), undefined);
    assert.equal(store.getMember(head.id)!.status, 'idle', '부장은 남는다');
  });

  // ---- T29 결함 ②: 열린 질문으로 끝낸 턴은 승격하지 않는다 -------------------------------------

  test('결함 ②(T29): 부장이 ask_user 로 턴을 끝내면 사용자 task 가 닫히지 않는다 — 답한 뒤 진짜 report 가 받아들여진다', async () => {
    const userTask = office.instruct(head.id, '무엇부터 할까');
    await sleep(FLUSH_MS);
    busy(head);

    const p = office.teamAskUser(head.id, { question: '어느 팀부터 만들까요?', options: ['개발', '문서'] });
    stop(head, '어느 팀부터 만들지 여쭤봤습니다.');
    assert.equal(store.getTask(userTask)!.status, 'assigned', '열린 질문이 있으면 승격 금지');
    assert.equal(derivedOf(head.id), 'waiting_answer');
    assert.equal(events.filter((e) => e.kind === 'reporting').length, 0);

    // 사용자가 답하면 질문이 닫히고, 그 뒤 부장이 진짜 report 를 한다 — "이미 보고됐습니다" 가 아니어야 한다.
    office.respondQuestion(p.id, { '어느 팀부터 만들까요?': '개발' });
    await sleep(FLUSH_MS);
    busy(head);
    const r = office.teamReport(head.id, { taskId: userTask, summary: '개발 팀부터 만들었습니다', status: 'done' });
    assert.equal(r.to, 'user');
    assert.equal(store.getTask(userTask)!.reportText, '개발 팀부터 만들었습니다');
  });

  test('결함 ②: ask_parent 로 끝낸 팀원의 턴도 승격되지 않는다(답이 온 다음 턴에서 닫힌다)', async () => {
    const { lead } = await makeTeam();
    const worker = await makeWorker(lead);
    const t = office.teamDelegate(lead.id, worker.id, '초안').task;
    await sleep(FLUSH_MS);
    busy(worker);

    const p = office.askParent(worker.id, { question: '어디에 쓸까요?' });
    stop(worker, '폴더를 여쭤봤습니다.');
    assert.equal(store.getTask(t.id)!.status, 'assigned');
    assert.deepEqual(pastesOf(lead).filter((s) => s.startsWith('[REPORTS')), [], '팀장에게 가짜 보고가 올라가지 않는다');

    office.teamReply(lead.id, { toMember: worker.id, text: 'docs' });
    assert.equal(store.getPending(p.id)!.status, 'answered');
    await sleep(NEXT_FLUSH_MS);
    busy(worker);
    stop(worker, '썼습니다');
    assert.equal(store.getTask(t.id)!.status, 'reported', '질문이 닫힌 뒤의 턴은 평소대로 승격된다');
    await sleep(FLUSH_MS);
    assert.ok(pastesOf(lead).some((s) => s.startsWith(`[REPORTS task#${t.id} 이음 status=done]`)));
  });

  // ---- 문구 빌더 ---------------------------------------------------------------------------

  test('문구 빌더: taskMessage 의 직급 라벨 / buildQuestionText / buildMessageText', () => {
    const task = { id: 7, fromMember: 'm_x', instruction: '해라' } as never;
    assert.equal(taskMessage(task, '국장', 'head'), '[TASK#7 from 국장(부장)]\n해라');
    assert.equal(taskMessage(task, '팀장A', 'lead'), '[TASK#7 from 팀장A(팀장)]\n해라');
    assert.equal(taskMessage({ ...(task as object), fromMember: 'user' } as never, 'user'), '[TASK#7 from user]\n해라');
    assert.equal(buildQuestionText('q_1', '이음', '왜?'), '[QUESTION from 이음 q#q_1]\n왜?');
    assert.equal(buildQuestionText('q_1', '이음', '왜?', ['a', 'b']), '[QUESTION from 이음 q#q_1]\n왜?\n(옵션: a | b)');
    assert.equal(buildMessageText('팀장A', '천천히'), '[MESSAGE from 팀장A]\n천천히');
  });
});
