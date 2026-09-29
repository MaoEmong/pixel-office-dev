// 데몬 공통 설정. 환경변수로 덮어쓸 수 있는 것만 여기에.
//
// **운영체제에 닿는 것은 하나도 여기 없다**(T48-1 · D-48 원칙 2) — 데이터 폴더 규칙과 실행 파일 탐색은
// `platform.ts` 로 옮겼다. 옛 이름(`resolveClaudeExe` 등)은 호출처·테스트가 그대로 쓰도록 여기서 다시 내보낸다.
import { host, resolveClaudeExe, resolveCodexExe } from './platform.js';

export { resolveClaudeExe, resolveClaudeExeDetailed, resolveCodexExe, type ExeResolution } from './platform.js';

export const config = {
  /** WebSocket(JSON-RPC) 포트. */
  wsPort: Number(process.env.PIXEL_WS_PORT || 7420),
  /** hook 수신 HTTP 포트 (hook.js 가 POST). */
  hookPort: Number(process.env.PIXEL_HOOK_PORT || 7421),
  /** TeamTools MCP(Streamable HTTP) 포트. CLI 세션이 `/mcp/<memberToken>` 으로 붙는다(T17). */
  mcpPort: Number(process.env.PIXEL_MCP_PORT || 7422),
  /**
   * 데몬 상태·토큰·DB·멤버 지시문이 놓이는 폴더. `PIXEL_DATA_DIR` → OS 별 기본
   * (윈도우 `%LOCALAPPDATA%\pixel-office` · 맥 `~/Library/Application Support/pixel-office` ·
   * 리눅스 `$XDG_DATA_HOME/pixel-office`). 규칙은 `platform.ts` 의 `dataDir()` 하나뿐이고 **앱도 같은 규칙**을 쓴다(D-48 ②).
   */
  dataDir: host.dataDir(),
  /**
   * claude 실행 파일. `PIXEL_CLAUDE_EXE` → PATH 의 진짜 실행 파일 → npm 전역 → (윈도우만) 데스크탑 앱 번들의
   * **최신 버전 폴더** 순으로 찾는다(platform.resolveClaudeExe, T41). 버전 폴더를 박아 두면 앱이 업데이트될 때마다
   * 부서 생성이 죽는다.
   */
  claudeExe: resolveClaudeExe(),
  /**
   * codex 실행 파일. `PIXEL_CODEX_EXE` 로 덮어쓸 수 있고, 없으면 npm 전역의 실제 `codex(.exe)` 를 찾는다(resolveCodexExe).
   * 윈도우 PATH 의 `codex`(.cmd/.ps1 셰임)는 node-pty 가 못 띄우므로 기본값으로 쓰지 않는다(T20 함정 4).
   */
  codexExe: resolveCodexExe(),
  /** 세션 hooks 의 timeout(초). 허가·질문 보류 상한 — D-16: 600이면 10분 뒤 CLI가 hook을 끊고 TUI 프롬프트로 폴백한다. */
  hookTimeoutSec: Number(process.env.PIXEL_HOOK_TIMEOUT_SEC || 86400),
  /**
   * 엔진 연결 확인(`claude auth status` · `codex login status`) 주기(초, T43/D-45). 0 이면 기동 시 한 번만 하고
   * 타이머를 걸지 않는다. 명령이 0.3초 이하라 60초는 부담이 없다.
   */
  usagePollSec: Number(process.env.PIXEL_USAGE_POLL_SEC || 60),
  /**
   * 확인용 세션(T43-4)을 쓰는가. `PIXEL_USAGE_PROBE=0` 이면 엔진마다 숨은 CLI 를 띄우지 않고 턴 종료 출처만
   * 쓴다(상주 프로세스가 싫을 때). 그러면 아무도 일을 안 한 동안·툴 밖에서 쓴 사용량은 반영되지 않는다.
   */
  usageProbe: process.env.PIXEL_USAGE_PROBE !== '0',
  /**
   * 확인용 세션이 `/usage`·`/status` 를 여는 주기(초, `PIXEL_USAGE_PROBE_SEC`). 모델 턴을 쓰지 않으므로
   * 할당량이 들지 않는다. 0 이하면 기동 뒤 **한 번만** 읽는다.
   */
  usageProbeSec: Number(process.env.PIXEL_USAGE_PROBE_SEC || 300),
  /**
   * 부모 앱의 pid(T46-1, D-47 · 수명주기.md §3). 앱이 데몬을 자식으로 띄울 때 `PIXEL_PARENT_PID=<앱 pid>` 를 준다.
   * 값이 있으면 데몬이 2초마다 그 프로세스를 지켜보다 사라지면 스스로 `daemon.shutdown` 과 같은 정리를 한다 —
   * 앱이 강제 종료되면 §2 의 코드가 돌지 못하기 때문이다. 없으면(콘솔에서 띄운 데몬) 감시하지 않는다.
   */
  parentPid: (() => {
    const n = Number(process.env.PIXEL_PARENT_PID);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  })(),
  /**
   * `1` 이면 **부모 감시를 끈다**(T46-1). 앱을 닫아도 데몬과 세션을 남기는 개발용 탈출구이자, 앱 설정
   * "앱을 닫아도 계속 일하기"(D-02 의 옛 동작)가 켜졌을 때 앱이 넘기는 값이다.
   */
  keepDaemon: process.env.PIXEL_KEEP_DAEMON === '1',
  /** 기본 터미널 크기. */
  cols: 120,
  rows: 40,
};

export type Config = typeof config;
