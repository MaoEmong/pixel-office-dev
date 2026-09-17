// T30 ①: hook 핸들러가 던져도 CLI 를 세워 두지 않는다.
// D-38 딸린 관찰의 재현 — 어댑터는 `req.hold()` **뒤에** `store.createPending()` 을 부른다. 그 호출이 던지면(개발 DB 의
// `no such table: main.members_v1`) 예전 catch 의 `req.respond(PASS_THROUGH)` 는 receiver 계약상 먹지 않아 hook 프로세스가
// 영영 매달렸다 = CLI 가 자기 TUI 프롬프트를 띄운 채 멈춘다. 이제는 열린 보류를 직접 pass-through 로 닫고,
// `error{summary:'hook handler failed: …'}` 이벤트 + `handler-error`(→ Office 의 `daemon.notice{error}`) 를 낸다.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeHooksAdapter } from '../../src/adapters/ClaudeHooksAdapter.js';
import { HookReceiver } from '../../src/hooks/HookReceiver.js';
import { PASS_THROUGH } from '../../src/hooks/decisions.js';
import { Store } from '../../src/store/Store.js';
import type { Member, OfficeEvent } from '../../src/store/types.js';
import type { DecisionHandle, HookRequest } from '../../src/hooks/HookReceiver.js';
import type { HookEvent, HookPayload } from '../../src/hooks/types.js';

// ---- 가짜 HookRequest (ClaudeHooksAdapter.test.ts 와 같은 계약) --------------------

interface FakeReq {
  req: HookRequest;
  sent: unknown[];
  state: () => 'open' | 'responded' | 'held';
  handle: () => DecisionHandle | undefined;
}

function fakeReq(memberToken: string, event: HookEvent, payload: HookPayload): FakeReq {
  const sent: unknown[] = [];
  let state: 'open' | 'responded' | 'held' = 'open';
  let handle: DecisionHandle | undefined;
  const req: HookRequest = {
    memberToken,
    event,
    payload,
    respond(json) {
      if (state !== 'open') return false;
      state = 'responded';
      sent.push(json);
      return true;
    },
    hold() {
      if (state !== 'open') throw new Error(`already ${state}`);
      state = 'held';
      let settled = false;
      handle = {
        memberToken,
        event,
        since: Date.now(),
        get settled() {
          return settled;
        },
        resolve(json) {
          if (settled) return false;
          settled = true;
          sent.push(json);
          return true;
        },
        cancel() {
          if (settled) return false;
          settled = true;
          sent.push({});
          return true;
        },
      };
      return handle;
    },
  };
  return { req, sent, state: () => state, handle: () => handle };
}

const COMMON = { session_id: 's1', cwd: 'D:/proj/alpha' };
const BROKEN = 'no such table: main.members_v1';

interface Harness {
  store: Store;
  adapter: ClaudeHooksAdapter;
  member: Member;
  events: OfficeEvent[];
  handlerErrors: Array<[unknown, string, string]>;
  send: (event: HookEvent, payload: HookPayload) => FakeReq;
  breakPending: () => void;
}

function harness(): Harness {
  const store = new Store(':memory:');
  const department = store.createDepartment({ name: 'alpha', cwd: 'D:/proj/alpha' });
  const team = store.createTeam({ departmentId: department.id, name: 'alpha', cwd: 'D:/proj/alpha' });
  const member = store.createMember({
    departmentId: team.departmentId,
    teamId: team.id,
    name: '이음',
    rank: 'member',
    engine: 'claude',
    cwd: team.cwd,
    hiredBy: 'user',
    memberToken: 'tok1',
  });
  const events: OfficeEvent[] = [];
  const handlerErrors: Array<[unknown, string, string]> = [];
  const adapter = new ClaudeHooksAdapter({ store, getInstructions: () => undefined, toolGate: undefined });
  adapter.on('event', (ev) => events.push(ev));
  adapter.on('handler-error', (err, memberId, event) => handlerErrors.push([err, memberId, event]));
  return {
    store,
    adapter,
    member,
    events,
    handlerErrors,
    send: (event, payload) => {
      const f = fakeReq(member.memberToken, event, payload);
      adapter.handleHook(f.req, store.getMember(member.id)!);
      return f;
    },
    // D-38 의 모양: pending 을 만들려는 순간 store 가 던진다(어댑터는 이미 hold() 했다).
    breakPending: () => {
      store.createPending = () => {
        throw new Error(BROKEN);
      };
    },
  };
}

describe('T30 hook 핸들러 예외', () => {
  let h: Harness;
  let errorLog: typeof console.error;
  beforeEach(() => {
    h = harness();
    errorLog = console.error;
    console.error = () => {};
  });
  afterEach(() => {
    console.error = errorLog;
    h.store.close();
  });

  test('D-38 재현: createPending 이 hold() 뒤에 던져도 보류가 pass-through 로 닫힌다 (PermissionRequest)', () => {
    h.breakPending();
    const f = h.send('PermissionRequest', {
      ...COMMON,
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: 'D:/proj/alpha/a.txt', content: 'x' },
    });

    // ① 응답이 실제로 나갔다(예전에는 여기가 비어 있었다 = CLI 가 TUI 프롬프트에서 멈춤).
    assert.equal(f.state(), 'held');
    assert.ok(f.handle()?.settled, '보류가 닫혀 있어야 한다');
    assert.deepEqual(f.sent, [PASS_THROUGH]);

    // ② 멤버에게 error 이벤트가 남는다.
    const err = h.events.filter((e) => e.kind === 'error');
    assert.equal(err.length, 1);
    assert.equal(err[0]!.detail.summary, `hook handler failed: ${BROKEN}`);
    assert.equal(err[0]!.detail.hookEvent, 'PermissionRequest');
    assert.equal(err[0]!.memberId, h.member.id);

    // ③ handler-error → Office 가 daemon.notice{error} 로 올린다.
    assert.equal(h.handlerErrors.length, 1);
    assert.equal(h.handlerErrors[0]![1], h.member.id);
    assert.equal(h.handlerErrors[0]![2], 'PermissionRequest');

    // ④ 열린 pending 도, 사용자 답을 기다리는 보류도 남지 않는다.
    assert.deepEqual(h.store.listOpenPending(h.member.id), []);
    assert.deepEqual(h.adapter.heldPendingIds(h.member.id), []);
  });

  test('ask_user(AskUserQuestion) 경로도 같다', () => {
    h.breakPending();
    const f = h.send('PermissionRequest', {
      ...COMMON,
      hook_event_name: 'PermissionRequest',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: '색은?', options: [{ label: '빨강' }] }] },
    });
    assert.deepEqual(f.sent, [PASS_THROUGH]);
    assert.equal(h.events.filter((e) => e.kind === 'error').length, 1);
    assert.equal(h.handlerErrors.length, 1);
  });

  test('hold() 전에 던지면 respond 로 나간다(회귀: 예전 경로도 그대로)', () => {
    const f = fakeReq(h.member.memberToken, 'SessionStart', { ...COMMON, hook_event_name: 'SessionStart', source: 'startup' });
    // getInstructions 는 이미 try 로 감싸여 있으니, store.updateMember 를 깨서 respond 이후 경로를 확인한다.
    h.store.updateMember = () => {
      throw new Error('boom');
    };
    h.adapter.handleHook(f.req, h.store.getMember(h.member.id)!);
    assert.equal(f.state(), 'responded');
    assert.deepEqual(f.sent, [PASS_THROUGH]);
    assert.equal(h.handlerErrors.length, 1);
  });

  test('핸들러가 이미 응답했으면 이중 응답하지 않는다', () => {
    const f = fakeReq(h.member.memberToken, 'Stop', { ...COMMON, hook_event_name: 'Stop', last_assistant_message: '끝' });
    h.store.appendEvent = () => {
      throw new Error('appendEvent 실패');
    };
    h.adapter.handleHook(f.req, h.store.getMember(h.member.id)!);
    assert.deepEqual(f.sent, [PASS_THROUGH], '응답은 정확히 한 번');
    assert.equal(h.handlerErrors.length, 1);
    assert.equal(h.events.length, 0, 'store 가 죽었으니 이벤트는 못 남긴다 — 그래도 notice 는 나간다');
  });

});

describe('T30 HookReceiver 백스톱', () => {
  test("리스너가 hold() 뒤에 던지면 receiver 가 보류를 '{}' 로 닫는다", async () => {
    const receiver = new HookReceiver();
    const port = await receiver.listen(0);
    const errors: unknown[] = [];
    receiver.on('handler-error', (err) => errors.push(err));
    receiver.on('hook', (req) => {
      req.hold();
      throw new Error('listener boom');
    });
    const res = await fetch(`http://127.0.0.1:${port}/hook/tok1/PermissionRequest`, {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'PermissionRequest' }),
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{}');
    assert.equal(errors.length, 1);
    assert.deepEqual(receiver.pendingHolds(), [], '보류가 남지 않는다');
    await receiver.close();
  });
});
