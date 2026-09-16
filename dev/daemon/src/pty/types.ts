// PtyManager 공개 타입. 구현은 PtyManager.ts.

export type Engine = 'claude' | 'codex';

/** sendKeys 로 보낼 수 있는 특수 키. 실측 ①: 다이얼로그 통과(↓+Enter)·턴 중단(Ctrl+C) 용도. */
export type KeyName = 'enter' | 'down' | 'up' | 'ctrl-c' | 'esc';

export interface SpawnOptions {
  /** 데몬 내부 멤버 id. 세션 설정 파일 폴더명으로도 쓴다. */
  memberId: string;
  /** hook 이 멤버를 식별하는 토큰. `PIXEL_MEMBER` 환경변수로 주입된다 (D-03). */
  memberToken: string;
  engine: Engine;
  /** CLI 작업 디렉토리(팀 프로젝트 폴더). */
  cwd: string;
  /** 있으면 `claude --resume <id>` / `codex resume <id>` 로 재개 (D-07). */
  resumeSessionId?: string;
  cols?: number;
  rows?: number;
  /** hook.js 절대 경로. 백슬래시는 슬래시로 바뀐다 (git-bash 에서 실행되므로). */
  hookScriptPath: string;
  /** HookReceiver 포트. hook 명령 인자로 전달. */
  hookPort: number;
  /** 엔진 인자 뒤에 그대로 붙일 추가 인자. */
  extraArgs?: string[];
  /** TeamTools MCP 설정 파일(T17). Claude 는 `--mcp-config <path>` 로 그 세션에만 주입한다. Codex 는 mcpUrl 을 쓴다. */
  mcpConfigPath?: string;
  /**
   * TeamTools MCP 엔드포인트(T22, Codex 전용). `-c mcp_servers.team.url="<url>"` 으로 그 실행에만 주입한다
   * (`~/.codex/config.toml` 은 건드리지 않는다). Claude 는 mcpConfigPath 를 쓴다.
   */
  mcpUrl?: string;
}

export interface ExitInfo {
  exitCode: number;
  signal?: number;
}

export interface PtySession {
  readonly memberId: string;
  readonly engine: Engine;
  /** ConPTY 자식 pid. 기록용 — 데몬이 죽으면 자식도 죽으므로 유령 정리는 없다. */
  readonly pid: number;
  readonly alive: boolean;
  /** 바이트를 그대로 pty 에 쓴다. Enter 는 '\r'. */
  write(text: string): void;
  /**
   * bracketed paste 로 여러 줄을 한 프롬프트로 넣는다 (`ESC[200~ … ESC[201~`).
   * 끝에 CR 을 붙이지 않는다 — 전송은 호출자가 sendKeys('enter') 로.
   */
  paste(text: string): void;
  sendKeys(keys: KeyName): void;
  resize(cols: number, rows: number): void;
  /** 즉시 강제 종료. 정중한 종료는 PtyManager.kill(id, {graceful:true}). */
  kill(): void;
}
