@echo off
chcp 65001 >nul
title Stop Antigravity Gateway
echo Stopping Antigravity Gateway processes...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8045 ^| findstr LISTENING') do (
    echo Terminating process PID %%a listening on port 8045...
    taskkill /F /PID %%a >nul 2>nul
)
echo Done.
ping 127.0.0.1 -n 2 >nul
