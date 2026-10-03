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

echo [1/3] Checking Node.js environment...
node -e "const v = parseInt(process.versions.node.split('.')[0]); if (v < 22) { console.error('\n[ERROR] Node.js version ' + process.version + ' detected.\nAntigravity Gateway requires Node.js 22 or higher (built-in SQLite and Fetch support).\nPlease upgrade from https://nodejs.org'); process.exit(1); } else { console.log('Node.js ' + process.version + ' OK (Zero runtime dependencies required)'); }"
if %errorlevel% neq 0 (
    echo.
    pause
    exit /b 1
)
echo.

echo [2/3] Configuring Antigravity credentials and environment...
node scripts/setup.js
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Setup script encountered an error.
    pause
    exit /b 1
)
echo.

echo [3/3] Installation Complete!
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
