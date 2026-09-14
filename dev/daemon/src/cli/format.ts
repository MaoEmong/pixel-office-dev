// 콘솔 출력 포맷 (T08). ANSI 제거·이벤트 한 줄 요약·멤버/팀/pending 표.
import type { EventDetail, Member, OfficeEvent, Pending, Task, Team } from '../store/types.js';

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

export function formatMember(m: Member, teamName?: string): string {
  const team = teamName ?? m.teamId;
  const pid = m.childPid ? ` pid=${m.childPid}` : '';
  return `${m.id}  ${m.name} [${m.engine}] ${m.status}  ${m.rank} team=${team}${pid}`;
}

export function formatTeam(t: Team, memberCount: number): string {
  return `${t.id}  ${t.name}  ${t.cwd}  leader=${t.leaderId ?? '-'}  members=${memberCount}/${t.maxMembers}`;
}

export function formatTask(t: Task, nameOf: NameOf): string {
  const to = t.toMember === 'user' ? 'user' : nameOf(t.toMember);
  const from = t.fromMember === 'user' ? 'user' : nameOf(t.fromMember);
  return `task#${t.id} ${t.status} ${from}→${to}: ${truncate(oneLine(t.instruction), 80)}`;
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

/** question payload 의 questions[] → {question, options(label[])}. */
export function questionsOf(payload: Record<string, unknown> | undefined): QuestionItem[] {
  if (!payload || !Array.isArray(payload.questions)) return [];
  const out: QuestionItem[] = [];
  for (const q of payload.questions) {
    if (!isRecord(q) || typeof q.question !== 'string') continue;
    const options = Array.isArray(q.options)
      ? q.options
          .map((o) => (isRecord(o) && typeof o.label === 'string' ? o.label : typeof o === 'string' ? o : ''))
          .filter(Boolean)
      : [];
    out.push({ question: q.question, options });
  }
  return out;
}

export function formatPending(p: LocalPending, nameOf: NameOf): string {
  return `${p.id}  ${p.type}  ${nameOf(p.memberId)}  ${p.summary}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
