// 기동 복구의 **순서**와 **말없이 앉히기** 규칙(T46-1, D-47 · 수명주기.md §4-2~3, §5).
//
// Office 가 하는 일(프로세스 띄우기·큐에 넣기)과 갈라 둔 이유는 T28 의 afterCare 와 같다 — 규칙은 표 하나로 읽히고,
// 테스트가 Office 없이도 규칙만 확인할 수 있다.
//
// 순서는 두 겹이다.
//   ① **부서** — 지금 보고 있는 탭의 부서부터(§5). 앱은 붙자마자 `hello{activeDepartmentId}` 로 알려 주지만
//      그 hello 는 **복구가 시작된 뒤에** 올 수도 있다(WS 서버는 복구 뒤에 열린다). 그래서 기본값으로
//      **마지막으로 활동한 부서**(가장 최근 이벤트)를 먼저 놓고, 힌트가 오면 남은 줄을 다시 세운다.
//   ② **트리** — 부장 → 팀장 → 팀원(T36). 부하가 먼저 깨어나 보고를 올리면 받을 상사가 아직 없다.
// 같은 칸 안에서는 원래 순서(생성순)를 지킨다 — 로그·테스트가 읽기 쉽다.
import type { Member, MemberRank, Pending, Task } from '../store/types.js';

/** 트리 깊이(잎이 0). Office 의 `RANK_DEPTH` 와 같은 값 — 정리는 작은 쪽부터, 복구는 큰 쪽부터. */
const RANK_DEPTH: Record<MemberRank, number> = { member: 0, lead: 1, head: 2 };

/** 한꺼번에 띄우는 CLI 수 상한(§5 "한꺼번에 띄우는 CLI 는 최대 3개(기동 부하)"). */
export const RECOVER_MAX_IN_FLIGHT = 3;

/**
 * 한 멤버의 "기동 중" 을 얼마나 기다려 주는가(ms). CLI 가 준비 화면에 도달하면(`starting` 을 벗어나면) 바로
 * 다음 멤버로 넘어가고, 그 신호가 영영 안 오는 경우(첫 실행 다이얼로그에 걸림 등)에도 줄이 막히지 않게 상한을 둔다.
 */
export const RECOVER_BOOT_SLOT_MS = 60_000;

/**
 * 복구 순서. `hintDepartmentId`(앱이 보고 있는 부서) → `recentDepartmentId`(마지막 활동 부서) → 나머지 순으로
 * 부서를 줄 세우고, 부서 안에서는 부장 → 팀장 → 팀원.
 */
export function recoveryOrder(
  members: readonly Member[],
  opts: { hintDepartmentId?: string; recentDepartmentId?: string } = {},
): Member[] {
  const rank = departmentRank(members, opts);
  return members
    .map((m, i) => ({ m, i }))
    .sort(
      (a, b) =>
        (rank.get(a.m.departmentId) ?? 0) - (rank.get(b.m.departmentId) ?? 0) ||
        RANK_DEPTH[b.m.rank] - RANK_DEPTH[a.m.rank] ||
        a.i - b.i,
    )
    .map(({ m }) => m);
}

/**
 * 부서 우선순위 표. 힌트 0, 마지막 활동 부서 1, 나머지는 **처음 나온 순서**대로 2, 3 … —
 * 부서끼리의 상대 순서가 힌트 하나로 통째로 뒤집히지 않게 한다.
 */
function departmentRank(members: readonly Member[], opts: { hintDepartmentId?: string; recentDepartmentId?: string }): Map<string, number> {
  const out = new Map<string, number>();
  let next = 2;
  for (const m of members) {
    if (out.has(m.departmentId)) continue;
    if (m.departmentId === opts.hintDepartmentId) out.set(m.departmentId, 0);
    else if (m.departmentId === opts.recentDepartmentId) out.set(m.departmentId, 1);
    else out.set(m.departmentId, next++);
  }
  // 힌트·최근 부서가 목록에 없어도 위 규칙이 그대로 성립한다(맵에 안 들어갈 뿐).
  return out;
}

/**
 * **말없이 앉히기**(수명주기.md 원칙 4, §4-3 · §5). `[RESUMED]` 를 타이핑하는 것은 **하던 일이 있던 캐릭터뿐**이다 —
 * 쉬고 있던 캐릭터에게 말을 걸면 그 자리에서 모델 턴이 한 번 돌아 토큰을 쓴다(정상 종료 뒤 앱을 켤 때마다
 * 조직 전원이 한 턴씩 도는 것이 T46 이전의 손실이다).
 *
 * "하던 일" 은 넷이다:
 *   - 진행 중 task(`assigned`) · 아직 안 들어간 지시(`queued`) — 내가 맡은 일
 *   - **내가 낸 일 중 아직 보고를 못 받은 것**(`issued`) — 부장·팀장은 이쪽이 "하던 일" 이다(T36/D-20).
 *     여기서 말을 걸지 않으면 되살아난 상사가 곧 도착할 `[REPORTS …]` 를 문맥 없이 받는다.
 *   - 답을 기다리는 질문(만료되고 남은 것 = 턴 종료 질문)
 * 허가 요청은 세지 않는다 — 그건 이미 만료돼 "다시 지시 필요" 카드가 되기 때문이다(§4-4).
 */
export function needsResumedText(input: {
  assigned: readonly Task[];
  queued: readonly Task[];
  issued: readonly Task[];
  openQuestions: readonly Pending[];
}): boolean {
  return input.assigned.length > 0 || input.queued.length > 0 || input.issued.length > 0 || input.openQuestions.length > 0;
}
