// 데몬 공통 설정. 환경변수로 덮어쓸 수 있는 것만 여기에.
import path from 'node:path';
import os from 'node:os';

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

export const config = {
  /** WebSocket(JSON-RPC) 포트. */
  wsPort: Number(process.env.PIXEL_WS_PORT || 7420),
  /** hook 수신 HTTP 포트 (hook.js 가 POST). */
  hookPort: Number(process.env.PIXEL_HOOK_PORT || 7421),
  /** 데몬 상태·토큰·DB·멤버 지시문이 놓이는 폴더. */
  dataDir: process.env.PIXEL_DATA_DIR || path.join(localAppData, 'pixel-office'),
  /** claude 실행 파일. PATH 에 있으면 'claude', 없으면 데스크탑 앱 번들 경로. */
  claudeExe:
    process.env.PIXEL_CLAUDE_EXE ||
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code', '2.1.270', 'claude.exe'),
  /** codex 실행 파일. */
  codexExe: process.env.PIXEL_CODEX_EXE || 'codex',
  /** 세션 hooks 의 timeout(초). 허가·질문 보류 상한 — D-16: 600이면 10분 뒤 CLI가 hook을 끊고 TUI 프롬프트로 폴백한다. */
  hookTimeoutSec: Number(process.env.PIXEL_HOOK_TIMEOUT_SEC || 86400),
  /** 기본 터미널 크기. */
  cols: 120,
  rows: 40,
};

export type Config = typeof config;
