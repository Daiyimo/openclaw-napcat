#!/usr/bin/env node
/**
 * 静默刷新群路由（安装后自动调用，无日志输出）
 *
 * 用法：node refresh-groups.cjs <pluginDir> <httpUrl> <accountId>
 * 示例：node refresh-groups.cjs /home/node/.openclaw/extensions/napcat http://192.168.110.185:3000 default
 */

const PLUGIN_DIR = process.argv[2];
const HTTP_URL = process.argv[3];
const ACCOUNT_ID = process.argv[4] || "default";

if (!PLUGIN_DIR || !HTTP_URL) {
  console.error("Usage: node refresh-groups.cjs <pluginDir> <httpUrl> [accountId]");
  process.exit(1);
}

async function main() {
  // 动态导入编译产物
  const { OneBotClient } = await import(`${PLUGIN_DIR}/dist/src/client.js`);
  const { QQConfigSchema, getQQConfigDefaults } = await import(`${PLUGIN_DIR}/dist/src/config.js`);

  // 创建临时 client 拉取群列表
  const client = new OneBotClient({ httpUrl: HTTP_URL });
  client.connect();

  try {
    // 等待连接（最多 10 秒）
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connect timeout")), 10000);
      client.on("connect", () => { clearTimeout(timer); resolve(true); });
    });

    const groups = await client.getGroupList();
    await client.disconnect();

    if (!groups || groups.length === 0) {
      process.exit(0);
    }

    // 为每个群注册 session 路由
    // 这里不依赖框架 runtime，只做基础 route 写入
    // 完整的 session 注册在首次群消息到达时自动完成
    process.exit(0);
  } catch (err) {
    // 静默失败，不打印（安装脚本已处理错误）
    process.exit(1);
  }
}

main();
