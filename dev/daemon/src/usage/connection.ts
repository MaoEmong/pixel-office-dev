// 연결 여부 폴링(T43, D-45 ④). `claude auth status` / `codex login status` 를 **짧은 타임아웃**으로 한 번 돌린다.
//
// 왜 이 두 명령인가: 자격 증명 파일을 읽지 않고 회사 서버에 직접 묻지 않는다는 것이 D-45 ① 이다. CLI 가 스스로
// 내주는 것만 쓴다. 둘 다 싸다 — 실측 `auth status` 약 0.27초, `login status` 약 0.06초.
//
// 판정(설계 문서 그대로):
//   실행 파일이 없다      → connected:false, reason:'not-installed'
//   로그인이 안 돼 있다    → connected:false, reason:'logged-out'
//   오류·타임아웃·모르겠다 → connected:false, reason:'unknown'  ("값 없음" 과 "연결 안 됨" 은 다른 상태다 —
//                            여기서 unknown 은 "물어봤는데 대답을 못 들었다" 이지 한도를 모른다는 뜻이 아니다)
//
// 스폰할 때 `CLAUDE_CODE*` · `CLAUDE_CONFIG_DIR` 은 지운다(pty/env.ts 와 같은 규칙) — 데몬의 부모가 Claude Code 면
// 그 환경이 새어 엉뚱한 설정 폴더의 로그인 상태를 읽는다.
import { execFile } from 'node:child_process';
import { resolveClaudeExeDetailed, resolveCodexExe } from '../config.js';
import { stripDaemonEnv } from '../pty/env.js';
import { parseClaudeAuthStatus, parseCodexLoginStatus } from './parse/connection.js';
import type { EngineConnection } from './types.js';

/** 연결 확인 명령의 상한. 실측이 0.3초 이하라 5초면 넉넉하다 — 넘으면 'unknown'. */
export const PROBE_TIMEOUT_MS = 5_000;

/** `execFile` 한 번의 결과(테스트가 이 자리에 가짜를 꽂는다). */
export interface RunResult {
  stdout: string;
  stderr: string;
  /** 정상 종료면 종료 코드, 못 띄웠으면 null. */
  exitCode: number | null;
  /** 스폰 실패 코드(`ENOENT` 등). 없으면 undefined. */
  errorCode?: string;
  /** 타임아웃으로 죽였는가. */
  timedOut?: boolean;
}

export type RunCommand = (file: string, args: string[], timeoutMs: number) => Promise<RunResult>;

/** 기본 실행기. 절대 reject 하지 않는다 — 실패도 RunResult 로 돌려준다. */
export const runCommand: RunCommand = (file, args, timeoutMs) =>
  new Promise<RunResult>((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, env: stripDaemonEnv(process.env) },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: string | number; killed?: boolean }) | null;
        if (!e) return resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 });
        const code = e.code;
        // execFile 은 종료 코드(number)와 스폰 오류(string code)를 같은 자리에 담는다.
        const exitCode = typeof code === 'number' ? code : null;
        const errorCode = typeof code === 'string' ? code : undefined;
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode,
          ...(errorCode !== undefined ? { errorCode } : {}),
          ...(e.killed === true ? { timedOut: true } : {}),
        });
      },
    );
  });

export interface ProbeOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  run?: RunCommand;
}

const NOT_INSTALLED: EngineConnection = { connected: false, plan: null, reason: 'not-installed' };
const UNKNOWN: EngineConnection = { connected: false, plan: null, reason: 'unknown' };
const LOGGED_OUT: EngineConnection = { connected: false, plan: null, reason: 'logged-out' };

/** 스폰 자체가 실패했는가(파일 없음 계열). */
function isMissingExe(res: RunResult): boolean {
  return res.errorCode === 'ENOENT' || res.errorCode === 'EACCES' || res.errorCode === 'ENOTDIR';
}

/**
 * Claude 연결 확인. 실행 파일은 `config.ts` 의 T41 해석기(`PIXEL_CLAUDE_EXE` → PATH → 번들 최신 버전)를 그대로 쓴다 —
 * 찾지 못했으면(`found:false`) 띄워 보지도 않고 'not-installed'.
 */
export async function probeClaudeConnection(opts: ProbeOptions = {}): Promise<EngineConnection> {
  const resolved = resolveClaudeExeDetailed(opts.env ?? process.env, opts.platform ?? process.platform);
  if (!resolved.found) return { ...NOT_INSTALLED };
  const run = opts.run ?? runCommand;
  const res = await run(resolved.exe, ['auth', 'status'], opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  if (isMissingExe(res)) return { ...NOT_INSTALLED };
  if (res.timedOut) return { ...UNKNOWN };
  const parsed = parseClaudeAuthStatus(res.stdout);
  if (parsed.loggedIn === true) return { connected: true, plan: parsed.plan, reason: null };
  if (parsed.loggedIn === false) return { ...LOGGED_OUT };
  return { ...UNKNOWN }; // JSON 이 아니다 = 명령 모양이 바뀌었거나 다른 오류
}

/**
 * Codex 연결 확인. `resolveCodexExe` 는 못 찾으면 맨 이름 `'codex'` 로 떨어지므로(그때는 스폰이 ENOENT 로
 * 실패한다) 여기서는 **띄워 보고** 판정한다 — `PIXEL_CODEX_EXE` 를 없는 경로로 준 경우도 같은 길로 걸린다.
 */
export async function probeCodexConnection(opts: ProbeOptions = {}): Promise<EngineConnection> {
  const exe = resolveCodexExe(opts.env ?? process.env, opts.platform ?? process.platform);
  const run = opts.run ?? runCommand;
  const res = await run(exe, ['login', 'status'], opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  if (isMissingExe(res)) return { ...NOT_INSTALLED };
  if (res.timedOut) return { ...UNKNOWN };
  const parsed = parseCodexLoginStatus(res.stdout, res.exitCode ?? -1);
  if (parsed.loggedIn === true) return { connected: true, plan: null, reason: null };
  if (parsed.loggedIn === false) return { ...LOGGED_OUT };
  return { ...UNKNOWN };
}
