// 파생 멤버 상태 한 곳(T28, 01 §2 "멤버 표시 상태(파생)").
//
// raw `status` 는 "CLI 프로세스가 어떤 상태인가" 일 뿐이다 — `idle` 은 턴이 끝났다는 뜻이지 "할 일이 없다" 가 아니고,
// `ask_user` 질문은 턴이 끝난 뒤에도 열려 있다(T17). 사무실 화면(포즈·모니터·말풍선)과 `member.status` 알림이 보는 것은
// 그래서 raw 가 아니라 이 함수가 만드는 **파생 상태**다. 데몬 안에서 이 규칙을 계산하는 곳은 여기 하나다 —
// snapshot(`members[].derived`) 도, `member.status` 알림도 같은 함수를 부른다(PROTOCOL.md).
//
//   waiting_approval  열린 허가 pending 이 있다(raw 가 무엇이든)
//   waiting_answer    열린 질문 pending 이 있다(raw 가 무엇이든 — `ask_user` 는 raw idle 에서도 열려 있다)
//   waiting_reports   팀장이 raw idle 인데 자기가 발행한 미종료 task 가 있다(T25 — 팀원 보고를 기다리는 중)
//   free              raw idle + 열린 pending 없음 + 배정된 미종료 task 없음(팀장은 발행 task 도 없을 때)
//   그 외              raw 그대로(starting / working / idle / exited / error)
//
// exited·error 는 어떤 경우에도 덮지 않는다 — 나간 멤버의 pending 이 정리 전이라도 "질문 대기" 로 보이면 안 된다.
import type { Member, MemberStatus, Pending, Task, TaskStatus } from '../store/types.js';
import type { DerivedStatus } from './types.js';

/** 미종료 task(= 아직 보고를 기다리는 것). 파생 상태·후처리·dismiss 검사가 같은 집합을 본다. */
export const OPEN_TASKS: readonly TaskStatus[] = ['queued', 'assigned'];

/** 종료된 것으로 보는 raw status. 파생이 덮지 않는다. */
export const GONE_STATUSES: ReadonlySet<MemberStatus> = new Set<MemberStatus>(['exited', 'error']);

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
  if (open.some((p) => p.type === 'question')) return 'waiting_answer';
  if (status !== 'idle') return status;
  // 팀장은 발행한 보고를 기다리는 동안 "한가함" 이 아니다(T25).
  if (member.rank === 'leader' && store.openTasksIssuedBy(member.id).length > 0) return 'waiting_reports';
  const mine = store.listTasks({ toMember: member.id, status: [...OPEN_TASKS] });
  return mine.length === 0 ? 'free' : 'idle';
}
