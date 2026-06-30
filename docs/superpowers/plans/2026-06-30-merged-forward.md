# 合并转发功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移植 openclaw_qq 的长回复合并转发能力到 napcat，群消息超过 2000 字符时自动走合并转发，失败回退普通分片。

**Architecture:** 在 send-text.ts 的分片发送前插入合并转发前置检查。新增 `send-merged-forward.ts` 模块封装节点构建与双 action 兜底逻辑，新增 `client.sendGroupForwardMsg` 方法。三层降级：send_group_forward_msg → send_forward_msg → 普通分片。

**Tech Stack:** TypeScript 5.9 ESM, Zod v4, Vitest, ws

## Global Constraints

- 遵循现有 Zod schema 模式（`.optional().default()` + JSDoc `@describe`）
- 遵循现有错误处理模式（`getLog(log).warn/error` + 不静默吞异常）
- 遵循现有测试模式（`vi.mock("ws")` + `vi.spyOn`）
- 类型注解强制（铁律 3.1）— 所有函数参数和返回值必须有类型
- 文档注释强制（铁律 3.2）— 公共函数必须有 Google 风格 JSDoc
- 新功能必须附带测试（铁律 5.1）
- 提交格式：`feat(qq): subject` + Co-authored-by

---

### Task 1: 配置项 — 新增合并转发三个配置

**Files:**
- Modify: `src/config.ts:125`（sleepMode schema 之后）
- Test: `src/__tests__/config.test.ts`

**Interfaces:**
- Produces: `QQConfig.forwardThreshold: number` (default 2000)
- Produces: `QQConfig.forwardNodeName: string` (default "OpenClaw")
- Produces: `QQConfig.forwardNodeCharLimit: number` (default 0)

- [ ] **Step 1: 在 config.ts 末尾（sleepMode 之后、Schema 闭合前）添加三个配置项**

在 `src/config.ts` 第 125 行（`sleepMode` schema 闭合 `});` 与 `// ── 休眠模式` 注释之间）插入：

```typescript
  // ── 合并转发（v1.11+） ─────────────────────────────────────
  /** 群消息长回复自动转为合并转发的字符数阈值。默认 2000；设为 0 禁用 */
  forwardThreshold: z.number().int().min(0).max(50000).optional().default(2000).describe("Group reply character threshold to trigger merged-forward delivery. Default 2000; set 0 to disable."),
  /** 合并转发节点显示昵称。默认 "OpenClaw" */
  forwardNodeName: z.string().min(1).max(64).optional().default("OpenClaw").describe("Display name for forwarded message nodes. Default 'OpenClaw'."),
  /** 合并转发单节点最大字符数。默认 0 = 不拆分节点（整段合成一个节点） */
  forwardNodeCharLimit: z.number().int().min(0).max(50000).optional().default(0).describe("Max chars per forward node. 0 = no split (entire text as one node). Default 0."),
```

- [ ] **Step 2: 验证 Schema 类型正确**

Run: `cd E:/project/openclaw-napcat && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 3: 提交**

```bash
git add src/config.ts
git commit -m "feat(qq): add forward threshold/node config for merged-forward

新增 forwardThreshold/forwardNodeName/forwardNodeCharLimit 三个配置项，
控制群消息长回复自动走合并转发的行为。

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

### Task 2: client.ts — 新增 sendGroupForwardMsg 方法

**Files:**
- Modify: `src/client.ts:249`（getForwardMsg 方法之后）
- Modify: `src/types.ts:24`（OneBotMessageSegment union 末尾）
- Test: `src/__tests__/client.test.ts`

**Interfaces:**
- Consumes: `sendWithResponse` (private method, line 767)
- Produces: `OneBotClient.sendGroupForwardMsg(groupId, messages, timeoutMs?)`
- Produces: `ForwardMessageNode` interface (exported from types.ts)

- [ ] **Step 1: 在 types.ts 添加 ForwardMessageNode 类型**

在 `src/types.ts` 末尾（`export type OneBotMessage` 之后）添加：

```typescript
/** 合并转发消息节点 */
export interface ForwardMessageNode {
  /** 节点显示昵称 */
  name: string;
  /** 节点 QQ 号 */
  uin: string;
  /** 节点文本内容 */
  content: string;
}
```

- [ ] **Step 2: 在 client.ts 添加 sendGroupForwardMsg 方法**

在 `src/client.ts` 的 `getForwardMsg` 方法之后（约第 249 行）添加：

```typescript
  /**
   * 发送合并转发消息（群）。
   *
   * 双 action 兜底：优先 send_group_forward_msg（NapCat 原生群转发），
   * 失败回退 send_forward_msg（通用转发）。
   *
   * @param groupId - 目标群 ID
   * @param messages - 转发节点列表
   * @param timeoutMs - 超时毫秒，默认 15000（合并转发消息体较大）
   * @throws ClientApiError | ServerApiError | TimeoutError | ConnectionError
   */
  async sendGroupForwardMsg(
    groupId: string | number,
    messages: ForwardMessageNode[],
    timeoutMs: number = 15_000,
  ): Promise<unknown> {
    const forwardMessages = messages.map((node) => ({
      type: "node" as const,
      data: {
        name: node.name,
        uin: node.uin,
        content: node.content,
      },
    }));

    const actions = [
      { action: "send_group_forward_msg" as const, params: { group_id: String(groupId), messages: forwardMessages } },
      { action: "send_forward_msg" as const, params: { group_id: String(groupId), messages: forwardMessages } },
    ];

    let lastError: Error | null = null;
    for (const { action, params } of actions) {
      try {
        this.log.log(`[napcat-QQ] attempting ${action} (nodes=${messages.length})`);
        const result = await this.sendWithResponse(action, params);
        this.log.log(`[napcat-QQ] ${action} success (nodes=${messages.length})`);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.log.warn(`[napcat-QQ] ${action} failed: ${lastError.message}`);
      }
    }

    throw lastError ?? new Error("All forward actions failed");
  }
```

- [ ] **Step 3: 在 client.ts 顶部添加 import**

在 `src/client.ts` 第 3 行 import 中添加 `ForwardMessageNode`：

```typescript
import type { OneBotEvent, OneBotMessage, ForwardMessageNode } from "./types.js";
```

- [ ] **Step 4: 添加测试**

在 `src/__tests__/client.test.ts` 中添加 describe block：

```typescript
  describe("sendGroupForwardMsg", () => {
    const nodes = [
      { name: "Bot", uin: "12345", content: "part1" },
      { name: "Bot", uin: "12345", content: "part2" },
    ];

    it("calls send_group_forward_msg with correct structure", async () => {
      const sendWithResponseSpy = vi.spyOn(client, "sendWithResponse").mockResolvedValue({ message_id: 1 });
      await client.sendGroupForwardMsg(67890, nodes);
      expect(sendWithResponseSpy).toHaveBeenCalledWith(
        "send_group_forward_msg",
        expect.objectContaining({
          group_id: "67890",
          messages: [
            { type: "node", data: { name: "Bot", uin: "12345", content: "part1" } },
            { type: "node", data: { name: "Bot", uin: "12345", content: "part2" } },
          ],
        }),
      );
    });

    it("falls back to send_forward_msg when send_group_forward_msg fails", async () => {
      const sendWithResponseSpy = vi.spyOn(client, "sendWithResponse")
        .mockRejectedValueOnce(new Error("API not supported"))
        .mockResolvedValueOnce({ message_id: 2 });
      await client.sendGroupForwardMsg(67890, nodes);
      expect(sendWithResponseSpy).toHaveBeenCalledTimes(2);
      expect(sendWithResponseSpy).toHaveBeenNthCalledWith(1, "send_group_forward_msg", expect.any(Object));
      expect(sendWithResponseSpy).toHaveBeenNthCalledWith(2, "send_forward_msg", expect.any(Object));
    });

    it("throws last error when both actions fail", async () => {
      const sendWithResponseSpy = vi.spyOn(client, "sendWithResponse")
        .mockRejectedValue(new Error("Both failed"));
      await expect(client.sendGroupForwardMsg(67890, nodes)).rejects.toThrow("Both failed");
      expect(sendWithResponseSpy).toHaveBeenCalledTimes(2);
    });
  });
```

- [ ] **Step 5: 运行测试**

Run: `cd E:/project/openclaw-napcat && npx vitest run src/__tests__/client.test.ts`
Expected: 全部通过

- [ ] **Step 6: 提交**

```bash
git add src/types.ts src/client.ts src/__tests__/client.test.ts
git commit -m "feat(qq): add sendGroupForwardMsg with dual-action fallback

新增合并转发发送方法，双 action 兜底：
send_group_forward_msg → send_forward_msg。
两个都失败时抛出最后一个错误。

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

### Task 3: send-merged-forward.ts — 核心合并转发模块

**Files:**
- Create: `src/outbound/send-merged-forward.ts`
- Create: `src/__tests__/send-merged-forward.test.ts`

**Interfaces:**
- Consumes: `OneBotClient.sendGroupForwardMsg`
- Consumes: `splitMessage` from message-parser.ts
- Produces: `sendMergedForward(params: SendMergedForwardParams): Promise<boolean>`

- [ ] **Step 1: 写失败测试**

创建 `src/__tests__/send-merged-forward.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OneBotClient } from "../client.js";
import type { QQConfig } from "../config.js";
import type { Logger } from "../types/channel-types.js";
import { sendMergedForward } from "../outbound/send-merged-forward.js";

function makeMockClient(sendGroupForwardMsgImpl: (...args: any[]) => Promise<unknown>): OneBotClient {
  return {
    sendGroupForwardMsg: vi.fn(sendGroupForwardMsgImpl),
  } as unknown as OneBotClient;
}

describe("sendMergedForward", () => {
  const baseNodeName = "OpenClaw";
  const baseNodeUin = "12345";

  it("returns false for empty texts after trimming", async () => {
    const client = makeMockClient(vi.fn().mockResolvedValue({}));
    const result = await sendMergedForward({
      client, groupId: 67890, texts: ["", "  ", ""],
      nodeName: baseNodeName, nodeUin: baseNodeUin, nodeCharLimit: 0,
    });
    expect(result).toBe(false);
  });

  it("builds single node when nodeCharLimit=0", async () => {
    const spy = vi.fn().mockResolvedValue({ message_id: 1 });
    const client = makeMockClient(spy);
    const result = await sendMergedForward({
      client, groupId: 67890, texts: ["hello world"],
      nodeName: baseNodeName, nodeUin: baseNodeUin, nodeCharLimit: 0,
    });
    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledWith(67890, [{ name: baseNodeName, uin: baseNodeUin, content: "hello world" }]);
  });

  it("builds multiple nodes when nodeCharLimit > 0 and text exceeds limit", async () => {
    const spy = vi.fn().mockResolvedValue({ message_id: 1 });
    const client = makeMockClient(spy);
    const longText = "a".repeat(3000);
    const result = await sendMergedForward({
      client, groupId: 67890, texts: [longText],
      nodeName: baseNodeName, nodeUin: baseNodeUin, nodeCharLimit: 1000,
    });
    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const callArgs = spy.mock.calls[0][1] as Array<{ content: string }>;
    expect(callArgs.length).toBeGreaterThan(1);
    callArgs.forEach((node) => {
      expect(node.content.length).toBeLessThanOrEqual(1000 + 100); // splitMessage may slightly exceed at boundaries
    });
  });

  it("returns false when sendGroupForwardMsg throws", async () => {
    const client = makeMockClient(vi.fn().mockRejectedValue(new Error("API error")));
    const result = await sendMergedForward({
      client, groupId: 67890, texts: ["hello"],
      nodeName: baseNodeName, nodeUin: baseNodeUin, nodeCharLimit: 0,
    });
    expect(result).toBe(false);
  });

  it("merges multiple texts into one node when nodeCharLimit=0", async () => {
    const spy = vi.fn().mockResolvedValue({ message_id: 1 });
    const client = makeMockClient(spy);
    const result = await sendMergedForward({
      client, groupId: 67890, texts: ["part1", "part2", "part3"],
      nodeName: baseNodeName, nodeUin: baseNodeUin, nodeCharLimit: 0,
    });
    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledWith(67890, [{ name: baseNodeName, uin: baseNodeUin, content: "part1part2part3" }]);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd E:/project/openclaw-napcat && npx vitest run src/__tests__/send-merged-forward.test.ts`
Expected: FAIL — "Cannot find module '../outbound/send-merged-forward.js'"

- [ ] **Step 3: 实现 send-merged-forward.ts**

创建 `src/outbound/send-merged-forward.ts`：

```typescript
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
  } catch {
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
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd E:/project/openclaw-napcat && npx vitest run src/__tests__/send-merged-forward.test.ts`
Expected: 全部 5 个测试通过

- [ ] **Step 5: 提交**

```bash
git add src/outbound/send-merged-forward.ts src/__tests__/send-merged-forward.test.ts
git commit -m "feat(qq): add sendMergedForward module

核心合并转发逻辑：节点构建（支持拆分/不拆分）+
双 action 兜底发送。失败返回 false 由调用方降级。

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

### Task 4: send-text.ts — 插入合并转发前置检查

**Files:**
- Modify: `src/outbound/send-text.ts:162-182`（try 块内，分片循环之前）
- Test: `src/__tests__/send-text-forward.test.ts`（新建）

**Interfaces:**
- Consumes: `sendMergedForward` from send-merged-forward.ts
- Consumes: `QQConfig.forwardThreshold`, `forwardNodeName`, `forwardNodeCharLimit`

- [ ] **Step 1: 写失败测试**

创建 `src/__tests__/send-text-forward.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OneBotClient } from "../client.js";
import type { QQConfig } from "../config.js";
import type { PassiveModeManager } from "../passive-mode.js";
import type { Logger } from "../types/channel-types.js";
import { sendText, type SendTextDeps } from "../outbound/send-text.js";

function makeDeps(overrides: Partial<SendTextDeps> = {}): SendTextDeps {
  return {
    getClient: vi.fn(),
    knownGroupIds: new Set<string>(),
    passiveMode: { markDone: vi.fn(), markSilent: vi.fn() } as unknown as PassiveModeManager,
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    ...overrides,
  };
}

function makeClient(overrides: Record<string, any> = {}): OneBotClient {
  return {
    getSelfId: () => 12345,
    getGroupInfo: vi.fn().mockResolvedValue({ group_id: 67890 }),
    sendGroupForwardMsg: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendGroupMsg: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as OneBotClient;
}

describe("sendText merged-forward", () => {
  const baseConfig: QQConfig = {
    forwardThreshold: 2000,
    forwardNodeName: "OpenClaw",
    forwardNodeCharLimit: 0,
    maxMessageLength: 4000,
  } as QQConfig;

  it("triggers merged forward when text exceeds threshold in group", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: vi.fn().mockReturnValue(client) });
    const longText = "a".repeat(2001);

    const result = await sendText(
      { to: "group:67890", text: longText, cfg: baseConfig, botSelfId: 12345 },
      deps,
    );

    expect(result.sent).toBe(true);
    expect(client.sendGroupForwardMsg).toHaveBeenCalledWith(
      "67890",
      expect.arrayContaining([expect.objectContaining({ name: "OpenClaw" })]),
    );
  });

  it("does NOT trigger merged forward for private messages", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: vi.fn().mockReturnValue(client) });
    const longText = "a".repeat(2001);

    const result = await sendText(
      { to: "private:99999", text: longText, cfg: baseConfig, botSelfId: 12345 },
      deps,
    );

    expect(result.sent).toBe(true);
    expect(client.sendGroupForwardMsg).not.toHaveBeenCalled();
  });

  it("does NOT trigger merged forward when threshold is 0", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: vi.fn().mockReturnValue(client) });
    const cfg = { ...baseConfig, forwardThreshold: 0 };

    const result = await sendText(
      { to: "group:67890", text: "a".repeat(3000), cfg, botSelfId: 12345 },
      deps,
    );

    expect(result.sent).toBe(true);
    expect(client.sendGroupForwardMsg).not.toHaveBeenCalled();
  });

  it("falls back to plain chunks when merged forward fails", async () => {
    const client = makeClient({
      sendGroupForwardMsg: vi.fn().mockRejectedValue(new Error("API error")),
    });
    const deps = makeDeps({ getClient: vi.fn().mockReturnValue(client) });
    const longText = "a".repeat(2001);

    const result = await sendText(
      { to: "group:67890", text: longText, cfg: baseConfig, botSelfId: 12345 },
      deps,
    );

    expect(result.sent).toBe(true);
    expect(client.sendGroupForwardMsg).toHaveBeenCalled();
    // 降级到 sendGroupMsg 分片
    expect(client.sendGroupMsg).toHaveBeenCalled();
  });

  it("does NOT trigger when text is below threshold", async () => {
    const client = makeClient();
    const deps = makeDeps({ getClient: vi.fn().mockReturnValue(client) });

    const result = await sendText(
      { to: "group:67890", text: "short message", cfg: baseConfig, botSelfId: 12345 },
      deps,
    );

    expect(result.sent).toBe(true);
    expect(client.sendGroupForwardMsg).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd E:/project/openclaw-napcat && npx vitest run src/__tests__/send-text-forward.test.ts`
Expected: FAIL — 合并转发逻辑尚未接入 sendText

- [ ] **Step 3: 修改 send-text.ts 插入合并转发前置检查**

在 `src/outbound/send-text.ts` 顶部添加 import：

```typescript
import { sendMergedForward } from "./send-merged-forward.js";
```

将 `send-text.ts` 的 try 块（第 162-183 行）从：

```typescript
  try {
    // 裸数字 to 处理
    const effectiveTo = await resolveBareGroupTarget(
      to,
      knownGroupIds,
      async (id) => client.getGroupInfo(id),
      log,
    );

    const target = parseTarget(effectiveTo);
    const chunks = splitMessage(finalText, params.cfg?.maxMessageLength ?? 4000);
    for (let i = 0; i < chunks.length; i++) {
      let message: OneBotMessage | string = chunks[i];
      if (replyToId && i === 0)
        message = [
          { type: "reply", data: { id: String(replyToId) } },
          { type: "text", data: { text: chunks[i] } },
        ];
      await dispatchMessage(client, target, message);
      if (chunks.length > 1 && i < chunks.length - 1) await sleep(OUTBOUND_MULTI_CHUNK_SLEEP_MS);
    }
    return { channel: "napcat", sent: true };
  } catch (err) {
```

替换为：

```typescript
  try {
    // 裸数字 to 处理
    const effectiveTo = await resolveBareGroupTarget(
      to,
      knownGroupIds,
      async (id) => client.getGroupInfo(id),
      log,
    );

    const target = parseTarget(effectiveTo);

    // ── 合并转发前置检查 ─────────────────────────────────────
    // 仅群消息 + 超阈值时先尝试合并转发，失败自动降级普通分片
    const forwardThreshold = params.cfg?.forwardThreshold ?? 2000;
    const isGroupTarget = target.kind === "group";
    if (isGroupTarget && forwardThreshold > 0 && finalText.length >= forwardThreshold) {
      getLog(log).log(
        `[napcat-QQ][merged-forward] text length ${finalText.length} >= threshold ${forwardThreshold}, attempting merged forward`,
      );
      const sent = await sendMergedForward({
        client,
        groupId: target.id,
        texts: [finalText],
        nodeName: params.cfg?.forwardNodeName ?? "OpenClaw",
        nodeUin: String(client.getSelfId() ?? params.botSelfId ?? ""),
        nodeCharLimit: params.cfg?.forwardNodeCharLimit ?? 0,
      });
      if (sent) {
        getLog(log).log(`[napcat-QQ][merged-forward] delivered successfully (nodes=${finalText.length} chars)`);
        return { channel: "napcat", sent: true };
      }
      getLog(log).warn("[napcat-QQ][merged-forward] failed, falling back to plain chunks");
    }

    // ── 普通分片发送（原逻辑） ─────────────────────────────────
    const chunks = splitMessage(finalText, params.cfg?.maxMessageLength ?? 4000);
    for (let i = 0; i < chunks.length; i++) {
      let message: OneBotMessage | string = chunks[i];
      if (replyToId && i === 0)
        message = [
          { type: "reply", data: { id: String(replyToId) } },
          { type: "text", data: { text: chunks[i] } },
        ];
      await dispatchMessage(client, target, message);
      if (chunks.length > 1 && i < chunks.length - 1) await sleep(OUTBOUND_MULTI_CHUNK_SLEEP_MS);
    }
    return { channel: "napcat", sent: true };
  } catch (err) {  } catch (err) {
    getLog(log).error("[napcat-QQ][outbound.sendText] FAILED:", err);
    return { channel: "napcat", sent: false, error: String(err) };
  }
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd E:/project/openclaw-napcat && npx vitest run src/__tests__/send-text-forward.test.ts`
Expected: 全部 5 个测试通过

- [ ] **Step 5: 全量测试验证无回归**

Run: `cd E:/project/openclaw-napcat && npx vitest run`
Expected: 全部测试通过（包括已有测试）

- [ ] **Step 6: 提交**

```bash
git add src/outbound/send-text.ts src/__tests__/send-text-forward.test.ts
git commit -m "feat(qq): integrate merged-forward into sendText outbound

群消息超阈值时优先走合并转发，失败自动降级普通分片。
私聊/频道不受影响，threshold=0 时禁用。

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

### Task 5: openclaw.plugin.json — 配置 Schema 同步

**Files:**
- Modify: `openclaw.plugin.json`（如存在 configSchema 部分）

- [ ] **Step 1: 检查 openclaw.plugin.json 是否有 configSchema**

Run: `find E:/project/openclaw-napcat -name "openclaw.plugin.json" -maxdepth 1`
Expected: 文件存在

- [ ] **Step 2: 添加新配置项到 plugin manifest**

在 `openclaw.plugin.json` 的 `configSchema.properties` 中添加 `forwardThreshold`、`forwardNodeName`、`forwardNodeCharLimit` 的描述（如已有自动同步机制则跳过）。

- [ ] **Step 3: 提交**

```bash
git add openclaw.plugin.json
git commit -m "docs(qq): sync forward config to plugin manifest

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

## 自检清单

- [x] Spec 覆盖：forwardThreshold/NodeName/NodeCharLimit 配置 → Task 1
- [x] Spec 覆盖：双 action 兜底 → Task 2
- [x] Spec 覆盖：节点构建（拆分/不拆分）→ Task 3
- [x] Spec 覆盖：sendText 集成 + 失败降级 → Task 4
- [x] Spec 覆盖：plugin manifest 同步 → Task 5
- [x] 无占位符（无 TBD/TODO）
- [x] 类型一致：`sendGroupForwardMsg` 在 Task 2 定义，Task 3 消费
- [x] 类型一致：`sendMergedForward` 在 Task 3 定义，Task 4 消费
