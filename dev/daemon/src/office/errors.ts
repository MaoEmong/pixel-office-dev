// Office 가 던지는 오류. RpcServer 가 JSON-RPC 에러 코드로 그대로 옮긴다(PROTOCOL.md "에러 코드").

export const RPC_ERROR = {
  /** 인증 실패(hello 토큰 불일치, 미인증 호출). */
  UNAUTHORIZED: -32001,
  /** 없는 멤버·팀·pending. */
  NOT_FOUND: -32002,
  /** 상태 오류(이미 종료된 멤버에 지시, 이미 답한 pending 등). */
  BAD_STATE: -32003,
  /** 직급 규칙 위반(M4). */
  RANK_RULE: -32004,
  /** JSON-RPC 표준: 파라미터 오류. */
  INVALID_PARAMS: -32602,
  /** JSON-RPC 표준: 없는 메서드. */
  METHOD_NOT_FOUND: -32601,
  /** JSON-RPC 표준: 파싱 실패. */
  PARSE_ERROR: -32700,
  /** JSON-RPC 표준: 요청 봉투 오류. */
  INVALID_REQUEST: -32600,
  /** 그 외 내부 오류. */
  INTERNAL: -32000,
} as const;

export type RpcErrorCode = (typeof RPC_ERROR)[keyof typeof RPC_ERROR];

export class OfficeError extends Error {
  constructor(
    readonly code: RpcErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'OfficeError';
  }
}

export const notFound = (what: string, id: string) => new OfficeError(RPC_ERROR.NOT_FOUND, `${what} not found: ${id}`);
export const badState = (message: string) => new OfficeError(RPC_ERROR.BAD_STATE, message);
export const invalidParams = (message: string) => new OfficeError(RPC_ERROR.INVALID_PARAMS, message);
