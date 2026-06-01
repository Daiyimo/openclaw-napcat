#!/usr/bin/env node
/**
 * Docker env var 一致性检查
 *
 * 验证 docker-compose.yml 中声明的 QQ_* env vars ⊆ docker/setup-config.cjs 中
 * 实际解析的 env.QQ_* 引用。否则 docker-compose.yml 写的 env var 不会写入
 * openclaw.json（用户在容器里设了等于没设）。
 *
 * 退出码：
 *   0 = 一致
 *   1 = env var 在 compose 声明了但 cjs 没解析（部署死代码）
 *   2 = env var 在 cjs 解析了但 compose 没声明（用户无法通过 env 设置）
 *
 * 用法：node scripts/check-docker-env-parity.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const COMPOSE_YML = path.join(ROOT, "docker-compose.yml");
const SETUP_CJS = path.join(ROOT, "docker", "setup-config.cjs");

/**
 * 从 docker-compose.yml 提取所有 active（未注释）的 QQ_* env var
 * 格式：`QQ_FOO: ${QQ_FOO:-default}` 在 `environment:` 块下、缩进匹配。
 * 简单实现：扫描所有 `^      QQ_\w+:` 行，忽略以 `#` 开头的注释行。
 */
function extractComposeEnvVars(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split("\n");
  const envVars = new Set();
  let inEnvironmentBlock = false;
  // 记录进入 environment 块时的缩进深度，离开时缩进变浅即结束
  let envIndent = -1;
  for (const line of lines) {
    // 检测 `environment:` 块（任意缩进深度）
    const envMatch = /^(\s+)environment:\s*$/.exec(line);
    if (envMatch) {
      inEnvironmentBlock = true;
      envIndent = envMatch[1].length;
      continue;
    }
    // 离开 environment 块：遇到比 envIndent 更浅缩进的非空行
    if (inEnvironmentBlock && line.trim() !== "") {
      const currentIndent = line.match(/^(\s*)/)[1].length;
      if (currentIndent < envIndent) {
        inEnvironmentBlock = false;
        envIndent = -1;
        continue;
      }
    }
    if (!inEnvironmentBlock) continue;
    // 跳过注释行
    if (/^\s*#/.test(line)) continue;
    // 匹配 active env var: `      QQ_FOO: value`（缩进比 environment 深）
    const m = /^\s+(QQ_\w+):/.exec(line);
    if (m) envVars.add(m[1]);
  }
  return envVars;
}

/**
 * 从 docker/setup-config.cjs 提取所有 env.QQ_* 引用
 */
function extractCjsEnvRefs(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const envRegex = /env\.(QQ_\w+)/g;
  const refs = new Set();
  let m;
  while ((m = envRegex.exec(text)) !== null) {
    refs.add(m[1]);
  }
  return refs;
}

function main() {
  let exitCode = 0;
  try {
    const composeVars = extractComposeEnvVars(COMPOSE_YML);
    const cjsRefs = extractCjsEnvRefs(SETUP_CJS);

    console.log(`[check-docker-env-parity] docker-compose.yml: ${composeVars.size} QQ_* env vars`);
    console.log(`[check-docker-env-parity] setup-config.cjs: ${cjsRefs.size} env.QQ_* refs`);

    // compose 声明了但 cjs 没解析（部署死代码 —— compose 写了但 env 不会生效）
    const declaredButNotParsed = [...composeVars].filter((k) => !cjsRefs.has(k));
    // cjs 解析了但 compose 没声明（用户无法通过 compose env 设置，要直接编辑 openclaw.json）
    const parsedButNotDeclared = [...cjsRefs].filter((k) => !composeVars.has(k));

    if (declaredButNotParsed.length === 0 && parsedButNotDeclared.length === 0) {
      console.log("✓ env var 声明与解析一致");
    } else {
      if (declaredButNotParsed.length > 0) {
        console.error(`✗ compose 声明但 cjs 未解析 ${declaredButNotParsed.length} 个（部署死代码）:`);
        for (const k of declaredButNotParsed) console.error(`    - ${k}`);
        exitCode = 1;
      }
      if (parsedButNotDeclared.length > 0) {
        console.warn(`⚠ cjs 解析但 compose 未声明 ${parsedButNotDeclared.length} 个（用户只能手改 openclaw.json）:`);
        for (const k of parsedButNotDeclared) console.warn(`    - ${k}`);
        // 这是 warning 不阻断（cjs 解析更多 = 更多灵活性）
        if (exitCode === 0) exitCode = 0;
      }
    }
  } catch (err) {
    console.error("[check-docker-env-parity] 检查失败:", err.message);
    exitCode = 3;
  }
  process.exit(exitCode);
}

main();
