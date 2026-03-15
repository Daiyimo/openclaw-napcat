# 脚本用途：向 OpenClaw 配置添加 StepFun 3.5 Flash 模型并设为主模型
# 使用方式：
#   1. 以管理员身份运行 PowerShell
#   2. 执行：iwr -Uri "https://gh-proxy.com/https://raw.githubusercontent.com/Daiyimo/openclaw-napcat/napcat-qq/add_stepfun.ps1" | iex
#   或直接下载后运行：.\add_stepfun.ps1
# 注意：首次运行可能需要执行：Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

$ErrorActionPreference = "Stop"

$CONFIG_FILE = Join-Path $env:USERPROFILE ".openclaw\openclaw.json"

# 检查配置文件是否存在
if (-not (Test-Path $CONFIG_FILE)) {
    Write-Host "错误：配置文件不存在: $CONFIG_FILE" -ForegroundColor Red
    Write-Host "请确认 OpenClaw 已正确安装" -ForegroundColor Yellow
    exit 1
}

# 检查是否安装了 jq（可选，脚本使用 PowerShell 原生 JSON 处理，但 jq 可用于验证）
# PowerShell 原生支持 JSON，无需额外依赖

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  OpenClaw 配置 - 添加 StepFun 3.5 Flash" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "请选择接入方式：" -ForegroundColor White
Write-Host "  1) OpenRouter 免费版（无需付费，有速率限制 50 RPM）" -ForegroundColor Green
Write-Host "  2) StepFun 官方 API（按量计费，需要官方 API Key）" -ForegroundColor Green
Write-Host ""

# 获取用户选择
do {
    $CHOICE = Read-Host "请输入数字选择 [1/2]"
} while ($CHOICE -notmatch '^[12]$')

Write-Host ""

if ($CHOICE -eq "1") {
    Write-Host "已选择：OpenRouter 免费版" -ForegroundColor Green
    Write-Host ""

    do {
        $OPENROUTER_APIKEY = Read-Host "请输入 OpenRouter API Key（sk-or-v1-...）"
        if ([string]::IsNullOrWhiteSpace($OPENROUTER_APIKEY)) {
            Write-Host "API Key 不能为空，请重新输入" -ForegroundColor Red
        }
    } while ([string]::IsNullOrWhiteSpace($OPENROUTER_APIKEY))

    Write-Host "配置文件: $CONFIG_FILE"
    Write-Host "API Key: $($OPENROUTER_APIKEY.Substring(0, [Math]::Min(15, $OPENROUTER_APIKEY.Length)))..."
    Write-Host ""

    # 备份配置文件
    $timestamp = Get-Date -Format "yyyyMMddHHmmss"
    $backupFile = "${CONFIG_FILE}.bak.$timestamp"
    Copy-Item $CONFIG_FILE $backupFile -Force
    Write-Host "已备份原配置文件: $backupFile"

    # 读取并修改配置文件
    try {
        $config = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json

        # 添加 OpenRouter 提供商配置
        $config.models.providers.openrouter = @{
            baseUrl = "https://openrouter.ai/api/v1"
            apiKey = $OPENROUTER_APIKEY
            api = "openai-completions"
            models = @(
                @{
                    id = "stepfun/step-3.5-flash:free"
                    name = "Step 3.5 Flash Free"
                    api = "openai-completions"
                    reasoning = $true
                    input = @("text")
                    cost = @{
                        input = 0
                        output = 0
                        cacheRead = 0
                        cacheWrite = 0
                    }
                    contextWindow = 256000
                    maxTokens = 8192
                }
            )
        }

        # 设置默认模型
        $config.agents.defaults.model.primary = "openrouter/stepfun/step-3.5-flash:free"

        # 写回配置文件（保持格式）
        $config | ConvertTo-Json -Depth 100 | Set-Content $CONFIG_FILE -Encoding UTF8

        Write-Host "==========================================" -ForegroundColor Green
        Write-Host "  配置更新完成!" -ForegroundColor Green
        Write-Host "==========================================" -ForegroundColor Green
        Write-Host "  - 已添加 OpenRouter StepFun 3.5 Flash Free" -ForegroundColor White
        Write-Host "  - 默认模型: openrouter/stepfun/step-3.5-flash:free" -ForegroundColor White
        Write-Host "  - 速率限制: 50 RPM" -ForegroundColor White
        Write-Host "  - 备份文件: $backupFile" -ForegroundColor White
    }
    catch {
        Write-Host "配置文件处理失败: $_" -ForegroundColor Red
        exit 1
    }
}
else {
    Write-Host "已选择：StepFun 官方 API" -ForegroundColor Green
    Write-Host ""

    do {
        $STEPFUN_APIKEY = Read-Host "请输入 StepFun API Key"
        if ([string]::IsNullOrWhiteSpace($STEPFUN_APIKEY)) {
            Write-Host "API Key 不能为空，请重新输入" -ForegroundColor Red
        }
    } while ([string]::IsNullOrWhiteSpace($STEPFUN_APIKEY))

    Write-Host "配置文件: $CONFIG_FILE"
    Write-Host "API Key: $($STEPFUN_APIKEY.Substring(0, [Math]::Min(10, $STEPFUN_APIKEY.Length)))..."
    Write-Host ""

    # 备份配置文件
    $timestamp = Get-Date -Format "yyyyMMddHHmmss"
    $backupFile = "${CONFIG_FILE}.bak.$timestamp"
    Copy-Item $CONFIG_FILE $backupFile -Force
    Write-Host "已备份原配置文件: $backupFile"

    # 读取并修改配置文件
    try {
        $config = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json

        # 添加 StepFun 提供商配置
        $config.models.providers.stepfun = @{
            baseUrl = "https://api.stepfun.com/v1"
            apiKey = $STEPFUN_APIKEY
            api = "openai-completions"
            models = @(
                @{
                    id = "stepfun/step-3.5-flash"
                    name = "Step 3.5 Flash"
                    api = "openai-completions"
                    reasoning = $false
                    input = @("text")
                    cost = @{
                        input = 0
                        output = 0
                        cacheRead = 0
                        cacheWrite = 0
                    }
                    contextWindow = 256000
                    maxTokens = 8192
                }
            )
        }

        # 设置默认模型
        $config.agents.defaults.model.primary = "stepfun/step-3.5-flash"

        # 写回配置文件（保持格式）
        $config | ConvertTo-Json -Depth 100 | Set-Content $CONFIG_FILE -Encoding UTF8

        Write-Host "==========================================" -ForegroundColor Green
        Write-Host "  配置更新完成!" -ForegroundColor Green
        Write-Host "==========================================" -ForegroundColor Green
        Write-Host "  - 已添加 StepFun 3.5 Flash" -ForegroundColor White
        Write-Host "  - 默认模型: stepfun/step-3.5-flash" -ForegroundColor White
        Write-Host "  - 备份文件: $backupFile" -ForegroundColor White
    }
    catch {
        Write-Host "配置文件处理失败: $_" -ForegroundColor Red
        exit 1
    }
}
