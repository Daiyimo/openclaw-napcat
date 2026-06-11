/**
 * 管理命令注册表
 *
 * 替代原来的 if-else 链，每个命令通过 register() 注册，
 * handler 接收统一上下文，返回处理结果字符串或 null（未处理）。
 */

import type { OneBotClient } from "../client.js";
import type { OneBotMessage } from "../types.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ConfigRef } from "../config-watcher.js";
import type { InboundRateLimiter } from "../rate-limiter.js";

// ── 类型定义 ──────────────────────────────────────────────────────────

export interface AdminCmdContext {
  client: OneBotClient;
  isGroup: boolean;
  groupId?: number;
  userId?: number;
  text: string;
  message?: OneBotMessage | string;
  eventTime?: number;
  configRef?: ConfigRef;
  fullCfg?: OpenClawConfig;
  refreshGroupRoutes?: () => Promise<number>;
  rateLimiter?: InboundRateLimiter;
}

export interface CommandHandler {
  name: string;
  description: string;
  handle(ctx: AdminCmdContext, parts: string[]): Promise<string | null>;
}

// ── 注册表实现 ────────────────────────────────────────────────────────

export class CommandRegistry {
  private commands = new Map<string, CommandHandler>();

  register(cmd: string, description: string, handler: (ctx: AdminCmdContext, parts: string[]) => Promise<string | null>): void {
    this.commands.set(cmd, { name: cmd, description, handle: handler });
  }

  async execute(cmd: string, ctx: AdminCmdContext, parts: string[]): Promise<boolean> {
    const command = this.commands.get(cmd);
    if (!command) return false;

    const reply = (msg: string): Promise<void> => {
      if (ctx.isGroup && ctx.groupId) {
        return ctx.client.sendGroupMsg(ctx.groupId, msg);
      } else if (ctx.userId) {
        return ctx.client.sendPrivateMsg(ctx.userId, msg);
      }
      return Promise.resolve();
    };

    const result = await command.handle(ctx, parts);
    if (result !== null) {
      await reply(result);
    }
    return true;
  }

  getCommandNames(): string[] {
    return Array.from(this.commands.keys());
  }

  getHelpText(): string {
    // 子类可覆写，或由外部组装
    return "";
  }
}
