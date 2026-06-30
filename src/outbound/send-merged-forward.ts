/**
 * 合并转发发送模块
 *
 * 将长文本构建为 OneBot 合并转发节点，通过 client.sendGroupForwardMsg 发送。
 * 失败时返回 false，由调用方（send-text.ts）降级为普通分片发送。
 */

import type { OneBotClient } from "../client.js";
import { splitMessage } from "../message-parser.js";

export interface SendMergedForwardParams {
  /** OneBot 客户端 */
  client: OneBotClient;
  /** 目标群 ID */
  groupId: string | number;
  /** 待发送文本列表 */
  texts: string[];
  /** 节点显示昵称 */
  nodeName: string;
  /** 节点 QQ 号 */
  nodeUin: string;
  /** 单节点最大字符数，0 = 不拆分 */
  nodeCharLimit: number;
}

/**
 * 发送合并转发消息。
 *
 * @returns 成功返回 true，失败返回 false（不抛异常）
 */
export async function sendMergedForward(params: SendMergedForwardParams): Promise<boolean> {
  const { client, groupId, texts, nodeName, nodeUin, nodeCharLimit } = params;

  // 过滤空文本
  const validTexts = texts.filter((t) => t.trim().length > 0);
  if (validTexts.length === 0) return false;

  // 构建转发节点
  const nodes = buildForwardNodes(validTexts, nodeName, nodeUin, nodeCharLimit);

  if (nodes.length === 0) return false;

  try {
    await client.sendGroupForwardMsg(groupId, nodes);
    return true;
  } catch (err) {
    // 不抛异常，由调用方降级为分片发送；记录 warn 日志用于排查
    client.log.warn(
      `[napcat-QQ][merged-forward] sendGroupForwardMsg failed, will fallback to chunks:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * 构建转发节点列表。
 *
 * - nodeCharLimit > 0：每条文本按 splitMessage 拆分后生成多节点
 * - nodeCharLimit = 0：所有文本拼为一个节点
 */
function buildForwardNodes(
  texts: string[],
  nodeName: string,
  nodeUin: string,
  nodeCharLimit: number,
): Array<{ name: string; uin: string; content: string }> {
  const shouldSplit = Number.isFinite(nodeCharLimit) && nodeCharLimit > 0;

  if (!shouldSplit) {
    // 不拆分：所有文本拼为一个节点
    return [{ name: nodeName, uin: nodeUin, content: texts.join("") }];
  }

  // 拆分：每条文本独立按 limit 切片
  const safeLimit = Math.max(200, Math.floor(nodeCharLimit));
  const chunks = texts.flatMap((t) => splitMessage(t, safeLimit));

  return chunks
    .filter((c) => c.trim().length > 0)
    .map((content) => ({ name: nodeName, uin: nodeUin, content }));
}
