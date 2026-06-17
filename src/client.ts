import WebSocket, { WebSocketServer } from "ws";
import EventEmitter from "events";
import type { OneBotEvent, OneBotMessage } from "./types.js";
import type { IncomingMessage } from "http";
import {
  ConnectionError,
  TimeoutError,
  ClientApiError,
  ServerApiError,
  RateLimitError,
} from "./errors/napcat-error.js";
import { maskUrl } from "./utils/log-sanitize.js";
import { withRetry, isRetryableError } from "./utils/retry.js";
import { BAN_DEFAULT_MINUTES, MUTE_DEFAULT_MINUTES } from "./admin-commands.js";
import { HONOR_TYPE_ALL, GROUP_FILE_DEFAULT_COUNT, SENT_FINGERPRINT_CLEANUP_THRESHOLD } from "./constants.js";
import type { Logger } from "./types/channel-types.js";
import {
  WS_HEARTBEAT_INTERVAL_MS,
  WS_RESPONSE_TIMEOUT_MS,
  HTTP_RESPONSE_TIMEOUT_MS,
  HTTP_MAX_RETRIES,
  HTTP_RETRY_BASE_DELAY_MS,
} from "./constants.js";

interface OneBotClientOptions {
  wsUrl?: string;
  httpUrl?: string;
  reverseWsPort?: number;
  accessToken?: string;
  requireReverseWsToken?: boolean;
  log?: Logger;
}

/** 带 cause 链的 Error（ES2022 Error.cause 的兼容写法） */
interface CausableError extends Error {
  cause: Error;
}

export class OneBotClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: OneBotClientOptions;
  private selfId: number | null = null;
  private forwardAlive = false;
  private reverseAlive = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reverseWss: WebSocketServer | null = null;
  private reverseWs: WebSocket | null = null;
  /** 反向 WS 专用心跳定时器（独立于正向 WS 的 heartbeatTimer） */
  private reverseHeartbeatTimer: NodeJS.Timeout | null = null;
  /** 请求-响应关联：echo → { resolve, reject, timer } */
  private readonly pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    action: string;
  }>();
  /** echo ID 递增计数器，避免 Math.random() 碰撞风险 */
  private echoCounter = 0;
  private log: Logger;
  /** parseIncomingMessage 解析失败计数（用于监控 WS 数据质量） */
  private parseErrorCount = 0;
  /** outbound 发送幂等去重：同一 action+params 在 5s 内不重复发送 */
  private readonly sentFingerprints = new Map<string, number>();
  private static readonly SENT_DEDUP_WINDOW_MS = 5_000;

  constructor(options: OneBotClientOptions) {
    super();
    this.options = options;
    this.log = options.log ?? console;
  }

  getSelfId(): number | null {
    return this.selfId;
  }

  /** parseIncomingMessage 累计解析失败次数（用于监控） */
  getParseErrorCount(): number {
    return this.parseErrorCount;
  }

  setSelfId(id: number): void {
    this.selfId = id;
  }

  connect(): void {
    if (!this.options.wsUrl) return;
    this.cleanup();

    const headers: Record<string, string> = {};
    if (this.options.accessToken) {
      headers["Authorization"] = `Bearer ${this.options.accessToken}`;
    }

    // 移除无用的 try-catch（异常直接向上传播，框架负责重连）
    this.ws = new WebSocket(this.options.wsUrl, { headers });

    this.ws.on("open", () => {
      this.forwardAlive = true;
      this.emit("connect");
      this.log.log("[napcat-QQ] Connected to OneBot server");
      this.startHeartbeat();
    });

    this.ws.on("message", (data) => {
      this.forwardAlive = true;
      const payload = this.parseIncomingMessage(data);
      if (!payload) return;
      this.emit("message", payload);
    });

    // pong 帧直接重置存活标志，不依赖应用消息（安静群聊中无消息时避免误判假死）
    this.ws.on("pong", () => {
      this.forwardAlive = true;
    });

    this.ws.on("close", () => { this.handleDisconnect(); });

    this.ws.on("error", (err) => {
      this.log.error("[napcat-QQ] WebSocket error:", err);
      this.handleDisconnect();
    });
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // 先 reject 所有 pending requests，再 removeAllListeners
    for (const [, entry] of this.pendingRequests) {
      clearTimeout(entry.timer);
      entry.reject(new ConnectionError(entry.action, "Connection closed"));
    }
    this.pendingRequests.clear();
    this.sentFingerprints.clear();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
      } catch (err) {
        this.log.warn("[napcat-QQ] removeAllListeners error during cleanup:", err);
      }
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        try {
          this.ws.terminate();
        } catch (err) {
          this.log.warn("[napcat-QQ] WebSocket terminate error during cleanup:", err);
        }
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
      if (this.forwardAlive === false) {
        this.log.warn("[napcat-QQ] Heartbeat timeout, forcing reconnect...");
        this.handleDisconnect();
        return;
      }
      this.forwardAlive = false;
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
    }, WS_HEARTBEAT_INTERVAL_MS);
  }

  /**
   * 反向 WS 心跳检测：定期 ping 对端，若超时无响应则判定连接假死并主动断开。
   * 解决 TCP 半开（SIGKILL / 网络分区）时 "close" 事件不触发的问题。
   */
  private startReverseHeartbeat(ws: WebSocket) {
    this.stopReverseHeartbeat();
    this.reverseAlive = true;
    this.reverseHeartbeatTimer = setInterval(() => {
      if (this.reverseAlive === false) {
        this.log.warn("[napcat-QQ] Reverse WS heartbeat timeout, closing stale connection...");
        ws.terminate();
        this.reverseAlive = false;
        // terminate() 会触发 "close" 事件 → 走正常 disconnect 流程
        return;
      }
      this.reverseAlive = false;
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
    this.stopReverseHeartbeat();
    this.forwardAlive = false;
    this.reverseAlive = false;
    // 拒绝所有等待中的请求
    for (const [echo, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new ConnectionError(pending.action, "WebSocket disconnected"));
    }
    this.pendingRequests.clear();
    this.log.log("[napcat-QQ] Disconnected from OneBot server");
    this.emit("disconnect");
    // Reconnection is handled by OpenClaw's health-monitor via startAccount.
    // Do not self-reconnect here to avoid racing with the host framework.
  }

  async sendPrivateMsg(userId: number, message: OneBotMessage | string): Promise<void> {
    await this.sendAction("send_private_msg", { user_id: String(userId), message });
  }

  async sendGroupMsg(groupId: number, message: OneBotMessage | string): Promise<void> {
    await this.sendAction("send_group_msg", { group_id: String(groupId), message });
  }

  deleteMsg(messageId: number | string): void {
    this.sendWs("delete_msg", { message_id: String(messageId) });
  }

  setGroupAddRequest(flag: string, subType: string, approve: boolean = true, reason: string = ""): void {
    this.sendWs("set_group_add_request", { flag, sub_type: subType, approve, reason });
  }

  setFriendAddRequest(flag: string, approve: boolean = true, remark: string = ""): void {
    this.sendWs("set_friend_add_request", { flag, approve, remark });
  }

  async getLoginInfo(): Promise<any> {
    return this.sendWithResponse("get_login_info", {});
  }

  async getMsg(messageId: number | string): Promise<any> {
    return this.sendWithResponse("get_msg", { message_id: String(messageId) });
  }

  async getGroupMsgHistory(groupId: number, count?: number): Promise<Record<string, unknown>> {
    const params: Record<string, string | number> = { group_id: String(groupId) };
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
      const data = await this.sendWithResponse("get_group_info", { group_id: String(groupId) });
      // sendWithResponse 返回 unknown，显式窄化为 NapCat 响应结构
      if (data && typeof data === "object" && "group_id" in (data as Record<string, unknown>)) {
        return data as { group_id: number; group_name?: string };
      }
      return null;
    } catch (err) {
      this.log.warn("get_group_info failed:", err);
      return null;
    }
  }

  async sendGuildChannelMsg(guildId: string, channelId: string, message: OneBotMessage | string): Promise<void> {
    await this.sendAction("send_guild_channel_msg", { guild_id: guildId, channel_id: channelId, message });
  }

  async getGuildList(): Promise<any[]> {
    try { return await this.sendWithResponse("get_guild_list", {}); }
    catch (err) { this.log.warn("get_guild_list failed", err); return []; }
  }

  async getGuildServiceProfile(): Promise<any> {
    try { return await this.sendWithResponse("get_guild_service_profile", {}); }
    catch (err) { this.log.warn("get_guild_service_profile failed", err); return null; }
  }

  sendGroupPoke(groupId: number, userId: number): void {
    this.sendWs("group_poke", { group_id: String(groupId), user_id: String(userId) });
  }

  sendFriendPoke(userId: number): void {
    this.sendWs("friend_poke", { user_id: String(userId) });
  }

  async setMsgEmojiLike(messageId: number | string, emojiId: string): Promise<void> {
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

  /**
   * 获取群成员信息（含群名片 card）。
   * 用于识别新 bot 后拉取昵称/群名片，存到 known-bots-store。
   */
  async getGroupMemberInfo(
    groupId: number | string,
    userId: number | string,
    noCache = false,
  ): Promise<any> {
    return this.sendWithResponse("get_group_member_info", {
      group_id: String(groupId),
      user_id: String(userId),
      no_cache: noCache,
    });
  }

  /**
   * 获取陌生人信息（昵称、性别等）。
   * 当目标 bot 不在同一群时使用。
   */
  async getStrangerInfo(userId: number | string, noCache = false): Promise<any> {
    return this.sendWithResponse("get_stranger_info", {
      user_id: String(userId),
      no_cache: noCache,
    });
  }

  async getAiCharacters(): Promise<any> {
    return this.sendWithResponse("get_ai_characters", {});
  }

  async sendGroupAiRecord(groupId: number, text: string, voiceId: string): Promise<void> {
    await this.sendAction("send_group_ai_record", { group_id: String(groupId), text, character: voiceId });
  }

  async uploadGroupFile(groupId: number, file: string, name: string): Promise<void> {
    await this.sendAction("upload_group_file", { group_id: String(groupId), file, name });
  }

  async uploadPrivateFile(userId: number, file: string, name: string): Promise<void> {
    await this.sendAction("upload_private_file", { user_id: String(userId), file, name });
  }

  setGroupBan(groupId: number, userId: number, duration: number = BAN_DEFAULT_MINUTES * 60): void {
    this.sendWs("set_group_ban", { group_id: String(groupId), user_id: String(userId), duration });
  }

  setGroupKick(groupId: number, userId: number, rejectAddRequest: boolean = false): void {
    this.sendWs("set_group_kick", { group_id: String(groupId), user_id: String(userId), reject_add_request: rejectAddRequest });
  }

  // ============================================================
  // 群管理 API 全套（v1.10+）
  // 参考 NapCat 4.18.1 OpenAPI（NapCatDocs/src/api/4.18.1/openapi.json）
  // 命名规约：camelCase 严格对应 snake_case endpoint。
  // 走 WS 还是 HTTP：纯指令（set_*）默认 sendWs；返回数据（get_*）用 sendWithResponse；
  //                  双向（文件操作）用 sendAction（HTTP 优先，WS 回退）。
  // ============================================================

  // ── A. OneBot v11 原生群管 ──────────────────────────────

  /** 设置/取消群管理员（仅群主可用） */
  setGroupAdmin(groupId: number, userId: number, enable: boolean = true): void {
    this.sendWs("set_group_admin", { group_id: String(groupId), user_id: String(userId), enable });
  }

  /** 全员禁言开关 */
  setGroupWholeBan(groupId: number, enable: boolean = true): void {
    this.sendWs("set_group_whole_ban", { group_id: String(groupId), enable });
  }

  /** 设置群名片（card 空串 = 清除名片） */
  setGroupCard(groupId: number, userId: number, card: string = ""): void {
    this.sendWs("set_group_card", { group_id: String(groupId), user_id: String(userId), card });
  }

  /** 修改群名称 */
  setGroupName(groupId: number, name: string): void {
    this.sendWs("set_group_name", { group_id: String(groupId), group_name: name });
  }

  /** 设置专属头衔（仅群主可用） */
  setGroupSpecialTitle(groupId: number, userId: number, specialTitle: string): void {
    this.sendWs("set_group_special_title", {
      group_id: String(groupId),
      user_id: String(userId),
      special_title: specialTitle,
    });
  }

  /** 退群（isDismiss=true 且 bot 为群主时为解散） */
  setGroupLeave(groupId: number, isDismiss: boolean = false): void {
    this.sendWs("set_group_leave", { group_id: String(groupId), is_dismiss: isDismiss });
  }

  /** 批量踢人 */
  setGroupKickMembers(groupId: number, userIds: number[], rejectAddRequest: boolean = false): void {
    this.sendWs("set_group_kick_members", {
      group_id: String(groupId),
      user_id: userIds.map((id) => String(id)),
      reject_add_request: rejectAddRequest,
    });
  }

  /** 设为群精华消息 */
  async setEssenceMsg(messageId: number | string): Promise<void> {
    await this.sendAction("set_essence_msg", { message_id: String(messageId), force: true });
  }

  /** 移出群精华消息 */
  async deleteEssenceMsg(messageId: number | string): Promise<void> {
    await this.sendAction("delete_essence_msg", { message_id: String(messageId), force: true });
  }

  /** 获取群精华列表 */
  async getEssenceMsgList(groupId: number): Promise<any[]> {
    try { return await this.sendWithResponse("get_essence_msg_list", { group_id: String(groupId) }); }
    catch (err) { this.log.warn("get_essence_msg_list failed", err); return []; }
  }

  /** 获取当前禁言名单 */
  async getGroupShutList(groupId: number): Promise<any[]> {
    try { return await this.sendWithResponse("get_group_shut_list", { group_id: String(groupId) }); }
    catch (err) { this.log.warn("get_group_shut_list failed", err); return []; }
  }

  /** 获取 @全体 剩余次数 */
  async getGroupAtAllRemain(groupId: number): Promise<any> {
    try { return await this.sendWithResponse("get_group_at_all_remain", { group_id: String(groupId) }); }
    catch (err) { this.log.warn("get_group_at_all_remain failed", err); return null; }
  }

  /**
   * 获取群荣誉信息（龙王、群聊之火、群聊炽焰、新蛋、快乐源泉、和谐之声）
   * type ∈ all | talkative | performer | legend | strong_newbie | emotion
   */
  async getGroupHonorInfo(groupId: number, type: string = HONOR_TYPE_ALL): Promise<any> {
    try { return await this.sendWithResponse("get_group_honor_info", { group_id: String(groupId), type }); }
    catch (err) { this.log.warn("API call failed", err); return null; }
  }

  // ── B. 群文件全套 ───────────────────────────────────────

  /** 列群根目录文件 + 子文件夹 */
  async getGroupRootFiles(groupId: number, fileCount: number = GROUP_FILE_DEFAULT_COUNT): Promise<any> {
    try { return await this.sendWithResponse("get_group_root_files", { group_id: String(groupId), file_count: fileCount }); }
    catch (err) { this.log.warn("API call failed", err); return null; }
  }

  /** 列指定文件夹下的文件 + 子文件夹 */
  async getGroupFilesByFolder(groupId: number, folderId: string, fileCount: number = GROUP_FILE_DEFAULT_COUNT): Promise<any> {
    try {
      return await this.sendWithResponse("get_group_files_by_folder", {
        group_id: String(groupId),
        folder_id: folderId,
        file_count: fileCount,
      });
    } catch (err) { this.log.warn("API call failed", err); return null; }
  }

  /** 获取文件下载 URL */
  async getGroupFileUrl(groupId: number, fileId: string): Promise<any> {
    try { return await this.sendWithResponse("get_group_file_url", { group_id: String(groupId), file_id: fileId }); }
    catch (err) { this.log.warn("API call failed", err); return null; }
  }

  /** 获取群文件系统空间/状态 */
  async getGroupFileSystemInfo(groupId: number): Promise<any> {
    try { return await this.sendWithResponse("get_group_file_system_info", { group_id: String(groupId) }); }
    catch (err) { this.log.warn("API call failed", err); return null; }
  }

  /** 删除群文件 */
  async deleteGroupFile(groupId: number, fileId: string): Promise<void> {
    await this.sendAction("delete_group_file", { group_id: String(groupId), file_id: fileId, force: true });
  }

  /** 新建群子文件夹 */
  async createGroupFileFolder(groupId: number, folderName: string): Promise<void> {
    await this.sendAction("create_group_file_folder", { group_id: String(groupId), folder_name: folderName, force: true });
  }

  /** 删除群子文件夹 */
  async deleteGroupFolder(groupId: number, folderId: string): Promise<void> {
    await this.sendAction("delete_group_folder", { group_id: String(groupId), folder_id: folderId, force: true });
  }

  /** 移动群文件到指定文件夹 */
  async moveGroupFile(
    groupId: number,
    fileId: string,
    currentParentDirectory: string,
    targetParentDirectory: string,
  ): Promise<void> {
    await this.sendAction("move_group_file", {
      group_id: String(groupId),
      file_id: fileId,
      current_parent_directory: currentParentDirectory,
      target_parent_directory: targetParentDirectory,
      force: true,
    });
  }

  /** 重命名群文件 */
  async renameGroupFile(
    groupId: number,
    fileId: string,
    currentParentDirectory: string,
    newName: string,
  ): Promise<void> {
    await this.sendAction("rename_group_file", {
      group_id: String(groupId),
      file_id: fileId,
      current_parent_directory: currentParentDirectory,
      new_name: newName,
      force: true,
    });
  }

  // ── C. NapCat 扩展群管 ─────────────────────────────────

  /** 设置群头像（file 可为本地路径 / URL / base64） */
  async setGroupPortrait(groupId: number, file: string): Promise<void> {
    await this.sendAction("set_group_portrait", { group_id: String(groupId), file, force: true });
  }

  /** 设置群备注（备注仅自己可见） */
  async setGroupRemark(groupId: number, remark: string): Promise<void> {
    await this.sendAction("set_group_remark", { group_id: String(groupId), remark, force: true });
  }

  /** 群一键签到 */
  async setGroupSign(groupId: number): Promise<void> {
    await this.sendAction("set_group_sign", { group_id: String(groupId), force: true });
  }

  /** 设置群待办（消息标 todo） */
  async setGroupTodo(groupId: number, messageId: number | string): Promise<void> {
    await this.sendAction("set_group_todo", { group_id: String(groupId), message_id: String(messageId), force: true });
  }

  /** 完成群待办 */
  async completeGroupTodo(groupId: number, messageId: number | string): Promise<void> {
    await this.sendAction("complete_group_todo", { group_id: String(groupId), message_id: String(messageId), force: true });
  }

  /** 取消群待办 */
  async cancelGroupTodo(groupId: number, messageId: number | string): Promise<void> {
    await this.sendAction("cancel_group_todo", { group_id: String(groupId), message_id: String(messageId), force: true });
  }

  /** Try HTTP API first, fall back to WebSocket */
  async sendAction(action: string, params: Record<string, unknown>, opts?: { force?: boolean }): Promise<void> {
    // outbound 幂等去重：同一 action+params 在短窗口内不重复发送（force 可跳过）
    const fp = action + "\x00" + JSON.stringify(params);
    const now = Date.now();
    if (!opts?.force) {
      const prev = this.sentFingerprints.get(fp);
      if (prev && now - prev < OneBotClient.SENT_DEDUP_WINDOW_MS) {
        this.log.log(`[napcat-QQ][sendAction] deduped duplicate send: ${action}`);
        return;
      }
    }
    this.sentFingerprints.set(fp, now);
    // 惰性清理过期条目（每 1000 次写入清理一次，O(1) 摊还）
    if (this.sentFingerprints.size > SENT_FINGERPRINT_CLEANUP_THRESHOLD) {
      const cutoff = now - OneBotClient.SENT_DEDUP_WINDOW_MS;
      for (const [key, ts] of this.sentFingerprints) {
        if (ts < cutoff) this.sentFingerprints.delete(key);
      }
    }

    if (this.options.httpUrl) {
      try {
        this.log.log(`[napcat-QQ][sendAction] trying HTTP: ${maskUrl(this.options.httpUrl!.replace(/\/+$/, ""))}/${action}`);
        await this.sendViaHttp(action, params);
        this.log.log(`[napcat-QQ][sendAction] HTTP success: ${action}`);
        return;
      } catch (err) {
        this.log.warn(`[napcat-QQ][sendAction] HTTP failed for ${action}:`, err);
      }
    }
    const activeWs = this.getActiveWs();
    this.log.log(`[napcat-QQ][sendAction] trying WS: forwardWs=${this.ws?.readyState}, reverseWs=${this.reverseWs?.readyState}, active=${!!activeWs}`);
    try {
      this.sendWs(action, params);
    } catch (err) {
      this.log.error(`[napcat-QQ][sendAction] WS failed for ${action}:`, err);
      throw err;
    }
  }

  private async sendViaHttp(action: string, params: Record<string, unknown>): Promise<unknown> {
    return withRetry(async () => {
      // 去除尾部斜杠，避免 //action 双斜杠路径
      const baseUrl = this.options.httpUrl!.replace(/\/+$/, "");
      const url = `${baseUrl}/${action}`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.options.accessToken) {
        headers["Authorization"] = `Bearer ${this.options.accessToken}`;
      }
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(HTTP_RESPONSE_TIMEOUT_MS),
      });
      if (!resp.ok) {
        if (resp.status >= 500) throw new ServerApiError(resp.status, resp.statusText, action);
        throw new ClientApiError(resp.status, resp.statusText, action);
      }
      const data = await resp.json() as Record<string, unknown>;
      if (data.status !== "ok" && data.retcode !== 0) {
        const code = (data.retcode as number | undefined) ?? resp.status;
        const text = (data.msg as string | undefined) || (data.wording as string | undefined) || resp.statusText;
        if (code >= 500) throw new ServerApiError(code, text, action);
        throw new ClientApiError(code, text, action);
      }
      return data.data;
    }, {
      maxRetries: HTTP_MAX_RETRIES,
      baseDelayMs: HTTP_RETRY_BASE_DELAY_MS,
      shouldRetry: isRetryableError,
    });
  }

  // --- Reverse WebSocket Server ---

  startReverseWs(): void {
    const port = this.options.reverseWsPort;
    if (!port) return;
    // 幂等保护：已启动则不重复创建
    if (this.reverseWss) return;

    // 注：反向 WS Server 启动需要真实 TCP 端口绑定，不做端到端测试。
    //     原因：(1) 测试环境会冲突端口；(2) 实际部署由 NapCat 客户端连入；
    //     (3) 单元测试已覆盖正向上游连接和 sendWithResponseWs 的 echo 关联逻辑。
    this.reverseWss = new WebSocketServer({ port });
    this.log.log(`[napcat-QQ] Reverse WebSocket server listening on port ${port}`);

    this.reverseWss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      // 反向 WS 鉴权：requireReverseWsToken=true 时，必须配置 accessToken 否则拒绝
      if (this.options.requireReverseWsToken && !this.options.accessToken) {
        this.log.warn("[napcat-QQ] Reverse WS: connection rejected (no accessToken configured, requireReverseWsToken=true)");
        ws.close(4001, "Unauthorized: accessToken required but not configured");
        return;
      }
      // 配置了 accessToken 则验证 Bearer token
      if (this.options.accessToken) {
        const auth = req.headers["authorization"];
        if (auth !== `Bearer ${this.options.accessToken}`) {
          this.log.warn("[napcat-QQ] Reverse WS: unauthorized connection rejected");
          ws.close(4001, "Unauthorized");
          return;
        }
      }

      this.log.log("[napcat-QQ] Reverse WS: NapCat connected");

      // 关闭旧连接，防止双连接窗口期内事件被处理两次
      if (this.reverseWs) {
        this.reverseWs.removeAllListeners();
        this.reverseWs.close();
      }
      this.reverseWs = ws;

      // 先注册 listeners，消除 emit("connect") 触发后响应消息的竞态
      ws.on("message", (data) => {
        this.reverseAlive = true; // reverse WS 心跳存活标记
        const payload = this.parseIncomingMessage(data);
        if (!payload || !payload.post_type) return;
        if (payload.post_type === "meta_event" && payload.meta_event_type === "lifecycle" && payload.self_id) {
          this.selfId = payload.self_id;
        }
        this.emit("message", payload);
      });

      // pong 帧直接重置存活标志，不依赖应用消息
      ws.on("pong", () => {
        this.reverseAlive = true;
      });

      ws.on("close", () => {
        this.log.log("[napcat-QQ] Reverse WS: NapCat disconnected");
        if (this.reverseWs === ws) this.reverseWs = null;
        this.stopReverseHeartbeat();
        ws.removeAllListeners();
        this.emit("disconnect");
      });

      ws.on("error", (err) => {
        this.log.error("[napcat-QQ] Reverse WS error:", err);
      });

      // listeners 就绪后触发，使 channel.ts 的 connect handler 能正确更新状态
      this.startReverseHeartbeat(ws);
      this.emit("connect");
    });

    this.reverseWss.on("error", (err) => {
      this.log.error("[napcat-QQ] Reverse WS server error:", err);
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
          this.log.log("[napcat-QQ] Reverse WebSocket server stopped");
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

  /** 发送请求并等待响应（HTTP 优先，仅网络级错误回退 WS） */
  async sendWithResponse<T = unknown>(action: string, params: Record<string, unknown>): Promise<T> {
    // Prefer HTTP API for request-response calls if available
    if (this.options.httpUrl) {
      return this.sendViaHttp(action, params).catch((err) => {
        // API 级错误（ClientApiError/ServerApiError）说明请求已送达服务端，
        // WS 回退会导致非幂等操作双发，直接抛出。
        // 仅网络级错误（ConnectionError/TimeoutError）才回退 WS。
        const isNetworkError =
          err instanceof ConnectionError ||
          err instanceof TimeoutError ||
          (err instanceof Error &&
            /fetch failed|ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENETUNREACH/i.test(err.message));
        if (!isNetworkError) {
          throw err;
        }
        this.log.warn(`[napcat-QQ] HTTP network error for ${action}, falling back to WS:`, err);
        return this.sendWithResponseWs(action, params) as T;
      }) as Promise<T>;
    }
    return this.sendWithResponseWs(action, params) as Promise<T>;
  }

  private sendWithResponseWs(action: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const activeWs = this.getActiveWs();
      if (!activeWs) {
        reject(new ConnectionError(action, "WebSocket not open"));
        return;
      }

      const echo = `e${++this.echoCounter}`;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(echo);
        reject(new TimeoutError(action, "Request timeout"));
      }, WS_RESPONSE_TIMEOUT_MS);

      const closeHandler = () => {
        if (this.pendingRequests.has(echo)) {
          this.pendingRequests.delete(echo);
          clearTimeout(timer);
          reject(new ConnectionError(action, "WebSocket closed while waiting for response"));
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
        action,
      });

      try {
        activeWs.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        this.pendingRequests.delete(echo);
        activeWs.off("close", closeHandler);
        clearTimeout(timer);
        const cause = err instanceof Error ? err : new Error(String(err));
        const connectionErr = new ConnectionError(action, cause.message) as CausableError;
        connectionErr.cause = cause;
        reject(connectionErr);
      }
    });
  }

  private sendWs(action: string, params: Record<string, unknown>): void {
    const activeWs = this.getActiveWs();
    if (activeWs) {
      try {
        activeWs.send(JSON.stringify({ action, params }));
      } catch (err) {
        throw new ConnectionError(action, err instanceof Error ? err.message : String(err));
      }
    } else {
      throw new ConnectionError(action, "No WebSocket connection available");
    }
  }

  async disconnect(): Promise<void> {
    this.cleanup();
    await this.stopReverseWs();
  }

  private parseIncomingMessage(data: WebSocket.RawData): OneBotEvent | null {
    try {
      const payload = JSON.parse(data.toString());
      if (payload.echo && this.pendingRequests.has(payload.echo)) {
        const pending = this.pendingRequests.get(payload.echo)!;
        this.pendingRequests.delete(payload.echo);
        clearTimeout(pending.timer);
        if (payload.status === "ok") {
          pending.resolve(payload.data);
        } else {
          const code = payload.retcode ?? 0;
          const text = payload.msg || payload.wording || "API request failed";
          pending.reject(code >= 500 ? new ServerApiError(code, text, payload.action || "unknown") : new ClientApiError(code, text, payload.action || "unknown"));
        }
        return null;
      }
      if (payload.post_type === "meta_event" && payload.meta_event_type === "heartbeat") {
        return null;
      }
      return payload as OneBotEvent;
    } catch (err) {
      this.parseErrorCount++;
      this.log.warn("[napcat-QQ] parse error:", err);
      return null;
    }
  }
}
