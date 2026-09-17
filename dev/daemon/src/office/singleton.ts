// 데몬은 하나만 (T30 / T38 함정 ⑤).
//
// 같은 `PIXEL_DATA_DIR` 을 두 데몬이 동시에 열면 SQLite 마이그레이션 중 읽기가 깨지고(T38 실기), hook·ws·mcp 포트가
// 겹쳐 EADDRINUSE 로 절반만 뜬 데몬이 남는다. 그래서 기동 때 `daemon.json` 의 pid 가 **살아 있고 그 ws 포트가 실제로
// 듣고 있으면** 거부한다(exit 3). pid 가 죽었으면 옛날처럼 그냥 덮어쓴다 — 크래시 후 재기동을 막으면 안 된다.
//
// 탈출구: `PIXEL_FORCE_START=1`. 통합 테스트는 그 대신 **각자의 `PIXEL_DATA_DIR`** 을 쓴다(그게 원래 규칙이다).
//
// T41(실기): daemon.json 이 **안 보이는데 포트만 잡혀 있는** 경우가 있다 — 다른 환경(샌드박스·다른 사용자)에서
// 띄운 데몬은 자기 `%LOCALAPPDATA%` 에 daemon.json 을 쓰므로 이쪽 pid 검사는 통과해 버리고, 그다음 hook/mcp/ws
// 바인딩이 EADDRINUSE 로 터진다. 예전에는 그게 **잡히지 않은 스택 트레이스**로 나왔다. 이제는 pid 검사와 **같은
// 문구·같은 exit 3** 으로 거부한다(`bindOrRefuse`).
import fs from 'node:fs';
import net from 'node:net';

/** 기동 거부 시의 프로세스 종료 코드. */
export const DAEMON_BUSY_EXIT_CODE = 3;
/** ws 포트 확인 제한 시간. 로컬 루프백이라 짧아도 된다. */
export const PORT_PROBE_TIMEOUT_MS = 400;
/** 강제 기동 환경변수. */
export const FORCE_START_ENV = 'PIXEL_FORCE_START';

export interface SingletonProbe {
  /** 그 pid 의 프로세스가 살아 있는가. */
  isPidAlive(pid: number): boolean;
  /** 127.0.0.1:port 가 듣고 있는가. */
  isPortOpen(port: number): Promise<boolean>;
}

/** 기동 거부의 공통 조상 — 진입점은 이것만 보고 "메시지 한 문단 + exit 3" 으로 끝낸다. */
export class DaemonStartRefusedError extends Error {
  readonly exitCode = DAEMON_BUSY_EXIT_CODE;
}

/** 이미 다른 데몬이 돌고 있어 기동을 거부했다. */
export class DaemonAlreadyRunningError extends DaemonStartRefusedError {
  constructor(
    readonly pid: number,
    readonly wsPort: number,
    readonly daemonJsonPath: string,
  ) {
    super(
      `이미 데몬이 돌고 있습니다 — pid ${pid} (ws 127.0.0.1:${wsPort}).\n` +
        `  같은 데이터 폴더를 두 데몬이 열면 DB 가 깨집니다(T38 함정 ⑤). 먼저 끄세요:\n` +
        `    콘솔에서 \`shutdown\`  또는  taskkill /F /PID ${pid}\n` +
        `  일부러 둘을 띄우려면 ${FORCE_START_ENV}=1 (테스트는 그 대신 PIXEL_DATA_DIR 을 따로 주세요).\n` +
        `  daemon.json: ${daemonJsonPath}`,
    );
    this.name = 'DaemonAlreadyRunningError';
  }
}

/** 데몬이 여는 포트 셋. 오류 문구에 이 이름이 그대로 나간다. */
export type DaemonPortRole = 'hook' | 'mcp' | 'ws';

const PORT_ROLE: Record<DaemonPortRole, { label: string; env: string }> = {
  hook: { label: 'hook(HTTP)', env: 'PIXEL_HOOK_PORT' },
  mcp: { label: 'MCP(HTTP)', env: 'PIXEL_MCP_PORT' },
  ws: { label: 'ws(JSON-RPC)', env: 'PIXEL_WS_PORT' },
};

/** EADDRINUSE 인가. `cause` 사슬까지 본다(감싸인 채로 올라오는 경우). */
export function isAddrInUse(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; e != null && i < 5; i++) {
    const node = e as NodeJS.ErrnoException;
    if (node.code === 'EADDRINUSE') return true;
    e = (node as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 포트를 다른 프로세스가 쥐고 있어 기동을 거부했다(T41).
 * daemon.json 이 안 보이는데 포트만 잡혀 있으면 **다른 환경에서 띄운 우리 데몬**이 범인이다.
 */
export class DaemonPortInUseError extends DaemonStartRefusedError {
  constructor(
    readonly role: DaemonPortRole,
    readonly port: number,
    readonly daemonJsonPath: string,
    options?: { cause?: unknown },
  ) {
    super(
      `이미 데몬이 돌고 있습니다 — ${PORT_ROLE[role].label} 포트 127.0.0.1:${port} 를 다른 프로세스가 쓰고 있습니다(EADDRINUSE).\n` +
        `  daemon.json 은 안 보이는데 포트만 잡혀 있으면 **다른 환경(샌드박스·다른 사용자)에서 띄운 데몬**입니다 —\n` +
        `  그 데몬은 자기 %LOCALAPPDATA% 에 daemon.json 을 씁니다. 범인을 찾으려면:\n` +
        `    netstat -ano | findstr :${port}   →   taskkill /F /PID <pid>\n` +
        `  포트를 바꾸려면 ${PORT_ROLE[role].env} (테스트는 PIXEL_DATA_DIR 과 포트 0 을 함께 쓰세요).\n` +
        `  daemon.json: ${daemonJsonPath}`,
      options,
    );
    this.name = 'DaemonPortInUseError';
  }
}

/** 포트 바인딩을 감싼다: EADDRINUSE 만 [DaemonPortInUseError] 로 바꾸고 나머지 오류는 그대로 올린다. */
export async function bindOrRefuse<T>(
  role: DaemonPortRole,
  port: number,
  daemonJsonPath: string,
  listen: () => Promise<T>,
): Promise<T> {
  try {
    return await listen();
  } catch (err) {
    if (isAddrInUse(err)) throw new DaemonPortInUseError(role, port, daemonJsonPath, { cause: err });
    throw err;
  }
}

export const defaultSingletonProbe: SingletonProbe = {
  isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try {
      process.kill(pid, 0); // 신호 0 = 존재 확인만
      return true;
    } catch (err) {
      // EPERM = 내 것이 아니지만 살아 있다.
      return (err as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  },
  isPortOpen(port) {
    if (!Number.isInteger(port) || port <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const done = (open: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  },
};

interface DaemonJsonHead {
  pid: number;
  wsPort: number;
}

/** `daemon.json` 에서 pid/wsPort 만 읽는다. 없거나 깨졌으면 null. */
export function readDaemonJsonHead(daemonJsonPath: string): DaemonJsonHead | null {
  try {
    const raw = JSON.parse(fs.readFileSync(daemonJsonPath, 'utf8')) as Record<string, unknown>;
    const pid = typeof raw?.pid === 'number' ? raw.pid : 0;
    const wsPort = typeof raw?.wsPort === 'number' ? raw.wsPort : 0;
    if (!pid) return null;
    return { pid, wsPort };
  } catch {
    return null;
  }
}

/**
 * 이미 다른 데몬이 이 데이터 폴더를 쓰고 있으면 `DaemonAlreadyRunningError` 를 던진다.
 * 조건은 **둘 다** 맞을 때만 — pid 가 살아 있고 그 ws 포트가 듣고 있다. (pid 재사용으로 무관한 프로세스를 데몬으로
 * 오인하거나, 포트만 다른 프로그램이 쥐고 있는 경우에 기동을 막지 않기 위해.)
 */
export async function assertSingleDaemon(opts: {
  daemonJsonPath: string;
  probe?: SingletonProbe;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = opts.env ?? process.env;
  if (env[FORCE_START_ENV] === '1') return;
  const head = readDaemonJsonHead(opts.daemonJsonPath);
  if (!head) return;
  const probe = opts.probe ?? defaultSingletonProbe;
  if (!probe.isPidAlive(head.pid)) return; // 죽은 pid = 크래시 뒤 재기동. 예전처럼 덮어쓴다.
  if (!(await probe.isPortOpen(head.wsPort))) return; // pid 는 살아 있지만 우리 데몬이 아니다(pid 재사용).
  throw new DaemonAlreadyRunningError(head.pid, head.wsPort, opts.daemonJsonPath);
}
