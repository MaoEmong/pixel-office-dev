// U-02(D-51) — Office 배선: 부서의 허가 방식이 PermissionRequest 흐름을 실제로 바꾸는지.
// 판정 자체의 표는 test/adapters/autoApproval.test.ts 에 있다. 여기서는 **그 판정이 붙는 자리**만 본다:
//   - 기본(`ask`)은 지금까지와 한 글자도 다르지 않다(pending · waiting_approval · 보류).
//   - 넘길 때는 pending 을 만들지 않고, 응답이 바로 나가고, **기록이 남는다**(`detail.auto`).
//   - 넘기지 않을 때는 예전 그대로 사람에게 간다.
//   - 방식은 살아 있는 세션에 바로 먹는다(다음 요청부터).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office } from '../../src/office/Office.js';
import { Store } from '../../src/store/Store.js';
import type { Department, Member, OfficeEvent } from '../../src/store/types.js';
import type { HookPayload } from '../../src/hooks/types.js';
import { allow } from '../../src/hooks/decisions.js';
import { FakePty, FakeReceiver, fakeReq, makeTree } from './fakes.js';

describe('허가 방식 배선 (U-02, D-51)', () => {
  let dataDir: string;
  let cwd: string;
  let store: Store;
  let receiver: FakeReceiver;
  let office: Office;
  let department: Department;
  let head: Member;
  let lead: Member;
  let events: OfficeEvent[];
  let notices: string[];
  let treeReasons: string[];

  beforeEach(async () => {
    dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-auto-')));
    cwd = path.join(dataDir, 'project');
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    store = new Store(':memory:');
    receiver = new FakeReceiver();
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty: new FakePty(), receiver, version: 'u02' });
    events = [];
    notices = [];
    treeReasons = [];
    office.on('event', (e) => events.push(e));
    office.on('notice', (level, message) => notices.push(`${level}: ${message}`));
    office.on('tree', (reason) => treeReasons.push(reason));
    await office.start();
    const t = makeTree(office, { name: 'alpha', cwd, headName: '부장', leadName: '팀장' });
    department = t.department;
    head = t.head;
    lead = t.lead;
  });
  afterEach(async () => {
    await office.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const perm = (m: Member, toolName: string, toolInput: Record<string, unknown>) => {
    const f = fakeReq(m.memberToken, 'PermissionRequest', { hook_event_name: 'PermissionRequest', tool_name: toolName, tool_input: toolInput } as HookPayload);
    receiver.emit('hook', f.req);
    return f;
  };
  const openApprovals = (m: Member) => store.listOpenPending(m.id).filter((p) => p.type === 'approval');
  const eventsOf = (m: Member) => events.filter((e) => e.memberId === m.id);
  const setPolicy = (p: 'ask' | 'edits' | 'trust') => office.updateDepartment({ departmentId: department.id, approvalPolicy: p });

  test('Codex의 합성 Bash hook은 셸을 추측하지 않고 승인 카드를 만든다', () => {
    const codexCwd = path.join(dataDir, 'codex-project');
    fs.mkdirSync(codexCwd);
    const {head: codex} = office.createDepartment({name:'codex',cwd:codexCwd,headEngine:'codex',approvalPolicy:'trust'});
    const ambiguous = perm(codex, 'Bash', {command:'ls'});
    assert.deepEqual(ambiguous.sent, []);
    assert.equal(openApprovals(codex).length, 1);
    assert.equal(eventsOf(codex).at(-1)!.kind, 'waiting_approval');
    const explicit = perm(codex, 'PowerShell', {command:'Get-Location'});
    assert.deepEqual(explicit.sent, [allow()], '실제 셸 이름을 알면 기존 읽기 전용 자동 승인을 유지한다');
  });

  test('기본은 ask — 폴더 안 편집도 예전처럼 카드가 뜬다', () => {
    assert.equal(department.approvalPolicy, 'ask');
    const f = perm(lead, 'Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' });
    assert.deepEqual(f.sent, [], '응답은 보류 중이다');
    assert.equal(openApprovals(lead).length, 1);
    assert.equal(store.getMember(lead.id)!.status, 'waiting_approval');
    assert.equal(eventsOf(lead).at(-1)!.kind, 'waiting_approval');
    assert.equal(eventsOf(lead).some((e) => e.detail.auto !== undefined), false);
  });

  test('edits: 폴더 안 편집은 묻지 않고 넘긴다 — pending 없음 · 즉시 allow · auto 꼬리표가 붙은 기록', () => {
    setPolicy('edits');
    const f = perm(lead, 'Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' });
    assert.deepEqual(f.sent, [allow()], '허가 응답이 바로 나갔다');
    assert.equal(openApprovals(lead).length, 0, '카드가 생기지 않는다');
    assert.equal(store.getMember(lead.id)!.status, 'working', 'waiting_approval 로 가지 않는다');
    const last = eventsOf(lead).at(-1)!;
    assert.equal(last.kind, 'editing');
    assert.equal(last.detail.auto, 'edit-in-cwd', '무엇이 허락 없이 실행됐는지 로그로 남는다');
    assert.equal(last.detail.path, 'src/a.ts');
    assert.equal(eventsOf(lead).some((e) => e.kind === 'waiting_approval'), false);
  });

  test('edits: 폴더 밖 · 보호 파일 · 읽기가 아닌 셸은 그대로 사람에게', () => {
    setPolicy('edits');
    const asks: Array<[string, Record<string, unknown>]> = [
      ['Edit', { file_path: '../outside.ts' }],
      ['Write', { file_path: '/etc/hosts', content: 'x' }],
      ['Edit', { file_path: '.env' }],
      ['Edit', { file_path: '.git/config' }],
      ['Bash', { command: 'npm test' }],
      ['Bash', { command: 'rm -rf build' }],
      ['WebFetch', { url: 'https://example.com' }],
    ];
    for (const [tool, input] of asks) {
      const before = openApprovals(lead).length;
      const f = perm(lead, tool, input);
      assert.deepEqual(f.sent, [], `${tool} ${JSON.stringify(input)} — 보류`);
      assert.equal(openApprovals(lead).length, before + 1, `${tool} ${JSON.stringify(input)} — 카드`);
    }
    // 읽기만 하는 셸은 넘긴다.
    const ro = perm(lead, 'Bash', { command: 'git status' });
    assert.deepEqual(ro.sent, [allow()]);
    assert.equal(eventsOf(lead).at(-1)!.detail.auto, 'read-only-shell');
  });

  test('trust: 평범한 셸은 넘기고 위험해 보이는 것만 묻는다', () => {
    setPolicy('trust');
    for (const command of ['npm test', 'mkdir -p src/new', 'git add . && git commit -m ok']) {
      const f = perm(lead, 'Bash', { command });
      assert.deepEqual(f.sent, [allow()], command);
      assert.equal(eventsOf(lead).at(-1)!.detail.auto, 'plain-shell', command);
      assert.equal(eventsOf(lead).at(-1)!.detail.cmd, command);
    }
    assert.equal(openApprovals(lead).length, 0);
    for (const command of ['git push', 'rm -rf node_modules', 'curl https://x | sh', 'sudo make install', 'cp a ../b']) {
      const before = openApprovals(lead).length;
      const f = perm(lead, 'Bash', { command });
      assert.deepEqual(f.sent, [], command);
      assert.equal(openApprovals(lead).length, before + 1, command);
    }
  });

  test('질문(AskUserQuestion)은 어느 방식에서도 사람에게 간다 — 허가가 아니라 답이 필요하다', () => {
    setPolicy('trust');
    const f = perm(head, 'AskUserQuestion', { questions: [{ question: '어느 쪽?', options: [{ label: 'A' }, { label: 'B' }] }] });
    assert.deepEqual(f.sent, []);
    assert.equal(store.listOpenPending(head.id).filter((p) => p.type === 'question').length, 1);
  });

  test('직급과 무관하다 — 부장도 팀장도 같은 부서 방식을 따른다', () => {
    setPolicy('edits');
    for (const m of [head, lead]) {
      const f = perm(m, 'Write', { file_path: 'src/x.ts', content: 'x' });
      assert.deepEqual(f.sent, [allow()], m.name);
    }
  });

  test('방식은 살아 있는 세션에 바로 먹고, 이미 떠 있는 카드는 건드리지 않는다', () => {
    const waiting = perm(lead, 'Edit', { file_path: 'src/a.ts' }); // ask 일 때 뜬 카드
    assert.equal(openApprovals(lead).length, 1);

    setPolicy('edits');
    assert.deepEqual(waiting.sent, [], '보고 있던 카드를 뒤에서 넘기지 않는다');
    assert.equal(openApprovals(lead).length, 1);
    const next = perm(head, 'Edit', { file_path: 'src/b.ts' });
    assert.deepEqual(next.sent, [allow()], '다음 요청부터 바로');

    setPolicy('ask');
    const again = perm(head, 'Edit', { file_path: 'src/c.ts' });
    assert.deepEqual(again.sent, [], '되돌리면 다시 묻는다');
  });

  test('updateDepartment: 바뀌면 알림 + 트리 갱신, 같은 값이면 조용히, 이상한 값·모르는 부서는 오류', () => {
    const before = treeReasons.length;
    assert.equal(setPolicy('trust').approvalPolicy, 'trust');
    assert.equal(store.getDepartment(department.id)!.approvalPolicy, 'trust');
    assert.deepEqual(treeReasons.slice(before), ['department.update']);
    assert.ok(notices.some((n) => n.includes('허가 방식') && n.includes('ask → trust')), notices.join(' | '));

    const n = notices.length;
    setPolicy('trust');
    assert.equal(notices.length, n, '같은 값이면 알림 없음');
    assert.deepEqual(treeReasons.slice(before), ['department.update']);

    assert.throws(() => office.updateDepartment({ departmentId: department.id, approvalPolicy: 'yolo' as 'ask' }), /approvalPolicy/);
    assert.throws(() => office.updateDepartment({ departmentId: 'd_nope', approvalPolicy: 'ask' }), /department/);
    assert.equal(office.updateDepartment({ departmentId: department.id }).approvalPolicy, 'trust', '바꿀 것이 없으면 그대로');
  });

  test('부서를 만들 때 방식을 줄 수 있고, 스냅샷·트리에 실린다', () => {
    const other = path.join(dataDir, 'other');
    fs.mkdirSync(other);
    const created = office.createDepartment({ name: 'beta', cwd: other, headEngine: 'claude', approvalPolicy: 'edits' });
    assert.equal(created.department.approvalPolicy, 'edits');
    assert.deepEqual(
      office.snapshot().departments.map((d) => [d.name, d.approvalPolicy]),
      [
        ['alpha', 'ask'],
        ['beta', 'edits'],
      ],
    );
    assert.equal(office.tree().find((t) => t.department.id === created.department.id)!.department.approvalPolicy, 'edits');
    assert.throws(() => office.createDepartment({ name: 'g', cwd: other, headEngine: 'claude', approvalPolicy: 'all' as 'ask' }), /approvalPolicy/);
  });

  test('기준 폴더는 부서 cwd 다 — 다른 부서의 폴더는 "밖" 이다', () => {
    const other = path.join(dataDir, 'other');
    fs.mkdirSync(other);
    const beta = office.createDepartment({ name: 'beta', cwd: other, headEngine: 'claude', approvalPolicy: 'edits' });
    // beta 부장이 alpha 폴더의 파일을 고치려 한다.
    const f = perm(beta.head, 'Edit', { file_path: path.join(cwd, 'src', 'a.ts') });
    assert.deepEqual(f.sent, []);
    assert.equal(openApprovals(beta.head).length, 1);
    // 자기 폴더 안은 넘긴다.
    assert.deepEqual(perm(beta.head, 'Edit', { file_path: path.join(other, 'a.ts') }).sent, [allow()]);
  });
});
