@echo off
REM OpenClaw QQ 插件卸载脚本 (Windows Batch)
REM 自动请求管理员权限

REM 设置脚本编码为 UTF-8
chcp 65001 >nul

REM =====================================================
REM 1. 自动请求管理员权限（如果当前不是管理员）
REM =====================================================
:check_admin
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo === 需要管理员权限 ===
    echo 此脚本需要管理员权限才能卸载插件和修改系统配置。
    echo 正在请求提升权限...
    echo.

    REM 使用 PowerShell 以管理员身份重新启动此脚本
    powershell -Command "Start-Process cmd -ArgumentList '/c cd /d \"%~dp0\" && \"%~dpnx0\" %*' -Verb RunAs"
    exit /b
)

REM 如果已经是管理员，继续执行
echo === OpenClaw QQ 插件卸载脚本 ===
echo.

REM 1. 查找插件目录
echo [INFO] 正在搜索 OpenClaw 插件目录...

set "FOUND_EXT_DIR="
for %%d in (
    "%USERPROFILE%\.openclaw\extensions\qq"
    "C:\openclaw\extensions\qq"
    "D:\openclaw\extensions\qq"
    "%ProgramFiles%\openclaw\extensions\qq"
) do (
    if exist "%%~d" (
        set "FOUND_EXT_DIR=%%~d"
        echo [INFO] 找到插件目录: %FOUND_EXT_DIR%
        goto :found_ext
    )
)

:found_ext
if not defined FOUND_EXT_DIR (
    echo [WARN] 未自动检测到插件目录
    set /p FOUND_EXT_DIR="请输入插件完整路径: "
    if not exist "%FOUND_EXT_DIR%" (
        echo [ERROR] 目录不存在: %FOUND_EXT_DIR%
        pause
        exit /b 1
    )
)

REM 2. 查找配置文件
echo [INFO] 正在搜索 OpenClaw 配置文件...

set "FOUND_CONFIG="
for %%c in (
    "%USERPROFILE%\.openclaw\openclaw.json"
    "C:\openclaw\openclaw.json"
    "D:\openclaw\openclaw.json"
    "%ProgramData%\openclaw\openclaw.json"
) do (
    if exist "%%~c" (
        set "FOUND_CONFIG=%%~c"
        echo [INFO] 找到配置文件: %FOUND_CONFIG%
        goto :found_config
    )
)

:found_config
if not defined FOUND_CONFIG (
    echo [WARN] 未自动检测到配置文件
    set /p FOUND_CONFIG="请输入 openclaw.json 完整路径: "
    if not exist "%FOUND_CONFIG%" (
        echo [ERROR] 文件不存在: %FOUND_CONFIG%
        pause
        exit /b 1
    )
)

REM 3. 确认卸载
echo.
echo [WARN] 即将执行以下操作：
echo [WARN]  1. 停止 OpenClaw 网关服务（如正在运行）
echo [WARN]  2. 删除插件目录: %FOUND_EXT_DIR%
echo [WARN]  3. 清理配置文件: %FOUND_CONFIG%
echo.
set /p CONFIRM="确认卸载？(输入 YES 继续): "
if /i not "%CONFIRM%"=="YES" (
    echo [INFO] 已取消卸载
    pause
    exit /b 0
)

REM 4. 停止网关服务
echo [INFO] 正在停止 OpenClaw 网关...

REM 尝试停止服务
sc stop openclaw 2>nul
sc stop openclaw-gateway 2>nul
timeout /t 2 /nobreak >nul

REM 杀死进程
taskkill /f /im openclaw.exe 2>nul
taskkill /f /im openclaw-gateway.exe 2>nul

echo [SUCCESS] 网关已停止

REM 5. 备份配置文件
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set "datetime=%%I"
set "BACKUP_CONFIG=%FOUND_CONFIG%.backup.%datetime:~0,8%_%datetime:~8,6%"
echo [INFO] 备份配置文件到: %BACKUP_CONFIG%
copy "%FOUND_CONFIG%" "%BACKUP_CONFIG%" >nul

REM 6. 清理配置文件
echo [INFO] 清理配置文件...

REM 使用 PowerShell 进行 JSON 处理（如果可用）
powershell -Command "& {
    try {
        \$json = Get-Content '%FOUND_CONFIG%' -Raw | ConvertFrom-Json
        if (\$json.plugins -and \$json.plugins.entries) {
            \$json.plugins.entries.PSObject.Properties.Remove('qq') | Out-Null
        }
        if (\$json.channels) {
            \$json.channels.PSObject.Properties.Remove('qq') | Out-Null
        }
        \$json | ConvertTo-Json -Depth 10 | Set-Content '%FOUND_CONFIG%'
        Write-Host '[SUCCESS] 配置清理完成（使用 PowerShell JSON）'
    } catch {
        Write-Host '[WARN] PowerShell JSON 处理失败，使用文本替换'
    }
}" 2>nul

if exist "%FOUND_CONFIG%.bak" (
    echo [WARN] 配置文件有备份，请手动检查清理是否完整
)

REM 7. 删除插件目录
echo [INFO] 正在删除插件目录...
if exist "%FOUND_EXT_DIR%\" (
    rmdir /s /q "%FOUND_EXT_DIR%"
    echo [SUCCESS] 插件目录已删除
) else (
    echo [WARN] 插件目录不存在，跳过删除
)

REM 8. 删除数据文件
echo [INFO] 清理插件数据文件...

if exist "%USERPROFILE%\.openclaw\data\qq\" (
    rmdir /s /q "%USERPROFILE%\.openclaw\data\qq"
    echo [SUCCESS] 已删除数据目录
)

del /q "%USERPROFILE%\.openclaw\logs\qq-*.log" 2>nul
if exist "%USERPROFILE%\.openclaw\logs\qq-*.log" (
    echo [SUCCESS] 已删除日志文件
)

REM 9. 验证卸载
echo.
echo [INFO] 验证卸载结果...

if exist "%FOUND_EXT_DIR%\" (
    echo [ERROR] 插件目录仍然存在！
    set EXIT_CODE=1
) else (
    echo [SUCCESS] 插件目录已删除
    set EXIT_CODE=0
)

REM 10. 输出总结
echo.
echo === 卸载完成 ===
echo [SUCCESS] QQ 插件已成功卸载
echo.
echo 已执行的操作：
echo   1. 停止 OpenClaw 网关服务
echo   2. 删除插件目录: %FOUND_EXT_DIR%
echo   3. 清理配置文件: %FOUND_CONFIG%
echo   4. 备份配置到: %BACKUP_CONFIG%
echo   5. 删除日志和数据文件
echo.
echo [INFO] 下一步：
echo   - 重启 OpenClaw 网关
echo   - 如需重新安装，请运行 install.ps1 或 install.sh
echo   - 配置文件备份: %BACKUP_CONFIG%
echo.

pause
exit /b %EXIT_CODE%

:cancel
echo [INFO] 已取消卸载
pause
exit /b 0
