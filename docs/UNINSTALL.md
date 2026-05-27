# 插件卸载指南

本文档说明如何卸载 OpenClaw NapCat 插件。

## 🚀 快速卸载

### **Linux / macOS**

```bash
# 1. 进入插件目录
cd openclaw-napcat

# 2. 运行卸载脚本
./uninstall.sh
```

脚本会自动：
- 停止 OpenClaw 网关服务
- 删除插件目录
- 清理 `openclaw.json` 配置
- 删除日志和数据文件
- 备份原始配置

### **Windows**

```powershell
# 1. 进入插件目录
cd openclaw-napcat

# 2. 以管理员身份运行 PowerShell
# 右键 PowerShell → "以管理员身份运行"

# 3. 执行脚本
.\uninstall.ps1
```

---

## 📋 **手动卸载步骤**

如果自动脚本不适用，可以按以下步骤手动操作：

### **步骤 1：停止网关**

```bash
# Linux
sudo systemctl stop openclaw
# 或
sudo pkill -f "openclaw gateway"

# Windows
# 停止服务或关闭运行中的终端
```

### **步骤 2：删除插件目录**

```bash
# 标准位置
rm -rf /usr/lib/node_modules/openclaw/dist/extensions/napcat
# 或 Windows
rmdir /s /q "%USERPROFILE%\.openclaw\extensions\napcat"
```

### **步骤 3：清理配置**

编辑 `~/.openclaw/openclaw.json`：

1. 删除 `plugins.entries.napcat` 项
2. 删除 `channels.napcat` 整个对象

示例：
```json
{
  // 删除前
  "plugins": {
    "entries": {
      "napcat": { "enabled": true },  ← 删除这行
      "other-plugin": { ... }
    }
  },
  "channels": {
    "napcat": { ... },  ← 删除整个 "napcat" 对象
    "other-channel": { ... }
  }
}
```

### **步骤 4：删除数据文件（可选）**

```bash
rm -rf ~/.openclaw/data/napcat
rm -f ~/.openclaw/logs/napcat-*.log
```

### **步骤 5：重启网关**

```bash
sudo openclaw gateway
```

---

## 🔍 **验证卸载**

```bash
# 查看插件列表
openclaw plugins list
# 不应再显示 "napcat" 插件

# 检查状态
openclaw status
# 不应再显示 napcat 通道信息
```

---

## ⚠️ **注意事项**

1. **先停止服务**：删除插件前必须先停止 `openclaw gateway`，否则会报"目录被占用"错误。
2. **备份配置**：卸载脚本会自动备份 `openclaw.json` 为 `openclaw.json.backup.时间戳`。
3. **NapCat 不受影响**：卸载插件不会影响 NapCat 服务，NapCat 继续独立运行。
4. **用户数据**：`known-users.json` 等用户数据会被删除，如需保留请先备份。

---

## 🆘 **故障排除**

### **问题：脚本提示"权限拒绝"**

**解决**：使用 sudo 运行（Linux/macOS）或以管理员身份运行（Windows）。

### **问题：找不到插件目录**

**解决**：手动指定路径，或在运行脚本时输入正确的插件路径。

常见位置：
- Linux/macOS: `/usr/lib/node_modules/openclaw/dist/extensions/napcat`
- Windows: `C:\Users\<用户名>\.openclaw\extensions\napcat`

### **问题：配置文件中的 napcat 引用未完全删除**

**解决**：手动编辑配置文件，搜索并删除所有 `"napcat"` 相关项。

推荐安装 `jq` 工具以获得更精确的 JSON 处理：
```bash
# Ubuntu/Debian
sudo apt-get install jq

# macOS
brew install jq

# CentOS/RHEL
sudo yum install jq
```

---

## 📦 **完整卸载示例（Linux/macOS）**

```bash
# 1. 停止网关
sudo pkill -f "openclaw gateway"

# 2. 运行卸载脚本
cd /usr/lib/node_modules/openclaw/dist/extensions/napcat  # 进入插件目录
./scripts/uninstall.sh

# 3. 如果脚本提示找不到配置，手动指定
# 在脚本提示时输入：
# 插件路径: /usr/lib/node_modules/openclaw/dist/extensions/napcat
# 配置路径: /home/用户名/.openclaw/openclaw.json

# 4. 重启网关
sudo openclaw gateway
```

---

## 🔄 **重新安装**

如果需要重新安装插件：

```bash
# Linux/macOS
cd /usr/lib/node_modules/openclaw/dist/extensions
git clone https://gh-proxy.com/https://github.com/Daiyimo/openclaw-napcat.git napcat
cd napcat
pnpm install

# 配置
bash scripts/update_json.sh

# 重启网关
sudo openclaw gateway
```

详细安装说明请参阅 `README.md`。

---

## 📝 **脚本说明**

### `uninstall.sh` (Linux/macOS)
- 自动检测 OpenClaw 安装位置
- 安全停止网关服务
- 备份并清理配置
- 删除插件目录和数据
- 彩色输出，操作清晰

### `uninstall.ps1` (Windows)
- PowerShell 实现，兼容 Windows
- 支持管理员权限检测
- 使用 PowerShell JSON 模块精确清理配置
- 自动处理权限问题

---

**提示**：卸载前建议备份整个 `~/.openclaw/` 目录，以防误删其他插件配置。
