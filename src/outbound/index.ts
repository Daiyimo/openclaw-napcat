/**
 * Outbound 模块入口
 *
 * 重新导出 send-text / send-media 公共 API。
 */

export { sendText, type SendTextParams, type SendTextDeps } from "./send-text.js";
export {
  sendMedia,
  deleteMessage,
  type SendMediaParams,
  type SendMediaDeps,
  type DeleteMessageParams,
  type DeleteMessageDeps,
} from "./send-media.js";
