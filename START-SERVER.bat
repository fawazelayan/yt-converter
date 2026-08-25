@echo off
title YT Downloader - Server (keep this window open)
cd /d "%~dp0"

echo ==========================================================
echo   YT Downloader - starting server
echo   Keep this window OPEN and the laptop AWAKE.
echo   Closing this window takes the website offline.
echo ==========================================================
echo.

where tailscale >nul 2>nul
if errorlevel 1 (
    echo [!] Tailscale is not installed or not on PATH.
    echo     Install it from https://tailscale.com/download then run this again.
    echo.
    pause
    exit /b 1
)

echo [1/3] Starting the download server on port 3000...
start "YT Downloader server" /min cmd /c "node server.js"

REM Give Node a moment to bind the port before the tunnel points at it.
timeout /t 4 /nobreak >nul

echo [2/3] Publishing it to the internet via Tailscale Funnel...
start "Tailscale Funnel" /min cmd /c "tailscale funnel 3000"

timeout /t 5 /nobreak >nul

echo [3/3] Your public address:
echo.
tailscale funnel status
echo.
echo ==========================================================
echo   Copy the https://...ts.net address above.
echo   It goes in public/app.js as BACKEND_URL (one time only).
echo ==========================================================
echo.
echo Press any key to STOP the server and take the site offline.
pause >nul

echo Stopping...
tailscale funnel --https=443 off >nul 2>nul
taskkill /F /IM node.exe >nul 2>nul
echo Done.
timeout /t 2 /nobreak >nul
