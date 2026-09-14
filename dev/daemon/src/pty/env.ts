// 자식 CLI 에 넘길 환경변수 정리. 순수 함수 — 테스트에서 스폰 없이 검증한다.
//
// 실측 ①: 데몬의 부모가 Claude Code 이면 CLAUDE_CODE_* 가 상속돼 자식 claude 가
// "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION" 을 띄운다 → 전부 제거.
// CLAUDE_CONFIG_DIR 도 부모 세션의 것이 새면 안 되므로 제거.

/** 제거할 키 패턴. Windows 환경변수는 대소문자를 구분하지 않으므로 /i. */
export const DROP_ENV_RE = /^(CLAUDE_?CODE|CLAUDECODE|CLAUDE_CONFIG_DIR)/i;

/** 스폰 시 항상 덮어쓰는 TERM. node-pty 의 name 옵션과 같은 값이어야 한다. */
export const CHILD_TERM = 'xterm-256color';

/**
 * base(보통 process.env)를 복사하되 DROP_ENV_RE 에 걸리는 키는 버리고,
 * PIXEL_MEMBER / TERM 을 세팅한 새 객체를 돌려준다. base 는 건드리지 않는다.
 */
export function sanitizeEnv(base: NodeJS.ProcessEnv, memberToken: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (DROP_ENV_RE.test(key)) continue;
    out[key] = value;
  }
  out.PIXEL_MEMBER = memberToken;
  out.TERM = CHILD_TERM;
  return out;
}
