// T43-1 콘솔 `usage` 출력 포맷. 순수 함수(format.ts)만 본다 — index.ts 는 import 하면 main() 이 돈다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatEngineUsage, formatMemberUsage, formatTokens, usageLines } from '../../src/cli/format.js';
import { helpCommands } from '../../src/cli/help.js';
import type { EngineUsage, MemberUsage } from '../../src/usage/types.js';

const nameOf = (id: string): string => ({ m_head: '국장', m_lead: '반장' })[id] ?? id;

const CLAUDE: EngineUsage = {
  engine: 'claude',
  connected: true,
  plan: 'max',
  weekly: { usedPercent: 54, resetsAt: '2026-09-23T03:00:00.000Z' },
  session: { usedPercent: 17, resetsAt: '2026-09-21T12:00:00.000Z' },
  updatedAt: '2026-09-21T10:00:00.000Z',
  reason: null,
};
const CODEX_OFF: EngineUsage = {
  engine: 'codex',
  connected: false,
  plan: null,
  weekly: null,
  session: null,
  updatedAt: null,
  reason: 'not-installed',
};
const HEAD: MemberUsage = {
  memberId: 'm_head',
  engine: 'claude',
  context: { used: 43910, window: 1_000_000, percent: 4 },
  tokens: { input: 912, output: 17, cacheRead: 29413, cacheCreate: 14495, total: 44837 },
  costUsd: 0.16072150000000002,
  updatedAt: '2026-09-21T10:00:00.000Z',
};
const LEAD: MemberUsage = {
  memberId: 'm_lead',
  engine: 'codex',
  context: { used: 21868, window: 258400, percent: 8 },
  tokens: { input: 43716, output: 10, cacheRead: 21632, cacheCreate: 0, total: 43726 },
  costUsd: null,
  updatedAt: '2026-09-21T10:01:00.000Z',
};

describe('formatTokens', () => {
  test('358k · 1.2M · 작은 수는 그대로 · 모르면 -', () => {
    assert.equal(formatTokens(358_600), '359k');
    assert.equal(formatTokens(1_234_567), '1.2M');
    assert.equal(formatTokens(912), '912');
    assert.equal(formatTokens(0), '0');
    assert.equal(formatTokens(null), '-');
    assert.equal(formatTokens(undefined), '-');
  });
});

describe('formatEngineUsage', () => {
  test('연결됨: 요금제 + "남음" 표기 + 리셋·측정 시각', () => {
    const line = formatEngineUsage(CLAUDE);
    assert.match(line, /^claude\s+연결됨\(max\)/);
    assert.ok(line.includes('주간 46% 남음'), line); // 100 - 54
    assert.ok(line.includes('5시간 83% 남음'), line); // 100 - 17
    assert.ok(line.includes('리셋 2026-09-23T03:00:00.000Z'), line);
    assert.ok(line.includes('측정 2026-09-21T10:00:00.000Z'), line);
  });

  test('연결 안 됨: 이유를 한국어로, 한도 칸은 아예 없다', () => {
    const line = formatEngineUsage(CODEX_OFF);
    assert.match(line, /^codex\s+연결 안 됨\(설치 안 됨\)$/);
    assert.equal(formatEngineUsage({ ...CODEX_OFF, reason: 'logged-out' }).includes('로그인 필요'), true);
    assert.equal(formatEngineUsage({ ...CODEX_OFF, reason: 'unknown' }).includes('확인 안 됨'), true);
  });

  test('연결은 됐는데 한도를 한 번도 못 봤으면 "첫 작업 후 표시"', () => {
    const line = formatEngineUsage({ ...CLAUDE, weekly: null, session: null, updatedAt: null });
    assert.ok(line.includes('첫 작업 후 표시'), line);
  });

  test('5시간 한도가 없는 요금제(Codex Pro)는 `5시간 -`', () => {
    const line = formatEngineUsage({ ...CLAUDE, engine: 'codex', plan: 'pro', session: null });
    assert.ok(line.includes('5시간 -'), line);
  });
});

describe('formatMemberUsage', () => {
  test('Claude: 컨텍스트 · 토큰 · 비용', () => {
    const line = formatMemberUsage(HEAD, nameOf);
    assert.ok(line.startsWith('국장 [claude]'), line);
    assert.ok(line.includes('컨텍스트 4% (44k/1.0M)'), line);
    assert.ok(line.includes('토큰 45k'), line);
    assert.ok(line.includes('$0.1607'), line);
  });

  test('Codex: 비용 자리는 `-`', () => {
    const line = formatMemberUsage(LEAD, nameOf);
    assert.ok(line.startsWith('반장 [codex]'), line);
    assert.ok(line.includes('컨텍스트 8% (22k/258k)'), line);
    assert.ok(line.endsWith('-  2026-09-21T10:01:00.000Z'), line);
  });

  test('값이 아직 없으면 `컨텍스트 -` · `토큰 -`', () => {
    const line = formatMemberUsage({ ...HEAD, context: null, tokens: null, costUsd: null }, nameOf);
    assert.ok(line.includes('컨텍스트 -'), line);
    assert.ok(line.includes('토큰 -'), line);
  });
});

describe('usageLines', () => {
  test('엔진 먼저, 멤버는 컨텍스트 큰 순으로 들여쓰기', () => {
    const lines = usageLines({ engines: [CLAUDE, CODEX_OFF], members: [HEAD, LEAD] }, nameOf);
    assert.equal(lines.length, 4);
    assert.match(lines[0]!, /^claude/);
    assert.match(lines[1]!, /^codex/);
    assert.ok(lines[2]!.startsWith('  반장'), lines[2]); // 8% > 4%
    assert.ok(lines[3]!.startsWith('  국장'), lines[3]);
  });

  test('멤버 사용량이 없으면 "첫 턴 뒤" 안내 한 줄', () => {
    const lines = usageLines({ engines: [CLAUDE], members: [] }, nameOf);
    assert.equal(lines.length, 2);
    assert.ok(lines[1]!.includes('첫 턴 뒤'), lines[1]);
  });

  test('옛 데몬이라 usage 가 아예 없으면 안내 한 줄', () => {
    assert.deepEqual(usageLines(undefined, nameOf), ['(사용량 정보 없음 — 스냅샷에 usage 가 없습니다)']);
  });

  test('help 에 usage 명령이 실려 있다', () => {
    assert.ok(helpCommands().includes('usage'), helpCommands().join(','));
  });
});
