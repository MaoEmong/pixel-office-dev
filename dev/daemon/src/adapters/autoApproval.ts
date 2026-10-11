// 허가 요청(PermissionRequest)을 **사람에게 묻지 않고** 통과시켜도 되는가 — 순수 판정 함수(U-02, D-51).
//
// 배경: D-32 ③ 은 "셸 허가는 직급과 무관하게 전부 사용자에게" 였다. 팀장·팀원이 붙으면 허가 카드가 머릿수만큼
// 곱해져서, 번거로움을 줄이려고 만든 도구가 번거로워졌다. 그래서 부서마다 **허가 방식**을 고른다:
//
//   ask    전부 묻기 — 지금까지의 동작. **기본값**이다(이 파일은 아무것도 통과시키지 않는다).
//   edits  작업 폴더 **안**의 파일 편집 + 읽기만 하는 셸 명령은 자동. 나머지는 묻는다.
//          Codex 가 이미 이렇게 돈다(`sandbox_mode="workspace-write"` — 폴더 안 쓰기는 묻지 않는다). Claude 를 같은 수준으로 맞춘다.
//   trust  위에 더해 **평범한 셸 명령**도 자동. 위험해 보이는 것만 묻는다.
//
// ── 틀리는 방향에 대하여 ─────────────────────────────────────────────────────────────────────────
// `mapping.ts` 의 위험 판별은 **경고 표시용**으로 만들어졌다 — 과탐지가 싸다는 전제다("사람이 한 번 더 보는 것이 싸다").
// 자동 허가의 기준으로 쓰면 비용이 뒤집힌다: 이제 비싼 쪽은 **미탐지**다(위험한데 안 잡힌 명령이 묻지 않고 실행된다).
// 그래서 여기서는:
//   - `edits` 는 **허용 목록**이다. "위험하지 않으면 통과" 가 아니라 "안전하다고 아는 것만 통과". 모르면 묻는다.
//   - `trust` 는 어쩔 수 없이 차단 목록이지만, **구조를 모르겠으면 묻는다**(치환·래퍼·인라인 코드·폴더 밖 경로).
//
// **`trust` 는 보안 경계가 아니다.** `python build.py` 나 `npm install` 은 그 안에서 무엇이든 할 수 있고, 스크립트는
// 자동 허가된 편집으로 방금 쓴 것일 수 있다. `trust` 가 막는 것은 **사고**다 — 실수로 나가는 `rm -rf`, `git push`,
// 폴더 밖 쓰기. 악의적인 에이전트를 가두는 장치가 아니다. 그게 필요하면 `ask` 를 쓴다.
//
// 어느 방식이든 **절대 자동으로 넘기지 않는 것**: 작업 폴더 밖 경로, `.git`·`.claude`·`.codex` 안, 비밀 파일(`.env`·키),
// 웹 요청(WebFetch/WebSearch), 팀 도구가 아닌 MCP 도구, 모르는 도구.
import fs from 'node:fs';
import path from 'node:path';
import { EDITING_TOOLS, SHELL_TOOLS, dangerousMatches } from './mapping.js';
import { CODEX_EDITING_TOOLS, CODEX_SHELL_TOOLS, isApplyPatch, isReadOnlyCommand, normalizeToolName } from './codexMapping.js';
import type { ApprovalPolicy } from '../store/types.js';

// 허가 방식 값은 store 가 주인이다(DB `departments.approval_policy`·RPC·앱이 같은 문자열을 쓴다).
export { APPROVAL_POLICIES, DEFAULT_APPROVAL_POLICY, isApprovalPolicy } from '../store/types.js';
export type { ApprovalPolicy } from '../store/types.js';

/** 통과시킨 규칙. 이벤트 `detail.auto` 로 나가 로그에 "자동 허가" 꼬리표가 된다. */
export type AutoRule = 'edit-in-cwd' | 'read-only-shell' | 'plain-shell';

export interface AutoApprovalInput {
  toolName: string;
  toolInput: unknown;
  /** 부서 작업 폴더(절대 경로). 모든 "폴더 안" 판정의 기준이다. */
  cwd: string;
}

export interface AutoApprovalDecision {
  /** true 면 사람에게 묻지 않고 허가한다. */
  allow: boolean;
  /** 통과시킨 규칙(allow 일 때만). */
  rule: AutoRule | null;
  /** 왜 그렇게 정했나(한 줄 — 로그·테스트용). */
  why: string;
}

/** 판정에 쓰는 바깥 세계. 테스트에서 바꿔 끼운다. */
export interface AutoApprovalEnv {
  /** 심볼릭 링크를 푼 진짜 경로. 없는 경로면 던진다(`fs.realpathSync`). */
  realpath?: (p: string) => string;
}

const ask = (why: string): AutoApprovalDecision => ({ allow: false, rule: null, why });
const pass = (rule: AutoRule, why: string): AutoApprovalDecision => ({ allow: true, rule, why });

// ─────────────────────────────────────────────────────────────────────────────
// 경로: "작업 폴더 안인가"
// ─────────────────────────────────────────────────────────────────────────────

/** 폴더 안이어도 자동으로 건드리지 않는 디렉터리(경로 조각 이름). 권한·hook·자격 증명이 사는 곳이다. */
const PROTECTED_SEGMENTS: ReadonlySet<string> = new Set(['.git', '.claude', '.codex', '.ssh', '.gnupg', '.aws']);

/** 폴더 안이어도 자동으로 건드리지 않는 파일 이름. */
const PROTECTED_BASENAMES: readonly RegExp[] = [
  /^\.env(\..*)?$/i, // .env · .env.local · .env.production
  /^\.envrc$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(npmrc|netrc|pypirc)$/i,
  /^\.mcp\.json$/i, // 여기에 서버를 더하면 다음 세션이 그 명령을 실행한다
];

/** 다른 플랫폼의 절대 경로 모양(`C:\x`, `\\server\share`). posix 에서는 "이상한 이름의 상대 경로" 로 풀려 버린다. */
const WINDOWS_ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** 가장 깊은 **존재하는** 조상을 realpath 로 풀고 나머지를 붙인다 — 새로 만드는 파일은 아직 없다. */
function realOf(p: string, realpath: (p: string) => string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpath(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * `target`(절대 또는 cwd 기준 상대)이 작업 폴더 **안**의, 보호 대상이 아닌 경로인가.
 * 심볼릭 링크로 밖을 가리키면 밖이다(존재하는 조상까지 realpath 로 푼다). 폴더 자체는 "안" 이 아니다.
 */
export function pathVerdict(cwd: string, target: string, env: AutoApprovalEnv = {}): { inside: boolean; why: string } {
  const realpath = env.realpath ?? ((p: string) => fs.realpathSync(p));
  if (!target || target.includes('\0')) return { inside: false, why: '경로가 비었거나 이상하다' };
  if (target.startsWith('~')) return { inside: false, why: `홈 폴더 경로(${target})` };
  if (path.sep === '/' && WINDOWS_ABSOLUTE_RE.test(target)) return { inside: false, why: `다른 플랫폼의 절대 경로(${target})` };
  const base = realOf(path.resolve(cwd), realpath);
  const abs = realOf(path.resolve(cwd, target), realpath);
  const rel = path.relative(base, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return { inside: false, why: `작업 폴더 밖(${target})` };
  }
  const segments = rel.split(/[\\/]/).map((s) => s.toLowerCase());
  const guarded = segments.find((s) => PROTECTED_SEGMENTS.has(s));
  if (guarded) return { inside: false, why: `보호 폴더 ${guarded} 안(${target})` };
  const name = segments[segments.length - 1] ?? '';
  if (PROTECTED_BASENAMES.some((re) => re.test(name))) return { inside: false, why: `보호 파일(${name})` };
  return { inside: true, why: '작업 폴더 안' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 셸: 공통 분해
// ─────────────────────────────────────────────────────────────────────────────

/** 아무 일도 안 하는 리다이렉트는 지우고 본다(`2>&1`, `> /dev/null`, `2>/dev/null` …). */
const HARMLESS_REDIRECT_RE = /\d?>&\d|\d?>>?\s*(?:\/dev\/null|\$null|nul\b)|&>\s*\/dev\/null/gi;

/**
 * 명령 치환·프로세스 치환·백그라운드 — **문자열만 보고는 무엇이 실행될지 알 수 없게 만드는 것들**.
 * 하나라도 있으면 어느 방식에서도 묻는다.
 */
export function shellTrickery(cmd: string): string | null {
  const c = cmd.replace(HARMLESS_REDIRECT_RE, ' ');
  if (c.includes('$(')) return '명령 치환 $(…)';
  if (c.includes('`')) return '명령 치환 `…`';
  if (/[<>]\(/.test(c) || /(^|\s)=\(/.test(c)) return '프로세스 치환 <(…)';
  if (/(^|[^&])&(?!&)/.test(c)) return '백그라운드 실행(&)';
  return null;
}

/** `;` `&&` `||` `|` 개행으로 자른 조각. 따옴표를 고려하지 않는다 — **항상 더 잘게** 자르므로 안전한 쪽으로 틀린다. */
function segmentsOf(cmd: string): string[] {
  return cmd
    .replace(HARMLESS_REDIRECT_RE, ' ')
    .split(/&&|\|\||[;\n|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 조각 맨 앞에 올 수 있는 셸 문법 낱말 — 건너뛰고 그 뒤를 명령으로 본다(`then curl …`, `do rm …`). */
const SHELL_KEYWORDS: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'in', '!', '{', '}', '(', ')']);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface ParsedSegment {
  /** 실행 파일 이름(경로·확장자 제거, 소문자). 없으면 빈 문자열. */
  name: string;
  args: string[];
  /** 명령 앞에 붙은 `VAR=값` 들의 변수 이름. */
  assigned: string[];
  /**
   * 이름 자리를 **글자 그대로 믿을 수 없다**: 따옴표를 끼워 넣었거나(`s"u"do`), 역슬래시로 이스케이프했거나(`c\url`),
   * 변수다(`$CMD`). 셸은 이걸 풀어서 실행하는데 우리는 푼 결과를 모른다 — 이름으로 거르는 판정을 전부 빠져나간다.
   */
  opaque: boolean;
}

const unquote = (t: string): string => t.replace(/^["']+|["']+$/g, '');

function parseSegment(segment: string): ParsedSegment {
  const tokens = segment.split(/\s+/).filter((t) => t.length > 0);
  const assigned: string[] = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!.replace(/^[({]+/, '');
    if (t === '' || SHELL_KEYWORDS.has(t)) continue;
    if (ASSIGNMENT_RE.test(t)) {
      assigned.push(t.slice(0, t.indexOf('=')));
      continue;
    }
    break;
  }
  const raw = tokens[i];
  if (raw === undefined) return { name: '', args: [], assigned, opaque: false };
  const bare = raw.replace(/^[({]+/, '');
  // 통째로 감싼 따옴표 한 쌍("my tool")은 괜찮다. 그 밖의 따옴표·달러·(posix 의) 역슬래시는 이름을 가린다.
  const whole = /^(["'])([^"']*)\1$/.exec(bare);
  const inner = whole ? whole[2]! : bare;
  const opaque = /["'$]/.test(inner) || (path.sep === '/' && inner.includes('\\'));
  const base = inner.split(/[\\/]/).pop() ?? '';
  return {
    name: base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase(),
    args: tokens.slice(i + 1).map(unquote),
    assigned,
    opaque,
  };
}

/** 인자 중 옵션이 아닌 것. */
const positional = (args: string[]): string[] => args.filter((a) => !a.startsWith('-'));
const hasFlag = (args: string[], ...flags: string[]): boolean => args.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)));
/** 짧은 옵션 묶음(`-uo`)에 그 글자가 들어 있는가. */
const hasShort = (args: string[], letter: string): boolean => args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter));

// ─────────────────────────────────────────────────────────────────────────────
// 셸: 폴더 밖 경로 찾기
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_DEVICES: ReadonlySet<string> = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin', '/dev/tty']);
/** 홈·사용자 폴더로 풀리는 변수. 값을 모르니 "밖" 으로 친다. */
const HOME_VAR_RE = /\$\{?(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMPDIR)\b|\$env:|%(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH|HOMEDRIVE|TEMP|TMP)%/i;
/** cmd.exe 식 한 글자 옵션(`/s`, `/b`, `/?`). 절대 경로처럼 생겼지만 경로가 아니다. */
const SLASH_FLAG_RE = /^\/[A-Za-z?]$/;

/**
 * 명령 문자열에서 **작업 폴더 밖을 가리키는 것으로 보이는** 낱말을 찾는다. 없으면 null.
 * 낱말 단위 휴리스틱이다: 절대 경로, `~`, `..` 로 빠져나가는 상대 경로, 홈 변수. `awk '/re/'` 같은 것도 걸린다
 * (절대 경로처럼 보인다) — 그때는 그냥 묻는다.
 */
export function outsidePathIn(cmd: string, cwd: string, env: AutoApprovalEnv = {}): string | null {
  if (HOME_VAR_RE.test(cmd)) return '홈 폴더 변수($HOME 등)';
  const words = cmd.split(/[\s;|&<>()]+/).filter((w) => w.length > 0);
  for (const word of words) {
    const w = unquote(word);
    const candidates = new Set<string>([w, ...w.split('=').slice(1)]);
    const glued = /^-{1,2}[A-Za-z]+(\/.*)$/.exec(w); // -C/ · -o/etc/x
    if (glued) candidates.add(glued[1]!);
    for (const raw of candidates) {
      const c = unquote(raw);
      if (c === '' || SAFE_DEVICES.has(c) || SLASH_FLAG_RE.test(c)) continue;
      const looksAbsolute = c.startsWith('/') || WINDOWS_ABSOLUTE_RE.test(c);
      const climbs = c.split(/[\\/]/).includes('..');
      if (!c.startsWith('~') && !looksAbsolute && !climbs) continue;
      // 보호 폴더·파일은 편집 판정에서만 본다 — 여기서는 "밖인가" 만.
      const v = pathVerdict(cwd, c, env);
      if (!v.inside && !v.why.startsWith('보호')) return v.why;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 셸 ①: 읽기만 하는 명령(`edits` 이상) — 허용 목록
// ─────────────────────────────────────────────────────────────────────────────

const GIT_BRANCH_LIST_FLAGS: ReadonlySet<string> = new Set(['-a', '-r', '-v', '-vv', '--all', '--remotes', '--list', '--show-current', '--no-color', '--color']);
const DATE_FLAGS_RE = /^(?:\+.*|-u|-R|-I\w*|--utc|--universal|--iso-8601(?:=\w+)?|--rfc-\w+(?:=\w+)?)$/;
const HOSTNAME_FLAGS: ReadonlySet<string> = new Set(['-s', '-f', '-i', '-d', '-A', '-I']);
const FIND_ACTIONS = ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'];

/**
 * `isReadOnlyCommand` 가 "읽기" 라고 한 명령을 **자동 허가용으로 한 번 더** 조인다.
 * 분류용 판정은 `ls $(touch x)` 도, `sort -o f` 도, `git branch -D x` 도 읽기로 본다 — 말풍선 색을 고르는 데는
 * 충분했지만 묻지 않고 실행하기에는 느슨하다.
 */
export function strictReadOnlyVerdict(cmd: string): { ok: boolean; why: string } {
  const trick = shellTrickery(cmd);
  if (trick) return { ok: false, why: trick };
  if (!isReadOnlyCommand(cmd)) return { ok: false, why: '읽기 전용 목록에 없는 명령' };
  // 괄호·중괄호는 인자 자리에서도 명령을 실행시킬 수 있다(PowerShell `Get-Content (Remove-Item x)`). 읽기 명령에는 필요 없다.
  if (/[(){}]/.test(cmd)) return { ok: false, why: '괄호·중괄호(안에서 다른 명령이 돌 수 있다)' };
  for (const segment of segmentsOf(cmd)) {
    const { name, args, assigned, opaque } = parseSegment(segment);
    // 환경 변수 접두는 실행을 바꾼다(LD_PRELOAD · PATH · GIT_PAGER …) — 읽기 명령에는 하나도 허락하지 않는다.
    if (assigned.length > 0) return { ok: false, why: `환경 변수 접두(${assigned[0]}=…)` };
    if (opaque) return { ok: false, why: '명령 이름을 글자 그대로 읽을 수 없다(따옴표·역슬래시·변수)' };
    const bad = (why: string) => ({ ok: false, why: `${name}: ${why}` });
    switch (name) {
      case 'less':
      case 'more':
        // 페이저는 시작 명령(`+!cmd`)으로 셸을 부를 수 있고, 사람이 보지 않는 자리에서는 쓸 일도 없다.
        return bad('페이저');
      case 'sed':
        // `-n 'N,Mp'` 꼴만. sed 스크립트는 파일을 쓰고(`w`) GNU 는 명령도 실행한다(`e`).
        if (args.some((a) => a.startsWith('-') && a !== '-n')) return bad('-n 말고 다른 옵션');
        if (!/^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(positional(args)[0] ?? '')) return bad("'N,Mp' 꼴이 아닌 스크립트");
        break;
      case 'git': {
        const sub = args[0];
        if (sub === undefined || sub.startsWith('-')) return bad('하위 명령 앞의 전역 옵션');
        const rest = args.slice(1);
        if (rest.some((a) => /^--output\b/.test(a) || a === '--ext-diff' || a === '-O' || a.startsWith('--open-files-in-pager'))) return bad('출력·외부 프로그램 옵션');
        if (sub === 'branch' && rest.some((a) => !GIT_BRANCH_LIST_FLAGS.has(a))) return bad('branch 는 목록 보기만');
        if (sub === 'remote' && rest.some((a) => a !== '-v' && a !== '--verbose')) return bad('remote 는 목록 보기만');
        break;
      }
      case 'find':
        if (args.some((a) => FIND_ACTIONS.includes(a))) return bad('실행·삭제·파일 쓰기 동작');
        break;
      case 'sort':
        if (hasFlag(args, '--output') || hasShort(args, 'o') || args.some((a) => /^-o./.test(a))) return bad('-o(파일로 쓴다)');
        break;
      case 'uniq':
        if (positional(args).length > 1) return bad('둘째 인자는 출력 파일');
        break;
      case 'tree':
        if (hasFlag(args, '-o')) return bad('-o(파일로 쓴다)');
        break;
      case 'fd':
        if (hasFlag(args, '-x', '-X', '--exec', '--exec-batch')) return bad('--exec(명령 실행)');
        break;
      case 'rg':
      case 'ripgrep':
        if (args.some((a) => a.startsWith('--pre') || a.startsWith('--hostname-bin'))) return bad('--pre(외부 프로그램)');
        break;
      case 'file':
        if (hasFlag(args, '-C', '--compile')) return bad('-C(파일을 만든다)');
        break;
      case 'date':
        if (args.some((a) => !DATE_FLAGS_RE.test(a))) return bad('시각을 바꾸는 인자');
        break;
      case 'hostname':
        if (args.some((a) => !HOSTNAME_FLAGS.has(a))) return bad('이름을 바꾸는 인자');
        break;
      default:
        break;
    }
  }
  return { ok: true, why: '읽기만 하는 명령' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 셸 ②: 평범한 명령(`trust`) — 위험해 보이는 것만 거른다
// ─────────────────────────────────────────────────────────────────────────────

/** `trust` 에서도 묻는 위험 패턴. 덮어쓰기 경고 둘(`write-redirect`·`mv-overwrite`)은 뺀다 — 폴더 안 쓰기는 편집과 같은 일이다. */
const TRUST_IGNORED_DANGER: ReadonlySet<string> = new Set(['write-redirect', 'mv-overwrite']);

/** 이름만으로 묻는 명령. 값은 사람이 읽는 이유. */
const ASK_COMMANDS: ReadonlyMap<string, string> = new Map(
  (
    [
      ['관리자 권한', ['sudo', 'su', 'doas', 'runas']],
      ['셸을 다시 부른다(안을 볼 수 없다)', ['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd']],
      [
        '다른 명령을 대신 실행한다',
        ['eval', 'exec', 'source', '.', 'env', 'xargs', 'nohup', 'timeout', 'watch', 'nice', 'command', 'builtin', 'time', 'parallel', 'start-process', 'invoke-expression', 'iex', 'invoke-command', 'icm'],
      ],
      ['네트워크·원격', ['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm']],
      [
        '바깥 서비스를 건드린다',
        ['gh', 'glab', 'aws', 'gcloud', 'az', 'kubectl', 'helm', 'terraform', 'pulumi', 'vercel', 'netlify', 'firebase', 'heroku', 'fly', 'flyctl', 'docker', 'podman', 'twine'],
      ],
      ['시스템 패키지 관리자', ['brew', 'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'port', 'choco', 'winget', 'scoop', 'snap']],
      [
        '프로세스·시스템 설정',
        [
          'kill', 'pkill', 'killall', 'taskkill', 'stop-process', 'shutdown', 'reboot', 'halt', 'launchctl', 'systemctl', 'service', 'crontab', 'at',
          'osascript', 'open', 'xdg-open', 'start', 'defaults', 'diskutil', 'mount', 'umount', 'chflags', 'csrutil', 'spctl', 'security', 'networksetup',
          'scutil', 'pmset', 'dscl', 'passwd', 'chsh', 'reg', 'regedit', 'sc', 'schtasks', 'set-executionpolicy',
        ],
      ],
      ['되돌릴 수 없는 삭제', ['shred', 'srm', 'wipe']],
    ] as const
  ).flatMap(([why, names]) => names.map((n) => [n, why] as const)),
);

/** 환경 변수 접두로 주면 **다른 코드가 실행되는** 변수. */
const EXEC_ENV_RE = /^(?:LD_|DYLD_)|^(?:PATH|NODE_OPTIONS|BASH_ENV|ENV|IFS|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|RUBYOPT|GIT_SSH|GIT_SSH_COMMAND|GIT_EXTERNAL_DIFF|GIT_PAGER|PAGER|EDITOR|VISUAL)$/;

const INTERPRETER_RE = /^(?:python[\d.]*|node|deno|bun|perl|ruby|php|lua|swift)$/;
/** 인터프리터에 **코드를 인자로** 주는 옵션: `-c` `-e` `-E` (묶음 `-pe` 포함), node `-p`/`-r`, `--eval`, deno `eval`. */
const isInlineCodeFlag = (a: string): boolean =>
  a === '--eval' || a === '--print' || a === 'eval' || a === '-p' || a === '-r' || /^-[A-Za-z]*[ceE][A-Za-z]*$/.test(a);
const INFO_FLAGS: ReadonlySet<string> = new Set(['--version', '-V', '-v', '--help', '-h']);
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'cargo', 'gem', 'go', 'uv', 'poetry']);
/** 밖으로 내보내거나 계정을 건드리는 하위 명령 — 어느 도구든 이 낱말이 인자로 서면 묻는다. */
const OUTWARD_WORDS: ReadonlySet<string> = new Set(['publish', 'unpublish', 'deploy', 'release', 'login', 'logout', 'adduser', 'token', 'owner']);
const DELETE_COMMANDS: ReadonlySet<string> = new Set(['rm', 'del', 'erase', 'unlink', 'remove-item', 'ri', 'rmdir', 'rd']);

/** `trust` 에서 묻지 않는 git 하위 명령(읽기 + 로컬에서 되돌릴 수 있는 것). 여기 없으면 묻는다 — push·clean·restore·config … */
const GIT_TRUSTED: ReadonlySet<string> = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog', 'grep', 'cat-file', 'whatchanged',
  'add', 'commit', 'branch', 'checkout', 'switch', 'merge', 'rebase', 'stash', 'fetch', 'pull', 'tag', 'mv', 'rm', 'init', 'cherry-pick', 'revert',
  'apply', 'format-patch', 'worktree', 'remote',
]);

function gitVerdict(args: string[]): string | null {
  const sub = args[0];
  if (sub === undefined || sub.startsWith('-')) return 'git: 하위 명령 앞의 전역 옵션';
  const rest = args.slice(1);
  if (!GIT_TRUSTED.has(sub)) return `git ${sub}`;
  if ((sub === 'checkout' || sub === 'switch') && rest.some((a) => a === '--' || a === '.' || a === '-f' || a === '--force' || a === '--discard-changes')) {
    return `git ${sub}: 작업 중인 변경을 버린다`;
  }
  if (sub === 'stash' && (rest[0] === 'drop' || rest[0] === 'clear')) return 'git stash drop/clear';
  if (sub === 'branch' && rest.some((a) => a === '-D' || a === '--delete' || a === '-d' || (/^-[A-Za-z]+$/.test(a) && /[dD]/.test(a)))) return 'git branch 삭제';
  if (sub === 'tag' && hasFlag(rest, '-d', '--delete')) return 'git tag 삭제';
  if (sub === 'worktree' && rest[0] !== undefined && rest[0] !== 'list' && rest[0] !== 'add') return `git worktree ${rest[0]}`;
  if (sub === 'remote' && rest.some((a) => a !== '-v' && a !== '--verbose')) return 'git remote 변경';
  if (sub === 'rebase' && rest.some((a) => a === '--exec' || a === '-x' || a.startsWith('--exec='))) return 'git rebase --exec';
  return null;
}

/**
 * `trust` 방식에서 이 셸 명령을 묻지 않고 넘겨도 되는가. 넘기지 못하면 이유를 준다.
 * **모르는 명령은 넘긴다**(차단 목록이다) — 대신 구조를 모르겠으면 묻는다.
 */
export function plainShellVerdict(cmd: string, cwd: string, env: AutoApprovalEnv = {}): { ok: boolean; why: string } {
  const no = (why: string) => ({ ok: false, why });
  const trick = shellTrickery(cmd);
  if (trick) return no(trick);
  const danger = dangerousMatches(cmd).filter((id) => !TRUST_IGNORED_DANGER.has(id));
  if (danger.length > 0) return no(`위험 패턴(${danger.join(', ')})`);
  const outside = outsidePathIn(cmd, cwd, env);
  if (outside) return no(outside);

  // `a | b` 에서 b 가 인터프리터면 a 의 출력이 코드로 실행된다.
  const cleaned = cmd.replace(HARMLESS_REDIRECT_RE, ' ');
  for (const list of cleaned.split(/&&|\|\||[;\n]/)) {
    const stages = list.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
    for (const stage of stages.slice(1)) {
      const { name } = parseSegment(stage);
      if (INTERPRETER_RE.test(name)) return no(`파이프로 받은 것을 ${name} 가 실행한다`);
    }
  }

  // 괄호·중괄호 바로 뒤에 선 낱말도 명령 자리다(`echo (curl …)` — PowerShell 은 인자 자리의 괄호 안을 실행한다).
  for (const m of cleaned.matchAll(/[({]\s*([A-Za-z_.][\w.-]*)/g)) {
    const inner = m[1]!.toLowerCase();
    const named = ASK_COMMANDS.get(inner);
    if (named) return no(`${inner}: ${named}`);
  }

  for (const segment of segmentsOf(cmd)) {
    const { name, args, assigned, opaque } = parseSegment(segment);
    const execEnv = assigned.find((v) => EXEC_ENV_RE.test(v));
    if (execEnv) return no(`실행을 바꾸는 환경 변수(${execEnv}=…)`);
    if (opaque) return no('명령 이름을 글자 그대로 읽을 수 없다(따옴표·역슬래시·변수)');
    if (name === '') continue;
    const named = ASK_COMMANDS.get(name);
    if (named) return no(`${name}: ${named}`);
    if (INTERPRETER_RE.test(name)) {
      if (args.some(isInlineCodeFlag)) return no(`${name}: 한 줄 코드 실행`);
      // 스크립트 파일 없이 부르면 표준 입력(here-doc·파이프)이 코드가 된다. 버전·도움말만 묻는 것은 괜찮다.
      const infoOnly = args.length > 0 && args.every((a) => INFO_FLAGS.has(a));
      if (!infoOnly && (positional(args).length === 0 || segment.includes('<'))) return no(`${name}: 표준 입력을 코드로 실행한다`);
    }
    if (name === 'git') {
      const g = gitVerdict(args);
      if (g) return no(g);
    }
    if (name === 'find' && args.some((a) => FIND_ACTIONS.includes(a))) return no('find: 실행·삭제 동작');
    if (DELETE_COMMANDS.has(name) && args.some((a) => /[*?]/.test(a))) return no(`${name}: 와일드카드로 삭제`);
    if (PACKAGE_MANAGERS.has(name) && (hasFlag(args, '-g', '--global') || args.includes('global'))) return no(`${name}: 전역 설치`);
    // git 은 위의 허용 목록이 이미 걸렀다 — 여기서 또 보면 커밋 메시지의 낱말("release notes")에 걸린다.
    const outward = name === 'git' ? undefined : args.find((a) => OUTWARD_WORDS.has(a.toLowerCase()));
    if (outward) return no(`${name} ${outward}: 밖으로 내보내거나 계정을 건드린다`);
  }
  return { ok: true, why: '위험해 보이는 것이 없다' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 편집 도구
// ─────────────────────────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** apply_patch 본문의 파일 줄. `Move to` 는 옮겨 갈 곳이다. */
const PATCH_LINE_RE = /^\*\*\*\s*(Add|Update|Delete)\s+File:\s*(.+?)\s*$|^\*\*\*\s*Move to:\s*(.+?)\s*$/gm;

export interface EditTargets {
  paths: string[];
  /** 파일을 지우는 편집이 섞여 있다(apply_patch `Delete File`). */
  deletes: boolean;
}

/** 편집 도구 입력에서 건드리는 파일 전부. 하나도 못 찾으면 null(= 모르겠다 → 묻는다). */
export function editTargets(toolInput: unknown): EditTargets | null {
  const r = rec(toolInput);
  const direct = str(r.file_path) ?? str(r.notebook_path) ?? str(r.path);
  const patch = str(r.patch) ?? str(r.input) ?? str(r.command) ?? str(r.content);
  const paths: string[] = [];
  let deletes = false;
  if (patch !== undefined && /\*\*\*\s*Begin Patch/.test(patch)) {
    for (const m of patch.matchAll(PATCH_LINE_RE)) {
      const p = unquote((m[2] ?? m[3] ?? '').trim());
      if (p) paths.push(p);
      if (m[1] === 'Delete') deletes = true;
    }
    // 패치인데 파일 줄을 하나도 못 읽었으면 모르는 것이다 — direct 로 떨어지지 않는다.
    return paths.length > 0 ? { paths, deletes } : null;
  }
  if (direct !== undefined) return { paths: [direct], deletes: false };
  return null;
}

function editVerdict(policy: ApprovalPolicy, targets: EditTargets | null, cwd: string, env: AutoApprovalEnv): AutoApprovalDecision {
  if (!targets) return ask('편집 대상 경로를 읽지 못했다');
  if (targets.deletes && policy !== 'trust') return ask('파일을 지우는 편집');
  for (const p of targets.paths) {
    const v = pathVerdict(cwd, p, env);
    if (!v.inside) return ask(v.why);
  }
  return pass('edit-in-cwd', `작업 폴더 안의 파일 편집(${targets.paths.length}개)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 진입점
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 이 허가 요청을 사람에게 묻지 않고 통과시킬 것인가.
 * **어떤 경우에도 던지지 않는다** — 판정 중에 무슨 일이 나면 묻는 쪽으로 떨어진다.
 */
export function decideAutoApproval(policy: ApprovalPolicy, input: AutoApprovalInput, env: AutoApprovalEnv = {}): AutoApprovalDecision {
  if (policy !== 'edits' && policy !== 'trust') return ask('허가 방식이 "전부 묻기"');
  try {
    if (!input.cwd || !path.isAbsolute(input.cwd)) return ask('작업 폴더를 모른다');
    const { toolName, toolInput, cwd } = input;
    const norm = normalizeToolName(toolName);

    if (EDITING_TOOLS.has(toolName) || CODEX_EDITING_TOOLS.has(norm)) {
      return editVerdict(policy, editTargets(toolInput), cwd, env);
    }

    if (SHELL_TOOLS.has(toolName) || CODEX_SHELL_TOOLS.has(norm)) {
      const cmd = str(rec(toolInput).command);
      if (cmd === undefined) return ask('명령 문자열이 없다(배열·빈 값)');
      // 셸로 부른 apply_patch 는 편집이다(Codex).
      if (isApplyPatch(cmd)) return editVerdict(policy, editTargets({ command: cmd }), cwd, env);
      const ro = strictReadOnlyVerdict(cmd);
      if (ro.ok) {
        const outside = outsidePathIn(cmd, cwd, env);
        return outside ? ask(outside) : pass('read-only-shell', ro.why);
      }
      if (policy !== 'trust') return ask(ro.why);
      const plain = plainShellVerdict(cmd, cwd, env);
      return plain.ok ? pass('plain-shell', plain.why) : ask(plain.why);
    }

    // 읽기 도구가 여기까지 왔다면 폴더 밖이라 CLI 가 물은 것이다. 웹·MCP·모르는 도구도 전부 사람에게.
    return ask(`자동 허가 대상이 아닌 도구(${toolName})`);
  } catch (err) {
    return ask(`판정 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
}
