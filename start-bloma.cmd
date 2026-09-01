@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found in PATH. Install Node.js first.
  pause
  exit /b 1
)
node scripts\start.mjs %*
if errorlevel 1 pause
