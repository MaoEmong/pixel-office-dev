// T20: Office 가 hook 을 멤버의 engine 으로 라우팅하는지 — 가짜 pty + 가짜 HookReceiver.
//   같은 사무실에 Claude 멤버와 Codex 멤버를 하나씩 두고 **같은 hook 페이로드**를 보내 결과가 갈리는지 본다.
//   (Claude 어댑터는 tool_name 이름표로, Codex 어댑터는 명령 문자열 휴리스틱으로 매핑한다.)
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office } from '../../src/office/Office.js';
import { Store } from '../../src/store/Store.js';
import type { Member, OfficeEvent, Team } from '../../src/store/types.js';
import { FakePty, FakeReceiver, fakeReq, seedDeptTeam } from './fakes.js';
import { allow } from '../../src/hooks/decisions.js';
import { reapOrphan, type OrphanOps } from '../../src/office/orphans.js';

const CAT = 'cat notes.txt';
const bash = (event: string, command: string, extra: Record<string, unknown> = {}) => ({
  session_id: 'sess-1',
  hook_event_name: event,
  cwd: 'D:\\x',
  tool_name: 'Bash',
  tool_input: { command },
  ...extra,
});

describe('Office: 엔진별 hook 라우팅 (T20)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let office: Office;
  let team: Team;
  let events: OfficeEvent[];
  let claude: Member;
  let codex: Member;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t20-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty, receiver, version: '1.0.0' });
    events = [];
    office.on('event', (e) => events.push(e));
    await office.start();
    // 팀장 없는 팀(store 직접) — 엔진 라우팅만 보므로 team.create 의 팀장 자동 출근(T24)은 끼우지 않는다.
    team = seedDeptTeam(store, { name: 'mix', cwd: dataDir, allowedEngines: ['claude', 'codex'] }).team;
    claude = office.clockIn({ teamId: team.id, engine: 'claude', name: '이음' });
    codex = office.clockIn({ teamId: team.id, engine: 'codex', name: '코덱스' });
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
  const kindsOf = (member: Member) => events.filter((e) => e.memberId === member.id).map((e) => e.kind);
  const lastOf = (member: Member) => events.filter((e) => e.memberId === member.id).at(-1)!;

  test('같은 PreToolUse(Bash: cat) 가 엔진에 따라 running / reading 으로 갈린다', () => {
    send(claude, 'PreToolUse', bash('PreToolUse', CAT));
    send(codex, 'PreToolUse', bash('PreToolUse', CAT));
    assert.deepEqual(kindsOf(claude), ['running'], 'Claude 는 도구 이름표(Bash=셸)로 running');
    assert.deepEqual(kindsOf(codex), ['reading'], 'Codex 는 명령 휴리스틱으로 reading');
    assert.equal(lastOf(codex).detail.cmd, CAT);
  });

  test('Codex 전용 Interrupt hook 은 Codex 멤버에게만 idle 을 남긴다', () => {
    const c = send(claude, 'Interrupt', { session_id: 's', hook_event_name: 'Interrupt' });
    const x = send(codex, 'Interrupt', { session_id: 's', hook_event_name: 'Interrupt' });
    assert.deepEqual(c.sent, [{}]);
    assert.deepEqual(x.sent, [{}]);
    assert.deepEqual(kindsOf(claude), [], 'Claude 에는 이 hook 이 없다(무시)');
    assert.deepEqual(kindsOf(codex), ['idle']);
    assert.equal(lastOf(codex).detail.summary, 'interrupted');
    assert.equal(store.getMember(codex.id)!.status, 'idle');
  });

  test('Codex 허가 요청은 Codex 어댑터가 붙들고, approval.respond 가 같은 결정 JSON 을 돌려준다', () => {
    const f = send(codex, 'PermissionRequest', bash('PermissionRequest', 'echo hi > ../outside.txt', { tool_input: { command: 'echo hi > ../outside.txt', description: '승인?' } }));
    const ev = lastOf(codex);
    assert.equal(ev.kind, 'waiting_approval');
    assert.equal(ev.detail.summary, '승인?');
    const pendingId = ev.ref.approvalId!;
    assert.deepEqual(office.codexAdapter.heldPendingIds(codex.id), [pendingId], 'Codex 어댑터가 보류 중');
    assert.deepEqual(office.adapter.heldPendingIds(), [], 'Claude 어댑터는 모른다');
    office.respondApproval(pendingId, { behavior: 'allow' });
    assert.deepEqual(f.sent, [allow()]);
    assert.equal(store.getPending(pendingId)!.status, 'answered');
  });

  test('clockOut: Codex 는 Ctrl+C 로 정중히 종료(한 번에 죽으면 그걸로 끝), Claude 는 /exit', async () => {
    const codexSession = pty.session(codex.id);
    const claudeSession = pty.session(claude.id);
    await office.clockOut(codex.id);
    await office.clockOut(claude.id);
    assert.deepEqual(codexSession.keys, ['ctrl-c'], '실측: idle Codex 는 Ctrl+C 한 번이면 exit 0');
    assert.deepEqual(codexSession.writes, []);
    assert.deepEqual(claudeSession.writes, ['/exit\r']);
    assert.deepEqual(claudeSession.keys, []);
    assert.deepEqual(pty.kills, [
      { memberId: codex.id, graceful: true },
      { memberId: claude.id, graceful: true },
    ]);
    assert.equal(store.getMember(codex.id)!.status, 'exited');
  });

  test('clockOut: 첫 Ctrl+C 로 안 죽는 Codex(턴 진행 중)에게만 두 번째 Ctrl+C', async () => {
    pty.stubborn.add(codex.id);
    const codexSession = pty.session(codex.id);
    await office.clockOut(codex.id);
    assert.deepEqual(codexSession.keys, ['ctrl-c', 'ctrl-c']);
  });

  test('스폰 옵션: Codex 는 engine=codex + mcpUrl(T22, mcpConfigPath 는 Claude 전용), 재고용은 resume', async () => {
    const first = pty.spawns.find((s) => s.memberId === codex.id)!;
    assert.equal(first.engine, 'codex');
    assert.equal(first.cwd, team.cwd);
    assert.equal(first.mcpConfigPath, undefined, 'Codex 는 --mcp-config 를 쓰지 않는다');
    assert.equal(first.mcpUrl, `http://127.0.0.1:${office.daemonInfo!.mcpPort}/mcp/${codex.memberToken}`, 'Codex 는 -c mcp_servers.team.url 로 주입(T22)');
    const claudeSpawn = pty.spawns.find((s) => s.memberId === claude.id)!;
    assert.equal(claudeSpawn.mcpUrl, undefined, 'Claude 는 mcp.json 경로를 쓴다');
    assert.ok(claudeSpawn.mcpConfigPath);
    assert.equal(first.resumeSessionId, undefined);
    assert.equal(first.memberToken, codex.memberToken);

    // SessionStart 로 session_id 를 받고 퇴근 → 재고용하면 codex resume <id> 로 간다.
    send(codex, 'SessionStart', { session_id: '01a09f50-13fe', hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal(store.getMember(codex.id)!.sessionId, '01a09f50-13fe');
    await office.clockOut(codex.id);
    await office.rehire(codex.id);
    const again = pty.spawns.filter((s) => s.memberId === codex.id).at(-1)!;
    assert.equal(again.resumeSessionId, '01a09f50-13fe');
    assert.equal(again.mcpUrl, first.mcpUrl, '재고용에도 같은 MCP 엔드포인트를 다시 주입한다');
  });

  test('MCP 연결은 Codex 퇴근·프로세스 종료에서도 끊긴다 (T22)', async () => {
    const disposed: string[] = [];
    const realDispose = office.mcp.dispose.bind(office.mcp);
    office.mcp.dispose = (token: string) => {
      disposed.push(token);
      realDispose(token);
    };
    await office.clockOut(codex.id);
    assert.ok(disposed.includes(codex.memberToken), 'clockOut → dispose(memberToken)');

    disposed.length = 0;
    await office.rehire(codex.id);
    pty.exit(codex.id, 1); // 예상 못 한 종료
    assert.ok(disposed.includes(codex.memberToken), 'pty 종료 → dispose(memberToken)');
  });

  test('Codex 부팅: SessionStart 없이도 화면이 준비되면 starting → idle (T20 실측: Codex 는 첫 프롬프트 때 SessionStart)', async () => {
    assert.equal(store.getMember(codex.id)!.status, 'starting');
    assert.equal(store.getMember(claude.id)!.status, 'starting');
    // Codex 준비 화면(tui-map 의 promptReady: 입력 placeholder + 상태줄)
    pty.data(codex.id, '\x1b[2J\x1b[H› Ask Codex to do anything\r\n\r\n  gpt-6-astra high · D:\\x\r\n');
    pty.data(claude.id, '\x1b[2J\x1b[H› Ask Codex to do anything\r\n\r\n  gpt-6-astra high · D:\\x\r\n');
    for (let i = 0; i < 20 && store.getMember(codex.id)!.status === 'starting'; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(store.getMember(codex.id)!.status, 'idle', '화면 준비 → idle');
    assert.equal(store.getMember(claude.id)!.status, 'starting', 'Claude 는 SessionStart hook 으로만 idle 이 된다');
  });

  test('SessionStart 의 지시문 주입은 엔진과 무관하게 같다', () => {
    office.setInstructions(codex.id, '[코덱스 팀원]');
    const f = send(codex, 'SessionStart', { session_id: 's2', hook_event_name: 'SessionStart', source: 'startup' });
    // T26b: 프리앰블 + 사용자 지시문. 엔진 표기(`엔진 codex`)만 다르고 구조는 Claude 와 같다.
    const expected = office.buildSessionContext(codex.id);
    assert.deepEqual(f.sent, [{ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: expected } }]);
    assert.match(expected, /엔진 codex/);
    assert.ok(expected.endsWith('\n\n[코덱스 팀원]'));
  });
});

describe('reapOrphan: Codex 이미지 이름 (T20/T09)', () => {
  const ops = (name: string | undefined, kills: number[]): OrphanOps => ({ alive: () => true, name: () => name, kill: (pid) => kills.push(pid) });

  test('codex.exe 는 codex 멤버의 유령으로 인정돼 종료된다', () => {
    const kills: number[] = [];
    assert.deepEqual(reapOrphan(ops('codex.exe', kills), 4242, 'codex'), { action: 'killed' });
    assert.deepEqual(kills, [4242]);
  });

  test('codex(확장자 없는 유닉스 이름)도 인정된다', () => {
    const kills: number[] = [];
    assert.deepEqual(reapOrphan(ops('codex', kills), 4243, 'codex'), { action: 'killed' });
    assert.deepEqual(kills, [4243]);
  });

  test('다른 엔진·재사용된 pid 는 건드리지 않는다', () => {
    const kills: number[] = [];
    assert.deepEqual(reapOrphan(ops('claude.exe', kills), 4244, 'codex'), {
      action: 'skipped',
      reason: 'process name claude.exe does not look like codex',
    });
    assert.deepEqual(reapOrphan(ops('node.exe', kills), 4245, 'codex'), { action: 'skipped', reason: 'process name node.exe does not look like codex' });
    assert.deepEqual(kills, []);
  });
});
