/**
 * 注册契约测试
 *
 * 覆盖此前无直接测试的三处：
 *   1. index.ts 入口形态与 registrationMode 行为矩阵
 *   2. channel.ts 的 qqChannel plugin 对象必备面与 config adapter 行为
 *   3. setup-entry.ts 轻量 setup 入口形态与 import 面
 *
 * runtime 单例是模块级状态，每个用例前 vi.resetModules() 拿全新注册表，
 * 避免用例间状态泄漏（对齐 lifecycle-concurrency.test.ts 的动态导入做法）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** 构造满足 isPluginRuntime 校验的假 runtime（需含 channel 属性） */
function makeFakeRuntime() {
  return { channel: {} } as never;
}

/** 构造假 OpenClawPluginApi */
function makeFakeApi(mode: string) {
  return {
    id: "napcat",
    registrationMode: mode,
    runtime: makeFakeRuntime(),
    registerChannel: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

describe("插件注册契约", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("入口形态", () => {
    it("default export 含 id/name/description/configSchema/register", async () => {
      const mod = await import("../index.js");
      expect(mod.default.id).toBe("napcat");
      expect(typeof mod.default.name).toBe("string");
      expect(mod.default.name.length).toBeGreaterThan(0);
      expect(typeof mod.default.description).toBe("string");
      expect(mod.default.configSchema).toBeDefined();
      expect(typeof mod.default.register).toBe("function");
    });

    it("re-export 主动消息与已知用户 API（cron/外部脚本入口）", async () => {
      const mod = await import("../index.js");
      expect(typeof mod.sendProactive).toBe("function");
      expect(typeof mod.sendBulkProactive).toBe("function");
      expect(typeof mod.broadcastToKnownUsers).toBe("function");
      expect(typeof mod.listKnownUsers).toBe("function");
      expect(typeof mod.getKnownUsersStats).toBe("function");
      expect(typeof mod.recordKnownUser).toBe("function");
      expect(typeof mod.flushKnownUsers).toBe("function");
    });
  });

  describe("registrationMode 行为矩阵", () => {
    it("cli-metadata：不注册 channel、不注入 runtime", async () => {
      const { default: plugin } = await import("../index.js");
      const { getQQRuntime } = await import("../runtime.js");
      const api = makeFakeApi("cli-metadata");
      plugin.register(api);
      expect(api.registerChannel).not.toHaveBeenCalled();
      expect(() => getQQRuntime()).toThrow("QQ runtime not initialized");
    });

    it("tool-discovery：不注册 channel、不注入 runtime", async () => {
      const { default: plugin } = await import("../index.js");
      const { getQQRuntime } = await import("../runtime.js");
      const api = makeFakeApi("tool-discovery");
      plugin.register(api);
      expect(api.registerChannel).not.toHaveBeenCalled();
      expect(() => getQQRuntime()).toThrow("QQ runtime not initialized");
    });

    it("setup-only：注册 channel 但不注入 runtime", async () => {
      const { default: plugin } = await import("../index.js");
      const { getQQRuntime } = await import("../runtime.js");
      const api = makeFakeApi("setup-only");
      plugin.register(api);
      expect(api.registerChannel).toHaveBeenCalledTimes(1);
      expect(() => getQQRuntime()).toThrow("QQ runtime not initialized");
    });

    it("full：注册 channel 并注入 runtime", async () => {
      const { default: plugin } = await import("../index.js");
      const { getQQRuntime } = await import("../runtime.js");
      const api = makeFakeApi("full");
      plugin.register(api);
      expect(api.registerChannel).toHaveBeenCalledTimes(1);
      expect(getQQRuntime()).toBe(api.runtime);
    });

    it("full：registerChannel 收到 qqChannel 对象本体", async () => {
      const { default: plugin } = await import("../index.js");
      const { qqChannel } = await import("../channel.js");
      const api = makeFakeApi("full");
      plugin.register(api);
      expect(api.registerChannel).toHaveBeenCalledWith({ plugin: qqChannel });
    });

    it("discovery：注册 channel 并注入 runtime（非激活发现）", async () => {
      const { default: plugin } = await import("../index.js");
      const { getQQRuntime } = await import("../runtime.js");
      const api = makeFakeApi("discovery");
      plugin.register(api);
      expect(api.registerChannel).toHaveBeenCalledTimes(1);
      expect(getQQRuntime()).toBe(api.runtime);
    });
  });

  describe("channel plugin 必备面", () => {
    it("qqChannel 含全部运行时 adapter", async () => {
      const { qqChannel } = await import("../channel.js");
      const requiredAdapters = [
        "id",
        "meta",
        "capabilities",
        "configSchema",
        "config",
        "status",
        "gateway",
        "outbound",
        "messaging",
        "actions",
        "agentPrompt",
      ];
      for (const key of requiredAdapters) {
        expect(qqChannel, `missing adapter: ${key}`).toHaveProperty(key);
      }
      expect(qqChannel.id).toBe("napcat");
      expect(qqChannel.meta.id).toBe("napcat");
    });

    it("config adapter：listAccountIds 无配置返回空、有配置返回 default", async () => {
      const { qqChannel } = await import("../channel.js");
      expect(qqChannel.config.listAccountIds({} as never)).toEqual([]);
      expect(
        qqChannel.config.listAccountIds({ channels: { napcat: { wsUrl: "ws://x" } } } as never),
      ).toEqual(["default"]);
    });

    it("config adapter：resolveAccount 返回 configured 账户并透传配置", async () => {
      const { qqChannel } = await import("../channel.js");
      const cfg = {
        channels: { napcat: { wsUrl: "ws://127.0.0.1:3002", admins: [1] } },
      } as never;
      const acc = qqChannel.config.resolveAccount(cfg, "default");
      expect(acc.accountId).toBe("default");
      expect(acc.configured).toBe(true);
      expect(acc.config.wsUrl).toBe("ws://127.0.0.1:3002");
      expect(acc.config.admins).toEqual([1]);
    });

    it("config adapter：resolveAccount 剥离运行时字段 _selfId/_selfName", async () => {
      const { qqChannel } = await import("../channel.js");
      const cfg = {
        channels: { napcat: { wsUrl: "ws://x", _selfId: 123, _selfName: "bot" } },
      } as never;
      const acc = qqChannel.config.resolveAccount(cfg, "default");
      expect((acc.config as Record<string, unknown>)._selfId).toBeUndefined();
      expect((acc.config as Record<string, unknown>)._selfName).toBeUndefined();
    });

    it("config adapter：未配置连接时 configured 为 false", async () => {
      const { qqChannel } = await import("../channel.js");
      const cfg = { channels: { napcat: { requireMention: true } } } as never;
      const acc = qqChannel.config.resolveAccount(cfg, "default");
      expect(acc.configured).toBe(false);
    });
  });
});

describe("setup-entry 契约", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("default export 为 { plugin } 且含最小 setup 面", async () => {
    const mod = await import("../setup-entry.js");
    expect(Object.keys(mod.default)).toEqual(["plugin"]);
    const p = mod.default.plugin;
    expect(p.id).toBe("napcat");
    expect(p.meta.id).toBe("napcat");
    expect(p.capabilities.chatTypes).toEqual(["direct", "group"]);
    expect(p.configSchema).toBeDefined();
    expect(typeof p.config.resolveAccount).toBe("function");
  });

  it("setup plugin 的 config adapter 与完整插件行为一致", async () => {
    const setup = await import("../setup-entry.js");
    const { qqChannel } = await import("../channel.js");
    const cfg = { channels: { napcat: { wsUrl: "ws://x", admins: [7] } } } as never;
    const a = setup.default.plugin.config.resolveAccount(cfg, "default");
    const b = qqChannel.config.resolveAccount(cfg, "default");
    expect(a).toEqual(b);
  });

  it("setup-entry 源码不引入重运行时模块（client/gateway/outbound/admin-commands）", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.join(process.cwd(), "src/setup-entry.ts"), "utf8");
    const importLines = src
      .split("\n")
      .filter((line) => /^\s*import/.test(line))
      .join("\n");
    expect(importLines).not.toMatch(/client\.js|gateway|outbound|admin-commands|proactive|message-parser/);
    expect(importLines).toMatch(/config-adapter\.js/);
  });
});
