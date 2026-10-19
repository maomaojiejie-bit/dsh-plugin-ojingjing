@echo off
chcp 936 >nul
cd /d "%~dp0"
title 哦鲸鲸

if exist ".venv\Scripts\pythonw.exe" goto launch

echo 首次运行：正在创建虚拟环境并安装 PySide6（约 300MB，请保持网络）...
where py >nul 2>nul
if %errorlevel%==0 (py -3 -m venv .venv) else (python -m venv .venv)

if not exist ".venv\Scripts\python.exe" (
  echo.
  echo [失败] 没找到 Python，请先安装 Python 3.10 或更高版本，安装时勾选 Add to PATH，再双击本文件。
  pause
  exit /b 1
)

".venv\Scripts\python.exe" -m pip install -i https://mirrors.aliyun.com/pypi/simple/ -r requirements.txt
if errorlevel 1 (
  echo.
  echo [失败] 依赖没装上，检查网络后重试，或再双击本文件。
  pause
  exit /b 1
)

:launch
start "" ".venv\Scripts\pythonw.exe" ojingjing_py.py
exit /b 0