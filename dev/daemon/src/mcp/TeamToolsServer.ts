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
// 도구(지금은 ask_user 하나):
//   ask_user({ question, options? }) — 비블로킹. 데몬이 pending(question) 을 만들고 즉시 "질문 q#<id> 등록됨 …" 텍스트를 돌려준다.
//   답은 사용자가 `question.respond` 하면 그 멤버 입력 큐에 `[ANSWER q#<id>]\n<답>` 시스템 메시지로 들어간다(Office.respondQuestion).
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/** MCP 서버 이름(Claude 에서 도구는 `mcp__team__ask_user` 로 보인다 — mcp.json 의 키 "team" 기준). */
export const TEAM_MCP_NAME = 'team';
/** 경로 접두사: `/mcp/<memberToken>`. */
export const MCP_PATH_PREFIX = '/mcp/';

export interface AskUserInput {
  question: string;
  options?: string[];
}

/** 데몬(Office)이 MCP 서버에 넘기는 연결점. 테스트에서는 가짜. */
export interface TeamToolsHost {
  /** URL 의 memberToken → 멤버. 모르는 토큰·이미 종료된 멤버면 undefined(→ 404). */
  resolveMember(memberToken: string): { id: string; name: string } | undefined;
  /** ask_user: pending(question) 등록 후 id 반환. 실패는 throw(→ 도구 결과 isError). */
  askUser(memberId: string, input: AskUserInput): { questionId: string };
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

export const ASK_USER_DESCRIPTION =
  '사용자(사람)에게 질문을 등록한다. 비블로킹 — 즉시 반환하며 답은 이 도구 결과에 오지 않는다. ' +
  '사용자의 답은 나중에 "[ANSWER q#<id>]" 로 시작하는 새 메시지로 도착한다. 답이 있어야 진행할 수 있으면 이 도구를 부른 뒤 ' +
  '현재 턴을 끝내고(추측으로 진행하지 말 것) 그 메시지를 기다려라. options 는 선택지 제안(사용자는 자유 답도 할 수 있다).';

const ASK_USER_SCHEMA = {
  question: z.string().min(1).describe('사용자에게 보여줄 질문 한 문장'),
  options: z.array(z.string().min(1)).max(10).optional().describe('선택지(선택). 사용자는 이 중 하나를 고르거나 자유 답을 한다'),
};

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

    const server = this.buildServer(member.id);
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

  /** 멤버 하나에 묶인 McpServer(도구 콜백이 memberId 를 닫아 둔다). 요청마다 새로 만든다. */
  private buildServer(memberId: string): McpServer {
    const server = new McpServer({ name: TEAM_MCP_NAME, version: this.version });
    server.registerTool(
      'ask_user',
      {
        title: '사용자에게 질문(비블로킹)',
        description: ASK_USER_DESCRIPTION,
        inputSchema: ASK_USER_SCHEMA,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ question, options }) => {
        try {
          const { questionId } = this.host.askUser(memberId, { question, options });
          return { content: [{ type: 'text', text: askUserResultText(questionId) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { isError: true, content: [{ type: 'text', text: `ask_user 실패: ${message}` }] };
        }
      },
    );
    return server;
  }
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
