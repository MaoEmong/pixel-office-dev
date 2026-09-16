// 데몬 공통 설정. 환경변수로 덮어쓸 수 있는 것만 여기에.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

/** npm 전역 설치 안에서 실제 실행 파일이 놓이는 경로: `<npmRoot>/node_modules/@openai/codex/node_modules/@openai/codex-<plat>/vendor/<target>/bin/codex(.exe)`. */
const CODEX_SCOPE_SEGMENTS = ['node_modules', '@openai', 'codex', 'node_modules', '@openai'];

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `<npmRoot>` 아래 vendor 트리에서 codex 실행 파일을 찾는다(플랫폼 패키지 이름·타깃 폴더는 버전마다 달라 스캔한다). */
function codexVendorExe(npmRoot: string, exeName: string): string | undefined {
  const scope = path.join(npmRoot, ...CODEX_SCOPE_SEGMENTS);
  let platformPkgs: string[];
  try {
    platformPkgs = fs.readdirSync(scope).filter((n) => n.startsWith('codex-'));
  } catch {
    return undefined;
  }
  for (const pkg of platformPkgs.sort()) {
    const vendor = path.join(scope, pkg, 'vendor');
    let targets: string[];
    try {
      targets = fs.readdirSync(vendor);
    } catch {
      continue;
    }
    for (const target of targets.sort()) {
      const exe = path.join(vendor, target, 'bin', exeName);
      if (isFile(exe)) return exe;
    }
  }
  return undefined;
}

/** PATH 에서 실행 파일(확장자까지 맞는 것)을 찾는다. `.cmd`/`.ps1` 셰임은 node-pty 가 못 띄우므로 세지 않는다(T20 함정 4). */
function onPath(exeName: string, pathVar: string | undefined): string | undefined {
  for (const dir of (pathVar ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir.replace(/^"|"$/g, ''), exeName);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * `config.codexExe` 결정(T22). node-pty(ConPTY)는 PATH 의 `codex.cmd`/`codex.ps1` 셰임을 띄우지 못한다(T20 함정 4) —
 * 그래서 **실제 실행 파일**을 찾아 둔다.
 *   1. `PIXEL_CODEX_EXE` (사용자가 지정한 경로를 그대로 쓴다)
 *   2. npm 전역(`%APPDATA%\npm`, `%LOCALAPPDATA%\npm`, `%ProgramFiles%\nodejs`) 의 `@openai/codex` vendor 안 `codex.exe`
 *   3. PATH 에 있는 진짜 `codex.exe`(셰임 제외)
 *   4. 못 찾으면 `'codex'` — 스폰이 실패하면서 오류로 드러난다(조용히 다른 것을 띄우지 않는다)
 */
export function resolveCodexExe(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.PIXEL_CODEX_EXE) return env.PIXEL_CODEX_EXE;
  const win = platform === 'win32';
  const exeName = win ? 'codex.exe' : 'codex';
  const roots = win
    ? [
        path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm'),
        path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'npm'),
        path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
      ]
    : ['/usr/local', '/usr/local/lib', path.join(os.homedir(), '.npm-global'), path.join(os.homedir(), '.local')];
  for (const root of roots) {
    const found = codexVendorExe(root, exeName);
    if (found) return found;
  }
  return onPath(exeName, env.PATH ?? env.Path) ?? 'codex';
}

export const config = {
  /** WebSocket(JSON-RPC) 포트. */
  wsPort: Number(process.env.PIXEL_WS_PORT || 7420),
  /** hook 수신 HTTP 포트 (hook.js 가 POST). */
  hookPort: Number(process.env.PIXEL_HOOK_PORT || 7421),
  /** TeamTools MCP(Streamable HTTP) 포트. CLI 세션이 `/mcp/<memberToken>` 으로 붙는다(T17). */
  mcpPort: Number(process.env.PIXEL_MCP_PORT || 7422),
  /** 데몬 상태·토큰·DB·멤버 지시문이 놓이는 폴더. */
  dataDir: process.env.PIXEL_DATA_DIR || path.join(localAppData, 'pixel-office'),
  /** claude 실행 파일. PATH 에 있으면 'claude', 없으면 데스크탑 앱 번들 경로. */
  claudeExe:
    process.env.PIXEL_CLAUDE_EXE ||
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code', '2.1.270', 'claude.exe'),
  /**
   * codex 실행 파일. `PIXEL_CODEX_EXE` 로 덮어쓸 수 있고, 없으면 npm 전역의 실제 `codex.exe` 를 찾는다(resolveCodexExe).
   * PATH 의 `codex`(.cmd/.ps1 셰임)는 node-pty 가 못 띄우므로 기본값으로 쓰지 않는다(T20 함정 4).
   */
  codexExe: resolveCodexExe(),
  /** 세션 hooks 의 timeout(초). 허가·질문 보류 상한 — D-16: 600이면 10분 뒤 CLI가 hook을 끊고 TUI 프롬프트로 폴백한다. */
  hookTimeoutSec: Number(process.env.PIXEL_HOOK_TIMEOUT_SEC || 86400),
  /** 기본 터미널 크기. */
  cols: 120,
  rows: 40,
};

export type Config = typeof config;
