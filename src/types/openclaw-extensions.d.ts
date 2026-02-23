// 类型扩展：添加 actions 支持到 ChannelPlugin
import "openclaw/plugin-sdk";

declare module "openclaw/plugin-sdk" {
  export interface ChannelPlugin<Account extends ChannelAccountSnapshot = ChannelAccountSnapshot> {
    actions?: {
      listActions?: (ctx: {
        cfg: any;
        accountId?: string;
      }) => string[];
      supportsAction?: (ctx: {
        action: string;
      }) => boolean;
      handleAction?: (ctx: {
        action: string;
        params: Record<string, any>;
        cfg: any;
        accountId?: string;
      }) => Promise<any>;
    };
  }
}
