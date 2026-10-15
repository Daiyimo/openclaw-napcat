/**
 * SDK 表面冒烟测试
 *
 * 上游 openclaw 发版会变 plugin-sdk：2026.7.2 曾一次删除 44 个公开子路径且未在
 * CHANGELOG 标注 BREAKING。本插件当时只导入 plugin-sdk/core 一个桶才零命中，
 * 但那是人工核对出来的——本测试把结论固化成门禁：
 *
 *   A. 导入面：插件从 openclaw/plugin-sdk/core import 的全部符号必须存在
 *      （7.2 那类"删子路径/删导出"在 npm test 当场红，而不是 NAS 上 channel
 *      静默不加载后从"QQ 没人回话"开始排查）
 *   B. 运行时面：插件在 channelRuntime 上调用的成员名必须存在于包内类型声明
 *      （channelRuntime 由宿主传入，TS 只按手写 d.ts 的 any 校验，上游改名
 *      编译期发现不了；成员消失时插件可选链静默不执行）
 *   C. 版本地板：测试实际加载的 openclaw 必须满足 package.json 的 peer 下限
 *      （否则本测试在对一个过旧 SDK 放行，失去意义）
 *
 * 入口模块能正常 import（index.ts / setup-entry.ts 的符号链接期校验）由
 * registration-contract.test.ts 覆盖，此处不重复。
 */

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

/** 插件源码实际 import 的 openclaw/plugin-sdk/core 符号（变更需同步此处） */
const SDK_IMPORTS = [
  "buildChannelConfigSchema",
  "emptyPluginConfigSchema",
  "defineSetupPluginEntry",
  "normalizeAccountId",
  "applyAccountNameToChannelSection",
  "migrateBaseNameToDefaultAccount",
  "DEFAULT_ACCOUNT_ID",
] as const;

/** 插件在 channelRuntime 上调用的成员（token 为上游类型声明中的名字） */
const RUNTIME_SURFACE_TOKENS = [
  "recordInboundSession", // channelRuntime.session.recordInboundSession
  "resolveStorePath", // channelRuntime.session.resolveStorePath
  "dispatchReplyWithBufferedBlockDispatcher", // channelRuntime.reply.*
  "resolveAgentRoute", // channelRuntime.routing.*
  "recordChannelActivity", // channelRuntime.activity.record 的底层符号（遥测面，可丢失不致命）
] as const;

/** 定位 openclaw 包根目录：从可解析的 plugin-sdk/core 上溯到含 package.json 的目录 */
function resolveOpenClawRoot(): string {
  const require_ = createRequire(import.meta.url);
  const coreEntry = require_.resolve("openclaw/plugin-sdk/core");
  let dir = path.dirname(coreEntry);
  while (dir !== path.parse(dir).root) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("无法定位 openclaw 包根目录（peer 依赖未安装？）");
}

/** 读取 openclaw 包已安装版本 */
function readInstalledVersion(root: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return pkg.version as string;
}

/** 比较 openclaw 的 YYYY.M.PATCH 版本号（纯 semver，无预发布标签场景） */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

describe("openclaw SDK 表面冒烟", () => {
  const root = resolveOpenClawRoot();

  it("A. plugin-sdk/core 导出插件依赖的全部符号", async () => {
    const sdk = (await import("openclaw/plugin-sdk/core")) as Record<string, unknown>;
    const missing = SDK_IMPORTS.filter((name) => !(name in sdk));
    expect(
      missing,
      `openclaw 已删除插件依赖的导出：${missing.join(", ")}。` +
        "对照上游 release notes 评估影响，并同步 src/openclaw-plugin-sdk.d.ts 与源码导入。",
    ).toEqual([]);
  });

  it("A2. DEFAULT_ACCOUNT_ID 为字符串常量", async () => {
    const sdk = (await import("openclaw/plugin-sdk/core")) as Record<string, unknown>;
    expect(typeof sdk.DEFAULT_ACCOUNT_ID).toBe("string");
    expect((sdk.DEFAULT_ACCOUNT_ID as string).length).toBeGreaterThan(0);
  });

  it("B. channelRuntime 调用的成员存在于包内类型声明", () => {
    const distDir = path.join(root, "dist");
    const dtsFiles = fs
      .readdirSync(distDir)
      .filter((f) => f.endsWith(".d.ts"))
      .map((f) => path.join(distDir, f));
    expect(dtsFiles.length, "dist 下未找到 .d.ts 文件，包结构可能已变").toBeGreaterThan(0);

    const contents = dtsFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    const missing = RUNTIME_SURFACE_TOKENS.filter((token) => !contents.includes(token));
    expect(
      missing,
      `openclaw 类型表面已无这些成员：${missing.join(", ")}。` +
        "插件经 channelRuntime 调用它们，可选链会静默不执行——检查上游 runtime 面改名记录并适配。",
    ).toEqual([]);
  });

  it("C. 已安装 openclaw 版本满足 peer 下限", () => {
    const installed = readInstalledVersion(root);
    const peerRange = "2026.7.1"; // 与 package.json peerDependencies.openclaw 下限一致
    expect(
      compareVersions(installed, peerRange) >= 0,
      `测试加载的 openclaw 是 ${installed}，低于 peer 下限 ${peerRange}。` +
        "先 npm update openclaw 再跑测试，否则本冒烟测试形同虚设。",
    ).toBe(true);
  });
});
