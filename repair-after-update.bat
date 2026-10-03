@echo off
setlocal
chcp 65001 >nul
title Antigravity Gateway - Post-Update Repair Tool

cd /d "%~dp0"

echo ========================================================
echo   Antigravity Gateway - Post-Update Diagnostic & Repair
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not found on your system!
    echo Please ensure Node.js 22+ is installed and added to PATH.
    echo.
    pause
    exit /b 1
)

echo Running repair script...
echo.
node scripts/repair.js

echo.
echo Press any key to exit or open dashboard...
pause >nul

echo Opening dashboard in browser...
powershell.exe -NoProfile -Command "Start-Process 'http://127.0.0.1:8045'"
exit /b 0
