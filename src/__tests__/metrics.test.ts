/**
 * MetricsCollector + AlertCooldown 独立测试
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MetricsCollector, AlertCooldown, createMetricsCollector } from "../metrics.js";

// ── MetricsCollector ──────────────────────────────────────

describe("MetricsCollector", () => {
  let mc: MetricsCollector;

  beforeEach(() => {
    mc = createMetricsCollector();
  });

  it("test_metrics_increment_counter", () => {
    mc.increment("inbound", "total");
    mc.increment("inbound", "total");
    mc.increment("dispatch", "attempts");
    expect((mc.counters as any).inbound.total).toBe(2);
    expect((mc.counters as any).dispatch.attempts).toBe(1);
  });

  it("test_metrics_increment_default_amount", () => {
    mc.increment("inbound", "total");
    expect((mc.counters as any).inbound.total).toBe(1);
  });

  it("test_metrics_increment_custom_amount", () => {
    mc.increment("inbound", "total", 5);
    expect((mc.counters as any).inbound.total).toBe(5);
  });

  it("test_metrics_gauge_default_zero", () => {
    expect(mc.getGauge("pendingRequests")).toBe(0);
  });

  it("test_metrics_set_gauge", () => {
    mc.setGauge("pendingRequests", 42);
    expect(mc.getGauge("pendingRequests")).toBe(42);
  });

  it("test_metrics_register_gauge_provider", () => {
    mc.registerGauge("pendingRequests", () => 99);
    expect(mc.getGauge("pendingRequests")).toBe(99);
  });

  it("test_metrics_gauge_provider_overrides_set_gauge", () => {
    mc.setGauge("pendingRequests", 5);
    mc.registerGauge("pendingRequests", () => 99);
    expect(mc.getGauge("pendingRequests")).toBe(99);
  });

  it("test_metrics_snapshot_gauges", () => {
    mc.setGauge("pendingRequests", 3);
    mc.setGauge("knownBots", 10);
    const snap = mc.snapshotGauges();
    expect(snap.pendingRequests).toBe(3);
    expect(snap.knownBots).toBe(10);
  });

  it("test_metrics_reset_counters", () => {
    mc.increment("inbound", "total", 10);
    mc.increment("dispatch", "succeeded", 5);
    mc.resetCounters();
    expect((mc.counters as any).inbound.total).toBe(0);
    expect((mc.counters as any).dispatch.succeeded).toBe(0);
  });

  it("test_metrics_format_report", () => {
    mc.increment("inbound", "total", 100);
    mc.increment("inbound", "filtered", 30);
    mc.increment("dispatch", "attempts", 50);
    mc.increment("dispatch", "succeeded", 45);
    mc.setGauge("pendingRequests", 2);
    const report = mc.formatReport("acc-1", "1.0.0");
    expect(report).toContain("入站: 100");
    expect(report).toContain("过滤=30");
    expect(report).toContain("派发: 50 次");
    expect(report).toContain("成功=45");
    expect(report).toContain("v1.0.0");
    expect(report).toContain("acc-1");
  });

  it("test_metrics_counters_initial_values", () => {
    // readonly 是编译期约束，运行时验证初始值全为零
    expect((mc.counters as any).inbound.total).toBe(0);
    expect((mc.counters as any).dispatch.attempts).toBe(0);
    expect((mc.counters as any).outbound.sent).toBe(0);
  });
});

// ── AlertCooldown ─────────────────────────────────────────

describe("AlertCooldown", () => {
  let ac: AlertCooldown;

  beforeEach(() => {
    ac = new AlertCooldown({ cooldownMs: 1000, maxHistory: 10 });
  });

  it("test_alertcooldown_first_fire_allowed", () => {
    expect(ac.shouldFire("rule-1")).toBe(true);
  });

  it("test_alertcooldown_second_fire_blocked", () => {
    ac.shouldFire("rule-1");
    expect(ac.shouldFire("rule-1")).toBe(false);
  });

  it("test_alertcooldown_different_rules_independent", () => {
    expect(ac.shouldFire("rule-1")).toBe(true);
    expect(ac.shouldFire("rule-2")).toBe(true);
    expect(ac.shouldFire("rule-1")).toBe(false);
    expect(ac.shouldFire("rule-2")).toBe(false);
  });

  it("test_alertcooldown_after_cooldown_allows_fire", async () => {
    ac.shouldFire("rule-1");
    expect(ac.shouldFire("rule-1")).toBe(false);
    await new Promise((r) => setTimeout(r, 1100));
    expect(ac.shouldFire("rule-1")).toBe(true);
  });

  it("test_alertcooldown_record_tracks_history", () => {
    ac.shouldFire("rule-1");
    ac.record("rule-1", "test message");
    const history = ac.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].key).toBe("rule-1");
    expect(history[0].msg).toBe("test message");
  });

  it("test_alertcooldown_reset_clears_cooldown", () => {
    ac.shouldFire("rule-1");
    expect(ac.shouldFire("rule-1")).toBe(false);
    ac.reset();
    expect(ac.shouldFire("rule-1")).toBe(true);
  });

  it("test_alertcooldown_max_history_trim", () => {
    const ac2 = new AlertCooldown({ cooldownMs: 0, maxHistory: 3 });
    ac2.record("r1", "m1");
    ac2.record("r2", "m2");
    ac2.record("r3", "m3");
    ac2.record("r4", "m4");
    const history = ac2.getHistory();
    expect(history).toHaveLength(3);
    expect(history[0].msg).toBe("m2");
  });

  it("test_alertcooldown_default_options", () => {
    const ac2 = new AlertCooldown();
    expect(ac2.shouldFire("x")).toBe(true);
    // default cooldown is 10 minutes, should be blocked immediately
    expect(ac2.shouldFire("x")).toBe(false);
  });
});
