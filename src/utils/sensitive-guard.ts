/**
 * 系统文件预拦截守卫
 *
 * 在 inbound pipeline 中检测非管理员用户是否试图诱导 bot 修改
 * 人设/记忆/身份等系统文件（SOUL.md、AGENTS.md、IDENTITY.md、
 * USER.md、MEMORY.md 等）。
 *
 * 治标原因：OpenClaw 主项目的 LLM tool dispatch 层目前不消费
 * ctx.CommandAuthorized 字段（agent-tools.ts 的 senderIsOwner 注释
 * 明确写 "does not filter model tools"），所以从 napcat 网关侧
 * 把消息挡在 OpenClaw 调用之前，是用户可控的最快防线。
 *
 * 匹配策略（两路 OR）：
 *   1. 文件名直命：文本含任一受保护文件名（英文走词边界，中文走 substring）
 *   2. 意图词组合：文本同时含任一动词 + 任一名词（两词无需相邻）
 *
 * 设计上是纯函数，便于零 mock 单元测试；wire 在 gateway/inbound.ts 一次。
 */

/** 默认受保护文件名（basename，不区分大小写） */
export const DEFAULT_SENSITIVE_FILES: readonly string[] = [
  "SOUL.md",
  "AGENTS.md",
  "IDENTITY.md",
  "USER.md",
  "MEMORY.md",
];

/**
 * 默认意图动词。中英混合：英文按 \b 词边界匹配（避免 "modifier" 误命中 "modify"），
 * 中文按 substring 匹配（中文无词边界概念）。
 */
export const DEFAULT_INTENT_VERBS: readonly string[] = [
  // 中文
  "改",
  "修改",
  "更新",
  "重写",
  "设置",
  "覆盖",
  "写入",
  "替换",
  // 英文
  "edit",
  "modify",
  "update",
  "rewrite",
  "set",
  "overwrite",
  "write",
  "replace",
];

/**
 * 默认意图名词。与动词搭配命中即视为敏感意图请求。
 * 包含中文俗称（人设/灵魂等）+ 英文同义词 + 文件名词根（不带 .md）。
 */
export const DEFAULT_INTENT_NOUNS: readonly string[] = [
  // 中文
  "人设",
  "灵魂",
  "记忆",
  "身份",
  "人格",
  "性格",
  // 英文
  "soul",
  "agents",
  "memory",
  "identity",
  "persona",
];

/** 默认拒答文案 */
export const DEFAULT_REJECTION_MESSAGE =
  "⚠️ 修改人设/记忆/身份等系统文件属于敏感操作，仅管理员可执行。请联系管理员。";

/** 调用方覆盖项 */
export interface SensitiveGuardOptions {
  /** 受保护文件名列表（替换默认） */
  files?: readonly string[];
  /** 动词列表（替换默认） */
  verbs?: readonly string[];
  /** 名词列表（替换默认） */
  nouns?: readonly string[];
}

/** 匹配结果 */
export interface SensitiveGuardMatch {
  matched: boolean;
  /** 命中原因：filename = 文件名直命；intent = 动词+名词组合 */
  reason?: "filename" | "intent";
  /** 命中的文件名（filename 模式）或 "动词+名词"（intent 模式） */
  hit?: string;
}

/**
 * 转义正则元字符。
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 判断单个关键词是否命中文本：英文走 \b 词边界、中文走 substring。
 * 与 bot-decision.ts:detectStopIntent 同算法（不直接复用是因为那边 API 是
 * 简单 keywords 列表，本模块需要更多上下文返回）。
 */
function hitsKeyword(lowerText: string, lowerKw: string): boolean {
  if (!lowerKw) return false;
  // 含拉丁字母 → 视为英文，要求词边界（避免 "soul" 命中 "soulmate"）
  if (/[a-z]/i.test(lowerKw)) {
    return new RegExp(`\\b${escapeRegex(lowerKw)}\\b`, "i").test(lowerText);
  }
  // 纯非拉丁（中文等）→ substring
  return lowerText.includes(lowerKw);
}

/**
 * 按长度降序排序词表副本，使更长的词优先匹配。
 * 例如 ["改", "修改"] → ["修改", "改"]，避免 "修改人设" 报成 "改+人设"。
 * 保留原列表的稳定性（同长度按原顺序）。
 */
function sortLongestFirst(words: readonly string[]): string[] {
  return [...words].sort((a, b) => b.length - a.length);
}

/**
 * 检测文本是否在请求修改受保护文件。
 *
 * 命中规则（任一满足即返回 matched）：
 *   - filename：文本含 DEFAULT_SENSITIVE_FILES（或用户自定义）之一
 *   - intent：文本同时含一个动词 + 一个名词（默认词表或用户自定义）
 *
 * @param text 用户消息文本
 * @param opts 覆盖默认词表
 */
export function detectSensitiveFileRequest(
  text: string,
  opts?: SensitiveGuardOptions,
): SensitiveGuardMatch {
  if (!text) return { matched: false };

  const files = sortLongestFirst(opts?.files ?? DEFAULT_SENSITIVE_FILES);
  const verbs = sortLongestFirst(opts?.verbs ?? DEFAULT_INTENT_VERBS);
  const nouns = sortLongestFirst(opts?.nouns ?? DEFAULT_INTENT_NOUNS);

  const lower = text.toLowerCase();

  // Path A：文件名直命（优先级高，给出更精确的命中信息）
  for (const f of files) {
    const lowerF = f.toLowerCase();
    if (hitsKeyword(lower, lowerF)) {
      return { matched: true, reason: "filename", hit: f };
    }
  }

  // Path B：意图词组合（动词 + 名词，顺序无关，无需相邻）
  // 按长度降序遍历后，"修改人设" 报作 "修改+人设" 而非 "改+人设"
  let hitVerb: string | undefined;
  for (const v of verbs) {
    if (hitsKeyword(lower, v.toLowerCase())) {
      hitVerb = v;
      break;
    }
  }
  if (!hitVerb) return { matched: false };

  for (const n of nouns) {
    if (hitsKeyword(lower, n.toLowerCase())) {
      return { matched: true, reason: "intent", hit: `${hitVerb}+${n}` };
    }
  }

  return { matched: false };
}
