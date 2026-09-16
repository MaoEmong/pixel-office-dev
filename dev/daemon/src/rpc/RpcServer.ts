// RpcServer — WebSocket(127.0.0.1) 위의 JSON-RPC 2.0. 봉투·메서드·에러 코드·알림은 PROTOCOL.md 가 계약이다.
// Office(OfficeApi)의 메서드를 그대로 노출하고, Office 이벤트를 알림으로 흘린다:
//   event → 'event'(전 클라이언트), status → 'member.status', term → 'term'(attach 한 클라이언트만), notice → 'daemon.notice'.
// 첫 요청은 반드시 hello{token}. 그 전의 다른 요청은 -32001 후 소켓 종료.
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { OfficeError, RPC_ERROR } from '../office/errors.js';
import type { OfficeApi, OfficeEvents } from '../office/types.js';
import type { Engine, MemberRank } from '../store/types.js';

export interface RpcServerOptions {
  port: number;
  /** 기본 127.0.0.1 — 로컬 전용(원격은 v2). */
  host?: string;
}

interface Client {
  id: string;
  ws: WebSocket;
  authed: boolean;
  name?: string;
  /** attach 한 memberId — term 라우팅과 연결 종료 시 detach 용. */
  attached: Set<string>;
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

/** 소켓 종료 코드(WebSocket 4000 번대는 애플리케이션 정의). */
export const CLOSE_UNAUTHORIZED = 4001;
export const CLOSE_SHUTDOWN = 1001;

type Handler = (client: Client, params: Record<string, unknown>) => unknown;

export class RpcServer {
  private readonly office: OfficeApi;
  private readonly opts: Required<RpcServerOptions>;
  private wss?: WebSocketServer;
  private readonly clients = new Map<string, Client>();
  private readonly handlers: Record<string, Handler>;
  private readonly officeListeners: Array<[keyof OfficeEvents, (...args: never[]) => void]> = [];

  constructor(office: OfficeApi, opts: RpcServerOptions) {
    this.office = office;
    this.opts = { port: opts.port, host: opts.host ?? '127.0.0.1' };
    this.handlers = this.buildHandlers();
    this.subscribeOffice();
  }

  /** 수신 시작. 실제 바인딩된 포트(0 이면 임시 포트)를 돌려준다. */
  listen(): Promise<number> {
    if (this.wss) return Promise.resolve(this.port);
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.opts.port, host: this.opts.host });
      const onError = (err: Error) => reject(err);
      wss.once('error', onError);
      wss.once('listening', () => {
        wss.off('error', onError);
        wss.on('error', (err) => console.error('[rpc] server error:', err));
        this.wss = wss;
        resolve(this.port);
      });
      wss.on('connection', (ws) => this.onConnection(ws));
    });
  }

  get port(): number {
    const addr = this.wss?.address() as AddressInfo | null | undefined;
    return addr?.port ?? 0;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** 클라이언트 전부 닫고 서버 종료. Office 이벤트 구독도 푼다. */
  async close(): Promise<void> {
    for (const [, l] of this.officeListeners) this.office.off(l as never, l as never);
    this.officeListeners.length = 0;
    for (const c of this.clients.values()) {
      try {
        c.ws.close(CLOSE_SHUTDOWN, 'daemon shutting down');
      } catch {
        // 이미 닫힌 소켓
      }
    }
    this.clients.clear();
    const wss = this.wss;
    this.wss = undefined;
    if (!wss) return;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  // ---- 연결 ------------------------------------------------------------------------

  private onConnection(ws: WebSocket): void {
    const client: Client = { id: randomUUID(), ws, authed: false, attached: new Set() };
    this.clients.set(client.id, client);
    ws.on('message', (raw) => this.onMessage(client, raw));
    ws.on('error', (err) => console.warn(`[rpc] client ${client.id.slice(0, 8)} error:`, err.message));
    ws.on('close', () => {
      this.clients.delete(client.id);
      try {
        this.office.detachAll(client.id);
      } catch (err) {
        console.warn('[rpc] detachAll failed:', err);
      }
    });
  }

  private async onMessage(client: Client, raw: RawData): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(rawToString(raw));
    } catch {
      this.sendError(client, null, RPC_ERROR.PARSE_ERROR, 'parse error');
      return;
    }
    if (!isRequest(msg)) {
      const id = isRecord(msg) && isId(msg.id) ? msg.id : null;
      this.sendError(client, id, RPC_ERROR.INVALID_REQUEST, 'invalid request');
      return;
    }
    if (msg.id === undefined) return; // 클라이언트 → 데몬 알림은 정의된 것이 없다: 무시
    const id = msg.id;
    const params = isRecord(msg.params) ? msg.params : {};

    if (!client.authed) {
      if (msg.method !== 'hello') {
        this.sendError(client, id, RPC_ERROR.UNAUTHORIZED, 'hello first', () => client.ws.close(CLOSE_UNAUTHORIZED, 'unauthorized'));
        return;
      }
      this.handleHello(client, id, params);
      return;
    }

    const handler = this.handlers[msg.method];
    if (!handler) {
      this.sendError(client, id, RPC_ERROR.METHOD_NOT_FOUND, `method not found: ${msg.method}`);
      return;
    }
    try {
      const result = await handler(client, params);
      this.send(client, { jsonrpc: '2.0', id, result: result ?? {} });
    } catch (err) {
      const { code, message, data } = toRpcError(err);
      if (code === RPC_ERROR.INTERNAL) console.error(`[rpc] ${msg.method} failed:`, err);
      this.sendError(client, id, code, message, undefined, data);
    }
  }

  /** hello{token, since?, client} → {daemon, snapshot} 후 since 초과 event replay. */
  private handleHello(client: Client, id: JsonRpcId, params: Record<string, unknown>): void {
    if (typeof params.token !== 'string' || params.token !== this.office.token) {
      this.sendError(client, id, RPC_ERROR.UNAUTHORIZED, 'bad token', () => client.ws.close(CLOSE_UNAUTHORIZED, 'unauthorized'));
      return;
    }
    const since = params.since;
    if (since !== undefined && (typeof since !== 'number' || !Number.isFinite(since))) {
      this.sendError(client, id, RPC_ERROR.INVALID_PARAMS, 'since must be a number');
      return;
    }
    const info = isRecord(params.client) ? params.client : {};
    client.authed = true;
    client.name = typeof info.name === 'string' ? info.name : undefined;

    const snapshot = this.office.snapshot();
    this.send(client, {
      jsonrpc: '2.0',
      id,
      result: { daemon: { version: this.office.version, pid: this.office.pid }, snapshot },
    });
    if (typeof since === 'number') {
      for (const ev of this.office.eventsSince(since)) this.notify(client, 'event', ev);
    }
  }

  // ---- 메서드 표 (PROTOCOL.md "클라이언트 → 데몬") ---------------------------------------

  private buildHandlers(): Record<string, Handler> {
    const o = this.office;
    return {
      'events.query': (_c, p) =>
        ({
          events: o.eventsQuery({
            departmentId: optStr(p, 'departmentId'),
            teamId: optStr(p, 'teamId'),
            memberId: optStr(p, 'memberId'),
            beforeSeq: optNum(p, 'beforeSeq'),
            limit: optNum(p, 'limit'),
          }),
        }),

      // 결과는 `{ department, head }` — 부장이 자동 출근한다(T34, D-32). 사용자가 하는 유일한 생성이다.
      'department.create': (_c, p) =>
        o.createDepartment({
          name: reqStr(p, 'name'),
          cwd: reqStr(p, 'cwd'),
          headEngine: reqEngine(p, 'headEngine'),
          headName: optStr(p, 'headName'),
        }),
      'department.delete': async (_c, p) => {
        await o.deleteDepartment(reqStr(p, 'departmentId'));
        return {};
      },
      'department.tree': () => ({ departments: o.tree() }),

      // T34 부터 **디버그 전용**(`force:true`) — 정식 경로는 부장의 `create_team` 도구(T35). 결과는 `{ team, lead }`.
      'team.create': (_c, p) => {
        requireForce(p, 'team.create', '팀은 부장이 create_team 도구로 만든다');
        return o.createTeam({
          departmentId: reqStr(p, 'departmentId'),
          name: reqStr(p, 'name'),
          leadEngine: optEngine(p, 'leadEngine') ?? optEngine(p, 'leaderEngine'),
          leadName: optStr(p, 'leadName') ?? optStr(p, 'leaderName'),
          maxMembers: optNum(p, 'maxMembers'),
          allowedEngines: optEngines(p, 'allowedEngines'),
        });
      },
      'team.delete': async (_c, p) => {
        await o.deleteTeam(reqStr(p, 'teamId'));
        return {};
      },

      // T34 부터 **디버그 전용**(`force:true`) — 사용자는 부서·부장만 만든다(D-32).
      'member.clockIn': (_c, p) => {
        requireForce(p, 'member.clockIn', '사용자는 부서를 만들어 부장만 임명한다');
        return {
          member: o.clockIn({
            parentId: optStr(p, 'parentId'),
            departmentId: optStr(p, 'departmentId'),
            teamId: optStr(p, 'teamId'),
            engine: reqEngine(p, 'engine'),
            name: reqStr(p, 'name'),
            instructions: optStr(p, 'instructions'),
            rank: optRank(p, 'rank'),
          }),
        };
      },
      'member.clockOut': async (_c, p) => {
        await o.clockOut(reqStr(p, 'memberId'));
        return {};
      },
      'member.rehire': async (_c, p) => ({ member: await o.rehire(reqStr(p, 'memberId')) }),
      'member.restart': async (_c, p) => ({ member: await o.restart(reqStr(p, 'memberId')) }),
      // `force:true` 는 "부장에게만 지시" 게이트(-32004)를 넘는 디버그 탈출구(T34) — 앱은 보내지 않는다.
      'member.instruct': (_c, p) => ({ taskId: o.instruct(reqStr(p, 'memberId'), reqStr(p, 'text'), { force: p.force === true }) }),
      'member.type': (_c, p) => {
        o.typeRaw(reqStr(p, 'memberId'), reqStr(p, 'data', true));
        return {};
      },
      'member.attach': (c, p) => {
        const memberId = reqStr(p, 'memberId');
        const res = o.attach(c.id, memberId, reqNum(p, 'cols'), reqNum(p, 'rows'));
        c.attached.add(memberId);
        return res;
      },
      'member.detach': (c, p) => {
        const memberId = reqStr(p, 'memberId');
        c.attached.delete(memberId);
        o.detach(c.id, memberId);
        return {};
      },
      'member.resize': (c, p) => {
        o.resize(c.id, reqStr(p, 'memberId'), reqNum(p, 'cols'), reqNum(p, 'rows'));
        return {};
      },
      'member.interrupt': (_c, p) => {
        o.interrupt(reqStr(p, 'memberId'));
        return {};
      },
      'member.instructions.get': (_c, p) => ({ markdown: o.getInstructions(reqStr(p, 'memberId')) }),
      // T26b: 다음 SessionStart 에 실제로 주입될 텍스트(프리앰블 + 사용자 파일 또는 기본 템플릿).
      'member.instructions.effective': (_c, p) => ({ markdown: o.buildSessionContext(reqStr(p, 'memberId')) }),
      'member.instructions.set': (_c, p) => {
        o.setInstructions(reqStr(p, 'memberId'), reqStr(p, 'markdown', true));
        return {};
      },

      'approval.respond': (_c, p) => {
        const behavior = reqStr(p, 'behavior');
        if (behavior !== 'allow' && behavior !== 'deny') throw new OfficeError(RPC_ERROR.INVALID_PARAMS, 'behavior must be allow|deny');
        o.respondApproval(reqStr(p, 'pendingId'), {
          behavior,
          updatedInput: p.updatedInput,
          message: optStr(p, 'message'),
          alwaysThisSession: p.alwaysThisSession === true,
        });
        return {};
      },
      'question.respond': (_c, p) => {
        const answers = p.answers;
        if (!isRecord(answers) || Object.values(answers).some((v) => typeof v !== 'string')) {
          throw new OfficeError(RPC_ERROR.INVALID_PARAMS, 'answers must be Record<string,string>');
        }
        o.respondQuestion(reqStr(p, 'pendingId'), answers as Record<string, string>);
        return {};
      },

      'daemon.shutdown': () => {
        // 응답을 먼저 보내고 다음 매크로태스크에서 종료 절차. 서버 자체는 Office 'shutdown' 을 받은 index.ts 가 닫는다.
        setImmediate(() => {
          this.broadcast('daemon.notice', { level: 'info', message: 'daemon shutting down' });
          this.office.shutdown().catch((err) => console.error('[rpc] shutdown failed:', err));
        });
        return {};
      },
    };
  }

  // ---- 알림 (PROTOCOL.md "데몬 → 클라이언트") ------------------------------------------------

  private subscribeOffice(): void {
    const on = <K extends keyof OfficeEvents>(name: K, l: (...args: OfficeEvents[K]) => void) => {
      this.office.on(name, l as never);
      this.officeListeners.push([name, l as (...args: never[]) => void]);
    };
    on('event', (ev) => this.broadcast('event', ev));
    on('status', (memberId, status, derived) => {
      this.broadcast('member.status', { memberId, status, derived, member: this.office.getMember(memberId) });
    });
    on('term', (memberId, data) => {
      for (const c of this.clients.values()) if (c.authed && c.attached.has(memberId)) this.notify(c, 'term', { memberId, data });
    });
    on('notice', (level, message) => this.broadcast('daemon.notice', { level, message }));
    // 트리 모양이 바뀌면(부서·팀 생성/삭제) 스냅샷을 한 번 민다(T38). 멤버 행은 `member.status` 가 알리지만
    // **부서·팀 행의 생멸을 알리는 알림은 없어서** 다른 클라이언트는 재접속할 때까지 지운 부서를 그리고 있었다
    // (T37 함정 ①). 요청한 클라이언트가 응답을 먼저 받도록 다음 매크로태스크로 미룬다.
    on('tree', () => setImmediate(() => this.pushSnapshot()));
  }

  /** 전 클라이언트에 `snapshot` 알림(PROTOCOL "데몬이 필요 시 재전송"). 종료 중이면 조용히 넘어간다. */
  private pushSnapshot(): void {
    if (!this.wss || this.clients.size === 0) return;
    try {
      this.broadcast('snapshot', this.office.snapshot());
    } catch (err) {
      console.warn('[rpc] snapshot push failed:', err);
    }
  }

  private broadcast(method: string, params: unknown): void {
    for (const c of this.clients.values()) if (c.authed) this.notify(c, method, params);
  }

  private notify(client: Client, method: string, params: unknown): void {
    this.send(client, { jsonrpc: '2.0', method, params });
  }

  private send(client: Client, msg: unknown, cb?: () => void): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    client.ws.send(JSON.stringify(msg), cb);
  }

  private sendError(client: Client, id: JsonRpcId, code: number, message: string, after?: () => void, data?: unknown): void {
    const error: Record<string, unknown> = { code, message };
    if (data !== undefined) error.data = data;
    this.send(client, { jsonrpc: '2.0', id, error }, after);
  }
}

// ---- 파라미터 검사 ---------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isId(v: unknown): v is JsonRpcId {
  return v === null || typeof v === 'string' || typeof v === 'number';
}

function isRequest(v: unknown): v is JsonRpcRequest {
  return isRecord(v) && v.jsonrpc === '2.0' && typeof v.method === 'string' && (v.id === undefined || isId(v.id));
}

function invalid(msg: string): OfficeError {
  return new OfficeError(RPC_ERROR.INVALID_PARAMS, msg);
}

function reqStr(p: Record<string, unknown>, key: string, allowEmpty = false): string {
  const v = p[key];
  if (typeof v !== 'string' || (!allowEmpty && v.length === 0)) throw invalid(`${key} must be a non-empty string`);
  return v;
}

function optStr(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw invalid(`${key} must be a string`);
  return v;
}

function reqNum(p: Record<string, unknown>, key: string): number {
  const v = p[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(`${key} must be a number`);
  return v;
}

function optNum(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(`${key} must be a number`);
  return v;
}

function reqEngine(p: Record<string, unknown>, key: string): Engine {
  const v = p[key];
  if (v !== 'claude' && v !== 'codex') throw invalid(`${key} must be claude|codex`);
  return v;
}

function optEngine(p: Record<string, unknown>, key: string): Engine | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (v !== 'claude' && v !== 'codex') throw invalid(`${key} must be claude|codex`);
  return v;
}

function optRank(p: Record<string, unknown>, key: string): MemberRank | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (v !== 'member' && v !== 'lead' && v !== 'head') throw invalid(`${key} must be head|lead|member`);
  return v;
}

/**
 * 디버그 전용 메서드의 관문(T34, D-32). 트리에서 없어진 사용자 기능(팀 직접 생성·팀원 직접 출근)은 지우지 않고
 * `force:true` 뒤로 숨긴다 — 콘솔·테스트가 쓸 길은 남기되 앱이 실수로 부르지 못하게. 없으면 -32004.
 */
function requireForce(p: Record<string, unknown>, method: string, why: string): void {
  if (p.force === true) return;
  throw new OfficeError(RPC_ERROR.RANK_RULE, `${method} 은(는) 디버그 전용입니다 — ${why} (force:true 필요)`);
}

function optEngines(p: Record<string, unknown>, key: string): Engine[] | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((e) => e !== 'claude' && e !== 'codex')) throw invalid(`${key} must be an array of claude|codex`);
  return v as Engine[];
}

function toRpcError(err: unknown): { code: number; message: string; data?: unknown } {
  if (err instanceof OfficeError) return { code: err.code, message: err.message, data: err.data };
  return { code: RPC_ERROR.INTERNAL, message: err instanceof Error ? err.message : String(err) };
}

function rawToString(raw: RawData): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw as ArrayBuffer).toString('utf8');
}
