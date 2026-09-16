// 멤버 지시문 기본 템플릿(T26b, T34 에서 3단 트리로). 설계: 01 §멤버 지시문 주입("비어 있으면 데몬 기본 템플릿") ·
// "직무 체계 rev 3"(D-32: 부장 → 팀장 → 팀원).
//
// 본문은 앱(T26a `dev/app/lib/panel/instructions_tab.dart` 의 leaderInstructionTemplate / memberInstructionTemplate)과
// **같은 문장**이다 — 앱의 "기본 템플릿 넣기" 버튼이 넣는 초안과 데몬이 자동으로 주입하는 기본값이 갈라지면 안 된다.
// 데몬 쪽에만 더 있는 것: (1) 동적 머리말(이름·직급·부서/팀·작업 폴더·엔진·역할·상사), (2) 팀 설정에서 온 숫자(정원·허용 엔진),
// (3) 도구 이름 줄 — Claude 2.1.270 은 MCP 도구를 지연 로딩하므로 이름을 적어 두면 ToolSearch 로 바로 찾는다(D-22, T25 실기).
//
// 기본값은 **파일로 저장하지 않는다.** 여기 문장을 고치면 지시문을 따로 쓰지 않은 멤버 전원에게 다음 SessionStart 부터 바로 반영된다.
// T34 는 **직급 라벨·상사 줄·부장 템플릿만** 트리에 맞춘 최소 수정이다 — 직급별 도구 목록(부장 create_team 등)과
// 그에 맞춘 문장은 T35 가 확정한다.
import { EVERYONE_TOOLS, LEADER_ONLY_TOOLS, TEAM_MCP_NAME } from '../../mcp/TeamToolsServer.js';
import type { Engine, Member, MemberRank } from '../../store/types.js';

/** 템플릿 문장이 쓰는 "범위" — 팀이 있으면 팀, 팀 없는 부장은 부서. */
export interface TemplateScope {
  name: string;
  cwd: string;
  maxMembers: number;
  allowedEngines: Engine[];
}

/** 템플릿이 쓰는 맥락. 전부 store(부서·팀·멤버 행)에서 온다. */
export interface InstructionContext {
  /** 부서 또는 팀 이름. */
  scopeName: string;
  cwd: string;
  memberName: string;
  /** 지시문 첫 줄의 `# 역할: <role>`(hire 가 쓴 것). 없으면 생략. */
  role?: string;
  engine: Engine;
  maxMembers: number;
  allowedEngines: Engine[];
  /** 직속 상사 이름. 부장은 없다(사용자가 상사다). */
  parentName?: string;
}

export const RANK_LABEL: Record<MemberRank, string> = { head: '부장', lead: '팀장', member: '팀원' };

/** 그 직급이 실제로 쓸 수 있는 TeamTools 도구의 **전체 이름**(MCP 서버 이름 포함). 직급별 목록 확정은 T35. */
export function toolNames(rank: MemberRank): string[] {
  const tools = rank === 'lead' ? [...LEADER_ONLY_TOOLS, ...EVERYONE_TOOLS] : [...EVERYONE_TOOLS];
  return tools.map((t) => `mcp__${TEAM_MCP_NAME}__${t}`);
}

/**
 * 지시문·프리앰블 양쪽에 들어가는 도구 이름 줄. D-22 참고: Claude 는 MCP 도구를 지연 로딩하므로
 * 이름이 적혀 있어야 `ToolSearch` 로 찾아 첫 턴부터 쓴다(T25 실기 로그).
 */
export function toolsLine(rank: MemberRank): string {
  return `도구 이름: ${toolNames(rank).join(', ')} (도구 목록에 없으면 ToolSearch로 찾는다).`;
}

/** `# <이름> — <부장|팀장|팀원> @ <부서/팀>` + 작업 폴더·엔진(+ 역할 / 상사). */
export function instructionHeader(ctx: InstructionContext, rank: MemberRank): string {
  const lines = [`# ${ctx.memberName} — ${RANK_LABEL[rank]} @ ${ctx.scopeName}`, `- 작업 폴더: ${ctx.cwd}`, `- 엔진: ${ctx.engine}`];
  if (ctx.role) lines.push(`- 역할: ${ctx.role}`);
  lines.push(rank === 'head' ? '- 상사: 사용자(사람)' : `- 상사: ${ctx.parentName ?? '(없음)'}`);
  return lines.join('\n');
}

/** 부장(부서 오케스트레이터) 기본 지시문. 팀 생성 도구는 T35 에서 붙는다. */
export function headTemplate(ctx: InstructionContext): string {
  return `${instructionHeader(ctx, 'head')}

## 부장 지시문
너는 이 부서의 부장이다. 사용자와 직접 말하는 유일한 직급이다. 사용자의 [TASK#n from user] 지시를 받으면:
1. 일을 팀 단위로 쪼갠다. 팀을 만들면 팀장이 자동으로 출근하고, 팀장이 팀원을 고용해 일을 나눈다.
2. 지시·위임은 **바로 아래(팀장)** 에게만 한다. 팀원에게 직접 시키지 않는다.
3. 보고는 팀장에게서 [REPORTS ...] 로 올라온다. [ALL_REPORTS_IN]이 오면 취합해 report(taskId, summary, status)로 사용자에게 보고한다.
4. 사용자에게 물어볼 것은 ask_user(question, options?)로. 답은 [ANSWER q#n] 메시지로 온다. 팀장·팀원은 사용자에게 직접 묻지 못하므로, 올라온 질문 중 진짜 중요한 것만 네가 올린다.
${toolsLine('head')}
`;
}

/** 팀장(오케스트레이터) 기본 지시문. 앱 `leaderInstructionTemplate` 과 같은 문장 + 동적 머리말·정원·허용 엔진. */
export function leaderTemplate(ctx: InstructionContext): string {
  return `${instructionHeader(ctx, 'lead')}

## 팀장 지시문
너는 이 팀의 팀장(오케스트레이터)이다. 부장의 [TASK#n from ${ctx.parentName ?? '<부장>'}] 지시를 받으면:
1. 작업을 팀원 단위로 쪼갠다. 필요한 팀원이 없으면 team MCP의 hire(name, role, engine?, instructions?)로 만든다.
2. delegate(to_member, task)로 배정한다. 팀원마다 겹치지 않는 디렉토리/파일을 맡기고, 빌드·테스트 명령은 한 번에 한 명만.
3. 보고는 [REPORTS ...] 메시지로 온다. [ALL_REPORTS_IN]이 오면 취합해 report(taskId, summary, status)로 부장에게 보고한다.
4. 일이 끝난 팀원은 dismiss(memberId)로 정리한다. 팀원 상한은 ${ctx.maxMembers}명(팀장 포함), 쓸 수 있는 엔진은 ${ctx.allowedEngines.join(', ')}.
5. 사용자에게 직접 묻지 않는다 — 막히면 부장에게 올린다.
${toolsLine('lead')}
`;
}

/** 팀원 기본 지시문. 앱 `memberInstructionTemplate` 과 같은 문장 + 동적 머리말·도구 이름 줄. */
export function memberTemplate(ctx: InstructionContext): string {
  const from = ctx.parentName ? `${ctx.parentName}(팀장)` : '<팀장>';
  return `${instructionHeader(ctx, 'member')}

## 팀원 지시문
너는 이 팀의 팀원이다. [TASK#n from ${from}] 지시를 받으면 그 범위만 작업한다.
- 맡은 디렉토리/파일 밖은 건드리지 않는다. 빌드·테스트는 지시받은 경우에만.
- 끝나면 report(taskId, summary, status: done|blocked)로 팀장에게 보고한다. 막히면 status: blocked로 이유를 적는다.
- 사용자에게 직접 묻지 않는다 — 막히면 팀장에게 올린다.
${toolsLine('member')}
`;
}

/** 멤버 행 + 범위(팀 또는 부서)에서 템플릿 맥락을 만든다. */
export function contextOf(member: Member, scope: TemplateScope, opts: { role?: string; parentName?: string } = {}): InstructionContext {
  return {
    scopeName: scope.name,
    cwd: member.cwd || scope.cwd,
    memberName: member.name,
    role: opts.role,
    engine: member.engine,
    maxMembers: scope.maxMembers,
    allowedEngines: scope.allowedEngines,
    parentName: opts.parentName,
  };
}

/**
 * 지시문을 따로 쓰지 않은 멤버의 기본값. 직급으로 템플릿을 고른다.
 * **파일로 저장하지 않는다** — 부를 때마다 계산하므로 여기 문장을 고치면 전원에게 바로 반영된다(T26b 결정).
 */
export function defaultInstructions(member: Member, scope: TemplateScope, opts: { role?: string; parentName?: string } = {}): string {
  const ctx = contextOf(member, scope, opts);
  if (member.rank === 'head') return headTemplate(ctx);
  return member.rank === 'lead' ? leaderTemplate(ctx) : memberTemplate(ctx);
}
