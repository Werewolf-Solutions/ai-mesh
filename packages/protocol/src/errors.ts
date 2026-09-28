/**
 * Error codes shared by the peer protocol, the HTTP API, and the client.
 *
 * `retryable` means "another worker/gateway may succeed and no output has been
 * shown yet". It never means "resume a partially streamed answer".
 */
export const ERROR_CODES = {
  bad_request: { http: 400, retryable: false },
  unsupported: { http: 400, retryable: false },
  context_exceeded: { http: 400, retryable: false },
  unauthorized: { http: 401, retryable: false },
  forbidden: { http: 403, retryable: false },
  payload_too_large: { http: 413, retryable: false },
  busy: { http: 429, retryable: true },
  gateway_busy: { http: 429, retryable: true },
  draining: { http: 503, retryable: true },
  not_ready: { http: 503, retryable: true },
  no_workers: { http: 503, retryable: true },
  model_mismatch: { http: 503, retryable: true },
  duplicate: { http: 409, retryable: false },
  connect_timeout: { http: 504, retryable: true },
  queue_timeout: { http: 504, retryable: true },
  first_token_timeout: { http: 504, retryable: true },
  stream_idle_timeout: { http: 504, retryable: false },
  deadline_exceeded: { http: 504, retryable: false },
  worker_unreachable: { http: 502, retryable: true },
  worker_failed: { http: 502, retryable: true },
  runtime_error: { http: 502, retryable: true },
  protocol_error: { http: 502, retryable: true },
  interrupted: { http: 502, retryable: false },
  cancelled: { http: 499, retryable: false },
  internal: { http: 500, retryable: false },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ERROR_CODE_LIST = Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]];

export class MeshError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterMs: number | undefined;
  constructor(code: ErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'MeshError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
  get retryable(): boolean {
    return ERROR_CODES[this.code].retryable;
  }
  get httpStatus(): number {
    return ERROR_CODES[this.code].http;
  }
}

export function isRetryable(code: ErrorCode): boolean {
  return ERROR_CODES[code].retryable;
}
