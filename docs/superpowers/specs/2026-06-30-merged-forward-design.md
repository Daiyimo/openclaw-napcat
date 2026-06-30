# 合并转发功能设计

## 背景

openclaw_qq 项目实现了「长回复自动合并转发」功能：当群消息文本超过阈值时，将多条消息打包为一条合并转发消息发送，阅读体验远优于逐条分块。napcat 项目当前仅支持 `splitMessage` 分片逐条发送，长文本体验较差。

## 目标

移植合并转发功能到 napcat，保持 napcat 现有架构风格和代码规范。

## 配置项（config.ts）

新增 3 个配置项：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `forwardThreshold` | number | 2000 | 触发合并转发的字符数阈值，0=禁用 |
| `forwardNodeName` | string | "OpenClaw" | 转发节点显示昵称 |
| `forwardNodeCharLimit` | number | 0 | 单节点最大字符数，0=不拆分节点 |

遵循现有 Zod schema 模式（`.optional().default()` + `z.preprocess` 容错）。

## client.ts 新增方法

```typescript
async sendGroupForwardMsg(
  groupId: string | number,
  messages: ForwardNode[],
  timeoutMs: number = 15_000,
): Promise<OneBotResponse>
```

内部尝试两个 action 的顺序：
1. `send_group_forward_msg`（NapCat 原生群合并转发）
2. `send_forward_msg`（通用合并转发）

两个都失败时抛出最后一个错误，由调用方决定降级。

`ForwardNode` 类型：
```typescript
interface ForwardNode {
  name: string;    // 节点显示昵称
  uin: string;     // 节点 QQ 号
  content: string; // 节点文本内容
}
```

映射到 OneBot 消息段格式：
```typescript
{ type: "node", data: { name, uin, content } }
```

## send-merged-forward.ts（新建）

核心函数：

```typescript
async function sendMergedForward(params: {
  client: OneBotClient;
  groupId: string | number;
  texts: string[];
  nodeName: string;
  nodeUin: string;
  nodeCharLimit: number;
}): Promise<boolean>
```

逻辑：
1. 过滤空文本
2. 构建转发节点列表：
   - `nodeCharLimit > 0`：对每条文本按 `splitMessage(text, nodeCharLimit)` 拆分
   - `nodeCharLimit = 0`：所有文本拼为一个节点
3. 调用 `client.sendGroupForwardMsg(groupId, nodes)`
4. 成功返回 `true`，失败返回 `false`（由调用方降级）

## send-text.ts 修改

在发送主流程（分片循环）之前插入合并转发前置检查：

```typescript
// 群消息 + 超阈值 → 先尝试合并转发
if (target.kind === "group" && finalText.length >= forwardThreshold && forwardThreshold > 0) {
  const sent = await sendMergedForward({
    client, groupId: target.id, texts: [finalText],
    nodeName: config.forwardNodeName ?? "OpenClaw",
    nodeUin: String(client.getSelfId() || ""),
    nodeCharLimit: config.forwardNodeCharLimit ?? 0,
  });
  if (sent) return { channel: "napcat", sent: true };
  // 失败 → 继续走下面的普通分片逻辑
}
```

## 降级策略

三层降级：
1. 按 `nodeCharLimit` 构建节点 → `send_group_forward_msg`
2. 失败 → `send_forward_msg`
3. 仍失败 → 返回 `false`，`send-text.ts` 回退到 `splitMessage` 分片发送

## 测试计划

| 测试文件 | 覆盖场景 |
|----------|----------|
| `send-merged-forward.test.ts` | 节点构建（拆分/不拆分）、双 action 兜底、空文本过滤 |
| `send-text-forward.test.ts` | 触发条件（群+超阈值）、私聊不触发、阈值=0 禁用、失败降级 |
| `config.test.ts` | 新增配置项默认值、Zod 验证 |

## 改动文件清单

1. `src/config.ts` — +3 配置项
2. `src/client.ts` — +`sendGroupForwardMsg` 方法 + `ForwardNode` 类型
3. `src/outbound/send-merged-forward.ts` — 新建
4. `src/outbound/send-text.ts` — 插入合并转发前置检查
5. `src/outbound/send-merged-forward.test.ts` — 新建测试
6. `src/__tests__/send-text-forward.test.ts` — 新建测试（或合并到现有 send-text 测试）
