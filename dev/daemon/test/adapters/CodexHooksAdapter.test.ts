// CodexHooksAdapter 테스트(T20). 인메모리 Store + 가짜 HookRequest(respond/hold 기록).
// 페이로드는 실측 그대로: dev/spike-0/hooklog-codex.json(SessionStart resume / UserPromptSubmit / Stop / SessionEnd)
// + dev/spike-0/run-codex6.log(PreToolUse / PermissionRequest / PostToolUse 의 키와 값) + run-codex5.log(startup SessionStart).
// Interrupt 페이로드는 스파이크에서 발화하지 않아(02 §④ "남은 것") 공통 필드 + turn_id 로 구성했다 — 어댑터는 payload 를 보지 않는다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CodexHooksAdapter } from '../../src/adapters/CodexHooksAdapter.js';
import type { ToolDoneInfo } from '../../src/adapters/types.js';
import { Store } from '../../src/store/Store.js';
import type { Member, MemberStatus, OfficeEvent, Pending } from '../../src/store/types.js';
import type { DecisionHandle, HookRequest } from '../../src/hooks/HookReceiver.js';
import type { HookEvent, HookPayload } from '../../src/hooks/types.js';
import { allow, deny, sessionStartContext } from '../../src/hooks/decisions.js';

// ---- 가짜 HookRequest ----------------------------------------------------------

interface FakeReq {
  req: HookRequest;
  /** respond()/resolve()/cancel() 로 나간 JSON(순서대로). */
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

// ---- 실측 페이로드 (hooklog-codex.json / run-codex6.log) -------------------------

const SID = '01a09f50-13fe-70a0-90b4-2b2a7cdbcb7a';
const TURN = '01a09f51-0568-7f42-a8b6-083730724090';
const COMMON = {
  session_id: SID,
  transcript_path: 'C:\\Users\\User\\.codex\\sessions\\2026\\09\\14\\rollout-2026-09-14T18-47-00-' + SID + '.jsonl',
  cwd: 'D:\\myproject\\pixel-office\\dev\\spike-0\\sandbox',
  model: 'gpt-6-astra',
  permission_mode: 'default',
};
const OUTSIDE_CMD = 'echo hi > ../outside.txt';
const APPROVAL_DESC = '상위 폴더에 outside.txt를 만들도록 이 명령 실행을 승인하시겠어요?';

const P = {
  sessionStart: { ...COMMON, hook_event_name: 'SessionStart', source: 'startup' },
  sessionStartResume: { ...COMMON, hook_event_name: 'SessionStart', source: 'resume' },
  userPrompt: {
    ...COMMON,
    turn_id: TURN,
    hook_event_name: 'UserPromptSubmit',
    prompt: '셸 명령 "echo hi > ../outside.txt"를 실행해서 상위 폴더에 파일을 만들어줘. 다른 건 하지 마.',
  },
  stop: {
    ...COMMON,
    turn_id: TURN,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: '[코덱스 팀원] 아까 만든 파일 이름은 `outside.txt`입니다.',
  },
  sessionEnd: { ...COMMON, hook_event_name: 'SessionEnd', reason: 'other' },
  interrupt: { ...COMMON, turn_id: TURN, hook_event_name: 'Interrupt' },
} as const;

/** run-codex6.log: PreToolUse 키 = …,tool_name,tool_input,tool_use_id */
function pre(command: string, toolUseId = 'call_8YkP3n'): HookPayload {
  return { ...COMMON, turn_id: TURN, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: toolUseId };
}
/** run-codex6.log: PermissionRequest 는 tool_use_id 가 없고 tool_input 에 한국어 description 이 붙는다. */
function perm(command: string, description = APPROVAL_DESC): HookPayload {
  return { ...COMMON, turn_id: TURN, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command, description } };
}
function post(command: string, response: unknown, toolUseId = 'call_8YkP3n'): HookPayload {
  return {
    ...COMMON,
    turn_id: TURN,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: response,
    tool_use_id: toolUseId,
  };
}

// ---- 하네스 ---------------------------------------------------------------------

interface Harness {
  store: Store;
  adapter: CodexHooksAdapter;
  member: Member;
  events: OfficeEvent[];
  statuses: MemberStatus[];
  sessionIds: Array<[string, string, string]>;
  created: Pending[];
  settled: Pending[];
  toolDone: Array<[string, ToolDoneInfo]>;
  instructions: string | undefined;
  send: (event: HookEvent, payload: HookPayload) => FakeReq;
  member$: () => Member;
}

function harness(): Harness {
  const store = new Store(':memory:');
  const team = store.createTeam({ name: 'alpha', cwd: 'D:/proj/alpha' });
  const member = store.createMember({
    teamId: team.id,
    name: '코덱스',
    rank: 'member',
    engine: 'codex',
    cwd: team.cwd,
    hiredBy: 'user',
    memberToken: 'tok-codex',
  });
  const h: Harness = {
    store,
    member,
    events: [],
    statuses: [],
    sessionIds: [],
    created: [],
    settled: [],
    toolDone: [],
    instructions: '[코덱스 팀원] 답변 첫 줄에 반드시 "[코덱스 팀원]"을 붙여라.',
    adapter: undefined as unknown as CodexHooksAdapter,
    send: undefined as unknown as Harness['send'],
    member$: () => store.getMember(member.id)!,
  };
  let t = Date.parse('2026-09-14T00:00:00.000Z');
  h.adapter = new CodexHooksAdapter({ store, getInstructions: () => h.instructions, now: () => (t += 1000) });
  h.adapter.on('event', (e) => h.events.push(e));
  h.adapter.on('status', (_id, s) => h.statuses.push(s));
  h.adapter.on('sessionId', (id, sid, src) => h.sessionIds.push([id, sid, src]));
  h.adapter.on('pendingCreated', (p) => h.created.push(p));
  h.adapter.on('pendingSettled', (p) => h.settled.push(p));
  h.adapter.on('toolDone', (id, info) => h.toolDone.push([id, info]));
  h.send = (event, payload) => {
    const f = fakeReq('tok-codex', event, payload);
    h.adapter.handleHook(f.req, h.member$());
    return f;
  };
  return h;
}

const kinds = (h: Harness) => h.events.map((e) => e.kind);
const last = (h: Harness) => h.events[h.events.length - 1]!;

describe('CodexHooksAdapter', () => {
  describe('SessionStart', () => {
    test('지시문을 additionalContext 로 주입하고 session_id 를 기록, status idle', () => {
      const h = harness();
      const f = h.send('SessionStart', P.sessionStart);
      assert.deepEqual(f.sent, [sessionStartContext(h.instructions!)]);
      assert.equal(h.member$().sessionId, SID);
      assert.deepEqual(h.sessionIds, [[h.member.id, SID, 'startup']]);
      assert.equal(h.member$().status, 'idle');
      assert.deepEqual(kinds(h), []);
    });

    test('지시문이 없으면 pass-through', () => {
      const h = harness();
      h.instructions = undefined;
      const f = h.send('SessionStart', P.sessionStart);
      assert.deepEqual(f.sent, [{}]);
    });

    test('resume(codex resume <id>)도 지시문 재주입 + text{summary:resumed}', () => {
      const h = harness();
      const f = h.send('SessionStart', P.sessionStartResume);
      assert.deepEqual(f.sent, [sessionStartContext(h.instructions!)]);
      assert.deepEqual(h.sessionIds, [[h.member.id, SID, 'resume']]);
      assert.deepEqual(kinds(h), ['text']);
      assert.equal(last(h).detail.summary, 'resumed');
    });
  });

  test('UserPromptSubmit → working + thinking{text}', () => {
    const h = harness();
    const f = h.send('UserPromptSubmit', P.userPrompt);
    assert.deepEqual(f.sent, [{}]);
    assert.deepEqual(kinds(h), ['thinking']);
    assert.equal(last(h).detail.text, P.userPrompt.prompt);
    assert.equal(h.member$().status, 'working');
  });

  describe('PreToolUse (tool_name="Bash", 명령 휴리스틱)', () => {
    test('쓰기 명령 → running{cmd}', () => {
      const h = harness();
      const f = h.send('PreToolUse', pre(OUTSIDE_CMD));
      assert.deepEqual(f.sent, [{}]);
      assert.deepEqual(kinds(h), ['running']);
      assert.deepEqual(last(h).detail, { tool: 'Bash', cmd: OUTSIDE_CMD });
      assert.equal(h.member$().status, 'working');
    });

    test('읽기 전용 명령 → reading{cmd}', () => {
      const h = harness();
      h.send('PreToolUse', pre('cat outside.txt'));
      h.send('PreToolUse', pre('git status --short'));
      h.send('PreToolUse', pre("rg -n 'apply_patch' src | head -20"));
      assert.deepEqual(kinds(h), ['reading', 'reading', 'reading']);
      assert.deepEqual(h.events[0]!.detail, { tool: 'Bash', cmd: 'cat outside.txt' });
    });

    test('apply_patch → editing{cmd,path}', () => {
      const h = harness();
      const cmd = "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch\nPATCH";
      h.send('PreToolUse', pre(cmd));
      assert.deepEqual(kinds(h), ['editing']);
      assert.equal(last(h).detail.path, 'src/a.ts');
      assert.equal(last(h).detail.tool, 'Bash');
    });

    test('셸이 아닌 도구(mcp__team__*)는 running{tool}', () => {
      const h = harness();
      h.send('PreToolUse', { ...COMMON, hook_event_name: 'PreToolUse', tool_name: 'mcp__team__ask_user', tool_input: { question: '색?' } });
      assert.deepEqual(kinds(h), ['running']);
      assert.deepEqual(last(h).detail, { tool: 'mcp__team__ask_user' });
    });
  });

  describe('PermissionRequest', () => {
    test('보류 + pending(approval) + waiting_approval{cmd,summary} + status waiting_approval', () => {
      const h = harness();
      const f = h.send('PermissionRequest', perm(OUTSIDE_CMD));
      assert.equal(f.state(), 'held');
      assert.deepEqual(f.sent, []);
      assert.equal(h.created.length, 1);
      const pending = h.created[0]!;
      assert.equal(pending.type, 'approval');
      assert.deepEqual(pending.payload, {
        tool_name: 'Bash',
        tool_input: { command: OUTSIDE_CMD, description: APPROVAL_DESC },
        permission_suggestions: null,
      });
      assert.deepEqual(kinds(h), ['waiting_approval']);
      assert.deepEqual(last(h).detail, { tool: 'Bash', cmd: OUTSIDE_CMD, summary: APPROVAL_DESC });
      assert.equal(last(h).ref.approvalId, pending.id);
      assert.equal(h.member$().status, 'waiting_approval');
      assert.deepEqual(h.adapter.heldPendingIds(h.member.id), [pending.id]);
    });

    test('allow 결정 JSON 은 Claude 와 같다(스파이크에서 먹힌 모양) + pending answered + working', () => {
      const h = harness();
      const f = h.send('PermissionRequest', perm(OUTSIDE_CMD));
      const pending = h.created[0]!;
      assert.equal(h.adapter.resolveApproval(pending.id, { behavior: 'allow' }), true);
      assert.deepEqual(f.sent, [allow()]);
      assert.deepEqual(f.sent, [{ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }]);
      assert.equal(h.settled.at(-1)!.status, 'answered');
      assert.equal(h.member$().status, 'working');
      assert.deepEqual(h.adapter.heldPendingIds(), []);
    });

    test('deny 는 사유를 싣고, 같은 pending 에 두 번 답할 수 없다', () => {
      const h = harness();
      const f = h.send('PermissionRequest', perm(OUTSIDE_CMD));
      const pending = h.created[0]!;
      assert.equal(h.adapter.resolveApproval(pending.id, { behavior: 'deny', message: '작업 폴더 밖이라 안 돼' }), true);
      assert.deepEqual(f.sent, [deny('작업 폴더 밖이라 안 돼')]);
      assert.equal(h.adapter.resolveApproval(pending.id, { behavior: 'allow' }), false);
    });

    test('updatedInput 으로 명령을 바꿔 허가할 수 있다', () => {
      const h = harness();
      const f = h.send('PermissionRequest', perm(OUTSIDE_CMD));
      const updated = { command: 'echo hi > inside.txt' };
      assert.equal(h.adapter.resolveApproval(h.created[0]!.id, { behavior: 'allow', updatedInput: updated }), true);
      assert.deepEqual(f.sent, [allow(updated)]);
    });

    test('mcp__team__* 는 사용자에게 올리지 않고 즉시 allow (D-22)', () => {
      const h = harness();
      const f = h.send('PermissionRequest', {
        ...COMMON,
        hook_event_name: 'PermissionRequest',
        tool_name: 'mcp__team__ask_user',
        tool_input: { question: '색?' },
      });
      assert.deepEqual(f.sent, [allow()]);
      assert.equal(h.created.length, 0);
      assert.deepEqual(kinds(h), []);
    });

    test('Codex 에는 AskUserQuestion 이 없다 — 그 이름이 와도 그냥 approval 로 다룬다', () => {
      const h = harness();
      h.send('PermissionRequest', {
        ...COMMON,
        hook_event_name: 'PermissionRequest',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: '좋아하는 색은?' }] },
      });
      assert.equal(h.created[0]!.type, 'approval');
      assert.deepEqual(kinds(h), ['waiting_approval']);
      assert.equal(h.member$().status, 'waiting_approval');
      assert.equal(h.adapter.resolveQuestion(h.created[0]!.id, { '좋아하는 색은?': '파랑' }), false);
    });
  });

  test('PostToolUse → toolDone(내부)만, 오피스 이벤트 없음', () => {
    const h = harness();
    const f = h.send('PostToolUse', post(OUTSIDE_CMD, { output: '', exit_code: 0 }));
    assert.deepEqual(f.sent, [{}]);
    assert.deepEqual(kinds(h), []);
    assert.deepEqual(h.toolDone, [[h.member.id, { tool: 'Bash', ok: true, toolUseId: 'call_8YkP3n' }]]);
    assert.equal(h.member$().status, 'working');
  });

  test('Stop → text{last_assistant_message} + idle, status idle', () => {
    const h = harness();
    h.send('UserPromptSubmit', P.userPrompt);
    const f = h.send('Stop', P.stop);
    assert.deepEqual(f.sent, [{}]);
    assert.deepEqual(kinds(h), ['thinking', 'text', 'idle']);
    assert.equal(h.events[1]!.detail.text, P.stop.last_assistant_message);
    assert.deepEqual(h.events[2]!.detail, {});
    assert.equal(h.member$().status, 'idle');
  });

  describe('Interrupt (Codex 전용 hook, 3초 클램프)', () => {
    test('즉시 pass-through 응답 + idle{summary:interrupted} + status idle', () => {
      const h = harness();
      h.send('UserPromptSubmit', P.userPrompt);
      const f = h.send('Interrupt', P.interrupt);
      assert.deepEqual(f.sent, [{}], '3초 클램프 — 붙잡지 않고 바로 답한다');
      assert.deepEqual(kinds(h), ['thinking', 'idle']);
      assert.equal(last(h).detail.summary, 'interrupted');
      assert.equal(h.member$().status, 'idle');
    });

    test('보류 중이던 허가는 만료되고 그 hook 은 {} 로 닫힌다', () => {
      const h = harness();
      const permReq = h.send('PermissionRequest', perm(OUTSIDE_CMD));
      const pending = h.created[0]!;
      h.send('Interrupt', P.interrupt);
      assert.deepEqual(permReq.sent, [{}]);
      assert.equal(h.store.getPending(pending.id)!.status, 'expired');
      assert.deepEqual(h.adapter.heldPendingIds(), []);
      assert.equal(last(h).kind, 'idle');
      assert.equal(h.member$().status, 'idle');
    });
  });

  describe('SessionEnd', () => {
    test("reason 'other'(실측) → idle{summary} + exited", () => {
      const h = harness();
      const f = h.send('SessionEnd', P.sessionEnd);
      assert.deepEqual(f.sent, [{}]);
      assert.deepEqual(kinds(h), ['idle']);
      assert.equal(last(h).detail.summary, 'session ended: other');
      assert.equal(h.member$().status, 'exited');
    });

    test("clear/resume 은 종료가 아니다(새 SessionStart 가 따라온다)", () => {
      const h = harness();
      h.send('SessionEnd', { ...P.sessionEnd, reason: 'resume' });
      h.send('SessionEnd', { ...P.sessionEnd, reason: 'clear' });
      assert.deepEqual(kinds(h), []);
      assert.notEqual(h.member$().status, 'exited');
    });
  });

  test('Notification 등 모르는 이벤트는 pass-through', () => {
    const h = harness();
    const f = h.send('Notification', { ...COMMON, hook_event_name: 'Notification', message: 'x' });
    assert.deepEqual(f.sent, [{}]);
    assert.deepEqual(kinds(h), []);
  });

  test('pty 종료: 0 이 아니면 error 이벤트 + status error, 열린 pending 만료', () => {
    const h = harness();
    h.send('PermissionRequest', perm(OUTSIDE_CMD));
    const pending = h.created[0]!;
    h.adapter.onSessionExit(h.member.id, 1);
    assert.equal(h.store.getPending(pending.id)!.status, 'expired');
    assert.equal(last(h).kind, 'error');
    assert.equal(last(h).detail.summary, 'process exited (code 1)');
    assert.equal(h.member$().status, 'error');
  });

  test('전체 흐름(실측 run-codex6): SessionStart→UserPromptSubmit→PreToolUse→PermissionRequest→allow→PostToolUse→Stop→SessionEnd', () => {
    const h = harness();
    h.send('SessionStart', P.sessionStart);
    h.send('UserPromptSubmit', P.userPrompt);
    h.send('PreToolUse', pre(OUTSIDE_CMD));
    const permReq = h.send('PermissionRequest', perm(OUTSIDE_CMD));
    assert.equal(h.member$().status, 'waiting_approval');
    assert.equal(h.adapter.resolveApproval(h.created[0]!.id, { behavior: 'allow' }), true);
    assert.deepEqual(permReq.sent, [allow()]);
    h.send('PostToolUse', post(OUTSIDE_CMD, { output: '' }));
    h.send('Stop', P.stop);
    h.send('SessionEnd', P.sessionEnd);
    assert.deepEqual(kinds(h), ['thinking', 'running', 'waiting_approval', 'text', 'idle', 'idle']);
    assert.deepEqual(h.statuses, ['idle', 'working', 'waiting_approval', 'working', 'idle', 'exited']);
  });
});
