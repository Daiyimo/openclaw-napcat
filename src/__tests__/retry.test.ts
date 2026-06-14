import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry, isRetryableError, CircuitBreaker, createCircuitBreaker } from "../utils/retry.js";
import { NapcatApiError, ServerApiError, ClientApiError } from "../errors/napcat-error.js";

describe("isRetryableError", () => {
  it("returns true for ServerApiError with 5xx", () => {
    const err = new ServerApiError(502, "Bad Gateway", "send_msg");
    expect(isRetryableError(err)).toBe(true);
  });

  it("returns false for ClientApiError with 4xx", () => {
    const err = new ClientApiError(400, "Bad Request", "send_msg");
    expect(isRetryableError(err)).toBe(false);
  });

  it("returns true for network errors", () => {
    expect(isRetryableError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isRetryableError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
  });

  it("returns false for generic errors", () => {
    expect(isRetryableError(new Error("something went wrong"))).toBe(false);
  });
});

describe("withRetry", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error and succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new ServerApiError(500, "Internal", "test"))
      .mockRejectedValueOnce(new ServerApiError(503, "Unavailable", "test"))
      .mockResolvedValue("recovered");

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws last error when all retries exhausted", async () => {
    const err = new ServerApiError(500, "Internal", "test");
    const fn = vi.fn().mockRejectedValue(err);

    const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).rejects.toThrow("SERVER_ERROR: 500 Internal");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable errors", async () => {
    const err = new ServerApiError(404, "Not Found", "test");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn)).rejects.toThrow("SERVER_ERROR: 404 Not Found");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects maxRetries=0", async () => {
    const err = new ServerApiError(500, "Internal", "test");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses exponential backoff delays", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new ServerApiError(500, "err", "t"))
      .mockRejectedValueOnce(new ServerApiError(500, "err", "t"))
      .mockRejectedValueOnce(new ServerApiError(500, "err", "t"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 200 });

    await vi.advanceTimersByTimeAsync(199);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(400);
    expect(fn).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(800);
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(4);
  });
});

describe("CircuitBreaker", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // Helper: advance both timers and system time
  const advanceMs = (ms: number) => {
    const now = Date.now();
    vi.setSystemTime(now + ms);
    vi.advanceTimersByTime(ms);
  };

  it("starts in closed state and allows calls", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutMs: 1000 });
    expect(breaker.currentState).toBe("closed");
    expect(breaker.isClosed).toBe(true);

    const fn = vi.fn().mockResolvedValue("ok");
    await breaker.execute(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("opens after threshold failures", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutMs: 1000 });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    // 前 threshold 次: closed -> call fn -> throw original error
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(fn)).rejects.toThrow("fail");
    }
    // 第 threshold+1 次: open -> fast fail
    await expect(breaker.execute(fn)).rejects.toThrow("Circuit breaker is OPEN");
    expect(breaker.currentState).toBe("open");
    expect(breaker.isClosed).toBe(false);
  });

  it("transitions to half_open after recovery timeout", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 1000 });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    // Open the breaker (threshold failures + 1 fast-fail call)
    await expect(breaker.execute(fn)).rejects.toThrow("fail");
    await expect(breaker.execute(fn)).rejects.toThrow("fail");
    await expect(breaker.execute(fn)).rejects.toThrow("Circuit breaker is OPEN");
    expect(breaker.currentState).toBe("open");

    // Advance past recovery timeout
    advanceMs(1001);
    expect(breaker.currentState).toBe("half_open");
    expect(breaker.isClosed).toBe(true);
  });

  // P1 regression: HalfOpen should trip to Open on single failure
  it("half_open single failure trips back to open (P1 fix)", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutMs: 1000 });
    const failFn = vi.fn().mockRejectedValue(new Error("still failing"));

    // Open the breaker
    await expect(breaker.execute(failFn)).rejects.toThrow("still failing");
    await expect(breaker.execute(failFn)).rejects.toThrow("still failing");
    await expect(breaker.execute(failFn)).rejects.toThrow("still failing");
    await expect(breaker.execute(failFn)).rejects.toThrow("Circuit breaker is OPEN");
    expect(breaker.currentState).toBe("open");

    // Advance to half_open
    advanceMs(1001);
    expect(breaker.currentState).toBe("half_open");

    // Single failure in half_open: fn rejects → recordFailure → back to open
    // First call: fn is invoked, throws original error (not yet OPEN)
    await expect(breaker.execute(failFn)).rejects.toThrow("still failing");
    // recordFailure with threshold=1 in half_open → state → open
    expect(breaker.currentState).toBe("open");
    // Second call: fast fail
    await expect(breaker.execute(failFn)).rejects.toThrow("Circuit breaker is OPEN");
  });

  it("half_open success closes the breaker", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 1000 });
    const failFn = vi.fn().mockRejectedValue(new Error("fail"));
    const okFn = vi.fn().mockResolvedValue("recovered");

    // Open the breaker
    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    await expect(breaker.execute(failFn)).rejects.toThrow("Circuit breaker is OPEN");

    // Recover
    advanceMs(1001);
    await breaker.execute(okFn);
    expect(breaker.currentState).toBe("closed");
    expect(breaker.isClosed).toBe(true);
  });

  it("reset restores initial state", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.currentState).toBe("open");

    breaker.reset();
    expect(breaker.currentState).toBe("closed");
    expect(breaker.isClosed).toBe(true);
  });

  it("fallback returns degraded result when open", async () => {
    // fastFail=false: open 状态不快速失败，而是走 fallback
    const breaker = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 1000, fastFail: false });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    // 两次失败后断路器打开
    await expect(breaker.execute(fn)).rejects.toThrow("fail");
    await expect(breaker.execute(fn)).rejects.toThrow("fail");
    expect(breaker.currentState).toBe("open");

    // Fallback 返回降级值（open 且未到恢复期 → fallback）
    const result = await breaker.execute(
      () => Promise.reject(new Error("fail")),
      () => Promise.resolve("fallback"),
    );
    expect(result).toBe("fallback");
  });

  it("createCircuitBreaker factory function", () => {
    const breaker = createCircuitBreaker({ failureThreshold: 5 });
    expect(breaker.currentState).toBe("closed");
    expect(breaker.getStats().failureCount).toBe(0);
  });
});
