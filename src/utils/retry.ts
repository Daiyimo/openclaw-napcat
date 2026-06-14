/**
 * HTTP 重试工具 + 熔断器
 *
 * 提供带指数退避的重试包装器，用于 OneBot HTTP API 调用。
 * 仅重试服务端错误(5xx)和网络错误，不重试客户端错误(4xx)。
 *
 * 熔断器（Circuit Breaker）：
 * - Closed（正常）：记录失败次数，超过阈值 → Open
 * - Open（熔断）：快速失败，不发起请求；经过 recoveryTimeout 后 → HalfOpen
 * - HalfOpen（探测）：允许单次请求，成功 → Closed，失败 → Open
 *
 * 防止级联故障：下游持续失败时快速失败，避免耗尽连接池和线程。
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

// ============ 类型定义 ============

export interface RetryOptions {
  /** 最大重试次数（不含首次调用）。默认 3 */
  maxRetries: number;
  /** 首次重试延迟（ms），后续按 2x 指数增长。默认 200 */
  baseDelayMs: number;
  /** 判断错误是否应该重试的谓词。默认 isRetryableError */
  shouldRetry: (error: unknown) => boolean;
}

/** 熔断器状态 */
export type CircuitState = "closed" | "open" | "half_open";

/** 熔断器配置 */
export interface CircuitBreakerOptions {
  /** 连续失败多少次后熔断。默认 5 */
  failureThreshold: number;
  /** 熔断后多久尝试恢复（ms）。默认 30_000 */
  recoveryTimeoutMs: number;
  /** 熔断期间是否快速失败（不执行 fn）。默认 true */
  fastFail: boolean;
}

// ============ 网络错误识别 ============

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

// ============ 默认配置 ============

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 200,
  shouldRetry: isRetryableError,
};

const DEFAULT_CIRCUIT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  recoveryTimeoutMs: 30_000,
  fastFail: true,
};

// ============ 工具函数 ============

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

// ============ 熔断器 ============

/**
 * 熔断器：防止级联故障。
 *
 * 状态机：
 *   Closed →（连续失败 ≥ threshold）→ Open →（经过 recoveryTimeout）→ HalfOpen
 *   HalfOpen →（成功）→ Closed
 *   HalfOpen →（失败）→ Open
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly options: CircuitBreakerOptions;

  constructor(options?: Partial<CircuitBreakerOptions>) {
    this.options = { ...DEFAULT_CIRCUIT_OPTIONS, ...options };
  }

  /** 当前状态（供 /status 等调试命令查询） */
  get currentState(): CircuitState {
    // 如果处于 Open 且已过恢复窗口，自动过渡到 HalfOpen
    if (this.state === "open" && Date.now() - this.lastFailureTime >= this.options.recoveryTimeoutMs) {
      this.state = "half_open";
    }
    return this.state;
  }

  /** 是否允许通过（Closed 和 HalfOpen 允许，Open 拒绝） */
  get isClosed(): boolean {
    return this.currentState !== "open";
  }

  /** 记录一次成功 */
  recordSuccess(): void {
    this.failureCount = 0;
    this.state = "closed";
  }

  /** 记录一次失败 */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    // P1 修复：HalfOpen 状态下单次失败即回 Open（标准熔断器行为）
    const threshold =
      this.state === "half_open" ? 1 : this.options.failureThreshold;
    if (this.failureCount >= threshold) {
      this.state = "open";
    }
  }

  /** 手动重置（如管理员干预） */
  reset(): void {
    this.failureCount = 0;
    this.state = "closed";
  }

  /**
   * 执行受熔断器保护的操作。
   * Open 且 fastFail=true 时直接抛错，不执行 fn。
   */
  async execute<T>(fn: () => Promise<T>, fallback?: () => Promise<T>): Promise<T> {
    if (this.currentState === "open" && this.options.fastFail) {
      throw new Error(`Circuit breaker is OPEN (${this.failureCount} failures), fast failing`);
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      if (fallback) {
        return fallback();
      }
      throw err;
    }
  }

  /** 获取统计信息 */
  getStats(): { state: CircuitState; failureCount: number; lastFailureTime: number } {
    return {
      state: this.currentState,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

// ============ 带熔断器的重试 ============

export interface RetryWithCircuitOptions extends RetryOptions {
  /** 熔断器配置。不传则禁用熔断器 */
  circuitBreaker?: Partial<CircuitBreakerOptions>;
}

/**
 * 带指数退避 + 可选熔断器的重试包装器。
 *
 * 熔断器在多次重试全部失败后激活，防止持续向已故障的下游发请求。
 * 延迟序列：baseDelayMs, baseDelayMs*2, baseDelayMs*4, ...
 *
 * 通过真实 setImmediate 调度最终 rejection，避免在 vi.useFakeTimers()
 * + vi.advanceTimersByTimeAsync() 测试中出现假阳性 unhandledRejection。
 */
export function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryWithCircuitOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs, shouldRetry, circuitBreaker } = {
    ...DEFAULT_RETRY_OPTIONS,
    ...opts,
  };

  const breaker = circuitBreaker
    ? new CircuitBreaker(circuitBreaker)
    : null;

  const inner = async (): Promise<T> => {
    if (breaker && !breaker.isClosed) {
      throw new Error(`Circuit breaker is ${breaker.currentState}`);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (!shouldRetry(err) || attempt >= maxRetries) {
          if (breaker) breaker.recordFailure();
          throw err;
        }
        await sleep(baseDelayMs * Math.pow(2, attempt));
      }
    }
    if (breaker) breaker.recordFailure();
    throw lastError;
  };

  return new Promise<T>((resolve, reject) => {
    inner().then(resolve, (err) => {
      _realSchedule(() => reject(err));
    });
  });
}

// ============ 独立熔断器（供 rate-limiter 等模块使用） ============

/**
 * 创建独立熔断器实例。
 * 适用于非 retry 场景（如批量操作、缓存刷新）的级联故障防护。
 */
export function createCircuitBreaker(options?: Partial<CircuitBreakerOptions>): CircuitBreaker {
  return new CircuitBreaker(options);
}
