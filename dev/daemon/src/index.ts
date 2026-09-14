// pixel-office daemon 진입점. T00: 골격만 — 설정 출력 후 대기.
import fs from 'node:fs';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
console.log(`[daemon] pixel-office daemon starting`);
console.log(`[daemon] data dir : ${config.dataDir}`);
console.log(`[daemon] ws port  : ${config.wsPort}`);
console.log(`[daemon] hook port: ${config.hookPort}`);
console.log(`[daemon] listening (T00 skeleton — no servers yet)`);

process.on('SIGINT', () => {
  console.log('[daemon] shutting down');
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
