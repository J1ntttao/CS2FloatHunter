@echo off
chcp 65001 >nul
setlocal EnableExtensions
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

rem 3) 服务已在运行就直接打开浏览器
node -e "fetch(process.argv[1]+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" "%URL%"
if not errorlevel 1 (
  echo [ok] 服务已在运行，正在打开 %URL%
  start "" "%URL%"
  exit /b 0
)

rem 4) 启动服务，2 秒后自动打开浏览器
echo [..] 正在启动服务：%URL%   （关闭此窗口或按 Ctrl+C 停止）
echo.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%URL%'"
node src\web\server.mjs
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
pause
exit /b 1
