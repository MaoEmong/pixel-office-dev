// T27 팀 단위 셸 뮤텍스. 두 층으로 본다:
//   1. 순수 ShellMutex — FIFO, 비어 있으면 즉시, releaseAllFor, 보유 상한 강제 해제, signal 로 줄에서 빠지기
//   2. Office 배선 — 같은 팀 두 멤버의 PreToolUse hook 응답이 실제로 보류되는지(= CLI 가 기다리는지),
//      읽기 명령은 안 기다리는지, PostToolUse/PostToolUseFailure/interrupt 가 푸는지, 다른 팀은 안 막는지
// 설계: 01 §구성 요소 1 "팀 단위 셸 뮤텍스"(해제 표), D-11(보류 타임아웃은 pass-through), D-27(읽기 전용 예외).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office } from '../../src/office/Office.js';
import { ShellMutex, shellLockCommand, isShellTool, DEFAULT_MAX_HOLD_MS } from '../../src/office/ShellMutex.js';
import { Store } from '../../src/store/Store.js';
import type { Member, OfficeEvent, Team } from '../../src/store/types.js';
import type { HookEvent, HookPayload } from '../../src/hooks/types.js';
import { FakePty, FakeReceiver, fakeReq, makeTree } from './fakes.js';

/** 마이크로태스크가 다 돌게 한다(게이트 프라미스 → hook 응답). */
const tick = () => new Promise<void>((r) => setImmediate(r));

// ---- 1. 순수 ShellMutex -----------------------------------------------------------------

describe('ShellMutex (순수)', () => {
  test('비어 있으면 즉시 잡고, 두 번째부터 FIFO 로 줄을 선다', async () => {
    const m = new ShellMutex();
    const order: string[] = [];

    const a = m.acquire('t1', 'a', 'u1', 'flutter test').then(() => order.push('a'));
    assert.equal(m.holder('t1')?.memberId, 'a');
    assert.equal(m.queueLength('t1'), 0);
    await a;
    assert.deepEqual(order, ['a'], '비어 있으면 await 한 틱에 풀린다');

    const b = m.acquire('t1', 'b', 'u2', 'echo x > y').then(() => order.push('b'));
    const c = m.acquire('t1', 'c', 'u3', 'npm run build').then(() => order.push('c'));
    assert.equal(m.queueLength('t1'), 2);
    assert.deepEqual(
      m.waiters('t1').map((w) => w.memberId),
      ['b', 'c'],
      '들어온 순서대로',
    );
    await tick();
    assert.deepEqual(order, ['a'], '락이 안 풀리면 아무도 못 지나간다');

    assert.equal(m.release('t1', 'a', 'u1'), true);
    await b;
    assert.equal(m.holder('t1')?.memberId, 'b', '다음 대기자가 곧바로 쥔다');
    assert.equal(m.queueLength('t1'), 1);

    m.release('t1', 'b', 'u2');
    await c;
    assert.deepEqual(order, ['a', 'b', 'c']);
    m.release('t1', 'c');
    assert.equal(m.holder('t1'), undefined);
    assert.equal(m.size, 0, '빈 팀 상태는 정리된다');
  });

  test('팀이 다르면 서로 막지 않는다', async () => {
    const m = new ShellMutex();
    await m.acquire('t1', 'a', null, 'flutter test');
    let granted = false;
    await m.acquire('t2', 'b', null, 'flutter test').then(() => (granted = true));
    assert.equal(granted, true);
    assert.equal(m.holder('t1')?.memberId, 'a');
    assert.equal(m.holder('t2')?.memberId, 'b');
  });

  test('release 는 주인·toolUseId 가 맞아야 푼다', async () => {
    const m = new ShellMutex();
    await m.acquire('t1', 'a', 'u1', 'x');
    assert.equal(m.release('t1', 'b', 'u1'), false, '남의 락은 못 푼다');
    assert.equal(m.release('t1', 'a', 'u9'), false, '다른 도구 호출의 PostToolUse 는 무시');
    assert.equal(m.release('t9', 'a', 'u1'), false, '모르는 팀');
    assert.equal(m.release('t1', 'a', 'u1'), true);
    assert.equal(m.release('t1', 'a', 'u1'), false, '두 번은 안 풀린다');
  });

  test('releaseAllFor: 그 멤버의 락과 대기 자리를 모두 정리하고 다음 사람에게 넘긴다', async () => {
    const m = new ShellMutex();
    const done: string[] = [];
    await m.acquire('t1', 'a', 'u1', 'flutter test');
    const b = m.acquire('t1', 'b', 'u2', 'build').then(() => done.push('b'));
    const a2 = m.acquire('t1', 'a', 'u3', 'again').then(() => done.push('a2'));
    assert.equal(m.queueLength('t1'), 2);

    assert.equal(m.releaseAllFor('a'), 2, '락 1 + 대기 1');
    await Promise.all([b, a2]);
    assert.deepEqual(done.sort(), ['a2', 'b']);
    assert.equal(m.holder('t1')?.memberId, 'b', '나가는 멤버의 대기 자리는 락을 넘겨받지 않는다');
    assert.equal(m.queueLength('t1'), 0);
  });

  test('보유 상한을 넘기면 warn + 강제 해제, 다음 대기자가 이어받는다', async () => {
    const m = new ShellMutex({ maxHoldMs: 20 });
    assert.equal(new ShellMutex().maxHoldMs, DEFAULT_MAX_HOLD_MS, '기본 30분');
    const warns: string[] = [];
    const released: string[] = [];
    m.on('warn', (info, message) => warns.push(`${info.memberId}:${message}`));
    m.on('released', (info, reason) => released.push(`${info.memberId}:${reason}`));

    await m.acquire('t1', 'a', 'u1', 'flutter test');
    let bGranted = false;
    // 상한 타이머가 a 를 풀어 줄 때만 이 프라미스가 resolve 된다(아무도 release 를 안 부른다).
    await m.acquire('t1', 'b', 'u2', 'build').then(() => (bGranted = true));

    assert.equal(bGranted, true, '강제 해제 후 대기자가 이어받는다');
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /^a:셸 락을 \d+초째 쥐고 있어 강제로 해제함$/);
    assert.deepEqual(released, ['a:max-hold']);
    assert.equal(m.holder('t1')?.memberId, 'b');
    m.clear();
  });

  test('signal 이 abort 되면 대기 자리를 버리고(resolve) 락은 넘겨받지 않는다', async () => {
    const m = new ShellMutex();
    await m.acquire('t1', 'a', 'u1', 'flutter test');
    const ac = new AbortController();
    let passed = false;
    const b = m.acquire('t1', 'b', 'u2', 'build', { signal: ac.signal }).then(() => (passed = true));
    assert.equal(m.queueLength('t1'), 1);

    ac.abort(); // hook 보류가 먼저 끊김(D-11 pass-through)
    await b;
    assert.equal(passed, true, '게이트는 reject 하지 않는다');
    assert.equal(m.queueLength('t1'), 0);
    assert.equal(m.holder('t1')?.memberId, 'a', '락은 그대로 a 가 쥔다');

    // 이미 abort 된 signal 로 들어오면 줄을 아예 안 선다.
    let immediate = false;
    await m.acquire('t1', 'c', 'u3', 'build', { signal: ac.signal }).then(() => (immediate = true));
    assert.equal(immediate, true);
    assert.equal(m.queueLength('t1'), 0);
  });

  test('waiting / granted 이벤트가 대기자당 한 번씩 난다', async () => {
    const m = new ShellMutex();
    const log: string[] = [];
    m.on('waiting', (info, holder) => log.push(`waiting ${info.memberId}<-${holder.memberId}`));
    m.on('granted', (info) => log.push(`granted ${info.memberId}`));
    await m.acquire('t1', 'a', 'u1', 'x');
    const b = m.acquire('t1', 'b', 'u2', 'y');
    m.release('t1', 'a', 'u1');
    await b;
    assert.deepEqual(log, ['granted a', 'waiting b<-a', 'granted b']);
  });

  describe('락 대상 판정 (D-27)', () => {
    test('셸 도구만, 읽기 전용 명령은 제외', () => {
      assert.equal(isShellTool('Bash'), true);
      assert.equal(isShellTool('PowerShell'), true);
      assert.equal(isShellTool('shell'), true, 'Codex 쪽 이름');
      assert.equal(isShellTool('Read'), false);

      assert.equal(shellLockCommand('Bash', { command: 'flutter test' }), 'flutter test');
      assert.equal(shellLockCommand('PowerShell', { command: 'npm run build' }), 'npm run build');
      assert.equal(shellLockCommand('Bash', { command: 'echo hi > a.txt' }), 'echo hi > a.txt', '쓰기 리다이렉트');
      assert.equal(shellLockCommand('Bash', { command: 'cat notes.txt' }), null, '읽기 전용은 직렬화하지 않는다');
      assert.equal(shellLockCommand('Bash', { command: 'git status' }), null);
      assert.equal(shellLockCommand('Read', { file_path: 'a.ts' }), null, '셸이 아니다');
      assert.equal(shellLockCommand('mcp__team__ask_user', { question: 'q' }), null);
      assert.equal(shellLockCommand('Bash', {}), '', '명령을 모르면 잡는다(보수적)');
    });
  });
});

// ---- 2. Office 배선 ---------------------------------------------------------------------

describe('Office 배선: 팀 셸 뮤텍스 (T27)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let office: Office;
  let team: Team;
  let other: Team;
  // T34: 셸 락 범위는 팀이 아니라 **부서**다(D-32 — 한 부서의 팀들은 같은 cwd 를 쓴다).
  let deptId: string;
  let otherDeptId: string;
  let events: OfficeEvent[];
  let notices: string[];
  let 하루: Member;
  let 이음: Member;
  let 남: Member; // 다른 팀

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t27-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty, receiver, version: '1.0.0' });
    events = [];
    notices = [];
    office.on('event', (e) => events.push(e));
    office.on('notice', (level, message) => notices.push(`${level}: ${message}`));
    await office.start();
    // T34: 부서를 만들면 부장이, 팀을 만들면 팀장이 자동 출근한다 — 그 팀장을 그대로 첫 멤버로 쓴다.
    // 락이 부서 단위이므로 "서로 막지 않는" 짝은 다른 **부서**로 만든다.
    const demo = makeTree(office, { name: 'demo', cwd: dataDir, headName: '데모부장', leadName: '하루', allowedEngines: ['claude', 'codex'] });
    const others = makeTree(office, { name: 'other', cwd: dataDir, headName: '남부장', leadName: '남', allowedEngines: ['claude', 'codex'] });
    team = demo.team;
    other = others.team;
    deptId = demo.department.id;
    otherDeptId = others.department.id;
    하루 = demo.lead;
    남 = others.lead;
    이음 = office.clockIn({ parentId: 하루.id, engine: 'claude', name: '이음' });
  });

  afterEach(async () => {
    await office.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const send = (member: Member, ev: HookEvent, payload: HookPayload) => {
    const f = fakeReq(member.memberToken, ev, payload);
    receiver.emit('hook', f.req);
    return f;
  };
  const pre = (command: string, toolUseId: string) =>
    ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: toolUseId }) as HookPayload;
  const post = (toolUseId: string) =>
    ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: toolUseId, tool_response: 'ok' }) as HookPayload;
  const postFail = (toolUseId: string) =>
    ({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: toolUseId, error: 'exit 1' }) as HookPayload;
  const waitEventsOf = (m: Member) => events.filter((e) => e.memberId === m.id && e.detail.waiting === 'shell-lock');

  test('같은 팀의 두 번째 셸 명령은 앞 명령의 PostToolUse 까지 응답이 보류된다', async () => {
    const a = send(하루, 'PreToolUse', pre('flutter test', 'u1'));
    await tick();
    assert.deepEqual(a.sent, [{}], '앞 명령은 바로 지나간다(pass-through)');
    assert.equal(office.shell.holder(deptId)?.memberId, 하루.id);

    const b = send(이음, 'PreToolUse', pre('echo x > y.txt', 'u2'));
    await tick();
    assert.deepEqual(b.sent, [], '두 번째 셸의 hook 응답은 아직 안 나갔다 — CLI 가 기다린다');
    assert.equal(office.shell.queueLength(deptId), 1);
    assert.equal(store.getMember(이음.id)!.status, 'working', '대기 중에도 status 는 working');

    // 대기 이벤트는 그 도구의 running 이벤트 **뒤에** 한 번(말풍선이 "대기 중" 으로 끝나야 한다).
    const mine = events.filter((e) => e.memberId === 이음.id);
    assert.deepEqual(
      mine.map((e) => e.kind),
      ['running', 'running'],
    );
    assert.equal(mine[0]!.detail.cmd, 'echo x > y.txt');
    assert.equal(mine[1]!.detail.waiting, 'shell-lock');
    assert.equal(mine[1]!.detail.summary, '셸 대기 중 (락: 하루)');
    assert.equal(mine[1]!.detail.holder, 하루.id);

    // 앞 명령이 끝나면 곧바로 풀린다.
    send(하루, 'PostToolUse', post('u1'));
    await tick();
    assert.deepEqual(b.sent, [{}], 'PostToolUse 가 두 번째를 풀어 준다');
    assert.equal(office.shell.holder(deptId)?.memberId, 이음.id);
    assert.equal(waitEventsOf(이음).length, 1, '대기 이벤트는 한 번만');
  });

  test('읽기 전용 명령은 락을 안 기다린다 (D-27)', async () => {
    send(하루, 'PreToolUse', pre('flutter test', 'u1'));
    await tick();

    const r = send(이음, 'PreToolUse', pre('cat notes.txt', 'u2'));
    await tick();
    assert.deepEqual(r.sent, [{}], 'cat 은 즉시 통과');
    assert.equal(office.shell.queueLength(deptId), 0);
    assert.equal(waitEventsOf(이음).length, 0);
    assert.equal(office.shell.holder(deptId)?.memberId, 하루.id, '락 주인은 그대로');
  });

  test('PostToolUseFailure 도 락을 푼다 (실측 02 §②: 실패 시 PostToolUse 는 안 온다)', async () => {
    send(하루, 'PreToolUse', pre('flutter test', 'u1'));
    await tick();
    const b = send(이음, 'PreToolUse', pre('npm run build', 'u2'));
    await tick();
    assert.deepEqual(b.sent, []);

    send(하루, 'PostToolUseFailure', postFail('u1'));
    await tick();
    assert.deepEqual(b.sent, [{}]);
    assert.equal(office.shell.holder(deptId)?.memberId, 이음.id);
  });

  test('앞 멤버를 interrupt 하면 락이 풀려 다음 사람이 들어간다', async () => {
    send(하루, 'PreToolUse', pre('flutter test', 'u1'));
    await tick();
    const b = send(이음, 'PreToolUse', pre('npm run build', 'u2'));
    await tick();
    assert.deepEqual(b.sent, []);

    office.interrupt(하루.id);
    await tick();
    assert.deepEqual(b.sent, [{}], 'interrupt 후처리(01 §공통 후처리)가 락을 돌려준다');
    assert.equal(office.shell.holder(deptId)?.memberId, 이음.id);
  });

  test('턴 종료(Stop)·퇴근도 안전망으로 락을 푼다', async () => {
    send(하루, 'PreToolUse', pre('flutter test', 'u1'));
    await tick();
    // PostToolUse 가 유실된 채 턴이 끝난 경우.
    send(하루, 'Stop', { hook_event_name: 'Stop', last_assistant_message: '끝' } as HookPayload);
    await tick();
    assert.equal(office.shell.holder(deptId), undefined, 'Stop 이 락을 회수한다');

    send(이음, 'PreToolUse', pre('npm run build', 'u2'));
    await tick();
    assert.equal(office.shell.holder(deptId)?.memberId, 이음.id);
    await office.clockOut(이음.id);
    assert.equal(office.shell.holder(deptId), undefined, '퇴근도 회수한다');
  });

  test('다른 부서는 서로 막지 않는다 (T34: 락 범위가 부서)', async () => {
    send(하루, 'PreToolUse', pre('flutter test', 'u1'));
    await tick();
    const n = send(남, 'PreToolUse', pre('flutter test', 'u9'));
    await tick();
    assert.deepEqual(n.sent, [{}], '다른 부서 멤버는 즉시 통과');
    assert.equal(office.shell.holder(otherDeptId)?.memberId, 남.id);
    assert.equal(waitEventsOf(남).length, 0);
  });

  test('보류가 먼저 끊기면(hold-closed, D-11) 대기 줄에서 빠진다', async () => {
    send(하루, 'PreToolUse', pre('flutter test', 'u1'));
    await tick();
    const b = send(이음, 'PreToolUse', pre('npm run build', 'u2'));
    await tick();
    assert.equal(office.shell.queueLength(deptId), 1);

    // hook 프로세스가 끊김 → receiver 가 이미 '{}' 를 보냈다고 치고 보류를 닫는다.
    b.handle()!.cancel();
    receiver.emit('hold-closed', { memberToken: 이음.memberToken, event: 'PreToolUse', since: Date.now() });
    await tick();
    assert.equal(office.shell.queueLength(deptId), 0, '아무도 안 기다리는 자리는 남기지 않는다');

    // 그 뒤 하루가 끝나도 락은 이음에게 안 넘어간다(그 명령은 이미 pass-through 로 실행됐다).
    send(하루, 'PostToolUse', post('u1'));
    await tick();
    assert.equal(office.shell.holder(deptId), undefined);
  });
});
