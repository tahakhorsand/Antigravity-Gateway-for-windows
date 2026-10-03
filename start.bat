@echo off
setlocal
chcp 65001 >nul
title Antigravity Gateway - Launcher

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not found on your system!
    echo Please install Node.js version 22 or higher from https://nodejs.org
    echo.
    pause
    exit /b 1
)

echo ========================================================
echo       Antigravity Gateway - Windows Manager
echo ========================================================
echo.
echo [1] Run in Background (Silent, Recommended)
echo [2] Run in Foreground (Show live logs in this window)
echo [3] Open Dashboard in Browser
echo [4] Stop Gateway
echo [5] Exit
echo.

choice /c 12345 /n /m "Choose an option [1-5] (Default: 1 in 5s): " /t 5 /d 1
if errorlevel 5 exit /b 0
if errorlevel 4 goto do_stop
if errorlevel 3 goto do_browser
if errorlevel 2 goto do_foreground
if errorlevel 1 goto do_background

:do_background
echo.
echo Starting Antigravity Gateway in the background...
wscript.exe run-background.vbs
echo Gateway started! Opening dashboard in your browser...
ping 127.0.0.1 -n 2 >nul
exit /b 0

:do_foreground
echo.
echo Starting Antigravity Gateway with live console output...
node src\server.js
pause
exit /b 0

:do_browser
powershell.exe -NoProfile -Command "Start-Process 'http://127.0.0.1:8045'"
exit /b 0

:do_stop
call stop.bat
exit /b 0
