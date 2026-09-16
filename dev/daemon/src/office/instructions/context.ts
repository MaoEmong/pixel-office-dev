// SessionStart additionalContext 본문(T26b). 설계: 01 §멤버 지시문 주입
// ("SessionStart hook 의 additionalContext 반환을 1순위로 — startup/resume/clear/compact 모두에서 다시 주입되므로 compaction 유실이 없다", D-05).
//
// 주입되는 텍스트 = **런타임 프리앰블 + 유효 지시문**.
//   - 유효 지시문 = 사용자 INSTRUCTIONS.md 본문이 있으면 그것, 없으면 직급 기본 템플릿(templates.ts).
//   - 프리앰블은 **사용자 파일이 있어도 늘 붙는다.** 사용자가 쓴 지시문에는 "나는 누구이고 팀에 누가 있는지" 가 없기 때문이다.
//     세션이 /clear·compact 로 리셋돼도 이 한 덩어리가 다시 오므로 모델이 자기 정체·팀 구성·도구 이름을 잃지 않는다.
//   - 전체 길이 상한(MAX_CONTEXT_CHARS)을 넘으면 **사용자 본문만** 잘린다(프리앰블은 통째로 유지).
import { RANK_LABEL, toolsLine } from './templates.js';
import type { Engine, Member, MemberRank, Team } from '../../store/types.js';

/** 프리앰블 로스터 한 줄에 들어가는 멤버(살아 있는 멤버만). */
export interface RosterEntry {
  name: string;
  rank: MemberRank;
  engine: Engine;
  /** 지시문 첫 줄 `# 역할: <role>`. */
  role?: string;
}

export interface SessionContextInput {
  team: Team;
  member: Member;
  /** 같은 팀에서 지금 살아 있는 멤버 전부(자기 자신 포함). */
  roster: RosterEntry[];
  /** 유효 지시문(사용자 파일 또는 기본 템플릿). */
  instructions: string;
}

/**
 * additionalContext 전체 길이 상한(글자). 한국어는 대략 글자당 1토큰 안팎이라 ~2500토큰 예산에 맞춘 값이다.
 * 프리앰블은 보통 300~500자라 사용자 본문에 2500자 이상이 남는다.
 */
export const MAX_CONTEXT_CHARS = 3000;

/** 사용자 본문을 잘랐을 때 붙는 표식. 모델이 "여기서 끊겼다" 를 알 수 있어야 한다. */
export const TRUNCATE_MARK = '\n\n[… 지시문이 길어 여기서 잘렸습니다. 전문은 이 멤버의 INSTRUCTIONS.md 에 있습니다.]';

/** 아무리 짧아도 사용자 본문에 남겨 주는 최소 길이(프리앰블이 비정상적으로 길어져도 본문이 통째로 사라지지 않게). */
const MIN_BODY_CHARS = 200;

const describe = (e: RosterEntry): string => `${e.name}(${e.engine}${e.role ? `, 역할 ${e.role}` : ''})`;

/** `- 팀장: 반장(claude)` / `- 팀원: 이음(claude, 역할 파일 작성), 나루(codex)`. 비면 `(없음)`. */
export function rosterLines(roster: RosterEntry[]): string[] {
  const of = (rank: MemberRank) => roster.filter((e) => e.rank === rank);
  const line = (rank: MemberRank) => {
    const list = of(rank);
    return `- ${RANK_LABEL[rank]}: ${list.length ? list.map(describe).join(', ') : '(없음)'}`;
  };
  return [line('leader'), line('member')];
}

/**
 * 지시문 앞에 늘 붙는 런타임 머리말. "너는 누구이고(이름·직급·팀·엔진·작업 폴더), 팀에 누가 있고, 어떤 도구를 쓸 수 있는가".
 * 사용자 지시문이 있든 없든 똑같이 나간다.
 */
export function sessionPreamble(input: SessionContextInput): string {
  const { member, team } = input;
  return [
    `[사무실] 너는 픽셀 오피스 팀 "${team.name}" 의 ${RANK_LABEL[member.rank]} ${member.name}(엔진 ${member.engine})이다.`,
    `- 작업 폴더: ${member.cwd || team.cwd}`,
    ...rosterLines(input.roster),
    `- ${toolsLine(member.rank)}`,
    '아래는 너의 지시문(INSTRUCTIONS.md)이다 — 프로젝트의 CLAUDE.md/AGENTS.md 위에 얹히는 개인 규칙이다.',
  ].join('\n');
}

/** SessionStart 의 additionalContext 로 나가는 전체 텍스트. 상한을 넘으면 사용자 본문만 잘린다. */
export function buildSessionContext(input: SessionContextInput): string {
  const head = sessionPreamble(input);
  const body = input.instructions.trim();
  if (!body) return head;
  const room = MAX_CONTEXT_CHARS - head.length - 2;
  if (body.length <= room) return `${head}\n\n${body}`;
  const keep = Math.max(MIN_BODY_CHARS, room - TRUNCATE_MARK.length);
  return `${head}\n\n${body.slice(0, keep).trimEnd()}${TRUNCATE_MARK}`;
}
