// Claude Code 도구 이름 → 오피스 이벤트 kind/detail 순수 매핑. 설계: 01 §2 오피스 이벤트 스키마 표.
//   reading : Read Glob Grep WebFetch WebSearch LS     detail.path ← file_path|pattern|path|url|query
//   editing : Edit Write NotebookEdit MultiEdit         detail.path ← file_path|notebook_path
//   running : Bash PowerShell                            detail.cmd ← command, detail.summary ← description
//   running : mcp__* / 그 외 알 수 없는 도구             detail.tool 만(+ description 이 있으면 summary)
//   (없음)  : AskUserQuestion                            PermissionRequest 에서 asking 으로 처리
import type { EventDetail, OfficeEventKind } from '../store/types.js';

export const READING_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'LS']);
export const EDITING_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);
export const ASK_USER_QUESTION = 'AskUserQuestion';

// ─────────────────────────────────────────────────────────────────────────────
// 되돌릴 수 없는 명령 판별 (T48-1 · 설계 표 "위험한 셸 명령 판별")
//
// **플랫폼과 무관하게 두 계열을 모두 검사한다**(D-48 ④): 맥에서 PowerShell 을 쓸 수도, 윈도우에서 git-bash 를
// 쓸 수도 있다. 그래서 `process.platform` 을 보지 않는다 — 보는 것은 명령 문자열뿐이다.
//
// 이 판별은 **경고용**이다(앱의 허가 카드 `위험` 태그와 같은 뜻, `approval_summary.dart`). 여기서 무엇을
// 막지는 않는다 — 막는 것은 hook 결정(D-04)이고, 애매하면 "위험" 쪽으로 기운다(사람이 한 번 더 보는 것이 싸다).
// ─────────────────────────────────────────────────────────────────────────────

/** 해로울 게 없는 리다이렉트(있어도 "파일 쓰기" 로 보지 않는다): `2>&1`, `> /dev/null`, `> $null`, `> nul`. */
const HARMLESS_REDIRECT_RE = /2>&1|>>?\s*(?:\/dev\/null|\$null|nul\b)/gi;
/** 파일로 나가는 리다이렉션(`> f`, `>> f`). 숫자 fd(`2>`)와 `>&` 는 뺀다. */
const WRITE_REDIRECT_RE = /(^|[^0-9&>])>>?\s*[^&\s|>]/;

export interface DangerPattern {
  /** 로그·테스트에서 부르는 이름. */
  id: string;
  /** 왜 위험한가(한 줄, 사람이 읽는다). */
  why: string;
  /** 소문자로 낮춘 명령에 대고 검사한다. */
  test(lowerCmd: string): boolean;
}

const re = (id: string, why: string, pattern: RegExp): DangerPattern => ({ id, why, test: (c) => pattern.test(c) });

/**
 * 위험 패턴 표. 유닉스 계열과 PowerShell/CMD 계열이 **같은 표**에 있다.
 * `mv` 는 문자열만 보고 "덮어쓸 파일이 있는지" 를 알 수 없으므로 **피연산자가 둘 이상이면** 위험으로 센다.
 */
export const DANGER_PATTERNS: readonly DangerPattern[] = [
  // ── 유닉스
  re('rm-recursive', 'rm 으로 폴더째 삭제(-r/-R/--recursive)', /\brm\s+(?:-{1,2}\S+\s+)*(?:-\w*r|--recursive)/i),
  re('rm-force', 'rm -f 로 되묻지 않고 삭제', /\brm\s+(?:-{1,2}\S+\s+)*(?:-\w*f|--force)/i),
  re('sudo', 'sudo — 관리자 권한으로 실행', /(?:^|[;&|]\s*|\s)sudo\s/i),
  re('chmod-recursive', 'chmod -R 로 권한을 폴더째 변경', /\bchmod\s+(?:\S+\s+)*(?:-\w*r|--recursive)/i),
  re('chown-recursive', 'chown -R 로 소유자를 폴더째 변경', /\bchown\s+(?:\S+\s+)*(?:-\w*r|--recursive)/i),
  re('git-push-force', 'git push --force — 남의 커밋을 지울 수 있다', /\bgit\s+push\b[\s\S]*(?:--force|\s-f\b)/i),
  re('git-reset-hard', 'git reset --hard — 작업 내용이 사라진다', /\bgit\s+reset\b[\s\S]*--hard/i),
  re('git-clean-force', 'git clean -fd — 추적되지 않는 파일 삭제', /\bgit\s+clean\b[\s\S]*-\w*f/i),
  re('truncate', 'truncate — 파일 내용을 잘라낸다', /(?:^|[;&|]\s*|\s)truncate\s/i),
  re('dd', 'dd — 장치·파일을 그대로 덮어쓴다', /(?:^|[;&|]\s*|\s)dd\s+(?:if|of|bs)=/i),
  re('mkfs', 'mkfs — 파일 시스템을 새로 만든다(디스크 초기화)', /\bmkfs(?:\.\w+)?\b/i),
  // ── PowerShell · CMD (예전 것을 그대로 남긴다)
  re('remove-item-recurse', 'Remove-Item -Recurse 로 폴더째 삭제', /\bremove-item\b[\s\S]*-recurse/i),
  re('remove-item-force', 'Remove-Item -Force 로 되묻지 않고 삭제', /\bremove-item\b[\s\S]*-force/i),
  re('del-s', 'del /s — 하위 폴더까지 삭제', /\bdel\s+(?:\/\w+\s+)*\/s\b/i),
  re('rd-s', 'rd|rmdir /s — 폴더째 삭제', /\b(?:rd|rmdir)\s+(?:\/\w+\s+)*\/s\b/i),
  re('format', 'format — 디스크 포맷', /(?:^|[;&|]\s*)format\s/i),
  // ── 문자열만으로는 애매해 따로 판정하는 둘
  {
    id: 'write-redirect',
    why: '파일로 리다이렉션(`>`·`>>`) — 기존 내용을 덮어쓴다',
    test: (c) => WRITE_REDIRECT_RE.test(c.replace(HARMLESS_REDIRECT_RE, ' ')),
  },
  {
    id: 'mv-overwrite',
    why: 'mv — 대상이 이미 있으면 덮어쓴다',
    test: (c) =>
      c
        .split(/&&|\|\||[;\n|]/)
        .some((seg) => {
          const tokens = seg.trim().split(/\s+/).filter((t) => t.length > 0);
          if (tokens[0]?.replace(/^.*[/\\]/, '') !== 'mv') return false;
          return tokens.slice(1).filter((t) => !t.startsWith('-')).length >= 2 || tokens.some((t) => t === '-f' || t === '--force');
        }),
  },
];

/** 위험 패턴 중 걸린 것들의 id. 안 걸리면 빈 배열. */
export function dangerousMatches(command: string | undefined): string[] {
  const c = (command ?? '').toLowerCase();
  if (c.trim() === '') return [];
  return DANGER_PATTERNS.filter((p) => p.test(c)).map((p) => p.id);
}

/** 되돌릴 수 없는(또는 덮어쓰는) 명령인가. 플랫폼을 보지 않는다 — 두 계열을 모두 검사한다. */
export function isDangerousCommand(command: string | undefined): boolean {
  return dangerousMatches(command).length > 0;
}

/** 걸린 패턴들의 설명(사람이 읽는 한 줄씩). 진단·로그용. */
export function dangerousReasons(command: string | undefined): string[] {
  const ids = new Set(dangerousMatches(command));
  return DANGER_PATTERNS.filter((p) => ids.has(p.id)).map((p) => p.why);
}

/** detail 문자열 상한. cmd 는 길 수 있어 조금 넉넉히. */
export const MAX_CMD_CHARS = 1000;
export const MAX_SUMMARY_CHARS = 300;
export const MAX_PATH_CHARS = 500;

export interface ToolMapping {
  kind: OfficeEventKind;
  detail: EventDetail;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 읽기/편집 도구 입력에서 대표 경로 하나. */
export function pathFromInput(input: unknown): string | undefined {
  const r = asRecord(input);
  const p = str(r.file_path) ?? str(r.notebook_path) ?? str(r.pattern) ?? str(r.path) ?? str(r.url) ?? str(r.query);
  return p === undefined ? undefined : truncate(p, MAX_PATH_CHARS);
}

/** 셸 도구 입력에서 cmd/summary. */
export function shellFromInput(input: unknown): { cmd?: string; summary?: string } {
  const r = asRecord(input);
  const out: { cmd?: string; summary?: string } = {};
  const cmd = str(r.command);
  const desc = str(r.description);
  if (cmd !== undefined) out.cmd = truncate(cmd, MAX_CMD_CHARS);
  if (desc !== undefined) out.summary = truncate(desc, MAX_SUMMARY_CHARS);
  return out;
}

/**
 * 도구 호출 하나의 표시용 detail(tool 은 항상 포함). PreToolUse 이벤트와 PermissionRequest 의
 * waiting_approval 이벤트가 같은 detail 을 쓴다.
 */
export function toolDetail(toolName: string, toolInput: unknown): EventDetail {
  const detail: EventDetail = { tool: toolName };
  if (READING_TOOLS.has(toolName) || EDITING_TOOLS.has(toolName)) {
    const path = pathFromInput(toolInput);
    if (path !== undefined) detail.path = path;
    return detail;
  }
  if (SHELL_TOOLS.has(toolName)) {
    Object.assign(detail, shellFromInput(toolInput));
    return detail;
  }
  // mcp__* 와 그 외: description 이 있으면 summary 로만 살린다(Agent, Task 등).
  const desc = str(asRecord(toolInput).description);
  if (desc !== undefined) detail.summary = truncate(desc, MAX_SUMMARY_CHARS);
  return detail;
}

/**
 * PreToolUse 의 tool_name → 오피스 이벤트. AskUserQuestion 은 null(여기서는 이벤트 없음).
 * 이름을 모르는 도구는 전부 `running`.
 */
export function mapPreToolUse(toolName: string, toolInput: unknown): ToolMapping | null {
  if (toolName === ASK_USER_QUESTION) return null;
  const detail = toolDetail(toolName, toolInput);
  if (READING_TOOLS.has(toolName)) return { kind: 'reading', detail };
  if (EDITING_TOOLS.has(toolName)) return { kind: 'editing', detail };
  return { kind: 'running', detail };
}

/** AskUserQuestion 의 questions[] 에서 말풍선용 요약("Q1 / Q2"). */
export function questionSummary(toolInput: unknown): string | undefined {
  const qs = asRecord(toolInput).questions;
  if (!Array.isArray(qs)) return undefined;
  const texts = qs.map((q) => str(asRecord(q).question)).filter((s): s is string => s !== undefined);
  return texts.length ? truncate(texts.join(' / '), MAX_SUMMARY_CHARS) : undefined;
}
