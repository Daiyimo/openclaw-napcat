#!/usr/bin/env node
/**
 * 配置 schema 同步检查
 *
 * 验证 openclaw.plugin.json 的 configSchema.properties ⊆ src/config.ts 的 QQConfigSchema
 * 字段。两边必须保持一致，否则 OpenClaw 控制台看不到 schema 中声明的字段。
 *
 * 退出码：
 *   0 = 一致
 *   1 = 缺字段（plugin.json 没声明但 config.ts 有）
 *   2 = 多字段（plugin.json 声明了但 config.ts 没有 —— 可能是 typo 或已删除）
 *
 * 用法：node scripts/check-config-sync.cjs
 *       npm run check:config
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PLUGIN_JSON = path.join(ROOT, "openclaw.plugin.json");
const CONFIG_TS = path.join(ROOT, "src", "config.ts");

/**
 * 从 openclaw.plugin.json 提取顶层 properties 的 key
 */
function extractPluginProperties(filePath) {
  const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const props = json?.configSchema?.properties;
  if (!props || typeof props !== "object") {
    throw new Error(`${filePath}: configSchema.properties 不存在或格式错误`);
  }
  return new Set(Object.keys(props));
}

/**
 * 从 src/config.ts 提取顶层 Zod 字段名。
 * 匹配模式：`字段名: z.xxx(` 出现在 QQConfigSchema = z.object({ ... }) 块内。
 * 实现：扫描 `z.object({` 起始大括号层级平衡，记录所有 `key: z.` 形式的 key。
 */
function extractZodTopLevelFields(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  // 找 QQConfigSchema 的 z.object({ ... }) 块
  const start = text.indexOf("export const QQConfigSchema = z.object({");
  if (start < 0) {
    throw new Error(`${filePath}: 未找到 "export const QQConfigSchema = z.object({"`);
  }
  // 从 start 开始扫描大括号，平衡计数找到匹配的 `});`
  let depth = 0;
  let i = start;
  let blockStart = -1;
  for (; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) blockStart = i + 1;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) {
    throw new Error(`${filePath}: 大括号不平衡，无法定位 QQConfigSchema 块`);
  }
  const block = text.slice(blockStart, i);

  // 在 block 内找所有 `key: z.xxx(` 模式（顶层字段）
  // 顶层字段的特征：缩进 2 空格（与子字段 4 空格区分）
  // 跳过以 `_` 开头的 internal 字段（如 _selfId、_selfName，由运行时注入，不暴露给用户）
  const fieldRegex = /^\s{2}(\w+):\s+z\./gm;
  const fields = new Set();
  let m;
  while ((m = fieldRegex.exec(block)) !== null) {
    if (m[1].startsWith("_")) continue; // internal 字段不参与 user-facing schema 同步
    fields.add(m[1]);
  }
  return fields;
}

function main() {
  let exitCode = 0;
  try {
    const pluginProps = extractPluginProperties(PLUGIN_JSON);
    const zodFields = extractZodTopLevelFields(CONFIG_TS);

    // plugin.json 缺什么（Zod 有但 plugin.json 没声明）
    const missing = [...zodFields].filter((k) => !pluginProps.has(k));
    // plugin.json 多什么（plugin.json 声明了但 Zod 没有 —— 可能是 typo 或已删除）
    const extra = [...pluginProps].filter((k) => !zodFields.has(k));

    console.log(`[check-config-sync] plugin.json: ${pluginProps.size} 字段`);
    console.log(`[check-config-sync] config.ts QQConfigSchema: ${zodFields.size} 字段`);

    if (missing.length === 0 && extra.length === 0) {
      console.log("✓ 配置 schema 一致");
    } else {
      if (missing.length > 0) {
        console.error(`✗ plugin.json 缺 ${missing.length} 字段（Zod 有但 plugin.json 没声明）:`);
        for (const k of missing) console.error(`    - ${k}`);
        exitCode = 1;
      }
      if (extra.length > 0) {
        console.error(`✗ plugin.json 多 ${extra.length} 字段（plugin.json 声明了但 Zod 没有 —— 可能是 typo）:`);
        for (const k of extra) console.error(`    - ${k}`);
        exitCode = 2;
      }
    }
  } catch (err) {
    console.error("[check-config-sync] 检查失败:", err.message);
    exitCode = 3;
  }
  process.exit(exitCode);
}

main();
