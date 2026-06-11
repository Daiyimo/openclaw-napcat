/**
 * 共享延迟工具（替代各模块内联定义的 sleep）。
 */

/**
 * 延迟指定毫秒数。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
