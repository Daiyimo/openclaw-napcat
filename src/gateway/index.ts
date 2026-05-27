/**
 * Gateway 模块入口
 *
 * 重新导出 connection / inbound / lifecycle 公共 API。
 */

export { installConnectHandler, type ConnectionResult } from "./connection.js";
export { installMessageHandler } from "./inbound.js";
export { startAccount } from "./lifecycle.js";
