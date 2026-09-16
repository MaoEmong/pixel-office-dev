// T22: Codex 멤버 폴백 — 턴 종료(`Stop`) 메시지의 **질문 승격**과 **보고 승격**.
//   질문 폴백: 마지막 줄이 질문처럼 보이면 pending(question, fallback) + asking + 파생 waiting_answer,
//              `question.respond` 는 `[ANSWER q#…]` 봉투 없이 답 본문만 보통 프롬프트로 넣는다.
//   보고 폴백: 배정 task 가 있고 질문이 아니면 기존 v1a 경로(Office.afterOfficeEvent)가 그대로 reported 로 닫는다(엔진 공통).
// 페이로드는 T20 과 같은 실측 모양(dev/spike-0/hooklog-codex.json: Stop = {…, turn_id, last_assistant_message}).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office } from '../../src/office/Office.js';
import { CODEX_FALLBACK, detectQuestion, isFallbackQuestion, lastLine, looksLikeQuestion } from '../../src/office/codexFallback.js';
import { Store } from '../../src/store/Store.js';
import type { Member, OfficeEvent, Team } from '../../src/store/types.js';
import { FakePty, FakeReceiver, fakeReq } from './fakes.js';
import { loadFixture } from '../screen/helpers.js';

const SID = '01a09f50-13fe-70a0-90b4-2b2a7cdbcb7a';
const TURN = '01a09f51-0568-7f42-a8b6-083730724090';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** hooklog-codex.json 의 공통 필드. */
const base = (event: string, extra: Record<string, unknown> = {}) => ({
  session_id: SID,
  hook_event_name: event,
  cwd: 'D:\\x',
  model: 'gpt-6-astra',
  turn_id: TURN,
  ...extra,
});

describe('codexFallback (순수 함수)', () => {
  test('lastLine: 마지막 비어 있지 않은 줄, 목록 기호·강조는 뗀다', () => {
    assert.equal(lastLine('첫 줄\n\n- **어느 쪽으로 할까요?**\n\n'), '어느 쪽으로 할까요?');
    assert.equal(lastLine('한 줄'), '한 줄');
    assert.equal(lastLine('\n\n  \n'), '');
  });

  test('looksLikeQuestion: 물음표(?/？)와 정해진 표현', () => {
    for (const s of ['이걸로 할까요?', '어느 쪽이 좋나요？', '(A 와 B 중 뭘 쓸까요?)', 'Which one should I use', '값을 알려주세요', '확인해 주세요.']) {
      assert.ok(looksLikeQuestion(s), `질문이어야 한다: ${s}`);
    }
    for (const s of ['다 했습니다.', '파일 3개를 고쳤어요', '', 'test 를 돌렸고 전부 통과']) {
      assert.equal(looksLikeQuestion(s), false, `질문이 아니어야 한다: ${s}`);
    }
  });

  test('detectQuestion: 마지막 줄만 본다 / 아니면 undefined / 너무 길면 자른다', () => {
    assert.equal(detectQuestion('중간에 물음표? 가 있어도\n마지막은 평서문입니다.'), undefined);
    assert.equal(detectQuestion('작업을 마쳤습니다.\n다음은 어떻게 할까요'), '다음은 어떻게 할까요');
    assert.equal(detectQuestion(undefined), undefined);
    assert.equal(detectQuestion(''), undefined);
    const long = 'ㄱ'.repeat(400) + '?';
    assert.equal(detectQuestion(long)!.length, 300);
  });

  test('isFallbackQuestion 은 표식이 있을 때만', () => {
    assert.ok(isFallbackQuestion({ source: 'ask_user', question: 'q', options: [], fallback: CODEX_FALLBACK }));
    assert.equal(isFallbackQuestion({ source: 'ask_user', question: 'q', options: [] }), false);
  });
});

describe('Office: Codex 폴백 (T22)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let office: Office;
  let team: Team;
  let events: OfficeEvent[];
  let statuses: Array<[string, string, string]>;
  let codex: Member;
  let claude: Member;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t22-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty, receiver, version: '1.0.0' });
    events = [];
    statuses = [];
    office.on('event', (e) => events.push(e));
    office.on('status', (id, s, d) => statuses.push([id, s, d]));
    await office.start();
    // 팀장 없는 팀(store 직접) — Codex 폴백만 보므로 team.create 의 팀장 자동 출근(T24)은 끼우지 않는다.
    team = store.createTeam({ name: 'mix', cwd: dataDir, allowedEngines: ['claude', 'codex'] });
    codex = office.clockIn({ teamId: team.id, engine: 'codex', name: '코덱스' });
    claude = office.clockIn({ teamId: team.id, engine: 'claude', name: '이음' });
  });

  afterEach(async () => {
    await office.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const send = (member: Member, event: string, payload: Record<string, unknown>) => {
    const f = fakeReq(member.memberToken, event as never, payload as never);
    receiver.emit('hook', f.req);
    return f;
  };
  const stop = (member: Member, message: string) => send(member, 'Stop', base('Stop', { last_assistant_message: message, stop_hook_active: false }));
  const idle = (member: Member) => send(member, 'SessionStart', base('SessionStart', { source: 'startup' }));
  const kindsOf = (m: Member) => events.filter((e) => e.memberId === m.id).map((e) => e.kind);
  const lastOf = (m: Member) => events.filter((e) => e.memberId === m.id).at(-1)!;
  /** 준비 화면(Codex ready 픽스처)을 흘려 넣어 큐가 흐르게 한다. */
  const feedReady = async (m: Member) => {
    pty.data(m.id, loadFixture('codex/ready.txt').join('\r\n'));
    await sleep(60);
  };
  /** 배정된 task 하나(큐 흐름 없이 바로 assigned). */
  const assignTask = (m: Member, instruction = '테스트를 돌려줘') =>
    store.createTask({ teamId: team.id, fromMember: 'user', toMember: m.id, instruction, status: 'assigned' });

  test('보고 폴백: Codex 가 report 도구를 안 불러도 Stop 의 마지막 메시지가 task 보고가 된다', () => {
    idle(codex);
    const task = assignTask(codex);
    stop(codex, '테스트 30개 전부 통과했습니다.');
    const done = store.getTask(task.id)!;
    assert.equal(done.status, 'reported');
    assert.equal(done.reportStatus, 'done');
    assert.equal(done.reportText, '테스트 30개 전부 통과했습니다.');
    assert.deepEqual(kindsOf(codex), ['text', 'idle', 'reporting']);
    assert.deepEqual(lastOf(codex).ref, { taskId: task.id });
    assert.equal(store.listOpenPending(codex.id).length, 0, '질문이 아니면 pending 없음');
  });

  test('질문 폴백: 질문으로 끝난 턴은 pending(question, fallback) + asking + 파생 waiting_answer, task 는 assigned 유지', () => {
    idle(codex);
    const task = assignTask(codex);
    stop(codex, '설정 파일을 두 군데서 찾았습니다.\n어느 쪽을 고칠까요?');

    const pendings = store.listOpenPending(codex.id);
    assert.equal(pendings.length, 1);
    assert.deepEqual(pendings[0]!.payload, { source: 'ask_user', question: '어느 쪽을 고칠까요?', options: [], fallback: CODEX_FALLBACK });
    assert.equal(pendings[0]!.type, 'question');

    assert.deepEqual(kindsOf(codex), ['text', 'idle', 'asking']);
    const ev = lastOf(codex);
    assert.deepEqual(ev.detail, { tool: 'ask_user', summary: '어느 쪽을 고칠까요?', fallback: CODEX_FALLBACK });
    assert.equal(ev.ref.questionId, pendings[0]!.id);

    assert.equal(store.getMember(codex.id)!.status, 'idle', '턴은 끝났다 — 실제 status 는 idle');
    assert.deepEqual(statuses.at(-1), [codex.id, 'idle', 'waiting_answer'], '파생은 waiting_answer(내 책상으로 걸어온다)');
    assert.equal(store.getTask(task.id)!.status, 'assigned', '질문으로 끝난 턴은 보고가 아니다');
    assert.equal(events.filter((e) => e.kind === 'reporting').length, 0);
  });

  test('질문 폴백: 열린 질문이 있으면 다음 Stop 에서 또 만들지 않는다', () => {
    idle(codex);
    stop(codex, '어느 쪽을 고칠까요?');
    stop(codex, '아직 답을 기다리는 중입니다. 알려주세요');
    assert.equal(store.listOpenPending(codex.id).length, 1);
    assert.equal(events.filter((e) => e.kind === 'asking').length, 1);
  });

  test('질문 폴백: 답한 뒤 마지막 메시지 없는 턴이 와도 같은 질문을 또 만들지 않는다', async () => {
    idle(codex);
    await feedReady(codex);
    stop(codex, '어느 쪽을 고칠까요?');
    const pending = store.listOpenPending(codex.id)[0]!;
    office.respondQuestion(pending.id, { q: 'dev/daemon 쪽' });
    send(codex, 'Stop', base('Stop', { stop_hook_active: false })); // last_assistant_message 없음
    assert.equal(store.listOpenPending(codex.id).length, 0);
    assert.equal(events.filter((e) => e.kind === 'asking').length, 1);
  });

  test('질문 폴백 답: `[ANSWER q#…]` 봉투 없이 본문만 보통 프롬프트로 들어간다', async () => {
    idle(codex);
    await feedReady(codex);
    stop(codex, '어느 쪽을 고칠까요?');
    const pending = store.listOpenPending(codex.id)[0]!;

    office.respondQuestion(pending.id, { '어느 쪽을 고칠까요?': 'dev/daemon 쪽' });
    assert.equal(store.getPending(pending.id)!.status, 'answered');
    await sleep(700); // InputQueue 폴링(500ms)
    const session = pty.session(codex.id);
    assert.deepEqual(session.pastes, ['dev/daemon 쪽'], '봉투 없이 그대로');
    assert.ok(!session.pastes.some((p) => p.includes('[ANSWER')), '기다리는 MCP 호출이 없으므로 [ANSWER] 를 쓰지 않는다');
  });

  test('진짜 ask_user 질문(MCP)은 그대로 `[ANSWER q#…]` 로 들어간다', async () => {
    idle(codex);
    await feedReady(codex);
    const pending = office.askUser(codex.id, { question: '색은?', options: ['빨강'] });
    assert.equal(isFallbackQuestion(pending.payload), false);
    stop(codex, '질문을 등록했습니다. 답을 기다릴게요.'); // 턴 종료(열린 질문이 있으므로 폴백은 새 질문을 만들지 않는다)
    assert.equal(store.listOpenPending(codex.id).length, 1);
    office.respondQuestion(pending.id, { '색은?': '빨강' });
    await sleep(700);
    assert.deepEqual(pty.session(codex.id).pastes, [`[ANSWER q#${pending.id}]\n빨강`]);
  });

  test('Claude 멤버는 그대로다: 질문으로 끝나도 pending 없이 보고로 닫힌다', () => {
    idle(claude);
    const task = assignTask(claude);
    stop(claude, '두 군데서 찾았습니다.\n어느 쪽을 고칠까요?');
    assert.equal(store.listOpenPending(claude.id).length, 0, 'Claude 는 ask_user 도구를 직접 부른다(폴백 없음)');
    assert.equal(store.getTask(task.id)!.status, 'reported');
    assert.deepEqual(kindsOf(claude), ['text', 'idle', 'reporting']);
  });

  test('질문 폴백은 프로세스가 살아 있을 때만(퇴근 뒤 늦게 온 Stop 은 무시)', async () => {
    idle(codex);
    await office.clockOut(codex.id);
    stop(codex, '어느 쪽을 고칠까요?');
    assert.equal(store.listOpenPending(codex.id).length, 0);
  });
});
