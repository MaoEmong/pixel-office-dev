// 콘솔 클라이언트용 WebSocket JSON-RPC 2.0 클라이언트 (T08). PROTOCOL.md 의 봉투·hello·재접속 규칙만 안다.
//
// - call(method, params)  : id 상관(correlation) + 타임아웃. 에러 응답은 RpcError 로 throw.
// - hello({token, since}) : token 을 생략하면 `${config.dataDir}/daemon.json` 에서 읽는다.
// - lastSeq               : `event` 알림의 seq 와 `snapshot.seq` 의 최댓값. seq <= lastSeq 인 event 는
//                           이미 스냅샷에 반영된 replay 로 보고 'event' 로 내보내지 않는다(재접속 규칙 2).
// - connectWithRetry      : 접속 재시도 후 hello. 한 번 동기화된 뒤라면 since=lastSeq 를 자동으로 넣는다.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { config } from '../config.js';
import type { OfficeEvent, Snapshot } from '../store/types.js';

export interface DaemonInfo {
  wsPort: number;
  hookPort: number;
  token: string;
  pid: number;
  startedAt: string;
}

export function daemonInfoPath(dataDir: string = config.dataDir): string {
  return path.join(dataDir, 'daemon.json');
}

/** daemon.json 을 읽는다. 없거나 깨졌으면 null. */
export function readDaemonInfo(dataDir: string = config.dataDir): DaemonInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(daemonInfoPath(dataDir), 'utf8')) as Record<string, unknown>;
    if (!raw || typeof raw.token !== 'string') return null;
    return {
      wsPort: typeof raw.wsPort === 'number' ? raw.wsPort : config.wsPort,
      hookPort: typeof raw.hookPort === 'number' ? raw.hookPort : config.hookPort,
      token: raw.token,
      pid: typeof raw.pid === 'number' ? raw.pid : 0,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    };
  } catch {
    return null;
  }
}

/** 기본 접속 URL. daemon.json 의 wsPort 가 있으면 그것, 없으면 config.wsPort. */
export function defaultWsUrl(dataDir: string = config.dataDir): string {
  const info = readDaemonInfo(dataDir);
  return `ws://127.0.0.1:${info?.wsPort ?? config.wsPort}`;
}

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** 클라이언트 쪽에서 만드는 에러 코드 (서버 코드와 겹치지 않도록 양수 아님·JSON-RPC 예약 범위 밖). */
export const RPC_CLIENT_CLOSED = -1;
export const RPC_CLIENT_TIMEOUT = -2;

export interface ClientInfo {
  name: string;
  version: string;
}
export interface HelloParams {
  token?: string;
  since?: number;
  client?: ClientInfo;
}
export interface HelloResult {
  daemon: { version: string; pid: number };
  snapshot: Snapshot;
}
export interface TermChunk {
  memberId: string;
  data: string;
}
export interface MemberStatusNotice {
  memberId: string;
  status: string;
  derived?: string | null;
}
export interface DaemonNotice {
  level: string;
  message: string;
}
export interface Notification {
  method: string;
  params: unknown;
}

export interface RpcClientEvents {
  /** 모든 알림(원본). */
  notification: [Notification];
  /** seq > lastSeq 인 event 만. */
  event: [OfficeEvent];
  snapshot: [Snapshot];
  term: [TermChunk];
  'member.status': [MemberStatusNotice];
  'daemon.notice': [DaemonNotice];
  open: [];
  /** 열렸던 소켓이 닫힘(접속 실패는 여기 안 옴). */
  close: [number, string];
  error: [Error];
}

export interface ConnectWithRetryOptions {
  url?: string;
  intervalMs?: number;
  maxAttempts?: number;
  /** 생략 시 마지막 hello 의 token/client 재사용(없으면 daemon.json). */
  hello?: HelloParams;
  onAttemptFailed?: (attempt: number, err: Error) => void;
}

interface PendingCall {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout | null;
}

export const DEFAULT_CALL_TIMEOUT_MS = 15_000;
const DEFAULT_CLIENT: ClientInfo = { name: 'pixel-office-cli', version: '0.1.0' };

export class RpcClient extends EventEmitter<RpcClientEvents> {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly calls = new Map<number, PendingCall>();
  private _lastSeq = 0;
  private _synced = false;
  private helloBase: { token: string; client: ClientInfo } | null = null;
  private _url: string | null = null;

  constructor(private readonly dataDir: string = config.dataDir) {
    super();
  }

  get lastSeq(): number {
    return this._lastSeq;
  }
  /** 테스트·복구용: 외부에서 알고 있는 seq 를 주입. */
  set lastSeq(v: number) {
    this._lastSeq = Math.max(this._lastSeq, v);
  }
  /** hello 를 한 번이라도 성공했는가(재접속 시 since 를 넣을지 판단). */
  get synced(): boolean {
    return this._synced;
  }
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
  get url(): string | null {
    return this._url;
  }

  connect(url: string = this._url ?? defaultWsUrl(this.dataDir)): Promise<void> {
    this.dropSocket();
    this._url = url;
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.emit('open');
        resolve();
      });
      ws.on('error', (err: Error) => {
        if (!opened) reject(err);
        else this.emit('error', err);
      });
      ws.on('message', (raw: WebSocket.RawData) => this.onMessage(rawToString(raw)));
      ws.on('close', (code: number, reason: Buffer) => {
        if (this.ws === ws) this.ws = null;
        this.rejectAll(new RpcError(RPC_CLIENT_CLOSED, `연결이 닫혔습니다 (code ${code})`));
        if (opened) this.emit('close', code, reason.toString());
      });
    });
  }

  /** PROTOCOL: 첫 요청. token 생략 시 daemon.json. 결과의 snapshot.seq 로 lastSeq 갱신. */
  async hello(params: HelloParams = {}): Promise<HelloResult> {
    const token = params.token ?? this.helloBase?.token ?? readDaemonInfo(this.dataDir)?.token;
    if (!token) {
      throw new Error(`token 이 없습니다 — 데몬이 실행 중인지 확인하세요 (${daemonInfoPath(this.dataDir)})`);
    }
    const client = params.client ?? this.helloBase?.client ?? DEFAULT_CLIENT;
    const req: Record<string, unknown> = { token, client };
    if (typeof params.since === 'number') req.since = params.since;
    const result = (await this.call('hello', req)) as HelloResult;
    this.helloBase = { token, client };
    this._synced = true;
    if (result?.snapshot && typeof result.snapshot.seq === 'number') this.lastSeq = result.snapshot.seq;
    return result;
  }

  call(method: string, params: unknown = {}, timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RpcError(RPC_CLIENT_CLOSED, '연결되어 있지 않습니다'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.calls.delete(id);
              reject(new RpcError(RPC_CLIENT_TIMEOUT, `${method} 응답 없음 (${timeoutMs}ms)`));
            }, timeoutMs)
          : null;
      timer?.unref();
      this.calls.set(id, { method, resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (err) => {
        if (err) {
          if (timer) clearTimeout(timer);
          this.calls.delete(id);
          reject(err);
        }
      });
    });
  }

  /** 접속 재시도 → hello. 이미 한 번 동기화됐으면 since=lastSeq 를 넣어 replay 를 받는다. */
  async connectWithRetry(opts: ConnectWithRetryOptions = {}): Promise<HelloResult> {
    const intervalMs = opts.intervalMs ?? 1000;
    const maxAttempts = opts.maxAttempts ?? Number.POSITIVE_INFINITY;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.connect(opts.url);
        break;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        opts.onAttemptFailed?.(attempt, e);
        if (attempt >= maxAttempts) throw e;
        await sleep(intervalMs);
      }
    }
    const hello: HelloParams = { ...(opts.hello ?? {}) };
    if (hello.since === undefined && this._synced) hello.since = this._lastSeq;
    return this.hello(hello);
  }

  close(): void {
    this.dropSocket();
  }

  // ---- 내부 ---------------------------------------------------------------

  private dropSocket(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.removeAllListeners();
    ws.on('error', () => {});
    try {
      ws.close();
    } catch {
      /* 이미 닫힘 */
    }
    this.rejectAll(new RpcError(RPC_CLIENT_CLOSED, '클라이언트가 연결을 닫았습니다'));
  }

  private rejectAll(err: Error): void {
    for (const [id, call] of this.calls) {
      if (call.timer) clearTimeout(call.timer);
      this.calls.delete(id);
      call.reject(err);
    }
  }

  private onMessage(text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.emit('error', new Error(`JSON 파싱 실패: ${text.slice(0, 80)}`));
      return;
    }
    if (!isRecord(msg)) return;
    if (msg.id !== undefined && msg.id !== null && ('result' in msg || 'error' in msg)) {
      this.onResponse(msg);
    } else if (typeof msg.method === 'string') {
      this.onNotification(msg.method, msg.params);
    }
  }

  private onResponse(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
    const call = this.calls.get(id);
    if (!call) return;
    this.calls.delete(id);
    if (call.timer) clearTimeout(call.timer);
    if ('error' in msg && msg.error !== undefined && msg.error !== null) {
      const e = isRecord(msg.error) ? msg.error : {};
      call.reject(
        new RpcError(
          typeof e.code === 'number' ? e.code : -32603,
          typeof e.message === 'string' ? e.message : 'unknown error',
          e.data,
        ),
      );
      return;
    }
    // hello 결과의 snapshot.seq 는 뒤따르는 replay 보다 먼저(동기적으로) 반영해야 중복 적용을 막는다.
    const result = msg.result;
    if (isRecord(result) && isRecord(result.snapshot) && typeof result.snapshot.seq === 'number') {
      this.lastSeq = result.snapshot.seq;
    }
    call.resolve(result);
  }

  private onNotification(method: string, params: unknown): void {
    this.emit('notification', { method, params });
    switch (method) {
      case 'event': {
        if (!isRecord(params) || typeof params.seq !== 'number') return;
        if (params.seq <= this._lastSeq) return; // replay 중복
        this._lastSeq = params.seq;
        this.emit('event', params as unknown as OfficeEvent);
        return;
      }
      case 'snapshot': {
        if (!isRecord(params)) return;
        if (typeof params.seq === 'number') this.lastSeq = params.seq;
        this.emit('snapshot', params as unknown as Snapshot);
        return;
      }
      case 'term':
        if (isRecord(params)) this.emit('term', params as unknown as TermChunk);
        return;
      case 'member.status':
        if (isRecord(params)) this.emit('member.status', params as unknown as MemberStatusNotice);
        return;
      case 'daemon.notice':
        if (isRecord(params)) this.emit('daemon.notice', params as unknown as DaemonNotice);
        return;
      default:
        return;
    }
  }
}

function rawToString(raw: WebSocket.RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
