/**
 * admin-commands barrel 导出
 * 统一从本文件 re-export 共享工具和常量，handler 函数保留在 admin-commands.ts 中。
 */

// 共享工具
export {
  extractAtTarget,
  extractAtTargets,
  extractReplyMsgId,
  extractImageFile,
  reply,
  needConfirm,
  fmtError,
  requireGroup,
  resolveMsgId,
  formatUptime,
} from "./shared.js";

// 常量
export {
  BAN_DEFAULT_MINUTES,
  MUTE_DEFAULT_MINUTES,
  MUTE_MAX_MINUTES,
  FILES_DEFAULT_COUNT,
  FILES_MAX_COUNT,
  MAX_SHUT_LIST_DISPLAY,
  LOGS_DEFAULT_COUNT,
  LOGS_MAX_COUNT,
  ESSENCE_MAX_DISPLAY,
  CONFIRM_TIMEOUT_SECONDS,
} from "./constants.js";
