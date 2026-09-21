// 연결 여부·요금제 파서(T43, D-45 ④⑥). 순수 함수 — 프로세스를 띄우지 않는다(띄우는 쪽은 connection.ts).
//
// **여기서 뽑는 것은 `loggedIn` 과 요금제 이름뿐이다.** `claude auth status` 의 JSON 에는 `email`·`orgId`·`orgName`
// 이 같이 들어 있지만(실측 T43-0 Q5) D-45 ② 에 따라 **저장도 표시도 하지 않는다** — 그래서 파서가 그 키를
// 아예 읽지 않는다. 테스트가 "이메일이 들어 있는 출력을 줘도 결과 객체에 그 키가 없다" 를 확인한다.
import { isRecord } from '../types.js';

export interface ParsedAuthStatus {
  /** 로그인 여부. 판단할 수 없으면 null. */
  loggedIn: boolean | null;
  /** 요금제 이름(claude `subscriptionType`). 없으면 null. */
  plan: string | null;
}

/**
 * `claude auth status` 의 stdout(JSON 이 기본 출력) → `{loggedIn, plan}`.
 * 로그아웃 상태에서는 `subscriptionType` 키 자체가 사라진다(실측) → plan null.
 * JSON 이 아니면 둘 다 null.
 */
export function parseClaudeAuthStatus(stdout: string): ParsedAuthStatus {
  const text = typeof stdout === 'string' ? stdout.trim() : '';
  if (text === '') return { loggedIn: null, plan: null };
  // 경고 한 줄이 앞에 섞여도 JSON 본문만 잘라 읽는다.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { loggedIn: null, plan: null };
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { loggedIn: null, plan: null };
  }
  if (!isRecord(obj)) return { loggedIn: null, plan: null };
  return {
    loggedIn: typeof obj.loggedIn === 'boolean' ? obj.loggedIn : null,
    plan: typeof obj.subscriptionType === 'string' && obj.subscriptionType ? obj.subscriptionType : null,
  };
}

/**
 * `codex login status` 의 stdout + 종료 코드 → `{loggedIn}`. 요금제는 이 명령이 주지 않는다(rollout 의
 * `plan_type` 에서 온다) → plan 은 항상 null.
 *
 * 실측: 연결됨 `"Logged in using ChatGPT"` exit 0 / 연결 안 됨 `"Not logged in"` exit 1.
 * 임시 `CODEX_HOME` 을 쓰면 stderr 에 PATH 별칭 경고가 섞이지만 판정에는 영향이 없다(stdout·종료 코드로 본다).
 */
export function parseCodexLoginStatus(stdout: string, exitCode: number): ParsedAuthStatus {
  const text = typeof stdout === 'string' ? stdout : '';
  if (/not\s+logged\s+in/i.test(text)) return { loggedIn: false, plan: null };
  if (/logged\s+in/i.test(text)) return { loggedIn: true, plan: null };
  if (exitCode === 0) return { loggedIn: true, plan: null };
  if (Number.isInteger(exitCode) && exitCode > 0) return { loggedIn: false, plan: null };
  return { loggedIn: null, plan: null };
}
