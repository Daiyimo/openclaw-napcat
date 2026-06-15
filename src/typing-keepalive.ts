/**
 * Typing 状态维持（NapCat best-effort）
 *
 * NapCat 没有官方群聊 typing API，私聊可通过 set_input_status 扩展 API 发送。
 * 群聊静默（不报错，不操作）。
 */

import type { OneBotClient } from "./client.js";

// 每 50 秒续发一次
const TYPING_INTERVAL_MS = 50_000;

export class TypingKeepAlive {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly client: OneBotClient,
    private readonly isGroup: boolean,
    private readonly groupId?: number,
    private readonly userId?: number,
    private readonly log?: { warn: (...args: unknown[]) => void },
  ) {}

  /** 启动定时 typing 状态发送 */
  start(): void {
    if (this.stopped) return;
    // 群聊无效，静默
    if (this.isGroup) return;
    // 私聊：立即发送一次，然后定时续期
    this.send();
    this.timer = setInterval(() => {
      if (this.stopped) { this.stop(); return; }
      this.send();
    }, TYPING_INTERVAL_MS);
    // 不影响进程退出（typing 是尽力而为的副作用）
    this.timer.unref();
  }

  /** 停止续期 */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private send(): void {
    if (!this.userId) return;
    // NapCat 扩展 API：set_input_status，user_id 需为 string 类型
    (this.client)
      .sendAction?.("set_input_status", {
        user_id: String(this.userId),
        event_type: 1,
      })
      .catch((err) => {
        this.log?.warn?.("[napcat-QQ] set_input_status failed:", err);
      });
  }
}
