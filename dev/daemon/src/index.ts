// pixel-office daemon 진입점 (T07). Office(오케스트레이터) + RpcServer(WS JSON-RPC) 를 띄우고 SIGINT/SIGTERM 에 정중히 내린다.
// node:sqlite ExperimentalWarning 은 Store 모듈이 로드 시 거른다.
import { config } from './config.js';
import { Office } from './office/Office.js';
import { RpcServer } from './rpc/RpcServer.js';

const office = new Office();
const info = await office.start();
const rpc = new RpcServer(office, { port: config.wsPort });
const wsPort = await rpc.listen();
if (wsPort !== info.wsPort) office.updateDaemonInfo({ wsPort });

console.log(`[daemon] pixel-office daemon v${office.version} pid=${office.pid}`);
console.log(`[daemon] data dir : ${config.dataDir}`);
console.log(`[daemon] daemon.json: ${office.daemonJsonPath}`);
console.log(`[daemon] ws        : ws://127.0.0.1:${wsPort}`);
console.log(`[daemon] hook port : ${info.hookPort} (${office.hookScriptPath})`);
console.log(`[daemon] db        : ${office.store.path}`);
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
