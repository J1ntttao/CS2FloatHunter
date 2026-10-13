@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "EXIT_CODE=1"
title CS2 磨损猎人
cd /d "%~dp0"

if not defined CS2_WEB_PORT set "CS2_WEB_PORT=8788"
set "URL=http://127.0.0.1:%CS2_WEB_PORT%"

echo ============================================================
echo  CS2 目标磨损炼金助手 - 一键启动
echo ============================================================

rem 1) 检查 Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo [x] 未找到 Node.js。请安装 22.5 或更高版本：https://nodejs.org/
  goto :fail
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)"
if errorlevel 1 (
  for /f "delims=" %%v in ('node -v') do echo [x] 当前 Node.js 版本 %%v 过低，需要 22.5 或更高版本。
  goto :fail
)
for /f "delims=" %%v in ('node -v') do echo [ok] Node.js %%v

rem 2) 检查 BUFF 登录态（缺失也能启动，可以在网页里录入）
if exist "data\cookies.manual.buff.json" (
  echo [ok] 已找到 BUFF 登录态
) else (
  echo [!] 未找到 BUFF 登录态，搜索会失败。可在网页里粘贴 Cookie，
  echo     或运行：powershell -File scripts\set-cookies.ps1 -Site buff
)

rem 3) 结束本项目的旧服务和 watch 任务
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart-web.ps1" -Port "%CS2_WEB_PORT%"
if errorlevel 1 goto :fail
node --check "%~dp0src\market\steam.mjs"
if errorlevel 1 goto :fail
node --check "%~dp0src\web\server.mjs"
if errorlevel 1 goto :fail

rem 4) 启动服务，2 秒后自动打开浏览器
echo [..] 正在启动服务：%URL%
echo [..] Ctrl+C to stop.
echo.
start "" /b powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\restart-web.ps1" -Port "%CS2_WEB_PORT%" -OpenBrowser
node --watch "%~dp0src\web\server.mjs"

set "EXIT_CODE=%errorlevel%"
echo.
if "%EXIT_CODE%"=="0" (
  echo [!] 服务已停止。
) else (
  echo [x] 服务异常退出，退出码：%EXIT_CODE%
)
goto :fail

:fail
echo.
echo 按任意键关闭此窗口...
pause >nul
exit /b %EXIT_CODE%
