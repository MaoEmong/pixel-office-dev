// 화면에 사람이 읽으라고 찍힌 리셋 표기 → ISO 8601(UTC). **순수 함수** — 파일도 시계도 건드리지 않는다.
//
// 실측 표기(T43-0 Q3·Q7, 원자료 `dev/spike-1/out/`):
//
//   Claude `/usage`   `9pm (Asia/Seoul)` · `Sep 23, 12pm (Asia/Seoul)` · `Sep 23, 11:59am (Asia/Seoul)`
//   Codex  `/status`  `14:02 on 28 Sep`                     (타임존 없음 = 로컬 시각)
//
// **연도가 없다.** T43-0 은 "화면의 사람 표기를 파싱해 날짜로 되돌리지 마라 — 연말에 깨진다" 고 경고했다.
// 그래서 연도를 **추측하지 않고 고른다**: 작년·올해·내년 셋 중 `now` 에 **가장 가까운** 것이 답이다
// (한도 창은 길어야 7일이므로 후보 사이가 1년 벌어져 헷갈릴 일이 없다 — 12월 28일에 본 `Jan 2` 는 내년,
// 1월 2일에 본 `Dec 28` 은 작년이 된다).
// 날짜가 아예 없으면(5시간 한도의 `9pm`) **그 타임존의 오늘**, 이미 지났으면 내일로 본다.
//
// 모양이 하나도 안 맞으면 **null** 이다 — 호출자는 퍼센트만 살리고 `resetsAt:null` 로 둔다(값을 통째로 버리지 않는다).

/** 두 글자 이상 앞만 보면 되는 월 이름(`Sept` 같은 변형도 앞 세 글자로 걸린다). */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;

/** 끝에 붙는 타임존 괄호 — `(Asia/Seoul)` · `(UTC)`. */
const TZ_RE = /\(\s*([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT)\s*\)\s*$/;

/** `12pm` · `11:59am` · `9 pm`. */
const AMPM_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
/** `14:02`. */
const HHMM_RE = /\b(\d{1,2}):(\d{2})\b/;
/** `Sep 23` · `Sept. 23`. */
const MON_DAY_RE = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})\b/;
/** `28 Sep`. */
const DAY_MON_RE = /\b(\d{1,2})\s+([A-Za-z]{3,9})\b/;

/** 연도 후보(작년·올해·내년). 가장 가까운 것을 고른다. */
const YEAR_CANDIDATES = [0, 1, -1] as const;

interface Wall {
  year: number;
  /** 1~12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * 리셋 표기 한 줄 → ISO(UTC) 문자열. 못 읽으면 null.
 *
 * @param text  `Resets ` 뒤의 문자열(`Sep 23, 12pm (Asia/Seoul)` 등). 괄호 안 타임존은 여기서 뗀다.
 * @param now   기준 시각(epoch ms) — 연도·오늘/내일 판정에 쓴다.
 */
export function parseResetText(text: unknown, now: number): string | null {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  if (!s) return null;

  const tzMatch = TZ_RE.exec(s);
  const tz = tzMatch ? normalizeZone(tzMatch[1]!) : undefined;
  if (tzMatch) s = s.slice(0, tzMatch.index).trim();
  // `Sep 24 at 9am` 의 `at`, `14:02 on 28 Sep` 의 `on` 은 자리표지일 뿐이다 — 아래 정규식들이 알아서 건너뛴다.

  const time = readTime(s);
  const date = readDate(s);
  if (!time && !date) return null;

  const hour = time?.hour ?? 0;
  const minute = time?.minute ?? 0;

  if (!date) {
    // 날짜가 없다 = 오늘 그 시각. 이미 지났으면 내일(5시간 한도의 `Resets 9pm`).
    const today = wallNow(now, tz);
    let ms = wallToUtcMs({ ...today, hour, minute }, tz);
    if (ms <= now) ms = wallToUtcMs(addDays({ ...today, hour, minute }, 1), tz);
    return new Date(ms).toISOString();
  }

  // 연도는 고르는 것이다(화면에 없다). 작년·올해·내년 중 **now 에 가장 가까운** 후보.
  const baseYear = wallNow(now, tz).year;
  let best: number | null = null;
  for (const delta of YEAR_CANDIDATES) {
    const ms = wallToUtcMs({ year: baseYear + delta, month: date.month, day: date.day, hour, minute }, tz);
    if (!Number.isFinite(ms)) continue;
    if (best === null || Math.abs(ms - now) < Math.abs(best - now)) best = ms;
  }
  return best === null ? null : new Date(best).toISOString();
}

function readTime(s: string): { hour: number; minute: number } | undefined {
  const ap = AMPM_RE.exec(s);
  if (ap) {
    let hour = Number(ap[1]);
    const minute = ap[2] ? Number(ap[2]) : 0;
    const pm = ap[3]!.toLowerCase() === 'pm';
    if (hour === 12) hour = 0;
    if (pm) hour += 12;
    if (hour > 23 || minute > 59) return undefined;
    return { hour, minute };
  }
  const hm = HHMM_RE.exec(s);
  if (!hm) return undefined;
  const hour = Number(hm[1]);
  const minute = Number(hm[2]);
  if (hour > 23 || minute > 59) return undefined;
  return { hour, minute };
}

function readDate(s: string): { month: number; day: number } | undefined {
  const md = MON_DAY_RE.exec(s);
  if (md) {
    const month = monthIndex(md[1]!);
    const day = Number(md[2]);
    if (month && day >= 1 && day <= 31) return { month, day };
  }
  const dm = DAY_MON_RE.exec(s);
  if (dm) {
    const month = monthIndex(dm[2]!);
    const day = Number(dm[1]);
    if (month && day >= 1 && day <= 31) return { month, day };
  }
  return undefined;
}

/** 월 이름 → 1~12. 모르는 낱말(`at`·`on`)이면 0. */
function monthIndex(word: string): number {
  const w = word.slice(0, 3).toLowerCase();
  const i = MONTHS.indexOf(w as (typeof MONTHS)[number]);
  return i < 0 ? 0 : i + 1;
}

/** `GMT` 는 Intl 이 아는 이름으로 바꾼다. 나머지는 그대로(모르는 이름이면 아래에서 로컬로 떨어진다). */
function normalizeZone(z: string): string {
  return z.toUpperCase() === 'GMT' ? 'UTC' : z;
}

function addDays(w: Wall, days: number): Wall {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: w.hour, minute: w.minute };
}

/** `now` 를 그 타임존에서 본 벽시계(시·분은 0). tz 가 없거나 모르는 이름이면 데몬 로컬. */
function wallNow(now: number, tz?: string): Wall {
  const parts = zoneParts(now, tz);
  return { ...parts, hour: 0, minute: 0 };
}

/**
 * 그 타임존의 벽시계 → epoch ms. Intl 로 오프셋을 구해 두 번 보정한다(서머타임 경계에서 한 번으로는 틀린다).
 * tz 가 없으면 데몬 로컬(`new Date(y, m, d, …)`).
 */
function wallToUtcMs(w: Wall, tz?: string): number {
  if (!tz) return new Date(w.year, w.month - 1, w.day, w.hour, w.minute, 0, 0).getTime();
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const off1 = zoneOffsetMs(guess, tz);
  let ms = guess - off1;
  const off2 = zoneOffsetMs(ms, tz);
  if (off2 !== off1) ms = guess - off2;
  return ms;
}

/** 그 타임존이 UTC 보다 얼마나 앞서는가(ms). 모르는 이름이면 0(= UTC 취급). */
function zoneOffsetMs(utcMs: number, tz: string): number {
  const p = zoneParts(utcMs, tz, true);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** 그 타임존에서 본 시각의 조각들. `strict` 면 모르는 타임존에 대해 UTC 로 떨어진다. */
function zoneParts(utcMs: number, tz: string | undefined, strict = false): ZoneParts {
  if (tz) {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const out: Record<string, number> = {};
      for (const p of fmt.formatToParts(new Date(utcMs))) if (p.type !== 'literal') out[p.type] = Number(p.value);
      // en-US + hour12:false 는 자정을 '24' 로 줄 때가 있다.
      const hour = out.hour === 24 ? 0 : (out.hour ?? 0);
      return { year: out.year ?? 1970, month: out.month ?? 1, day: out.day ?? 1, hour, minute: out.minute ?? 0, second: out.second ?? 0 };
    } catch {
      // 모르는 타임존 이름 — UTC(strict) 또는 로컬로 떨어진다.
    }
    if (strict) {
      const d = new Date(utcMs);
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
    }
  }
  const d = new Date(utcMs);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() };
}
