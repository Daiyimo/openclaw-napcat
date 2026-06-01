/**
 * 项目级常量
 * 所有跨文件的魔法数字集中在此，每条带来源注释。
 */

// === WebSocket / Client ===

/** WebSocket ping 间隔（ms）。NapCat 默认心跳 30s，45s 穿透大多数 NAT 60s 空闲超时 */
export const WS_HEARTBEAT_INTERVAL_MS = 45_000;

/** sendWithResponseWs API 调用超时（ms） */
export const WS_RESPONSE_TIMEOUT_MS = 5_000;

// === 消息管道 ===

/** connect handler 中 getLoginInfo 的超时保护（ms） */
export const LOGIN_INFO_TIMEOUT_MS = 5_000;

/** 去重集合最大容量，超过后触发修剪 */
export const DEDUP_MAX_SIZE = 2_000;

/** 修剪后保留最新的 N 条消息 ID */
export const DEDUP_KEEP_SIZE = 1_000;

/** 去重集合 + 旁观冷却的定期清理间隔（ms）*/
export const CLEANUP_INTERVAL_MS = 60_000;

// === 旁观模式 ===

/** 旁观派发中（-1 哨兵）的兜底释放超时（ms）。避免 AI 崩溃后旁观永久沉默 */
export const PASSIVE_SENTINEL_TIMEOUT_MS = 30_000;

/** 旁观冷却条目最大保留时长（ms）。超过 1 小时后在 cleanup 时清除 */
export const PASSIVE_COOLDOWN_MAX_AGE_MS = 3_600_000;

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
 * 使用零宽字符作为分隔符，用户完全不可见。
 * 注意：部分平台（如 NapCat）可能会剥离零宽字符，导致签名失效。
 */
export const BOT_SIGNATURE_ZW_PATTERN = /​(\d+)‌/;

/**
 * 生成零宽字符签名。
 * @param botId bot 的 QQ 号
 */
export function makeZeroWidthSignature(botId: string | number): string {
  return `​${botId}‌`;
}

// === 协议层握手（Plan A，v1.8+ 默认方案） ===

/** 握手元数据中 app 字段的固定值，用于跨实现识别 */
export const BOT_HANDSHAKE_APP = "openclaw-napcat";

/** 握手元数据中 kind 字段的固定值（"bot"=bot 身份声明） */
export const BOT_HANDSHAKE_KIND = "bot" as const;

/** 握手消息最小 raw_message 长度（json 段载荷通常 >= 100 字节，过滤掉误判） */
export const BOT_HANDSHAKE_MIN_LENGTH = 60;

// === 投递 ===

/** 向多个管理员发错误通知时的发送间隔（ms），避免触发 QQ 发送频率限制 */
export const ERROR_NOTIFY_SLEEP_MS = 500;

/** outbound.sendText 多分片时的分片间隔（ms） */
export const OUTBOUND_MULTI_CHUNK_SLEEP_MS = 1_000;

// === HTTP 重试 ===

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

/** 默认 bot 签名样式
 *  v1.8 起改为 "metadata"：用 OneBot json 段在协议层声明 bot 身份，
 *  用户文本 100% 干净。仅当对方不是 v1.8+ openclaw-napcat 时,回退到 "visible"。
 */
export const DEFAULT_BOT_SIGNATURE_STYLE: "none" | "visible" | "zero-width" | "metadata" = "metadata";
