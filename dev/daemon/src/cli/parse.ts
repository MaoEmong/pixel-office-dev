// 콘솔 명령 파싱·인자 해석 (T08). 네트워크·상태 없음 — 순수 함수만 두어 테스트한다.
import type { Department, Member, Team } from '../store/types.js';
import { stripAnsi } from './format.js';

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export interface ParsedLine {
  /** 첫 토큰(명령어). 빈 줄이면 ''. */
  cmd: string;
  /** 명령어 뒤 토큰들(따옴표 처리됨). */
  args: string[];
  /** i 번째 토큰(0 = 명령어) 뒤의 원문. 앞 공백만 제거. */
  rawAfter(i: number): string;
}

/** 공백 분리 + "..."/'...' 따옴표. 따옴표 안의 \" 는 ". */
export function tokenize(line: string): { tokens: string[]; ends: number[] } {
  const tokens: string[] = [];
  const ends: number[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && /\s/.test(line[i]!)) i++;
    if (i >= n) break;
    let tok = '';
    let quote: string | null = null;
    while (i < n) {
      const ch = line[i]!;
      if (quote) {
        if (ch === '\\' && i + 1 < n && (line[i + 1] === quote || line[i + 1] === '\\')) {
          tok += line[i + 1];
          i += 2;
          continue;
        }
        if (ch === quote) {
          quote = null;
          i++;
          continue;
        }
        tok += ch;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        i++;
        continue;
      }
      if (/\s/.test(ch)) break;
      tok += ch;
      i++;
    }
    tokens.push(tok);
    ends.push(i);
  }
  return { tokens, ends };
}

export function parseLine(line: string): ParsedLine {
  const { tokens, ends } = tokenize(line);
  const [cmd = '', ...args] = tokens;
  return {
    cmd,
    args,
    rawAfter(i: number): string {
      const end = ends[i];
      if (end === undefined) return '';
      return line.slice(end).replace(/^\s+/, '');
    },
  };
}

// ---- 인자 해석 --------------------------------------------------------------

export function parseIntArg(v: string | undefined, name: string, fallback?: number): number {
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new CliError(`${name} 이(가) 필요합니다`);
  }
  const num = Number(v);
  if (!Number.isInteger(num) || num < 0) throw new CliError(`${name} 은(는) 0 이상의 정수여야 합니다: ${v}`);
  return num;
}

export function parseEngine(v: string | undefined, fallback: 'claude' | 'codex' = 'claude'): 'claude' | 'codex' {
  if (v === undefined) return fallback;
  if (v === 'claude' || v === 'codex') return v;
  throw new CliError(`엔진은 claude 또는 codex: ${v}`);
}

/**
 * 멤버 참조 해석. 우선순위: id 정확 일치 → 이름 정확 일치 → id 접두 → 이름 접두(대소문자 무시).
 * 후보가 여럿이고 그중 exited/error 가 아닌 것이 정확히 하나면 그것(같은 이름으로 재고용한 경우).
 */
export function resolveMember(members: Iterable<Member>, ref: string): Member {
  const all = [...members];
  if (!ref) throw new CliError('멤버 id 또는 이름이 필요합니다');
  const lower = ref.toLowerCase();
  const tiers: Array<(m: Member) => boolean> = [
    (m) => m.id === ref,
    (m) => m.name === ref,
    (m) => m.id.startsWith(ref),
    (m) => m.name.toLowerCase().startsWith(lower),
  ];
  for (const match of tiers) {
    const hits = all.filter(match);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) {
      const live = hits.filter((m) => m.status !== 'exited' && m.status !== 'error');
      if (live.length === 1) return live[0]!;
      const list = hits.map((m) => `${m.id}(${m.name}, ${m.status})`).join(', ');
      throw new CliError(`멤버 참조가 모호합니다 "${ref}": ${list}`);
    }
  }
  throw new CliError(`멤버를 찾을 수 없습니다: ${ref}`);
}

/** id/이름으로 행 하나를 고른다(정확 일치 → 접두). 팀·부서가 같은 규칙을 쓴다. */
function resolveNamed<T extends { id: string; name: string }>(rows: Iterable<T>, ref: string, what: string): T {
  const all = [...rows];
  if (!ref) throw new CliError(`${what} id 또는 이름이 필요합니다`);
  const lower = ref.toLowerCase();
  const tiers: Array<(t: T) => boolean> = [
    (t) => t.id === ref,
    (t) => t.name === ref,
    (t) => t.id.startsWith(ref),
    (t) => t.name.toLowerCase().startsWith(lower),
  ];
  for (const match of tiers) {
    const hits = all.filter(match);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) {
      throw new CliError(`${what} 참조가 모호합니다 "${ref}": ${hits.map((t) => `${t.id}(${t.name})`).join(', ')}`);
    }
  }
  throw new CliError(`${what}을(를) 찾을 수 없습니다: ${ref}`);
}

export function resolveTeam(teams: Iterable<Team>, ref: string): Team {
  return resolveNamed(teams, ref, '팀');
}

export function resolveDepartment(departments: Iterable<Department>, ref: string): Department {
  return resolveNamed(departments, ref, '부서');
}

/** pending id 는 정확 일치 → 접두. */
export function resolvePendingId(ids: Iterable<string>, ref: string): string {
  const all = [...ids];
  if (!ref) throw new CliError('pending id 가 필요합니다');
  if (all.includes(ref)) return ref;
  const hits = all.filter((id) => id.startsWith(ref));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) throw new CliError(`pending 참조가 모호합니다 "${ref}": ${hits.join(', ')}`);
  throw new CliError(`열린 pending 을 찾을 수 없습니다: ${ref} (pending 으로 목록 확인)`);
}

/**
 * `answer` 인자. 모두 `question=label` 이면 pairs, 하나이고 `=` 가 없으면 single(질문 하나짜리 payload 용).
 */
export function parseAnswerArgs(args: string[]): { pairs: Record<string, string> } | { single: string } {
  if (args.length === 0) throw new CliError('답이 필요합니다: answer <pending> <question>=<label> ... 또는 answer <pending> <label>');
  const withEq = args.filter((a) => a.includes('='));
  if (withEq.length === args.length) {
    const pairs: Record<string, string> = {};
    for (const a of args) {
      const at = a.indexOf('=');
      const q = a.slice(0, at).trim();
      const label = a.slice(at + 1).trim();
      if (!q || !label) throw new CliError(`형식 오류: ${a} (question=label)`);
      pairs[q] = label;
    }
    return { pairs };
  }
  if (args.length === 1) return { single: args[0]! };
  throw new CliError('answer 인자는 전부 question=label 이거나, 단일 label 하나여야 합니다');
}

// ---- type 명령의 raw 텍스트 ---------------------------------------------------

/** `\n \r \t \e \\ \xHH \uHHHH` 이스케이프 해석. */
export function unescapeTyped(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[nrte\\])/g, (_m, g: string) => {
    switch (g[0]) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'e':
        return '\x1b';
      case '\\':
        return '\\';
      case 'x':
      case 'u':
        return String.fromCharCode(parseInt(g.slice(1), 16));
      default:
        return g;
    }
  });
}

/**
 * 이스케이프·제어문자만으로 이루어진 입력인가(`\e`, `\e\e`, `\e[A`, `\x03` …).
 * T19 함정 3: 이런 입력에 Enter(`\r`)를 붙이면 `ESC CR` = **Alt+Enter** 로 나가 ESC 가 먹지 않는다.
 * 판정은 콘솔 출력과 같은 ANSI/제어문자 정규식([stripAnsi])으로 — 남는 글자가 없으면 "키 입력만" 이다.
 * (`\t`·`\n`·`\r` 는 stripAnsi 가 남기므로 여기에 걸리지 않는다.)
 */
export function isEscapeOnly(data: string): boolean {
  return data.length > 0 && stripAnsi(data) === '';
}

/**
 * member.type 에 보낼 데이터. 원문이 `\n`/`\r` 로 끝나거나 [isEscapeOnly] 면 그대로,
 * 아니면 Enter(`\r`)를 붙인다.
 */
export function typedPayload(rawText: string): string {
  const endsWithNewline = /\\[nr]$/.test(rawText) || /[\r\n]$/.test(rawText);
  const data = unescapeTyped(rawText);
  return endsWithNewline || isEscapeOnly(data) ? data : data + '\r';
}

// ---- argv (비대화 모드) ----------------------------------------------------------

export interface CliArgv {
  exec: string[];
  waitIdle?: string;
  url?: string;
  token?: string;
  timeoutMs: number;
  help: boolean;
}

export function parseArgv(argv: string[]): CliArgv {
  const out: CliArgv = { exec: [], timeoutMs: 10 * 60_000, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new CliError(`${a} 뒤에 값이 필요합니다`);
      return v;
    };
    switch (a) {
      case '--exec':
      case '-e':
        out.exec.push(next());
        break;
      case '--wait-idle':
        out.waitIdle = next();
        break;
      case '--url':
        out.url = next();
        break;
      case '--token':
        out.token = next();
        break;
      case '--timeout':
        out.timeoutMs = parseIntArg(next(), '--timeout');
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        throw new CliError(`알 수 없는 옵션: ${a}`);
    }
  }
  return out;
}
