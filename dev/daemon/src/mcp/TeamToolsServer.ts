// TeamToolsServer — 데몬이 CLI 세션에 노출하는 MCP 서버(T17, 설계 §구성 요소 1 "TeamTools MCP").
//
// HTTP(127.0.0.1:config.mcpPort) 위에 MCP Streamable HTTP 전송을 `/mcp/<memberToken>` 경로로 연다. Claude 는
// `--mcp-config <session>/mcp.json`({ mcpServers: { team: { type:'http', url } } }) 으로 그 세션에만 붙는다(Codex 는 M3).
// URL 의 memberToken 은 hook 과 같은 용도 — 어느 멤버가 부르는지 식별하는 것이지 보안 경계가 아니다(로컬 전용).
//
// 세션 관리: SDK 의 무상태 모드(`sessionIdGenerator: undefined`). 무상태 전송은 요청마다 새 인스턴스여야 하고(SDK 가 재사용을
// 거부한다) McpServer 는 전송 하나에만 붙으므로, **요청마다 McpServer + 전송을 만들고 응답이 닫히면 버린다**(도구 등록은 싼
// 작업이다). 멤버 토큰별 항목(`entries`)은 그 멤버의 살아 있는 연결(SSE 포함)을 들고 있다가 퇴근·종료 시 `dispose(token)` 으로
// 끊는다. 데몬이 죽었다 살아나도 클라이언트는 그냥 다시 initialize 하면 된다(세션 id 없음).
//
// **직급별 도구(T35, D-32 "직무 체계 rev 3")** — 목록의 단일 출처는 아래 `RANK_TOOLS` 다:
//   부장(head)   create_team · dismiss_team · delegate · reply · report(→사용자) · ask_user
//   팀장(lead)   hire · dismiss · delegate · reply · report(→부장) · ask_parent
//   팀원(member) report(→팀장) · ask_parent
// **직급 규칙은 데몬이 강제한다**(01 §TeamTools, D-06): 요청마다 store 에서 그 멤버의 rank 를 다시 읽어(모델 말을 절대
// 믿지 않는다) ① 그 직급의 도구만 tools/list 에 내보내고 ② 그래도 호출되면 `isError` + 한국어 사유를 돌려준다
// (두 겹 — 세션 중간에 직급이 바뀌어도 새 요청의 도구 목록·검사가 같이 따라온다).
// **대상 규칙**(delegate/reply/hire/dismiss 는 살아 있는 직속 부하에게만, report/ask_parent 는 직속 상사에게만)은
// 여기가 아니라 Office 한 곳에서 본다 — 이 서버는 store 를 모른다.
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/** MCP 서버 이름(Claude 에서 도구는 `mcp__team__ask_user` 로 보인다 — mcp.json 의 키 "team" 기준). */
export const TEAM_MCP_NAME = 'team';
/** 경로 접두사: `/mcp/<memberToken>`. */
export const MCP_PATH_PREFIX = '/mcp/';

/** 이 서버가 아는 모든 도구 이름(직급 순). PROTOCOL 의 표와 같은 순서. */
export const ALL_TEAM_TOOLS = [
  'create_team',
  'dismiss_team',
  'hire',
  'dismiss',
  'delegate',
  'reply',
  'report',
  'ask_user',
  'ask_parent',
] as const;
export type TeamToolName = (typeof ALL_TEAM_TOOLS)[number];

/** 멤버 직급(store 의 MemberRank 와 같은 값). */
export type TeamToolRank = 'head' | 'lead' | 'member';
export type TeamEngine = 'claude' | 'codex';
export type ReportToolStatus = 'done' | 'blocked' | 'aborted';

/**
 * **직급별 도구 목록의 단일 출처**(T35). 지시문 템플릿의 "도구 이름" 줄(instructions/templates.ts)과
 * PROTOCOL.md 의 표가 이 표를 그대로 읽는다.
 */
export const RANK_TOOLS: Record<TeamToolRank, readonly TeamToolName[]> = {
  head: ['create_team', 'dismiss_team', 'delegate', 'reply', 'report', 'ask_user'],
  lead: ['hire', 'dismiss', 'delegate', 'reply', 'report', 'ask_parent'],
  member: ['report', 'ask_parent'],
};

/** 직급 한글 라벨. instructions/templates.ts 의 RANK_LABEL 과 같은 말(import 순환을 피하려고 여기 둔다). */
export const MCP_RANK_LABEL: Record<TeamToolRank, string> = { head: '부장', lead: '팀장', member: '팀원' };

export function canUseTool(rank: TeamToolRank, tool: TeamToolName): boolean {
  return RANK_TOOLS[rank].includes(tool);
}

/** `ask_user` 는 부장 전용이다(D-32 "사용자에게 직접 오는 것은 부장뿐"). 팀장·팀원에게는 이 문장으로 길을 알려 준다. */
export const ASK_USER_HEAD_ONLY_MESSAGE = '부장만 사용자에게 질문할 수 있습니다. ask_parent를 쓰세요.';

/** 직급에 없는 도구를 부른 경우의 isError 사유(PROTOCOL.md·Office 와 같은 문자열). */
export function rankToolMessage(tool: string, rank: TeamToolRank): string {
  if (tool === 'ask_user') return ASK_USER_HEAD_ONLY_MESSAGE;
  const label = MCP_RANK_LABEL[rank];
  return `${tool} 는 ${label}이(가) 쓸 수 있는 도구가 아닙니다. ${label}의 도구: ${RANK_TOOLS[rank].join(', ')}.`;
}

export interface AskUserInput {
  question: string;
  options?: string[];
}

/** `ask_parent` 입력 — 모양은 ask_user 와 같고 받는 쪽만 다르다(사용자 → 직속 상사). */
export type AskParentInput = AskUserInput;

export interface CreateTeamToolInput {
  name: string;
  leadName: string;
  engine?: TeamEngine;
  instructions?: string;
}

export interface DismissTeamInput {
  teamId: string;
}

export interface HireInput {
  name: string;
  role: string;
  engine?: TeamEngine;
  instructions?: string;
}

export interface DismissInput {
  memberId: string;
}

export interface DelegateInput {
  to_member: string;
  task: string;
}

export interface ReplyInput {
  to_member: string;
  text: string;
}

export interface ReportInput {
  taskId: number;
  summary: string;
  files?: string[];
  status: ReportToolStatus;
}

/** 도구를 부른 멤버(토큰으로 찾는다). rank 는 **요청마다 store 에서 다시 읽는다**. */
export interface TeamToolsMember {
  id: string;
  name: string;
  rank: TeamToolRank;
}

/** 데몬(Office)이 MCP 서버에 넘기는 연결점. 테스트에서는 가짜. 실패는 throw(→ 도구 결과 isError). */
export interface TeamToolsHost {
  /** URL 의 memberToken → 멤버. 모르는 토큰·이미 종료된 멤버면 undefined(→ 404). */
  resolveMember(memberToken: string): TeamToolsMember | undefined;
  /** ask_user(부장 전용): pending(question) 등록 후 id 반환. */
  askUser(memberId: string, input: AskUserInput): { questionId: string };
  /** ask_parent(팀장·팀원): pending(question) 등록 + 상사 큐에 `[QUESTION from …]`. */
  askParent(memberId: string, input: AskParentInput): { questionId: string; parentName: string };
  /** create_team(부장): 팀 + 팀장 출근. */
  createTeam(memberId: string, input: CreateTeamToolInput): { teamId: string; teamName: string; leadName: string; leadMemberId: string };
  /** dismiss_team(부장): 팀장·팀원 퇴근 + 팀 해산(프로세스 종료라 비동기). */
  dismissTeam(memberId: string, input: DismissTeamInput): Promise<{ teamName: string; dismissed: string[] }>;
  /** hire(팀장): 팀원을 출근시키고 그 멤버를 돌려준다. */
  hire(memberId: string, input: HireInput): { memberId: string; name: string; engine: string };
  /** dismiss(팀장): 직속 팀원을 퇴근시킨다(프로세스 종료라 비동기). */
  dismiss(memberId: string, input: DismissInput): Promise<{ memberId: string; name: string }>;
  /** delegate(부장·팀장): task 행을 만들고 대상이 유휴면 바로 배정(assigned), 아니면 queued. */
  delegate(memberId: string, input: DelegateInput): { taskId: number; name: string; status: 'assigned' | 'queued' };
  /** reply(부장·팀장): 직속 부하의 열린 ask_parent 에 답하거나(questionId) 그냥 메시지를 넣는다. */
  reply(memberId: string, input: ReplyInput): { name: string; questionId?: string };
  /** report(전원): 배정받은 task 를 닫는다. `to` 는 이 보고가 올라간 곳(부장은 사용자). */
  report(memberId: string, input: ReportInput): { taskId: number; status: ReportToolStatus; to: 'user' | 'parent' };
}

export interface TeamToolsServerOptions {
  host: TeamToolsHost;
  /** MCP serverInfo.version. 기본 '0.0.0'. */
  version?: string;
}

/** ask_user 도구 결과 본문. 모델이 턴을 끝내고 기다리도록 답의 도착 형식을 알려준다. */
export function askUserResultText(questionId: string): string {
  return `질문 q#${questionId} 등록됨. 사용자의 답은 "[ANSWER q#${questionId}]" 메시지로 도착한다. 답이 필요하면 이 턴을 끝내고 기다려라.`;
}

/** ask_parent 도구 결과 본문. 답이 오는 곳만 "상사 이름" 으로 다르다. */
export function askParentResultText(questionId: string, parentName: string): string {
  return `질문 q#${questionId} 등록됨(→ ${parentName}). 답은 "[ANSWER q#${questionId}]" 메시지로 도착한다. 답이 필요하면 이 턴을 끝내고 기다려라.`;
}

export const ASK_USER_DESCRIPTION =
  '[부장 전용] 사용자(사람)에게 질문을 등록한다. 비블로킹 — 즉시 반환하며 답은 이 도구 결과에 오지 않는다. ' +
  '사용자의 답은 나중에 "[ANSWER q#<id>]" 로 시작하는 새 메시지로 도착한다. 답이 있어야 진행할 수 있으면 이 도구를 부른 뒤 ' +
  '현재 턴을 끝내고(추측으로 진행하지 말 것) 그 메시지를 기다려라. options 는 선택지 제안(사용자는 자유 답도 할 수 있다). ' +
  '사용자를 부르는 유일한 길이므로 진짜 중요한 것만 올려라 — 아래에서 올라온 질문도 네가 판단해서 고른다.';

export const ASK_PARENT_DESCRIPTION =
  '직속 상사에게 질문을 올린다(사용자에게 직접 묻는 것은 부장만 할 수 있다). 비블로킹 — 즉시 반환하며 답은 이 도구 결과에 ' +
  '오지 않는다. 상사의 답은 나중에 "[ANSWER q#<id>]" 로 시작하는 새 메시지로 도착한다. 답이 있어야 진행할 수 있으면 ' +
  '이 도구를 부른 뒤 현재 턴을 끝내고(추측으로 진행하지 말 것) 그 메시지를 기다려라. options 는 선택지 제안이다.';

const ASK_USER_SCHEMA = {
  question: z.string().min(1).describe('사용자에게 보여줄 질문 한 문장'),
  options: z.array(z.string().min(1)).max(10).optional().describe('선택지(선택). 사용자는 이 중 하나를 고르거나 자유 답을 한다'),
};

const ASK_PARENT_SCHEMA = {
  question: z.string().min(1).describe('상사에게 올릴 질문 한 문장'),
  options: z.array(z.string().min(1)).max(10).optional().describe('선택지(선택). 상사는 이 중 하나를 고르거나 자유 답을 한다'),
};

// ---- 도구 설명·스키마·결과 문구 -------------------------------------------------------

export const CREATE_TEAM_DESCRIPTION =
  '[부장 전용] 부서 안에 팀을 만들고 그 팀장을 출근시킨다. 팀장이 준비되기까지 몇 초 걸리지만 바로 이어서 delegate 해도 ' +
  '된다(유휴가 되는 순간 데몬이 전달한다). 팀장은 필요하면 스스로 팀원을 hire 해 일을 나눈다. 작업 폴더는 부서와 같다.';

const CREATE_TEAM_SCHEMA = {
  name: z.string().min(1).describe('팀 이름. 사무실의 책상 묶음 이름이 된다'),
  leadName: z.string().min(1).describe('그 팀 팀장의 이름. 사무실 캐릭터 이름이자 [TASK#n from <이름>(팀장)] 에 쓰인다'),
  engine: z.enum(['claude', 'codex']).optional().describe('팀장의 CLI 엔진(선택). 생략하면 너와 같은 엔진'),
  instructions: z.string().optional().describe('그 팀장의 INSTRUCTIONS.md 초안(선택). 없으면 데몬 기본 팀장 지시문'),
};

export const DISMISS_TEAM_DESCRIPTION =
  '[부장 전용] 일이 끝난 팀을 해산한다. 그 팀의 팀장이 유휴(idle)이고 팀에 미종료 task 가 없을 때만 된다 — ' +
  '팀장·팀원이 모두 퇴근하고 팀이 사라진다. 아직 일하는 중이면 보고를 기다려라.';

const DISMISS_TEAM_SCHEMA = {
  teamId: z.string().min(1).describe('해산할 팀의 teamId(create_team 결과에 나온 id)'),
};

export const HIRE_DESCRIPTION =
  '[팀장 전용] 새 팀원을 출근시킨다. 데몬이 그 팀의 작업 디렉토리에서 CLI 세션을 띄우고 role 로 시작하는 지시문을 주입한다. ' +
  '즉시 반환하지만 팀원이 준비되기까지 몇 초 걸리므로, 바로 이어서 delegate 해도 된다(준비되면 데몬이 알아서 전달한다). ' +
  '팀 정원(maxMembers)을 넘으면 실패한다 — 끝난 팀원은 dismiss 로 정리하고 다시 불러라. 작은 일은 팀원 없이 직접 해도 된다.';

const HIRE_SCHEMA = {
  name: z.string().min(1).describe('팀원 이름. 사무실 캐릭터 이름이자 [TASK#n from <이름>] 에 쓰인다'),
  role: z.string().min(1).describe('맡길 역할 한 줄. 그 팀원 지시문의 첫 줄 "# 역할: <role>" 이 된다'),
  engine: z.enum(['claude', 'codex']).optional().describe('CLI 엔진(선택). 생략하면 팀 기본(팀장과 같은 엔진)'),
  instructions: z.string().optional().describe('그 팀원의 INSTRUCTIONS.md 초안(선택). 역할 줄 아래에 붙는다'),
};

export const DISMISS_DESCRIPTION =
  '[팀장 전용] 일이 끝난 팀원을 퇴근시킨다. **네가 hire 한 직속 팀원만**, 그리고 그 팀원이 유휴(idle)이고 미종료 task 가 ' +
  '없을 때만 된다. 사용자가 출근시킨 팀원은 사용자만 퇴근시킬 수 있다. 아직 일하는 중이면 보고를 기다려라.';

const DISMISS_SCHEMA = {
  memberId: z.string().min(1).describe('퇴근시킬 팀원의 memberId(hire 결과·[REPORTS] 에 나온 id)'),
};

export const DELEGATE_DESCRIPTION =
  '**직속 부하에게만** 작업을 맡긴다(부장 → 팀장, 팀장 → 팀원). 비블로킹 — task 행만 만들고 즉시 반환한다. 대상이 유휴면 ' +
  '바로 전달되고(assigned), 아니면 줄을 서 있다가(queued) 유휴가 되는 순간 데몬이 전달한다. 부하의 보고는 나중에 ' +
  '"[REPORTS task#n …]" 메시지로 오고, 네가 낸 task 가 전부 끝나면 마지막에 "[ALL_REPORTS_IN]" 이 붙는다. ' +
  '그때 취합해서 report 로 위에 보고하라. 부하마다 겹치지 않는 디렉토리·파일을 맡기고 빌드·테스트는 한 번에 한 명만 시켜라.';

const DELEGATE_SCHEMA = {
  to_member: z.string().min(1).describe('맡길 직속 부하의 memberId(자기 자신·상사·남의 부하는 불가)'),
  task: z.string().min(1).describe('그 부하가 받을 지시 전문. 범위·완료 조건을 분명히 적어라'),
};

export const REPLY_DESCRIPTION =
  '직속 부하에게 한마디 보낸다. 그 부하가 ask_parent 로 물어 둔 질문이 열려 있으면 **그 질문의 답**으로 들어가고' +
  '("[ANSWER q#n]"), 열린 질문이 없으면 그냥 메시지로 들어간다("[MESSAGE from <너>]"). 새 작업을 시키는 것은 delegate 다.';

const REPLY_SCHEMA = {
  to_member: z.string().min(1).describe('답을 받을 직속 부하의 memberId([QUESTION from …] 을 보낸 그 멤버)'),
  text: z.string().min(1).describe('답 또는 전할 말. 부하는 이것만 읽고 판단한다'),
};

export const REPORT_DESCRIPTION =
  '배정받은 task 를 닫고 보고한다. taskId 는 "[TASK#n from …]" 메시지의 n 이고, **자기에게 배정된 task 만** 보고할 수 있다. ' +
  '보고는 직속 상사에게 올라가고, 부장의 보고만 사용자 책상으로 간다. ' +
  "status: 'done' 끝남 / 'blocked' 막힘(즉시 위로 전달된다 — summary 에 무엇이 막는지 적어라) / 'aborted' 중단.";

const REPORT_SCHEMA = {
  taskId: z.coerce.number().int().positive().describe('보고할 task 번호([TASK#n] 의 n)'),
  summary: z.string().min(1).describe('결과 요약. 위에서 이것만 읽고 판단할 수 있게 적어라'),
  files: z.array(z.string().min(1)).max(50).optional().describe('건드린 파일 경로(선택)'),
  status: z.enum(['done', 'blocked', 'aborted']).describe('done | blocked(막힘, 즉시 전달) | aborted(중단)'),
};

export function createTeamResultText(teamName: string, leadName: string, leadMemberId: string): string {
  return `팀 ${teamName} 생성, 팀장 ${leadName}(${leadMemberId}) 출근.`;
}

export function dismissTeamResultText(teamName: string, dismissed: string[]): string {
  return `팀 ${teamName} 해산. ${dismissed.length}명 퇴근 (${dismissed.join(', ') || '없음'}).`;
}

export function hireResultText(name: string, memberId: string, engine: string): string {
  return `팀원 ${name} (${memberId}) 출근. 엔진 ${engine}.`;
}

export function dismissResultText(name: string, memberId: string): string {
  return `팀원 ${name} (${memberId}) 퇴근. 자리가 하나 비었다.`;
}

export function delegateResultText(taskId: number, name: string, status: 'assigned' | 'queued'): string {
  const tail =
    status === 'assigned'
      ? '전달됨. 보고는 "[REPORTS task#…]" 메시지로 온다 — 이 턴을 끝내고 기다려라.'
      : '대기(부하가 바쁘다). 유휴가 되면 데몬이 전달한다. 보고는 "[REPORTS task#…]" 메시지로 온다.';
  return `task#${taskId} → ${name} (${status}) ${tail}`;
}

export function replyResultText(name: string, questionId?: string): string {
  return questionId ? `q#${questionId} 의 답을 ${name} 에게 전달했다.` : `${name} 에게 메시지를 전달했다(열린 질문 없음).`;
}

export function reportResultText(taskId: number, status: ReportToolStatus, to: 'user' | 'parent'): string {
  const where = to === 'user' ? '사용자 책상' : '직속 상사';
  return `task#${taskId} 보고 접수(status=${status}). ${where}(으)로 올라간다.`;
}

interface TokenEntry {
  memberId: string;
  /** 살아 있는 요청(응답이 아직 닫히지 않음). SSE 스트림도 여기 있다. */
  live: Set<LiveConnection>;
}

interface LiveConnection {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export class TeamToolsServer {
  private readonly host: TeamToolsHost;
  private readonly version: string;
  private readonly http: http.Server;
  private readonly entries = new Map<string, TokenEntry>();
  /** 살아 있는 소켓(SSE 포함) — close() 가 영원히 기다리지 않도록 끊는다. */
  private readonly sockets = new Set<Socket>();
  private boundPort = 0;

  constructor(opts: TeamToolsServerOptions) {
    this.host = opts.host;
    this.version = opts.version ?? '0.0.0';
    this.http = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error('[mcp] request failed:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
        } else {
          res.end();
        }
      });
    });
    this.http.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
  }

  /** 실제 바인딩된 포트(0 이면 임시 포트). */
  get port(): number {
    return this.boundPort;
  }

  listen(port: number, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, host, () => {
        this.http.off('error', reject);
        this.boundPort = (this.http.address() as AddressInfo).port;
        resolve(this.boundPort);
      });
    });
  }

  /** 모든 연결을 끊고 서버를 닫는다. 두 번 불러도 무해. */
  async close(): Promise<void> {
    for (const token of [...this.entries.keys()]) this.dispose(token);
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (!this.http.listening) return;
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  /** 멤버 퇴근·종료: 그 토큰의 살아 있는 연결을 끊고 항목을 지운다(Office 가 pty exit 에서 부른다). */
  dispose(memberToken: string): void {
    const entry = this.entries.get(memberToken);
    if (!entry) return;
    this.entries.delete(memberToken);
    for (const c of entry.live) closeConnection(c);
    entry.live.clear();
  }

  /** 진단·테스트: 토큰별(또는 전체) 살아 있는 연결 수. */
  liveConnections(memberToken?: string): number {
    if (memberToken !== undefined) return this.entries.get(memberToken)?.live.size ?? 0;
    let n = 0;
    for (const e of this.entries.values()) n += e.live.size;
    return n;
  }

  /** 지금 항목이 있는(한 번이라도 요청한) 토큰 목록. */
  knownTokens(): string[] {
    return [...this.entries.keys()];
  }

  // ---- 내부 ----------------------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const token = tokenFromUrl(req.url ?? '');
    const member = token ? this.host.resolveMember(token) : undefined;
    if (!token || !member) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unknown member token' }, id: null }));
      return;
    }
    let entry = this.entries.get(token);
    if (!entry || entry.memberId !== member.id) {
      entry = { memberId: member.id, live: new Set() };
      this.entries.set(token, entry);
    }

    const server = this.buildServer(token, member);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const conn: LiveConnection = { server, transport };
    entry.live.add(conn);
    // JSON 응답은 finish 에서, SSE 스트림·끊긴 소켓은 close 에서 정리한다(둘 다 와도 한 번만).
    const done = () => {
      if (!entry.live.delete(conn)) return;
      closeConnection(conn);
    };
    res.once('finish', done);
    res.once('close', done);
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  /**
   * 멤버 하나에 묶인 McpServer(도구 콜백이 memberId 를 닫아 둔다). 요청마다 새로 만든다.
   * **그 직급의 도구만 등록한다**(`RANK_TOOLS`) — 팀원의 tools/list 에는 report·ask_parent 만 보인다.
   * 콜백 안에서 한 번 더 `resolveMember(token)` 으로 직급을 확인한다(모델이 아니라 store 가 기준, 두 겹).
   */
  private buildServer(memberToken: string, member: TeamToolsMember): McpServer {
    const memberId = member.id;
    const server = new McpServer({ name: TEAM_MCP_NAME, version: this.version });
    const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
    const fail = (tool: string, message: string): CallToolResult => ({
      isError: true,
      content: [{ type: 'text', text: `${tool} 실패: ${message}` }],
    });
    const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });
    /** 호출 시점의 직급 검사. 통과하면 undefined, 아니면 그대로 돌려줄 isError 결과. */
    const gate = (tool: TeamToolName): CallToolResult | undefined => {
      const fresh = this.host.resolveMember(memberToken);
      if (!fresh) return fail(tool, '멤버를 찾을 수 없습니다(이미 퇴근했을 수 있습니다).');
      if (!canUseTool(fresh.rank, tool)) return fail(tool, rankToolMessage(tool, fresh.rank));
      return undefined;
    };
    const has = (tool: TeamToolName): boolean => canUseTool(member.rank, tool);

    if (has('create_team')) {
      server.registerTool(
        'create_team',
        { title: '팀 만들기(부장 전용)', description: CREATE_TEAM_DESCRIPTION, inputSchema: CREATE_TEAM_SCHEMA, annotations },
        async (input) => {
          const denied = gate('create_team');
          if (denied) return denied;
          try {
            const r = this.host.createTeam(memberId, input);
            return ok(createTeamResultText(r.teamName, r.leadName, r.leadMemberId));
          } catch (err) {
            return fail('create_team', errText(err));
          }
        },
      );
    }

    if (has('dismiss_team')) {
      server.registerTool(
        'dismiss_team',
        { title: '팀 해산(부장 전용)', description: DISMISS_TEAM_DESCRIPTION, inputSchema: DISMISS_TEAM_SCHEMA, annotations },
        async (input) => {
          const denied = gate('dismiss_team');
          if (denied) return denied;
          try {
            const r = await this.host.dismissTeam(memberId, input);
            return ok(dismissTeamResultText(r.teamName, r.dismissed));
          } catch (err) {
            return fail('dismiss_team', errText(err));
          }
        },
      );
    }

    if (has('hire')) {
      server.registerTool(
        'hire',
        { title: '팀원 출근(팀장 전용)', description: HIRE_DESCRIPTION, inputSchema: HIRE_SCHEMA, annotations },
        async (input) => {
          const denied = gate('hire');
          if (denied) return denied;
          try {
            const r = this.host.hire(memberId, input);
            return ok(hireResultText(r.name, r.memberId, r.engine));
          } catch (err) {
            return fail('hire', errText(err));
          }
        },
      );
    }

    if (has('dismiss')) {
      server.registerTool(
        'dismiss',
        { title: '팀원 퇴근(팀장 전용)', description: DISMISS_DESCRIPTION, inputSchema: DISMISS_SCHEMA, annotations },
        async (input) => {
          const denied = gate('dismiss');
          if (denied) return denied;
          try {
            const r = await this.host.dismiss(memberId, input);
            return ok(dismissResultText(r.name, r.memberId));
          } catch (err) {
            return fail('dismiss', errText(err));
          }
        },
      );
    }

    if (has('delegate')) {
      server.registerTool(
        'delegate',
        { title: '작업 위임(직속 부하)', description: DELEGATE_DESCRIPTION, inputSchema: DELEGATE_SCHEMA, annotations },
        async (input) => {
          const denied = gate('delegate');
          if (denied) return denied;
          try {
            const r = this.host.delegate(memberId, input);
            return ok(delegateResultText(r.taskId, r.name, r.status));
          } catch (err) {
            return fail('delegate', errText(err));
          }
        },
      );
    }

    if (has('reply')) {
      server.registerTool(
        'reply',
        { title: '부하에게 답·전달', description: REPLY_DESCRIPTION, inputSchema: REPLY_SCHEMA, annotations },
        async (input) => {
          const denied = gate('reply');
          if (denied) return denied;
          try {
            const r = this.host.reply(memberId, input);
            return ok(replyResultText(r.name, r.questionId));
          } catch (err) {
            return fail('reply', errText(err));
          }
        },
      );
    }

    if (has('report')) {
      server.registerTool(
        'report',
        { title: '작업 보고', description: REPORT_DESCRIPTION, inputSchema: REPORT_SCHEMA, annotations },
        async (input) => {
          const denied = gate('report');
          if (denied) return denied;
          try {
            const r = this.host.report(memberId, input);
            return ok(reportResultText(r.taskId, r.status, r.to));
          } catch (err) {
            return fail('report', errText(err));
          }
        },
      );
    }

    if (has('ask_user')) {
      server.registerTool(
        'ask_user',
        { title: '사용자에게 질문(부장 전용, 비블로킹)', description: ASK_USER_DESCRIPTION, inputSchema: ASK_USER_SCHEMA, annotations },
        async ({ question, options }) => {
          const denied = gate('ask_user');
          if (denied) return denied;
          try {
            const { questionId } = this.host.askUser(memberId, { question, options });
            return ok(askUserResultText(questionId));
          } catch (err) {
            return fail('ask_user', errText(err));
          }
        },
      );
    }

    if (has('ask_parent')) {
      server.registerTool(
        'ask_parent',
        { title: '상사에게 질문(비블로킹)', description: ASK_PARENT_DESCRIPTION, inputSchema: ASK_PARENT_SCHEMA, annotations },
        async ({ question, options }) => {
          const denied = gate('ask_parent');
          if (denied) return denied;
          try {
            const r = this.host.askParent(memberId, { question, options });
            return ok(askParentResultText(r.questionId, r.parentName));
          } catch (err) {
            return fail('ask_parent', errText(err));
          }
        },
      );
    }
    return server;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `/mcp/<token>` (뒤에 ? 나 / 가 붙어도 허용) → token. 다른 경로는 undefined. */
export function tokenFromUrl(url: string): string | undefined {
  if (!url.startsWith(MCP_PATH_PREFIX)) return undefined;
  const rest = url.slice(MCP_PATH_PREFIX.length);
  const token = rest.split(/[/?#]/, 1)[0] ?? '';
  return /^[A-Za-z0-9_-]+$/.test(token) ? token : undefined;
}

function closeConnection(c: LiveConnection): void {
  c.transport.close().catch(() => {});
  c.server.close().catch(() => {});
}
