// T17 ask_user: Office + 실제 TeamToolsServer(임시 포트) + 가짜 pty/receiver.
//   - clockIn 이 sessions/<id>/mcp.json 을 쓰고 spawn 에 mcpConfigPath 를 넘긴다(Claude 만)
//   - MCP 클라이언트로 /mcp/<token> 에 붙어 ask_user → pending(question, source:'ask_user', tool_input 없음) + asking + waiting_answer
//   - 질문이 열린 동안 instruct 는 큐에 머문다 → question.respond → [ANSWER q#id] 가 먼저, 그 뒤 쌓인 [TASK#n]
//   - 답이 턴 진행 중(waiting_answer)에 오면 working 으로, Stop 뒤에 flush
//   - 재시작 복구: ask_user pending 은 open 유지, [RESUMED] 는 답이 올 때까지 대기, respond → [ANSWER] → [RESUMED]
//   - interrupt/clockOut 은 pending 만료 + MCP 항목 정리
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Office, buildAnswerText, isAskUserPayload } from '../../src/office/Office.js';
import { RPC_ERROR } from '../../src/office/errors.js';
import { TeamToolsServer, askUserResultText } from '../../src/mcp/TeamToolsServer.js';
import { Store } from '../../src/store/Store.js';
import type { Member, OfficeEvent, Team } from '../../src/store/types.js';
import { loadFixture } from '../screen/helpers.js';
import { FakePty, FakeReceiver, fakeReq, seedDeptTeam } from './fakes.js';

const SID = 'sess-0001';
const base = (event: string) => ({ session_id: SID, hook_event_name: event, cwd: 'D:\\x' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readyScreen = () => loadFixture('claude-ready.txt').join('\r\n');
const QUESTION = '좋아하는 색은?';

async function mcpClient(port: number, token: string): Promise<Client> {
  const client = new Client({ name: 't17-office-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${token}`)));
  return client;
}

describe('Office ask_user (T17)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let office: Office;
  let team: Team;
  let departmentId: string;
  let events: OfficeEvent[];
  let statuses: Array<[string, string, string]>;
  const clients: Client[] = [];

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t17-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty, receiver, version: 't17' });
    events = [];
    statuses = [];
    office.on('event', (e) => events.push(e));
    office.on('status', (id, s, d) => statuses.push([id, s, d]));
    await office.start();
    // 팀장 없는 팀(store 직접 생성) — 이 파일은 clockIn/ask_user 를 보므로 team.create 의 팀장 자동 출근(T24)을 끼우지 않는다.
    const seeded = seedDeptTeam(store, { name: 'alpha', cwd: dataDir, maxMembers: 3 });
    team = seeded.team;
    departmentId = seeded.department.id;
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    await office.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const clockIn = (name = 'kim', engine: 'claude' | 'codex' = 'claude') => office.clockIn({ teamId: team.id, engine, name });
  /** T35: `ask_user` **도구**는 부장 전용이라 MCP 왕복을 보는 테스트는 부장으로 출근시킨다(팀 없는 부서 직속). */
  const headIn = (name = '부장', engine: 'claude' | 'codex' = 'claude') => office.clockIn({ departmentId, engine, name, rank: 'head' });
  const hook = (m: Member, event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop', extra: Record<string, unknown> = {}) => {
    const r = fakeReq(m.memberToken, event, { ...base(event), ...extra });
    receiver.emit('hook', r.req);
    return r;
  };
  const sessionStart = (m: Member, source = 'startup') => hook(m, 'SessionStart', { source });
  const feedReady = async (m: Member) => {
    pty.data(m.id, readyScreen());
    await sleep(60);
  };
  const connect = async (m: Member) => {
    const c = await mcpClient(office.mcp.port, m.memberToken);
    clients.push(c);
    return c;
  };

  test('clockIn(claude): writes sessions/<id>/mcp.json pointing at /mcp/<token> and passes mcpConfigPath; codex gets none', () => {
    const m = clockIn();
    const opts = pty.spawns[0]!;
    const file = path.join(dataDir, 'sessions', m.id, 'mcp.json');
    assert.equal(opts.mcpConfigPath, file);
    assert.equal(office.mcpConfigPath(m.id), file);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(json, { mcpServers: { team: { type: 'http', url: `http://127.0.0.1:${office.mcp.port}/mcp/${m.memberToken}` } } });
    assert.ok(office.mcp.port > 0);
    assert.equal(office.daemonInfo!.mcpPort, office.mcp.port);

    const codexTeam = seedDeptTeam(store, { name: 'cx', cwd: dataDir, allowedEngines: ['codex'] }).team;
    office.clockIn({ teamId: codexTeam.id, engine: 'codex', name: 'cdx' });
    assert.equal(pty.spawns[1]!.mcpConfigPath, undefined);
  });

  test('MCP ask_user over HTTP → pending(question, source ask_user, no tool_input) + asking event + waiting_answer; result text', async () => {
    const m = headIn();
    sessionStart(m);
    const client = await connect(m);
    const { tools } = await client.listTools();
    // T35: `ask_user` 는 부장 전용이다. 부장 도구 6종이 보인다(팀원은 report·ask_parent 뿐).
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['ask_user', 'create_team', 'delegate', 'dismiss_team', 'reply', 'report'],
    );

    const seqBefore = events.length;
    const r = await client.callTool({ name: 'ask_user', arguments: { question: QUESTION, options: ['빨강', '파랑'] } });
    assert.equal(r.isError ?? false, false);

    const open = store.listOpenPending(m.id);
    assert.equal(open.length, 1);
    const p = open[0]!;
    assert.equal(p.type, 'question');
    assert.equal(p.payload.tool_input, undefined, 'D-19: ask_user pending has no tool_input');
    assert.ok(isAskUserPayload(p.payload));
    assert.deepEqual(p.payload, { source: 'ask_user', question: QUESTION, options: ['빨강', '파랑'] });
    assert.equal((r.content as Array<{ text: string }>)[0]!.text, askUserResultText(p.id));

    const asking = events.slice(seqBefore).find((e) => e.kind === 'asking');
    assert.ok(asking, 'asking event');
    assert.equal(asking.memberId, m.id);
    assert.equal(asking.ref.questionId, p.id);
    assert.equal(asking.detail.summary, QUESTION);
    assert.equal(asking.detail.tool, 'ask_user');
    assert.deepEqual(asking.detail.options, ['빨강', '파랑']);
    assert.equal(store.getMember(m.id)!.status, 'waiting_answer');
    assert.deepEqual(statuses.at(-1), [m.id, 'waiting_answer', 'waiting_answer']);

    // 도구 완료·턴 종료: status 는 idle 이지만 파생 상태는 열린 질문 때문에 waiting_answer
    hook(m, 'PostToolUse', { tool_name: 'mcp__team__ask_user', tool_input: { question: QUESTION } });
    assert.equal(store.getMember(m.id)!.status, 'working');
    hook(m, 'Stop', { last_assistant_message: '색을 물어봤어요.' });
    assert.equal(store.getMember(m.id)!.status, 'idle');
    assert.deepEqual(statuses.at(-1), [m.id, 'idle', 'waiting_answer']);
    assert.equal(store.snapshot().pending.length, 1, 'open ask_user question is in the snapshot');
  });

  test('unknown token → 404; exited member token → 404; member not running → isError', async () => {
    const m = clockIn();
    sessionStart(m);
    await assert.rejects(mcpClient(office.mcp.port, 'deadbeef'), /unknown member token/);
    // 살아 있지만 status 가 exited 로 바뀐 경우(가짜 pty 로 종료를 흉내)
    const client = await connect(m);
    pty.exit(m.id, 0);
    await assert.rejects(client.callTool({ name: 'ask_user', arguments: { question: 'x' } }), /unknown member token/);
    // 직접 호출: 런타임 없음 → -32003
    assert.throws(() => office.askUser(m.id, { question: 'x' }), (e: { code: number }) => e.code === RPC_ERROR.BAD_STATE);
    assert.throws(() => office.askUser('m_nope', { question: 'x' }), (e: { code: number }) => e.code === RPC_ERROR.NOT_FOUND);
    const m2 = clockIn('lee');
    assert.throws(() => office.askUser(m2.id, { question: '   ' }), (e: { code: number }) => e.code === RPC_ERROR.INVALID_PARAMS);
  });

  test('while an ask_user question is open, instruct waits; respond → pending answered, [ANSWER q#id] pasted first, then the queued [TASK#n]', async () => {
    const m = clockIn();
    sessionStart(m);
    const p = office.askUser(m.id, { question: QUESTION, options: ['빨강', '파랑'] });
    hook(m, 'PostToolUse', { tool_name: 'mcp__team__ask_user' });
    hook(m, 'Stop', { last_assistant_message: '물어봤어요.' });
    await feedReady(m);
    const session = pty.session(m.id);

    // 열린 질문 → 새 지시는 큐에 머문다(isIdle = idle ∧ 열린 pending 없음)
    const taskId = office.instruct(m.id, '다음 일');
    await sleep(600);
    assert.deepEqual(session.pastes, [], 'instruct blocked while question open');
    assert.equal(store.getTask(taskId)!.status, 'queued');

    // 잘못된 답
    assert.throws(() => office.respondQuestion(p.id, {}), (e: { code: number }) => e.code === RPC_ERROR.INVALID_PARAMS);
    assert.throws(() => office.respondQuestion(p.id, { [QUESTION]: '  ' }), (e: { code: number }) => e.code === RPC_ERROR.INVALID_PARAMS);
    assert.equal(store.getPending(p.id)!.status, 'open', 'bad answers do not close the pending');

    const statusCount = statuses.length;
    office.respondQuestion(p.id, { [QUESTION]: '파랑' });
    const answered = store.getPending(p.id)!;
    assert.equal(answered.status, 'answered');
    assert.deepEqual(answered.answer, { [QUESTION]: '파랑' });
    assert.equal(store.getMember(m.id)!.status, 'idle', 'status untouched (turn already ended)');
    // derived 가 waiting_answer → idle(배정 task 있음) 로 바뀌었음을 알린다
    assert.equal(statuses.length, statusCount + 1);
    assert.deepEqual(statuses.at(-1), [m.id, 'idle', 'idle']);
    assert.throws(() => office.respondQuestion(p.id, { [QUESTION]: '빨강' }), (e: { code: number }) => e.code === RPC_ERROR.BAD_STATE);

    // 답이 먼저(게이트가 열리자마자), 그 뒤 busy 창(1.5s) 지나 쌓여 있던 [TASK#n]
    await sleep(600);
    assert.deepEqual(session.pastes, [`[ANSWER q#${p.id}]\n파랑`]);
    assert.equal(session.keys.at(-1), 'enter');
    await sleep(1800);
    assert.deepEqual(session.pastes, [`[ANSWER q#${p.id}]\n파랑`, `[TASK#${taskId} from user]\n다음 일`]);
    assert.equal(store.getTask(taskId)!.status, 'assigned');
  });

  test('answer arriving mid-turn (status waiting_answer, before PostToolUse) → working; [ANSWER] flushes after Stop', async () => {
    const m = clockIn();
    sessionStart(m);
    await feedReady(m);
    const p = office.askUser(m.id, { question: QUESTION });
    assert.equal(store.getMember(m.id)!.status, 'waiting_answer');
    office.respondQuestion(p.id, { [QUESTION]: '파랑' });
    assert.equal(store.getMember(m.id)!.status, 'working');
    assert.deepEqual(statuses.at(-1), [m.id, 'working', 'working']);
    await sleep(600);
    assert.deepEqual(pty.session(m.id).pastes, [], 'not idle yet → answer waits');
    hook(m, 'PostToolUse', { tool_name: 'mcp__team__ask_user' });
    hook(m, 'Stop', { last_assistant_message: '기다릴게요.' });
    await sleep(600);
    assert.deepEqual(pty.session(m.id).pastes, [`[ANSWER q#${p.id}]\n파랑`]);
  });

  test('two open questions: the first answer alone does not open the gate; both answers flush in answer order', async () => {
    const m = clockIn();
    sessionStart(m);
    const p1 = office.askUser(m.id, { question: 'Q1?' });
    const p2 = office.askUser(m.id, { question: 'Q2?' });
    hook(m, 'Stop', {});
    await feedReady(m);
    office.respondQuestion(p2.id, { 'Q2?': 'b' });
    await sleep(600);
    assert.deepEqual(pty.session(m.id).pastes, [], 'p1 still open → gate closed');
    office.respondQuestion(p1.id, { 'Q1?': 'a' });
    await sleep(600);
    assert.deepEqual(pty.session(m.id).pastes, [`[ANSWER q#${p1.id}]\na`]);
    await sleep(1800);
    assert.deepEqual(pty.session(m.id).pastes, [`[ANSWER q#${p1.id}]\na`, `[ANSWER q#${p2.id}]\nb`]);
  });

  test('TUI AskUserQuestion pending still goes through the hook decision (no [ANSWER] injection)', async () => {
    const m = clockIn();
    sessionStart(m);
    await feedReady(m);
    const pr = fakeReq(m.memberToken, 'PermissionRequest', {
      ...base('PermissionRequest'),
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'TUI?', options: [{ label: 'x' }] }] },
    });
    receiver.emit('hook', pr.req);
    const p = store.listOpenPending(m.id)[0]!;
    assert.ok(!isAskUserPayload(p.payload));
    office.respondQuestion(p.id, { 'TUI?': 'x' });
    assert.equal(pr.sent.length, 1, 'hook decision returned');
    assert.equal(store.getMember(m.id)!.status, 'working');
    await sleep(600);
    assert.deepEqual(pty.session(m.id).pastes, []);
  });

  test('restart recovery: ask_user pending stays open, [RESUMED] waits for the answer; respond → [ANSWER] then [RESUMED]', async () => {
    // 이전 기동이 남긴 행: 답을 기다리다 죽은 멤버
    const seededStore = new Store(':memory:');
    const t = seedDeptTeam(seededStore, { name: 'r', cwd: dataDir }).team;
    const prev = seededStore.createMember({ departmentId: t.departmentId, teamId: t.id, name: 'R', rank: 'member', engine: 'claude', cwd: dataDir, hiredBy: 'user', status: 'waiting_answer', sessionId: 'sess-R' });
    const q = seededStore.createPending({ memberId: prev.id, type: 'question', payload: { source: 'ask_user', question: QUESTION, options: ['빨강', '파랑'] } });
    const pty2 = new FakePty();
    const receiver2 = new FakeReceiver();
    const office2 = new Office({
      config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 },
      store: seededStore,
      pty: pty2,
      receiver: receiver2,
      version: 't17',
      recovery: { orphanOps: { alive: () => false, name: () => undefined, kill: () => {} } },
    });
    try {
      await office2.start();
      assert.deepEqual(office2.recoveryResult!.resumed, [prev.id]);
      assert.deepEqual(office2.recoveryResult!.expired, []);
      assert.equal(seededStore.getPending(q.id)!.status, 'open', 'ask_user question survives the restart');
      assert.equal(pty2.spawns[0]!.resumeSessionId, 'sess-R');
      assert.ok(pty2.spawns[0]!.mcpConfigPath, 'resumed session gets --mcp-config too');
      const json = JSON.parse(fs.readFileSync(pty2.spawns[0]!.mcpConfigPath!, 'utf8'));
      assert.equal(json.mcpServers.team.url, `http://127.0.0.1:${office2.mcp.port}/mcp/${prev.memberToken}`);

      receiver2.emit('hook', fakeReq(prev.memberToken, 'SessionStart', { ...base('SessionStart'), source: 'resume' }).req);
      pty2.data(prev.id, readyScreen());
      await sleep(600);
      const s = pty2.session(prev.id);
      assert.deepEqual(s.pastes, [], '[RESUMED] waits while the ask_user question is open (T09 trap 5)');
      assert.equal(seededStore.getMember(prev.id)!.status, 'idle');

      office2.respondQuestion(q.id, { [QUESTION]: '파랑' });
      await sleep(600);
      assert.deepEqual(s.pastes, [`[ANSWER q#${q.id}]\n파랑`]);
      await sleep(1800);
      assert.equal(s.pastes.length, 2);
      assert.match(s.pastes[1]!, /^\[RESUMED\] 데몬이 재시작됐다\. 진행 중이던 작업: 없음\./);
    } finally {
      await office2.shutdown();
    }
  });

  test('interrupt expires the open ask_user question; clockOut disposes the MCP entry', async () => {
    const m = headIn();
    sessionStart(m);
    const client = await connect(m);
    await client.callTool({ name: 'ask_user', arguments: { question: QUESTION } });
    const mcp = office.mcp as TeamToolsServer;
    assert.deepEqual(mcp.knownTokens(), [m.memberToken]);
    const p = store.listOpenPending(m.id)[0]!;
    hook(m, 'PostToolUse', { tool_name: 'mcp__team__ask_user' });
    office.interrupt(m.id);
    assert.equal(store.getPending(p.id)!.status, 'expired');
    assert.throws(() => office.respondQuestion(p.id, { [QUESTION]: '파랑' }), (e: { code: number }) => e.code === RPC_ERROR.BAD_STATE);

    await office.clockOut(m.id);
    assert.deepEqual(mcp.knownTokens(), []);
    assert.equal(store.getMember(m.id)!.status, 'exited');
  });

  test('buildAnswerText: single answer → label only; several → "question: label" lines', () => {
    assert.equal(buildAnswerText('q_1', { '색?': '파랑' }), '[ANSWER q#q_1]\n파랑');
    assert.equal(buildAnswerText('q_1', { '색?': ' 파랑 ', '크기?': '대' }), '[ANSWER q#q_1]\n색?: 파랑\n크기?: 대');
    assert.throws(() => buildAnswerText('q_1', {}), (e: { code: number }) => e.code === RPC_ERROR.INVALID_PARAMS);
  });
});
