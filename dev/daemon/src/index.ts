// pixel-office daemon 진입점 (T07). Office(오케스트레이터) + RpcServer(WS JSON-RPC) 를 띄우고 SIGINT/SIGTERM 에 정중히 내린다.
// node:sqlite ExperimentalWarning 은 Store 모듈이 로드 시 거른다.
import { config, resolveClaudeExeDetailed } from './config.js';
import { Office } from './office/Office.js';
import { bindOrRefuse, DaemonStartRefusedError } from './office/singleton.js';
import { RpcServer } from './rpc/RpcServer.js';

const office = new Office();

/**
 * 기동 거부는 스택 트레이스가 아니라 **한 문단 + exit 3**: 이미 도는 데몬(pid 확인, T30) 이든
 * 포트를 쥔 다른 환경의 데몬(EADDRINUSE, T41) 이든 사용자가 할 일은 같다.
 */
function refuse(err: unknown): never {
  if (err instanceof DaemonStartRefusedError) {
    console.error(`[daemon] ${err.message}`);
    process.exit(err.exitCode);
  }
  throw err;
}

let info;
try {
  info = await office.start();
} catch (err) {
  refuse(err);
}
const rpc = new RpcServer(office, { port: config.wsPort });
let wsPort: number;
try {
  wsPort = await bindOrRefuse('ws', config.wsPort, office.daemonJsonPath, () => rpc.listen());
} catch (err) {
  // ws 만 막힌 경우 daemon.json 은 이미 쓰였다 — 내리면서 지운다(shutdown 이 지운다).
  await office.shutdown().catch(() => {});
  refuse(err);
}
if (wsPort !== info.wsPort) office.updateDaemonInfo({ wsPort });

console.log(`[daemon] pixel-office daemon v${office.version} pid=${office.pid}`);
console.log(`[daemon] data dir : ${config.dataDir}`);
console.log(`[daemon] daemon.json: ${office.daemonJsonPath}`);
console.log(`[daemon] ws        : ws://127.0.0.1:${wsPort}`);
console.log(`[daemon] hook port : ${info.hookPort} (${office.hookScriptPath})`);
console.log(`[daemon] db        : ${office.store.path}`);
// 엔진 실행 파일은 환경마다 다르다(T41: 번들 버전 폴더를 박아 뒀다가 앱 업데이트로 깨졌다).
const claude = resolveClaudeExeDetailed();
console.log(`[daemon] claude    : ${claude.exe}`);
if (!claude.found) {
  console.warn(`[daemon] claude 실행 파일을 못 찾았습니다 — 찾아본 곳: ${claude.tried.join(' · ')}`);
  console.warn(`[daemon] 경로를 직접 주려면 PIXEL_CLAUDE_EXE=<claude.exe 경로>`);
}
console.log(`[daemon] codex     : ${config.codexExe}`);
console.log(`[daemon] listening`);

office.once('shutdown', async () => {
  await rpc.close();
  console.log('[daemon] bye');
  process.exit(0);
});

let signalled = false;
const onSignal = (sig: string) => {
  if (signalled) {
    console.log(`[daemon] ${sig} again — forcing exit`);
    process.exit(1);
  }
  signalled = true;
  console.log(`[daemon] ${sig} — shutting down`);
  office.shutdown().catch((err) => {
    console.error('[daemon] shutdown failed:', err);
    process.exit(1);
  });
};
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('uncaughtException', (err) => console.error('[daemon] uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('[daemon] unhandledRejection:', err));
