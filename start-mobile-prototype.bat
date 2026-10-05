@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "PYTHON_EXE=%~dp0.python\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python"

echo 移动端原型：http://127.0.0.1:8790/mobile-prototype.html
echo 按 Ctrl+C 停止服务。
"%PYTHON_EXE%" -m http.server 8790 --bind 127.0.0.1 --directory "%~dp0public"
pause
