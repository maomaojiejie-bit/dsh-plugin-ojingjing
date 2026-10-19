@echo off
chcp 936 >nul
title Í£Ö¹Å¶¾¨¾¨
set "PIDFILE=%~dp0data\ojingjing.pid"
if exist "%PIDFILE%" (
  set /p XJPID=<"%PIDFILE%"
  taskkill /f /pid %XJPID% >nul 2>nul
  del "%PIDFILE%" >nul 2>nul
) else (
  echo Ã»ÕÒµ½ pid ÎÄ¼þ£¬°´´°¿Ú±êÌâ¶µµ×½áÊø¡£
  taskkill /f /fi "WINDOWTITLE eq Å¶¾¨¾¨" >nul 2>nul
)
echo Å¶¾¨¾¨ÒÑÍË³ö¡£
timeout /t 2 >nul