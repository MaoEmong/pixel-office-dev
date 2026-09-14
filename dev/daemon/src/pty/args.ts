// 엔진별 CLI 인자 생성 (순수 함수). 실측에서 확인한 값을 그대로 유지한다.

/**
 * Claude: `--settings <세션 설정>` + `--permission-mode default` (기본 auto 면 PermissionRequest hook 이 안 옴, 실측 ①)
 * + 재개 시 `--resume <id>` + extraArgs.
 */
export function buildClaudeArgs(settingsPath: string, resumeSessionId?: string, extraArgs: readonly string[] = []): string[] {
  return [
    '--settings',
    settingsPath,
    '--permission-mode',
    'default',
    ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
    ...extraArgs,
  ];
}

/**
 * Codex: 재개 시 `resume <id>` 가 맨 앞(서브커맨드), 그 뒤 `--dangerously-bypass-hook-trust`(비관리 hooks 신뢰 우회, 실측 ④),
 * `approval_policy="on-request"`(`untrusted` 는 0.154.0 에서 제거됨), `sandbox_mode="workspace-write"` + extraArgs.
 */
export function buildCodexArgs(resumeSessionId?: string, extraArgs: readonly string[] = []): string[] {
  return [
    ...(resumeSessionId ? ['resume', resumeSessionId] : []),
    '--dangerously-bypass-hook-trust',
    '-c',
    'approval_policy="on-request"',
    '-c',
    'sandbox_mode="workspace-write"',
    ...extraArgs,
  ];
}
