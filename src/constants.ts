/**
 * 项目级常量
 * 所有跨文件的魔法数字集中在此，每条带来源注释。
 */

// === CQ 码 ===

/**
 * CQ at 码正则：匹配 [CQ:at,qq=数字] 或 [CQ:at,qq=all]。
 * 用于检测消息中是否 @ 了 bot。
 */
export const CQ_AT_PATTERN = /\[CQ:at,qq=(\d+|all)\]/;

// === WebSocket / Client ===

/** WebSocket ping 间隔（ms）。NapCat 默认心跳 30s，45s 穿透大多数 NAT 60s 空闲超时 */
export const WS_HEARTBEAT_INTERVAL_MS = 45_000;

/** sendWithResponseWs API 调用超时（ms） */
export const WS_RESPONSE_TIMEOUT_MS = 5_000;

// === 消息管道 ===

/** connect handler 中 getLoginInfo 的超时保护（ms） */
export const LOGIN_INFO_TIMEOUT_MS = 5_000;

/** 图片下载最大并发数。防止大量图片同时下载耗尽连接池 */
export const CONCURRENT_DOWNLOADS = 3;

/** 去重集合最大容量，超过后触发修剪 */
export const DEDUP_MAX_SIZE = 2_000;

/** 去重集合修剪触发阈值。超过此大小时触发修剪（防止集合无限增长） */
export const DEDUP_TRIM_THRESHOLD = 100_000;

/** 修剪后保留最新的 N 条消息 ID */
export const DEDUP_KEEP_SIZE = 1_000;

/** 去重集合 + 旁观冷却的定期清理间隔（ms）*/
export const CLEANUP_INTERVAL_MS = 60_000;

/** get_group_honor_info type="all"（查询所有荣誉类型） */
export const HONOR_TYPE_ALL = "all";

/** 群文件列表默认条数 */
export const GROUP_FILE_DEFAULT_COUNT = 50;

// === 旁观模式 ===

/** 旁观派发中（-1 哨兵）的兜底释放超时（ms）。避免 AI 崩溃后旁观永久沉默 */
export const PASSIVE_SENTINEL_TIMEOUT_MS = 30_000;

/** 旁观冷却条目最大保留时长（ms）。超过 1 小时后在 cleanup 时清除 */
export const PASSIVE_COOLDOWN_MAX_AGE_MS = 3_600_000;

/** 零宽字符常量，避免源码中出现不可见字符 */
const ZWSP = "\u200b"; // Zero-Width Space
const ZWNJ = "\u200c"; // Zero-Width Non-Joiner

// === 群路由 ===

/** 群路由定时刷新间隔（ms）。每 1 小时同步新加入/退出的群 */
export const GROUP_ROUTE_REFRESH_INTERVAL_MS = 1 * 60 * 60 * 1_000;

// === 友军识别 ===

/**
 * 可见签名正则：匹配 [BOT:数字] 格式，提取 bot 的 QQ 号。
 * 例如 [BOT:123456] → 捕获组 1 = "123456"
 */
export const BOT_SIGNATURE_PATTERN = /\[BOT:(\d+)\]/;

/**
 * 零宽字符签名正则：匹配 U+200B + 编码的 bot ID + U+200C 格式。
 * 使用 ​/‌ 转义避免源码中出现不可见字符。
 * 注意：部分平台（如 NapCat）可能会剥离零宽字符，导致签名失效。
 */
export const BOT_SIGNATURE_ZW_PATTERN = /\u200b(\d+)\u200c/;

/**
 * 生成零宽字符签名。
 * @param botId bot 的 QQ 号
 */
export function makeZeroWidthSignature(botId: string | number): string {
  return ZWSP + String(botId) + ZWNJ;
}

// 协议层握手（json 段 / metadata 模式）在 v1.9.2 移除：
// OneBot json 段在 QQ 客户端渲染为可见卡片消息，启动握手 = 群广播 spam。
// 友军识别依赖 sender.bot / knownBotIds / 持久化 known-bots cache / 文本签名。

// === 投递 ===

/** 向多个管理员发错误通知时的发送间隔（ms），避免触发 QQ 发送频率限制 */
export const ERROR_NOTIFY_SLEEP_MS = 500;

/** outbound.sendText 多分片时的分片间隔（ms） */
export const OUTBOUND_MULTI_CHUNK_SLEEP_MS = 1_000;

// === HTTP 重试 ===

/** HTTP API 调用超时（ms）。防止慢速攻击耗尽连接池 */
export const HTTP_RESPONSE_TIMEOUT_MS = 10_000;

/** HTTP API 最大重试次数（不含首次调用） */
export const HTTP_MAX_RETRIES = 3;

/** HTTP 重试首次延迟（ms），后续按 2x 指数增长：200 → 400 → 800 */
export const HTTP_RETRY_BASE_DELAY_MS = 200;

// === 多 bot 对话控制（v1.8+） ===

/** 用户停止指令后，bot 静默窗口（ms）。60 秒内不再响应新消息 */
export const BOT_STOPPED_SUPPRESS_MS = 60_000;

/** 用户停止意图默认关键词（v1.8+ 旁观模式检测用户停止指令用） */
export const DEFAULT_STOP_KEYWORDS = [
  "别聊了",
  "stop",
  "Stop",
  "STOP",
  "闭嘴",
  "安静",
  "别说了",
  "别吵了",
];

/** 默认 bot 签名样式。metadata（OneBot json 段握手）在 v1.9.2 移除（会导致群广播 spam），
 *  现仅保留 visible / zero-width / none 三种纯文本策略。 */
export const DEFAULT_BOT_SIGNATURE_STYLE: "none" | "visible" | "zero-width" = "visible";

// === 回复格式硬约束（v1.9.1+） ===

/**
 * 默认 responseGuidelines:硬性约束 LLM 不要在回复中混入内部推理 / meta 注释。
 *
 * 触发场景:reasoning 类模型(Claude with extended thinking / o1 / o3 等)有时会
 * 把思考过程作为 text 块返回,而不是分离到 thinking 块,导致用户在群里看到:
 *   "The user '戴以沫' is pinging me with just '醒'... I should respond...
 *    醒着呢!👀"
 * 这条约束通过显式 system prompt 强约束 LLM 只输出最终回复。
 *
 * 用户可通过 responseGuidelines: "" 关闭,或用 QQ_RESPONSE_GUIDELINES 自定义。
 */
export const DEFAULT_RESPONSE_GUIDELINES = `【回复格式硬性约束 — 违反任何一条都视为出错】

1. 只输出最终给用户看的回复内容,绝对不要包含:
   - "我在思考"、"我想"、"I should..."、"I need to..."、"Let me..." 等内部推理
   - "用户说..."、"The user is..."、"The user asked..." 等用户行为分析
   - 任何英文 meta 注释、内心独白、行动规划
   - 自指描述如 "我是 AI"、"我是助手" 等(除非用户明确询问身份)

2. 直接回答问题。群聊场景:
   - 默认 50 字以内,信息密度优先
   - 不用"首先/其次/最后"这种八股结构
   - 不用 Markdown 标题 / 列表(除非用户明确要求或消息体本身就是技术内容)
   - 用纯文本 + 偶尔 emoji 即可

3. 语言:跟用户用同一种语言。用户用中文就用中文,用户用英文才用英文。

4. 多 bot 共存场景:不要复述其他 bot 的消息(避免噪声);如需回应则简短、明确。

5. 旁听/被动模式:没想说的回复 [SILENT],不要硬凑回复。`;

// === 入站频控 ===

/** 入站频控默认每窗口最大消息数 */
export const INBOUND_RATE_LIMIT_DEFAULT_MAX = 5;

/** 群消息历史缓存 TTL（ms）。减少热路径中重复调用 getGroupMsgHistory 的网络 I/O */
export const GROUP_HISTORY_CACHE_TTL_MS = 30_000;

// === 对话状态 ===

/** 群对话状态清理最大未活跃时长（ms）。超过后清除对话状态 */
export const DIALOG_STATE_CLEANUP_MS = 60 * 60 * 1_000;

// === 探活 ===

/** 账号探活超时默认值（ms）。用于 channel.ts probeAccount 无超时参数时的兜底 */
export const PROBE_DEFAULT_TIMEOUT_MS = 5_000;

// === 引用索引 ===

/** 引用索引写队列 flush 延迟（ms）。写队列有数据时延迟 flush 以减少 I/O */
export const FLUSH_DELAY_MS = 100;

// === 图片下载 ===

/** downloadImages 最大重定向跳数 */
export const MAX_REDIRECT_COUNT = 3;

/** Silk 语音默认采样率（Hz）。NapCat 语音消息标准采样率 */
export const SILK_SAMPLE_RATE = 24_000;

// === 主动推送 ===

/** 批量主动推送默认最大接收者数 */
export const PROACTIVE_DEFAULT_MAX_RECIPIENTS = 200;

/** 批量主动推送默认发送间隔（ms）。避免触发 QQ 发送频率限制 */
export const PROACTIVE_DEFAULT_INTERVAL_MS = 1_500;

// === 去重 ===

/** sentFingerprints 惰性清理阈值。超过此大小时触发过期条目清理（O(1) 摊还） */
export const SENT_FINGERPRINT_CLEANUP_THRESHOLD = 1000;

// === 休眠模式 ===

/** 休眠模式默认开始小时（23 = 晚上 11 点） */
export const DEFAULT_SLEEP_START_HOUR = 23;

/** 休眠模式默认结束小时（7 = 早上 7 点） */
export const DEFAULT_SLEEP_END_HOUR = 7;

// === session 冲突 ===

/** 框架 session 初始化冲突错误的识别特征。
 *  来源：openclaw 框架在并发 session 初始化时抛出的 Error.message 固定英文文案。
 *  ⚠️ 强依赖框架原文；若框架改词或本地化，此处需同步更新。 */
export const SESSION_CONFLICT_PATTERN = /session initialization conflicted/i;
