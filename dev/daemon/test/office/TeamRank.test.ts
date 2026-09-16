// T24 — 팀·직급 모델·출근/퇴근. 01 §4(팀·직급 모델) · 전제 6 · D-06.
//   ① `team.create` 가 팀장을 자동 출근시키고 `teams.leader_id` 를 채운다(`{ team, leader }`).
//   ② `member.clockIn{rank:'leader'}` 는 팀장이 없는 팀에만 — 두 번째 팀장은 -32003.
//   ③ "팀장에게만 지시": 살아 있는 팀장이 있으면 팀원 `member.instruct` 는 -32004, `force:true` 로만 넘는다.
//      팀장이 나가면(exited/error) 게이트가 열린다.
//   ④ `team.delete` 는 팀장·팀원 전원을 퇴근시킨다.
//   ⑤ 스냅샷 JSON 에 `Member.rank` / `Team.leaderId` 가 들어 있다.
// 가짜 pty + 가짜 HookReceiver 위의 진짜 Office/Store.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_LEADER_NAME, Office, leaderOnlyMessage } from '../../src/office/Office.js';
import { RPC_ERROR } from '../../src/office/errors.js';
import { Store } from '../../src/store/Store.js';
import type { Member } from '../../src/store/types.js';
import { FakePty, FakeReceiver } from './fakes.js';

const code = (e: unknown) => (e as { code?: number }).code;

describe('팀·직급 모델 (T24)', () => {
  let dataDir: string;
  let store: Store;
  let pty: FakePty;
  let receiver: FakeReceiver;
  let office: Office;
  let notices: string[];
  let statuses: Array<[string, string, string]>;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-office-t24-'));
    store = new Store(':memory:');
    pty = new FakePty();
    receiver = new FakeReceiver();
    office = new Office({ config: { dataDir, hookPort: 0, wsPort: 0, mcpPort: 0 }, store, pty, receiver, version: 't24' });
    notices = [];
    statuses = [];
    office.on('notice', (l, m) => notices.push(`${l}: ${m}`));
    office.on('status', (id, s, d) => statuses.push([id, s, d]));
    await office.start();
  });
  afterEach(async () => {
    await office.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const createTeam = (over: Partial<Parameters<Office['createTeam']>[0]> = {}) =>
    office.createTeam({ name: 'alpha', cwd: dataDir, leaderEngine: 'claude', ...over });

  // ---- ① 팀 생성 = 팀장 자동 출근 --------------------------------------------------------

  test('team.create: 팀장이 rank leader / hiredBy user 로 자동 출근하고 teams.leader_id 가 채워진다', () => {
    const { team, leader } = createTeam({ leaderName: '반장' });

    assert.equal(leader.rank, 'leader');
    assert.equal(leader.hiredBy, 'user');
    assert.equal(leader.name, '반장');
    assert.equal(leader.engine, 'claude');
    assert.equal(leader.teamId, team.id);
    assert.equal(leader.status, 'starting');
    assert.equal(leader.cwd, path.resolve(dataDir));

    // 팀 행에 기록됐고 store 에서도 같은 값이 보인다.
    assert.equal(team.leaderId, leader.id);
    assert.equal(store.getTeam(team.id)!.leaderId, leader.id);
    assert.equal(store.liveLeader(team.id)!.id, leader.id);

    // 실제로 CLI 가 스폰됐다 — 팀장도 보통 멤버와 같은 경로.
    assert.equal(pty.spawns.length, 1);
    assert.equal(pty.spawns[0]!.memberId, leader.id);
    assert.equal(pty.spawns[0]!.engine, 'claude');
    assert.equal(pty.spawns[0]!.resumeSessionId, undefined);
    assert.ok(pty.session(leader.id).alive);

    // 다른 클라이언트가 알 수 있도록 member.status 가 멤버 행과 함께 나간다(RpcServer 가 getMember 로 붙인다).
    assert.deepEqual(statuses, [[leader.id, 'starting', 'starting']]);
  });

  test('team.create: leaderName 이 없으면 기본 이름 "팀장"; 공백만 줘도 기본 이름', () => {
    assert.equal(createTeam().leader.name, DEFAULT_LEADER_NAME);
    assert.equal(createTeam({ name: 'b', leaderName: '   ' }).leader.name, DEFAULT_LEADER_NAME);
  });

  test('team.create: 팀장 엔진이 codex 여도 허용하되 daemon.notice{warn} 을 낸다 (v1 권장은 claude)', () => {
    const { leader } = createTeam({ leaderEngine: 'codex', allowedEngines: ['claude', 'codex'] });
    assert.equal(leader.engine, 'codex');
    assert.ok(
      notices.some((n) => n.startsWith('warn:') && n.includes('codex')),
      `codex 팀장 경고: ${JSON.stringify(notices)}`,
    );
  });

  test('team.create: 잘못된 파라미터 — cwd 아님 / 모르는 엔진 / allowedEngines 에 없는 팀장 엔진 / maxMembers<1', () => {
    const bad = (over: Record<string, unknown>) =>
      assert.throws(() => createTeam(over as never), (e: unknown) => code(e) === RPC_ERROR.INVALID_PARAMS);
    bad({ cwd: path.join(dataDir, 'missing') });
    bad({ leaderEngine: 'gpt' });
    bad({ leaderEngine: 'codex', allowedEngines: ['claude'] });
    bad({ maxMembers: 0 });
    assert.equal(store.listTeams().length, 0, '검사에 걸린 팀 행은 남지 않는다');
  });

  test('team.create: 팀장 스폰이 실패하면 팀 행도 되돌린다(팀장 없는 팀을 남기지 않는다)', () => {
    // FakePty 는 memberId 를 미리 모르므로, spawn 자체를 한 번 던지게 바꾼다.
    const original = pty.spawn.bind(pty);
    pty.spawn = () => {
      throw new Error('spawn refused');
    };
    assert.throws(() => createTeam(), /spawn refused/);
    assert.equal(store.listTeams().length, 0);
    assert.equal(store.listMembers().length, 0);
    pty.spawn = original;
  });

  test('team.create: 팀장도 정원(maxMembers)의 한 자리 — maxMembers:1 이면 팀원 출근이 거절된다', () => {
    const { team } = createTeam({ maxMembers: 1 });
    assert.throws(
      () => office.clockIn({ teamId: team.id, engine: 'claude', name: '이음' }),
      (e: unknown) => code(e) === RPC_ERROR.BAD_STATE,
    );
  });

  // ---- ② 두 번째 팀장 ---------------------------------------------------------------------

  test('member.clockIn{rank:leader}: 살아 있는 팀장이 있으면 -32003, 팀장이 나가면 다시 허용', () => {
    const { team, leader } = createTeam();

    assert.throws(
      () => office.clockIn({ teamId: team.id, engine: 'claude', name: '대행', rank: 'leader' }),
      (e: unknown) => code(e) === RPC_ERROR.BAD_STATE,
      '두 번째 팀장은 거절',
    );
    // 팀원은 그대로 출근된다.
    const member = office.clockIn({ teamId: team.id, engine: 'claude', name: '이음' });
    assert.equal(member.rank, 'member');
    assert.equal(member.hiredBy, 'user');

    // 팀장이 나가면(프로세스 비정상 종료 → error) 게이트가 열린다.
    pty.exit(leader.id, 1);
    assert.equal(store.liveLeader(team.id), undefined);
    const newLeader = office.clockIn({ teamId: team.id, engine: 'claude', name: '대행', rank: 'leader' });
    assert.equal(newLeader.rank, 'leader');
    assert.equal(store.getTeam(team.id)!.leaderId, newLeader.id, 'leader_id 가 새 팀장으로 갱신된다');
    assert.equal(store.liveLeader(team.id)!.id, newLeader.id);
  });

  test('hireByLeader(T25 용): hiredBy leader / rank member, 팀장이 아닌 멤버가 부르면 -32004', () => {
    const { team, leader } = createTeam();
    const hired = office.hireByLeader({ leaderId: leader.id, engine: 'claude', name: '이음', instructions: '# 역할\n테스터' });
    assert.equal(hired.rank, 'member');
    assert.equal(hired.hiredBy, 'leader');
    assert.equal(hired.teamId, team.id);
    assert.equal(fs.readFileSync(office.instructionsPath(team.id, hired.id), 'utf8'), '# 역할\n테스터');

    assert.throws(
      () => office.hireByLeader({ leaderId: hired.id, engine: 'claude', name: 'x' }),
      (e: unknown) => code(e) === RPC_ERROR.RANK_RULE,
    );
    // 나간 팀장도 고용할 수 없다.
    pty.exit(leader.id, 1);
    assert.throws(
      () => office.hireByLeader({ leaderId: leader.id, engine: 'claude', name: 'y' }),
      (e: unknown) => code(e) === RPC_ERROR.RANK_RULE,
    );
  });

  // ---- ③ "팀장에게만 지시" -----------------------------------------------------------------

  test('member.instruct: 살아 있는 팀장이 있으면 팀원 지시는 -32004 (팀장 본인은 통과)', () => {
    const { team, leader } = createTeam({ leaderName: '반장' });
    const member = office.clockIn({ teamId: team.id, engine: 'claude', name: '이음' });

    let thrown: unknown;
    try {
      office.instruct(member.id, '빌드 돌려줘');
    } catch (e) {
      thrown = e;
    }
    assert.equal(code(thrown), RPC_ERROR.RANK_RULE);
    assert.equal((thrown as Error).message, '팀장에게만 지시할 수 있습니다 (leader: 반장)');
    assert.equal((thrown as Error).message, leaderOnlyMessage(leader.name));
    assert.deepEqual((thrown as { data?: unknown }).data, { leaderId: leader.id });
    assert.equal(store.listTasks({ toMember: member.id }).length, 0, '거절된 지시는 task 를 만들지 않는다');

    // 팀장에게는 그대로 간다.
    const taskId = office.instruct(leader.id, '기능 나눠서 진행해');
    assert.equal(store.getTask(taskId)!.toMember, leader.id);
  });

  test('member.instruct{force:true}: 게이트를 넘는 디버그 탈출구 — 팀원에게 task 가 생긴다', () => {
    const { team } = createTeam();
    const member = office.clockIn({ teamId: team.id, engine: 'claude', name: '이음' });
    const taskId = office.instruct(member.id, '직접 지시', { force: true });
    assert.equal(store.getTask(taskId)!.toMember, member.id);
    assert.equal(store.getTask(taskId)!.fromMember, 'user');
  });

  test('member.instruct: 팀장이 나가면(exited) 팀원 직접 지시가 열린다', async () => {
    const { team, leader } = createTeam();
    const member = office.clockIn({ teamId: team.id, engine: 'claude', name: '이음' });
    assert.throws(() => office.instruct(member.id, 'x'), (e: unknown) => code(e) === RPC_ERROR.RANK_RULE);

    await office.clockOut(leader.id);
    assert.equal(store.getMember(leader.id)!.status, 'exited');
    assert.equal(store.liveLeader(team.id), undefined);
    const taskId = office.instruct(member.id, '이제 직접 지시');
    assert.equal(store.getTask(taskId)!.toMember, member.id);
  });

  test('member.instruct: 게이트는 같은 팀에만 — 팀장 없는 다른 팀의 멤버는 그대로 지시된다', () => {
    createTeam();
    const other = store.createTeam({ name: 'no-leader', cwd: dataDir });
    const m = office.clockIn({ teamId: other.id, engine: 'claude', name: '외톨이' });
    assert.ok(office.instruct(m.id, '혼자 해줘') > 0);
  });

  test('member.type(터미널 직접 타이핑)은 게이트와 무관하다 — 그건 "지시"가 아니다', () => {
    const { team } = createTeam();
    const member = office.clockIn({ teamId: team.id, engine: 'claude', name: '이음' });
    office.typeRaw(member.id, 'ls\r');
    assert.ok(pty.session(member.id).writes.includes('ls\r'));
  });

  // ---- ④ 팀 삭제 --------------------------------------------------------------------------

  test('team.delete: 팀장·팀원 전원을 퇴근시키고 행을 지운다', async () => {
    const { team, leader } = createTeam({ maxMembers: 4 });
    const a = office.clockIn({ teamId: team.id, engine: 'claude', name: '이음' });
    const b = office.clockIn({ teamId: team.id, engine: 'claude', name: '하루' });
    assert.equal(store.listMembers(team.id).length, 3);

    await office.deleteTeam(team.id);

    assert.equal(store.getTeam(team.id), undefined);
    for (const id of [leader.id, a.id, b.id]) assert.equal(store.getMember(id), undefined, `${id} 행이 지워졌다`);
    assert.deepEqual(
      pty.kills.map((k) => k.memberId).sort(),
      [leader.id, a.id, b.id].sort(),
      '팀장 포함 전원에게 종료가 갔다',
    );
    assert.ok(pty.kills.every((k) => k.graceful), '정중한 종료');
    assert.equal(pty.list().length, 0);
  });

  // ---- ⑤ 스냅샷 ---------------------------------------------------------------------------

  test('snapshot JSON: Member.rank 와 Team.leaderId 가 그대로 실린다', () => {
    const { team, leader } = createTeam({ leaderName: '반장' });
    const member = office.clockIn({ teamId: team.id, engine: 'claude', name: '이음' });

    // 와이어를 그대로 보기 위해 직렬화 왕복.
    const snap = JSON.parse(JSON.stringify(office.snapshot()));
    const t = snap.teams.find((x: { id: string }) => x.id === team.id);
    assert.equal(t.leaderId, leader.id);
    assert.equal(t.maxMembers, 4);
    const rows: Array<{ id: string; rank: string; hiredBy: string }> = snap.members;
    assert.equal(rows.find((m) => m.id === leader.id)!.rank, 'leader');
    assert.equal(rows.find((m) => m.id === leader.id)!.hiredBy, 'user');
    assert.equal(rows.find((m) => m.id === member.id)!.rank, 'member');
    // getMember(=`member.status` 알림의 member 필드)도 같은 값을 준다.
    assert.equal((office.getMember(leader.id) as Member).rank, 'leader');
  });
});
