import WebSocket, { WebSocketServer } from "ws";
import EventEmitter from "events";
import type { OneBotEvent, OneBotMessage } from "./types.js";
import type { IncomingMessage } from "http";

interface OneBotClientOptions {
  wsUrl: string;
  httpUrl?: string;
  reverseWsPort?: number;
  accessToken?: string;
}

export class OneBotClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: OneBotClientOptions;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 60000; // Max 1 minute delay
  private selfId: number | null = null;
  private isAlive = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reverseWss: WebSocketServer | null = null;
  private reverseWs: WebSocket | null = null;

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
    this.cleanup();

    const headers: Record<string, string> = {};
    if (this.options.accessToken) {
      headers["Authorization"] = `Bearer ${this.options.accessToken}`;
    }

    try {
      this.ws = new WebSocket(this.options.wsUrl, { headers });

      this.ws.on("open", () => {
        this.isAlive = true;
        this.reconnectAttempts = 0; // Reset counter on success
        this.emit("connect");
        console.log("[QQ] Connected to OneBot server");
        
        // Start heartbeat check
        this.startHeartbeat();
      });

      this.ws.on("message", (data) => {
        this.isAlive = true; // Any message from server means connection is alive
        try {
          const payload = JSON.parse(data.toString()) as OneBotEvent;
          if (payload.post_type === "meta_event" && payload.meta_event_type === "heartbeat") {
            return;
          }
          this.emit("message", payload);
        } catch (err) {
          // Ignore non-JSON or parse errors
        }
      });

      this.ws.on("close", () => {
        this.handleDisconnect();
      });

      this.ws.on("error", (err) => {
        console.error("[QQ] WebSocket error:", err);
        this.handleDisconnect();
      });
    } catch (err) {
      console.error("[QQ] Failed to initiate WebSocket connection:", err);
      this.scheduleReconnect();
    }
  }

  private cleanup() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
    // Check every 30 seconds
    this.heartbeatTimer = setInterval(() => {
      if (this.isAlive === false) {
        console.warn("[QQ] Heartbeat timeout, forcing reconnect...");
        this.handleDisconnect();
        return;
      }
      this.isAlive = false;
      // We don't send ping, we rely on OneBot's heartbeat meta_event
      // or we can send a small API call to verify
    }, 45000); 
  }

  private handleDisconnect() {
    this.cleanup();
    this.emit("disconnect");
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return; // Already scheduled
    
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    console.log(`[QQ] Reconnecting in ${delay / 1000}s (Attempt ${this.reconnectAttempts + 1})...`);
    
    this.reconnectTimer = setTimeout(() => {
        this.reconnectAttempts++;
        this.connect();
    }, delay);
  }

  async sendPrivateMsg(userId: number, message: OneBotMessage | string) {
    await this.sendAction("send_private_msg", { user_id: userId, message });
  }

  async sendGroupMsg(groupId: number, message: OneBotMessage | string) {
    await this.sendAction("send_group_msg", { group_id: groupId, message });
  }

  deleteMsg(messageId: number | string) {
    this.sendWs("delete_msg", { message_id: messageId });
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
    return this.sendWithResponse("get_msg", { message_id: messageId });
  }

  // Note: get_group_msg_history is extended API supported by go-cqhttp/napcat
  async getGroupMsgHistory(groupId: number, count?: number): Promise<any> {
    const params: any = { group_id: groupId };
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

  // --- Guild (Channel) Extension APIs ---
  sendGuildChannelMsg(guildId: string, channelId: string, message: OneBotMessage | string) {
    this.sendWs("send_guild_channel_msg", { guild_id: guildId, channel_id: channelId, message });
  }

  async getGuildList(): Promise<any[]> {
    // Note: API name varies by implementation (get_guild_list vs get_guilds)
    // We try the most common one for extended OneBot
    try {
        return await this.sendWithResponse("get_guild_list", {});
    } catch {
        return [];
    }
  }

  async getGuildServiceProfile(): Promise<any> {
      try { return await this.sendWithResponse("get_guild_service_profile", {}); } catch { return null; }
  }

  sendGroupPoke(groupId: number, userId: number) {
      this.sendWs("group_poke", { group_id: groupId, user_id: userId });
  }

  sendFriendPoke(userId: number) {
      this.sendWs("friend_poke", { user_id: userId });
  }

  async setMsgEmojiLike(messageId: number | string, emojiId: string) {
      this.sendWs("set_msg_emoji_like", { message_id: messageId, emoji_id: emojiId });
  }

  async markGroupMsgAsRead(groupId: number) {
      this.sendWs("mark_group_msg_as_read", { group_id: groupId });
  }

  async markPrivateMsgAsRead(userId: number) {
      this.sendWs("mark_private_msg_as_read", { user_id: userId });
  }

  async getGroupMemberList(groupId: number): Promise<any[]> {
      return this.sendWithResponse("get_group_member_list", { group_id: groupId });
  }

  async getAiCharacters(): Promise<any> {
      return this.sendWithResponse("get_ai_characters", {});
  }

  async sendGroupAiRecord(groupId: number, text: string, voiceId: string) {
      await this.sendAction("send_group_ai_record", { group_id: groupId, text, character: voiceId });
  }

  async uploadGroupFile(groupId: number, file: string, name: string) {
      await this.sendAction("upload_group_file", { group_id: groupId, file, name });
  }

  async uploadPrivateFile(userId: number, file: string, name: string) {
      await this.sendAction("upload_private_file", { user_id: userId, file, name });
  }
  // --------------------------------------

  setGroupBan(groupId: number, userId: number, duration: number = 1800) {
    this.sendWs("set_group_ban", { group_id: groupId, user_id: userId, duration });
  }

  setGroupKick(groupId: number, userId: number, rejectAddRequest: boolean = false) {
    this.sendWs("set_group_kick", { group_id: groupId, user_id: userId, reject_add_request: rejectAddRequest });
  }

  /** Try HTTP API first, fall back to WebSocket */
  private async sendAction(action: string, params: any) {
    if (this.options.httpUrl) {
      try {
        console.log(`[QQ][sendAction] trying HTTP: ${this.options.httpUrl}/${action}`);
        await this.sendViaHttp(action, params);
        console.log(`[QQ][sendAction] HTTP success: ${action}`);
        return;
      } catch (err: any) {
        console.warn(`[QQ][sendAction] HTTP failed for ${action}:`, err.message);
      }
    }
    const activeWs = this.getActiveWs();
    console.log(`[QQ][sendAction] trying WS: forwardWs=${this.ws?.readyState}, reverseWs=${this.reverseWs?.readyState}, active=${!!activeWs}`);
    this.sendWs(action, params);
  }

  private async sendViaHttp(action: string, params: any): Promise<any> {
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
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    const data = await resp.json() as any;
    if (data.status !== "ok" && data.retcode !== 0) {
      throw new Error(data.msg || data.wording || "HTTP API request failed");
    }
    return data.data;
  }

  // --- Reverse WebSocket Server ---

  startReverseWs() {
    const port = this.options.reverseWsPort;
    if (!port) return;

    this.reverseWss = new WebSocketServer({ port });
    console.log(`[QQ] Reverse WebSocket server listening on port ${port}`);

    this.reverseWss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      // Verify access token if configured
      if (this.options.accessToken) {
        const auth = req.headers["authorization"];
        if (auth !== `Bearer ${this.options.accessToken}`) {
          console.warn("[QQ] Reverse WS: unauthorized connection rejected");
          ws.close(4001, "Unauthorized");
          return;
        }
      }

      console.log("[QQ] Reverse WS: NapCat connected");
      this.reverseWs = ws;

      ws.on("message", (data) => {
        try {
          const payload = JSON.parse(data.toString()) as OneBotEvent;
          if (payload.post_type === "meta_event" && payload.meta_event_type === "heartbeat") {
            return;
          }
          if (payload.post_type === "meta_event" && payload.meta_event_type === "lifecycle" && payload.self_id) {
            this.selfId = payload.self_id;
          }
          this.emit("message", payload);
        } catch (err) {
          // Ignore non-JSON
        }
      });

      ws.on("close", () => {
        console.log("[QQ] Reverse WS: NapCat disconnected");
        if (this.reverseWs === ws) this.reverseWs = null;
      });

      ws.on("error", (err) => {
        console.error("[QQ] Reverse WS error:", err);
      });
    });

    this.reverseWss.on("error", (err) => {
      console.error("[QQ] Reverse WS server error:", err);
    });
  }

  stopReverseWs() {
    if (this.reverseWs) {
      this.reverseWs.close();
      this.reverseWs = null;
    }
    if (this.reverseWss) {
      this.reverseWss.close();
      this.reverseWss = null;
      console.log("[QQ] Reverse WebSocket server stopped");
    }
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
        console.warn(`[QQ] HTTP API failed for ${action}, falling back to WS:`, err.message);
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
      const handler = (data: WebSocket.RawData) => {
        try {
          const resp = JSON.parse(data.toString());
          if (resp.echo === echo) {
            activeWs.off("message", handler);
            if (resp.status === "ok") {
              resolve(resp.data);
            } else {
              reject(new Error(resp.msg || "API request failed"));
            }
          }
        } catch (err) {
          // Ignore non-JSON messages
        }
      };

      activeWs.on("message", handler);
      activeWs.send(JSON.stringify({ action, params, echo }));

      // Timeout after 5 seconds
      setTimeout(() => {
        activeWs.off("message", handler);
        reject(new Error("Request timeout"));
      }, 5000);
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

  disconnect() {
    this.cleanup();
    this.stopReverseWs();
  }
}
