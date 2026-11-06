@echo off
chcp 65001 >nul
title LOL ARAM Helper Console
cd /d "%~dp0"

set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" (
  echo 找不到 Node.js，请先安装 Node.js 20 或更高版本喵。
  pause
  exit /b 1
)

echo 正在以管理员身份启动控制台模式喵...
powershell -NoProfile -Command "Start-Process -FilePath '%NODE_EXE%' -ArgumentList '%~dp0src\index.js' -WorkingDirectory '%~dp0' -Verb RunAs"
if errorlevel 1 (
  echo.
  echo 启动失败，请右键本文件选择「以管理员身份运行」重试喵。
  pause
)
exit /b
