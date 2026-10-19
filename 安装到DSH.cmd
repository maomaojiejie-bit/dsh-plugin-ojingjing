@echo off
rem ===========================================================================
rem  Double-click installer for ojingjing (DSH Desktop plugin).
rem  Everything user-facing is printed by tools\install.mjs (UTF-8), because
rem  cmd.exe batch files are read in the OEM codepage and Chinese here would
rem  turn into mojibake. Keep this file ASCII-only.
rem
rem  Extra arguments are passed through:
rem    install.cmd --dry-run        preview only
rem    install.cmd --mirror cn      pip via aliyun mirror
rem ===========================================================================
chcp 65001 >nul 2>nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js not found on PATH. Install Node.js 22+ and run this again.
  echo.
  pause
  exit /b 1
)

node "%~dp0tools\install.mjs" --relaunch %*
set "XJ_RC=%errorlevel%"

echo.
if not "%XJ_RC%"=="0" echo [x] install failed, exit code %XJ_RC%.
pause
exit /b %XJ_RC%
