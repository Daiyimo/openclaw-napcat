import { describe, it, expect } from "vitest";
import { createConfigRef, updateConfigRef } from "../config-watcher.js";

describe("createConfigRef", () => {
  it("stores the initial config", () => {
    const initial = { rateLimitMs: 1000, requireMention: true } as any;
    const ref = createConfigRef(initial);
    expect(ref.current).toBe(initial);
  });
});

describe("updateConfigRef", () => {
  it("updates config when valid input is provided", () => {
    const initial = { rateLimitMs: 1000, requireMention: true } as any;
    const ref = createConfigRef(initial);
    const result = updateConfigRef(ref, { rateLimitMs: 2000, requireMention: false });
    expect(result.success).toBe(true);
    expect(ref.current.rateLimitMs).toBe(2000);
    expect(ref.current.requireMention).toBe(false);
  });

  it("keeps old config when Zod validation fails", () => {
    const initial = { rateLimitMs: 1000, requireMention: true } as any;
    const ref = createConfigRef(initial);
    // rateLimitMs max is 60000 per QQConfigSchema
    const result = updateConfigRef(ref, { rateLimitMs: 999999 });
    expect(result.success).toBe(false);
    expect(ref.current.rateLimitMs).toBe(1000);
  });

  it("fills defaults for missing optional fields", () => {
    const initial = { rateLimitMs: 5000, enableReactions: false } as any;
    const ref = createConfigRef(initial);
    // Empty config → Zod fills defaults
    const result = updateConfigRef(ref, {});
    expect(result.success).toBe(true);
    expect(ref.current.enableReactions).toBe(true); // default true
    expect(ref.current.rateLimitMs).toBe(1000); // default 1000
  });

  it("detects connection parameter changes and returns warning", () => {
    const initial = { wsUrl: "ws://old:3001", rateLimitMs: 1000 } as any;
    const ref = createConfigRef(initial);
    const result = updateConfigRef(ref, { wsUrl: "ws://new:3001", rateLimitMs: 2000 });
    expect(result.success).toBe(true);
    expect(result.connectionChanged).toBe(true);
    expect(ref.current.rateLimitMs).toBe(2000);
  });

  it("returns connectionChanged=false when only runtime params change", () => {
    const initial = { rateLimitMs: 1000, requireMention: true } as any;
    const ref = createConfigRef(initial);
    const result = updateConfigRef(ref, { rateLimitMs: 3000, requireMention: false });
    expect(result.success).toBe(true);
    expect(result.connectionChanged).toBe(false);
  });
});
