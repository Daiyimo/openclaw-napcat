import WebSocket, { WebSocketServer } from "ws";
import EventEmitter from "events";
import type { OneBotEvent, OneBotMessage } from "./types.js";
import type { IncomingMessage } from "http";
import { withRetry, HttpApiError, isRetryableError } from "./utils/retry.js";
import {
  WS_HEARTBEAT_INTERVAL_MS,
  WS_RESPONSE_TIMEOUT_MS,
  HTTP_MAX_RETRIES,
  HTTP_RETRY_BASE_DELAY_MS,
} from "./constants.js";

interface OneBotClientOptions {
  wsUrl?: string;
  httpUrl?: string;
  reverseWsPort?: number;
  accessToken?: string;
}

export class OneBotClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: OneBotClientOptions;
  private selfId: number | null = null;
  private isAlive = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reverseWss: WebSocketServer | null = null;
  private reverseWs: WebSocket | null = null;
  /** 反向 WS 专用心跳定时器（独立于正向 WS 的 heartbeatTimer） */
  private reverseHeartbeatTimer: NodeJS.Timeout | null = null;
  /** 请求-响应关联：echo → { resolve, reject, timer } */
  private readonly pendingRequests = new Map<string, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(options: OneBotClientOptions) {
    super();
    this.options = options;
  }

  getSelfId(): number | null {
    return this.selfId;
  }

  setSelfId(id: number) {
    this.selfId = id;
  }

  connect() {
    if (!this.options.wsUrl) return;
    this.cleanup();

    const headers: Record<string, string> = {};
    if (this.options.accessToken) {
      headers["Authorization"] = `Bearer ${this.options.accessToken}`;
    }

    // 移除无用的 try-catch（异常直接向上传播，框架负责重连）
    this.ws = new WebSocket(this.options.wsUrl, { headers });

    this.ws.on("open", () => {
      this.isAlive = true;
      this.emit("connect");
      console.log("[napcat-QQ] Connected to OneBot server");
      this.startHeartbeat();
    });

    this.ws.on("message", (data) => {
      this.isAlive = true;
      const payload = this.parseIncomingMessage(data);
      if (!payload) return;
      this.emit("message", payload);
    });

    this.ws.on("close", () => { this.handleDisconnect(); });

    this.ws.on("error", (err) => {
      console.error("[napcat-QQ] WebSocket error:", err);
      this.handleDisconnect();
    });
  }

  private cleanup() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.terminate();
      }
      this.ws = null;
    }
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    // Send a WebSocket ping every 45 seconds to keep the TCP connection alive
    // through NAT/virtual network layers (which often have a 60s idle timeout).
    // If no message is received within one interval (45s), force a reconnect.
    this.heartbeatTimer = setInterval(() => {
      if (this.isAlive === false) {
        console.warn("[napcat-QQ] Heartbeat timeout, forcing reconnect...");
        this.handleDisconnect();
        return;
      }
      this.isAlive = false;
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
    }, WS_HEARTBEAT_INTERVAL_MS);
  }

  /**
   * 反向 WS 心跳检测：定期 ping 对端，若超时无响应则判定连接假死并主动断开。
   * 解决 TCP 半开（SIGKILL / 网络分区）时 "close" 事件不触发的问题。
   */
  private startReverseHeartbeat(ws: WebSocket) {
    this.stopReverseHeartbeat();
    this.isAlive = true;
    this.reverseHeartbeatTimer = setInterval(() => {
      if (this.isAlive === false) {
        console.warn("[napcat-QQ] Reverse WS heartbeat timeout, closing stale connection...");
        ws.terminate();
        // terminate() 会触发 "close" 事件 → 走正常 disconnect 流程
        return;
      }
      this.isAlive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, WS_HEARTBEAT_INTERVAL_MS);
  }

  private stopReverseHeartbeat() {
    if (this.reverseHeartbeatTimer) {
      clearInterval(this.reverseHeartbeatTimer);
      this.reverseHeartbeatTimer = null;
    }
  }

  private handleDisconnect() {
    this.cleanup();
    // 拒绝所有等待中的请求
    for (const [echo, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("WebSocket disconnected"));
    }
    this.pendingRequests.clear();
    console.log("[napcat-QQ] Disconnected from OneBot server");
    this.emit("disconnect");
    // Reconnection is handled by OpenClaw's health-monitor via startAccount.
    // Do not self-reconnect here to avoid racing with the host framework.
  }

  async sendPrivateMsg(userId: number, message: OneBotMessage | string) {
    await this.sendAction("send_private_msg", { user_id: String(userId), message });
  }

  async sendGroupMsg(groupId: number, message: OneBotMessage | string) {
    await this.sendAction("send_group_msg", { group_id: String(groupId), message });
  }

  deleteMsg(messageId: number | string) {
    this.sendWs("delete_msg", { message_id: String(messageId) });
  }

  setGroupAddRequest(flag: string, subType: string, approve: boolean = true, reason: string = "") {
    this.sendWs("set_group_add_request", { flag, sub_type: subType, approve, reason });
  }

  setFriendAddRequest(flag: string, approve: boolean = true, remark: string = "") {
    this.sendWs("set_friend_add_request", { flag, approve, remark });
  }

  async getLoginInfo(): Promise<any> {
    return this.sendWithResponse("get_login_info", {});
  }

  async getMsg(messageId: number | string): Promise<any> {
    return this.sendWithResponse("get_msg", { message_id: String(messageId) });
  }

  async getGroupMsgHistory(groupId: number, count?: number): Promise<any> {
    const params: any = { group_id: String(groupId) };
    if (count !== undefined) params.count = count;
    return this.sendWithResponse("get_group_msg_history", params);
  }

  async getForwardMsg(id: string): Promise<any> {
    return this.sendWithResponse("get_forward_msg", { id });
  }

  async getFriendList(): Promise<any[]> {
    return this.sendWithResponse("get_friend_list", {});
  }

  async getGroupList(): Promise<any[]> {
    return this.sendWithResponse("get_group_list", {});
  }

  async getGroupInfo(groupId: string | number): Promise<{ group_id: number; group_name?: string } | null> {
    try {
      return await this.sendWithResponse("get_group_info", { group_id: String(groupId) });
    } catch {
      return null;
    }
  }

  async sendGuildChannelMsg(guildId: string, channelId: string, message: OneBotMessage | string): Promise<void> {
    await this.sendAction("send_guild_channel_msg", { guild_id: guildId, channel_id: channelId, message });
  }

  async getGuildList(): Promise<any[]> {
    try { return await this.sendWithResponse("get_guild_list", {}); } catch { return []; }
  }

  async getGuildServiceProfile(): Promise<any> {
    try { return await this.sendWithResponse("get_guild_service_profile", {}); } catch { return null; }
  }

  sendGroupPoke(groupId: number, userId: number) {
    this.sendWs("group_poke", { group_id: String(groupId), user_id: String(userId) });
  }

  sendFriendPoke(userId: number) {
    this.sendWs("friend_poke", { user_id: String(userId), target_id: String(userId) });
  }

  async setMsgEmojiLike(messageId: number | string, emojiId: string) {
    await this.sendAction("set_msg_emoji_like", { message_id: String(messageId), emoji_id: emojiId, set: true });
  }

  async markGroupMsgAsRead(groupId: number): Promise<void> {
    const activeWs = this.getActiveWs();
    if (activeWs) {
      activeWs.send(JSON.stringify({ action: "mark_group_msg_as_read", params: { group_id: String(groupId) } }));
    }
  }

  async markPrivateMsgAsRead(userId: number): Promise<void> {
    const activeWs = this.getActiveWs();
    if (activeWs) {
      activeWs.send(JSON.stringify({ action: "mark_private_msg_as_read", params: { user_id: String(userId) } }));
    }
  }

  async getGroupMemberList(groupId: number): Promise<any[]> {
    return this.sendWithResponse("get_group_member_list", { group_id: String(groupId) });
  }

  async getAiCharacters(): Promise<any> {
    return this.sendWithResponse("get_ai_characters", {});
  }

  async sendGroupAiRecord(groupId: number, text: string, voiceId: string) {
    await this.sendAction("send_group_ai_record", { group_id: String(groupId), text, character: voiceId });
  }

  async uploadGroupFile(groupId: number, file: string, name: string) {
    await this.sendAction("upload_group_file", { group_id: String(groupId), file, name });
  }

  async uploadPrivateFile(userId: number, file: string, name: string) {
    await this.sendAction("upload_private_file", { user_id: String(userId), file, name });
  }

  setGroupBan(groupId: number, userId: number, duration: number = 1800) {
    this.sendWs("set_group_ban", { group_id: String(groupId), user_id: String(userId), duration });
  }

  setGroupKick(groupId: number, userId: number, rejectAddRequest: boolean = false) {
    this.sendWs("set_group_kick", { group_id: String(groupId), user_id: String(userId), reject_add_request: rejectAddRequest });
  }

  /** Try HTTP API first, fall back to WebSocket */
  private async sendAction(action: string, params: any) {
    if (this.options.httpUrl) {
      try {
        console.log(`[napcat-QQ][sendAction] trying HTTP: ${this.options.httpUrl}/${action}`);
        await this.sendViaHttp(action, params);
        console.log(`[napcat-QQ][sendAction] HTTP success: ${action}`);
        return;
      } catch (err: any) {
        console.warn(`[napcat-QQ][sendAction] HTTP failed for ${action}:`, err.message);
      }
    }
    const activeWs = this.getActiveWs();
    console.log(`[napcat-QQ][sendAction] trying WS: forwardWs=${this.ws?.readyState}, reverseWs=${this.reverseWs?.readyState}, active=${!!activeWs}`);
    this.sendWs(action, params);
  }

  private async sendViaHttp(action: string, params: any): Promise<any> {
    return withRetry(async () => {
      const url = `${this.options.httpUrl}/${action}`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.options.accessToken) {
        headers["Authorization"] = `Bearer ${this.options.accessToken}`;
      }
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(params),
      });
      if (!resp.ok) {
        throw new HttpApiError(resp.status, resp.statusText, action);
      }
      const data = await resp.json() as any;
      if (data.status !== "ok" && data.retcode !== 0) {
        throw new Error(data.msg || data.wording || "HTTP API request failed");
      }
      return data.data;
    }, {
      maxRetries: HTTP_MAX_RETRIES,
      baseDelayMs: HTTP_RETRY_BASE_DELAY_MS,
      shouldRetry: isRetryableError,
    });
  }

  // --- Reverse WebSocket Server ---

  startReverseWs() {
    const port = this.options.reverseWsPort;
    if (!port) return;
    // 幂等保护：已启动则不重复创建
    if (this.reverseWss) return;

    this.reverseWss = new WebSocketServer({ port });
    console.log(`[napcat-QQ] Reverse WebSocket server listening on port ${port}`);

    this.reverseWss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      // Verify access token if configured
      if (this.options.accessToken) {
        const auth = req.headers["authorization"];
        if (auth !== `Bearer ${this.options.accessToken}`) {
          console.warn("[napcat-QQ] Reverse WS: unauthorized connection rejected");
          ws.close(4001, "Unauthorized");
          return;
        }
      }

      console.log("[napcat-QQ] Reverse WS: NapCat connected");

      // 关闭旧连接，防止双连接窗口期内事件被处理两次
      if (this.reverseWs) {
        this.reverseWs.removeAllListeners();
        this.reverseWs.close();
      }
      this.reverseWs = ws;

      // 先注册 listeners，消除 emit("connect") 触发后响应消息的竞态
      ws.on("message", (data) => {
        this.isAlive = true; // reverse WS 路径同样维护心跳存活标记
        const payload = this.parseIncomingMessage(data);
        if (!payload || !payload.post_type) return;
        if (payload.post_type === "meta_event" && payload.meta_event_type === "lifecycle" && payload.self_id) {
          this.selfId = payload.self_id;
        }
        this.emit("message", payload);
      });

      ws.on("close", () => {
        console.log("[napcat-QQ] Reverse WS: NapCat disconnected");
        if (this.reverseWs === ws) this.reverseWs = null;
        this.stopReverseHeartbeat();
        ws.removeAllListeners();
        this.emit("disconnect");
      });

      ws.on("error", (err) => {
        console.error("[napcat-QQ] Reverse WS error:", err);
      });

      // listeners 就绪后触发，使 channel.ts 的 connect handler 能正确更新状态
      this.startReverseHeartbeat(ws);
      this.emit("connect");
    });

    this.reverseWss.on("error", (err) => {
      console.error("[napcat-QQ] Reverse WS server error:", err);
    });
  }

  stopReverseWs(): Promise<void> {
    return new Promise((resolve) => {
      this.stopReverseHeartbeat();
      if (this.reverseWs) {
        this.reverseWs.close();
        this.reverseWs = null;
      }
      if (this.reverseWss) {
        this.reverseWss.close(() => {
          this.reverseWss = null;
          console.log("[napcat-QQ] Reverse WebSocket server stopped");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private getActiveWs(): WebSocket | null {
    if (this.ws?.readyState === WebSocket.OPEN) return this.ws;
    if (this.reverseWs?.readyState === WebSocket.OPEN) return this.reverseWs;
    return null;
  }

  private sendWithResponse(action: string, params: any): Promise<any> {
    // Prefer HTTP API for request-response calls if available
    if (this.options.httpUrl) {
      return this.sendViaHttp(action, params).catch((err) => {
        console.warn(`[napcat-QQ] HTTP API failed for ${action}, falling back to WS:`, err.message);
        return this.sendWithResponseWs(action, params);
      });
    }
    return this.sendWithResponseWs(action, params);
  }

  private sendWithResponseWs(action: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const activeWs = this.getActiveWs();
      if (!activeWs) {
        reject(new Error("WebSocket not open"));
        return;
      }

      const echo = Math.random().toString(36).substring(2, 15);

      const timer = setTimeout(() => {
        this.pendingRequests.delete(echo);
        reject(new Error("Request timeout"));
      }, WS_RESPONSE_TIMEOUT_MS);

      // 注册 close 监听，WS 断连时立即 reject 而非等待超时
      const closeHandler = () => {
        if (this.pendingRequests.has(echo)) {
          this.pendingRequests.delete(echo);
          clearTimeout(timer);
          reject(new Error("WebSocket closed while waiting for response"));
        }
      };
      activeWs.once("close", closeHandler);

      this.pendingRequests.set(echo, {
        resolve: (value) => {
          activeWs.off("close", closeHandler);
          resolve(value);
        },
        reject: (reason) => {
          activeWs.off("close", closeHandler);
          reject(reason);
        },
        timer,
      });

      // TOCTOU 修复：try-catch 包裹 send()，防止 WS 在检查后关闭导致异常逃逸
      try {
        activeWs.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        this.pendingRequests.delete(echo);
        activeWs.off("close", closeHandler);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  private sendWs(action: string, params: any) {
    const activeWs = this.getActiveWs();
    if (activeWs) {
      activeWs.send(JSON.stringify({ action, params }));
    } else {
      throw new Error("No WebSocket connection available");
    }
  }

  async disconnect() {
    this.cleanup();
    await this.stopReverseWs();
  }

  /** 解析入站消息，过滤心跳，分发 echo 响应，解析失败返回 null */
  private parseIncomingMessage(data: WebSocket.RawData): OneBotEvent | null {
    try {
      const payload = JSON.parse(data.toString());
      // echo 响应分发：由 pendingRequests Map 处理，不透传给上层
      if (payload.echo && this.pendingRequests.has(payload.echo)) {
        const pending = this.pendingRequests.get(payload.echo)!;
        this.pendingRequests.delete(payload.echo);
        clearTimeout(pending.timer);
        if (payload.status === "ok") {
          pending.resolve(payload.data);
        } else {
          pending.reject(new Error(payload.msg || "API request failed"));
        }
        return null;
      }
      if (payload.post_type === "meta_event" && payload.meta_event_type === "heartbeat") {
        return null;
      }
      return payload as OneBotEvent;
    } catch {
      return null;
    }
  }
}
