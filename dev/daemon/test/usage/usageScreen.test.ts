// T43-4 — 확인용 세션이 읽는 **화면 파서**. 픽스처는 T43-0 스파이크의 실측 캡처를 가공 없이 옮긴 것이다
// (`test/fixtures/usage/screens/` ← `dev/spike-1/out/`). 패턴은 코드가 아니라 tui-map JSON 에 있으므로
// 여기서는 **내장 맵 그대로** 실제 화면에 대어 본다 — 맵을 고치면 이 테스트가 먼저 깨진다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_FILES, compileTuiMap, loadTuiMap, type TuiUsage } from '../../src/screen/tuiMap.js';
import { countPanels, panelReady, parseUsageScreen } from '../../src/usage/parse/usageScreen.js';
import { parseResetText } from '../../src/usage/parse/resetText.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const screens = path.resolve(here, '../fixtures/usage/screens');
const read = (f: string): string => fs.readFileSync(path.join(screens, f), 'utf8');

const claudeUsage = (): TuiUsage => {
  const u = loadTuiMap('claude').usage;
  assert.ok(u, 'claude tui-map 에 usage 절이 있어야 한다');
  return u;
};
/**
 * 픽스처는 **찍힌 그 버전의 맵**으로 읽는다(T49). 내장 맵을 그냥 쓰면 이 PC 에 깔린 CLI 버전에 따라
 * 고르는 맵이 달라져 테스트가 흔들리고, 0.159 에서 `Account:` 줄 모양이 바뀌었으므로 실제로 갈린다.
 */
const usageFromFile = (file: string): TuiUsage => {
  const json = BUILTIN_FILES[file];
  assert.ok(json, `${file} 이 내장 표에 없다`);
  const u = compileTuiMap(json).usage;
  assert.ok(u, `${file} 에 usage 절이 있어야 한다`);
  return u;
};
const codexUsage = (): TuiUsage => usageFromFile('codex-0.154.json');
const codexUsage0159 = (): TuiUsage => usageFromFile('codex-0.159.json');

/** 2026-09-21 07:20 KST = 리셋 표기(`Sep 23`·`28 Sep`)의 기준 시각. */
const NOW = Date.parse('2026-09-20T22:20:00.000Z');

describe('parseUsageScreen — Claude /usage (실측 화면)', () => {
  test('턴 1회 뒤 화면: 5시간 · 주간 전체 · 모델별 블록 셋을 다 읽는다', () => {
    const got = parseUsageScreen(read('claude-screen-05-usage.txt'), claudeUsage(), NOW);
    assert.equal(got.ok, true);
    assert.equal(got.session?.usedPercent, 17);
    assert.equal(got.weekly?.usedPercent, 55);
    assert.deepEqual(
      got.models.map((m) => [m.label, m.usedPercent]),
      [['Fable', 55]],
      '괄호 안 문자열을 그대로 라벨로 쓴다 — 실측값은 모델 이름이 아니라 "Fable" 이었다',
    );
  });

  test('모델 라벨을 하드코딩하지 않는다 — 모르는 이름도 그대로 실린다', () => {
    const text = read('claude-screen-05-usage.txt').replace('Current week (Fable)', 'Current week (Nebula 9 preview)');
    const got = parseUsageScreen(text, claudeUsage(), NOW);
    assert.deepEqual(got.models.map((m) => m.label), ['Nebula 9 preview']);
    assert.equal(got.weekly?.usedPercent, 55, '주간 전체 블록은 그대로다');
  });

  test('리셋 표기는 ISO(UTC)로 바뀐다 — Asia/Seoul 은 UTC+9', () => {
    const got = parseUsageScreen(read('claude-screen-05-usage.txt'), claudeUsage(), NOW);
    // "Resets Sep 23, 12pm (Asia/Seoul)" = 2026-09-23 12:00 KST = 03:00Z
    assert.equal(got.weekly?.resetsAt, '2026-09-23T03:00:00.000Z');
    // "Resets 9pm (Asia/Seoul)" — 날짜가 없다 → 그 타임존의 오늘 21시(= 12:00Z)
    assert.equal(got.session?.resetsAt, '2026-09-21T12:00:00.000Z');
    // 모델 블록은 11:59am → 02:59Z
    assert.equal(got.models[0]?.resetsAt, '2026-09-23T02:59:00.000Z');
  });

  test('턴 0회 화면(토큰 0 · 비용 $0)에서도 한도는 나온다 — 확인용 세션의 존재 이유', () => {
    const got = parseUsageScreen(read('claude-full-usage-fresh.txt'), claudeUsage(), NOW);
    assert.equal(got.ok, true);
    assert.equal(got.session?.usedPercent, 20, '세션 한도는 턴 1회 뒤 캡처(17%)와 다른 값이다');
    assert.equal(got.weekly?.usedPercent, 55);
    assert.deepEqual(got.models.map((m) => m.label), ['Fable']);
  });

  test('모델별 블록이 없는 화면이면 models 는 빈 배열(null 이 아니다)', () => {
    const text = read('claude-full-usage-fresh.txt').replace(/\n\s*Current week \(Fable\)[\s\S]*?Resets [^\n]*\n/, '\n');
    const got = parseUsageScreen(text, claudeUsage(), NOW);
    assert.equal(got.weekly?.usedPercent, 55);
    assert.deepEqual(got.models, []);
  });

  test('리셋 문자열을 못 읽어도 퍼센트는 살린다', () => {
    const text = read('claude-screen-05-usage.txt').replace('Resets Sep 23, 12pm (Asia/Seoul)', 'Resets 알 수 없음');
    const got = parseUsageScreen(text, claudeUsage(), NOW);
    assert.equal(got.weekly?.usedPercent, 55);
    assert.equal(got.weekly?.resetsAt, null);
  });

  test('전혀 다른 화면이면 ok:false — 아무 값도 쓰지 않는다', () => {
    const got = parseUsageScreen('여기는 그냥 프롬프트입니다\n? for shortcuts\n', claudeUsage(), NOW);
    assert.deepEqual(got, { weekly: null, session: null, models: [], plan: null, ok: false });
  });

  test('panelReady / countPanels: 패널이 뜨기 전에는 0', () => {
    const u = claudeUsage();
    assert.equal(panelReady('아무것도 없음', u), false);
    assert.equal(countPanels('아무것도 없음', u), 0);
    const text = read('claude-screen-05-usage.txt');
    assert.equal(panelReady(text, u), true);
    assert.equal(countPanels(text, u), 1);
  });
});

describe('parseUsageScreen — Codex /status (실측 화면)', () => {
  test('`% left` 를 뒤집어 usedPercent 로 넣는다(D-45 ③)', () => {
    const got = parseUsageScreen(read('codex-full-03-status-after-turn.txt'), codexUsage(), NOW);
    assert.equal(got.ok, true);
    assert.equal(got.weekly?.usedPercent, 12, '화면은 88% left');
    assert.equal(got.session, null, 'Pro 계정에는 5h limit 줄이 없다 — null 이 정상');
    // 파서는 화면에 쓰인 대로 돌려준다. 소문자화(rollout 의 "pro" 와 맞추기)는 UsageTracker 가 한다.
    assert.equal(got.plan, 'Pro');
  });

  test('리셋 `14:02 on 28 Sep` → ISO(로컬 시각 기준)', () => {
    const got = parseUsageScreen(read('codex-full-03-status-after-turn.txt'), codexUsage(), NOW);
    const expected = new Date(2026, 8, 28, 14, 2, 0, 0).toISOString(); // 타임존이 없으므로 데몬 로컬
    assert.equal(got.weekly?.resetsAt, expected);
  });

  test('요금제만 읽는다 — 같은 줄의 계정 이메일은 결과 어디에도 없다(D-45 ②)', () => {
    const text = read('codex-full-03-status-after-turn.txt').replace('<이메일>', 'someone@example.com');
    const got = parseUsageScreen(text, codexUsage(), NOW);
    assert.equal(got.plan, 'Pro');
    assert.ok(!JSON.stringify(got).includes('@'), JSON.stringify(got));
  });

  test('턴 0회 화면(Context window 줄이 없다)에서도 주간 한도는 나온다', () => {
    const got = parseUsageScreen(read('codex-full-05-status-fresh.txt'), codexUsage(), NOW);
    assert.equal(got.weekly?.usedPercent, 12);
  });

  test('스크롤백에 옛 패널이 남아 있으면 **뒤의 것**이 이긴다', () => {
    const older = read('codex-full-05-status-fresh.txt');
    const newer = read('codex-full-03-status-after-turn.txt').replace('88% left', '70% left');
    const got = parseUsageScreen(`${older}\n${newer}`, codexUsage(), NOW);
    assert.equal(got.weekly?.usedPercent, 30, '뒤(70% left)가 이긴다');
    assert.equal(countPanels(`${older}\n${newer}`, codexUsage()), 2, '패널 등장 횟수로 새 판을 구별한다');
  });

  test('`5h limit` 줄이 있는 요금제(미검증 패턴)도 같은 모양이면 읽힌다', () => {
    const text = read('codex-full-03-status-after-turn.txt').replace(
      '│  Weekly limit:',
      '│  5h limit:            [████░░░░░░░░░░░░░░░░] 95% left (resets 21:00 on 21 Sep) │\n│  Weekly limit:',
    );
    const got = parseUsageScreen(text, codexUsage(), NOW);
    assert.equal(got.session?.usedPercent, 5);
    assert.equal(got.weekly?.usedPercent, 12);
  });

  test('Codex 는 모델별 한도가 없다 — 언제나 빈 배열', () => {
    assert.deepEqual(parseUsageScreen(read('codex-full-03-status-after-turn.txt'), codexUsage(), NOW).models, []);
  });
});

// T49 — 0.159 의 /status 는 괘선이 없어지고 `Account:` 줄이 `<이메일> (Pro)` → `Pro (More)` 로 바뀌었다(D-49 ④).
describe('parseUsageScreen — Codex 0.159 /status (실측 화면)', () => {
  /** 2026-09-29 기준(픽스처의 `resets 9:13 PM on 5 Oct` 을 읽는 기준 시각). */
  const NOW_0159 = Date.parse('2026-09-29T12:49:00.000Z');
  const screen = () => read('codex-0.159-status.txt');

  test('주간 한도를 읽는다 — 괘선(│)이 없어도 같다', () => {
    const got = parseUsageScreen(screen(), codexUsage0159(), NOW_0159);
    assert.equal(got.ok, true);
    assert.equal(got.weekly?.usedPercent, 45, '화면은 55% left');
    assert.equal(got.session, null, 'Pro 계정에는 5h limit 줄이 없다');
  });

  test('요금제는 `Account: Pro (More)` 에서 "Pro" 다 — "More" 를 집지 않는다', () => {
    assert.equal(parseUsageScreen(screen(), codexUsage0159(), NOW_0159).plan, 'Pro');
  });

  test('0.154 맵으로 0.159 화면을 읽으면 요금제가 "More" 로 잘못 잡힌다 — 맵을 버전별로 두는 이유', () => {
    assert.equal(parseUsageScreen(screen(), codexUsage(), NOW_0159).plan, 'More');
  });

  test('요금제 줄에 이메일이 돌아오더라도 그것을 요금제로 쓰지 않는다(D-45 ②)', () => {
    const text = screen().replace('Account:             Pro (More)', 'Account:             someone@example.com (Pro)');
    const got = parseUsageScreen(text, codexUsage0159(), NOW_0159);
    assert.equal(got.plan, null, '모양이 바뀌면 요금제는 비운다 — 이메일을 흘리는 것보다 낫다');
    assert.ok(!JSON.stringify(got).includes('@'), JSON.stringify(got));
  });

  test('패널이 떴다고 보는 표지(`Weekly limit:`)는 0.159 에서도 그대로다', () => {
    const u = codexUsage0159();
    assert.equal(panelReady(screen(), u), true);
    assert.equal(countPanels(screen(), u), 1);
  });
});

describe('parseResetText — 화면의 사람 표기 → ISO(UTC)', () => {
  test('시각만 있으면 그 타임존의 오늘, 이미 지났으면 내일', () => {
    const morning = Date.parse('2026-09-21T00:00:00.000Z'); // KST 09:00
    assert.equal(parseResetText('9pm (Asia/Seoul)', morning), '2026-09-21T12:00:00.000Z');
    const evening = Date.parse('2026-09-21T13:00:00.000Z'); // KST 22:00 — 9pm 은 지났다
    assert.equal(parseResetText('9pm (Asia/Seoul)', evening), '2026-09-22T12:00:00.000Z');
  });

  test('`Sep 24 at 9am (Asia/Seoul)` 처럼 at 이 끼어도 읽는다', () => {
    assert.equal(parseResetText('Sep 24 at 9am (Asia/Seoul)', NOW), '2026-09-24T00:00:00.000Z');
  });

  test('연도는 화면에 없다 — 연말에도 깨지지 않게 now 기준으로 고른다', () => {
    const dec = Date.parse('2026-12-28T10:00:00.000Z');
    assert.equal(parseResetText('Jan 2, 9am (UTC)', dec), '2027-01-02T09:00:00.000Z', '12월에 본 1월은 내년');
    const jan = Date.parse('2027-01-02T10:00:00.000Z');
    assert.equal(parseResetText('Dec 28, 9am (UTC)', jan), '2026-12-28T09:00:00.000Z', '1월에 본 12월은 작년');
  });

  test('모르는 모양·빈 값은 null(값을 통째로 버리지 않게 호출자가 퍼센트만 쓴다)', () => {
    assert.equal(parseResetText('알 수 없음', NOW), null);
    assert.equal(parseResetText('', NOW), null);
    assert.equal(parseResetText(undefined, NOW), null);
    assert.equal(parseResetText(42, NOW), null);
  });

  test('모르는 타임존 이름이면 로컬로 떨어지되 죽지 않는다', () => {
    const got = parseResetText('Sep 23, 12pm (Mars/Olympus)', NOW);
    assert.ok(got && !Number.isNaN(Date.parse(got)), String(got));
  });
});
