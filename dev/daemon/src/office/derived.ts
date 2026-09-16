// 파생 멤버 상태 한 곳(T28, 01 §2 "멤버 표시 상태(파생)").
//
// raw `status` 는 "CLI 프로세스가 어떤 상태인가" 일 뿐이다 — `idle` 은 턴이 끝났다는 뜻이지 "할 일이 없다" 가 아니고,
// `ask_user` 질문은 턴이 끝난 뒤에도 열려 있다(T17). 사무실 화면(포즈·모니터·말풍선)과 `member.status` 알림이 보는 것은
// 그래서 raw 가 아니라 이 함수가 만드는 **파생 상태**다. 데몬 안에서 이 규칙을 계산하는 곳은 여기 하나다 —
// snapshot(`members[].derived`) 도, `member.status` 알림도 같은 함수를 부른다(PROTOCOL.md).
//
//   waiting_approval  열린 허가 pending 이 있다(raw 가 무엇이든)
//   waiting_answer    열린 질문 pending 이 있다(raw 가 무엇이든 — 턴 종료 질문 `ask_user`(부장→사용자)·
//                     `ask_parent`(팀장·팀원→상위)는 raw idle 에서도 열려 있다, T17·D-32)
//   waiting_reports   raw idle 인데 자기가 발행한 미종료 task 가 있다(T25 — 부하 보고를 기다리는 중).
//                     T34 부터 **직급을 가리지 않는다** — 부장도 팀장도 자식이 있으면 같은 상태다(D-32 "자식이 있는 모든 직급에").
//   free              raw idle + 열린 pending 없음 + 배정·발행 미종료 task 없음(= 잎이 한가함)
//   그 외              raw 그대로(starting / working / idle / exited / error)
//
// exited·error 는 어떤 경우에도 덮지 않는다 — 나간 멤버의 pending 이 정리 전이라도 "질문 대기" 로 보이면 안 된다.
import type { Member, MemberStatus, Pending, Task, TaskStatus } from '../store/types.js';
import type { DerivedStatus } from './types.js';

/** 미종료 task(= 아직 보고를 기다리는 것). 파생 상태·후처리·dismiss 검사가 같은 집합을 본다. */
export const OPEN_TASKS: readonly TaskStatus[] = ['queued', 'assigned'];

/** 종료된 것으로 보는 raw status. 파생이 덮지 않는다. */
export const GONE_STATUSES: ReadonlySet<MemberStatus> = new Set<MemberStatus>(['exited', 'error']);

/**
 * 턴을 끝내고도 열려 있는 질문의 출처(MCP 도구). 부장은 `ask_user` 로 사용자에게, 팀장·팀원은 `ask_parent` 로
 * 바로 위에 묻는다(D-32). 둘 다 **턴 종료 상태**라 프로세스가 죽어도 유효하다(D-19) — `member.restart`(D-36)와
 * 데몬 재시작 복구는 이 질문을 만료시키지 않는다.
 */
export const TURN_ENDING_QUESTION_SOURCES: readonly string[] = ['ask_user', 'ask_parent'];

/**
 * 그 pending 이 "프로세스가 죽어도 유효한 질문" 인가(D-19). TUI `AskUserQuestion` 메뉴는 `payload.tool_input` 이
 * 있고 프로세스와 함께 사라지므로 여기에 들지 않는다.
 */
export function isTurnEndingQuestion(p: Pending): boolean {
  if (p.type !== 'question') return false;
  if (TURN_ENDING_QUESTION_SOURCES.includes(String(p.payload.source))) return true;
  return p.payload.tool_input === undefined;
}

/** `derivedStatus` 가 쓰는 Store 의 부분(테스트에서 가짜를 넣을 수 있게). */
export interface DerivedStore {
  listOpenPending(memberId?: string): Pending[];
  openTasksIssuedBy(memberId: string): Task[];
  listTasks(input: { toMember?: string; status?: TaskStatus | TaskStatus[] }): Task[];
}

/**
 * 멤버 하나의 파생 상태. `status` 를 주면 그 값을 raw 로 본다(어댑터가 store 에 쓰기 직전/직후 같은 값으로 부를 수 있게).
 */
export function derivedStatus(member: Member, store: DerivedStore, status: MemberStatus = member.status): DerivedStatus {
  if (GONE_STATUSES.has(status)) return status;
  const open = store.listOpenPending(member.id);
  if (open.some((p) => p.type === 'approval')) return 'waiting_approval';
  // 질문은 종류를 가리지 않는다: TUI `AskUserQuestion` 도, 턴 종료 질문(`ask_user`/`ask_parent`)도 답을 기다리는 중이다.
  if (open.some((p) => p.type === 'question')) return 'waiting_answer';
  if (status !== 'idle') return status;
  // 부하에게 낸 일의 보고를 기다리는 동안은 "한가함" 이 아니다(T25 → T34: 직급 무관).
  if (store.openTasksIssuedBy(member.id).length > 0) return 'waiting_reports';
  const mine = store.listTasks({ toMember: member.id, status: [...OPEN_TASKS] });
  return mine.length === 0 ? 'free' : 'idle';
}
