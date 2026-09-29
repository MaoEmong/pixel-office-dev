// 재시작 복구(T09)의 "기동 시 PID 정리". 01 §데몬 재시작 복구의 전제("데몬이 죽으면 ConPTY 자식도 죽는다")는
// 하드 킬(TerminateProcess)에서는 깨진다 — T09 통합 테스트에서 데몬을 process.kill 로 죽여도 claude.exe 가 살아남았다.
// 살아남은 자식은 같은 멤버 토큰으로 새 데몬에 hook 을 계속 보내고 세션 파일을 쥐고 있으므로 `--resume` 전에 정리한다.
// node-pty 는 재-attach 를 지원하지 않으니 "종료 후 resume" 뿐이다(설계 §데몬 재시작 복구).
//
// 안전장치: pid 가 재사용됐을 수 있으므로 프로세스 이름이 엔진 이름(claude/codex)을 포함할 때만 죽인다.
//
// 운영체제에 닿는 세 연산(생존·이미지 이름·트리 종료)은 `platform.ts` 하나로 모았다(T48-1 · D-48 원칙 2).
import { host } from '../platform.js';
import type { Engine } from '../store/types.js';

/** 복구가 유령 자식을 다루는 데 쓰는 최소 연산. 테스트에서 가짜로 대체한다. */
export interface OrphanOps {
  /** pid 가 살아 있는가. */
  alive(pid: number): boolean;
  /** 프로세스 이미지 이름(소문자, 예: 'claude.exe'). 모르면 undefined. */
  name(pid: number): string | undefined;
  /** 프로세스 트리 강제 종료(동기). */
  kill(pid: number): void;
}

export type OrphanVerdict = { action: 'killed' } | { action: 'not-alive' } | { action: 'skipped'; reason: string };

/**
 * 그 pid 를 죽여도 되는 이미지 이름인가.
 *
 * 기본은 D-17 그대로 — 이름에 엔진 이름(`claude`/`codex`)이 들어 있을 때만이다. **`node.exe` 는 기본으로 받지 않는다**:
 * 데몬·앱·npm 이 전부 node 라서, 재사용된 pid 하나로 엉뚱한 프로그램을 트리째 죽일 수 있다(T20/T09 가 이 경우를
 * 일부러 막아 놨다).
 *
 * T46-1 이 더한 것은 **실제로 띄운 실행 파일 이름**(`exeName`)을 같이 받는 길뿐이다. `PIXEL_CLAUDE_EXE` 가
 * 자바스크립트 진입점을 가리키면 자식이 `node.exe` 로 뜨는데, 그때는 데몬이 **자기가 그렇게 띄웠다는 것을 알고 있다** —
 * 그래서 "아무 node 나" 가 아니라 "내가 띄운 그 실행 파일" 이 조건이 된다.
 */
export function looksLikeEngine(name: string, engine: Engine, exeName?: string): boolean {
  const n = name.toLowerCase();
  if (n.includes(engine)) return true;
  const expected = exeName?.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  return expected !== undefined && expected !== '' && n.replace(/\.(exe|cmd|bat)$/, '') === expected;
}

/** 실행 파일 경로에서 이미지 이름만(`D:\x\node.exe` → `node.exe`). 빈 값이면 undefined. */
export function exeImageName(exePath: string | undefined): string | undefined {
  if (!exePath) return undefined;
  const base = exePath.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  return base && base !== '' ? base : undefined;
}

/**
 * 그 pid 가 우리 엔진 프로세스로 보이면 죽인다. 자기 자신·이름 불일치는 건너뛴다.
 * `opts.exeName` 은 데몬이 실제로 띄운 실행 파일 이름(위 `looksLikeEngine` 주석 — node 래퍼용).
 */
export function reapOrphan(ops: OrphanOps, pid: number, engine: Engine, opts: { exeName?: string } = {}): OrphanVerdict {
  if (pid === process.pid) return { action: 'skipped', reason: 'pid is the daemon itself' };
  if (!ops.alive(pid)) return { action: 'not-alive' };
  const name = ops.name(pid);
  if (!name) return { action: 'skipped', reason: 'process name unknown' };
  if (!looksLikeEngine(name, engine, opts.exeName)) return { action: 'skipped', reason: `process name ${name} does not look like ${engine}` };
  ops.kill(pid);
  return { action: 'killed' };
}

/**
 * 실제 OS 연산 — 전부 `platform.ts` 를 통해서만(윈도우 `tasklist`/`taskkill`, 유닉스 `ps`/`kill`).
 *
 * T48-1 에서 `alive` 가 **`EPERM` 을 "살아 있음" 으로** 세게 됐다(D-40 · parentWatch 와 같은 규칙으로 통일).
 * 예전에는 EPERM 을 "죽음" 으로 봐 남의 계정 프로세스를 못 봤는데, 어차피 [reapOrphan] 은 이미지 이름이
 * 엔진과 맞을 때만 죽이므로 "살아 있다" 고 보는 편이 안전하다 — 이름을 못 읽으면 그냥 건너뛴다.
 */
export const defaultOrphanOps: OrphanOps = {
  alive: (pid) => host.isProcessAlive(pid),
  name: (pid) => host.processImageName(pid),
  kill: (pid) => host.killTree(pid),
};
