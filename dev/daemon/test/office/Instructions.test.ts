// T26b 멤버 지시문: 기본 템플릿 · 런타임 프리앰블 · SessionStart 주입.
//   - 직급별 기본값(팀장 = 오케스트레이션 규칙 + 5개 도구 / 팀원 = 역할 규칙 + 2개 도구)
//   - 프리앰블은 사용자 파일이 있어도 늘 붙는다(정체 + 로스터 + 도구 이름)
//   - 사용자 파일 우선, `# 역할:` 한 줄뿐인 파일(hire 가 쓴 것)은 기본 템플릿을 덮지 않는다
//   - 길면 사용자 본문만 잘린다(프리앰블 유지)
//   - member.instructions.effective RPC = 주입될 그 텍스트
//   - 재주입: SessionStart(compact) 는 startup 과 같은 텍스트 / set 뒤 SessionStart(clear) 는 새 텍스트
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Office, bodyBelowRole } from '../../src/office/Office.js';
import { Store } from '../../src/store/Store.js';
import type { Member, Team } from '../../src/store/types.js';
import { sessionStartContext } from '../../src/hooks/decisions.js';
import { defaultInstructions, leaderTemplate, memberTemplate, toolsLine } from '../../src/office/instructions/templates.js';
import { MAX_CONTEXT_CHARS, TRUNCATE_MARK, buildSessionContext, rosterLines } from '../../src/office/instructions/context.js';
import { FakePty, FakeReceiver, fakeReq } from './fakes.js';

const SID = 'sess-0001';
const base = (event: string) => ({ session_id: SID, hook_event_name: event, cwd: 'D:\\x' });

describe('멤버 지시문 템플릿·주입 (T26b)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let office: Office;
  let team: Team;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t26b-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty, receiver, version: 't26b' });
    await office.start();
    team = store.createTeam({ name: 'alpha', cwd: dataDir, maxMembers: 4, allowedEngines: ['claude', 'codex'] });
  });
  afterEach(async () => {
    await office.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const leaderIn = (name = '반장') => office.clockIn({ teamId: team.id, engine: 'claude', name, rank: 'leader' });
  const memberIn = (name: string, instructions?: string) => office.clockIn({ teamId: team.id, engine: 'claude', name, instructions });
  /** SessionStart hook 을 어댑터까지 태우고 응답으로 나간 JSON 을 돌려준다. */
  const sessionStart = (m: Member, source: string) => {
    const r = fakeReq(m.memberToken, 'SessionStart', { ...base('SessionStart'), source });
    receiver.emit('hook', r.req);
    return r;
  };

  // ---- 기본 템플릿 -------------------------------------------------------------------------

  test('기본값은 직급이 고른다: 팀장은 hire/delegate/dismiss/report/ask_user, 팀원은 report/ask_user', () => {
    const leader = leaderIn();
    const worker = memberIn('이음');

    const lead = office.effectiveInstructions(leader.id);
    assert.match(lead, /^# 반장 — 팀장 @ alpha\n/);
    assert.match(lead, /- 작업 폴더: /);
    assert.match(lead, /- 엔진: claude/);
    assert.match(lead, /## 팀장 지시문/);
    assert.match(lead, /hire\(name, role, engine\?, instructions\?\)/);
    assert.match(lead, /delegate\(to_member, task\)/);
    assert.match(lead, /dismiss\(memberId\)/);
    assert.match(lead, /\[ALL_REPORTS_IN\]/);
    // 팀 설정에서 온 숫자
    assert.match(lead, /팀원 상한은 4명\(팀장 포함\), 쓸 수 있는 엔진은 claude, codex\./);
    assert.ok(lead.includes(toolsLine('leader')), '팀장 도구 이름 줄');
    assert.ok(lead.includes('mcp__team__hire') && lead.includes('mcp__team__ask_user'));

    const mem = office.effectiveInstructions(worker.id);
    assert.match(mem, /^# 이음 — 팀원 @ alpha\n/);
    assert.match(mem, /- 팀장: 반장/);
    assert.match(mem, /## 팀원 지시문/);
    assert.match(mem, /\[TASK#n from 반장\(팀장\)\] 지시를 받으면/);
    assert.match(mem, /report\(taskId, summary, status: done\|blocked\)/);
    assert.ok(mem.includes(toolsLine('member')), '팀원 도구 이름 줄');
    assert.ok(!mem.includes('mcp__team__hire'), '팀원 템플릿에 팀장 도구가 없다');

    // 파일은 만들어지지 않는다 — 기본값은 부를 때마다 계산한다(템플릿을 고치면 전원에게 바로 반영).
    assert.equal(office.getInstructions(leader.id), '');
    assert.equal(office.getInstructions(worker.id), '');
    assert.equal(fs.existsSync(office.instructionsPath(team.id, leader.id)), false);
  });

  test('defaultInstructions(member, team): rank 로 템플릿을 고르고 role/leaderName 을 머리말에 싣는다', () => {
    const leader = leaderIn();
    const worker = memberIn('이음');
    const t = store.getTeam(team.id)!;
    assert.equal(defaultInstructions(store.getMember(leader.id)!, t), leaderTemplate({
      teamName: 'alpha', cwd: t.cwd, memberName: '반장', engine: 'claude', maxMembers: 4, allowedEngines: ['claude', 'codex'],
    }));
    assert.equal(
      defaultInstructions(store.getMember(worker.id)!, t, { role: '파일 작성', leaderName: '반장' }),
      memberTemplate({
        teamName: 'alpha', cwd: t.cwd, memberName: '이음', role: '파일 작성', engine: 'claude',
        maxMembers: 4, allowedEngines: ['claude', 'codex'], leaderName: '반장',
      }),
    );
  });

  // ---- 프리앰블 ----------------------------------------------------------------------------

  test('프리앰블: 사용자 파일이 있어도 정체·로스터·도구 이름이 늘 앞에 붙는다', () => {
    const leader = leaderIn();
    const worker = memberIn('이음');
    office.teamHire(leader.id, { name: '나루', role: '문서', engine: 'codex' });
    office.setInstructions(worker.id, '말투는 반말.');

    const ctx = office.buildSessionContext(worker.id);
    assert.match(ctx, /^\[사무실\] 너는 픽셀 오피스 팀 "alpha" 의 팀원 이음\(엔진 claude\)이다\.\n/);
    assert.match(ctx, /- 작업 폴더: /);
    assert.match(ctx, /- 팀장: 반장\(claude\)\n/);
    assert.match(ctx, /- 팀원: 이음\(claude\), 나루\(codex, 역할 문서\)\n/);
    assert.ok(ctx.includes(`- ${toolsLine('member')}`), '도구 이름 줄');
    assert.match(ctx, /CLAUDE\.md\/AGENTS\.md/);
    // 사용자 본문이 프리앰블 뒤에 그대로.
    assert.ok(ctx.endsWith('\n\n말투는 반말.'), ctx.slice(-40));
    // 팀장 쪽 프리앰블은 팀장 도구 목록.
    assert.ok(office.buildSessionContext(leader.id).includes(`- ${toolsLine('leader')}`));
  });

  test('로스터는 살아 있는 멤버만 — 퇴근하면 다음 주입에서 빠진다', async () => {
    const leader = leaderIn();
    const worker = memberIn('이음');
    assert.match(office.buildSessionContext(leader.id), /- 팀원: 이음\(claude\)/);
    await office.clockOut(worker.id);
    assert.match(office.buildSessionContext(leader.id), /- 팀원: \(없음\)/);
    assert.deepEqual(rosterLines([]), ['- 팀장: (없음)', '- 팀원: (없음)']);
  });

  // ---- 사용자 파일 우선 --------------------------------------------------------------------

  test('사용자 파일이 기본 템플릿을 이긴다 — 단 `# 역할:` 한 줄뿐인 파일(hire)은 아니다', () => {
    const leader = leaderIn();
    const hired = office.teamHire(leader.id, { name: '이음', role: '파일 작성' });
    // hire 는 `# 역할: 파일 작성\n` 만 쓴다 → 본문이 없으므로 기본 템플릿 + 역할 머리말.
    assert.equal(office.getInstructions(hired.id), '# 역할: 파일 작성\n');
    const eff = office.effectiveInstructions(hired.id);
    assert.match(eff, /^# 이음 — 팀원 @ alpha\n/);
    assert.match(eff, /- 역할: 파일 작성\n/);
    assert.match(eff, /## 팀원 지시문/);

    // 팀장이 초안을 같이 주면(hire 의 instructions) 그게 본문이 되어 템플릿을 대신한다.
    const hired2 = office.teamHire(leader.id, { name: '나루', role: '문서', instructions: '반말로 답한다.' });
    assert.equal(office.effectiveInstructions(hired2.id), '# 역할: 문서\n\n반말로 답한다.\n');
    assert.ok(!office.effectiveInstructions(hired2.id).includes('## 팀원 지시문'));

    // 사용자가 출근시키며 준 지시문도 파일이 된다.
    const user = memberIn('하늘', '# 내 규칙\n짧게 답한다.');
    assert.equal(office.getInstructions(user.id), '# 내 규칙\n짧게 답한다.');
    assert.equal(office.effectiveInstructions(user.id), '# 내 규칙\n짧게 답한다.');

    assert.equal(bodyBelowRole('# 역할: x\n'), '');
    assert.equal(bodyBelowRole('# 역할: x\n\n본문'), '\n본문');
    assert.equal(bodyBelowRole('그냥 본문'), '그냥 본문');
    assert.equal(bodyBelowRole(), '');
  });

  test('긴 사용자 지시문은 본문만 잘리고 표식이 붙는다 — 프리앰블은 통째로 남는다', () => {
    const leader = leaderIn();
    const worker = memberIn('이음');
    const long = '가'.repeat(MAX_CONTEXT_CHARS * 2);
    office.setInstructions(worker.id, long);

    const ctx = office.buildSessionContext(worker.id);
    assert.ok(ctx.length <= MAX_CONTEXT_CHARS, `길이 ${ctx.length} <= ${MAX_CONTEXT_CHARS}`);
    assert.ok(ctx.endsWith(TRUNCATE_MARK), ctx.slice(-60));
    assert.match(ctx, /^\[사무실\] /);
    assert.ok(ctx.includes(`- ${toolsLine('member')}`), '잘려도 도구 이름 줄은 남는다');
    assert.ok(ctx.includes('- 팀장: 반장(claude)'), '잘려도 로스터는 남는다');

    // 짧으면 그대로.
    office.setInstructions(worker.id, '짧다.');
    assert.ok(office.buildSessionContext(worker.id).endsWith('\n\n짧다.'));
    assert.ok(!office.buildSessionContext(leader.id).includes(TRUNCATE_MARK));

    // 순수 함수로도 같은 규칙(팀·멤버 행 없이).
    const t = store.getTeam(team.id)!;
    const direct = buildSessionContext({ team: t, member: store.getMember(worker.id)!, roster: [], instructions: long });
    assert.ok(direct.length <= MAX_CONTEXT_CHARS && direct.endsWith(TRUNCATE_MARK));
    assert.ok(!buildSessionContext({ team: t, member: store.getMember(worker.id)!, roster: [], instructions: '   ' }).includes('\n\n'));
  });

  // ---- SessionStart 주입 -------------------------------------------------------------------

  test('SessionStart(startup|clear|compact|resume) 모두 같은 additionalContext 를 받는다 — compaction 유실 없음(D-05)', () => {
    const leader = leaderIn();
    const worker = memberIn('이음', '말투는 반말.');
    const expected = office.buildSessionContext(worker.id);

    for (const source of ['startup', 'clear', 'compact', 'resume']) {
      const r = sessionStart(worker, source);
      assert.deepEqual(r.sent, [sessionStartContext(expected)], `source=${source}`);
    }
    // 팀장은 팀장 텍스트.
    assert.deepEqual(sessionStart(leader, 'compact').sent, [sessionStartContext(office.buildSessionContext(leader.id))]);
  });

  test('instructions.set 뒤 SessionStart(clear) 는 새 텍스트를 주입한다 — 재시작 없이 다음 세션부터 반영', () => {
    const worker = memberIn('이음');
    const before = sessionStart(worker, 'startup').sent[0] as { hookSpecificOutput: { additionalContext: string } };
    assert.match(before.hookSpecificOutput.additionalContext, /## 팀원 지시문/);

    office.setInstructions(worker.id, '# 내 규칙\n첫 줄에 "[이음]" 을 붙인다.');
    const after = sessionStart(worker, 'clear').sent[0] as { hookSpecificOutput: { additionalContext: string } };
    const text = after.hookSpecificOutput.additionalContext;
    assert.ok(text.endsWith('# 내 규칙\n첫 줄에 "[이음]" 을 붙인다.'), text.slice(-60));
    assert.ok(!text.includes('## 팀원 지시문'), '기본 템플릿은 더 이상 안 나간다');
    assert.match(text, /^\[사무실\] .*팀원 이음/, '프리앰블은 그대로');
  });

  test('member.instructions.get 은 사용자 파일만, member.instructions.effective 는 주입될 텍스트', () => {
    const worker = memberIn('이음');
    assert.equal(office.getInstructions(worker.id), '');
    assert.equal(office.buildSessionContext(worker.id), office.buildSessionContext(worker.id));
    assert.match(office.buildSessionContext(worker.id), /^\[사무실\] /);

    office.setInstructions(worker.id, '말투는 반말.');
    assert.equal(office.getInstructions(worker.id), '말투는 반말.');
    assert.ok(office.buildSessionContext(worker.id).endsWith('\n\n말투는 반말.'));

    // 없는 멤버는 던지지 않는다(hook 경로에서 불린다).
    assert.equal(office.buildSessionContext('m_nope'), '');
    assert.equal(office.effectiveInstructions('m_nope'), '');
  });
});
