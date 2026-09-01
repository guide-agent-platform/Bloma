@echo off
rem Bloma 一键启动（双击入口）：构建 + 弹出应用窗口
cd /d "%~dp0"
node scripts\start.mjs %*
if errorlevel 1 (
  echo.
  echo 启动失败，按任意键关闭窗口查看上方错误。
  pause >nul
)
