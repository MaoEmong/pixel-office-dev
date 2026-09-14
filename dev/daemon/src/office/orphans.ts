// 재시작 복구(T09)의 "기동 시 PID 정리". 01 §데몬 재시작 복구의 전제("데몬이 죽으면 ConPTY 자식도 죽는다")는
// 하드 킬(TerminateProcess)에서는 깨진다 — T09 통합 테스트에서 데몬을 process.kill 로 죽여도 claude.exe 가 살아남았다.
// 살아남은 자식은 같은 멤버 토큰으로 새 데몬에 hook 을 계속 보내고 세션 파일을 쥐고 있으므로 `--resume` 전에 정리한다.
// node-pty 는 재-attach 를 지원하지 않으니 "종료 후 resume" 뿐이다(설계 §데몬 재시작 복구).
//
// 안전장치: pid 가 재사용됐을 수 있으므로 프로세스 이름이 엔진 이름(claude/codex)을 포함할 때만 죽인다.
import { spawnSync } from 'node:child_process';
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

/** 그 pid 가 우리 엔진 프로세스로 보이면 죽인다. 자기 자신·이름 불일치는 건너뛴다. */
export function reapOrphan(ops: OrphanOps, pid: number, engine: Engine): OrphanVerdict {
  if (pid === process.pid) return { action: 'skipped', reason: 'pid is the daemon itself' };
  if (!ops.alive(pid)) return { action: 'not-alive' };
  const name = ops.name(pid);
  if (!name) return { action: 'skipped', reason: 'process name unknown' };
  if (!name.includes(engine)) return { action: 'skipped', reason: `process name ${name} does not look like ${engine}` };
  ops.kill(pid);
  return { action: 'killed' };
}

/** 실제 OS 연산. win32 는 tasklist/taskkill, 그 외는 ps/kill. */
export const defaultOrphanOps: OrphanOps = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  name(pid) {
    try {
      if (process.platform === 'win32') {
        const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        // "claude.exe","14932","Console","1","265,524 K"
        const m = /^"([^"]+)","(\d+)"/.exec((out.stdout ?? '').trim());
        return m && Number(m[2]) === pid ? m[1]!.toLowerCase() : undefined;
      }
      const out = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
      const comm = (out.stdout ?? '').trim();
      return comm ? comm.toLowerCase() : undefined;
    } catch {
      return undefined;
    }
  },
  kill(pid) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
      return;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 이미 죽음
    }
  },
};
