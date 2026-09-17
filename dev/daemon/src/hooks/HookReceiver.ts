// HookReceiver — CLI hooks(hook.js)가 POST 하는 HTTP 수신기.
//   POST /hook/<memberToken>/<event>  body=JSON 페이로드  →  응답 body=결정 JSON (없으면 '{}')
// 핸들러는 hold() 로 응답을 열어 둔 채 사용자 답을 기다릴 수 있다(어떤 이벤트를 붙들지는 어댑터가 결정).
// 설계: 01 §HookReceiver, §대기 정책. 실측: 02 §②③④.
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HookEvent, HookPayload } from './types.js';

/** 기본 보류 상한 24h. setTimeout 한계(≈24.8일) 안쪽. */
export const DEFAULT_MAX_HOLD_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface PendingHold {
  memberToken: string;
  event: HookEvent;
  /** 보류 시작 시각(epoch ms). */
  since: number;
}

/** hold() 가 돌려주는 핸들. resolve/cancel 은 처음 한 번만 유효(이후 false). */
export interface DecisionHandle extends PendingHold {
  readonly settled: boolean;
  /** 결정 JSON 을 보내고 응답을 닫는다. */
  resolve(json: unknown): boolean;
  /** '{}'(pass-through) 를 보내고 응답을 닫는다. */
  cancel(): boolean;
}

export interface HookRequest {
  memberToken: string;
  event: HookEvent;
  payload: HookPayload;
  /** emit 중 동기적으로 호출해야 한다. 이미 응답/보류됐으면 false. */
  respond(json: unknown): boolean;
  /**
   * 응답을 열어 둔다(emit 중 동기 호출). 이미 respond/hold 했으면 throw.
   * 어떤 이벤트를 붙들지는 여기서 제한하지 않는다(어댑터가 결정; 참고용 DECISION_EVENTS 는 types.ts).
   */
  hold(): DecisionHandle;
}

export interface UnknownMemberInfo {
  memberToken: string;
  event: HookEvent;
  payload: HookPayload;
}

export interface BadRequestInfo {
  method: string;
  url: string;
  reason: 'not-found' | 'body-too-large';
}

export interface BadPayloadInfo {
  memberToken: string;
  event: HookEvent;
  /** 파싱 실패한 본문 앞부분(최대 200자). */
  bodyHead: string;
  error: string;
}

export interface HookReceiverOptions {
  /** 보류 상한(ms). 초과 시 '{}' 를 보내고 'hold-timeout' 을 emit. 기본 24h. */
  maxHoldMs?: number;
  /** memberToken 검증. 생략하면 모두 허용. false 면 '{}' 응답 + 'unknown-member'. */
  isKnownMember?: (token: string) => boolean;
  /** 요청 본문 상한(bytes). 기본 16MB. */
  maxBodyBytes?: number;
}

export interface HookReceiverEvents {
  /** 알려진 멤버의 hook. 핸들러는 emit 중 동기적으로 respond()/hold() 를 부른다. */
  hook: [req: HookRequest];
  /** isKnownMember 가 false 를 돌려준 요청('{}' 로 응답함). */
  'unknown-member': [info: UnknownMemberInfo];
  /** 보류가 maxHoldMs 를 넘겨 '{}' 로 닫힘. */
  'hold-timeout': [info: PendingHold];
  /** 결정 전에 hook 프로세스 쪽 연결이 끊김(CLI 종료·hook timeout 등). 응답은 보내지 못함. */
  'hold-closed': [info: PendingHold];
  /** 라우팅 실패·본문 초과('{}' 로 응답함). */
  'bad-request': [info: BadRequestInfo];
  /** 본문이 JSON 이 아님('{}' 로 응답함, 'hook' 은 emit 하지 않음). */
  'bad-payload': [info: BadPayloadInfo];
  /** 'hook' 리스너가 throw 함('{}' 로 응답함). */
  'handler-error': [err: unknown, req: Omit<HookRequest, 'respond' | 'hold'>];
}

type HoldState = 'open' | 'responded' | 'held';

interface HoldEntry extends PendingHold {
  settled: boolean;
  timer: NodeJS.Timeout;
  res: http.ServerResponse;
}

export class HookReceiver extends EventEmitter<HookReceiverEvents> {
  private readonly server: http.Server;
  private readonly holds = new Set<HoldEntry>();
  private readonly maxHoldMs: number;
  private readonly maxBodyBytes: number;
  private readonly isKnownMember: (token: string) => boolean;

  constructor(options: HookReceiverOptions = {}) {
    super();
    this.maxHoldMs = options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.isKnownMember = options.isKnownMember ?? (() => true);
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    // hook 이 붙든 채 오래 기다리므로 서버 쪽 idle 타임아웃은 끈다.
    this.server.keepAliveTimeout = 0;
    this.server.headersTimeout = 0;
    this.server.requestTimeout = 0;
    this.server.timeout = 0;
  }

  /** 수신 시작. 실제 바인딩된 포트를 돌려준다(0 이면 임시 포트). */
  listen(port: number, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once('error', onError);
      this.server.listen(port, host, () => {
        this.server.off('error', onError);
        resolve(this.port);
      });
    });
  }

  /** 바인딩된 포트. 아직 listen 전이면 0. */
  get port(): number {
    const addr = this.server.address() as AddressInfo | null;
    return addr?.port ?? 0;
  }

  /** 열린 보류 전부 '{}' 로 닫고 서버를 내린다. */
  async close(): Promise<void> {
    for (const h of [...this.holds]) this.settle(h, '{}');
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  /** 지금 보류 중인 응답 목록(오래된 순). */
  pendingHolds(): PendingHold[] {
    return [...this.holds].map(({ memberToken, event, since }) => ({ memberToken, event, since }));
  }

  // ---- 내부 -------------------------------------------------------------

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '';
    const method = req.method ?? '';
    const m = /^\/hook\/([^/]+)\/([^/]+)\/?$/.exec(url);
    if (method !== 'POST' || !m) {
      this.reply(res, 404, '{}');
      this.emit('bad-request', { method, url, reason: 'not-found' });
      req.resume();
      return;
    }
    const memberToken = safeDecode(m[1]!);
    const event = safeDecode(m[2]!) as HookEvent;

    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > this.maxBodyBytes) {
        tooLarge = true;
        this.reply(res, 413, '{}');
        this.emit('bad-request', { method, url, reason: 'body-too-large' });
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => {
      if (!res.writableEnded) this.reply(res, 400, '{}');
    });
    req.on('end', () => {
      if (tooLarge) return;
      const text = Buffer.concat(chunks).toString('utf8');
      let payload: HookPayload;
      try {
        const parsed: unknown = text.trim() === '' ? {} : JSON.parse(text);
        payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as HookPayload) : { raw: parsed };
      } catch (err) {
        this.reply(res, 200, '{}');
        this.emit('bad-payload', { memberToken, event, bodyHead: text.slice(0, 200), error: String(err) });
        return;
      }
      this.dispatch(memberToken, event, payload, res);
    });
  }

  private dispatch(memberToken: string, event: HookEvent, payload: HookPayload, res: http.ServerResponse): void {
    if (!this.isKnownMember(memberToken)) {
      this.reply(res, 200, '{}');
      this.emit('unknown-member', { memberToken, event, payload });
      return;
    }

    let state: HoldState = 'open';
    let handle: DecisionHandle | undefined;
    const request: HookRequest = {
      memberToken,
      event,
      payload,
      respond: (json) => {
        if (state !== 'open') return false;
        state = 'responded';
        this.reply(res, 200, toBody(json));
        return true;
      },
      hold: () => {
        if (state !== 'open') throw new Error(`hook ${event}: already ${state}`);
        state = 'held';
        return (handle = this.createHold(memberToken, event, res));
      },
    };

    try {
      this.emit('hook', request);
    } catch (err) {
      // 백스톱(T30): 리스너가 던졌으면 응답은 **무조건** 나가야 한다. hold() 뒤에 던졌다면 respond 는 이미 막혀 있으므로
      // 그 보류를 직접 '{}' 로 닫는다 — 안 그러면 hook 프로세스가 영영 매달리고 CLI 가 TUI 프롬프트에서 멈춘다(D-38).
      if (state === 'open') {
        state = 'responded';
        this.reply(res, 200, '{}');
      } else if (state === 'held' && handle && !handle.settled) {
        handle.cancel();
      }
      this.emit('handler-error', err, { memberToken, event, payload });
      return;
    }
    // 아무도 동기적으로 respond/hold 하지 않았으면 즉시 pass-through.
    if (state === 'open') {
      state = 'responded';
      this.reply(res, 200, '{}');
    }
  }

  private createHold(memberToken: string, event: HookEvent, res: http.ServerResponse): DecisionHandle {
    const entry: HoldEntry = {
      memberToken,
      event,
      since: Date.now(),
      settled: false,
      res,
      timer: setTimeout(() => {
        if (this.settle(entry, '{}')) this.emit('hold-timeout', pick(entry));
      }, this.maxHoldMs),
    };
    this.holds.add(entry);
    // hook 프로세스가 먼저 끊으면(CLI 종료, hook timeout) 보류를 정리하고 알린다.
    res.once('close', () => {
      if (entry.settled) return;
      entry.settled = true;
      clearTimeout(entry.timer);
      this.holds.delete(entry);
      this.emit('hold-closed', pick(entry));
    });

    const self = this;
    return {
      memberToken,
      event,
      since: entry.since,
      get settled() {
        return entry.settled;
      },
      resolve: (json) => self.settle(entry, toBody(json)),
      cancel: () => self.settle(entry, '{}'),
    };
  }

  /** 보류 하나를 닫는다. 이미 닫혔으면 false. */
  private settle(entry: HoldEntry, body: string): boolean {
    if (entry.settled) return false;
    entry.settled = true;
    clearTimeout(entry.timer);
    this.holds.delete(entry);
    this.reply(entry.res, 200, body);
    return true;
  }

  private reply(res: http.ServerResponse, status: number, body: string): void {
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) {
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        connection: 'close',
      });
    }
    res.end(body);
  }
}

function toBody(json: unknown): string {
  if (typeof json === 'string') return json;
  if (json === undefined || json === null) return '{}';
  return JSON.stringify(json);
}

function pick({ memberToken, event, since }: PendingHold): PendingHold {
  return { memberToken, event, since };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
