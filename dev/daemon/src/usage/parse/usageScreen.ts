// 확인용 세션(T43-4)이 읽은 **화면 텍스트** → 엔진 한도. **순수 함수**다 — pty 도 파일도 시계도 없다.
//
// CLI 문구는 여기 한 글자도 없다. 전부 `src/tui-maps/<engine>-<ver>.json` 의 `usage` 절에서 온다
// (버전이 바뀌면 코드가 아니라 맵을 고친다 — tui-maps/README.md).
//
// 규칙:
//   - 화면에서 읽은 퍼센트는 맵의 `percentIs` 에 따라 **`usedPercent`(쓴 비율)로 통일**한다(D-45 ③).
//     Codex 화면은 "남은 %" 로 말하므로 `100 - N`.
//   - 같은 칸을 여러 번 잡으면 **뒤의 것이 이긴다** — Codex 는 스크롤백 전체를 읽어 지난 패널이 같이 잡힌다.
//   - 리셋 문자열은 `resetText.ts` 가 ISO(UTC)로 바꾼다. **못 읽어도 퍼센트는 살린다**(`resetsAt: null`).
//   - 블록이 **하나도** 안 맞으면 `ok:false` — 호출자는 그 판을 버리고 경고 한 번을 낸다(값을 덮어쓰지 않는다).
import type { TuiUsage } from '../../screen/tuiMap.js';
import { parseResetText } from './resetText.js';
import { toPercent, type UsageModel, type UsageWindow } from '../types.js';

export interface UsageScreenResult {
  weekly: UsageWindow | null;
  session: UsageWindow | null;
  /** 모델별 주간 한도(Claude 전용). 없으면 빈 배열. */
  models: UsageModel[];
  /** 요금제(맵에 `plan` 패턴이 있고 맞았을 때만). */
  plan: string | null;
  /** 기대한 패널이 맞았는가. false 면 아무 값도 쓰지 않는다. */
  ok: boolean;
}

const EMPTY: UsageScreenResult = { weekly: null, session: null, models: [], plan: null, ok: false };

/**
 * 패널이 다 그려졌는가 — `ready` 패턴이 **전부** 보이는가.
 * (확인용 세션은 여기에 더해 [countPanels] 가 늘어난 것도 본다.)
 */
export function panelReady(text: string, usage: TuiUsage): boolean {
  return usage.ready.every((r) => matchCount(text, r) > 0);
}

/**
 * 화면에 패널이 몇 번 나오는가(`ready[0]` 기준). 확인용 세션이 명령을 치기 **전후로** 세서
 * 스크롤백에 남은 **지난번** 패널을 새 것으로 착각하지 않게 한다.
 */
export function countPanels(text: string, usage: TuiUsage): number {
  const first = usage.ready[0];
  return first ? matchCount(text, first) : 0;
}

/** 화면 텍스트 → 한도. `now` 는 리셋 표기의 연도·오늘/내일 판정에 쓴다. */
export function parseUsageScreen(text: string, usage: TuiUsage, now: number): UsageScreenResult {
  if (typeof text !== 'string' || text === '') return { ...EMPTY };
  const out: UsageScreenResult = { weekly: null, session: null, models: [], plan: null, ok: false };
  /** 모델 라벨 → 자리(뒤에 온 값이 이기되 처음 본 순서를 지킨다). */
  const models = new Map<string, UsageModel>();

  for (const block of usage.blocks) {
    for (const m of text.matchAll(block.pattern)) {
      const g = m.groups;
      if (!g) continue;
      const win = toWindow(g.percent, g.resets, block.percentIs, now);
      if (!win) continue;
      out.ok = true;
      if (block.target === 'weekly') {
        out.weekly = win;
        continue;
      }
      if (block.target === 'session') {
        out.session = win;
        continue;
      }
      // target: 'auto' — 라벨로 가른다.
      const label = g.label ?? '';
      if (block.sessionLabel?.test(label)) {
        out.session = win;
        continue;
      }
      if (block.weeklyLabel?.test(label)) {
        out.weekly = win;
        continue;
      }
      // 나머지는 모델별. **괄호 안 문자열을 그대로** 라벨로 쓴다(모델 이름을 하드코딩하지 않는다, T43-0 Q3).
      const name = (g.model ?? label).trim();
      if (name) models.set(name, { label: name, usedPercent: win.usedPercent, resetsAt: win.resetsAt });
    }
  }
  out.models = [...models.values()];

  if (usage.plan) {
    const p = usage.plan.exec(text)?.groups?.plan?.trim();
    if (p) out.plan = p;
  }
  return out;
}

/** 퍼센트·리셋 그룹 한 쌍 → 한도 창. 퍼센트가 숫자가 아니면 null(그 매치는 버린다). */
function toWindow(percent: string | undefined, resets: string | undefined, percentIs: 'used' | 'left', now: number): UsageWindow | null {
  if (percent === undefined) return null;
  const n = toPercent(Number(percent));
  if (n === null) return null;
  return { usedPercent: percentIs === 'left' ? 100 - n : n, resetsAt: parseResetText(resets, now) };
}

/** g 플래그 정규식의 매치 수. `matchAll` 은 원본의 lastIndex 를 건드리지 않는다. */
function matchCount(text: string, re: RegExp): number {
  let n = 0;
  for (const _ of text.matchAll(re)) n++;
  return n;
}
