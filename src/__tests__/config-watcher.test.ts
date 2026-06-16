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

  // ── temperature 热更新映射 ──────────────────────────────────────────────

  it("maps temperature to sub-parameters on reload", () => {
    const initial = { passiveMode: { cooldownMs: 10000 } } as any;
    const ref = createConfigRef(initial);
    const result = updateConfigRef(ref, { passiveMode: { temperature: 0 } });
    expect(result.success).toBe(true);
    // temperature=0 → cooldown=60s, minInterval=120s, botSuppression=300s
    expect(ref.current.passiveMode.cooldownMs).toBe(60_000);
    expect(ref.current.passiveMode.minIntervalMs).toBe(120_000);
    expect(ref.current.passiveMode.botSuppressionMs).toBe(300_000);
  });

  it("preserves temperature=50 defaults on reload", () => {
    const initial = { passiveMode: { cooldownMs: 5000 } } as any;
    const ref = createConfigRef(initial);
    const result = updateConfigRef(ref, { passiveMode: { temperature: 50 } });
    expect(result.success).toBe(true);
    // temperature=50 → matches original defaults
    expect(ref.current.passiveMode.cooldownMs).toBe(10_000);
    expect(ref.current.passiveMode.minIntervalMs).toBe(30_000);
    expect(ref.current.passiveMode.botSuppressionMs).toBe(120_000);
  });

  it("maps temperature=100 to most active settings on reload", () => {
    const ref = createConfigRef({ passiveMode: { cooldownMs: 10000 } } as any);
    const result = updateConfigRef(ref, { passiveMode: { temperature: 100 } });
    expect(result.success).toBe(true);
    expect(ref.current.passiveMode.cooldownMs).toBe(2_000);
    expect(ref.current.passiveMode.minIntervalMs).toBe(5_000);
    expect(ref.current.passiveMode.botSuppressionMs).toBe(30_000);
  });

  it("preserves systemPrompt when temperature is set on reload", () => {
    const ref = createConfigRef({} as any);
    const result = updateConfigRef(ref, {
      passiveMode: { temperature: 75, systemPrompt: "自定义人设" },
    });
    expect(result.success).toBe(true);
    expect(ref.current.passiveMode.systemPrompt).toBe("自定义人设");
  });

  it("preserves passiveMode when not specified in reload", () => {
    // Zod v4 .optional() removes the key from output when not provided,
    // so Object.assign preserves existing values (correct hot-reload behavior)
    const initial = {
      passiveMode: { cooldownMs: 15000, minIntervalMs: 45000, botSuppressionMs: 180000 },
    } as any;
    const ref = createConfigRef(initial);
    const result = updateConfigRef(ref, { rateLimitMs: 2000 });
    expect(result.success).toBe(true);
    // passiveMode not in reload config → existing values preserved
    expect(ref.current.passiveMode.cooldownMs).toBe(15000);
    expect(ref.current.passiveMode.minIntervalMs).toBe(45000);
    expect(ref.current.passiveMode.botSuppressionMs).toBe(180000);
  });

  it("preserves explicit sub-params when included in reload config", () => {
    const ref = createConfigRef({ passiveMode: { cooldownMs: 15000 } } as any);
    const result = updateConfigRef(ref, {
      passiveMode: { cooldownMs: 15000, minIntervalMs: 45000, botSuppressionMs: 180000 },
    });
    expect(result.success).toBe(true);
    expect(ref.current.passiveMode.cooldownMs).toBe(15000);
    expect(ref.current.passiveMode.minIntervalMs).toBe(45000);
    expect(ref.current.passiveMode.botSuppressionMs).toBe(180000);
  });

  // ── sleepMode 运行时保留 ──────────────────────────────────────────────────

  it("preserves runtime sleepMode when not in reload config", () => {
    // 模拟 /sleep 命令修改了 sleepMode 后执行 /reload
    const initial = {
      sleepMode: { enabled: true, startHour: 23, endHour: 7 },
    } as any;
    const ref = createConfigRef(initial);
    // /reload 传入的配置中不包含 sleepMode（用户通过 /sleep 设置，不会写回文件）
    const result = updateConfigRef(ref, { rateLimitMs: 2000 });
    expect(result.success).toBe(true);
    expect(ref.current.sleepMode.enabled).toBe(true);
    expect(ref.current.sleepMode.startHour).toBe(23);
    expect(ref.current.sleepMode.endHour).toBe(7);
  });

  it("updates sleepMode when explicitly set in reload config", () => {
    const initial = {
      sleepMode: { enabled: true, startHour: 23, endHour: 7 },
    } as any;
    const ref = createConfigRef(initial);
    const result = updateConfigRef(ref, {
      sleepMode: { enabled: true, startHour: 0, endHour: 6 },
    });
    expect(result.success).toBe(true);
    expect(ref.current.sleepMode.startHour).toBe(0);
    expect(ref.current.sleepMode.endHour).toBe(6);
  });

  it("does not reset sleepMode to defaults when absent from reload", () => {
    const initial = {
      sleepMode: { enabled: true, startHour: 1, endHour: 5 },
    } as any;
    const ref = createConfigRef(initial);
    // Empty reload → schema defaults would set sleepMode to { enabled: false, startHour: 23, endHour: 7 }
    // but our fix preserves the runtime value
    const result = updateConfigRef(ref, {});
    expect(result.success).toBe(true);
    expect(ref.current.sleepMode.enabled).toBe(true);
    expect(ref.current.sleepMode.startHour).toBe(1);
    expect(ref.current.sleepMode.endHour).toBe(5);
  });
});
