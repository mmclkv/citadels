@echo off
chcp 65001 >nul
title Citadels Server - 富饶之城
cd /d "%~dp0"

rem ---- 没有管理员权限时自动提权（放行防火墙需要）----
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo   正在请求管理员权限（用于自动放行 8787 端口）...
  echo   若弹出 UAC 窗口，请点「是」。
  echo.
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

rem ---- 放行防火墙（重复运行也不会产生重复规则）----
netsh advfirewall firewall delete rule name="Citadels Board Game Server" >nul 2>&1
netsh advfirewall firewall add rule name="Citadels Board Game Server" dir=in action=allow protocol=TCP localport=8787 >nul 2>&1
if %errorlevel% equ 0 (
  echo   [OK] 已放行 TCP 8787 入站，手机可以访问了。
) else (
  echo   [WARN] 防火墙放行失败，手机可能连不上。
)

rem ---- 找到 node ----
set "NODE_EXE=node"
where node >nul 2>&1
if %errorlevel% neq 0 (
  if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe" (
    set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe"
  ) else (
    echo   [ERROR] 找不到 node.exe，请先安装 Node.js。
    pause
    exit /b 1
  )
)

echo.
"%NODE_EXE%" server.js 8787
echo.
echo   服务器已停止。
pause
