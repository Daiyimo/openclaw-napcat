/**
 * 入站消息过滤阶段。
 *
 * 负责事件类型过滤、自身消息过滤、blocked/allowed 过滤、去重、
 * 自动已读、群成员缓存预热。
 */

import type { OneBotClient } from "../client.js";
import type { OneBotEvent } from "../types.js";
import type { InboundContext } from "../types/channel-types.js";
import { populateGroupMemberCache } from "../member-cache.js";
import { maskId } from "../utils/log-sanitize.js";
import { resolvePassiveModeTemperature } from "../config.js";

export interface FilterResult {
  event: OneBotEvent;
  userId: number | undefined;
  groupId: number | undefined;
  guildId: string | undefined;
  channelId: string | undefined;
  isGroup: boolean;
  isGuild: boolean;
  selfId: string;
}

export function filterStage(
  event: OneBotEvent,
  client: OneBotClient,
  ctx: InboundContext,
): FilterResult | null {
  const { config, knownGroupIds, inboundStore, log, metrics } = ctx;
  if (config.debug) {
    log.log(
      `[napcat-QQ][debug-filter] start, post_type=${event.post_type} user_id=${maskId(String(event.user_id))} self_id=${event.self_id}`,
    );
  }
  // 入站计数
  metrics?.increment("inbound", "total");
  const userId = event.user_id;
  const groupId = event.group_id;
  const guildId = event.guild_id != null ? String(event.guild_id) : undefined;
  const channelId = event.channel_id != null ? String(event.channel_id) : undefined;
  const isGroup = event.message_type === "group";
  const isGuild = event.message_type === "guild";

  if (groupId) knownGroupIds.add(String(groupId));

  if (event.post_type === "meta_event") {
    if (
      event.meta_event_type === "lifecycle" &&
      event.sub_type === "connect" &&
      event.self_id
    ) {
      client.setSelfId(event.self_id);
    }
    metrics?.increment("inbound", "filtered");
    return null;
  }

  if (event.post_type === "request" && config.autoApproveRequests) {
    if (event.request_type === "friend" && event.flag) {
      client.setFriendAddRequest(event.flag, true);
    } else if (event.request_type === "group" && event.flag && event.sub_type) {
      client.setGroupAddRequest(event.flag, event.sub_type, true);
    }
    return null;
  }

  if (
    event.post_type === "notice" &&
    event.notice_type === "notify" &&
    event.sub_type === "poke"
  ) {
    if (String(event.target_id) === String(client.getSelfId())) {
      const isGroupPoke = !!event.group_id;
      event.post_type = "message";
      event.message_type = isGroupPoke ? "group" : "private";
      event.raw_message = `[动作] 用户戳了你一下`;
      event.message = [{ type: "text", data: { text: event.raw_message } }];
      if (isGroupPoke) {
        client.sendGroupPoke(event.group_id!, event.user_id!);
      } else if (event.user_id) {
        client.sendFriendPoke(event.user_id);
      }
    } else {
      return null;
    }
  }

  if (event.post_type !== "message") {
    metrics?.increment("inbound", "filtered");
    return null;
  }

  const rawSelfId = client.getSelfId() ?? event.self_id;
  if (!rawSelfId) {
    log.warn(
      `[napcat-QQ] selfId not available yet, dropping message from user ${event.user_id}`,
    );
    metrics?.increment("inbound", "filtered");
    return null;
  }
  const selfId = String(rawSelfId);

  if (String(event.user_id) === String(selfId)) {
    if (config.debug) {
      log.log(
        `[napcat-QQ][debug-self-filter] dropping self message event.user_id=${maskId(String(event.user_id))} selfId=${selfId}`,
      );
    }
    metrics?.increment("inbound", "filtered");
    return null;
  }

  if (config.blockedUsers?.includes(userId!)) {
    metrics?.increment("inbound", "filtered");
    return null;
  }
  if (isGroup && config.allowedGroups?.length && !config.allowedGroups.includes(groupId!)) {
    metrics?.increment("inbound", "filtered");
    return null;
  }

  if (config.enableDeduplication !== false && event.message_id) {
    const msgIdKey = String(event.message_id);
    if (inboundStore.processedMsgIds.has(msgIdKey)) {
      metrics?.increment("inbound", "filtered");
      return null;
    }
    inboundStore.processedMsgIds.add(msgIdKey);
  }

  if (config.autoMarkRead) {
    if (isGroup && groupId) {
      client.markGroupMsgAsRead(groupId).catch((err) => {
        ctx.log.warn("[napcat-QQ] markGroupMsgAsRead failed:", err);
      });
    } else if (!isGuild && userId) {
      client.markPrivateMsgAsRead(userId).catch((err) => {
        ctx.log.warn("[napcat-QQ] markPrivateMsgAsRead failed:", err);
      });
    }
  }

  if (isGroup && groupId) {
    void populateGroupMemberCache(client, groupId);
  }

  return {
    event,
    userId,
    groupId,
    guildId,
    channelId,
    isGroup,
    isGuild,
    selfId,
  };
}
