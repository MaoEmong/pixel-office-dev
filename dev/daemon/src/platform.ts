// 운영체제에 닿는 코드는 **이 파일 하나**에 모은다 (T48-1 · D-48 원칙 2).
//
// 나머지 코드는 `host.xxx()` 또는 여기서 내보내는 함수만 부른다. `process.platform === 'win32'` 가 여기저기
// 흩어져 있으면 맥에서 하나씩 터진다(D-48 맥락: 데몬 18곳).
//
// 규칙 셋.
//   ① **윈도우 동작은 1비트도 바뀌지 않는다**(D-48 ⑧). 윈도우 분기는 옛 코드를 글자 그대로 옮긴 것이다 —
//      `tasklist` 인자·`taskkill` 인자·PowerShell 스크립트·안내 문구까지.
//   ② **맥 분기는 주입으로만 검증한다**(D-48 ⑨ · 원칙 4). 그래서 플랫폼·환경변수·홈 폴더·`spawnSync`·`kill` 을
//      전부 [PlatformDeps] 로 받는다. 테스트는 가짜 `spawnSync` 로 **인자와 출력 파싱**을 고정한다 —
//      이 PC 에서 진짜 `ps`/`kill` 을 부르는 테스트는 없다.
//   ③ **맥 = 유닉스**(원칙 5). `darwin` 과 `linux` 는 데이터 폴더 규칙만 다르고 나머지(`ps`/`kill`/`lsof`)는 같다.
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 데이터 폴더·npm 뿌리·실행 파일 경로에 쓰이는 폴더 이름. */
export const APP_DIR_NAME = 'pixel-office';

// ─────────────────────────────────────────────────────────────────────────────
// 주입구
// ─────────────────────────────────────────────────────────────────────────────

/** `spawnSync` 결과 중 우리가 보는 것만. */
export interface SpawnSyncResultLike {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

/** `spawnSync` 에 주는 것 중 우리가 쓰는 것만. */
export interface SpawnSyncOptionsLike {
  encoding?: 'utf8';
  windowsHide?: boolean;
  timeout?: number;
  stdio?: 'ignore';
  env?: NodeJS.ProcessEnv;
}

export type SpawnSyncLike = (file: string, args: readonly string[], options: SpawnSyncOptionsLike) => SpawnSyncResultLike;

/** 운영체제에 닿는 모든 입력. 테스트는 필요한 것만 덮어쓴다. */
export interface PlatformDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** 홈 폴더(`os.homedir()`). */
  homedir(): string;
  /** 자식 프로세스 동기 실행(`ps`/`tasklist`/`taskkill`/PowerShell). */
  spawnSync: SpawnSyncLike;
  /** 신호 보내기(`process.kill`). 살아 있는지 볼 때는 signal 0. */
  kill(pid: number, signal: number | NodeJS.Signals): void;
  /** 파일인가(`fs.statSync(p).isFile()`). 실행 파일 탐색이 쓴다 — 심볼릭 링크는 따라간다. */
  isFile(p: string): boolean;
  /** 폴더 목록(`fs.readdirSync`). 없으면 빈 배열. */
  readdir(p: string): string[];
}

/** 실제 운영체제에 붙은 기본값. */
export const realDeps: PlatformDeps = {
  platform: process.platform,
  env: process.env,
  homedir: () => os.homedir(),
  spawnSync: (file, args, options) => {
    const r = nodeSpawnSync(file, [...args], { ...options, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  },
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  isFile: (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  readdir: (p) => {
    try {
      return fs.readdirSync(p);
    } catch {
      return [];
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 실행 파일 탐색 결과 타입(옛 config.ts 에서 옮겨 옴 — 이름·모양 그대로)
// ─────────────────────────────────────────────────────────────────────────────

/** [Platform.resolveClaudeExeDetailed] 가 무엇을 어디서 찾았는지 — 못 찾았을 때 콘솔에 그대로 뿌린다. */
export interface ExeResolution {
  /** 쓸 실행 파일(못 찾으면 마지막 폴백 `claude`). */
  exe: string;
  /** 실제 파일을 찾았는가. */
  found: boolean;
  /** 찾아본 곳(사람이 읽는 한 줄씩). */
  tried: string[];
}

/** 운영체제에 닿는 연산 한 벌. [createPlatform] 이 만든다. */
export interface Platform {
  readonly platform: NodeJS.Platform;
  readonly isWindows: boolean;
  /** 데몬 상태·토큰·DB·멤버 지시문이 놓이는 폴더(`PIXEL_DATA_DIR` 이 모든 것을 덮는다). */
  dataDir(): string;
  /** 오류 문구에 쓰는 데이터 폴더 표기(`%LOCALAPPDATA%\pixel-office` 같은 사람이 읽는 형태). */
  dataDirLabel(): string;
  /** npm 전역 **뿌리**(윈도우는 prefix, 유닉스는 `lib/node_modules`) — 아래 함수 주석의 비대칭 설명을 볼 것. */
  npmGlobalRoots(): string[];
  /** 스코프 폴더(`@anthropic-ai`)를 **바로 품는** 폴더들. 패키지 경로 계산은 전부 이것을 쓴다. */
  npmModulesRoots(): string[];
  resolveClaudeExeDetailed(): ExeResolution;
  resolveClaudeExe(): string;
  resolveCodexExe(): string;
  /** pid 가 살아 있는가(`EPERM` 도 살아 있음 — D-40). */
  isProcessAlive(pid: number): boolean;
  /** 프로세스 이미지 이름(소문자, 예: `claude.exe` · `claude`). 모르면 undefined. */
  processImageName(pid: number): string | undefined;
  /** 프로세스 **트리** 강제 종료(동기). */
  killTree(pid: number): void;
  /** 프로세스 시작 시각(ms epoch). 모르면 undefined. 비싼 호출 — 폴링에 쓰지 않는다. */
  processStartTime(pid: number): number | undefined;
  /** "이 pid 를 끄세요" 안내 문구. */
  hintForKillingPid(pid: number): string;
  /** "그 포트를 쥔 범인을 찾으세요" 안내 문구. */
  hintForFindingPortOwner(port: number): string;
  /** 정중히 종료해야 하는 신호 목록(유닉스는 `SIGHUP` 포함 — 터미널 닫힘). */
  shutdownSignals(): NodeJS.Signals[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 작은 순수 헬퍼(테스트가 직접 부른다)
// ─────────────────────────────────────────────────────────────────────────────

/** 버전 폴더 이름(`2.1.270` · `v24.8.0`) 비교 — 내림차순(높은 버전이 앞). 숫자 조각만 본다. */
export function compareVersionDesc(a: string, b: string): number {
  const nums = (s: string) => s.replace(/^v/, '').split('.').map(Number);
  const pa = nums(a);
  const pb = nums(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 실행 파일 경로에서 이미지 이름만(`/usr/bin/claude` → `claude`). 빈 값이면 undefined. */
export function baseName(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const base = p.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  return base && base !== '' ? base : undefined;
}

/**
 * `ps -p <pid> -o lstart=` 한 줄을 ms epoch 으로. `LC_ALL=C` 를 고정해 받으므로 형식은 한 가지다:
 * `Mon Sep 29 10:11:12 2026`(요일 · 달 · 일 · 시:분:초 · 연). `Date.parse` 에 맡기지 않는 이유는
 * 엔진·로캘에 따라 해석이 갈릴 수 있기 때문이다 — 여기서 손으로 뜯어 **지역 시간**으로 만든다.
 */
export function parseLstart(text: string): number | undefined {
  const m = /^\s*[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(text);
  if (!m) return undefined;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = months.indexOf(m[1]!.toLowerCase());
  if (month < 0) return undefined;
  const ms = new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/** `ps -axo pid=,ppid=` 출력 → `{pid, ppid}` 목록. 숫자 두 개가 아닌 줄은 버린다. */
export function parsePidPpid(text: string): Array<{ pid: number; ppid: number }> {
  const rows: Array<{ pid: number; ppid: number }> = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  return rows;
}

/**
 * 트리를 **아래부터** 죽이는 순서. 맥 `ps` 에는 `--ppid` 가 없어 `ps -axo pid=,ppid=` 전체를 읽어 트리를
 * 만든다(설계 표). 반환 순서 = 자식(깊은 쪽) 먼저, 뿌리 마지막 — 부모를 먼저 죽이면 자식이 고아가 되어
 * `init` 에 붙고 다음 조회에서 사라진다.
 */
export function killOrder(rows: Array<{ pid: number; ppid: number }>, root: number): number[] {
  const children = new Map<number, number[]>();
  for (const { pid, ppid } of rows) {
    if (pid === ppid) continue; // 자기 부모인 줄(방어)
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const bfs: number[] = [root];
  const seen = new Set<number>([root]);
  for (let i = 0; i < bfs.length; i++) {
    for (const child of children.get(bfs[i]!) ?? []) {
      if (seen.has(child)) continue; // 순환 방어
      seen.add(child);
      bfs.push(child);
    }
  }
  return bfs.reverse();
}

/** `tasklist /FO CSV /NH` 한 줄에서 이미지 이름(소문자). pid 가 물어본 것과 다르면 undefined. */
export function parseTasklistCsv(text: string, pid: number): string | undefined {
  // "claude.exe","14932","Console","1","265,524 K"
  const m = /^"([^"]+)","(\d+)"/.exec(text.trim());
  return m && Number(m[2]) === pid ? m[1]!.toLowerCase() : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 본체
// ─────────────────────────────────────────────────────────────────────────────

/** npm 전역 설치 안에서 codex 실행 파일이 놓이는 곳: `<modulesRoot>/@openai/codex/node_modules/@openai/codex-<plat>/vendor/<target>/bin/codex(.exe)`. */
const CODEX_SCOPE_SEGMENTS = ['@openai', 'codex', 'node_modules', '@openai'];

export function createPlatform(over: Partial<PlatformDeps> = {}): Platform {
  const deps: PlatformDeps = { ...realDeps, ...over };
  const { env, platform } = deps;
  const win = platform === 'win32';
  const home = () => deps.homedir();

  /** PATH 에서 실행 파일(확장자까지 맞는 것)을 찾는다. */
  const onPath = (exeName: string): string | undefined => {
    for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir.replace(/^"|"$/g, ''), exeName);
      if (deps.isFile(candidate)) return candidate;
    }
    return undefined;
  };

  /** `<parent>/<버전>/…` 꼴 폴더를 최신 버전 먼저 나열한다(nvm `v24.8.0` · volta `24.8.0`). */
  const versionDirs = (parent: string): string[] =>
    deps
      .readdir(parent)
      .filter((n) => /^v?\d+(\.\d+)*$/.test(n))
      .sort(compareVersionDesc)
      .map((n) => path.join(parent, n));

  const npmGlobalRoots = (): string[] => {
    if (win) {
      // 윈도우는 예전 그대로 **prefix 뿌리**다(`%APPDATA%\npm` 아래에 `node_modules` 가 있다).
      return [
        path.join(env.APPDATA || path.join(home(), 'AppData', 'Roaming'), 'npm'),
        path.join(env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local'), 'npm'),
        path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
      ];
    }
    // 유닉스는 **`lib/node_modules` 까지** 가 뿌리다(`$(npm prefix -g)/lib/node_modules`).
    // `npm prefix -g` 는 프로세스를 하나 띄우는 비싼 호출이라 부르지 않는다 — 대신 `PIXEL_NPM_PREFIX`,
    // 없으면 잘 알려진 자리들. 맥에서 다른 자리에 깔려 있으면 2단계 대본 M2 가 그것을 알려 준다.
    const prefix = env.PIXEL_NPM_PREFIX;
    if (prefix) return [path.join(prefix, 'lib', 'node_modules')];
    const modules = (p: string) => path.join(p, 'lib', 'node_modules');
    return [
      '/opt/homebrew/lib/node_modules', // Homebrew (Apple Silicon)
      '/usr/local/lib/node_modules', // Homebrew (Intel) · 직접 설치
      modules(path.join(home(), '.npm-global')), // `npm config set prefix`
      ...versionDirs(path.join(home(), '.nvm', 'versions', 'node')).map(modules), // nvm — 최신 버전 먼저
      ...versionDirs(path.join(home(), '.volta', 'tools', 'image', 'node')).map(modules), // volta
    ];
  };

  /**
   * 스코프 폴더를 바로 품는 폴더들. 윈도우 뿌리는 prefix 라 `node_modules` 를 한 칸 더 붙이고, 유닉스 뿌리는
   * 이미 `lib/node_modules` 라 그대로 쓴다 — 이 비대칭을 **여기 한 곳에서만** 흡수한다(호출처는 전부 이것을 쓴다).
   */
  const npmModulesRoots = (): string[] => (win ? npmGlobalRoots().map((r) => path.join(r, 'node_modules')) : npmGlobalRoots());

  /** `%APPDATA%\Claude\claude-code\<semver>\claude.exe` 중 **가장 높은 버전**(윈도우 전용 단계). */
  const newestClaudeBundle = (appData: string, exeName: string): { exe?: string; root: string } => {
    const root = path.join(appData, 'Claude', 'claude-code');
    for (const dir of deps
      .readdir(root)
      .filter((n) => /^\d+(\.\d+)*$/.test(n))
      .sort(compareVersionDesc)) {
      const exe = path.join(root, dir, exeName);
      if (deps.isFile(exe)) return { exe, root };
    }
    return { root };
  };

  /** `<modulesRoot>` 아래 vendor 트리에서 codex 실행 파일(플랫폼 패키지·타깃 폴더 이름은 버전마다 달라 스캔한다). */
  const codexVendorExe = (modulesRoot: string, exeName: string): string | undefined => {
    const scope = path.join(modulesRoot, ...CODEX_SCOPE_SEGMENTS);
    for (const pkg of deps
      .readdir(scope)
      .filter((n) => n.startsWith('codex-'))
      .sort()) {
      const vendor = path.join(scope, pkg, 'vendor');
      for (const target of deps.readdir(vendor).sort()) {
        const exe = path.join(vendor, target, 'bin', exeName);
        if (deps.isFile(exe)) return exe;
      }
    }
    return undefined;
  };

  const ps = (args: readonly string[], extraEnv?: NodeJS.ProcessEnv): string => {
    const out = deps.spawnSync('ps', args, {
      encoding: 'utf8',
      timeout: 5000,
      ...(extraEnv ? { env: { ...env, ...extraEnv } } : {}),
    });
    return (out.stdout ?? '').trim();
  };

  const self: Platform = {
    platform,
    isWindows: win,

    dataDir() {
      if (env.PIXEL_DATA_DIR) return env.PIXEL_DATA_DIR;
      if (win) return path.join(env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local'), APP_DIR_NAME);
      if (platform === 'darwin') return path.join(home(), 'Library', 'Application Support', APP_DIR_NAME);
      return path.join(env.XDG_DATA_HOME || path.join(home(), '.local', 'share'), APP_DIR_NAME);
    },

    dataDirLabel() {
      if (win) return `%LOCALAPPDATA%\\${APP_DIR_NAME}`;
      if (platform === 'darwin') return `~/Library/Application Support/${APP_DIR_NAME}`;
      return `$XDG_DATA_HOME/${APP_DIR_NAME}`;
    },

    npmGlobalRoots,
    npmModulesRoots,

    /**
     * `config.claudeExe` 결정(T41 · T48-1).
     *   1. `PIXEL_CLAUDE_EXE` (지정한 경로를 그대로 쓴다)
     *   2. PATH 의 **진짜** 실행 파일
     *      - 윈도우: `.cmd`/`.ps1` 셰임은 node-pty(ConPTY)가 못 띄운다(T20 함정 4) → 확장자가 `.exe` 인 것만 센다.
     *      - 유닉스: **셰뱅 스크립트(`#!/usr/bin/env node`)도 실행 파일이다** — node-pty 의 유닉스 구현은
     *        `execvp` 로 띄우므로 커널이 셰뱅을 처리한다. 심볼릭 링크도 `statSync` 가 따라간다. 그래서
     *        "셰임 제외" 규칙은 **윈도우 전용**이다(설계 표의 그 줄).
     *   3. npm 전역 `<modulesRoot>/@anthropic-ai/claude-code/bin/claude(.exe)`
     *   4. (윈도우만) `%APPDATA%\Claude\claude-code\<버전>\claude.exe` 중 가장 높은 버전 — **맥엔 앱 번들 탐색이 없다**
     *      (설계 표: "앱 번들 탐색은 건너뜀"). 맥 데스크탑 앱은 CLI 를 이런 모양으로 깔지 않는다.
     *   5. 못 찾으면 `'claude'` + [ExeResolution.tried] 로 "어디를 봤는지" 를 남긴다
     */
    resolveClaudeExeDetailed(): ExeResolution {
      const tried: string[] = [];
      if (env.PIXEL_CLAUDE_EXE) return { exe: env.PIXEL_CLAUDE_EXE, found: true, tried: ['PIXEL_CLAUDE_EXE'] };
      tried.push('PIXEL_CLAUDE_EXE 없음');

      const exeName = win ? 'claude.exe' : 'claude';
      const onPathExe = onPath(exeName);
      if (onPathExe) return { exe: onPathExe, found: true, tried: [...tried, `PATH: ${onPathExe}`] };
      tried.push(win ? `PATH 에 ${exeName} 없음(.cmd/.ps1 셰임은 세지 않는다)` : `PATH 에 ${exeName} 없음(셰뱅 스크립트도 실행 파일로 본다)`);

      // npm 전역 설치(`npm i -g @anthropic-ai/claude-code`): 윈도우 PATH 에는 `claude.cmd` 셰임만 오르고 실제 exe 는
      // `<modulesRoot>/@anthropic-ai/claude-code/bin/` 에 있다(실측 2.1.278). codex 와 같은 뿌리를 뒤진다.
      for (const root of npmModulesRoots()) {
        const exe = path.join(root, '@anthropic-ai', 'claude-code', 'bin', exeName);
        if (deps.isFile(exe)) return { exe, found: true, tried: [...tried, `npm 전역: ${exe}`] };
      }
      tried.push(`npm 전역에 @anthropic-ai/claude-code/bin/${exeName} 없음`);

      if (win) {
        const appData = env.APPDATA || path.join(home(), 'AppData', 'Roaming');
        const { exe, root } = newestClaudeBundle(appData, exeName);
        if (exe) return { exe, found: true, tried: [...tried, `번들: ${exe}`] };
        tried.push(`번들 없음: ${root}\\<버전>\\${exeName}`);
      }
      return { exe: 'claude', found: false, tried };
    },

    resolveClaudeExe() {
      return self.resolveClaudeExeDetailed().exe;
    },

    /**
     * `config.codexExe` 결정(T22 · T48-1).
     *   1. `PIXEL_CODEX_EXE`
     *   2. npm 전역의 `@openai/codex` vendor 안 진짜 `codex(.exe)`
     *   3. PATH 의 `codex(.exe)`
     *   4. 못 찾으면 `'codex'` — 스폰이 실패하면서 오류로 드러난다(조용히 다른 것을 띄우지 않는다)
     */
    resolveCodexExe() {
      if (env.PIXEL_CODEX_EXE) return env.PIXEL_CODEX_EXE;
      const exeName = win ? 'codex.exe' : 'codex';
      for (const root of npmModulesRoots()) {
        const found = codexVendorExe(root, exeName);
        if (found) return found;
      }
      return onPath(exeName) ?? 'codex';
    },

    /**
     * pid 생존. 윈도우·유닉스 모두 `kill(pid, 0)` 한 번이다 — 노드가 윈도우에서는 `OpenProcess` 로 바꿔 주므로
     * `tasklist` 를 띄울 필요가 없다(옛 코드도 이렇게 했다 = 윈도우 동작 그대로). `EPERM` 은 "내 것이 아니지만
     * 살아 있음" 이다(D-40 ①).
     */
    isProcessAlive(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        deps.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException)?.code === 'EPERM';
      }
    },

    processImageName(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      try {
        if (win) {
          const out = deps.spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 5000,
          });
          return parseTasklistCsv(out.stdout ?? '', pid);
        }
        // 맥·리눅스: `comm` 은 경로가 붙어 나올 수 있어(리눅스는 이름만, 맥은 `/usr/bin/…`) basename 을 쓴다.
        const comm = baseName(ps(['-p', String(pid), '-o', 'comm=']));
        return comm ? comm.toLowerCase() : undefined;
      } catch {
        return undefined;
      }
    },

    killTree(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return;
      if (win) {
        deps.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
        return;
      }
      // 맥 `ps` 에는 `--ppid` 가 없다 → 전체를 **한 번** 읽어 트리를 만들고 아래부터 SIGKILL(설계 표).
      let order: number[] = [pid];
      try {
        order = killOrder(parsePidPpid(ps(['-axo', 'pid=,ppid='])), pid);
      } catch {
        // ps 가 실패하면 적어도 당사자는 죽인다.
      }
      for (const target of order) {
        try {
          deps.kill(target, 'SIGKILL');
        } catch {
          // 이미 죽었거나 권한이 없다 — 다음 pid 로 넘어간다.
        }
      }
    },

    processStartTime(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      try {
        if (win) {
          const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString("o")`;
          const out = deps.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 5000,
          });
          const ms = Date.parse((out.stdout ?? '').trim());
          return Number.isFinite(ms) ? ms : undefined;
        }
        // 로캘을 `LC_ALL=C` 로 못 박아 `Mon Sep 29 10:11:12 2026` 한 형식만 받는다(설계 표).
        return parseLstart(ps(['-p', String(pid), '-o', 'lstart='], { LC_ALL: 'C' }));
      } catch {
        return undefined;
      }
    },

    hintForKillingPid(pid) {
      return win ? `taskkill /F /PID ${pid}` : `kill ${pid}`;
    },

    hintForFindingPortOwner(port) {
      return win ? `netstat -ano | findstr :${port}   →   taskkill /F /PID <pid>` : `lsof -i :${port}   →   kill <pid>`;
    },

    /**
     * 정중히 종료해야 하는 신호. 유닉스는 **터미널이 닫힐 때 오는 `SIGHUP`** 도 같은 정리를 타야 한다
     * (설계 표 "종료 신호"). 윈도우 노드는 `SIGHUP` 을 콘솔 닫힘에 흉내내 올리기도 하지만 공식 계약이 아니라
     * 걸지 않는다 — 윈도우 동작은 그대로(`SIGINT`/`SIGTERM`).
     */
    shutdownSignals() {
      return win ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    },
  };
  return self;
}

/** 실제 운영체제에 붙은 한 벌. 코드는 보통 이것만 쓴다. */
export const host: Platform = createPlatform();

// ─────────────────────────────────────────────────────────────────────────────
// 옛 이름 유지용 얇은 함수들 (config.ts 가 다시 내보낸다 — 호출처·테스트가 이 모양을 쓴다)
// ─────────────────────────────────────────────────────────────────────────────

/** 데이터 폴더(`PIXEL_DATA_DIR` → OS 별 기본). 플랫폼·환경을 주면 그 조합으로 계산한다(테스트). */
export function dataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return createPlatform({ env, platform }).dataDir();
}

/** npm 전역 뿌리(테스트용 얇은 함수 — 본체는 [Platform.npmGlobalRoots]). */
export function npmGlobalRoots(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  return createPlatform({ env, platform }).npmGlobalRoots();
}

export function resolveClaudeExeDetailed(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ExeResolution {
  return createPlatform({ env, platform }).resolveClaudeExeDetailed();
}

export function resolveClaudeExe(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return createPlatform({ env, platform }).resolveClaudeExe();
}

export function resolveCodexExe(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return createPlatform({ env, platform }).resolveCodexExe();
}

/** 신호 등록에 필요한 `process` 의 일부(테스트가 가짜로 바꿔 끼운다). */
export interface SignalTarget {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
}

/**
 * 종료 신호 핸들러를 건다. 등록한 신호 목록을 돌려준다 — **유닉스에서만 `SIGHUP` 이 들어 있다**(T48-1 §4).
 * 진입점(`index.ts`)이 부르고, 테스트는 가짜 `target` 으로 등록 목록을 확인한다.
 */
export function installShutdownSignals(
  onSignal: (signal: NodeJS.Signals) => void,
  opts: { platform?: Platform; target?: SignalTarget } = {},
): NodeJS.Signals[] {
  const plat = opts.platform ?? host;
  const target = opts.target ?? process;
  const signals = plat.shutdownSignals();
  for (const sig of signals) target.on(sig, () => onSignal(sig));
  return signals;
}
