/**
 * 文件上传去重缓存
 *
 * 同一账号、同一文件路径在 TTL 内只需上传一次，后续直接复用 file_id。
 * 减少重复上传带宽消耗，提升响应速度。
 */

// ============ 默认值 ============

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 分钟

// ============ 类型 ============

interface CacheEntry {
  fileId: string;
  expiresAt: number;
}

// ============ UploadCache 类 ============

export class UploadCache {
  private readonly cache = new Map<string, CacheEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly defaultTtlMs = DEFAULT_TTL_MS) {
    // 每 10 分钟清理一次过期条目
    this.cleanupTimer = setInterval(() => this.cleanup(), 10 * 60 * 1000);
  }

  /**
   * 构建缓存 key
   */
  buildKey(accountId: string, filePath: string): string {
    return `${accountId}:${filePath}`;
  }

  /**
   * 查询缓存中的 file_id，未命中或已过期返回 null
   */
  get(key: string): string | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.fileId;
  }

  /**
   * 写入缓存
   */
  set(key: string, fileId: string, ttlMs = this.defaultTtlMs): void {
    this.cache.set(key, { fileId, expiresAt: Date.now() + ttlMs });
  }

  /**
   * 清理过期条目
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) this.cache.delete(key);
    }
  }

  /**
   * 销毁（清除定时器）
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
