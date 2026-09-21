// T43-1 — Office 배선: statusLine 경로 → UsageTracker → 스냅샷·알림, 턴 종료 꼬리 읽기, 멤버 삭제 정리.
// 가짜 pty + 가짜 HookReceiver 로 프로세스를 띄우지 않는다. 사용량 입력은 실측 픽스처 그대로.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Office } from '../../src/office/Office.js';
import { Store } from '../../src/store/Store.js';
import type { Member } from '../../src/store/types.js';
import { UsageTracker } from '../../src/usage/UsageTracker.js';
import type { EngineUsage, MemberUsage } from '../../src/usage/types.js';
import type { StatusLineRequest } from '../../src/hooks/HookReceiver.js';
import { FakeMcp, FakePty, FakeReceiver, fakeReq, makeTree } from './fakes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../fixtures/usage');
const read = (f: string): string => fs.readFileSync(path.join(fixtures, f), 'utf8');
const statusLine = (n: number): Record<string, unknown> =>
  JSON.parse(read('claude-statusline.jsonl').split(/\r?\n/).filter(Boolean)[n]!) as Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('사용량 배선 (T43, D-45)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let mcp: FakeMcp;
  let office: Office;
  let head: Member;
  let lead: Member;
  let engineNotes: EngineUsage[];
  let memberNotes: MemberUsage[];
  /** 꼬리 읽기 가짜: 경로 → 내용. */
  let tails: Map<string, string>;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-usage-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    mcp = new FakeMcp();
    tails = new Map();
    const usage = new UsageTracker({
      store,
      pollIntervalMs: 0,
      probeClaude: async () => ({ connected: true, plan: 'max', reason: null }),
      probeCodex: async () => ({ connected: false, plan: null, reason: 'not-installed' }),
      readTail: async (file) => tails.get(file) ?? '',
    });
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty, receiver, mcp, usage, version: 't43' });
    engineNotes = [];
    memberNotes = [];
    office.on('usage.engine', (u) => engineNotes.push(u));
    office.on('usage.member', (u) => memberNotes.push(u));
    await office.start();
    const t = makeTree(office, { name: 'alpha', cwd: dataDir, headName: '국장', leadName: '반장', engine: 'claude', leadEngine: 'codex' });
    head = t.head;
    lead = t.lead;
  });
  afterEach(async () => {
    await office.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** statusLine 왕복 한 번 — 응답 텍스트를 돌려준다. */
  function fireStatusLine(m: Member, payload: Record<string, unknown>): string {
    let text = '';
    const req: StatusLineRequest = {
      memberToken: m.memberToken,
      payload,
      respond: (t) => {
        text = t;
        return true;
      },
    };
    receiver.emit('status-line', req);
    return text;
  }

  test('statusLine → 스냅샷 usage + usage.engine/usage.member 알림 + 상태 줄 응답', () => {
    const text = fireStatusLine(head, statusLine(1));
    assert.equal(text, '컨텍스트 4% · 주간 46% 남음');

    const snap = office.snapshot();
    assert.deepEqual(snap.usage.engines.map((e) => e.engine), ['claude', 'codex']);
    const claude = snap.usage.engines.find((e) => e.engine === 'claude')!;
    assert.equal(claude.weekly?.usedPercent, 54);
    assert.equal(claude.session?.usedPercent, 17);
    assert.ok(claude.updatedAt, '마지막 확인 시각이 있다');

    assert.deepEqual(snap.usage.members.map((m) => m.memberId), [head.id]);
    assert.equal(snap.usage.members[0]!.context?.percent, 4);
    assert.equal(snap.usage.members[0]!.costUsd, 0.16072150000000002);

    assert.equal(engineNotes.length, 1);
    assert.equal(memberNotes.length, 1);
    assert.equal(engineNotes[0]!.engine, 'claude');
    assert.equal(memberNotes[0]!.memberId, head.id);
  });

  test('같은 값이 연달아 와도 알림은 한 번뿐이다', () => {
    fireStatusLine(head, statusLine(1));
    for (const n of [2, 3, 4, 5]) fireStatusLine(head, statusLine(n));
    assert.equal(engineNotes.length, 1);
    assert.equal(memberNotes.length, 1);
  });

  test('모르는 토큰의 statusLine 은 무시된다(응답 없음)', () => {
    const req: StatusLineRequest = { memberToken: 'ghost', payload: statusLine(1), respond: () => true };
    receiver.emit('status-line', req);
    assert.deepEqual(office.snapshot().usage.members, []);
  });

  test('Claude Stop → transcript 꼬리에서 누적 토큰·비용', async () => {
    const transcript = 'C:/x/claude.jsonl';
    tails.set(transcript, read('claude-transcript-tail.jsonl'));
    const r = fakeReq(head.memberToken, 'Stop', { session_id: 's1', hook_event_name: 'Stop', transcript_path: transcript, last_assistant_message: '끝' });
    receiver.emit('hook', r.req);
    await sleep(30);
    const m = office.snapshot().usage.members.find((u) => u.memberId === head.id)!;
    assert.equal(m.tokens?.total, 44837);
    assert.equal(m.costUsd, 0.16072150000000002);
  });

  test('Codex Stop → rollout 꼬리에서 엔진 주간 한도 + 멤버 컨텍스트', async () => {
    const rollout = 'C:/x/rollout.jsonl';
    tails.set(rollout, read('codex-rollout-tail.jsonl'));
    const r = fakeReq(lead.memberToken, 'Stop', { session_id: 's2', hook_event_name: 'Stop', transcript_path: rollout, last_assistant_message: '2' });
    receiver.emit('hook', r.req);
    await sleep(30);
    const snap = office.snapshot().usage;
    const codex = snap.engines.find((e) => e.engine === 'codex')!;
    assert.equal(codex.weekly?.usedPercent, 12);
    assert.equal(codex.plan, 'pro');
    const m = snap.members.find((u) => u.memberId === lead.id)!;
    assert.equal(m.context?.used, 21868);
    assert.equal(m.costUsd, null, 'Codex 는 비용이 없다');
  });

  test('경로는 hook 페이로드에서 기억한다 — Stop 에 transcript_path 가 없어도 마지막 경로로 읽는다', async () => {
    const rollout = 'C:/x/rollout2.jsonl';
    tails.set(rollout, read('codex-rollout-tail.jsonl'));
    // UserPromptSubmit 이 경로를 알려 주고, Stop 에는 경로가 빠져 있다.
    receiver.emit('hook', fakeReq(lead.memberToken, 'UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', transcript_path: rollout, prompt: '1+1' }).req);
    receiver.emit('hook', fakeReq(lead.memberToken, 'Stop', { hook_event_name: 'Stop', last_assistant_message: '2' }).req);
    await sleep(30);
    assert.equal(office.snapshot().usage.engines.find((e) => e.engine === 'codex')!.weekly?.usedPercent, 12);
  });

  test('파일을 못 읽으면 이전 값을 그대로 둔다', async () => {
    fireStatusLine(head, statusLine(1));
    const before = office.snapshot().usage.members[0]!;
    receiver.emit('hook', fakeReq(head.memberToken, 'Stop', { hook_event_name: 'Stop', transcript_path: 'C:/x/gone.jsonl' }).req);
    await sleep(30);
    const after = office.snapshot().usage.members[0]!;
    assert.deepEqual(after.context, before.context);
    assert.equal(after.tokens, null);
  });

  test('부서를 지우면 멤버 사용량도 사라지고 엔진 값은 남는다', async () => {
    fireStatusLine(head, statusLine(1));
    assert.equal(office.snapshot().usage.members.length, 1);
    await office.deleteDepartment(head.departmentId);
    const snap = office.snapshot().usage;
    assert.deepEqual(snap.members, []);
    assert.equal(snap.engines.find((e) => e.engine === 'claude')!.weekly?.usedPercent, 54, '엔진 값은 마지막 표시용으로 남는다');
    assert.deepEqual(store.listMemberUsage(), []);
  });

  test('연결 폴링 결과가 엔진 칩으로 나간다(이유 포함)', async () => {
    await office.usage.pollConnections();
    const snap = office.snapshot().usage;
    assert.equal(snap.engines.find((e) => e.engine === 'claude')!.connected, true);
    assert.equal(snap.engines.find((e) => e.engine === 'claude')!.plan, 'max');
    const codex = snap.engines.find((e) => e.engine === 'codex')!;
    assert.equal(codex.connected, false);
    assert.equal(codex.reason, 'not-installed');
    assert.equal(engineNotes.length, 2, '엔진 둘 다 한 번씩');
  });

  test('스냅샷 어디에도 이메일·계정 식별자가 없다 (D-45 ②)', () => {
    fireStatusLine(head, statusLine(1));
    const text = JSON.stringify(office.snapshot().usage);
    assert.ok(!text.includes('@'), text);
    assert.ok(!text.includes('email'), text);
    assert.ok(!text.includes('orgId'), text);
  });

  test('Claude 세션에만 statusLine 이 주입된다(Codex 는 없다)', () => {
    const claudeSpawn = pty.spawns.find((s) => s.memberId === head.id)!;
    const codexSpawn = pty.spawns.find((s) => s.memberId === lead.id)!;
    assert.ok(claudeSpawn.statusLineScriptPath?.endsWith('/src/hooks/statusline.js'), String(claudeSpawn.statusLineScriptPath));
    assert.ok(!claudeSpawn.statusLineScriptPath!.includes('\\'), '슬래시 경로여야 한다');
    assert.ok(fs.existsSync(claudeSpawn.statusLineScriptPath!.replace(/\//g, path.sep)), 'statusline.js 가 실제로 있다');
    assert.equal(codexSpawn.statusLineScriptPath, undefined, 'Codex 에는 statusLine 설정이 없다');
  });
});
