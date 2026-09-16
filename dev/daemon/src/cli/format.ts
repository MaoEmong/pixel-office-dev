// 콘솔 출력 포맷 (T08). ANSI 제거·이벤트 한 줄 요약·멤버/팀/pending 표.
import type { Department, EventDetail, Member, OfficeEvent, Pending, Task, Team } from '../store/types.js';

// CSI / OSC / DCS / 2-byte ESC 시퀀스 / 나머지 C0 제어문자(\t \n \r 제외).
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1bP[\s\S]*?\x1b\\|\x1b[ #%()*+\-.\/][0-9A-Za-z@]|\x1b[^[\]P]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function oneLine(s: string): string {
  return s.replace(/\r?\n/g, ' ⏎ ').trim();
}

/** 이벤트 detail → 짧은 요약. */
export function detailSummary(detail: EventDetail | undefined, max = 100): string {
  if (!detail) return '';
  const parts: string[] = [];
  const tool = typeof detail.tool === 'string' ? detail.tool : '';
  const target = typeof detail.cmd === 'string' ? detail.cmd : typeof detail.path === 'string' ? detail.path : '';
  if (tool || target) parts.push([tool, target].filter(Boolean).join(' '));
  if (typeof detail.summary === 'string' && detail.summary) parts.push(detail.summary);
  else if (typeof detail.text === 'string' && detail.text) parts.push(detail.text);
  if (parts.length === 0) {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(detail)) if (v !== undefined && v !== null) rest[k] = v;
    if (Object.keys(rest).length) parts.push(JSON.stringify(rest));
  }
  return truncate(oneLine(parts.join(' — ')), max);
}

export type NameOf = (memberId: string) => string;

export function formatEvent(ev: OfficeEvent, nameOf: NameOf): string {
  const ref = ev.ref ?? {};
  const refs: string[] = [];
  if (ref.approvalId) refs.push(`approval=${ref.approvalId}`);
  if (ref.questionId) refs.push(`question=${ref.questionId}`);
  if (ref.taskId !== undefined && ref.taskId !== null) refs.push(`task#${ref.taskId}`);
  const tail = [detailSummary(ev.detail), refs.join(' ')].filter(Boolean).join('  ');
  return `#${ev.seq} ${ev.kind} ${nameOf(ev.memberId)}${tail ? ' ' + tail : ''}`;
}

/** 직급 한글 라벨(데몬 templates.ts 의 RANK_LABEL 과 같은 말). */
export const RANK_LABEL: Record<Member['rank'], string> = { head: '부장', lead: '팀장', member: '팀원' };

export function formatMember(m: Member, scopeName?: string): string {
  const scope = scopeName ?? m.teamId ?? m.departmentId;
  const pid = m.childPid ? ` pid=${m.childPid}` : '';
  return `${m.id}  ${m.name} [${m.engine}] ${m.status}  ${RANK_LABEL[m.rank]}(${m.rank}) @${scope}${pid}`;
}

export function formatTeam(t: Team, memberCount: number): string {
  return `${t.id}  ${t.name}  dept=${t.departmentId}  ${t.cwd}  lead=${t.leaderId ?? '-'}  members=${memberCount}/${t.maxMembers}`;
}

export function formatDepartment(d: Department, teamCount: number, memberCount: number): string {
  return `${d.id}  ${d.name}  ${d.cwd}  head=${d.headId ?? '-'}  팀 ${teamCount}개  멤버 ${memberCount}명`;
}

/** `department.tree` 결과 한 그루(데몬 office/types.ts DepartmentTree 의 와이어 모양). */
export interface TreeNode {
  department: Department;
  head?: Member & { derived?: string };
  teams: Array<{ team: Team; lead?: Member & { derived?: string }; members: Array<Member & { derived?: string }> }>;
  orphans: Array<Member & { derived?: string }>;
}

/** 콘솔 `tree` 출력. 부서 → 부장 → 팀/팀장 → 팀원(T34). */
export function treeLines(nodes: TreeNode[]): string[] {
  const who = (m: (Member & { derived?: string }) | undefined, fallback: string): string =>
    m ? `${RANK_LABEL[m.rank]} ${m.name} [${m.engine}] ${m.derived ?? m.status} (${m.id})` : fallback;
  const out: string[] = [];
  for (const n of nodes) {
    out.push(`${n.department.name} (${n.department.id})  ${n.department.cwd}`);
    out.push(`  └ ${who(n.head, '부장 (없음)')}`);
    for (const t of n.teams) {
      out.push(`     ├ 팀 ${t.team.name} (${t.team.id})  정원 ${t.members.length + (t.lead ? 1 : 0)}/${t.team.maxMembers}`);
      out.push(`     │  └ ${who(t.lead, '팀장 (없음)')}`);
      for (const m of t.members) out.push(`     │     └ ${who(m, '')}`);
    }
    if (n.teams.length === 0) out.push('     ├ (팀 없음)');
    for (const m of n.orphans) out.push(`     ! 팀 없는 멤버: ${who(m, '')}`);
  }
  return out;
}

/** `task#12 assigned 반장→이음: <지시>  ↩ done <보고>` — 보고가 있으면 뒤에 붙는다(T25). */
export function formatTask(t: Task, nameOf: NameOf): string {
  const to = t.toMember === 'user' ? 'user' : nameOf(t.toMember);
  const from = t.fromMember === 'user' ? 'user' : nameOf(t.fromMember);
  const head = `task#${t.id} ${t.status} ${from}→${to}: ${truncate(oneLine(t.instruction), 80)}`;
  if (!t.reportStatus && !t.reportText) return head;
  const body = t.reportText ? ` ${truncate(oneLine(t.reportText), 80)}` : '';
  return `${head}  ↩ ${t.reportStatus ?? '?'}${body}`;
}

export interface LocalPending {
  id: string;
  memberId: string;
  type: 'approval' | 'question';
  /** 한 줄 요약(이벤트 detail 또는 payload 에서). */
  summary: string;
  /** 스냅샷에서 온 경우에만 있음. */
  payload?: Record<string, unknown>;
}

/** 스냅샷의 Pending → LocalPending. */
export function fromSnapshotPending(p: Pending): LocalPending {
  return { id: p.id, memberId: p.memberId, type: p.type, summary: pendingSummary(p.type, p.payload), payload: p.payload };
}

export function pendingSummary(type: 'approval' | 'question', payload: Record<string, unknown>): string {
  if (type === 'question') {
    const qs = questionsOf(payload);
    return qs.map((q) => `${q.question} [${q.options.join('|')}]`).join(' / ') || '(질문 내용 없음)';
  }
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '?';
  const input = isRecord(payload.tool_input) ? payload.tool_input : {};
  const target =
    typeof input.command === 'string'
      ? input.command
      : typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.path === 'string'
          ? input.path
          : '';
  return truncate(oneLine(target ? `${tool} ${target}` : tool), 100);
}

export interface QuestionItem {
  question: string;
  options: string[];
}

function labelsOf(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.map((o) => (isRecord(o) && typeof o.label === 'string' ? o.label : typeof o === 'string' ? o : '')).filter(Boolean)
    : [];
}

/**
 * question payload → {question, options(label[])}. 세 가지 모양을 받는다(PROTOCOL "TeamTools MCP", D-19):
 *  - TUI `AskUserQuestion`: `{ questions: [{question, options:[{label}…]}], tool_input }`
 *  - TeamTools `ask_user`(T17): `{ source:'ask_user', question, options: string[] }` — 질문 하나, `tool_input` 없음
 *  - TeamTools `ask_parent`(T35): 같은 모양 + `{ from, to }`(트리 간선). 답은 보통 상사가 `reply` 로 한다.
 */
export function questionsOf(payload: Record<string, unknown> | undefined): QuestionItem[] {
  if (!payload) return [];
  if (Array.isArray(payload.questions)) {
    const out: QuestionItem[] = [];
    for (const q of payload.questions) {
      if (!isRecord(q) || typeof q.question !== 'string') continue;
      out.push({ question: q.question, options: labelsOf(q.options) });
    }
    return out;
  }
  // ask_user(또는 이벤트로만 알게 된 같은 모양): 질문 하나.
  if (typeof payload.question === 'string' && payload.question) {
    return [{ question: payload.question, options: labelsOf(payload.options) }];
  }
  return [];
}

/**
 * `q_ab12  question  이음 → 반장(ask_parent)  어느 폴더에 …` (T35).
 * `ask_parent` 질문은 사용자가 아니라 **직속 상사**를 향한다 — 누가 누구에게 물었는지 한 줄에 보인다.
 */
export function formatPending(p: LocalPending, nameOf: NameOf): string {
  const who = nameOf(p.memberId);
  const to = typeof p.payload?.to === 'string' ? p.payload.to : undefined;
  const route = p.payload?.source === 'ask_parent' ? `${who} → ${nameOf(to ?? '')}(ask_parent)` : who;
  return `${p.id}  ${p.type}  ${route}  ${p.summary}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
