/**
 * NapCat API 统一错误类型层次。
 *
 * 替代原先单一的 NapcatApiError，按错误性质分类，
 * 方便调用方做精细化处理（重试、降级、告警）。
 */

export enum NapcatErrorCode {
  CONNECTION_CLOSED = "CONNECTION_CLOSED",
  CONNECTION_SEND_FAILED = "CONNECTION_SEND_FAILED",
  REQUEST_TIMEOUT = "REQUEST_TIMEOUT",
  RATE_LIMIT = "RATE_LIMIT",
  CLIENT_ERROR = "CLIENT_ERROR",
  SERVER_ERROR = "SERVER_ERROR",
  API_ERROR = "API_ERROR",
}

export class NapcatApiError extends Error {
  public readonly code: NapcatErrorCode;
  public readonly statusCode: number;
  public readonly action: string;
  public readonly statusText: string;

  constructor(
    code: NapcatErrorCode,
    statusCode: number,
    statusText: string,
    action: string,
    message?: string,
    cause?: unknown,
  ) {
    super(message ?? `${code}: ${statusCode} ${statusText} for ${action}`, { cause });
    this.code = code;
    this.statusCode = statusCode;
    this.statusText = statusText;
    this.action = action;
  }
}

export class ConnectionError extends NapcatApiError {
  constructor(action: string, message?: string, cause?: unknown) {
    super(NapcatErrorCode.CONNECTION_CLOSED, 0, "Disconnected", action, message, cause);
    Object.defineProperty(this, "name", { value: "ConnectionError" });
  }
}

export class TimeoutError extends NapcatApiError {
  constructor(action: string, message?: string, cause?: unknown) {
    super(NapcatErrorCode.REQUEST_TIMEOUT, 0, "Timeout", action, message, cause);
    Object.defineProperty(this, "name", { value: "TimeoutError" });
  }
}

export class ClientApiError extends NapcatApiError {
  constructor(statusCode: number, statusText: string, action: string, message?: string, cause?: unknown) {
    super(NapcatErrorCode.CLIENT_ERROR, statusCode, statusText, action, message, cause);
    Object.defineProperty(this, "name", { value: "ClientApiError" });
  }
}

export class ServerApiError extends NapcatApiError {
  constructor(statusCode: number, statusText: string, action: string, message?: string, cause?: unknown) {
    super(NapcatErrorCode.SERVER_ERROR, statusCode, statusText, action, message, cause);
    Object.defineProperty(this, "name", { value: "ServerApiError" });
  }
}

export class RateLimitError extends NapcatApiError {
  constructor(action: string, retryAfterMs?: number, cause?: unknown) {
    super(NapcatErrorCode.RATE_LIMIT, 429, "Rate Limited", action, retryAfterMs ? `Retry after ${retryAfterMs}ms` : undefined, cause);
    this.retryAfterMs = retryAfterMs;
  }
  readonly retryAfterMs?: number;
}
