import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry, isRetryableError, HttpApiError } from "../utils/retry.js";

describe("isRetryableError", () => {
  it("returns true for HttpApiError with 5xx", () => {
    const err = new HttpApiError(502, "Bad Gateway", "send_msg");
    expect(isRetryableError(err)).toBe(true);
  });

  it("returns false for HttpApiError with 4xx", () => {
    const err = new HttpApiError(400, "Bad Request", "send_msg");
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
      .mockRejectedValueOnce(new HttpApiError(500, "Internal", "test"))
      .mockRejectedValueOnce(new HttpApiError(503, "Unavailable", "test"))
      .mockResolvedValue("recovered");

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws last error when all retries exhausted", async () => {
    const err = new HttpApiError(500, "Internal", "test");
    const fn = vi.fn().mockRejectedValue(err);

    const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).rejects.toThrow("HTTP 500");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable errors", async () => {
    const err = new HttpApiError(404, "Not Found", "test");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn)).rejects.toThrow("HTTP 404");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects maxRetries=0", async () => {
    const err = new HttpApiError(500, "Internal", "test");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses exponential backoff delays", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new HttpApiError(500, "err", "t"))
      .mockRejectedValueOnce(new HttpApiError(500, "err", "t"))
      .mockRejectedValueOnce(new HttpApiError(500, "err", "t"))
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
