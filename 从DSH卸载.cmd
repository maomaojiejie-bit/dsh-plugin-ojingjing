@echo off
rem ===========================================================================
rem  Double-click uninstaller for ojingjing (DSH Desktop plugin).
rem  Everything user-facing is printed by tools\uninstall.mjs (UTF-8). Keep
rem  this file ASCII-only: cmd.exe reads batch files in the OEM codepage.
rem
rem  Extra arguments are passed through:
rem    uninstall.cmd --dry-run    preview only
rem    uninstall.cmd --purge      also remove .venv, data/, logs, dist tarball
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

node "%~dp0tools\uninstall.mjs" %*
set "XJ_RC=%errorlevel%"

echo.
if not "%XJ_RC%"=="0" echo [x] uninstall failed, exit code %XJ_RC%.
pause
exit /b %XJ_RC%
