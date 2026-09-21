// 데몬 로그의 목적지 (T46-3 실기 결함 ③ · D-47 §2·§3).
//
// ## 왜 이 파일이 있는가 — 윈도우에서 "읽는 쪽이 사라진 파이프" 는 프로세스를 통째로 멈춘다
//
// T46-2 부터 앱이 데몬을 **파이프 모드**로 띄운다(콘솔 창이 안 뜨는 유일한 모드). 그래서 데몬의
// stdout/stderr 를 읽는 사람은 **앱 하나뿐**이다. 앱을 `taskkill /F` 로 죽이면(설계 §3 이 바로 그 경우다)
// 그 파이프의 읽는 쪽이 사라지는데, 그 뒤 데몬이 `console.log` 를 한 줄만 써도:
//
//   - 그 write 가 **영영 완료되지 않고**,
//   - **이벤트 루프가 그 자리에서 멈춘다**(타이머도 더는 안 돈다),
//   - 프로세스는 **죽지도 않는다.**
//
// 실측(임시 재현, `pipe-parent2.mjs`/`pipe-child2.mjs`): 파이프를 읽던 부모를 죽인 순간 자식의
// 100ms 타이머가 그대로 멎었고(마지막 기록 t=3065ms), 8초 뒤에도 프로세스는 살아 있었다.
// 실기에서는 그대로 **데몬이 정리를 끝내지 못하고** `claude.exe`·`codex.exe` 가 영원히 남았다
// (T46-3 검증 5, 2분 30초 뒤에도 그대로).
//
// ## 그래서
//
// 앱이 띄운 데몬은 **stdout 을 아예 쓰지 않는다.** `PIXEL_DAEMON_LOG` 이 있으면 `console.*` 를
// 그 파일에 **직접** 이어 쓰도록 바꾼다(앱이 파이프를 읽어 옮겨 적지 않아도 된다). 이렇게 하면
//
//   - 앱이 죽어도 데몬은 막히지 않는다(파이프에 쓰는 것이 없다),
//   - **앱이 죽은 뒤의 로그도 남는다** — `부모 앱이 사라졌다`·`[office] 종료: …` 가 daemon.log 에 그대로 들어간다.
//     예전에는 그 줄들이 죽은 파이프로 흘러가 사라졌다(사고 원인을 볼 길이 없었다).
//
// 콘솔에서 띄운 데몬(`npm start`)은 이 환경변수가 없으므로 **예전 그대로** stdout 에 찍는다.
// 그리고 어느 쪽이든 stdout/stderr 의 `error` 를 먹어 둔다 — 끊긴 파이프가 uncaughtException 이 되면 안 된다.
import fs from 'node:fs';
import path from 'node:path';
import { formatWithOptions } from 'node:util';

/** 앱이 데몬에게 "로그는 여기에 직접 써라" 고 알려 주는 환경변수. */
export const DAEMON_LOG_ENV = 'PIXEL_DAEMON_LOG';

/** 한 줄로 만든다(console 과 같은 포맷 규칙, 색은 끈다 — 파일이다). */
export function formatLogLine(args: unknown[]): string {
  return formatWithOptions({ colors: false, depth: 4 }, ...(args as [unknown, ...unknown[]]));
}

/** 파일에 이어 쓰는 sink 하나. 실패는 삼킨다 — 로그 때문에 데몬이 멈추면 안 된다. */
export function fileSink(filePath: string): (args: unknown[]) => void {
  let broken = false;
  return (args: unknown[]) => {
    if (broken) return;
    try {
      fs.appendFileSync(filePath, formatLogLine(args) + '\n', 'utf8');
    } catch {
      // 한 번 실패하면 더 시도하지 않는다(폴더가 사라졌거나 권한이 없다).
      broken = true;
    }
  };
}

/**
 * 끊긴 stdout/stderr 가 uncaughtException 이 되지 않게 한다. 콘솔 실행에서도 해가 없다.
 * (이것만으로는 위의 "멈춤" 을 못 막는다 — 멈추는 것은 error 가 아니라 **완료되지 않는 write** 다.)
 */
export function guardStdioErrors(): void {
  for (const s of [process.stdout, process.stderr]) {
    try {
      if (s.listenerCount('error') === 0) s.on('error', () => {});
    } catch {
      // 스트림이 없는 환경(드물다) — 무시.
    }
  }
}

/**
 * `PIXEL_DAEMON_LOG` 이 있으면 `console.log/warn/error/info/debug` 를 그 파일로 돌린다(stdout 안 씀).
 * 없으면 아무것도 하지 않는다(콘솔 실행). 돌렸으면 true.
 */
export function installFileLog(filePath = process.env[DAEMON_LOG_ENV], target: Console = console): boolean {
  guardStdioErrors();
  const p = (filePath ?? '').trim();
  if (!p) return false;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  } catch {
    // 폴더를 못 만들면 sink 가 첫 쓰기에서 broken 이 된다 — 그래도 데몬은 돈다.
  }
  const write = fileSink(p);
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    target[level] = (...args: unknown[]) => write(args);
  }
  return true;
}
