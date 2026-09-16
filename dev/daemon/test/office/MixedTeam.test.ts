// T23: 혼합 팀(Claude 1 + Codex 1)이 같은 사무실에서 각자 동작하는지 — 가짜 pty + 가짜 HookReceiver.
//
//   T20 `CodexRouting.test.ts` 가 "같은 hook 을 두 엔진에 보내면 갈린다"를 본다면, 이 파일은 한 발 더 나가
//   **실측 hook 로그를 두 멤버에 번갈아 흘려** 사무실 전체(이벤트·pending·status·스냅샷·퇴근·MCP)가
//   멤버별로 독립인지 본다. M3 완료 기준("혼합 팀에서 Codex 캐릭터가 동작")의 단위 테스트 절반이다.
//
//   페이로드 출처(가공하지 않고 파일에서 읽는다):
//     - Claude : dev/spike-0/hooklog-2.json  (SessionStart/UserPromptSubmit/PreToolUse(AskUserQuestion·Bash·Write)/
//                PermissionRequest/PostToolUse/Notification/Stop/SessionEnd — 스파이크 실측 23건)
//     - Codex  : dev/spike-0/hooklog-codex.json (SessionStart(resume)/UserPromptSubmit/Stop/SessionEnd — 실측 4건)
//   두 로그에 없는 조합(Claude `Read`, Codex `cat`/`echo >`)은 **같은 로그의 실제 PreToolUse 봉투를 그대로 쓰고
//   tool_name/tool_input 만 바꿔** 만든다(Codex 쪽 키 목록은 run-codex6.log 44행 그대로). 설계 표 대조용.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Office } from '../../src/office/Office.js';
import { Store } from '../../src/store/Store.js';
import type { Member, OfficeEvent, Team } from '../../src/store/types.js';
import type { HookEvent, HookPayload } from '../../src/hooks/types.js';
import { FakePty, FakeReceiver, fakeReq } from './fakes.js';
import { allow } from '../../src/hooks/decisions.js';

// ---- 실측 로그 로딩 --------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const spikeDir = path.resolve(here, '../../../spike-0');

interface LogEntry {
  ev: HookEvent;
  payload: HookPayload;
}

function loadLog(file: string): LogEntry[] {
  const raw = JSON.parse(fs.readFileSync(path.join(spikeDir, file), 'utf8')) as Array<{ ev: string; payload: HookPayload }>;
  return raw.map((e) => ({ ev: e.ev as HookEvent, payload: e.payload }));
}

const CLAUDE_LOG = loadLog('hooklog-2.json');
const CODEX_LOG = loadLog('hooklog-codex.json');

/** 실측 로그에서 그 이벤트의 첫 페이로드(봉투) — 필드를 갈아 끼울 원본으로 쓴다. */
function envelope(log: LogEntry[], ev: HookEvent): HookPayload {
  const found = log.find((e) => e.ev === ev);
  assert.ok(found, `실측 로그에 ${ev} 가 없다`);
  return found.payload;
}

/** hooklog-2.json 의 진짜 PreToolUse 봉투 + 도구만 교체. */
function claudePre(toolName: string, toolInput: Record<string, unknown>): HookPayload {
  return { ...envelope(CLAUDE_LOG, 'PreToolUse'), tool_name: toolName, tool_input: toolInput } as HookPayload;
}

/**
 * Codex PreToolUse. hooklog-codex.json 에는 PreToolUse 가 없어(스파이크 로그가 4건짜리다) 같은 세션의
 * UserPromptSubmit 봉투에 run-codex6.log 가 기록한 키(tool_name, tool_input, tool_use_id)를 얹는다.
 */
function codexPre(command: string, toolUseId = 'call_8YkP3n'): HookPayload {
  const base = envelope(CODEX_LOG, 'UserPromptSubmit') as Record<string, unknown>;
  const { prompt: _prompt, ...rest } = base;
  return { ...rest, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: toolUseId } as HookPayload;
}

function codexPerm(command: string, description: string): HookPayload {
  const p = codexPre(command) as Record<string, unknown>;
  delete p.tool_use_id; // 실측: Codex PermissionRequest 에는 tool_use_id 가 없다(T20 함정 6)
  return { ...p, hook_event_name: 'PermissionRequest', tool_input: { command, description } } as HookPayload;
}

// ---- 하네스 ---------------------------------------------------------------------

describe('혼합 팀: Claude 1 + Codex 1 (T23)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let office: Office;
  let team: Team;
  let events: OfficeEvent[];
  let 하루: Member; // claude
  let 코덱: Member; // codex
  let disposed: string[];

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t23-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty, receiver, version: '1.0.0' });
    events = [];
    office.on('event', (e) => events.push(e));
    await office.start();
    disposed = [];
    const realDispose = office.mcp.dispose.bind(office.mcp);
    office.mcp.dispose = (token: string) => {
      disposed.push(token);
      realDispose(token);
    };
    team = office.createTeam({ name: 'demo', cwd: dataDir, leaderEngine: 'claude', allowedEngines: ['claude', 'codex'] });
    하루 = office.clockIn({ teamId: team.id, engine: 'claude', name: '하루' });
    코덱 = office.clockIn({ teamId: team.id, engine: 'codex', name: '코덱' });
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
  const kindsOf = (m: Member) => events.filter((e) => e.memberId === m.id).map((e) => e.kind);
  const eventsOf = (m: Member) => events.filter((e) => e.memberId === m.id);
  const statusOf = (m: Member) => store.getMember(m.id)!.status;
  const openPendings = (m: Member) => store.snapshot().pending.filter((p) => p.memberId === m.id);

  // ---- 1. 이벤트 매핑 (설계 01 §2 표) -------------------------------------------

  test('같은 사무실에서 각 엔진의 도구가 표대로 매핑된다 (Claude 이름표 / Codex 명령 휴리스틱)', () => {
    // 번갈아 넣는다 — 한쪽 hook 이 다른 쪽 매핑에 영향을 주지 않는지 보려고.
    send(하루, 'PreToolUse', claudePre('Read', { file_path: 'D:\\x\\hello.txt' }));
    send(코덱, 'PreToolUse', codexPre('cat notes.txt'));
    send(하루, 'PreToolUse', claudePre('Bash', { command: 'echo hold > hold.txt', description: 'Write "hold" to hold.txt' }));
    send(코덱, 'PreToolUse', codexPre('echo hi > ../outside.txt'));
    send(하루, 'PreToolUse', claudePre('Write', { file_path: 'D:\\x\\multi.txt', content: 'a\n' }));
    send(코덱, 'PreToolUse', codexPre('apply_patch <<EOF\n*** Begin Patch\n*** Update File: src/a.ts\nEOF'));

    assert.deepEqual(kindsOf(하루), ['reading', 'running', 'editing'], 'Claude: Read/Bash/Write 이름표');
    assert.deepEqual(kindsOf(코덱), ['reading', 'running', 'editing'], 'Codex: cat / echo> / apply_patch 휴리스틱');

    const c = eventsOf(하루);
    assert.equal(c[0]!.detail.path, 'D:\\x\\hello.txt');
    assert.equal(c[1]!.detail.cmd, 'echo hold > hold.txt');
    assert.equal(c[1]!.detail.summary, 'Write "hold" to hold.txt');
    assert.equal(c[2]!.detail.path, 'D:\\x\\multi.txt');

    const x = eventsOf(코덱);
    assert.equal(x[0]!.detail.tool, 'Bash');
    assert.equal(x[0]!.detail.cmd, 'cat notes.txt');
    assert.equal(x[1]!.detail.cmd, 'echo hi > ../outside.txt', '쓰기 리다이렉트는 reading 이 아니다');
    assert.equal(x[2]!.detail.path, 'src/a.ts', 'apply_patch 본문에서 경로를 뽑는다');
    // 같은 명령을 Claude 에게 주면 이름표만 보므로 running 이다(T20 CodexRouting 과 같은 대조).
    assert.equal(eventsOf(하루).filter((e) => e.kind === 'reading').length, 1);
  });

  test('실측 로그 전체 재생: 두 로그를 번갈아 흘려도 각자 자기 이벤트만 쌓는다', () => {
    const maxLen = Math.max(CLAUDE_LOG.length, CODEX_LOG.length);
    for (let i = 0; i < maxLen; i++) {
      if (CLAUDE_LOG[i]) send(하루, CLAUDE_LOG[i]!.ev, CLAUDE_LOG[i]!.payload);
      if (CODEX_LOG[i]) send(코덱, CODEX_LOG[i]!.ev, CODEX_LOG[i]!.payload);
    }
    // 모든 이벤트에 주인이 있고, 섞이지 않았다.
    assert.equal(
      events.filter((e) => e.memberId !== 하루.id && e.memberId !== 코덱.id).length,
      0,
      '제3의 멤버 이벤트가 생기면 안 된다',
    );
    assert.ok(eventsOf(하루).length > 0 && eventsOf(코덱).length > 0);

    // Claude: 질문(AskUserQuestion) → 셸 허가 → 쓰기 허가 → 각 턴 끝의 idle/text 가 순서대로.
    const ck = kindsOf(하루);
    assert.ok(ck.includes('asking'), 'AskUserQuestion → asking');
    assert.ok(ck.includes('waiting_approval'), 'Bash/Write PermissionRequest → waiting_approval');
    assert.ok(ck.includes('editing'), 'Write → editing');
    // Codex 로그(4건)는 도구가 없는 대화 한 턴이다:
    //   SessionStart(source=resume) → text{resumed} / UserPromptSubmit → thinking / Stop → text+idle / SessionEnd → idle
    assert.deepEqual(kindsOf(코덱), ['text', 'thinking', 'text', 'idle', 'idle'], '엔진 공통 뼈대를 그대로 탄다');
    const codexTexts = eventsOf(코덱).filter((e) => e.kind === 'text');
    assert.equal(codexTexts[0]!.detail.summary, 'resumed');
    assert.equal(codexTexts[1]!.detail.text, '[코덱스 팀원] 아까 만든 파일 이름은 `outside.txt`입니다.', 'Stop 의 last_assistant_message');

    // session_id 는 엔진별로 각자 최신 값(Claude 는 로그 후반에 /clear 로 바뀐다).
    assert.equal(store.getMember(코덱.id)!.sessionId, '01a09f50-13fe-70a0-90b4-2b2a7cdbcb7a');
    assert.equal(store.getMember(하루.id)!.sessionId, 'd5477a7c-8324-45e6-8dee-ffd7b4974cc0');
  });

  // ---- 2. pending 은 멤버별로 따로 --------------------------------------------

  test('허가 pending 이 멤버별로 따로 열리고, 한쪽 응답이 다른 쪽을 건드리지 않는다', () => {
    const cf = send(하루, 'PermissionRequest', claudePre('Bash', { command: 'echo hold > hold.txt', description: 'Write "hold" to hold.txt' }));
    const xf = send(코덱, 'PermissionRequest', codexPerm('echo hi > ../outside.txt', '상위 폴더에 outside.txt를 만들도록 승인하시겠어요?'));

    const cPend = openPendings(하루);
    const xPend = openPendings(코덱);
    assert.equal(cPend.length, 1);
    assert.equal(xPend.length, 1);
    assert.notEqual(cPend[0]!.id, xPend[0]!.id);
    assert.equal(statusOf(하루), 'waiting_approval');
    assert.equal(statusOf(코덱), 'waiting_approval');

    // 어댑터도 각자 붙들고 있다.
    assert.deepEqual(office.adapter.heldPendingIds(하루.id), [cPend[0]!.id]);
    assert.deepEqual(office.codexAdapter.heldPendingIds(코덱.id), [xPend[0]!.id]);
    assert.deepEqual(office.adapter.heldPendingIds(코덱.id), [], 'Claude 어댑터는 Codex 멤버를 모른다');
    assert.deepEqual(office.codexAdapter.heldPendingIds(하루.id), []);

    // 하루만 허가 → 코덱은 그대로 대기.
    office.respondApproval(cPend[0]!.id, { behavior: 'allow' });
    assert.deepEqual(cf.sent, [allow()]);
    assert.deepEqual(xf.sent, [], 'Codex hook 은 아직 보류 중');
    assert.equal(openPendings(하루).length, 0);
    assert.equal(openPendings(코덱).length, 1);
    assert.equal(statusOf(코덱), 'waiting_approval');

    // 코덱도 허가 → 같은 결정 JSON.
    office.respondApproval(xPend[0]!.id, { behavior: 'allow' });
    assert.deepEqual(xf.sent, [allow()]);
    assert.equal(openPendings(코덱).length, 0);
  });

  test('Codex 질문 폴백 pending 과 Claude TUI 질문 pending 이 동시에 열려도 서로 독립 (T22)', () => {
    // Claude: 실측 AskUserQuestion PermissionRequest → question pending
    send(하루, 'PreToolUse', envelope(CLAUDE_LOG, 'PreToolUse'));
    send(하루, 'PermissionRequest', envelope(CLAUDE_LOG, 'PermissionRequest'));
    // Codex: 도구 없이 질문으로 턴을 끝냄 → 폴백 question pending
    const stop = { ...envelope(CODEX_LOG, 'Stop'), last_assistant_message: '어느 폴더부터 볼까요?' } as HookPayload;
    send(코덱, 'Stop', stop);

    const cq = openPendings(하루);
    const xq = openPendings(코덱);
    assert.equal(cq.length, 1);
    assert.equal(xq.length, 1);
    assert.equal(cq[0]!.type, 'question');
    assert.equal(xq[0]!.type, 'question');
    assert.ok((cq[0]!.payload as Record<string, unknown>).tool_input, 'TUI 질문은 tool_input 이 있다(D-19)');
    assert.equal((xq[0]!.payload as Record<string, unknown>).source, 'ask_user');
    assert.equal((xq[0]!.payload as Record<string, unknown>).fallback, 'codex-stop');
    assert.equal(statusOf(코덱), 'idle', '폴백은 raw status 를 건드리지 않는다(T22 함정 4)');
    assert.ok(kindsOf(코덱).includes('asking'));
  });

  // ---- 3. 스냅샷 ----------------------------------------------------------------

  test('스냅샷에 두 멤버가 각자 엔진으로 들어 있다', () => {
    const snap = office.snapshot();
    assert.equal(snap.teams.length, 1);
    const byName = new Map(snap.members.map((m) => [m.name, m]));
    assert.equal(byName.size, 2);
    assert.equal(byName.get('하루')!.engine, 'claude');
    assert.equal(byName.get('코덱')!.engine, 'codex');
    assert.equal(byName.get('하루')!.teamId, team.id);
    assert.equal(byName.get('코덱')!.teamId, team.id);
    assert.notEqual(byName.get('하루')!.memberToken, byName.get('코덱')!.memberToken);
    // 스폰 인자도 엔진별로 다르다(T22: Claude=mcp.json, Codex=-c mcp_servers.team.url).
    const cSpawn = pty.spawns.find((s) => s.memberId === 하루.id)!;
    const xSpawn = pty.spawns.find((s) => s.memberId === 코덱.id)!;
    assert.equal(cSpawn.engine, 'claude');
    assert.equal(xSpawn.engine, 'codex');
    assert.ok(cSpawn.mcpConfigPath);
    assert.equal(cSpawn.mcpUrl, undefined);
    assert.equal(xSpawn.mcpConfigPath, undefined);
    assert.equal(xSpawn.mcpUrl, `http://127.0.0.1:${office.daemonInfo!.mcpPort}/mcp/${코덱.memberToken}`);
  });

  test('스냅샷의 pending 은 멤버별로 구분되고, 각자 엔진의 detail 을 싣는다', () => {
    send(하루, 'PermissionRequest', claudePre('Bash', { command: 'echo hold > hold.txt', description: 'Write "hold" to hold.txt' }));
    send(코덱, 'PermissionRequest', codexPerm('echo hi > ../outside.txt', '승인하시겠어요?'));
    const snap = office.snapshot();
    assert.equal(snap.pending.length, 2);
    const byMember = new Map(snap.pending.map((p) => [p.memberId, p]));
    assert.ok(byMember.has(하루.id));
    assert.ok(byMember.has(코덱.id));
    const cEv = eventsOf(하루).at(-1)!;
    const xEv = eventsOf(코덱).at(-1)!;
    assert.equal(cEv.detail.summary, 'Write "hold" to hold.txt', 'Claude: description');
    assert.equal(xEv.detail.summary, '승인하시겠어요?', 'Codex: 한국어 승인 문구');
  });

  // ---- 4. 퇴근 격리 --------------------------------------------------------------

  test('한 명의 퇴근이 다른 한 명의 상태·pending·세션을 건드리지 않는다', async () => {
    send(하루, 'PermissionRequest', claudePre('Bash', { command: 'echo hold > hold.txt' }));
    send(코덱, 'PermissionRequest', codexPerm('echo hi > ../outside.txt', '승인?'));
    assert.equal(openPendings(하루).length, 1);
    assert.equal(openPendings(코덱).length, 1);
    const claudeSession = pty.session(하루.id);

    await office.clockOut(코덱.id);

    assert.equal(statusOf(코덱), 'exited');
    assert.equal(openPendings(코덱).length, 0, '퇴근하면 그 멤버 pending 만 만료');
    assert.equal(statusOf(하루), 'waiting_approval', '하루는 그대로 대기 중');
    assert.equal(openPendings(하루).length, 1);
    assert.ok(claudeSession.alive, '하루 세션은 살아 있다');
    assert.deepEqual(
      pty.kills.map((k) => k.memberId),
      [코덱.id],
      '코덱 세션만 종료',
    );
    // 퇴근 키도 엔진별(Codex=Ctrl+C, Claude=/exit) — 하루에게는 아무것도 안 갔다.
    assert.deepEqual(claudeSession.writes, []);
    assert.deepEqual(claudeSession.keys, []);

    // 남은 하루는 계속 정상 동작한다.
    office.respondApproval(openPendings(하루)[0]!.id, { behavior: 'allow' });
    send(하루, 'Stop', envelope(CLAUDE_LOG, 'Stop'));
    assert.equal(statusOf(하루), 'idle');
    assert.ok(kindsOf(하루).includes('idle'));
  });

  test('반대 방향: Claude 퇴근 후에도 Codex 는 hook 을 계속 처리한다', async () => {
    await office.clockOut(하루.id);
    assert.equal(statusOf(하루), 'exited');
    const before = eventsOf(코덱).length;
    send(코덱, 'PreToolUse', codexPre('cat notes.txt'));
    send(코덱, 'Stop', envelope(CODEX_LOG, 'Stop'));
    const after = eventsOf(코덱);
    assert.ok(after.length > before);
    assert.deepEqual(after.slice(before).map((e) => e.kind), ['reading', 'text', 'idle']);
    assert.equal(statusOf(코덱), 'idle');
  });

  // ---- 5. TeamTools MCP 토큰 --------------------------------------------------

  test('TeamTools MCP 연결은 멤버 토큰별로 따로 끊긴다', async () => {
    assert.notEqual(하루.memberToken, 코덱.memberToken);
    // 스폰(disposeRuntime)이 남긴 no-op dispose 는 세지 않는다. 한 번의 퇴근에서 같은 토큰이 두 번
    // 끊길 수는 있다(pty exit 경로 + finishMember 경로, T22) — 중요한 건 **다른 멤버 토큰이 섞이지 않는 것**.
    disposed.length = 0;
    await office.clockOut(코덱.id);
    assert.deepEqual([...new Set(disposed)], [코덱.memberToken], '코덱 토큰만 dispose');

    disposed.length = 0;
    await office.clockOut(하루.id);
    assert.deepEqual([...new Set(disposed)], [하루.memberToken]);
  });

  test('프로세스가 죽어도 그 멤버 토큰만 dispose 되고 다른 멤버는 멀쩡하다', () => {
    disposed.length = 0;
    pty.exit(코덱.id, 1); // Codex 비정상 종료
    assert.ok(disposed.includes(코덱.memberToken));
    assert.ok(!disposed.includes(하루.memberToken), 'Claude 연결은 유지');
    assert.equal(statusOf(하루), 'starting');
    assert.ok(pty.session(하루.id).alive);
  });
});
