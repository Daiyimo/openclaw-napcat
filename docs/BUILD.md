# 本地构建与开发指南

> 给贡献者 / 二次开发者用的本地构建、测试、调试全流程。

## 环境要求

| 工具      | 最低版本  | 用途                  | 备注                                |
| --------- | --------- | --------------------- | ----------------------------------- |
| Node.js   | ≥ 20.x    | 编译 / 运行           | 推荐 22.x LTS；< 20 会因 `NodeNext` 模块解析报错 |
| npm       | ≥ 10.x    | 依赖管理              | 跟随 Node 20+ 自带                 |
| Git       | 任意      | 提交 / 分支           | Linux 基础镜像可能没有，但本地开发需要 |
| Bash      | ≥ 4.x     | 跑测试和脚本          | Windows 用 Git Bash / WSL           |
| (可选) Docker | 最新版 | 跑 openclaw 容器做集成测试 | 详见 [DOCKER.md](DOCKER.md)        |

**Windows 用户注意**：仓库路径避免含中文或空格；脚本中 `tar` / `find` 行为按 Unix 假设，建议 WSL2。

## 快速开始（5 分钟）

```bash
# 1. 克隆
git clone https://github.com/Daiyimo/openclaw-napcat.git
cd openclaw-napcat

# 2. 安装依赖（含 devDeps：typescript、vitest）
npm install

# 3. 跑测试（应全绿）
npm test

# 4. 编译产物到 dist/
npm run build

# 5. 看产物
ls dist/src/   # 预期: channel.js client.js ... index.js ...
```

> 首次 `npm install` 较慢（拉 zod / ws / silk-wasm / mpg123-decoder 等）。若网络受限可设国内镜像：
> ```bash
> npm config set registry https://registry.npmmirror.com
> ```

## 常用命令

| 命令                      | 作用                                       |
| ------------------------- | ------------------------------------------ |
| `npm test`                | 跑全套 vitest（30+ 测试文件，约 5-10 秒）  |
| `npm run test:watch`      | 监听文件变化，单测自动重跑                 |
| `npm run test:coverage`   | 生成 v8 覆盖率报告到 `coverage/index.html` |
| `npm run build`           | `tsc` 严格模式编译到 `dist/`               |
| `npm run prepublishOnly`  | 等价 `npm run build`，发布前自动跑         |

### 类型检查单跑

构建本身已含类型检查。若只想检查不改产物：

```bash
npx tsc --noEmit --project tsconfig.json
```

## 目录结构

```
openclaw-napcat/
├── src/                    # 源码（被 tsconfig 编译）
│   ├── __tests__/          # vitest 测试，**不会**被编译进 dist
│   ├── gateway/            # 连接 + 消息入站 + 生命周期
│   ├── outbound/           # 消息出站（send-text / send-media）
│   ├── utils/              # 纯函数工具（日志脱敏 / 重试 / 平台判断等）
│   ├── *.ts                # 顶层模块（client / config / channel 等）
│   └── index.ts            # 插件入口（openclaw.plugin.json 指向 dist/src/index.js）
├── scripts/                # 安装/更新/卸载脚本（bash + nodejs）
│   ├── docker-install.sh   # 容器内一键安装
│   ├── install.sh          # 宿主机安装
│   ├── update.sh           # 插件更新
│   └── setup-config.cjs    # 把 QQ_* 环境变量写入 openclaw.json
├── docs/                   # 用户文档（中文）
├── config/                 # 配置文件示例
├── docker/                 # Dockerfile + entrypoint + setup-config
├── openclaw.plugin.json    # openclaw 框架识别插件的清单
├── package.json            # npm 元数据
├── tsconfig.json           # TS 严格模式配置
└── vitest.config.ts        # 测试运行器配置
```

**关键不变量**：
- `tsconfig.json` 排除 `src/__tests__/`，所以测试代码**不会污染生产产物**
- `package.json` 的 `files: ["dist/"]` 决定了发布到 npm 时带什么
- 插件入口在 `dist/src/index.js`，不是 `dist/index.js`（注意 `src/` 多一层）

## 本地联调（开发模式）

最常见的开发场景：改完代码想立刻看到效果，不要每次手动重装插件。

### 方式一：符号链接到 openclaw 扩展目录（推荐）

```bash
# 1. 编译一次
npm run build

# 2. 找出 openclaw 扩展目录
OPENCLAW_EXT=$(find /usr /home /opt -type d -path "*/openclaw/dist/extensions" 2>/dev/null | head -1)
#   或容器路径：$HOME/.openclaw/extensions

# 3. 链接（不是复制）
ln -sfn "$(pwd)" "$OPENCLAW_EXT/napcat-dev"

# 4. 在 openclaw.json 里把扩展指向 napcat-dev
# 5. 重启 openclaw
```

改完代码只需 `npm run build`，无需重装。

### 方式二：在容器里跑 openclaw + 挂载源码

参考 [DOCKER.md](DOCKER.md) 的 compose 配置，把本仓库目录挂到容器里的 `~/.openclaw/extensions/napcat`。容器内跑：

```bash
# 容器内
cd ~/.openclaw/extensions/napcat
npm install
npm run build
# 重启 openclaw
```

> **注意**：v1.8.x 之后所有 install / update 脚本都自带 build。如要纯手动开发，绕开脚本直接 `cd` + `npm install` + `npm run build` 即可。

### 方式三：watch 模式自动重编译

```bash
# 终端 1：监听 src/ 变化自动重编译
npx tsc --watch --project tsconfig.json

# 终端 2：vitest watch
npm run test:watch
```

`tsc --watch` 输出增量编译结果，TypeScript 报错会立即可见。

## 调试技巧

### 1. 结构化日志

本插件自建了一个轻量日志系统（`src/log-buffer.ts`），不依赖 winston/pino。所有日志走：

```typescript
import { logger } from "./log-buffer";
logger.info("[模块名] 事件", { extra: "context" });
```

**输出位置**：
- 容器内：`docker logs openclaw` 实时滚动
- 进程模式：`openclaw gateway` 启动后的 stdout

**`/status` 命令**（机器人侧）可查运行时指标（详见 [COMMANDS.md](COMMANDS.md)）。

### 2. 隔离单测

```bash
# 跑某一个测试文件
npx vitest run src/__tests__/config.test.ts

# 跑某个 describe
npx vitest run -t "parses valid config"

# 只看失败
npx vitest run --reporter=verbose
```

### 3. 集成到运行中的 openclaw

```bash
# 看当前连接状态
docker exec openclaw openclaw status

# 实时看 QQ 插件日志
docker logs -f openclaw | grep -E "napcat|QQ"
```

### 4. 类型错误的快速定位

```bash
# 严格模式全量类型检查
npx tsc --noEmit

# 看某一个文件的错误
npx tsc --noEmit src/config.ts 2>&1 | head -20
```

## 常见问题（FAQ）

### Q1：`npm install` 报 `ENOTSUP` / `EPERM`（Windows）
**原因**：Windows 文件系统不支持符号链接。
**解决**：
```bash
npm install --no-bin-links
```

### Q2：`tsc` 报 `Cannot find module 'openclaw'`
**原因**：`openclaw` 是 `peerDependency`，本地开发没装。
**解决**：在 `node_modules/openclaw` 放一个 stub 目录（含 `package.json` 声明 `main`），或装真包。**不要**把 `openclaw` 加进 `dependencies`。

### Q3：测试覆盖率低
**不是 bug**。项目测试哲学见 [CLAUDE.md §11.2](../CLAUDE.md)：「按价值选测试目标，不追求覆盖率数字」。纯 I/O 协调层和有 mock >3 层的不测。

### Q4：build 出来的 `dist/` 巨大（>10MB）
**原因**：忘了 `npm prune --omit=dev`。
**解决**：
```bash
npm prune --omit=dev
du -sh dist/ node_modules/
```

### Q5：如何验证 tarball 下载脚本（v1.8.x）？
**不要**真去 GitHub 下载。模拟解压目录结构即可：
```bash
EXTRACT_DIR=/tmp/test-$$
mkdir -p "$EXTRACT_DIR/openclaw-napcat-main"
find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d -name "openclaw-napcat-*"
# 应输出 $EXTRACT_DIR/openclaw-napcat-main
```

### Q6：commit 被 pre-commit 钩子拒了
仓库根目录 `.pre-commit-config.yaml` 定义了 `ruff` / `eslint` / `tsc` 检查。错误信息会精确指出哪个文件、哪条规则。**不要**用 `--no-verify` 绕过（违反 §7.3）。

## 发布流程（维护者）

1. 改 `package.json` 的 `version`（语义化版本：fix 改 patch、feat 改 minor、break 改 major）
2. `docs/CHANGELOG.md` 顶部补新版本条目（Keep a Changelog 格式）
3. `npm run build` 确认无 TS 错误
4. `npm test` 全绿
5. `git tag vX.Y.Z && git push --tags`（**不**自动 push，由维护者手动）
6. `npm publish`（需 `NPM_TOKEN` 环境变量）

> 项目根 `.npmrc` 不会追踪敏感 token。CI 走 `NPM_TOKEN` env。

## 下一步

- 架构图：[docs/ARCHITECTURE_VISUAL.md](ARCHITECTURE_VISUAL.md)
- 部署：[docs/DOCKER.md](DOCKER.md)
- 配置项：[docs/CONFIG.md](CONFIG.md)
- 机器人命令：[docs/COMMANDS.md](COMMANDS.md)
- 模块说明：[docs/MODULES.md](MODULES.md)
- 变更记录：[docs/CHANGELOG.md](CHANGELOG.md)
- 行为准则：[CLAUDE.md](../CLAUDE.md)
