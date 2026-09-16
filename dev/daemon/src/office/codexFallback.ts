// Codex 멤버 폴백(T22, 설계 01 §"Codex 멤버 폴백(v1)" / §2 표 "delegating·reporting: 동일 (+ 폴백: 턴 종료 메시지 승격)").
//
// Codex 멤버는 TeamTools MCP 를 붙여 줘도(T22 주입) 모델이 `ask_user`/`report` 를 **안 부르고** 그냥 말로 끝내는 일이 잦다.
// 그러면 사무실에서는 "할 말이 있는데 아무 일도 안 일어나는" 상태가 된다. 그래서 턴 종료(`Stop`) 시점에 마지막 assistant
// 메시지를 보고 두 가지를 승격한다:
//   - 질문처럼 보이면      → pending(question) + `asking` 이벤트(파생 waiting_answer) — 캐릭터가 내 책상으로 걸어온다.
//   - 배정 task 가 있으면  → task report (Office.afterOfficeEvent 의 기존 v1a 보고 경로, 엔진 공통).
// 질문이 우선이다: 질문으로 끝난 턴은 "끝난 작업"이 아니다(task 는 assigned 로 남겨 둔다).
//
// 여기 있는 것은 전부 순수 함수 — 판정 규칙을 테스트로 고정하기 위해 Office 에서 분리했다.

/** 질문 폴백으로 만든 pending 임을 나타내는 표식. payload 는 `ask_user` 와 같은 모양이라(D-19) 재시작 복구·앱 카드가 그대로 동작한다. */
export const CODEX_FALLBACK = 'codex-stop';

/** 질문 폴백 pending 의 payload. `source:'ask_user'` 를 유지해 D-19(재시작 시 살아남는 질문) 규칙을 그대로 탄다. */
export interface FallbackQuestionPayload {
  source: 'ask_user';
  question: string;
  options: string[];
  /** `[ANSWER q#…]` 가 아니라 **보통 프롬프트**로 답을 넣어야 한다는 표식(기다리는 MCP 호출이 없다). */
  fallback: typeof CODEX_FALLBACK;
}

/** 질문 문장으로 볼 어미·표현(대소문자 무시). 물음표가 없어도 이 중 하나가 마지막 줄에 있으면 질문으로 본다. */
export const QUESTION_PATTERNS: readonly RegExp[] = [
  /알려\s*주세요/,
  /알려\s*줘/,
  /확인해\s*주세요/,
  /확인\s*부탁/,
  /어떻게\s*할까요/,
  /어느\s*쪽/,
  /선택해\s*주세요/,
  /골라\s*주세요/,
  /진행할까요/,
  /맞나요/,
  /which\b/i,
  /should I\b/i,
];

/** 질문 이벤트·pending 에 싣는 상한(말풍선·카드용). */
export const MAX_QUESTION_CHARS = 300;

/** 마지막 비어 있지 않은 줄(목록 기호·강조 마크다운은 떼고). 없으면 빈 문자열. */
export function lastLine(message: string): string {
  const lines = message.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = stripMarkdown(lines[i]!);
    if (line) return line;
  }
  return '';
}

/** 그 줄이 질문처럼 보이는가 — 물음표(`?`/`？`)로 끝나거나 QUESTION_PATTERNS 중 하나에 걸리면. */
export function looksLikeQuestion(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  if (/[?？]["'”’)\]]*$/.test(s)) return true;
  return QUESTION_PATTERNS.some((rx) => rx.test(s));
}

/**
 * 턴 종료 메시지에서 질문을 뽑는다. 질문이 아니면 undefined.
 * 질문 본문은 **마지막 줄**(모델이 마지막에 묻는다). 너무 길면 자른다.
 */
export function detectQuestion(lastAssistantMessage: string | undefined): string | undefined {
  if (!lastAssistantMessage) return undefined;
  const line = lastLine(lastAssistantMessage);
  if (!looksLikeQuestion(line)) return undefined;
  return line.length <= MAX_QUESTION_CHARS ? line : line.slice(0, MAX_QUESTION_CHARS - 1) + '…';
}

/** 그 pending payload 가 질문 폴백(= 답을 보통 프롬프트로 넣어야 하는 것)인가. */
export function isFallbackQuestion(payload: Record<string, unknown>): boolean {
  return payload.fallback === CODEX_FALLBACK;
}

/** 목록 기호(`- `, `* `, `1. `)와 강조(`**…**`), 인용(`> `)을 떼고 trim. */
function stripMarkdown(line: string): string {
  return line
    .trim()
    .replace(/^([-*+]|\d+\.|>)\s+/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .trim();
}
