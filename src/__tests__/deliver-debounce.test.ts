import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DeliverDebouncer,
  createDeliverDebouncer,
  type DeliverPayload,
  type DeliverInfo,
} from "../deliver-debounce.js";

const INFO: DeliverInfo = { kind: "text" };

describe("createDeliverDebouncer", () => {
  it("returns null when enabled is false", () => {
    expect(createDeliverDebouncer({ enabled: false }, vi.fn())).toBeNull();
  });
  it("returns DeliverDebouncer when enabled is true", () => {
    expect(createDeliverDebouncer({ enabled: true }, vi.fn())).toBeInstanceOf(DeliverDebouncer);
  });
  it("returns DeliverDebouncer when config is undefined", () => {
    expect(createDeliverDebouncer(undefined, vi.fn())).toBeInstanceOf(DeliverDebouncer);
  });
});

describe("DeliverDebouncer", () => {
  let executor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    executor = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 基本缓冲行为 ────────────────────────────────────────────────────────

  it("buffers single text and flushes after windowMs", async () => {
    const d = new DeliverDebouncer({ windowMs: 1500, maxWaitMs: 8000 }, executor);

    await d.deliver({ text: "hello" }, INFO);
    expect(executor).not.toHaveBeenCalled();
    expect(d.hasPending).toBe(true);
    expect(d.pendingCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1500);

    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith({ text: "hello" }, INFO);
    expect(d.hasPending).toBe(false);
  });

  it("merges multiple texts within windowMs using separator", async () => {
    const d = new DeliverDebouncer(
      { windowMs: 1500, maxWaitMs: 8000, separator: "\n---\n" },
      executor,
    );

    await d.deliver({ text: "part1" }, INFO);
    await d.deliver({ text: "part2" }, INFO);
    await d.deliver({ text: "part3" }, INFO);

    await vi.advanceTimersByTimeAsync(1500);

    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith({ text: "part1\n---\npart2\n---\npart3" }, INFO);
  });

  it("resets debounce window on each new delivery", async () => {
    const d = new DeliverDebouncer({ windowMs: 1500, maxWaitMs: 8000 }, executor);

    await d.deliver({ text: "a" }, INFO);
    await vi.advanceTimersByTimeAsync(1000); // 1000ms — window not yet done

    await d.deliver({ text: "b" }, INFO); // resets window
    await vi.advanceTimersByTimeAsync(1000); // only 1000ms since last — still not flushed
    expect(executor).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500); // total 1500ms since last — flushes
    expect(executor).toHaveBeenCalledOnce();
  });

  // ── maxWaitMs 强制 flush ───────────────────────────────────────────────

  it("force-flushes when maxWaitMs is reached regardless of debounce", async () => {
    const d = new DeliverDebouncer({ windowMs: 1500, maxWaitMs: 3000 }, executor);

    // t=0
    await d.deliver({ text: "first" }, INFO);
    // t=1000
    await vi.advanceTimersByTimeAsync(1000);
    await d.deliver({ text: "second" }, INFO); // resets debounce (next fire: t=2500)
    // t=2000
    await vi.advanceTimersByTimeAsync(1000);
    await d.deliver({ text: "third" }, INFO); // resets debounce (next fire: t=3500)
    // t=3000 — maxWait timer fires (set at t=0 for 3000ms)
    await vi.advanceTimersByTimeAsync(1000);

    expect(executor).toHaveBeenCalledOnce(); // maxWait triggered before debounce
  });

  // ── 媒体 deliver ────────────────────────────────────────────────────────

  it("immediately flushes buffered text when a media deliver arrives", async () => {
    const d = new DeliverDebouncer({ windowMs: 1500, maxWaitMs: 8000 }, executor);

    await d.deliver({ text: "caption text" }, INFO);
    const mediaPayload: DeliverPayload = {
      text: "media caption",
      mediaUrl: "https://a.com/img.png",
    };
    await d.deliver(mediaPayload, INFO);

    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor).toHaveBeenNthCalledWith(1, { text: "caption text" }, INFO);
    expect(executor).toHaveBeenNthCalledWith(2, mediaPayload, INFO);
  });

  it("immediately flushes when mediaUrls array is non-empty", async () => {
    const d = new DeliverDebouncer({ windowMs: 1500, maxWaitMs: 8000 }, executor);

    await d.deliver({ text: "a" }, INFO);
    await d.deliver({ mediaUrls: ["https://a.com/1.jpg"] }, INFO);

    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("immediately flushes when files array is non-empty", async () => {
    const d = new DeliverDebouncer({ windowMs: 1500, maxWaitMs: 8000 }, executor);

    await d.deliver({ text: "a" }, INFO);
    await d.deliver({ files: [{ url: "https://a.com/file.pdf" }] }, INFO);

    expect(executor).toHaveBeenCalledTimes(2);
  });

  // ── 空文本透传 ─────────────────────────────────────────────────────────

  it("passes through empty text directly without buffering", async () => {
    const d = new DeliverDebouncer({ windowMs: 1500, maxWaitMs: 8000 }, executor);

    await d.deliver({ text: "" }, INFO);

    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith({ text: "" }, INFO);
    expect(d.hasPending).toBe(false);
  });

  it("passes through whitespace-only text directly", async () => {
    const d = new DeliverDebouncer({ windowMs: 1500, maxWaitMs: 8000 }, executor);

    await d.deliver({ text: "   " }, INFO);

    expect(executor).toHaveBeenCalledOnce();
  });

  // ── executor 错误恢复 ───────────────────────────────────────────────────

  it("restores buffer after executor error during timer flush", async () => {
    const failingExecutor = vi.fn().mockRejectedValue(new Error("send failed"));
    const mockLog = { info: vi.fn(), error: vi.fn() };
    const d = new DeliverDebouncer(
      { windowMs: 1500, maxWaitMs: 8000 },
      failingExecutor,
      mockLog,
    );

    await d.deliver({ text: "important" }, INFO);
    // Timer fires, flush fails, error is caught internally by timer callback
    await vi.advanceTimersByTimeAsync(1500);

    // Buffer is restored after failed flush
    expect(d.hasPending).toBe(true);
    expect(d.pendingCount).toBe(1);
  });

  // ── dispose ────────────────────────────────────────────────────────────

  it("dispose flushes remaining buffer and clears timers", async () => {
    const d = new DeliverDebouncer({ windowMs: 1500, maxWaitMs: 8000 }, executor);

    await d.deliver({ text: "pending message" }, INFO);
    expect(d.hasPending).toBe(true);

    await d.dispose();

    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith({ text: "pending message" }, INFO);
    expect(d.hasPending).toBe(false);
  });

  it("dispose on empty buffer does nothing", async () => {
    const d = new DeliverDebouncer({ windowMs: 1500, maxWaitMs: 8000 }, executor);

    await d.dispose();

    expect(executor).not.toHaveBeenCalled();
  });

  // ── hasPending / pendingCount ──────────────────────────────────────────

  it("hasPending and pendingCount reflect buffer state", async () => {
    const d = new DeliverDebouncer({ windowMs: 1500, maxWaitMs: 8000 }, executor);

    expect(d.hasPending).toBe(false);
    expect(d.pendingCount).toBe(0);

    await d.deliver({ text: "a" }, INFO);
    expect(d.hasPending).toBe(true);
    expect(d.pendingCount).toBe(1);

    await d.deliver({ text: "b" }, INFO);
    expect(d.pendingCount).toBe(2);

    await vi.advanceTimersByTimeAsync(1500);
    expect(d.hasPending).toBe(false);
    expect(d.pendingCount).toBe(0);
  });
});
