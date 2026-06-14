/**
 * 出站消息合并回复（Deliver Debounce）模块
 *
 * 解决的问题：
 * 当 openclaw 框架层的 embedded agent 超时或快速连续产生多次 deliver 时，
 * 用户会在短时间内收到大量碎片消息（消息轰炸）。
 *
 * 解决方案：
 * 在 deliver 回调和实际发送之间加入 debounce 层。
 * 短时间内（windowMs）连续到达的多条纯文本 deliver 会被合并为一条消息发送。
 * 含媒体的 deliver 会立即 flush 已缓冲的文本并正常处理媒体。
 */

// ============ 默认值 ============

const DEFAULT_WINDOW_MS = 1500;
const DEFAULT_MAX_WAIT_MS = 8000;
const DEFAULT_SEPARATOR = "\n\n---\n\n";
/** flush 失败后最大重试次数 */
const MAX_FLUSH_RETRIES = 3;
/** flush 重试间隔（ms），每次翻倍：2000 → 4000 → 8000 */
const FLUSH_RETRY_BASE_MS = 2000;

// ============ 类型定义 ============

export interface DeliverDebounceOptions {
  enabled?: boolean;
  windowMs?: number;
  maxWaitMs?: number;
  separator?: string;
}

export interface DeliverPayload {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  files?: Array<{ url?: string; name?: string }>;
  [key: string]: unknown;
}

export interface DeliverInfo {
  kind: string;
}

/** 实际执行发送的回调 */
export type DeliverExecutor = (payload: DeliverPayload, info: DeliverInfo) => Promise<void>;

// ============ DeliverDebouncer 类 ============

export class DeliverDebouncer {
  private readonly windowMs: number;
  private readonly maxWaitMs: number;
  private readonly separator: string;
  private readonly executor: DeliverExecutor;
  private readonly log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
  private readonly prefix: string;

  /** 缓冲中的文本片段 */
  private bufferedTexts: string[] = [];
  /** 缓冲中最后一次 deliver 的 info（用于 flush 时传递 kind） */
  private lastInfo: DeliverInfo | null = null;
  /** debounce 定时器 */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最大等待定时器（从第一条 deliver 开始计算） */
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  /** 是否正在 flush */
  private flushing = false;
  /** 已销毁标记 */
  private disposed = false;
  /** 连续 flush 失败次数 */
  private retryCount = 0;
  /** flush 失败后的重试定时器 */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    config: DeliverDebounceOptions | undefined,
    executor: DeliverExecutor,
    log?: { info: (msg: string) => void; error: (msg: string) => void },
    prefix = "[debounce]",
  ) {
    this.windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxWaitMs = config?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.separator = config?.separator ?? DEFAULT_SEPARATOR;
    this.executor = executor;
    this.log = log;
    this.prefix = prefix;
  }

  /**
   * 接收一次 deliver 调用。
   * - 纯文本 deliver → 缓冲并设置 debounce 定时器
   * - 含媒体 deliver → 先 flush 已缓冲文本，再直接执行当前 deliver
   */
  async deliver(payload: DeliverPayload, info: DeliverInfo): Promise<void> {
    if (this.disposed) return;

    const hasMedia = Boolean(
      (payload.mediaUrls && payload.mediaUrls.length > 0) ||
        payload.mediaUrl ||
        (payload.files && payload.files.length > 0),
    );
    const text = (payload.text ?? "").trim();

    // 含媒体的 deliver：立即 flush 缓冲 + 直接执行
    if (hasMedia) {
      this.log?.info(
        `${this.prefix} Media deliver detected, flushing ${this.bufferedTexts.length} buffered text(s) first`,
      );
      await this.flush();
      await this.executor(payload, info);
      return;
    }

    // 空文本 deliver：直接透传（不缓冲）
    if (!text) {
      await this.executor(payload, info);
      return;
    }

    // 纯文本 deliver：缓冲
    this.bufferedTexts.push(text);
    this.lastInfo = info;

    this.log?.info(
      `${this.prefix} Buffered text #${this.bufferedTexts.length} (${text.length} chars), window=${this.windowMs}ms`,
    );

    // 重置 debounce 定时器
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.flush().catch((err) => {
        this.log?.error(`${this.prefix} Flush error (debounce timer): ${err}`);
      });
    }, this.windowMs);

    // 首次缓冲时启动最大等待定时器
    if (this.bufferedTexts.length === 1) {
      if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = setTimeout(() => {
        this.log?.info(`${this.prefix} Max wait (${this.maxWaitMs}ms) reached, force flushing`);
        this.flush().catch((err) => {
          this.log?.error(`${this.prefix} Flush error (max wait timer): ${err}`);
        });
      }, this.maxWaitMs);
    }
  }

  /**
   * 将缓冲中的文本合并为一条消息发送
   */
  async flush(): Promise<void> {
    if (this.flushing || this.bufferedTexts.length === 0) return;
    this.flushing = true;

    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.maxWaitTimer) { clearTimeout(this.maxWaitTimer); this.maxWaitTimer = null; }

    const texts = this.bufferedTexts;
    const info = this.lastInfo!;
    this.bufferedTexts = [];
    this.lastInfo = null;

    try {
      // 合并时只保留 text，不继承上条 payload 中的 files/media 字段，
      // 避免将旧的文件附件随合并文本重复发送。
      const merged = texts.length === 1 ? texts[0] : texts.join(this.separator);
      if (texts.length === 1) {
        this.log?.info(`${this.prefix} Flushing single buffered text (${texts[0].length} chars)`);
      } else {
        this.log?.info(
          `${this.prefix} Merged ${texts.length} buffered texts into one (${merged.length} chars)`,
        );
      }
      await this.executor({ text: merged }, info);
      this.retryCount = 0; // 成功后重置重试计数
    } catch (err) {
      // flushing=true 标志位保证本 catch 不会被并发 flush 重复触发
      // 因此 [...texts, ...this.bufferedTexts] 不会产生重复条目
      this.bufferedTexts = [...texts, ...this.bufferedTexts];
      this.lastInfo = info;
      this.retryCount++;
      this.log?.error(`${this.prefix} Flush executor failed (attempt ${this.retryCount}/${MAX_FLUSH_RETRIES}), ${texts.length} message(s) restored to buffer: ${err}`);

      // 调度重试：未 disposed 且未超过最大重试次数
      if (!this.disposed && this.retryCount <= MAX_FLUSH_RETRIES) {
        const retryDelay = FLUSH_RETRY_BASE_MS * Math.pow(2, this.retryCount - 1);
        this.log?.info(`${this.prefix} Scheduling retry in ${retryDelay}ms`);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.flush().catch((retryErr) => {
            this.log?.error(`${this.prefix} Retry flush failed: ${retryErr}`);
          });
        }, retryDelay);
      } else if (this.retryCount > MAX_FLUSH_RETRIES) {
        const lost = this.bufferedTexts.splice(0);
        this.lastInfo = null;
        this.log?.error(
          `${this.prefix} Max retries (${MAX_FLUSH_RETRIES}) exhausted, ${lost.length} message(s) permanently lost`,
        );
      }

      throw err;
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 销毁：flush 剩余缓冲并清除定时器。
   * 若 flush 失败，记录丢失的消息并 log 错误（不再无限归还到已 disposed 的 buffer）。
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.maxWaitTimer) { clearTimeout(this.maxWaitTimer); this.maxWaitTimer = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.bufferedTexts.length > 0) {
      this.flushing = false; // 确保 flush 能执行
      this.retryCount = 0;  // dispose 阶段重置计数，给最后一次 flush 机会
      try {
        await this.flush();
      } catch (err) {
        // dispose 阶段 flush 失败：不再归还（因为 disposed=true 后无人可重试），
        // 直接丢弃并记录，防止消息永久困在 buffer
        const lost = this.bufferedTexts.splice(0);
        this.log?.error(
          `${this.prefix} Dispose flush failed, ${lost.length} message(s) lost: ${err}`,
        );
      }
    }
  }

  get hasPending(): boolean { return this.bufferedTexts.length > 0; }
  get pendingCount(): number { return this.bufferedTexts.length; }
}

// ============ 工厂函数 ============

/**
 * 根据配置创建 debouncer 或返回 null（禁用时）
 */
export function createDeliverDebouncer(
  config: DeliverDebounceOptions | undefined,
  executor: DeliverExecutor,
  log?: { info: (msg: string) => void; error: (msg: string) => void },
  prefix?: string,
): DeliverDebouncer | null {
  if (config?.enabled === false) return null;
  return new DeliverDebouncer(config, executor, log, prefix);
}
