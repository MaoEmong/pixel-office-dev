// ClaudeHooksAdapter 테스트. 인메모리 Store + 가짜 HookRequest(respond/hold 기록). 페이로드는 dev/spike-0/hooklog-2.json /
// hooklog.json(resume) / run11.log(PostToolUseFailure keys) 실측을 그대로 옮겼다(경로만 짧게).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeHooksAdapter } from '../../src/adapters/ClaudeHooksAdapter.js';
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

// ---- 실측 페이로드 (hooklog-2.json) -------------------------------------------

const SID = '99d3da71-41ca-4bb0-934e-546dfd8ce145';
const COMMON = {
  session_id: SID,
  transcript_path: 'C:\\Users\\User\\.claude\\projects\\sandbox\\' + SID + '.jsonl',
  cwd: 'D:\\myproject\\pixel-office\\dev\\spike-0\\sandbox',
  scratchpad_dir: 'C:\\Users\\User\\AppData\\Local\\Temp\\claude\\sandbox\\' + SID + '\\scratchpad',
};
const P = {
  sessionStart: { ...COMMON, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5[1m]' },
  sessionStartClear: { ...COMMON, session_id: 'd5477a7c-8324-45e6-8dee-ffd7b4974cc0', hook_event_name: 'SessionStart', source: 'clear' },
  sessionStartResume: {
    ...COMMON,
    session_id: 'ac1c1601-3ee1-4612-bcc1-75c93178c2ed',
    hook_event_name: 'SessionStart',
    source: 'resume',
    seconds_since_last_response: 622,
    context_tokens: 48823,
    prompt_cache_likely_expired: false,
    estimated_cache_write_usd: 0.4882,
  },
  userPrompt: {
    ...COMMON,
    prompt_id: 'f7c32ace-13b7-4c67-9b07-cbd5429fc0c2',
    permission_mode: 'default',
    hook_event_name: 'UserPromptSubmit',
    prompt: '셸 명령 "echo hold > hold.txt"를 실행해줘. 다른 건 하지 마.',
  },
  askInput: {
    questions: [
      {
        question: '좋아하는 색은?',
        header: '색',
        options: [
          { label: '빨강', description: '빨간색' },
          { label: '파랑', description: '파란색' },
        ],
        multiSelect: false,
      },
    ],
  },
  bashInput: { command: 'echo hold > hold.txt', description: 'Write "hold" to hold.txt' },
  writeInput: { file_path: 'D:\\myproject\\pixel-office\\dev\\spike-0\\sandbox\\multi.txt', content: '첫째 줄\n둘째 줄\n셋째 줄\n' },
  notification: {
    ...COMMON,
    prompt_id: 'f7c32ace-13b7-4c67-9b07-cbd5429fc0c2',
    hook_event_name: 'Notification',
    message: 'Claude needs your permission',
    notification_type: 'permission_prompt',
  },
  stop: {
    ...COMMON,
    prompt_id: 'f7c32ace-13b7-4c67-9b07-cbd5429fc0c2',
    permission_mode: 'default',
    effort: { level: 'high' },
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: '[테스트 팀원 startup]\n`echo hold > hold.txt`를 실행했고, 출력 없이 끝났어요.',
    background_tasks: [],
    session_crons: [],
  },
  sessionEndClear: { ...COMMON, prompt_id: 'a41c125c', hook_event_name: 'SessionEnd', reason: 'clear' },
  sessionEndExit: { ...COMMON, prompt_id: '09978f16', hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' },
} as const;

function pre(tool: string, input: unknown, toolUseId = 'toolu_01Um7bhKTNNQEtLg8ysRiCBP'): HookPayload {
  return {
    ...COMMON,
    prompt_id: 'f7c32ace-13b7-4c67-9b07-cbd5429fc0c2',
    permission_mode: 'default',
    effort: { level: 'high' },
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: input as Record<string, unknown>,
    tool_use_id: toolUseId,
  };
}
function perm(tool: string, input: unknown, suggestions?: unknown): HookPayload {
  const p: HookPayload = {
    ...COMMON,
    prompt_id: 'f7c32ace-13b7-4c67-9b07-cbd5429fc0c2',
    permission_mode: 'default',
    effort: { level: 'high' },
    hook_event_name: 'PermissionRequest',
    tool_name: tool,
    tool_input: input as Record<string, unknown>,
  };
  if (suggestions !== undefined) p.permission_suggestions = suggestions;
  return p;
}
function post(tool: string, input: unknown, response: unknown, toolUseId = 'toolu_01Um7bhKTNNQEtLg8ysRiCBP'): HookPayload {
  return {
    ...COMMON,
    prompt_id: 'f7c32ace-13b7-4c67-9b07-cbd5429fc0c2',
    permission_mode: 'default',
    effort: { level: 'high' },
    hook_event_name: 'PostToolUse',
    tool_name: tool,
    tool_input: input as Record<string, unknown>,
    tool_response: response,
    tool_use_id: toolUseId,
    duration_ms: 1772,
  };
}
/** run11.log 의 PostToolUseFailure keys: ...tool_name,tool_input,tool_use_id,error,is_interrupt,duration_ms */
function postFailure(tool: string, input: unknown, error: string, toolUseId = 'toolu_fail'): HookPayload {
  return {
    ...COMMON,
    prompt_id: 'p',
    permission_mode: 'default',
    effort: { level: 'high' },
    hook_event_name: 'PostToolUseFailure',
    tool_name: tool,
    tool_input: input as Record<string, unknown>,
    tool_use_id: toolUseId,
    error,
    is_interrupt: false,
    duration_ms: 12,
  };
}

const BASH_SUGGESTIONS = [
  { type: 'addDirectories', directories: ['D:\\myproject\\pixel-office\\dev\\spike-0\\sandbox'], destination: 'session' },
];

// ---- 하네스 ---------------------------------------------------------------------

interface Harness {
  store: Store;
  adapter: ClaudeHooksAdapter;
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

function harness(opts: { toolGate?: (memberId: string, tool: string, input: unknown) => Promise<void> } = {}): Harness {
  const store = new Store(':memory:');
  const team = store.createTeam({ name: 'alpha', cwd: 'D:/proj/alpha' });
  const member = store.createMember({
    teamId: team.id,
    name: '이음',
    rank: 'member',
    engine: 'claude',
    cwd: team.cwd,
    hiredBy: 'user',
    memberToken: 'tok1',
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
    instructions: '[테스트 팀원 startup]',
    adapter: undefined as unknown as ClaudeHooksAdapter,
    send: undefined as unknown as Harness['send'],
    member$: () => store.getMember(member.id)!,
  };
  let t = Date.parse('2026-09-14T00:00:00.000Z');
  const deps: ConstructorParameters<typeof ClaudeHooksAdapter>[0] = {
    store,
    getInstructions: () => h.instructions,
    now: () => (t += 1000),
  };
  if (opts.toolGate) deps.toolGate = opts.toolGate;
  h.adapter = new ClaudeHooksAdapter(deps);
  h.adapter.on('event', (e) => h.events.push(e));
  h.adapter.on('status', (_id, s) => h.statuses.push(s));
  h.adapter.on('sessionId', (id, sid, src) => h.sessionIds.push([id, sid, src]));
  h.adapter.on('pendingCreated', (p) => h.created.push(p));
  h.adapter.on('pendingSettled', (p) => h.settled.push(p));
  h.adapter.on('toolDone', (id, info) => h.toolDone.push([id, info]));
  h.send = (event, payload) => {
    const f = fakeReq('tok1', event, payload);
    h.adapter.handleHook(f.req, h.member$());
    return f;
  };
  return h;
}

const kinds = (h: Harness) => h.events.map((e) => e.kind);

describe('ClaudeHooksAdapter', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => {
    h.store.close();
  });

  test('SessionStart(startup): stores session_id, emits sessionId, responds additionalContext, status idle, no event', () => {
    const f = h.send('SessionStart', P.sessionStart);
    assert.deepEqual(f.sent, [sessionStartContext('[테스트 팀원 startup]')]);
    assert.equal(f.state(), 'responded');
    assert.equal(h.member$().sessionId, SID);
    assert.deepEqual(h.sessionIds, [[h.member.id, SID, 'startup']]);
    assert.equal(h.member$().status, 'idle');
    assert.deepEqual(h.statuses, ['idle']);
    assert.equal(h.events.length, 0);
  });

  test('SessionStart with empty instructions → {} ; clear/resume update session_id again; resume appends text{resumed}', () => {
    h.instructions = '';
    h.send('SessionStart', P.sessionStart);
    const clear = h.send('SessionStart', P.sessionStartClear);
    assert.deepEqual(clear.sent, [{}]);
    assert.equal(h.member$().sessionId, 'd5477a7c-8324-45e6-8dee-ffd7b4974cc0');
    assert.equal(h.events.length, 0);

    h.instructions = undefined;
    const resume = h.send('SessionStart', P.sessionStartResume);
    assert.deepEqual(resume.sent, [{}]);
    assert.equal(h.member$().sessionId, 'ac1c1601-3ee1-4612-bcc1-75c93178c2ed');
    assert.deepEqual(
      h.sessionIds.map(([, sid, src]) => [sid, src]),
      [
        [SID, 'startup'],
        ['d5477a7c-8324-45e6-8dee-ffd7b4974cc0', 'clear'],
        ['ac1c1601-3ee1-4612-bcc1-75c93178c2ed', 'resume'],
      ],
    );
    assert.deepEqual(kinds(h), ['text']);
    assert.deepEqual(h.events[0]!.detail, { summary: 'resumed' });
    assert.equal(h.events[0]!.ts, '2026-09-14T00:00:01.000Z'); // now() 주입 확인
  });

  test('UserPromptSubmit → status working + thinking{text: prompt[:200]}', () => {
    h.send('SessionStart', P.sessionStart);
    const longPrompt = 'ㄱ'.repeat(300);
    const f = h.send('UserPromptSubmit', { ...P.userPrompt, prompt: longPrompt });
    assert.deepEqual(f.sent, [{}]);
    assert.equal(h.member$().status, 'working');
    assert.deepEqual(kinds(h), ['thinking']);
    const text = h.events[0]!.detail.text as string;
    assert.equal(text.length, 200);
    assert.equal(h.events[0]!.teamId, h.member.teamId);
    assert.equal(h.events[0]!.memberId, h.member.id);
  });

  test('PreToolUse mapping: Bash → running{cmd,summary}, Write → editing{path}, Read → reading, mcp → running, AskUserQuestion → none', () => {
    h.send('SessionStart', P.sessionStart);
    h.send('UserPromptSubmit', P.userPrompt);
    const f1 = h.send('PreToolUse', pre('Bash', P.bashInput));
    assert.deepEqual(f1.sent, [{}]);
    h.send('PreToolUse', pre('Write', P.writeInput));
    h.send('PreToolUse', pre('Read', { file_path: 'D:\\x\\y.md' }));
    h.send('PreToolUse', pre('Grep', { pattern: 'foo', path: 'src' }));
    h.send('PreToolUse', pre('mcp__team__report', { taskId: 1, summary: 'done' }));
    h.send('PreToolUse', pre('SomethingNew', { a: 1 }));
    const ask = h.send('PreToolUse', pre('AskUserQuestion', P.askInput, 'toolu_013nmtuc9nBx6Wr5pdVoeT3w'));
    assert.deepEqual(ask.sent, [{}]);

    assert.deepEqual(kinds(h), ['thinking', 'running', 'editing', 'reading', 'reading', 'running', 'running']);
    assert.deepEqual(h.events[1]!.detail, { tool: 'Bash', cmd: 'echo hold > hold.txt', summary: 'Write "hold" to hold.txt' });
    assert.deepEqual(h.events[2]!.detail, { tool: 'Write', path: P.writeInput.file_path });
    assert.deepEqual(h.events[3]!.detail, { tool: 'Read', path: 'D:\\x\\y.md' });
    assert.deepEqual(h.events[4]!.detail, { tool: 'Grep', path: 'foo' });
    assert.deepEqual(h.events[5]!.detail, { tool: 'mcp__team__report' });
    assert.deepEqual(h.events[6]!.detail, { tool: 'SomethingNew' });
    assert.deepEqual(h.events[1]!.ref, {});
    assert.equal(h.member$().status, 'working');
  });

  test('PermissionRequest(Bash) → pending(approval) + waiting_approval event + hold; resolveApproval(allow) sends exact allow JSON', () => {
    h.send('SessionStart', P.sessionStart);
    h.send('UserPromptSubmit', P.userPrompt);
    h.send('PreToolUse', pre('Bash', P.bashInput));
    const f = h.send('PermissionRequest', perm('Bash', P.bashInput, BASH_SUGGESTIONS));
    assert.equal(f.state(), 'held');
    assert.deepEqual(f.sent, []);
    assert.equal(h.created.length, 1);
    const pending = h.created[0]!;
    assert.equal(pending.type, 'approval');
    assert.ok(pending.id.startsWith('a_'));
    assert.deepEqual(pending.payload, {
      tool_name: 'Bash',
      tool_input: P.bashInput,
      permission_suggestions: BASH_SUGGESTIONS,
    });
    assert.equal(h.store.getPending(pending.id)!.status, 'open');
    assert.deepEqual(h.adapter.heldPendingIds(h.member.id), [pending.id]);

    const ev = h.events.at(-1)!;
    assert.equal(ev.kind, 'waiting_approval');
    assert.deepEqual(ev.detail, { tool: 'Bash', cmd: 'echo hold > hold.txt', summary: 'Write "hold" to hold.txt' });
    assert.deepEqual(ev.ref, { approvalId: pending.id });
    assert.equal(h.member$().status, 'waiting_approval');

    // Notification(permission_prompt) 은 무시, 상태 유지
    const n = h.send('Notification', P.notification);
    assert.deepEqual(n.sent, [{}]);
    assert.equal(h.member$().status, 'waiting_approval');

    assert.equal(h.adapter.resolveApproval(pending.id, { behavior: 'allow' }), true);
    assert.deepEqual(f.sent, [allow()]);
    assert.deepEqual(f.sent[0], { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    assert.equal(f.handle()!.settled, true);
    const after = h.store.getPending(pending.id)!;
    assert.equal(after.status, 'answered');
    assert.deepEqual(after.answer, { behavior: 'allow' });
    assert.equal(h.settled.length, 1);
    assert.equal(h.settled[0]!.id, pending.id);
    assert.equal(h.settled[0]!.status, 'answered');
    assert.equal(h.member$().status, 'working');
    assert.deepEqual(h.adapter.heldPendingIds(), []);

    // 두 번째 답은 무효
    assert.equal(h.adapter.resolveApproval(pending.id, { behavior: 'deny' }), false);
    assert.equal(h.adapter.resolveApproval('a_nope', { behavior: 'allow' }), false);
  });

  test('resolveApproval(allow, updatedInput) / (deny, message) build the exact decision JSON', () => {
    h.send('SessionStart', P.sessionStart);
    const f1 = h.send('PermissionRequest', perm('Write', P.writeInput, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]));
    const p1 = h.created[0]!;
    const updated = { ...P.writeInput, content: 'changed' };
    assert.equal(h.adapter.resolveApproval(p1.id, { behavior: 'allow', updatedInput: updated }), true);
    assert.deepEqual(f1.sent, [allow(updated)]);

    const f2 = h.send('PermissionRequest', perm('Bash', P.bashInput, BASH_SUGGESTIONS));
    const p2 = h.created[1]!;
    assert.equal(h.adapter.resolveApproval(p2.id, { behavior: 'deny', message: 'not now' }), true);
    assert.deepEqual(f2.sent, [deny('not now')]);
    assert.deepEqual(f2.sent[0], {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'not now' } },
    });

    const f3 = h.send('PermissionRequest', perm('Bash', P.bashInput));
    const p3 = h.created[2]!;
    assert.equal(p3.payload.permission_suggestions, null);
    assert.equal(h.adapter.resolveApproval(p3.id, { behavior: 'deny' }), true);
    assert.equal((f3.sent[0] as ReturnType<typeof deny>).hookSpecificOutput.decision.message, 'Denied by user');
  });

  test('PermissionRequest(AskUserQuestion) → pending(question) + asking + waiting_answer; resolveQuestion sends updatedInput.answers', () => {
    h.send('SessionStart', P.sessionStart);
    h.send('UserPromptSubmit', { ...P.userPrompt, prompt: '좋아하는 색을 물어봐' });
    h.send('PreToolUse', pre('AskUserQuestion', P.askInput, 'toolu_013nmtuc9nBx6Wr5pdVoeT3w'));
    const f = h.send('PermissionRequest', perm('AskUserQuestion', P.askInput));
    assert.equal(f.state(), 'held');
    const pending = h.created[0]!;
    assert.equal(pending.type, 'question');
    assert.ok(pending.id.startsWith('q_'));
    assert.deepEqual(pending.payload, { questions: P.askInput.questions, tool_input: P.askInput });

    assert.deepEqual(kinds(h), ['thinking', 'asking']);
    const ev = h.events[1]!;
    assert.deepEqual(ev.detail, { tool: 'AskUserQuestion', summary: '좋아하는 색은?' });
    assert.deepEqual(ev.ref, { questionId: pending.id });
    assert.equal(h.member$().status, 'waiting_answer');

    // approval 용 API 로는 못 닫는다
    assert.equal(h.adapter.resolveApproval(pending.id, { behavior: 'allow' }), false);
    assert.equal(f.sent.length, 0);

    assert.equal(h.adapter.resolveQuestion(pending.id, { '좋아하는 색은?': '파랑' }), true);
    assert.deepEqual(f.sent, [
      {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow', updatedInput: { ...P.askInput, answers: { '좋아하는 색은?': '파랑' } } },
        },
      },
    ]);
    const after = h.store.getPending(pending.id)!;
    assert.equal(after.status, 'answered');
    assert.deepEqual(after.answer, { '좋아하는 색은?': '파랑' });
    assert.equal(h.member$().status, 'working');
    assert.equal(h.settled.length, 1);

    // PostToolUse(AskUserQuestion) 이 뒤따라온다 → toolDone, 이벤트 없음
    h.send('PostToolUse', post('AskUserQuestion', P.askInput, { answers: {} }, 'toolu_013nmtuc9nBx6Wr5pdVoeT3w'));
    assert.deepEqual(h.toolDone, [[h.member.id, { tool: 'AskUserQuestion', ok: true, toolUseId: 'toolu_013nmtuc9nBx6Wr5pdVoeT3w' }]]);
    assert.deepEqual(kinds(h), ['thinking', 'asking']);
  });

  test('PostToolUse / PostToolUseFailure → toolDone only (no office event), status working', () => {
    h.send('SessionStart', P.sessionStart);
    h.send('UserPromptSubmit', P.userPrompt);
    h.send('PreToolUse', pre('Bash', P.bashInput));
    const ok = h.send('PostToolUse', post('Bash', P.bashInput, { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }));
    assert.deepEqual(ok.sent, [{}]);
    const fail = h.send('PostToolUseFailure', postFailure('Bash', { command: 'cat nofile.txt', description: 'Print contents of nofile.txt' }, 'cat: nofile.txt: No such file or directory'));
    assert.deepEqual(fail.sent, [{}]);
    assert.deepEqual(h.toolDone, [
      [h.member.id, { tool: 'Bash', ok: true, toolUseId: 'toolu_01Um7bhKTNNQEtLg8ysRiCBP' }],
      [h.member.id, { tool: 'Bash', ok: false, toolUseId: 'toolu_fail', error: 'cat: nofile.txt: No such file or directory' }],
    ]);
    assert.deepEqual(kinds(h), ['thinking', 'running']);
    assert.equal(h.member$().status, 'working');
  });

  test('Stop → text{last_assistant_message[:4000]} + idle event, status idle, responds {} (never blocks)', () => {
    h.send('SessionStart', P.sessionStart);
    h.send('UserPromptSubmit', P.userPrompt);
    const f = h.send('Stop', P.stop);
    assert.deepEqual(f.sent, [{}]);
    assert.equal(f.state(), 'responded');
    assert.deepEqual(kinds(h), ['thinking', 'text', 'idle']);
    assert.deepEqual(h.events[1]!.detail, { text: P.stop.last_assistant_message });
    assert.deepEqual(h.events[2]!.detail, {});
    assert.equal(h.member$().status, 'idle');
    assert.deepEqual(h.statuses, ['idle', 'working', 'idle']);

    // 4000자 초과 잘림
    h.send('UserPromptSubmit', P.userPrompt);
    h.send('Stop', { ...P.stop, last_assistant_message: 'a'.repeat(5000) });
    assert.equal((h.events.at(-2)!.detail.text as string).length, 4000);

    // 메시지 없는 Stop 은 idle 만
    h.send('UserPromptSubmit', P.userPrompt);
    const before = h.events.length;
    h.send('Stop', { ...P.stop, last_assistant_message: undefined });
    assert.deepEqual(kinds(h).slice(before), ['idle']);
  });

  test('SubagentStop / PreCompact / Notification / Interrupt → {} and nothing else', () => {
    h.send('SessionStart', P.sessionStart);
    const before = { events: h.events.length, statuses: h.statuses.length };
    for (const ev of ['SubagentStop', 'PreCompact', 'Notification', 'Interrupt'] as HookEvent[]) {
      const f = h.send(ev, { ...COMMON, hook_event_name: ev });
      assert.deepEqual(f.sent, [{}], ev);
    }
    assert.equal(h.events.length, before.events);
    assert.equal(h.statuses.length, before.statuses);
  });

  test('SessionEnd(clear) → nothing; SessionEnd(prompt_input_exit) → idle{session ended} + status exited', () => {
    h.send('SessionStart', P.sessionStart);
    const c = h.send('SessionEnd', P.sessionEndClear);
    assert.deepEqual(c.sent, [{}]);
    assert.equal(h.events.length, 0);
    assert.equal(h.member$().status, 'idle');
    h.send('SessionStart', P.sessionStartClear);

    const e = h.send('SessionEnd', P.sessionEndExit);
    assert.deepEqual(e.sent, [{}]);
    assert.deepEqual(kinds(h), ['idle']);
    assert.deepEqual(h.events[0]!.detail, { summary: 'session ended: prompt_input_exit' });
    assert.equal(h.member$().status, 'exited');
  });

  test('onSessionExit: code 0 after SessionEnd → no duplicate; code 1 → status error + error event; open pending expired', () => {
    h.send('SessionStart', P.sessionStart);
    h.send('SessionEnd', P.sessionEndExit);
    h.adapter.onSessionExit(h.member.id, 0);
    assert.deepEqual(kinds(h), ['idle']);
    assert.equal(h.member$().status, 'exited');

    // 비정상 종료: 보류 중 pending 이 있으면 expired + '{}' 로 닫힘
    h.send('SessionStart', P.sessionStart);
    const f = h.send('PermissionRequest', perm('Bash', P.bashInput, BASH_SUGGESTIONS));
    const pending = h.created.at(-1)!;
    h.adapter.onSessionExit(h.member.id, 1);
    assert.deepEqual(f.sent, [{}]);
    assert.equal(h.store.getPending(pending.id)!.status, 'expired');
    assert.equal(h.settled.at(-1)!.status, 'expired');
    assert.equal(h.events.at(-1)!.kind, 'error');
    assert.deepEqual(h.events.at(-1)!.detail, { summary: 'process exited (code 1)', exitCode: 1 });
    assert.equal(h.member$().status, 'error');
    assert.equal(h.adapter.resolveApproval(pending.id, { behavior: 'allow' }), false);

    // 모르는 멤버는 무시
    h.adapter.onSessionExit('m_nope', 1);
  });

  test('expireAllForMember settles held handles with {} and marks pending expired; waiting_* → working', () => {
    h.send('SessionStart', P.sessionStart);
    h.send('UserPromptSubmit', P.userPrompt);
    const f = h.send('PermissionRequest', perm('AskUserQuestion', P.askInput));
    const pending = h.created[0]!;
    assert.equal(h.member$().status, 'waiting_answer');

    h.adapter.expireAllForMember(h.member.id);
    assert.deepEqual(f.sent, [{}]);
    assert.equal(f.handle()!.settled, true);
    assert.equal(h.store.getPending(pending.id)!.status, 'expired');
    assert.deepEqual(h.store.listOpenPending(h.member.id), []);
    assert.equal(h.settled.length, 1);
    assert.equal(h.settled[0]!.status, 'expired');
    assert.equal(h.member$().status, 'working');
    assert.deepEqual(h.adapter.heldPendingIds(), []);
    assert.equal(h.adapter.resolveQuestion(pending.id, { x: 'y' }), false);

    // 다른 멤버의 보류는 건드리지 않는다
    const other = h.store.createMember({ teamId: h.member.teamId, name: '둘', rank: 'member', engine: 'claude', cwd: 'x', hiredBy: 'user', memberToken: 'tok2' });
    const fo = fakeReq('tok2', 'PermissionRequest', perm('Bash', P.bashInput));
    h.adapter.handleHook(fo.req, other);
    h.adapter.expireAllForMember(h.member.id);
    assert.equal(fo.state(), 'held');
    assert.deepEqual(fo.sent, []);
    assert.deepEqual(h.adapter.heldPendingIds(other.id).length, 1);
  });

  test('onHoldTimeout (receiver already sent {}) → pending expired, error event, status working', () => {
    h.send('SessionStart', P.sessionStart);
    const f = h.send('PermissionRequest', perm('Bash', P.bashInput, BASH_SUGGESTIONS));
    const pending = h.created[0]!;
    // receiver 가 상한 초과로 '{}' 를 보낸 상황을 흉내
    f.handle()!.cancel();
    h.adapter.onHoldTimeout('tok1', 'PermissionRequest');
    assert.equal(h.store.getPending(pending.id)!.status, 'expired');
    assert.equal(h.settled[0]!.status, 'expired');
    const ev = h.events.at(-1)!;
    assert.equal(ev.kind, 'error');
    assert.equal(ev.detail.pendingId, pending.id);
    assert.equal(h.member$().status, 'working');
    assert.equal(h.adapter.resolveApproval(pending.id, { behavior: 'allow' }), false);

    // settled 되지 않은 보류는 timeout 알림이 와도 건드리지 않는다(다른 요청의 timeout)
    const f2 = h.send('PermissionRequest', perm('Bash', P.bashInput));
    h.adapter.onHoldTimeout('tok1', 'PermissionRequest');
    assert.equal(f2.state(), 'held');
    assert.equal(h.store.getPending(h.created[1]!.id)!.status, 'open');
  });

  test('resolveApproval on a handle the receiver already closed → false and pending expired', () => {
    h.send('SessionStart', P.sessionStart);
    const f = h.send('PermissionRequest', perm('Bash', P.bashInput));
    const pending = h.created[0]!;
    f.handle()!.cancel(); // hold-closed 등, 아직 onHoldClosed 가 불리기 전
    assert.equal(h.adapter.resolveApproval(pending.id, { behavior: 'allow' }), false);
    assert.equal(h.store.getPending(pending.id)!.status, 'expired');
    assert.equal(h.settled[0]!.status, 'expired');
  });

  test('handler exceptions are swallowed: {} is sent and handler-error emitted', () => {
    const errors: unknown[] = [];
    h.adapter.on('handler-error', (err, memberId, event) => errors.push([String(err), memberId, event]));
    const origError = console.error;
    console.error = () => {};
    try {
      // getInstructions 가 throw 해도 SessionStart 는 '{}' 로 응답하고 session_id 는 저장된다
      h.instructions = undefined;
      const adapterThrow = new ClaudeHooksAdapter({
        store: h.store,
        getInstructions: () => {
          throw new Error('boom');
        },
      });
      const f = fakeReq('tok1', 'SessionStart', P.sessionStart);
      adapterThrow.handleHook(f.req, h.member$());
      assert.deepEqual(f.sent, [{}]);
      assert.equal(h.member$().sessionId, SID);

      // store 가 닫힌 뒤 들어온 hook: throw 를 삼키고 {} + handler-error
      const m = h.member$();
      h.store.close();
      const f2 = fakeReq('tok1', 'UserPromptSubmit', P.userPrompt);
      h.adapter.handleHook(f2.req, m);
      assert.deepEqual(f2.sent, [{}]);
      assert.equal(errors.length, 1);
      assert.deepEqual((errors[0] as unknown[]).slice(1), [h.member.id, 'UserPromptSubmit']);
    } finally {
      console.error = origError;
      h.store = new Store(':memory:'); // afterEach close 용
    }
  });
});

describe('ClaudeHooksAdapter + toolGate', () => {
  test('PreToolUse is held until the gate promise settles, then {} (resolve and reject alike)', async () => {
    let release!: () => void;
    const gateCalls: Array<[string, string, unknown]> = [];
    const h = harness({
      toolGate: (m, t, i) => {
        gateCalls.push([m, t, i]);
        return new Promise<void>((r) => (release = r));
      },
    });
    try {
      h.send('SessionStart', P.sessionStart);
      h.send('UserPromptSubmit', P.userPrompt);
      const f = h.send('PreToolUse', pre('Bash', P.bashInput));
      assert.equal(f.state(), 'held');
      assert.deepEqual(f.sent, []);
      assert.deepEqual(gateCalls, [[h.member.id, 'Bash', P.bashInput]]);
      // 이벤트·status 는 보류와 무관하게 즉시
      assert.deepEqual(kinds(h), ['thinking', 'running']);
      assert.equal(h.member$().status, 'working');

      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(f.sent, []);
      release();
      await new Promise((r) => setTimeout(r, 0));
      assert.deepEqual(f.sent, [{}]);
      assert.equal(f.handle()!.settled, true);

      // AskUserQuestion 은 게이트를 타지 않는다
      const ask = h.send('PreToolUse', pre('AskUserQuestion', P.askInput));
      assert.deepEqual(ask.sent, [{}]);
      assert.equal(gateCalls.length, 1);
    } finally {
      h.store.close();
    }

    // reject 도 '{}' (deny 하지 않는다, D-11)
    const origError = console.error;
    console.error = () => {};
    const h2 = harness({ toolGate: () => Promise.reject(new Error('gate broke')) });
    try {
      h2.send('SessionStart', P.sessionStart);
      const f = h2.send('PreToolUse', pre('Read', { file_path: 'x' }));
      assert.equal(f.state(), 'held');
      await new Promise((r) => setTimeout(r, 0));
      assert.deepEqual(f.sent, [{}]);
    } finally {
      console.error = origError;
      h2.store.close();
    }
  });

  test('expireAllForMember cancels gate holds with {} too', async () => {
    const h = harness({ toolGate: () => new Promise<void>(() => {}) }); // 영원히 안 풀리는 게이트
    try {
      h.send('SessionStart', P.sessionStart);
      const f = h.send('PreToolUse', pre('Bash', P.bashInput));
      assert.equal(f.state(), 'held');
      h.adapter.expireAllForMember(h.member.id);
      assert.deepEqual(f.sent, [{}]);
      assert.equal(f.handle()!.settled, true);
    } finally {
      h.store.close();
    }
  });
});
