// 콘솔 도움말·트리 출력 (T38, rev 3). `index.ts` 는 import 하는 순간 main() 이 도므로
// 순수한 부분(HELP·treeLines)을 `help.ts`/`format.ts` 로 빼 두고 여기서 본다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HELP, helpCommands, helpLines } from '../../src/cli/help.js';
import { treeLines, type TreeNode } from '../../src/cli/format.js';
import type { Department, Member, Team } from '../../src/store/types.js';

const text = helpLines().join('\n');

const member = (id: string, name: string, rank: Member['rank'], derived: string): Member & { derived: string } => ({
  id,
  departmentId: 'd1',
  teamId: rank === 'head' ? null : 't1',
  parentId: rank === 'head' ? null : 'mH',
  name,
  rank,
  engine: 'claude',
  sessionId: null,
  childPid: null,
  cwd: 'D:\\x',
  status: 'idle',
  hiredBy: 'leader',
  memberToken: 'mt',
  instructionsPath: null,
  createdAt: 'c',
  updatedAt: 'u',
  derived,
});

const DEPT: Department = { id: 'd_1', name: 'alpha', cwd: 'D:\\x', headId: 'mH', createdAt: 'c' };
const TEAM: Team = { id: 't1', departmentId: 'd_1', name: 't1', cwd: 'D:\\x', leaderId: 'mL', maxMembers: 4, allowedEngines: ['claude'], createdAt: 'c' };

describe('콘솔 도움말 (T38 rev 3)', () => {
  test('트리 순서의 절 + rev 3 명령이 전부 있다', () => {
    assert.deepEqual(
      HELP.map((s) => s.title.split(' (')[0]),
      ['부서·트리', '지시·터미널', '내 책상 — 허가·질문', '일·이벤트', '지시문', '멤버', '디버그', '연결'],
    );
    for (const usage of [
      'dept create <name> <cwd> [claude|codex] [부장이름]',
      'depts',
      'dept delete <dept>',
      'tree',
      'say <head> <text...>',
      'pending',
      'allow <pending>',
      'deny <pending> [message]',
      'answer <pending> <question>=<label> ...',
      'tasks',
      'instr get <member>',
      'instr set <member> [text]',
      'instr effective <member>',
      'attach <member>',
      'type <member> <text>',
      'int <member>',
      'fire <member>',
    ]) {
      assert.ok(text.includes(usage), `도움말에 없음: ${usage}`);
    }
    // 첫 토큰이 실제 명령어 집합과 맞는다(오타 방지).
    for (const cmd of helpCommands()) {
      assert.match(cmd, /^(depts|dept|tree|teams|team|members|hire|fire|rehire|restart|say|say!|type|attach|detach|int|resize|pending|allow|deny|answer|events|query|tasks|instr|refresh|reconnect|help|quit|shutdown)$/);
    }
  });

  test('디버그 명령은 디버그 절에만 있고 force 를 밝힌다', () => {
    const debug = HELP.find((s) => s.title.startsWith('디버그'))!;
    const rows = debug.rows.map(([u]) => u);
    assert.ok(rows.some((u) => u.startsWith('team create')));
    assert.ok(rows.some((u) => u.startsWith('hire')));
    assert.match(debug.title, /force:true/);
    for (const [, desc] of debug.rows.filter(([u]) => u.startsWith('team ') || u.startsWith('hire'))) {
      assert.match(desc, /\[디버그\]/);
    }
  });

  test('없어진 2단(팀장에게만 지시·팀=최상위) 문구가 남아 있지 않다', () => {
    assert.ok(!text.includes('팀장에게만'), '"팀장에게만 지시" 는 rev 3 에서 "부장에게만" 이다');
    assert.ok(!/team create <name> <cwd>/.test(text), '옛 2단 team create 사용법이 남아 있다');
    assert.ok(!/hire <team>/.test(text), 'hire 의 첫 인자는 팀이 아니라 상사(parent)다');
    assert.ok(!/query <team/.test(text), 'query 는 부서로 좁힌다');
    assert.match(text, /부장에게만 지시할 수 있습니다/);
    assert.match(text, /하위 전원|하위 트리 전원/); // fire·dept delete 의 파급을 밝힌다
    assert.match(text, /ask_parent/); // pending/answer 가 상사에게 간 질문을 설명한다
  });

  test('helpLines: 절 제목 + 사용법/설명 두 칸, 절 사이 빈 줄', () => {
    const lines = helpLines();
    assert.equal(lines[0], '  ── 부서·트리 (사용자가 만드는 것은 부서뿐 — D-32) ──');
    assert.match(lines[1]!, /^ {2}dept create .*\s{2,}부서 생성/);
    assert.ok(lines.includes(''), '절 사이에 빈 줄');
    assert.notEqual(lines.at(-1), ''); // 마지막 빈 줄은 없앤다
  });
});

describe('treeLines (T34 출력, T38 에서 format.ts 로 이동)', () => {
  test('부서 → 부장 → 팀/팀장 → 팀원, 파생 상태와 정원', () => {
    const nodes: TreeNode[] = [
      {
        department: DEPT,
        head: member('mH', '부장', 'head', 'waiting_reports'),
        teams: [{ team: TEAM, lead: member('mL', '반장', 'lead', 'free'), members: [member('m1', '이음', 'member', 'working')] }],
        orphans: [],
      },
    ];
    assert.deepEqual(treeLines(nodes), [
      'alpha (d_1)  D:\\x',
      '  └ 부장 부장 [claude] waiting_reports (mH)',
      '     ├ 팀 t1 (t1)  정원 2/4',
      '     │  └ 팀장 반장 [claude] free (mL)',
      '     │     └ 팀원 이음 [claude] working (m1)',
    ]);
  });

  test('팀이 없으면 "(팀 없음)", 부모 없는 멤버는 경고 줄', () => {
    const nodes: TreeNode[] = [
      { department: DEPT, head: undefined, teams: [], orphans: [member('m9', '떠돌이', 'member', 'free')] },
    ];
    assert.deepEqual(treeLines(nodes), [
      'alpha (d_1)  D:\\x',
      '  └ 부장 (없음)',
      '     ├ (팀 없음)',
      '     ! 팀 없는 멤버: 팀원 떠돌이 [claude] free (m9)',
    ]);
  });
});
