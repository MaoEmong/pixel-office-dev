// SessionStart additionalContext 본문(T26b, T34 에서 3단 트리로). 설계: 01 §멤버 지시문 주입
// ("SessionStart hook 의 additionalContext 반환을 1순위로 — startup/resume/clear/compact 모두에서 다시 주입되므로 compaction 유실이 없다", D-05).
//
// 주입되는 텍스트 = **런타임 프리앰블 + 유효 지시문**.
//   - 유효 지시문 = 사용자 INSTRUCTIONS.md 본문이 있으면 그것, 없으면 직급 기본 템플릿(templates.ts).
//   - 프리앰블은 **사용자 파일이 있어도 늘 붙는다.** 사용자가 쓴 지시문에는 "나는 누구이고 위아래에 누가 있는지" 가 없기 때문이다.
//     세션이 /clear·compact 로 리셋돼도 이 한 덩어리가 다시 오므로 모델이 자기 정체·상하 관계·도구 이름을 잃지 않는다.
//   - **로스터는 팀 전체가 아니라 직속 부하만**(D-32: 지시는 바로 아래로만, 보고는 바로 위로만) — 트리에서 내가 말을 걸 수
//     있는 상대가 상사 한 명과 직속 부하들뿐이라, 팀 전체를 보여 주면 없는 권한을 착각한다.
//   - 전체 길이 상한(MAX_CONTEXT_CHARS)을 넘으면 **사용자 본문만** 잘린다(프리앰블은 통째로 유지).
import { RANK_LABEL, toolsLine } from './templates.js';
import type { Department, Engine, Member, MemberRank, Team } from '../../store/types.js';

/** 프리앰블 로스터 한 줄에 들어가는 멤버(살아 있는 직속 부하만). */
export interface RosterEntry {
  name: string;
  rank: MemberRank;
  engine: Engine;
  /** 지시문 첫 줄 `# 역할: <role>`. */
  role?: string;
}

export interface SessionContextInput {
  department: Department;
  /** 팀이 있으면(팀장·팀원). 부장은 없다. */
  team?: Team;
  member: Member;
  /** 직속 상사. 부장은 없다(상사가 사용자다). */
  parent?: { name: string; rank: MemberRank };
  /** 지금 살아 있는 **직속 부하**. */
  children: RosterEntry[];
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

/** `- 상사: 반장(부장)` — 부장은 `- 상사: 사용자(사람) — 보고·질문은 너만 사용자에게 올린다`. */
export function parentLine(input: SessionContextInput): string {
  if (input.member.rank === 'head') return '- 상사: 사용자(사람) — 사용자에게 직접 보고·질문할 수 있는 직급은 너뿐이다.';
  return `- 상사: ${input.parent ? `${input.parent.name}(${RANK_LABEL[input.parent.rank]})` : '(없음)'} — 보고·질문은 여기로만 올린다.`;
}

/** `- 직속 부하(팀장): 반장(claude)` / `- 직속 부하: (없음)`. 팀 전체가 아니라 **바로 아래**만. */
export function childrenLine(children: RosterEntry[]): string {
  if (children.length === 0) return '- 직속 부하: (없음)';
  const label = RANK_LABEL[children[0]!.rank];
  return `- 직속 부하(${label}): ${children.map(describe).join(', ')}`;
}

/**
 * 지시문 앞에 늘 붙는 런타임 머리말. "너는 누구이고(이름·직급·부서/팀·엔진·작업 폴더), 위아래에 누가 있고, 어떤 도구를 쓸 수 있는가".
 * 사용자 지시문이 있든 없든 똑같이 나간다.
 */
export function sessionPreamble(input: SessionContextInput): string {
  const { member, department, team } = input;
  const where = team ? `부서 "${department.name}" 의 팀 "${team.name}"` : `부서 "${department.name}"`;
  return [
    `[사무실] 너는 픽셀 오피스 ${where} 의 ${RANK_LABEL[member.rank]} ${member.name}(엔진 ${member.engine})이다.`,
    `- 직급: ${RANK_LABEL[member.rank]} (부장 → 팀장 → 팀원; 지시·고용은 바로 아래로만, 보고·질문은 바로 위로만)`,
    `- 작업 폴더: ${member.cwd || team?.cwd || department.cwd}`,
    parentLine(input),
    childrenLine(input.children),
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
