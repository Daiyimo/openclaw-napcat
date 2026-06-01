/**
 * 多 bot 对话状态管理（按群隔离）
 *
 * 追踪每个群内的对话链：
 * - rounds: 连续 bot-to-bot 对话轮数（用户消息重置）
 * - stoppedAt: 用户发出停止指令的时间戳（用于让所有 bot 静默一段时间）
 * - lastSpeakerId: 上一个发言的 bot（用于未来扩展"不连续同 bot 自言自语"等规则）
 *
 * 内存态：跨重启不保留（用户重新说话即恢复）。
 */

interface DialogState {
  rounds: number;
  lastUserMsgAt: number;
  lastBotMsgAt: number;
  stoppedAt: number | null;
  lastSpeakerId: string | null;
}

const states = new Map<string, DialogState>();

function makeKey(accountId: string, groupId: string | number): string {
  return `${accountId}:${groupId}`;
}

export function getDialogState(accountId: string, groupId: string | number): DialogState {
  const key = makeKey(accountId, groupId);
  let s = states.get(key);
  if (!s) {
    s = {
      rounds: 0,
      lastUserMsgAt: 0,
      lastBotMsgAt: 0,
      stoppedAt: null,
      lastSpeakerId: null,
    };
    states.set(key, s);
  }
  return s;
}

export function recordBotTurn(accountId: string, groupId: string | number, botId: string): void {
  const s = getDialogState(accountId, groupId);
  s.rounds += 1;
  s.lastBotMsgAt = Date.now();
  s.lastSpeakerId = botId;
}

export function recordUserMessage(accountId: string, groupId: string | number): void {
  const s = getDialogState(accountId, groupId);
  s.rounds = 0;
  s.lastUserMsgAt = Date.now();
  // 用户新消息解除"停止"状态（即使刚发过"别聊了"又发新话题）
  s.stoppedAt = null;
}

export function markStopped(accountId: string, groupId: string | number): void {
  const s = getDialogState(accountId, groupId);
  s.stoppedAt = Date.now();
}

export function isStopped(accountId: string, groupId: string | number, withinMs: number): boolean {
  if (withinMs <= 0) return false;
  const s = states.get(makeKey(accountId, groupId));
  if (!s || s.stoppedAt === null) return false;
  return Date.now() - s.stoppedAt < withinMs;
}

/**
 * 清理超过 maxAgeMs 未活跃的群状态。
 * 防止长期运行下 states Map 无限增长。
 */
let lastCleanupAt = 0;
const CLEANUP_COOLDOWN_MS = 5_000;

export function cleanupDialogState(maxAgeMs: number): void {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_COOLDOWN_MS) return;
  lastCleanupAt = now;

  for (const [key, s] of states) {
    const lastActive = Math.max(s.lastUserMsgAt, s.lastBotMsgAt);
    if (now - lastActive > maxAgeMs) {
      states.delete(key);
    }
  }
}

/** 测试用：重置所有状态。 */
export function resetDialogState(): void {
  states.clear();
  lastCleanupAt = 0;
}

/** 测试用：获取内部状态。 */
export function _getRawStateForTest(accountId: string, groupId: string | number): DialogState | undefined {
  return states.get(makeKey(accountId, groupId));
}
