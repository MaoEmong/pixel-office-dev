// 엔진별 CLI 인자 생성 (순수 함수). 실측에서 확인한 값을 그대로 유지한다.

export interface ClaudeArgsOptions {
  /** TeamTools MCP 설정 파일(T17). 있으면 `--mcp-config <path>` 를 붙인다. */
  mcpConfigPath?: string;
}

/**
 * Claude: `--settings <세션 설정>` + `--permission-mode default` (기본 auto 면 PermissionRequest hook 이 안 옴, 실측 ①)
 * + 재개 시 `--resume <id>` + (`--mcp-config <path>`, T17) + extraArgs.
 */
export function buildClaudeArgs(settingsPath: string, resumeSessionId?: string, extraArgs: readonly string[] = [], opts: ClaudeArgsOptions = {}): string[] {
  return [
    '--settings',
    settingsPath,
    '--permission-mode',
    'default',
    ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
    ...(opts.mcpConfigPath ? ['--mcp-config', opts.mcpConfigPath] : []),
    ...extraArgs,
  ];
}

export interface CodexArgsOptions {
  /** TeamTools MCP 엔드포인트(T22). 있으면 `-c mcp_servers.team.url="<url>"` 을 붙인다. */
  mcpUrl?: string;
}

/** Codex MCP 설정 키(0.154.0 `codex mcp add <name> --url` 이 config.toml 에 쓰는 모양: `[mcp_servers.<name>] url = "…"`). */
export const CODEX_MCP_URL_KEY = (serverName: string): string => `mcp_servers.${serverName}.url`;
/** mcp.json 의 서버 키와 같은 이름을 쓴다(도구 이름이 엔진별로 갈리지 않게). */
export const CODEX_MCP_SERVER_NAME = 'team';

/**
 * Codex: 재개 시 `resume <id>` 가 맨 앞(서브커맨드), 그 뒤 `--dangerously-bypass-hook-trust`(비관리 hooks 신뢰 우회, 실측 ④),
 * `approval_policy="on-request"`(`untrusted` 는 0.154.0 에서 제거됨), `sandbox_mode="workspace-write"`,
 * (T22) `-c mcp_servers.team.url="http://127.0.0.1:<mcpPort>/mcp/<memberToken>"` + extraArgs.
 *
 * `-c` 값은 TOML 로 파싱되므로 URL 은 큰따옴표로 감싼다(실측: `codex mcp list -c mcp_servers.team.url="…"` 이 그 서버를 보여준다).
 */
export function buildCodexArgs(resumeSessionId?: string, extraArgs: readonly string[] = [], opts: CodexArgsOptions = {}): string[] {
  return [
    ...(resumeSessionId ? ['resume', resumeSessionId] : []),
    '--dangerously-bypass-hook-trust',
    '-c',
    'approval_policy="on-request"',
    '-c',
    'sandbox_mode="workspace-write"',
    ...(opts.mcpUrl ? ['-c', `${CODEX_MCP_URL_KEY(CODEX_MCP_SERVER_NAME)}="${opts.mcpUrl}"`] : []),
    ...extraArgs,
  ];
}
