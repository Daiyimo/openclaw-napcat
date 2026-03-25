# OpenClaw QQ 插件卸载脚本 (Windows PowerShell)
# 自动请求管理员权限

# 设置错误处理
$ErrorActionPreference = "Stop"

# =====================================================
# 1. 自动请求管理员权限（如果当前不是管理员）
# =====================================================
function Ensure-Administrator {
    $CurrentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $CurrentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host "=== 需要管理员权限 ===" -ForegroundColor Yellow
        Write-Host "此脚本需要管理员权限才能卸载插件和修改系统配置。"
        Write-Host "正在请求提升权限..." -ForegroundColor Cyan
        Write-Host ""

        # 获取当前脚本路径
        $ScriptPath = $MyInvocation.MyCommand.Path

        # 获取所有传递给脚本的参数
        $Parameters = $args

        # 使用 UAC 提升权限重新启动脚本
        try {
            $ProcessInfo = Start-Process PowerShell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" $Parameters" -Wait -PassThru
            exit $ProcessInfo.ExitCode
        } catch {
            Write-Error "无法提升权限: $($_.Exception.Message)"
            Write-Host "请右键点击脚本，选择'以管理员身份运行'" -ForegroundColor Yellow
            pause
            exit 1
        }
    }
}

# 在脚本开头立即检查权限
Ensure-Administrator

# =====================================================
# 颜色函数
# =====================================================
function Write-Info {
    param([string]$Message)
    Write-Host "[INFO] $Message" -ForegroundColor Cyan
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Write-Error {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
}

function Write-Success {
    param([string]$Message)
    Write-Host "[SUCCESS] $Message" -ForegroundColor Green
}

Write-Host "=== OpenClaw QQ 插件卸载脚本 ===" -ForegroundColor White
Write-Host ""

# 2. 查找插件目录
Write-Info "正在搜索 OpenClaw 插件目录..."

$possiblePaths = @(
    "${env:USERPROFILE}\.openclaw\extensions\qq",
    "C:\openclaw\extensions\qq",
    "D:\openclaw\extensions\qq",
    "${env:ProgramFiles}\openclaw\extensions\qq",
    "${env:ProgramFiles(x86)}\openclaw\extensions\qq"
)

# 尝试通过 where 命令找到 openclaw
try {
    $openclawPath = (Get-Command openclaw -ErrorAction SilentlyContinue).Source
    if ($openclawPath) {
        $openclawDir = Split-Path (Split-Path $openclawPath) -Parent
        $nodeModulesPath = Join-Path $openclawDir "lib\node_modules\openclaw\extensions\qq"
        $possiblePaths += $nodeModulesPath
    }
} catch {
    # 忽略错误
}

$FoundExtDir = $null
foreach ($path in $possiblePaths) {
    if (Test-Path $path) {
        $FoundExtDir = $path
        Write-Info "找到插件目录: $FoundExtDir"
        break
    }
}

if (-not $FoundExtDir) {
    Write-Warn "未自动检测到插件目录，请手动指定"
    Write-Info "常见位置："
    Write-Info "  - $env:USERPROFILE\.openclaw\extensions\qq"
    Write-Info "  - C:\openclaw\extensions\qq"
    $FoundExtDir = Read-Host "请输入插件完整路径"
    if (-not (Test-Path $FoundExtDir)) {
        Write-Error "目录不存在: $FoundExtDir"
        pause
        exit 1
    }
}

# 3. 查找配置文件
Write-Info "正在搜索 OpenClaw 配置文件..."

$configPaths = @(
    "${env:USERPROFILE}\.openclaw\openclaw.json",
    "C:\openclaw\openclaw.json",
    "D:\openclaw\openclaw.json",
    "${env:ProgramData}\openclaw\openclaw.json"
)

$FoundConfig = $null
foreach ($cfg in $configPaths) {
    if (Test-Path $cfg) {
        $FoundConfig = $cfg
        Write-Info "找到配置文件: $FoundConfig"
        break
    }
}

if (-not $FoundConfig) {
    Write-Warn "未自动检测到配置文件，请手动指定"
    $FoundConfig = Read-Host "请输入 openclaw.json 完整路径"
    if (-not (Test-Path $FoundConfig)) {
        Write-Error "文件不存在: $FoundConfig"
        pause
        exit 1
    }
}

# 4. 确认卸载
Write-Host ""
Write-Warn "即将执行以下操作："
Write-Warn "  1. 停止 OpenClaw 网关服务（如正在运行）"
Write-Warn "  2. 删除插件目录: $FoundExtDir"
Write-Warn "  3. 清理配置文件: $FoundConfig"
Write-Host ""
$Confirm = Read-Host "确认卸载？(输入 YES 继续)"
if ($Confirm -ne "YES") {
    Write-Info "已取消卸载"
    pause
    exit 0
}

# 5. 停止网关服务
Write-Info "正在停止 OpenClaw 网关..."

try {
    # 尝试停止服务
    $services = Get-Service -Name "openclaw*" -ErrorAction SilentlyContinue
    foreach ($service in $services) {
        if ($service.Status -eq 'Running') {
            Write-Info "停止服务: $($service.Name)"
            Stop-Service -Name $service.Name -Force
        }
    }
} catch {
    Write-Warn "无法通过服务管理器停止，尝试终止进程..."
    # 杀死进程
    $processes = Get-Process -Name "openclaw" -ErrorAction SilentlyContinue
    foreach ($proc in $processes) {
        Write-Info "终止进程: $($proc.Id)"
        Stop-Process -Id $proc.Id -Force
    }
}

Start-Sleep -Seconds 2
Write-Success "网关已停止"

# 6. 备份配置文件
$BackupConfig = "${FoundConfig}.backup.$(Get-Date -Format 'yyyyMMdd_HHmmss')"
Write-Info "备份配置文件到: $BackupConfig"
Copy-Item $FoundConfig $BackupConfig

# 7. 清理配置文件
Write-Info "清理配置文件..."

# 使用 PowerShell 的 JSON 处理
try {
    $jsonContent = Get-Content $FoundConfig -Raw | ConvertFrom-Json

    # 删除 plugins.entries.qq
    if ($jsonContent.plugins -and $jsonContent.plugins.entries -and $jsonContent.plugins.entries.qq) {
        $jsonContent.plugins.entries.PSObject.Properties.Remove('qq') | Out-Null
        Write-Info "已删除 plugins.entries.qq"
    }

    # 删除 channels.qq
    if ($jsonContent.channels -and $jsonContent.channels.qq) {
        $jsonContent.channels.PSObject.Properties.Remove('qq') | Out-Null
        Write-Info "已删除 channels.qq"
    }

    # 保存配置
    $jsonContent | ConvertTo-Json -Depth 10 | Set-Content $FoundConfig
    Write-Success "配置清理完成"
} catch {
    Write-Warn "JSON 处理失败: $($_.Exception.Message)"
    Write-Warn "回退到文本替换（可能不精确）"

    # 备份原文件（如果上面的备份失败）
    if (-not (Test-Path $BackupConfig)) {
        Copy-Item $FoundConfig "${FoundConfig}.bak"
    }

    # 文本清理（简单替换）
    (Get-Content $FoundConfig) |
        Where-Object { $_ -notmatch '"qq"\s*:' } |
        Set-Content $FoundConfig

    Write-Success "配置已进行基础清理，请手动检查"
}

# 8. 删除插件目录
Write-Info "正在删除插件目录..."
if (Test-Path $FoundExtDir) {
    try {
        Remove-Item -Recurse -Force $FoundExtDir
        Write-Success "插件目录已删除"
    } catch {
        Write-Warn "删除失败，尝试重置权限后重试..."
        # 使用 icacls 重置权限
        icacls $FoundExtDir /grant Everyone:(F) /T /C | Out-Null
        Remove-Item -Recurse -Force $FoundExtDir -ErrorAction SilentlyContinue
        if (Test-Path $FoundExtDir) {
            Write-Error "插件目录删除失败，请手动删除"
            Write-Info "路径: $FoundExtDir"
        } else {
            Write-Success "插件目录已删除"
        }
    }
} else {
    Write-Warn "插件目录不存在，跳过删除"
}

# 9. 删除插件数据文件
Write-Info "清理插件数据文件..."

$dataPaths = @(
    "${env:USERPROFILE}\.openclaw\data\qq",
    "${env:USERPROFILE}\.openclaw\logs\qq-*.log"
)

foreach ($path in $dataPaths) {
    if ($path -like '*{*}*') {
        # 处理通配符
        $files = Get-ChildItem $path -ErrorAction SilentlyContinue
        foreach ($file in $files) {
            Remove-Item $file.FullName -Force -ErrorAction SilentlyContinue
        }
        if ($files) {
            Write-Success "已删除日志文件: $path"
        }
    } else {
        if (Test-Path $path) {
            Remove-Item -Recurse -Force $path
            Write-Success "已删除数据目录: $path"
        }
    }
}

# 10. 验证卸载
Write-Host ""
Write-Info "验证卸载结果..."

if (Test-Path $FoundExtDir) {
    Write-Error "插件目录仍然存在！"
    $ExitCode = 1
} else {
    Write-Success "插件目录已删除"
    $ExitCode = 0
}

# 检查配置文件中是否还有 qq 引用
try {
    $configContent = Get-Content $FoundConfig -Raw
    if ($configContent -match '"qq"') {
        Write-Warn "配置文件中可能仍有 qq 相关配置"
        Write-Info "请手动检查: $FoundConfig"
    } else {
        Write-Success "配置文件中无 qq 引用"
    }
} catch {
    Write-Warn "无法验证配置文件"
}

# 11. 输出总结
Write-Host ""
Write-Host "=== 卸载完成 ===" -ForegroundColor Green
Write-Success "QQ 插件已成功卸载"
Write-Host ""
Write-Host "已执行的操作："
Write-Host "  1. 停止 OpenClaw 网关服务"
Write-Host "  2. 删除插件目录: $FoundExtDir"
Write-Host "  3. 清理配置文件: $FoundConfig"
Write-Host "  4. 备份配置到: $BackupConfig"
Write-Host "  5. 删除日志和数据文件"
Write-Host ""
Write-Info "下一步："
Write-Host "  - 重启 OpenClaw 网关（如果不再需要）"
Write-Host "  - 如需重新安装，请运行 install_stepfun.ps1"
Write-Host "  - 配置文件备份: $BackupConfig"
Write-Host ""

pause
exit $ExitCode
