// 콘솔 명령 파싱·멤버 해석·ANSI 제거 테스트 (순수 함수).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CliError,
  parseAnswerArgs,
  parseArgv,
  parseLine,
  resolveMember,
  resolvePendingId,
  resolveTeam,
  tokenize,
  isEscapeOnly,
  typedPayload,
  unescapeTyped,
} from '../../src/cli/parse.js';
import { detailSummary, formatEvent, pendingSummary, questionsOf, stripAnsi } from '../../src/cli/format.js';
import type { Member, OfficeEvent, Team } from '../../src/store/types.js';

function member(over: Partial<Member> & Pick<Member, 'id' | 'name'>): Member {
  return {
    departmentId: 'd1',
    teamId: 't1',
    parentId: null,
    rank: 'member',
    engine: 'claude',
    sessionId: null,
    childPid: null,
    cwd: 'D:\\x',
    status: 'idle',
    hiredBy: 'user',
    memberToken: 'tok',
    instructionsPath: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

describe('tokenize / parseLine', () => {
  test('공백 분리, 따옴표, 이스케이프', () => {
    assert.deepEqual(tokenize('hire t1 claude 하루').tokens, ['hire', 't1', 'claude', '하루']);
    assert.deepEqual(tokenize('team create "my team" "D:\\a b" codex').tokens, ['team', 'create', 'my team', 'D:\\a b', 'codex']);
    assert.deepEqual(tokenize(`say m1 'it\\'s "x"'`).tokens, ['say', 'm1', 'it\'s "x"']);
    assert.deepEqual(tokenize('   ').tokens, []);
  });

  test('rawAfter 는 i 번째 토큰 뒤 원문(앞 공백만 제거)', () => {
    const p = parseLine('say 하루   안녕  "세상"  ');
    assert.equal(p.cmd, 'say');
    assert.deepEqual(p.args, ['하루', '안녕', '세상']);
    assert.equal(p.rawAfter(1), '안녕  "세상"  ');
    assert.equal(p.rawAfter(0), '하루   안녕  "세상"  ');
    assert.equal(p.rawAfter(5), '');
    assert.equal(parseLine('').cmd, '');
  });
});

describe('resolveMember', () => {
  const members = [
    member({ id: 'abc123', name: '하루' }),
    member({ id: 'abd999', name: '하늘' }),
    member({ id: 'zzz000', name: '민수', status: 'exited' }),
    member({ id: 'zzz111', name: '민수' }),
  ];

  test('id 정확 → 이름 정확 → id 접두 → 이름 접두', () => {
    assert.equal(resolveMember(members, 'abc123').id, 'abc123');
    assert.equal(resolveMember(members, '하늘').id, 'abd999');
    assert.equal(resolveMember(members, 'abd').id, 'abd999');
    assert.equal(resolveMember(members, '하루').id, 'abc123');
    assert.equal(resolveMember(members, '하늘').id, 'abd999');
  });

  test('모호하면 에러, 단 살아있는 멤버가 하나면 그것', () => {
    assert.throws(() => resolveMember(members, 'ab'), /모호/);
    assert.throws(() => resolveMember(members, '하'), /모호/);
    assert.equal(resolveMember(members, '민수').id, 'zzz111'); // exited 제외
    assert.equal(resolveMember(members, 'zzz').id, 'zzz111');
    assert.throws(() => resolveMember(members, '없음'), /찾을 수 없/);
    assert.throws(() => resolveMember(members, ''), CliError);
  });

  test('resolveTeam / resolvePendingId 접두', () => {
    const teams: Team[] = [
      { id: 't1', departmentId: 'd1', name: 'alpha', cwd: '', leaderId: null, maxMembers: 4, allowedEngines: ['claude'], createdAt: '' },
      { id: 't2', departmentId: 'd1', name: 'beta', cwd: '', leaderId: null, maxMembers: 4, allowedEngines: ['claude'], createdAt: '' },
    ];
    assert.equal(resolveTeam(teams, 'beta').id, 't2');
    assert.equal(resolveTeam(teams, 'al').id, 't1');
    assert.throws(() => resolveTeam(teams, 't'), /모호/);
    assert.equal(resolvePendingId(['a_111', 'q_222'], 'q_'), 'q_222');
    assert.equal(resolvePendingId(['a_111', 'a_112'], 'a_111'), 'a_111');
    assert.throws(() => resolvePendingId(['a_111', 'a_112'], 'a_11'), /모호/);
    assert.throws(() => resolvePendingId([], 'x'), /찾을 수 없/);
  });
});

describe('answer / type / argv', () => {
  test('parseAnswerArgs', () => {
    assert.deepEqual(parseAnswerArgs(['색=파랑', '크기=L']), { pairs: { 색: '파랑', 크기: 'L' } });
    assert.deepEqual(parseAnswerArgs(['파랑']), { single: '파랑' });
    assert.deepEqual(parseAnswerArgs(['a=b=c']), { pairs: { a: 'b=c' } });
    assert.throws(() => parseAnswerArgs([]), CliError);
    assert.throws(() => parseAnswerArgs(['a', 'b']), CliError);
    assert.throws(() => parseAnswerArgs(['=b']), CliError);
  });

  test('unescapeTyped / typedPayload — 끝이 \\n/\\r 이 아니면 Enter 추가', () => {
    assert.equal(unescapeTyped('a\\tb\\e[A\\x41\\u0042\\\\'), 'a\tb\x1b[AAB\\');
    assert.equal(typedPayload('hello'), 'hello\r');
    assert.equal(typedPayload('hello\\n'), 'hello\n');
    assert.equal(typedPayload('hello\\r'), 'hello\r');
    assert.equal(typedPayload(''), '\r'); // 빈 입력 = Enter 한 번
    assert.equal(typedPayload('hello\\e'), 'hello\x1b\r'); // 글자가 섞여 있으면 그대로 Enter
  });

  test('T19b: 이스케이프·제어문자만이면 Enter 를 붙이지 않는다 (ESC 가 Alt+Enter 로 나가던 버그)', () => {
    assert.equal(typedPayload('\\e'), '\x1b'); // 예전: '\x1b\r' = Alt+Enter → 다이얼로그가 안 닫혔다
    assert.equal(typedPayload('\\e\\e'), '\x1b\x1b');
    assert.equal(typedPayload('\\e[A'), '\x1b[A'); // 커서 위
    assert.equal(typedPayload('\\x03'), '\x03'); // Ctrl+C
    assert.equal(typedPayload('\\x1b[B'), '\x1b[B');
    assert.equal(isEscapeOnly('\x1b'), true);
    assert.equal(isEscapeOnly('\x1b[A'), true);
    assert.equal(isEscapeOnly(''), false);
    assert.equal(isEscapeOnly('\t'), false); // 탭·개행은 "글자" 로 본다
    assert.equal(isEscapeOnly('a\x1b'), false);
  });

  test('parseArgv', () => {
    const a = parseArgv(['--exec', 'hire t1 claude 하루', '-e', 'say 하루 안녕', '--wait-idle', '하루', '--timeout', '5000']);
    assert.deepEqual(a, { exec: ['hire t1 claude 하루', 'say 하루 안녕'], waitIdle: '하루', timeoutMs: 5000, help: false });
    assert.equal(parseArgv([]).exec.length, 0);
    assert.equal(parseArgv(['--url', 'ws://x:1', '--token', 't']).url, 'ws://x:1');
    assert.throws(() => parseArgv(['--exec']), CliError);
    assert.throws(() => parseArgv(['--bogus']), CliError);
  });
});

describe('format', () => {
  test('stripAnsi: CSI/OSC/charset/private mode 제거, 개행·탭 유지', () => {
    assert.equal(stripAnsi('\x1b[1;32m✔\x1b[0m ok\n\x1b[?25l\x1b[2K\tx\r\n'), '✔ ok\n\tx\r\n');
    assert.equal(stripAnsi('\x1b]0;title\x07body\x1b(B\x1b[38;2;10;20;30mcolor\x1b[m'), 'bodycolor');
    assert.equal(stripAnsi('\x1b=\x1b>\x07plain\x08'), 'plain');
    assert.equal(stripAnsi('no escapes 한글'), 'no escapes 한글');
  });

  test('detailSummary / formatEvent', () => {
    assert.equal(detailSummary({ tool: 'Bash', cmd: 'npm test' }), 'Bash npm test');
    assert.equal(detailSummary({ tool: 'Read', path: 'a.ts', summary: 'reading' }), 'Read a.ts — reading');
    assert.equal(detailSummary({ text: 'line1\nline2' }), 'line1 ⏎ line2');
    assert.equal(detailSummary({ foo: 1 }), '{"foo":1}');
    assert.equal(detailSummary({}), '');
    assert.equal(detailSummary({ summary: 'x'.repeat(200) }).length, 100);
    const ev: OfficeEvent = {
      seq: 812,
      ts: '',
      departmentId: 'd1',
      teamId: 't1',
      memberId: 'm3',
      kind: 'waiting_approval',
      detail: { tool: 'Bash', cmd: 'rm -rf x' },
      ref: { approvalId: 'a_9', questionId: null, taskId: 7 },
    };
    assert.equal(formatEvent(ev, (id) => (id === 'm3' ? '하루' : id)), '#812 waiting_approval 하루 Bash rm -rf x  approval=a_9 task#7');
  });

  test('pendingSummary / questionsOf', () => {
    assert.equal(pendingSummary('approval', { tool_name: 'Bash', tool_input: { command: 'ls' } }), 'Bash ls');
    assert.equal(pendingSummary('approval', { tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }), 'Edit a.ts');
    const payload = {
      questions: [
        { question: '색?', options: [{ label: '파랑' }, { label: '빨강' }] },
        { question: '크기?', options: ['S', 'L'] },
      ],
    };
    assert.deepEqual(questionsOf(payload), [
      { question: '색?', options: ['파랑', '빨강'] },
      { question: '크기?', options: ['S', 'L'] },
    ]);
    assert.equal(pendingSummary('question', payload), '색? [파랑|빨강] / 크기? [S|L]');
    assert.deepEqual(questionsOf(undefined), []);
  });

  test('T19b: questionsOf 가 TeamTools ask_user payload {source, question, options} 도 읽는다', () => {
    const askUser = { source: 'ask_user', question: '점심은?', options: ['김밥', '라면'] };
    assert.deepEqual(questionsOf(askUser), [{ question: '점심은?', options: ['김밥', '라면'] }]);
    // `pending` 출력이 더 이상 "(질문 내용 없음)" 이 아니고, 질문이 하나라 `answer <id> <label>` 이 먹는다.
    assert.equal(pendingSummary('question', askUser), '점심은? [김밥|라면]');
    assert.equal(questionsOf(askUser).length, 1);
    // 옵션 없는 자유 질문도 하나로.
    assert.deepEqual(questionsOf({ source: 'ask_user', question: '어디로?' }), [{ question: '어디로?', options: [] }]);
    // 질문 본문을 모르면 여전히 빈 배열(= answer 가 question=label 형식을 요구).
    assert.deepEqual(questionsOf({ source: 'ask_user' }), []);
    assert.deepEqual(questionsOf({ fromEvent: true }), []);
    assert.equal(pendingSummary('question', { fromEvent: true }), '(질문 내용 없음)');
  });
});
