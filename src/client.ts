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
      await this.sendAction("set_msg_emoji_like", { message_id: Number(messageId), emoji_id: emojiId });
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

  // --- NapCat 4.17.25 新增 API ---

  // 通用消息发送
  async sendMsg(message: OneBotMessage | string, options?: { group_id?: number, user_id?: number, guild_id?: number, channel_id?: number }) {
      const params: any = { message };
      if (options?.group_id) params.group_id = options.group_id;
      if (options?.user_id) params.user_id = options.user_id;
      if (options?.guild_id) params.guild_id = options.guild_id;
      if (options?.channel_id) params.channel_id = options.channel_id;
      await this.sendAction("send_msg", params);
  }

  // 获取群详细信息 (扩展)
  async getGroupInfoEx(groupId: number): Promise<any> {
      return this.sendWithResponse("get_group_info_ex", { group_id: groupId });
  }

  // 批量踢出群成员
  async setGroupKickBatch(groupId: number, userIds: number[], rejectAddRequest: boolean = false) {
      await this.sendAction("set_group_kick_batch", { group_id: groupId, user_id: userIds, reject_add_request: rejectAddRequest });
  }

  // 设置群加群选项
  async setGroupAddOption(groupId: number, type: "allow" | "need_verify" | "disable") {
      await this.sendAction("set_group_add_option", { group_id: groupId, type });
  }

  // 设置群机器人加群选项
  async setGroupBotAddOption(groupId: number, enable: boolean) {
      await this.sendAction("set_group_bot_add_option", { group_id: groupId, enable });
  }

  // 获取表情点赞详情
  async getMsgEmojiLikeInfo(messageId: number | string): Promise<any> {
      return this.sendWithResponse("get_msg_emoji_like_info", { message_id: messageId });
  }

  // 获取消息表情点赞列表
  async getMsgEmojiLikeUsers(messageId: number | string, emojiId: string): Promise<any> {
      return this.sendWithResponse("get_msg_emoji_like_users", { message_id: messageId, emoji_id: emojiId });
  }

  // 获取群精华消息列表
  async getGroupEssenceMsgList(groupId: number): Promise<any[]> {
      return this.sendWithResponse("get_essence_msg_list", { group_id: groupId });
  }

  // 设置精华消息
  async setEssenceMsg(messageId: number | string) {
      await this.sendAction("set_essence_msg", { message_id: messageId });
  }

  // 移出精华消息
  async deleteEssenceMsg(messageId: number | string) {
      await this.sendAction("delete_essence_msg", { message_id: messageId });
  }

  // 获取群荣誉信息
  async getGroupHonorInfo(groupId: number, type: "talkative" | "performer" | "legend" | "strong_newbie" | "emotion" | "all" = "all"): Promise<any> {
      return this.sendWithResponse("get_group_honor_info", { group_id: groupId, type });
  }

  // 发送群公告
  async sendGroupNotice(groupId: number, message: string, image?: string) {
      await this.sendAction("send_group_notice", { group_id: groupId, message, image });
  }

  // 获取群公告
  async getGroupNotice(groupId: number): Promise<any[]> {
      return this.sendWithResponse("get_group_notice", { group_id: groupId });
  }

  // 删除群公告
  async deleteGroupNotice(groupId: number, messageId: string) {
      await this.sendAction("delete_group_notice", { group_id: groupId, message_id: messageId });
  }

  // 获取群艾特全体剩余次数
  async getGroupAtAllRemain(groupId: number): Promise<any> {
      return this.sendWithResponse("get_group_at_all_remain", { group_id: groupId });
  }

  // 获取群禁言列表
  async getGroupBanList(groupId: number): Promise<any[]> {
      return this.sendWithResponse("get_group_ban_list", { group_id: groupId });
  }

  // 设置群管理员
  async setGroupAdmin(groupId: number, userId: number, enable: boolean = true) {
      await this.sendAction("set_group_admin", { group_id: groupId, user_id: userId, enable });
  }

  // 设置群名片
  async setGroupCard(groupId: number, userId: number, card: string) {
      await this.sendAction("set_group_card", { group_id: groupId, user_id: userId, card });
  }

  // 设置群名称
  async setGroupName(groupId: number, name: string) {
      await this.sendAction("set_group_name", { group_id: groupId, name });
  }

  // 设置群头像
  async setGroupAvatar(groupId: number, file: string) {
      await this.sendAction("set_group_avatar", { group_id: groupId, file });
  }

  // 设置群备注
  async setGroupRemark(groupId: number, remark: string) {
      await this.sendAction("set_group_remark", { group_id: groupId, remark });
  }

  // 设置专属头衔
  async setGroupSpecialTitle(groupId: number, userId: number, title: string, duration: number = -1) {
      await this.sendAction("set_group_special_title", { group_id: groupId, user_id: userId, title, duration });
  }

  // 群打卡
  async sendGroupSignIn(groupId: number) {
      await this.sendAction("send_group_sign_in", { group_id: groupId });
  }

  // 点赞
  async sendLike(userId: number, times: number = 1) {
      await this.sendAction("send_like", { user_id: userId, times });
  }

  // 获取陌生人信息
  async getStrangerInfo(userId: number, noCache: boolean = false): Promise<any> {
      return this.sendWithResponse("get_stranger_info", { user_id: userId, no_cache: noCache });
  }

  // 设置好友备注
  async setFriendRemark(userId: number, remark: string) {
      await this.sendAction("set_friend_remark", { user_id: userId, remark });
  }

  // 设置个性签名
  async setCurSignature(sign: string) {
      await this.sendAction("set_cur_signature", { sign });
  }

  // 设置头像
  async setAvatar(file: string) {
      await this.sendAction("set_avatar", { file });
  }

  // 设置在线状态
  async setCurStatus(status: { online?: boolean, battery?: number, charging?: boolean }) {
      await this.sendAction("set_cur_status", status);
  }

  // 获取在线客户端
  async getOnlineClients(): Promise<any[]> {
      return this.sendWithResponse("get_online_clients", {});
  }

  // 获取私聊文件URL
  async getPrivateFileUrl(userId: number, fileId: string, busid: number): Promise<any> {
      return this.sendWithResponse("get_private_file_url", { user_id: userId, file_id: fileId, busid });
  }

  // 获取文件信息
  async getFile(file: string, name?: string): Promise<any> {
      const params: any = { file };
      if (name) params.name = name;
      return this.sendWithResponse("get_file", params);
  }

  // 图片 OCR 识别
  async ocrImage(image: string): Promise<any> {
      return this.sendWithResponse("ocr_image", { image });
  }

  // 检查URL安全性
  async checkUrlSafely(url: string): Promise<any> {
      return this.sendWithResponse("check_url_safely", { url });
  }

  // 清理缓存
  async cleanCache(): Promise<any> {
      return this.sendWithResponse("clean_cache", {});
  }

  // 获取群系统消息
  async getGroupSystemMsg(groupId: number): Promise<any> {
      return this.sendWithResponse("get_group_system_msg", { group_id: groupId });
  }

  // 获取群被忽略的加群请求
  async getGroupIgnoreAddRequest(groupId: number): Promise<any> {
      return this.sendWithResponse("get_group_ignore_add_request", { group_id: groupId });
  }

  // 获取资料点赞
  async getUserProfileLike(userId: number): Promise<any> {
      return this.sendWithResponse("get_user_profile_like", { user_id: userId });
  }

  // 获取机型显示
  async getModelShow(model: string): Promise<any> {
      return this.sendWithResponse("get_model_show", { model });
  }

  // 设置机型
  async setModelShow(model: string, show: string) {
      await this.sendAction("set_model_show", { model, show });
  }

  // 设置输入状态
  async setInputStatus(type: "friend" | "group", id: number, status: boolean) {
      await this.sendAction("set_input_status", { type, id, status });
  }

  // 通用戳一戳 (group_id 存在则群聊戳，否则私聊戳)
  async sendPoke(userId: number, groupId?: number) {
      const params: any = { user_id: userId };
      if (groupId) params.group_id = groupId;
      await this.sendAction("send_poke", params);
  }

  // 群签到 (set_group_sign)
  async setGroupSign(groupId: number) {
      await this.sendAction("set_group_sign", { group_id: String(groupId) });
  }

  // 设置群聊已读 (set_group_msg_as_read)
  async setGroupMsgAsRead(groupId: number) {
      await this.sendAction("set_group_msg_as_read", { group_id: groupId });
  }

  // 获取推荐群聊卡片
  async getArkShareGroup(groupId: number): Promise<any> {
      return this.sendWithResponse("ArkShareGroup", { group_id: String(groupId) });
  }

  // 获取推荐好友/群聊卡片
  async getArkSharePeer(options: { user_id?: string; group_id?: string; phoneNumber?: string }): Promise<any> {
      return this.sendWithResponse("ArkSharePeer", options);
  }

  // 转发单条消息到群聊
  async forwardGroupSingleMsg(messageId: number, groupId: number) {
      await this.sendAction("forward_group_single_msg", { message_id: messageId, group_id: groupId });
  }

  // 转发单条消息到好友
  async forwardFriendSingleMsg(messageId: number, userId: number) {
      await this.sendAction("forward_friend_single_msg", { message_id: messageId, user_id: userId });
  }

  // 设置在线状态 (NapCat扩展)
  async setOnlineStatus(status: number, extStatus: number, batteryStatus: number = 0) {
      await this.sendAction("set_online_status", { status, ext_status: extStatus, battery_status: batteryStatus });
  }

  // 获取分类好友列表
  async getFriendsWithCategory(): Promise<any[]> {
      return this.sendWithResponse("get_friends_with_category", {});
  }

  // 设置QQ头像
  async setQQAvatar(file: string) {
      await this.sendAction("set_qq_avatar", { file });
  }

  // 发送合并转发
  async sendForwardMsg(options: { message_type: string; user_id?: number; group_id?: number; messages: any[] }): Promise<any> {
      return this.sendWithResponse("send_forward_msg", options);
  }

  // 获取自身点赞列表
  async getProfileLike(): Promise<any> {
      return this.sendWithResponse("get_profile_like", {});
  }

  // AI文字转语音
  async getAiRecord(character: string, groupId: number, text: string): Promise<any> {
      return this.sendWithResponse("get_ai_record", { character, group_id: groupId, text });
  }

  // 获取AI语音角色列表 (带 group_id)
  async getAiCharactersList(groupId: number): Promise<any> {
      return this.sendWithResponse("get_ai_characters", { group_id: groupId });
  }

  // 获取最近联系人
  async getRecentContact(count: number = 10): Promise<any[]> {
      return this.sendWithResponse("get_recent_contact", { count });
  }

  // 获取私聊历史记录
  async getFriendMsgHistory(userId: string, messageSeq: string = "0", count: number = 20, reverseOrder: boolean = false): Promise<any> {
      return this.sendWithResponse("get_friend_msg_history", { user_id: userId, message_seq: messageSeq, count, reverseOrder });
  }

  // 英译中
  async translateEn2Zh(words: string[]): Promise<string[]> {
      return this.sendWithResponse("translate_en2zh", { words });
  }

  // 设置表情回复
  async setMsgEmojiLikeWithSet(messageId: number | string, emojiId: string, set: boolean = true) {
      await this.sendAction("set_msg_emoji_like", { message_id: Number(messageId), emoji_id: emojiId, set });
  }

  // 获取自定义表情
  async fetchCustomFace(count: number = 48): Promise<string[]> {
      return this.sendWithResponse("fetch_custom_face", { count });
  }

  // 获取机器人账号范围
  async getRobotUinRange(): Promise<any[]> {
      return this.sendWithResponse("get_robot_uin_range", {});
  }

  // 获取群成员信息
  async getGroupMemberInfo(groupId: number, userId: number, noCache: boolean = false): Promise<any> {
      return this.sendWithResponse("get_group_member_info", { group_id: groupId, user_id: userId, no_cache: noCache });
  }

  // 全员禁言
  async setGroupWholeBan(groupId: number, enable: boolean = true) {
      await this.sendAction("set_group_whole_ban", { group_id: groupId, enable });
  }

  // 退出群聊
  async setGroupLeave(groupId: number, isDismiss: boolean = false) {
      await this.sendAction("set_group_leave", { group_id: groupId, is_dismiss: isDismiss });
  }

  // 群匿名禁言
  async setGroupAnonymousBan(groupId: number, anonymous: any, duration: number = 1800) {
      await this.sendAction("set_group_anonymous_ban", { group_id: groupId, anonymous, duration });
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
