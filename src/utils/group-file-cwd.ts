/**
 * 群文件 cwd 状态管理
 *
 * 每个 admin 在每个群里维护一个"当前目录栈"，让 /files /cd /cdup /pwd
 * 命令像 shell 一样工作。
 *
 * 实现：模块级 Map（key = `${userId}:${groupId}`），值是 folder 栈。
 * 不持久化：进程重启后所有 cwd 回到根目录（这是想要的行为）。
 */

/** 栈条目：folder 的 ID 与显示名。根目录用空栈表示，folder_id = "/"。 */
export interface FolderStackEntry {
  /** OneBot/NapCat 的 folder_id（根目录传 "/" 给 API） */
  id: string;
  /** 用户可读的显示名，用于 /pwd 输出 */
  name: string;
}

/** 模块级 cwd Map（不导出，仅通过纯函数访问）。 */
const cwdMap = new Map<string, FolderStackEntry[]>();

/** 构造内部 key。 */
function buildKey(userId: number, groupId: number): string {
  return `${userId}:${groupId}`;
}

/**
 * 获取当前 cwd 栈。空数组 = 根目录。
 * 返回的是栈的浅拷贝，外部修改不影响内部状态。
 */
export function getCwd(userId: number, groupId: number): FolderStackEntry[] {
  return [...(cwdMap.get(buildKey(userId, groupId)) ?? [])];
}

/**
 * 进入子目录（push 栈）。
 */
export function pushCwd(userId: number, groupId: number, entry: FolderStackEntry): void {
  const key = buildKey(userId, groupId);
  const stack = cwdMap.get(key) ?? [];
  cwdMap.set(key, [...stack, entry]);
}

/**
 * 回上级目录（pop 栈）。返回被弹出的条目；已在根目录返回 null。
 */
export function popCwd(userId: number, groupId: number): FolderStackEntry | null {
  const key = buildKey(userId, groupId);
  const stack = cwdMap.get(key);
  if (!stack || stack.length === 0) return null;
  const popped = stack[stack.length - 1];
  const next = stack.slice(0, -1);
  if (next.length === 0) {
    cwdMap.delete(key);
  } else {
    cwdMap.set(key, next);
  }
  return popped;
}

/**
 * 回到根目录。
 */
export function resetCwd(userId: number, groupId: number): void {
  cwdMap.delete(buildKey(userId, groupId));
}

/**
 * 拼接 cwd 路径字符串供 /pwd 显示。根目录返回 "/"。
 */
export function formatCwdPath(stack: FolderStackEntry[]): string {
  if (stack.length === 0) return "/";
  return "/" + stack.map((e) => e.name).join("/");
}

/**
 * 当前目录的 folder_id（根目录返回 "/"）。
 * 调用 NapCat API 时使用。
 */
export function currentFolderId(stack: FolderStackEntry[]): string {
  if (stack.length === 0) return "/";
  return stack[stack.length - 1].id;
}

/**
 * 仅用于测试：重置全部状态。
 */
export function _testReset(): void {
  cwdMap.clear();
}
