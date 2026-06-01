#!/usr/bin/env node
/**
 * openclaw-napcat Docker 启动脚本
 *
 * 职责：
 *  1. 读取 QQ_* 环境变量
 *  2. 写入 ~/.openclaw/openclaw.json（channels.napcat 节 + plugins.entries.napcat）
 *  3. 不覆盖已有配置（除非 QQ_FORCE_RECONFIGURE=true）
 *
 * 用法：由 entrypoint.sh 调用，不建议直接执行。
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const CONFIG_DIR  = path.join(process.env.HOME || "/home/node", ".openclaw");
const CONFIG_PATH = path.join(CONFIG_DIR, "openclaw.json");

// ── 从环境变量构建 channels.napcat 配置 ─────────────────────────────────────────

function parseIntList(raw) {
  if (!raw) return undefined;
  const nums = raw.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  return nums.length > 0 ? nums : undefined;
}

function parseStringList(raw) {
  if (!raw) return undefined;
  const items = raw.split(",").map(s => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseBool(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true" || raw === "1";
}

function parseIntOpt(raw) {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return isNaN(n) ? undefined : n;
}

const env = process.env;
const qqEnv = {};

// 必填连接
if (env.QQ_WS_URL)           qqEnv.wsUrl           = env.QQ_WS_URL;
if (env.QQ_HTTP_URL)         qqEnv.httpUrl         = env.QQ_HTTP_URL;
if (env.QQ_ACCESS_TOKEN)     qqEnv.accessToken     = env.QQ_ACCESS_TOKEN;
if (env.QQ_REVERSE_WS_PORT)  qqEnv.reverseWsPort   = parseIntOpt(env.QQ_REVERSE_WS_PORT);

// 权限
const admins = parseIntList(env.QQ_ADMINS);
if (admins)                  qqEnv.admins          = admins;

const allowedGroups = parseIntList(env.QQ_ALLOWED_GROUPS);
if (allowedGroups)           qqEnv.allowedGroups   = allowedGroups;

const blockedUsers = parseIntList(env.QQ_BLOCKED_USERS);
if (blockedUsers)            qqEnv.blockedUsers    = blockedUsers;

if (env.QQ_REQUIRE_MENTION !== undefined)
                             qqEnv.requireMention   = parseBool(env.QQ_REQUIRE_MENTION, true);

// AI 行为
if (env.QQ_SYSTEM_PROMPT)    qqEnv.systemPrompt    = env.QQ_SYSTEM_PROMPT;
if (env.QQ_RESPONSE_GUIDELINES !== undefined) qqEnv.responseGuidelines = env.QQ_RESPONSE_GUIDELINES;

const historyLimit = parseIntOpt(env.QQ_HISTORY_LIMIT);
if (historyLimit !== undefined) qqEnv.historyLimit  = historyLimit;

const kwTriggers = parseStringList(env.QQ_KEYWORD_TRIGGERS);
if (kwTriggers)              qqEnv.keywordTriggers  = kwTriggers;

if (env.QQ_MARKDOWN_MODE)    qqEnv.markdownMode     = env.QQ_MARKDOWN_MODE;

// 风控
const rateLimitMs = parseIntOpt(env.QQ_RATE_LIMIT_MS);
if (rateLimitMs !== undefined) qqEnv.rateLimitMs    = rateLimitMs;

const inboundRateMs = parseIntOpt(env.QQ_INBOUND_RATE_LIMIT_MS);
if (inboundRateMs !== undefined) qqEnv.inboundRateLimitMs = inboundRateMs;

const silentKws = parseStringList(env.QQ_SILENT_KEYWORDS);
if (silentKws)               qqEnv.silentKeywords   = silentKws;

if (env.QQ_ANTI_RISK_MODE !== undefined)
                             qqEnv.antiRiskMode      = parseBool(env.QQ_ANTI_RISK_MODE, false);

// ── 旁观模式 ─────────────────────────────────────────────────────────────────
if (env.QQ_PASSIVE_MODE_ENABLED !== undefined) {
  const passiveMode = {};
  passiveMode.enabled = parseBool(env.QQ_PASSIVE_MODE_ENABLED, false);
  const cooldownMs = parseIntOpt(env.QQ_PASSIVE_MODE_COOLDOWN_MS);
  if (cooldownMs !== undefined) passiveMode.cooldownMs = cooldownMs;
  if (env.QQ_PASSIVE_MODE_SYSTEM_PROMPT) passiveMode.systemPrompt = env.QQ_PASSIVE_MODE_SYSTEM_PROMPT;
  qqEnv.passiveMode = passiveMode;
}

// ── 无可配置的 env vars → 退出，让 openclaw 自主加载现有配置 ───────────────────

if (Object.keys(qqEnv).length === 0) {
  process.exit(0);
}

// ── 读取 / 创建配置文件 ──────────────────────────────────────────────────────

fs.mkdirSync(CONFIG_DIR, { recursive: true });

let config = {};
if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.warn("[openclaw-napcat] 解析现有配置失败，将重新生成：", e.message);
  }
}

// ── 补全 stepfun-plan/step-3.7-flash 模型定义（多模态支持） ──────────────────
// 该模型在 onboard 后可能缺失 provider models 定义，导致框架无法识别其 vision 能力
let modelConfigPatched = false;
(function ensureStepfunModelConfig() {
  const providers = config.models?.providers;
  if (!providers?.["stepfun-plan"]) return;

  const models = providers["stepfun-plan"].models;
  if (!Array.isArray(models)) {
    providers["stepfun-plan"].models = [];
  }
  const modelList = providers["stepfun-plan"].models;

  const has37 = modelList.some(function(m) { return m.id === "step-3.7-flash"; });
  if (!has37) {
    modelList.push({
      id: "step-3.7-flash",
      name: "Step 3.7 Flash",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 65536
    });
    modelConfigPatched = true;
    console.log("[openclaw-napcat] 已补全 stepfun-plan/step-3.7-flash 模型定义（含 image 支持）");
  }
})();

// 模型配置有变更，立即写入文件（不依赖后续的 channel 配置写入流程）
if (modelConfigPatched && fs.existsSync(CONFIG_PATH)) {
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, CONFIG_PATH);
}

const forceReconfigure = parseBool(env.QQ_FORCE_RECONFIGURE, false);
const qqExists = !!(
  config.channels?.napcat?.wsUrl ||
  config.channels?.napcat?.reverseWsPort ||
  config.channels?.napcat?.httpUrl
);

if (qqExists && !forceReconfigure) {
  console.log("[openclaw-napcat] channels.napcat 已存在，跳过环境变量写入（设 QQ_FORCE_RECONFIGURE=true 强制覆盖）");
  process.exit(0);
}

// ── 合并写入 ──────────────────────────────────────────────────────────────────

config.channels            = config.channels ?? {};
config.channels.napcat = { ...(config.channels.napcat ?? {}), ...qqEnv };

config.plugins             = config.plugins ?? {};
config.plugins.entries     = config.plugins.entries ?? {};
config.plugins.entries.napcat = { enabled: true };

config.gateway             = config.gateway ?? {};
if (!config.gateway.mode)  config.gateway.mode = "local";
config.gateway.controlUi = { ...(config.gateway.controlUi ?? {}), allowInsecureAuth: true };

const tmpPath = CONFIG_PATH + ".tmp";
fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n", "utf8");
fs.renameSync(tmpPath, CONFIG_PATH); // 同目录 rename 在 Linux 下是原子操作
console.log("[openclaw-napcat] channels.napcat + plugins.entries.napcat + gateway.mode 已写入 →", CONFIG_PATH);
