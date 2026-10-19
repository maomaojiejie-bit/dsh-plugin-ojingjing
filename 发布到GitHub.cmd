@echo off
rem ASCII-only on purpose: cmd.exe reads .cmd in the OEM code page.
rem All user-facing text is printed by node in UTF-8 (chcp 65001 below).
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js not found in PATH.
  pause
  exit /b 1
)
node "tools\release.mjs" %*
echo.
pause
