@echo off
setlocal
chcp 65001 >nul
title Antigravity Gateway - One-Click Installer

cd /d "%~dp0"

echo ========================================================
echo       Antigravity Gateway - Automated Installer
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in your PATH!
    echo Please download and install Node.js 22 or higher from:
    echo https://nodejs.org
    echo.
    pause
    exit /b 1
)

echo [1/4] Checking Node.js environment...
node -v
echo.

echo [2/4] Installing project dependencies...
if not exist "node_modules\" (
    echo Installing npm packages...
    call npm install --omit=dev
) else (
    echo Dependencies already installed. Updating if necessary...
    call npm install --omit=dev
)
if %errorlevel% neq 0 (
    echo [WARNING] npm install reported an issue. Continuing with setup...
)
echo.

echo [3/4] Running automated system configuration...
node scripts/setup.js
if %errorlevel% neq 0 (
    echo [ERROR] Setup script encountered an error.
    pause
    exit /b 1
)
echo.

echo [4/4] Installation Complete!
echo.
echo Antigravity Gateway is now configured for your system.
echo A shortcut 'Antigravity Gateway' has been placed on your Desktop.
echo.

echo Do you want to start Antigravity Gateway right now?
echo [1] Start in Background and open dashboard (Recommended)
echo [2] Start in Foreground with live debug logs
echo [3] Exit for now
echo.

choice /c 123 /n /m "Choose [1-3] (Default: 1 in 10s): " /t 10 /d 1
if %errorlevel% equ 3 exit /b 0
if %errorlevel% equ 2 (
    echo.
    echo Starting Gateway in foreground...
    node src\server.js
    pause
    exit /b 0
)
if %errorlevel% equ 1 (
    echo.
    echo Starting Gateway in background...
    wscript.exe run-background.vbs
    echo Opening dashboard...
    ping 127.0.0.1 -n 2 >nul
    powershell.exe -NoProfile -Command "Start-Process 'http://127.0.0.1:8045'"
    exit /b 0
)

exit /b 0
