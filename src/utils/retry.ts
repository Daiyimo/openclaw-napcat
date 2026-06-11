/**
 * HTTP 重试工具
 *
 * 提供带指数退避的重试包装器，用于 OneBot HTTP API 调用。
 * 仅重试服务端错误(5xx)和网络错误，不重试客户端错误(4xx)。
 */

/**
 * 捕获模块加载时（vi.useFakeTimers() 安装前）的真实 setImmediate 引用。
 * 直接赋值而非包一层箭头函数，避免调用时通过作用域链重新查找
 * 被 vi.useFakeTimers() 替换后的假版本。
 * 当与 vi.advanceTimersByTimeAsync() 配合使用时，需要通过真实事件循环
 * 来调度 rejection，以避免 unhandledRejection 假阳性报错。
 */
const _realSetImmediate = typeof setImmediate !== "undefined" ? setImmediate : undefined;

const _realSchedule: (fn: () => void) => void =
  _realSetImmediate !== undefined
    ? (fn) => _realSetImmediate(fn)
    : (fn) => void Promise.resolve().then(fn);

/**
 * @deprecated 兼容旧测试和外部调用者。新代码请使用 client.ts 的 NapcatApiError。
 */
export class HttpApiError extends Error {
  public readonly name = "HttpApiError";

  constructor(
    public readonly statusCode: number,
    public readonly statusText: string,
    public readonly action: string,
  ) {
    super(`HTTP ${statusCode} ${statusText} for action ${action}`);
  }

  get isServerError(): boolean {
    return this.statusCode >= 500;
  }

  get isClientError(): boolean {
    return this.statusCode >= 400 && this.statusCode < 500;
  }
}

export interface RetryOptions {
  /** 最大重试次数（不含首次调用）。默认 3 */
  maxRetries: number;
  /** 首次重试延迟（ms），后续按 2x 指数增长。默认 200 */
  baseDelayMs: number;
  /** 判断错误是否应该重试的谓词。默认 isRetryableError */
  shouldRetry: (error: unknown) => boolean;
}

/** 网络错误关键词 */
const NETWORK_ERROR_PATTERNS = [
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "fetch failed",
  "network error",
  "socket hang up",
];

/**
 * 判断错误是否值得重试。
 * 可重试：5xx 服务端错误（通过 statusCode 鸭子类型兼容 NapcatApiError），网络错误。
 * 不重试：4xx，其他未知错误。
 */
export function isRetryableError(error: unknown): boolean {
  // 鸭子类型：兼容 NapcatApiError（client.ts）等带 statusCode 的错误
  if (typeof error === "object" && error !== null && (error as any).statusCode >= 500) {
    return true;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return NETWORK_ERROR_PATTERNS.some((p) => msg.includes(p.toLowerCase()));
  }
  return false;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 200,
  shouldRetry: isRetryableError,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 内部重试循环（async）。成功时 resolve，失败时 reject。
 */
async function _retryLoop<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number,
  shouldRetry: (error: unknown) => boolean,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!shouldRetry(err) || attempt >= maxRetries) {
        throw err;
      }
      await sleep(baseDelayMs * Math.pow(2, attempt));
    }
  }
  throw lastError;
}

/**
 * 带指数退避的重试包装器。
 * 延迟序列：baseDelayMs, baseDelayMs*2, baseDelayMs*4, ...
 *
 * 通过真实 setImmediate 调度最终 rejection，避免在 vi.useFakeTimers()
 * + vi.advanceTimersByTimeAsync() 测试中出现假阳性 unhandledRejection。
 */
export function withRetry<T>(
  fn: () => Promise<T>,
  opts?: Partial<RetryOptions>,
): Promise<T> {
  const { maxRetries, baseDelayMs, shouldRetry } = { ...DEFAULT_OPTIONS, ...opts };
  const inner = _retryLoop(fn, maxRetries, baseDelayMs, shouldRetry);
  return new Promise<T>((resolve, reject) => {
    inner.then(resolve, (err) => {
      _realSchedule(() => reject(err));
    });
  });
}
