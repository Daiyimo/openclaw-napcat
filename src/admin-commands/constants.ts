/**
 * admin-commands 子模块常量
 * 集中管理魔法数字，供 handlers 共享。
 */

/** /ban 默认封禁时长（分钟） */
export const BAN_DEFAULT_MINUTES = 30;
/** /mute 默认禁言时长（分钟） */
export const MUTE_DEFAULT_MINUTES = 30;
/** /mute 最大禁言时长（分钟）= 30 天 */
export const MUTE_MAX_MINUTES = 43200;
/** /files 默认列文件数量 */
export const FILES_DEFAULT_COUNT = 20;
/** /files 最大列文件数量 */
export const FILES_MAX_COUNT = 50;
/** /shutlist 最大显示禁言用户数 */
export const MAX_SHUT_LIST_DISPLAY = 30;

/** /logs 默认日志条数 */
export const LOGS_DEFAULT_COUNT = 20;
/** /logs 最大日志条数 */
export const LOGS_MAX_COUNT = 100;
/** /essence 最大显示精华消息条数 */
export const ESSENCE_MAX_DISPLAY = 10;
/** 高代价操作确认窗口（秒） */
export const CONFIRM_TIMEOUT_SECONDS = 30;
