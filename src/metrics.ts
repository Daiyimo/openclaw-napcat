/**
 * 可观测性：轻量指标收集 + 告警冷却
 *
 * 零外部依赖。用纯内存计数器/ gauge 跟踪关键路径，
 * 通过 /status 命令暴露运行时快照。
 *
 * 指标分类:
 *   Counters: 接收/过滤/触发/发送/错误/缓存命中 各阶段计数
 *   Gauges:  连接状态、缓存条目数、速率限制器状态、内存
 *
 * 告警冷却: 同一规则在 cooldown 窗口内不重复告警，防止告警风暴。
 */

// ── 计数器 ──────────────────────────────────────────────

export interface MetricsCounters {
  inbound: {
    total: number;        // 入站消息总数
    filtered: number;     // 被 filterStage 过滤的（非目标事件/自消息/黑名单/去重）
    rateLimited: number;  // 被速率限制拦截的
    silentDropped: number; // 被 silent keyword 拦截的
    triggered: number;    // 通过 triggerStage 的
  };
  dispatch: {
    attempts: number;     // 尝试 AI 派发
    succeeded: number;    // 派发成功（deliver 完成）
    failed: number;       // 派发失败
  };
  outbound: {
    sent: number;         // 发送成功（文本/媒体/文件）
    failed: number;       // 发送失败
    mediaSent: number;    // 媒体发送
    silentDropped: number; // [SILENT]/[END_DIALOG] 丢弃
  };
  cache: {
    memberHits: number;   // member-cache 命中
    memberMisses: number; // member-cache 未命中
    uploadHits: number;   // upload-cache 命中
    uploadMisses: number; // upload-cache 未命中
    botSigHits: number;   // bot 签名 regex 缓存命中
  };
}

export interface MetricsGauges {
  pendingRequests: number;   // pendingRequests Map 大小
  rateLimiterKeys: number;   // 速率限制器活跃 key 数
  knownBots: number;         // known-bots 缓存条目数
  knownGroups: number;       // 已知群数
  memberCacheSize: number;   // member-cache 条目数
  uploadCacheSize: number;   // upload-cache 条目数
  dialogsActive: number;     // 活跃对话数（可选）
}

// ── 指标收集器 ──────────────────────────────────────────

export class MetricsCollector {
  // 内部可变，increment/reset 需要写入
  counters: MetricsCounters = {
    inbound: { total: 0, filtered: 0, rateLimited: 0, silentDropped: 0, triggered: 0 },
    dispatch: { attempts: 0, succeeded: 0, failed: 0 },
    outbound: { sent: 0, failed: 0, mediaSent: 0, silentDropped: 0 },
    cache: { memberHits: 0, memberMisses: 0, uploadHits: 0, uploadMisses: 0, botSigHits: 0 },
  };

  private _gauges: MetricsGauges = {
    pendingRequests: 0,
    rateLimiterKeys: 0,
    knownBots: 0,
    knownGroups: 0,
    memberCacheSize: 0,
    uploadCacheSize: 0,
    dialogsActive: 0,
  };

  private gaugeProviders: Map<keyof MetricsGauges, () => number> = new Map();

  // ── 计数操作 ──────────────────────────────────────────

  increment<K extends keyof MetricsCounters>(category: K, field: keyof MetricsCounters[K], amount = 1): void {
    // 内部可变，直接写入（移除顶层 readonly 后不再需要 as any 绕过类型契约）
    const cat = this.counters[category] as Record<string, number>;
    cat[field as string] += amount;
  }

  // ── Gauge 注册 ────────────────────────────────────────
  // 注册一个 gauge 的实时查询函数，snapshot 时调用获取最新值

  registerGauge<K extends keyof MetricsGauges>(key: K, provider: () => number): void {
    this.gaugeProviders.set(key, provider);
  }

  /** 手动设置 gauge（用于不便于注册 provider 的场景） */
  setGauge<K extends keyof MetricsGauges>(key: K, value: number): void {
    this._gauges[key] = value;
  }

  /** 获取 gauge 快照 */
  getGauge<K extends keyof MetricsGauges>(key: K): number {
    const provider = this.gaugeProviders.get(key);
    if (provider) return provider();
    return this._gauges[key] ?? 0;
  }

  /** 获取完整 gauge 快照 */
  snapshotGauges(): MetricsGauges {
    const result: Partial<MetricsGauges> = {};
    for (const key of Object.keys(this._gauges) as (keyof MetricsGauges)[]) {
      result[key] = this.getGauge(key);
    }
    return result as MetricsGauges;
  }

  /** 重置所有计数器（用于分段统计） */
  resetCounters(): void {
    for (const cat of Object.keys(this.counters) as (keyof MetricsCounters)[]) {
      for (const field of Object.keys(this.counters[cat]) as (keyof MetricsCounters[typeof cat])[]) {
        (this.counters[cat] as Record<string, number>)[field as string] = 0;
      }
    }
  }

  /** 生成可读的状态报告 */
  formatReport(accountId: string, version: string): string {
    const g = this.snapshotGauges();
    const c = this.counters;
    const lines: string[] = [];

    lines.push(`[OpenClaw QQ] v${version} — ${accountId}`);
    lines.push(`── 消息流量 ──`);
    lines.push(`  入站: ${c.inbound.total} (过滤=${c.inbound.filtered} 限速=${c.inbound.rateLimited} 静默=${c.inbound.silentDropped} 触发=${c.inbound.triggered})`);
    lines.push(`  派发: ${c.dispatch.attempts} 次 (成功=${c.dispatch.succeeded} 失败=${c.dispatch.failed})`);
    lines.push(`  出站: ${c.outbound.sent} 条 (媒体=${c.outbound.mediaSent} 静默=${c.outbound.silentDropped} 失败=${c.outbound.failed})`);

    lines.push(`── 缓存 ──`);
    lines.push(`  member: ${c.cache.memberHits} hit / ${c.cache.memberMisses} miss`);
    lines.push(`  upload: ${c.cache.uploadHits} hit / ${c.cache.uploadMisses} miss`);
    lines.push(`  bot sig regex: ${c.cache.botSigHits} hit`);

    lines.push(`── 运行时 ──`);
    lines.push(`  pendingRequests: ${g.pendingRequests}`);
    lines.push(`  rateLimiter keys: ${g.rateLimiterKeys}`);
    lines.push(`  knownBots: ${g.knownBots}`);
    lines.push(`  knownGroups: ${g.knownGroups}`);
    lines.push(`  memberCache: ${g.memberCacheSize}`);
    lines.push(`  uploadCache: ${g.uploadCacheSize}`);

    return lines.join("\n");
  }
}

// ── 全局单例 ────────────────────────────────────────────
// 每个账号一个实例，在 startAccount 时创建

export function createMetricsCollector(): MetricsCollector {
  return new MetricsCollector();
}

// ── 告警冷却 ────────────────────────────────────────────

export interface AlertCooldownOptions {
  cooldownMs: number;       // 冷却窗口（默认 10 分钟）
  maxHistory: number;       // 最多记录多少条（防止内存增长）
}

export class AlertCooldown {
  private readonly cooldownMs: number;
  private readonly maxHistory: number;
  /** ruleKey → 最后触发时间戳 */
  private readonly lastFired = new Map<string, number>();
  /** 触发历史（用于调试/审计） */
  private readonly history: Array<{ key: string; time: number; msg: string }> = [];

  constructor(options: AlertCooldownOptions = { cooldownMs: 10 * 60_000, maxHistory: 200 }) {
    this.cooldownMs = options.cooldownMs;
    this.maxHistory = options.maxHistory;
  }

  /**
   * 检查一条告警是否应该在冷却期内触发。
   * @returns true 表示可以触发（不在冷却期），false 表示跳过
   */
  shouldFire(ruleKey: string): boolean {
    const now = Date.now();
    const last = this.lastFired.get(ruleKey);
    if (last != null && now - last < this.cooldownMs) {
      return false;
    }
    this.lastFired.set(ruleKey, now);
    return true;
  }

  /**
   * 记录一次触发（即使 shouldFire 返回 false 也可记录，用于审计）。
   */
  record(ruleKey: string, message: string): void {
    const now = Date.now();
    this.history.push({ key: ruleKey, time: now, msg: message });
    // 限制历史长度
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
  }

  /** 获取最近的触发历史 */
  getHistory(): Array<{ key: string; time: number; msg: string }> {
    return [...this.history];
  }

  /** 清除冷却状态 */
  reset(): void {
    this.lastFired.clear();
  }
}
