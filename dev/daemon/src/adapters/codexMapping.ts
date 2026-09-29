// Codex CLI 도구 → 오피스 이벤트 kind/detail 순수 매핑. 설계: 01 §2 표의 Codex 열
//   reading : 읽기 전용 셸 명령 휴리스틱(cat, rg, ls, sed -n, type, Get-Content, git diff|log|status …)  detail.cmd
//   editing : apply_patch / 파일 변경 도구                                                               detail.cmd(+path)
//   running : 그 외 셸 명령, 이름 모르는 도구                                                            detail.cmd|tool
//
// 실측(02 §④, dev/spike-0/run-codex5~7.log): Codex 0.154.0 은 셸 실행을 `tool_name:"Bash"`,
// `tool_input:{command}` 로 보낸다(PermissionRequest 에는 `description` 도 붙는다 — 한국어 승인 문구).
// 도구 **이름**만으로는 읽기/쓰기를 못 가르므로 명령 문자열을 본다. 판정이 애매하면 항상 `running`
// (표시용 이벤트일 뿐이라 과장된 'reading' 보다 'running' 이 안전하다).
import type { EventDetail, OfficeEventKind } from '../store/types.js';
import {
  isDangerousCommand,
  mapPreToolUse,
  pathFromInput,
  shellFromInput,
  toolDetail,
  truncate,
  MAX_PATH_CHARS,
  type ToolMapping,
} from './mapping.js';

export { DANGER_PATTERNS, dangerousMatches, dangerousReasons, isDangerousCommand } from './mapping.js';

/** 도구 이름 비교용 정규화: 소문자 + `_`/`-` 제거. `apply_patch`·`ApplyPatch`·`apply-patch` 를 같게 본다. */
export function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, '');
}

/**
 * 셸 실행 도구(정규화된 이름). 실측은 "Bash" 하나지만 버전·플랫폼에 따라 다른 이름이 올 수 있다 —
 * 맥 기본 셸(`zsh`)·POSIX `sh` 이름도 같이 받는다(T48-1, 플랫폼 무관하게 둘 다 검사한다).
 */
export const CODEX_SHELL_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'sh',
  'zsh',
  'shell',
  'localshell',
  'execcommand',
  'exec',
  'powershell',
  'pwsh',
  'container.exec',
]);

/** 파일 편집 도구(정규화된 이름). */
export const CODEX_EDITING_TOOLS: ReadonlySet<string> = new Set(['applypatch', 'filechange', 'editfile', 'writefile', 'strreplaceeditor', 'edit', 'write']);

/** 인자를 더 볼 필요 없이 읽기로 보는 명령. */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'cat', 'rg', 'ripgrep', 'ls', 'dir', 'type', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'findstr', 'wc', 'pwd', 'tree', 'stat',
  'less', 'more', 'nl', 'du', 'df', 'file', 'basename', 'dirname', 'realpath', 'readlink', 'which', 'where', 'whoami', 'hostname',
  'date', 'fd', 'jq', 'diff', 'cmp', 'sort', 'uniq', 'get-content', 'gc', 'get-childitem', 'gci', 'select-string', 'sls', 'get-location',
]);

/** 자체로는 아무것도 안 바꾸는 명령(다른 읽기 명령과 섞여 있어도 reading 판정을 깨지 않는다). */
export const NEUTRAL_COMMANDS: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd', 'true', ':', 'set-location', 'sl']);

/** 읽기로 보는 git 하위 명령. */
export const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'diff', 'log', 'status', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog', 'branch', 'remote', 'grep', 'cat-file', 'whatchanged',
]);

/** Codex 가 셸에서 부르는 패치 적용기(조각의 **첫 토큰**일 때만 — `rg 'apply_patch'` 같은 검색과 헷갈리면 안 된다). */
const APPLY_PATCH_NAME = 'apply_patch';
/** 패치 본문 머리. 래퍼 셸(`bash -lc "apply_patch …"`) 안에 있어도 이건 명백하다. */
const PATCH_BODY_RE = /\*\*\*\s*Begin Patch/;
/** apply_patch 본문의 파일 경로(`*** Update File: src/a.ts`). */
const PATCH_FILE_RE = /\*\*\*\s*(?:Add|Update|Delete)\s+File:\s*(.+)/;
/** 해로울 게 없는 stderr 리다이렉트(있어도 "쓰기" 로 보지 않는다). */
const HARMLESS_REDIRECT_RE = /2>&1|2>\s*(?:\/dev\/null|\$null|nul\b)/gi;

/** 명령을 `&&`, `||`, `;`, `|`, 개행으로 자른 조각들(빈 조각 제외). 따옴표 안은 고려하지 않는 거친 분해다. */
export function splitCommand(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||[;\n|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 조각 하나를 실행 파일 이름(경로·확장자·환경변수 접두 제거, 소문자) + 나머지 인자로 쪼갠다.
 * 이름이 없으면(빈 조각) undefined.
 */
export function parseSegment(segment: string): { name: string; args: string[] } | undefined {
  const tokens = segment.split(/\s+/).filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++; // VAR=1 cat x
  const raw = tokens[i];
  if (raw === undefined) return undefined;
  const base = raw.replace(/^["']|["']$/g, '').split(/[\\/]/).pop() ?? raw;
  return { name: base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase(), args: tokens.slice(i + 1) };
}

/**
 * 명령이 "읽기만" 하는가. 조각이 하나라도 읽기 목록 밖이면 false. 쓰기 리다이렉트(`>`·`>>`)가 있으면 false.
 * 셸 래퍼(`bash -lc "..."`)는 안을 파싱하지 않고 false — 모르면 running.
 */
export function isReadOnlyCommand(cmd: string): boolean {
  // 안전망(T48-1): 위험 패턴이 걸린 명령은 무슨 일이 있어도 "읽기 전용" 이 아니다. 아래 목록 검사만으로도
  // 이미 전부 "쓰기" 로 떨어지지만(모르는 명령은 false), 표에 새 읽기 명령을 더할 때 사고가 나지 않도록 못을 박는다.
  if (isDangerousCommand(cmd)) return false;
  const cleaned = cmd.replace(HARMLESS_REDIRECT_RE, ' ');
  if (cleaned.includes('>')) return false;
  const segments = splitCommand(cleaned);
  if (segments.length === 0) return false;
  let sawRead = false;
  for (const segment of segments) {
    const parsed = parseSegment(segment);
    if (!parsed) return false;
    const { name, args } = parsed;
    if (NEUTRAL_COMMANDS.has(name)) continue;
    if (READ_ONLY_COMMANDS.has(name)) {
      sawRead = true;
      continue;
    }
    if (name === 'sed') {
      // `sed -n '1,20p' file` 만 읽기. `-i`(in-place)가 있으면 편집이다.
      if (!args.some((a) => a === '-n' || /^-[a-z]*n[a-z]*$/.test(a)) || args.some((a) => a.startsWith('-i'))) return false;
      sawRead = true;
      continue;
    }
    if (name === 'git') {
      const sub = args.find((a) => !a.startsWith('-'));
      if (sub === undefined || !GIT_READ_SUBCOMMANDS.has(sub)) return false;
      sawRead = true;
      continue;
    }
    if (name === 'find') {
      if (args.some((a) => a === '-delete' || a === '-exec' || a === '-execdir' || a === '-fprint')) return false;
      sawRead = true;
      continue;
    }
    return false;
  }
  return sawRead;
}

/** 명령이 apply_patch 실행인가(조각의 첫 토큰이거나 패치 본문을 품고 있으면). */
export function isApplyPatch(cmd: string): boolean {
  if (PATCH_BODY_RE.test(cmd)) return true;
  return splitCommand(cmd).some((seg) => parseSegment(seg)?.name === APPLY_PATCH_NAME);
}

/** 셸 명령 한 줄 → 오피스 이벤트 kind. */
export function classifyCommand(cmd: string): OfficeEventKind {
  if (isApplyPatch(cmd)) return 'editing';
  return isReadOnlyCommand(cmd) ? 'reading' : 'running';
}

/** apply_patch 본문에서 첫 파일 경로. 없으면 undefined. */
export function applyPatchPath(text: string): string | undefined {
  const m = PATCH_FILE_RE.exec(text);
  const p = m?.[1]?.trim().replace(/^["']|["']$/g, '');
  return p ? truncate(p, MAX_PATH_CHARS) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 편집 도구 입력에서 패치 본문(apply_patch 는 도구 입력 이름이 버전마다 다르다). */
function patchTextOf(input: unknown): string | undefined {
  const r = asRecord(input);
  return str(r.patch) ?? str(r.input) ?? str(r.content) ?? str(r.command);
}

/**
 * Codex PreToolUse / PermissionRequest 의 도구 → 오피스 이벤트. 항상 결과가 있다(Codex 에는 AskUserQuestion 이 없다).
 * 셸이면 명령 문자열로 reading/editing/running 을 가르고, detail 에 cmd(+PermissionRequest 의 description → summary)를 싣는다.
 */
export function mapCodexTool(toolName: string, toolInput: unknown): ToolMapping {
  const norm = normalizeToolName(toolName);

  if (CODEX_EDITING_TOOLS.has(norm)) {
    const detail: EventDetail = { tool: toolName };
    const patch = patchTextOf(toolInput);
    const path = pathFromInput(toolInput) ?? (patch ? applyPatchPath(patch) : undefined);
    if (path !== undefined) detail.path = path;
    const desc = str(asRecord(toolInput).description);
    if (desc !== undefined) detail.summary = truncate(desc, 300);
    return { kind: 'editing', detail };
  }

  if (CODEX_SHELL_TOOLS.has(norm)) {
    const raw = str(asRecord(toolInput).command) ?? '';
    const detail: EventDetail = { tool: toolName, ...shellFromInput(toolInput) };
    const kind = classifyCommand(raw);
    if (kind === 'editing') {
      const path = applyPatchPath(raw);
      if (path !== undefined) detail.path = path;
    }
    return { kind, detail };
  }

  // 이름 있는 도구(mcp__*, Read/Grep 등)는 Claude 매핑을 그대로 쓴다. null(AskUserQuestion)은 Codex 에 없지만 방어적으로 running.
  return mapPreToolUse(toolName, toolInput) ?? { kind: 'running', detail: toolDetail(toolName, toolInput) };
}
